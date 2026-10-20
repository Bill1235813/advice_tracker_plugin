// Background service worker: the only place that stores data, talks to the study server and
// decides when to ask the participant something. For every chat:
//   snapshot from the page -> each user turn the participant SENT is judged, one at a time, in
//   order (lib/episodes.js: the advice judge while searching, the continuation judge inside an
//   episode) -> an episode ends at a topic switch, or after endQuietMinutes without activity
//   -> the participant is asked for ratings as the episode's rating mode says (lib/modes.js:
//   frequent, switching, periodical or combined) -> check-in followupSeconds after the episode's first
//   request (14 days).
// Every text leaves the computer only after local redaction (lib/redact.js): the episode's
// conversation (the participant's messages and the assistant's replies) is uploaded with every set
// of answers, and once more, complete, when an episode with answers ends.
// Storage (chrome.storage.local):
//   settings        participant id, server, rating mode, preferences (options page)
//   snap:<chat>     the chat's latest messages, kept only while a turn is unjudged or an episode
//                   is open, and deleted as soon as the chat is settled
//   chat:<chat>     the chat's episode state: turn numbers and hashes, no text
//   sent:<chat>     the ids (hashes) of the participant's messages captured in the chat, no text:
//                   the popup's count, which stays when the page moves to another chat and back
//   sentlog:<chat>  the same messages as {h: hash of their loose form, at: when captured}: which turns of
//                   a conversation read from the site itself were sent on a watched page (lib/history.js)
//   alias:<key>     a second key of a chat (a new chat's URL gains its id after the first turn)
//   act:<chat>      when the participant last typed in the chat (pauses: periodical, combined modes)
//   lastView        the conversation the participant looked at last (moves: switching, combined)
//   episode:<id>    an episode from its first advice turn on: its mode, the answers given so far,
//                   and its text from its end until the day-14 check-in
//   queue, stats    uploads waiting for the network; counts for the heartbeat
//   held            uploads that "Hold my answers on this computer" (before 0.5) held back: sent or
//                   deleted only when the participant chooses so on the settings page
//   heartbeatAt     when the last heartbeat was sent
//   joinedAt        when the participant ID was first set: turns before it are past, after it the study's
//   trackingLog     [{at, on: [hosts]}]: from `at` on, tracking was on for these sites (none while paused)
//   deletedAt       when "delete all data" last ran
importScripts("config.js", "lib/sites.js", "lib/episodes.js", "lib/modes.js", "lib/redact.js", "lib/similarity.js", "lib/questions.js",
              "lib/history.js");

const DEFAULT_SETTINGS = {
  participantId: "", serverUrl: STUDY_CONFIG.serverUrl, studyKey: STUDY_CONFIG.studyKey, paused: false, pausedAt: null,
  ratingMode: STUDY_CONFIG.ratingMode || "switching",     // "frequent" | "switching" | "periodical" | "combined"
  followupSeconds: 14 * 24 * 3600,   // the check-in this long after an episode's first request (the settings page can shorten it for a test)
  endQuietMinutes: 24 * 60,    // an episode also ends after this long without activity in its chat
  cutDays: 7,                  // ... and is complete this many days after its first request (as at a change of topic)
  pauseMinutes: 3,            // periodical, combined: a pause is this long without typing in the episode's chat
  updateSeconds: 30,           // the update and confirm pop-ups disappear after this long
  excludedHosts: [], redactNames: [], relatedThreshold: 0.5,
  readPast: false,             // opt-in: read past conversations (before joining) to annotate some (lib/history.js)
  readApps: false,             // opt-in: read the conversations of the site's apps and other devices since joining
};
const POLL_WAIT_S = 20;      // one long-poll for a label (Chrome stops a worker that waits > 30 s for a response)
const RETRY_MINUTES = 2;     // after a failed judgment, or when the server cannot be reached
const SNOOZE_MINUTES = 60;   // "later (1 h)"
const ASK_WAIT_MINUTES = 5;  // a question about a reply waits at most this long for the reply to be complete
const HEARTBEAT_MINUTES = 12 * 60;
let generation = 0;          // "delete all data" bumps it; judging loops begun before stop writing
let deletingSince = 0;       // when "delete all data" last ended (Infinity while it runs): snapshots taken before are ignored

// ---------------- storage helpers ----------------
async function load(name) { return (await chrome.storage.local.get(name))[name]; }
async function save(name, value) { await chrome.storage.local.set({ [name]: value }); }
async function remove(name) { await chrome.storage.local.remove(name); }
// NOTE: [edge case callout] settings saved before 0.6.1 hold the follow-up time in days (followupDays);
// Modes.followupSeconds converts it until the next install or update saves the settings in seconds
async function getSettings() {
  const stored = (await load("settings")) || {};
  return { ...DEFAULT_SETTINGS, followupSeconds: Modes.followupSeconds(stored), ...stored };
}
async function loadAll(prefix) {
  const everything = await chrome.storage.local.get(null);
  return Object.entries(everything).filter(([name]) => name.startsWith(prefix));
}
const excluded = (settings, url) => isExcluded(new URL(url).hostname, settings.excludedHosts);     // lib/sites.js
// Nothing is captured before the participant set their study ID (it ties the data to their
// consent), while tracking is paused, or on a site they excluded; nothing is judged or asked then.
const trackingOff = (settings) => !settings.participantId || settings.paused;
const notTracking = (settings, url) => trackingOff(settings) || excluded(settings, url);
// An episode's conversation does not go with its answers (lib/questions.js, conversationGoes): its
// site is excluded, its answers were held by "Hold my answers on this computer" (before 0.5) and
// wait for the participant's decision, the participant deleted those or it is from 0.3 (keepText),
// or it is from 0.4, when the conversation was sent only after a review at the check-in
// (reviewAtCheckin; the check-in page still offers it).
const textStays = (record, settings) => Questions.conversationGoes(record, excluded(settings, record.url)) !== "with_answers";
// An episode the walk through conversations read from the site holds (lib/history.js), or a past one:
// it holds its own text, and is asked about through its site's queue (lib/modes.js viaQueue), until a
// web page takes it over (heldBy web: then its chat holds it, as any episode seen on the web).
const ownText = (record) => Modes.viaQueue(record);

// NOTE: [design thought] chrome.storage has no transactions, so read-modify-writes of the same
// record go through a promise chain per record name: they run one after the other
const chains = new Map();
function serialized(name, task) {
  const run = (chains.get(name) || Promise.resolve()).then(task);
  chains.set(name, run.catch(() => {}));
  return run;
}
function count(name) {
  return serialized("stats", async () => {
    const stats = (await load("stats")) || {};
    await save("stats", { ...stats, [name]: (stats[name] || 0) + 1 });
  });
}
// Change an episode record: change(record) returns the new record, or null to delete it.
function updateEpisode(id, change) {
  const started = generation;
  return serialized(`episode:${id}`, async () => {
    const record = await load(`episode:${id}`);
    if (!record || started !== generation) return null;
    const next = change(record);
    if (next === null) await remove(`episode:${id}`);
    else await save(`episode:${id}`, next);
    return next;
  });
}

// The conversation text a record holds: the episode's messages, from its end until its check-in
// (answers given after the episode ended are uploaded with them).
function withoutText(record) {
  const { messages, ...rest } = record;
  return rest;
}
// a finished episode keeps its answers and counts, no text
const doneRecord = (record) => ({ ...withoutText(record), status: "done", openingText: "", finalDue: false });

// ---------------- messages from the chat pages ----------------
// A new chat's URL gains its id after the first turn; the content script then sends the new key
// with `aliasOf` = the temporary one, and from then on both keys lead to the same chat.
async function chatKey(message) {
  const known = await load(`alias:${message.key}`);
  if (known) return known;
  if (message.aliasOf && !(await load(`chat:${message.key}`))) {
    const target = (await load(`alias:${message.aliasOf}`)) || message.aliasOf;
    if (await load(`chat:${target}`)) {
      await save(`alias:${message.key}`, target);
      return target;
    }
  }
  return message.key;
}

async function onSnapshot(message, sender) {
  const started = generation;
  const stale = () => started !== generation;      // "delete all data" happened meanwhile: nothing is written
  const settings = await getSettings();
  if (notTracking(settings, message.url)) return;
  // a snapshot taken before "delete all data" still lists the turns sent before it
  if (message.capturedAt < Math.max(deletingSince, (await load("deletedAt")) || 0)) return;
  const key = await chatKey(message);
  const kept = await serialized(`snap:${key}`, async () => {
    const chat = await load(`chat:${key}`);
    // a chat in which nothing was ever sent while watched (a past chat, only opened) is not kept
    if (stale() || (!chat && !message.sent.length)) return false;
    if (!chat) await save(`chat:${key}`, Episodes.newChat({ key, site: message.site, now: Date.now() }));
    const stored = await load(`snap:${key}`);
    const counted = (await load(`sent:${key}`)) || [];
    let messages = message.messages, sent = message.sent, storedSent = [], captured = counted;
    if (stored) {
      // a page that shows only part of a long chat keeps the rest of the stored copy
      // NOTE: [design thought] a turn's id counts the earlier turns with the same text, so the ids
      // of sent turns are renumbered with their turns: the page's from its own numbering, the
      // stored ones where older turns came in above (or an edit replaced them)
      const merged = Episodes.mergeWindow(stored.messages, message.messages, { fresh: message.fresh ?? null, claimed: message.sent.length > 0 });
      const turnsOf = (list) => Episodes.splitTurns(list).userTurns;
      const pageId = merged.pageShift === null ? () => null : Episodes.renumber(turnsOf(message.messages), turnsOf(merged.messages), merged.pageShift);
      const storedId = Episodes.renumber(turnsOf(stored.messages), turnsOf(merged.messages), merged.storedShift, merged.storedKeep);
      messages = merged.messages;
      sent = message.sent.map(pageId).filter(Boolean);
      storedSent = stored.sent.map(storedId).filter(Boolean);
      // the popup's count: the captured turns of the stored copy are renumbered too
      const storedIds = new Set(Episodes.turnIds(turnsOf(stored.messages)));
      captured = captured.map((id) => (storedIds.has(id) ? storedId(id) : id)).filter(Boolean);
    }
    if (stale()) return false;
    const count = [...new Set([...captured, ...sent])];
    if (JSON.stringify(count) !== JSON.stringify(counted)) await save(`sent:${key}`, count);
    // the messages captured as sent for the first time, by their loose form and when
    const firstSent = sent.filter((id) => !captured.includes(id));
    if (firstSent.length) {
      const userTurns = Episodes.splitTurns(messages).userTurns, ids = Episodes.turnIds(userTurns);
      const entries = firstSent.map((id) => ({ h: Episodes.looseHash(userTurns[ids.indexOf(id)] ?? ""), at: message.capturedAt }));
      await save(`sentlog:${key}`, [...((await load(`sentlog:${key}`)) || []), ...entries].slice(-500));
    }
    const same = stored && JSON.stringify(stored.messages) === JSON.stringify(messages);
    // whole: the copy holds the chat from its first settled turn on (Episodes.sync). A copy begun
    // from a part of the chat further down (its earlier copy was dropped) stays a part.
    const pageIds = Episodes.turnIds(Episodes.splitTurns(messages).userTurns);
    const whole = stored ? stored.whole ?? true : !(Episodes.lineUp(chat?.ids || [], pageIds) > 0);
    await save(`snap:${key}`, {
      messages, url: message.url, site: message.site, tabId: sender.tab.id, settled: Boolean(message.settled), whole,
      sent: [...new Set([...storedSent, ...sent])],
      changedAt: same ? stored.changedAt : Date.now(),        // the quiet timer counts from here
      version: (stored?.version || 0) + 1,
    });
    return true;
  });
  if (!kept || stale()) return;
  advance(key);
  if (message.settled) await onSettled(key);
}

// A settled snapshot came in: the reply on the page is complete. A ratings page of the chat's
// episode that is open shows the complete reply, and the question that waited for it is asked.
async function onSettled(key) {
  const chat = await load(`chat:${key}`);
  const record = chat?.episodeId && (await load(`episode:${chat.episodeId}`));
  if (record?.status !== "open") return;
  await refreshPanels(record);
  if (record.dueAsk) await askDue(record.id);
}

// The page now shows a conversation (opened, started, or its tab or window came to the front).
// For switching and combined modes, looking at any other conversation than an open episode's chat
// is a move to another conversation.
async function onView(message, sender) {
  const settings = await getSettings();
  if (notTracking(settings, message.url)) return;
  const view = { key: await chatKey(message), tabId: sender.tab.id, site: message.site, url: message.url, at: Date.now() };
  await save("lastView", view);
  for (const [, record] of await loadAll("episode:")) {
    if (record.status === "open" && record.chatKey !== view.key && !ownText(record)) await ask(record.id, "onOtherConversation", view);
  }
  // a page of the site came to the front: its next question about a conversation read from the site
  await offerQueued(view);
}

// The participant typed in a chat: for an open periodical or combined episode, the start of a new
// pause.
async function onActivity(message) {
  const settings = await getSettings();
  if (notTracking(settings, message.url)) return;
  const chat = await load(`chat:${await chatKey(message)}`);
  const record = chat?.episodeId && (await load(`episode:${chat.episodeId}`));
  if (record?.status !== "open" || !Modes.asksAtPauses(record.mode)) return;     // nothing else needs it
  await save(`act:${record.chatKey}`, Date.now());
  await armPause(record);
}

async function armPause(record) {
  const settings = await getSettings();
  const lastTyped = (await load(`act:${record.chatKey}`)) || Date.now();
  chrome.alarms.create(`pause|${record.id}`, { when: Math.max(lastTyped + settings.pauseMinutes * 60000, Date.now() + 1000) });
}

async function onPause(id) {
  const settings = await getSettings();
  const record = await load(`episode:${id}`);
  if (record?.status !== "open") return;
  const lastTyped = (await load(`act:${record.chatKey}`)) || 0;
  if (Date.now() < lastTyped + settings.pauseMinutes * 60000 - 1000) return armPause(record);   // typed again meanwhile
  await ask(id, "onPause");
}

// ---------------- judging: one chat at a time, one turn at a time ----------------
const running = new Set(), again = new Set();

// Run settle(key), unless it is already running for this chat: then it runs once more afterwards.
async function advance(key) {
  if (running.has(key)) { again.add(key); return; }
  running.add(key);
  try {
    do { again.delete(key); await settle(key); } while (again.has(key));
  } catch (error) {
    console.error("advance", key, error);
    chrome.alarms.create(`judge|${key}`, { delayInMinutes: RETRY_MINUTES });
  } finally {
    running.delete(key);
  }
}

// Judge the chat's unjudged turns in order until every turn on the page is settled; then close
// the open episode if the chat has been quiet for endQuietMinutes, and drop the text.
async function settle(key) {
  const started = generation;
  const stale = () => started !== generation;      // "delete all data" happened meanwhile
  for (;;) {
    const settings = await getSettings();
    const snapshot = await load(`snap:${key}`);
    let chat = await load(`chat:${key}`);
    if (!snapshot || !chat || stale()) return;
    const { userTurns, replies } = Episodes.splitTurns(snapshot.messages);
    const page = { snapshot, userTurns, replies, started };
    let closed;
    // an episode closed last time, and the worker stopped before its record was closed
    if (chat.closing) chat = await finishClosing(key, chat, page);
    // the walk took the chat's open episode (turns from another device continue it): the chat lets it go
    if (chat.state === "episode" && chat.episodeId && (await load(`episode:${chat.episodeId}`))?.heldBy === "history") {
      chat = { ...chat, state: "searching", episodeId: null, segmentStart: chat.end + 1, opening: null, end: null, openedAt: null,
               pending: chat.pending?.kind === "continuation" ? null : chat.pending };
      if (stale()) return;
      await save(`chat:${key}`, chat);
    }

    if (excluded(settings, snapshot.url)) {
      // the participant excluded this site after these turns were captured: nothing more is
      // judged or asked, and the text goes (answers already given stay)
      if (chat.state === "episode") {
        if (chat.episodeId) await updateEpisode(chat.episodeId, (record) => (record.answers ? record : { ...record, status: "removed" }));
        ({ chat, closed } = Episodes.closeOpen(chat, "excluded"));
        chat = await closeEpisode(key, chat, closed, page);
      }
      if (stale()) return;
      await save(`chat:${key}`, { ...chat, pending: null });
      await dropText(key, snapshot);
      // an episode that ended meanwhile (a judgment in flight closed it at a change of topic)
      for (const [, record] of await loadAll("episode:")) if (record.chatKey === key) await forgetEnded(record.id);
      await updateBadge();
      return;
    }

    const before = chat;
    ({ chat, closed } = Episodes.sync(chat, userTurns, new Set(snapshot.sent), snapshot.whole ?? true));
    // with readApps on, an open episode followed by turns the page did not see sent (another device,
    // most likely) is handed to the walk through the conversation read from the site, instead of ending
    if (closed?.closedBy === "history" && settings.readApps && historyAllowed(settings, hostOf(snapshot.url)) &&
        (await handOff(before.episodeId, closed, page, snapshot.url))) {
      chat = { ...chat, episodeId: null };
    } else {
      chat = closed ? await closeEpisode(key, chat, closed, page) : await afterSync(before, chat, page, settings);
    }
    // "No" (not advice) on the open episode: it ends here, so its later turns go to the advice judge only
    if (chat.state === "episode" && (await load(`episode:${chat.episodeId}`))?.status === "removed") {
      ({ chat, closed } = Episodes.closeOpen(chat, "removed"));
      chat = await closeEpisode(key, chat, closed, page);
    }
    if (stale()) return;
    await save(`chat:${key}`, chat);

    if (chat.pending) {
      // a judgment is in flight: collect its label. The alarm resumes this loop if Chrome stops
      // the worker meanwhile (it does so after 30 s without events).
      chrome.alarms.create(`judge|${key}`, { delayInMinutes: 1 });
      const result = chat.pending.label ? { state: "done", label: chat.pending.label } : await collect(chat.pending.id, settings);
      if (stale()) return;
      if (result.state === "waiting") continue;
      if (result.state === "done" && !chat.pending.label && (await load(`snap:${key}`))?.version !== snapshot.version) {
        // NOTE: [edge case callout] the page changed while the label was on its way: it is kept with
        // the judgment and applied once the chat is lined up with the page again (Episodes.sync drops
        // it if the participant edited the judged turn meanwhile; the server forgets a label it gave)
        await save(`chat:${key}`, { ...chat, pending: { ...chat.pending, label: result.label } });
        continue;
      }
      if (result.state === "done") {
        const job = chat.pending;
        ({ chat, closed } = Episodes.applyLabel(chat, job, result.label));
        if (closed) {
          chat = await closeEpisode(key, chat, closed, page);
        } else {
          const opened = job.kind === "advice" && chat.state === "episode";
          if (opened) chat = { ...chat, episodeId: episodeId(chat.key, chat.segmentStart, chat.opening, chat.openedAt) };
          if (stale()) return;
          // the chat is saved before the episode record: after a restart this turn is never judged
          // again, and afterSync gives the open episode its record if it is missing
          await save(`chat:${key}`, chat);
          if (opened) await episodeOpened(chat, job, page, settings);
          else if (job.kind === "continuation") await episodeExtended(chat, job);
        }
        await count("judged");
        continue;
      }
      if (result.state === "unreachable") return;                // keep the job; the alarm asks again
      await save(`chat:${key}`, { ...chat, pending: null });      // failed or unknown to the server
      if (result.state === "unknown") continue;                   // (it restarted): submit again now
      chrome.alarms.create(`judge|${key}`, { delayInMinutes: RETRY_MINUTES });
      return;
    }

    // a turn sent right after turns from another device: the episode they belong to may go on here
    const taken = await takeFromElsewhere(key, chat, page, settings);
    if (taken.waiting) {
      if (stale()) return;
      await save(`chat:${key}`, taken.chat);
      chrome.alarms.create(`judge|${key}`, { delayInMinutes: 1 });
      return;
    }
    if (taken !== chat) {
      chat = taken;
      if (stale()) return;
      await save(`chat:${key}`, chat);
    }
    const job = Episodes.nextJob(chat, userTurns, replies);
    // NOTE: [design thought] a week after its first request an episode is complete, as at a change
    // of topic: a turn sent later is not part of it (it goes to the advice judge, as a new start), so
    // the conversation asked about at the check-in is the one the answers were about
    if (job?.kind === "continuation" && Date.now() >= await cutAt(chat, settings)) {
      ({ chat, closed } = Episodes.closeOpen(chat, "cut"));
      await closeEpisode(key, chat, closed, page);
      continue;
    }
    if (job) {
      if (trackingOff(settings)) return;
      const id = await submit(job, chat, settings);
      if (stale()) return;
      if (!id) { chrome.alarms.create(`judge|${key}`, { delayInMinutes: RETRY_MINUTES }); return; }
      // sentAt: when the page last changed before this judgment, i.e. about when the turn was sent;
      // hash: the turn's text, which an edit can change before the label comes (Episodes.sync)
      await save(`chat:${key}`, { ...chat, pending: { id, kind: job.kind, turn: job.turn, sentAt: snapshot.changedAt,
                                                      hash: Episodes.hash(userTurns[job.turn - 1]) } });
      continue;
    }

    // every turn on the page is settled
    chrome.alarms.clear(`judge|${key}`);
    if (chat.state === "episode") {
      // the episode ends when the chat has been quiet for endQuietMinutes, or at its cut, whichever
      // comes first (the alarm comes back here then)
      const quietAt = snapshot.changedAt + settings.endQuietMinutes * 60000, cut = await cutAt(chat, settings);
      if (Date.now() < Math.min(quietAt, cut)) {
        chrome.alarms.create(`quiet|${key}`, { when: Math.min(quietAt, cut) });
        return;
      }
      ({ chat, closed } = Episodes.closeOpen(chat, cut <= quietAt ? "cut" : "quiet"));
      // quiet here with readApps on: the conversation may go on in an app, so the walk takes the episode
      if (closed.closedBy === "quiet" && settings.readApps && historyAllowed(settings, hostOf(snapshot.url)) &&
          (await handOff(chat.episodeId, closed, page, snapshot.url))) {
        chat = { ...chat, episodeId: null };
        if (stale()) return;
        await save(`chat:${key}`, chat);
      } else {
        chat = await closeEpisode(key, chat, closed, page);
      }
    }
    if (await dropText(key, snapshot)) return;
  }
}

// When the open episode of `chat` is complete: cutDays after its first request (the record keeps
// that time too, for a chat from before 0.4 that does not)
async function cutAt(chat, settings) {
  const openedAt = chat.openedAt ?? (await load(`episode:${chat.episodeId}`))?.openedAt ?? Date.now();
  return openedAt + settings.cutDays * 24 * 3600 * 1000;
}

// An episode of the chat closed (`chat` is the chat after it, still carrying the episode's id).
// NOTE: [design thought] a write-ahead note: the chat is saved first, with a note of the closed
// episode, and only then is the episode's record closed (and the participant asked). If Chrome
// stops the worker in between, the next run of the loop finds the note and finishes the job, so
// neither the label (which the server forgets once delivered) nor the closing is lost.
async function closeEpisode(key, chat, closed, page) {
  chat = { ...chat, episodeId: null, closing: { ...closed, id: chat.episodeId } };
  if (page.started !== generation) return chat;
  await save(`chat:${key}`, chat);
  return finishClosing(key, chat, page);
}

async function finishClosing(key, chat, page) {
  if (chat.closing.id) {
    // NOTE: [edge case callout] a note replayed after a stop has the turn numbers of the snapshot
    // that closed the episode (those of chat.ids); the page may have loaded older turns above since.
    // If its turns are no longer there unchanged, the record closes without text.
    const shift = Episodes.findOffset(chat.ids, Episodes.turnIds(page.userTurns));
    const moved = (turn) => (turn === undefined || turn === null ? turn : turn + shift);
    const closing = shift > 0 ? { ...chat.closing, start: moved(chat.closing.start), opening: moved(chat.closing.opening),
                                  end: moved(chat.closing.end) } : chat.closing;
    await episodeClosed(closing, shift < 0 ? null : page);
  }
  chat = { ...chat, closing: null };
  if (page.started === generation) await save(`chat:${key}`, chat);
  return chat;
}

// Nothing needs the chat's text any more: delete it, unless a newer snapshot came in meanwhile.
async function dropText(key, snapshot) {
  return serialized(`snap:${key}`, async () => {
    if ((await load(`snap:${key}`))?.version !== snapshot.version) return false;
    await remove(`snap:${key}`);
    await remove(`act:${key}`);
    return true;
  });
}

// What sync changed about the open episode when it did not close it: it vanished (its opening
// turn was edited away), or its turns were renumbered (older turns loaded above). Also gives the
// open episode its record if there is none: the worker stopped between saving the chat and
// saving the record, or the episode opened before version 0.4 (which kept no open records).
async function afterSync(before, chat, page, settings) {
  if (before.state === "episode" && chat.state !== "episode") return episodeVanished(before, chat);
  if (chat.state !== "episode") return chat;
  if (!chat.episodeId) chat = { ...chat, episodeId: episodeId(chat.key, chat.segmentStart, chat.opening, chat.openedAt) };
  if (!(await load(`episode:${chat.episodeId}`))) {
    await episodeOpened(chat, { sentAt: chat.openedAt }, page, settings);
    return chat;
  }
  if (chat.opening !== before.opening) {
    // NOTE: [edge case callout] the shift is computed against the record itself, so doing this
    // twice (the worker stopped between the two writes) changes nothing the second time
    await updateEpisode(chat.episodeId, (record) => {
      const shift = chat.opening - record.opening;
      const moved = (turn) => (turn === null || turn === undefined ? turn : turn + shift);
      return { ...record, start: chat.segmentStart, opening: chat.opening, end: chat.end, answeredEnd: moved(record.answeredEnd),
               askedEnd: moved(record.askedEnd) };
    });
  }
  return chat;
}

async function submit(job, chat, settings) {
  try {
    const response = await fetch(`${settings.serverUrl}/judge`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Study-Key": settings.studyKey },
      body: JSON.stringify({ participant_id: settings.participantId, site: chat.site, ...redactJob(job, settings.redactNames) }),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) return null;          // 503 = queue full
    return (await response.json()).id;
  } catch (error) {
    return null;                             // offline, or the server is asleep
  }
}

// NOTE: [design thought] the judge sees the turns with personal details replaced ([NAME],
// [EMAIL], ...): whether a message asks for advice does not depend on them, and they never leave
// the computer. The turn ids that track the chat are computed from the original text, on the page.
function redactJob(job, names) {
  const clean = (text) => Redact.redact(text, names).text;
  if (job.kind === "advice") return { ...job, turns: job.turns.map(clean) };
  return { ...job, previous: clean(job.previous), reply: clean(job.reply), current: clean(job.current) };
}

// {state: "waiting" | "done" | "failed"} from the server, or "unknown" / "unreachable"
async function collect(id, settings) {
  try {
    const response = await fetch(`${settings.serverUrl}/judge/${id}?wait=${POLL_WAIT_S}`, {
      headers: { "X-Study-Key": settings.studyKey }, signal: AbortSignal.timeout((POLL_WAIT_S + 8) * 1000),
    });
    if (response.status === 404) return { state: "unknown" };
    if (!response.ok) return { state: "unreachable" };
    return await response.json();
  } catch (error) {
    return { state: "unreachable" };
  }
}

// ---------------- an episode's life: opened, extended, closed ----------------
// The id is derived from the episode itself (its chat, first turns and when its first request
// was sent), so recording it twice keeps one copy, and an edited opening makes a new episode.
function episodeId(key, start, opening, openedAt) {
  return `${Episodes.hash(key)}-${start}-${opening}-${(openedAt || 0).toString(36)}`;
}

// BITE links a later event to an earlier interaction by word overlap; here a new episode about
// the same decision is linked to the earlier one, and the check-in mentions it
async function relatedEpisodes(openingText, settings) {
  return (await loadAll("episode:")).map(([, other]) => other)
    .filter((other) => other.openingText && Similarity.jaccard(openingText, other.openingText) >= settings.relatedThreshold)
    .map((other) => other.id);
}

async function saveNewRecord(id, chat, page, settings) {
  const openingText = page.userTurns[chat.opening - 1] || "";
  const record = {
    id, chatKey: chat.key, site: chat.site, url: page.snapshot.url,
    mode: settings.ratingMode,           // fixed for the episode's whole life
    start: chat.segmentStart, opening: chat.opening, end: chat.end ?? chat.opening, openedAt: chat.openedAt ?? Date.now(),
    closedAt: null, closedBy: null, openingText, related: await relatedEpisodes(openingText, settings),
    status: "open", answers: null, versions: 0, answeredEnd: null, askedEnd: null, finalDue: false, panelTabs: [],
  };
  if (page.started !== generation) return null;          // "delete all data" happened meanwhile
  await save(`episode:${id}`, record);
  await count("episodes");
  return record;
}

async function episodeOpened(chat, job, page, settings) {
  if (await load(`episode:${chat.episodeId}`)) return;           // opened before a restart: nothing new to ask
  const record = await saveNewRecord(chat.episodeId, chat, page, settings);
  if (!record) return;
  if (Modes.asksAtPauses(record.mode)) await armPause(record);
  // NOTE: [design thought] combined mode: after a move, the ratings page comes instead of the
  // confirm pop-up, and asks the confirm question itself
  if (await askIfAlreadyElsewhere(record, job)) return;
  await askWhenSettled(record, "onOpened");
}

async function episodeExtended(chat, job) {
  const record = await updateEpisode(chat.episodeId, (current) => (current.status === "open" ? { ...current, end: chat.end } : current));
  if (record?.status !== "open") return;
  await refreshPanels(record);                    // a ratings page of the episode that is open shows the new turn
  if (Modes.asksAtPauses(record.mode)) await armPause(record);      // a pause may have passed meanwhile
  if (await askIfAlreadyElsewhere(record, job)) return;
  await askWhenSettled(record, "onExtended");
}

// Switching and combined modes: the participant may have moved to another conversation while
// this turn was being judged; that move counts as soon as the label is in. Returns whether they
// were asked something.
async function askIfAlreadyElsewhere(record, job) {
  if (!Modes.asksAtMoves(record.mode)) return false;
  const view = await load("lastView");
  if (view && view.key !== record.chatKey && view.at > job.sentAt) return ask(record.id, "onOtherConversation", view);
  return false;
}

// A closed episode keeps its answers, and its text until its check-in is done, or (`waits`) until its
// complete conversation could be sent (an episode on a site the participant then excluded keeps no
// text: none of it leaves the computer any more).
function closedRecord(current, decision, closed, messages, waits = false) {
  const { dueAsk, refused, ...rest } = current;
  const next = { ...rest, end: closed.end, closedAt: Date.now(), closedBy: closed.closedBy, status: decision.status,
                 finalDue: decision.finalDue };
  if (closed.closedBy === "excluded") return { ...withoutText(next), keepText: true };
  if ((next.status === "done" || next.checkin?.doneAt) && !waits) return doneRecord(next);
  return { ...next, messages };
}

// `closed`: {id, start, opening, end, closedBy, openedAt}; `page`: the snapshot the episode's turns
// are in (null: they are not there any more)
async function episodeClosed(closed, page) {
  for (const alarm of ["pause", "ask"]) chrome.alarms.clear(`${alarm}|${closed.id}`);
  const messages = page && Episodes.episodeMessages(page.userTurns, page.replies, closed.start, closed.end);
  const settings = await getSettings();
  let closedNow = false;
  const record = await updateEpisode(closed.id, (current) => {
    if (!["open", "removed"].includes(current.status)) return current;     // closed before (the note was replayed)
    closedNow = true;
    // NOTE: [edge case callout] the snapshot that closed the episode can also have loaded older
    // turns above (sync renumbered the chat): the record takes the closing's turn numbers first
    const shift = closed.opening === undefined ? 0 : closed.opening - current.opening;
    const moved = (turn) => (turn === null || turn === undefined ? turn : turn + shift);
    current = { ...current, start: closed.start, opening: current.opening + shift, answeredEnd: moved(current.answeredEnd),
                askedEnd: moved(current.askedEnd) };
    // (the record's own text, if it holds one: an episode of the walk, or handed to it)
    const text = messages ?? (ownText(current) ? current.messages : null);
    // a web episode handed to the walk that no turn from elsewhere joined is asked about by the web's
    // rules again once it ends (as it would have been without the reading)
    if ((current.source ?? "web") === "web" && current.heldBy === "history" && !current.grew) current = { ...current, heldBy: "web", walk: null };
    const decision = Modes.onClosed(current, closed.closedBy);
    const waits = Boolean(current.answers) && trackingOff(settings);      // its complete conversation goes once tracking is on
    return decision.status === "delete" ? null : closedRecord(current, decision, closed, text, waits);
  });
  if (record && closedNow) await ask(record.id, "waitingPage");
  // the complete conversation of an episode with answers (turns may have come after the last answers);
  // without the page's copy, the record's own (an episode from a conversation read from the site)
  if (record && closedNow) await sendTranscript(record.id, messages);
  await updateBadge();
}

// The episode's complete conversation, redacted, once: when an episode with answers ends, or once
// tracking is on again if it ended while tracking was off. `messages`: its turns start..end (the
// record's own copy if not given). Returns whether it went.
// NOTE: [design thought] the record's chain decides, on the record and the settings as they are
// now: two callers at once (a resume and "Send them now") send it once, and nothing goes after a
// new pause, an exclusion of the site or "delete all data"
async function sendTranscript(id, messages = null) {
  const settings = await getSettings();
  let claimed = null;
  await updateEpisode(id, (current) => {
    const text = messages || current.messages;
    if (!current.answers || current.transcriptSent || !text || current.status === "open" || trackingOff(settings) ||
        textStays(current, settings)) return current;
    claimed = { ...current, text };
    return { ...current, transcriptSent: true };
  });
  if (!claimed) return false;
  const { userTurns, replies } = Episodes.splitTurns(claimed.text);
  const redacted = Redact.redactMessages(Episodes.episodeMessages(userTurns, replies, claimed.opening - claimed.start + 1,
                                                                  claimed.end - claimed.start + 1), settings.redactNames);
  await upload("episode_transcript", { episode: claimed.id, site: claimed.site, source: claimed.source ?? "web", mode: claimed.mode, closed_by: claimed.closedBy,
                                       turns: claimed.end - claimed.opening + 1, transcript: redacted.messages,
                                       redacted: redacted.counts }, settings);
  return true;
}

// Tracking is on again (resumed, or the participant ID set): ended episodes whose complete
// conversation waited are sent now; one whose check-in is done lets go of its text then.
async function sendWaitingTranscripts() {
  for (const [, record] of await loadAll("episode:")) {
    if (!(await sendTranscript(record.id))) continue;
    await updateEpisode(record.id, (current) => (current.checkin?.doneAt ? doneRecord({ ...current, status: "done" }) : current));
  }
}

// An ended episode on a site the participant excluded: its answers stay without the text; one
// without answers goes, with its timers.
async function forgetEnded(id) {
  let deleted = false;
  await updateEpisode(id, (current) => {
    if (current.status === "open") return current;
    if (current.answers) return { ...withoutText(current), keepText: true, finalDue: false };
    deleted = true;
    return null;
  });
  if (deleted) for (const alarm of ["pause", "ask", "remind", "checkin"]) chrome.alarms.clear(`${alarm}|${id}`);
}

// The participant excluded a site: its episodes let go of their text now, not when their chats are
// next seen. Open ones are closed by their chat (settle, which also lets go of an episode that a
// judgment in flight closes), ended ones without answers deleted, and ended ones with answers keep
// the answers only.
async function forgetExcluded() {
  const settings = await getSettings();
  for (const [, record] of await loadAll("episode:")) {
    if (!excluded(settings, record.url)) continue;
    // one held by a walk through the conversation read from the site ends now, as its chat would end it
    // on the web (without answers it goes; with answers they stay, without the text); the walk stops below
    if (record.status === "open" && record.heldBy === "history") {
      if (!record.answers) await updateEpisode(record.id, () => null);
      else await episodeClosed({ id: record.id, start: record.start, opening: record.opening, end: record.end, closedBy: "excluded", openedAt: record.openedAt }, null);
    } else if (record.status === "open") advance(record.chatKey);
    else await forgetEnded(record.id);
  }
  // what was read from the site goes: its list, its conversations and their text
  for (const host of HISTORY_SITES) {
    if (!excluded(settings, `https://${host}/`)) continue;
    for (const [name] of [...(await loadAll(`hist:${host}/`)), ...(await loadAll(`hlist:${host}`)), ...(await loadAll(`hstate:${host}`))]) await remove(name);
    for (const name of await waitingTexts()) if (name.startsWith(`htext:${host}/`)) await chrome.storage.session.remove(name);
  }
  for (const [name, snapshot] of await loadAll("snap:")) if (excluded(settings, snapshot.url)) advance(name.slice("snap:".length));
  await updateBadge();
}

// The opening turn was edited away, so the episode no longer exists in the chat. Answers already
// given are kept (as if it had ended there); otherwise the record goes.
async function episodeVanished(before, chat) {
  if (before.episodeId) {
    for (const alarm of ["pause", "ask"]) chrome.alarms.clear(`${alarm}|${before.episodeId}`);
    await updateEpisode(before.episodeId, (record) => (record.answers
      ? closedRecord(record, { status: "rated", finalDue: false }, { end: record.end, closedBy: "edited" }, null)
      : null));
  }
  return { ...chat, episodeId: null };
}

// ---------------- asking the participant ----------------
// The panel's view of an episode: what it quotes and the earlier answers. `basedOn` (the number of
// answers given so far) lets an answer from a page built before newer answers be recognised.
// `text`: what happens to the episode's conversation (lib/questions.js, conversationGoes), for the
// note under the questions.
function panelEpisode(record, stage, settings) {
  return {
    id: record.id, site: record.site, openingText: record.openingText, stage, mode: record.mode, start: record.start, end: record.end,
    closedBy: record.closedBy, basedOn: record.versions, source: record.source ?? "web", openedAt: record.openedAt, title: record.title ?? "", previous: record.answers, answered: record.versions > 0,
    confirmed: record.versions > 0 || Boolean(record.confirmedAt),        // combined mode: Yes in the confirm pop-up
    text: Questions.conversationGoes(record, excluded(settings, record.url)),
  };
}

function panelSettings(settings) {
  return { followupSeconds: settings.followupSeconds, updateSeconds: settings.updateSeconds };
}

// The episode's conversation from its first advice turn (the opening) through turn `end`,
// redacted for upload: {messages, counts}. An open episode is read from its chat's latest
// snapshot, an ended one from its record (null once the record no longer holds it).
// NOTE: [design thought] the turns before the opening stay out: they were judged not to ask for
// advice, and can be anything (a work document, another task), with no review before upload
async function transcript(record, end, settings) {
  end = Math.min(end, record.end);
  if (end < record.opening || textStays(record, settings)) return null;
  let messages = null;
  if (record.status === "open" && !ownText(record)) {
    const chat = await load(`chat:${record.chatKey}`);
    const { userTurns, replies } = Episodes.splitTurns((await load(`snap:${record.chatKey}`))?.messages || []);
    // NOTE: [edge case callout] the page may have loaded older turns above since the chat was last
    // brought in line with it (its judging loop waits for a label meanwhile): the episode's turns
    // then sit further down in the snapshot. If its known turns are not there unchanged, nothing
    // is sent rather than other turns.
    const shift = Episodes.findOffset(chat?.ids || [], Episodes.turnIds(userTurns));
    if (shift < 0) return null;
    messages = Episodes.episodeMessages(userTurns, replies, record.opening + shift, end + shift);
  } else if (record.messages) {
    // the record holds turns start..end only: its turn k is turn start + k - 1 of the chat
    const { userTurns, replies } = Episodes.splitTurns(record.messages);
    messages = Episodes.episodeMessages(userTurns, replies, record.opening - record.start + 1, end - record.start + 1);
  }
  return messages && Redact.redactMessages(messages, settings.redactNames);
}

// Ratings pages of the episode that are open (in any tab) take its newer state: more turns, the
// complete reply, or (with `stage`) a new request. Returns the tabs where a page took it; tabs
// that no longer show one (closed, reloaded) are forgotten.
async function refreshPanels(record, stage = null) {
  const tabs = record.panelTabs || [];
  if (!tabs.length) return [];
  const settings = await getSettings();
  const message = { type: "refresh_panel", episode: panelEpisode(record, stage, settings), settings: panelSettings(settings) };
  const refreshed = [];
  for (const tabId of tabs) {
    const response = await chrome.tabs.sendMessage(tabId, message).catch(() => null);
    if (response?.refreshed) refreshed.push(tabId);
  }
  if (refreshed.length < tabs.length) {
    await updateEpisode(record.id, (current) => ({ ...current,
      panelTabs: (current.panelTabs || []).filter((tab) => refreshed.includes(tab) || !tabs.includes(tab)) }));
  }
  return refreshed;
}

// Ask the participant about an episode as `rule` (a lib/modes.js function) decides on the record
// as it is now: other events may have changed it since the caller looked. The question goes to
// the page the participant is looking at (`view`, if given) or to the tab of the episode's chat.
// On a page of another chat site only a pop-up without conversation text appears, and the
// answers go in an extension tab. A ratings page of the episode that is already open takes the
// request instead. A pop-up refused because something else is open on that page comes once that
// closes; a waiting question (rule waitingPage) whose page is gone becomes a notification; other
// questions wait for the next occasion. Nothing is asked while tracking is paused, or about an
// episode on a site the participant excluded.
async function ask(id, rule, view = null) {
  const settings = await getSettings();
  const record = await load(`episode:${id}`);
  if (record && ownText(record)) return askQueued(record, rule, settings);
  const decision = record && Modes[rule](record, Date.now());
  if (!decision || trackingOff(settings) || excluded(settings, record.url)) return false;
  const page = decision.show === "page";
  const snapshot = await load(`snap:${record.chatKey}`);
  const tabId = (view ? view.tabId : snapshot?.tabId) ?? null;
  const site = view ? view.site : record.site;
  // an open page of the episode shows the request; a page is also put in front of the participant
  // if they are looking at another tab
  const refreshed = await refreshPanels(record, page ? decision.stage : null);
  if (refreshed.length && (!page || tabId === null || refreshed.includes(tabId))) return true;
  const type = site !== record.site ? "offer_tab" : { page: "show_panel", update: "offer_update", confirm: "offer_confirm" }[decision.show];
  let episode = panelEpisode(record, decision.stage, settings);
  // NOTE: [design thought] a page of another chat site gets no text of the conversation at all
  if (type === "offer_tab") episode = { id: episode.id, site: episode.site, stage: episode.stage, start: episode.start, end: episode.end, answered: episode.answered };
  let response = null;
  if (tabId !== null) {
    try {
      response = await chrome.tabs.sendMessage(tabId, { type, episode, settings: panelSettings(settings) });
    } catch (error) { /* tab closed, or showing a page without the content script */ }
  }
  if (response?.busy) {
    await updateEpisode(id, (current) => ({ ...current, refused: { tabId, rule, view } }));
    return false;
  }
  // a page or pop-up counts as asked once it is on the screen (rating_shown, offer_seen)
  if (response?.shown || response?.queued) {
    if (type === "show_panel" && response.shown && !response.refreshed) await count("asked_show_panel");
    return true;
  }
  if (rule !== "waitingPage") return false;
  // NOTE: [design thought] notifications never show conversation text (IRB protocol)
  chrome.notifications.create(`rate|${id}`, {
    type: "basic", iconUrl: "icons/icon128.png", title: "Advice Tracker: a quick question",
    message: `A conversation on ${record.site} looked like a request for advice. Click to answer a few questions (about 5-10 min).`,
  });
  await count("asked_notification");
  return true;
}

// The reply to the episode's last turn is on the page and complete.
function replySettled(snapshot, turn) {
  if (!snapshot?.settled) return false;
  return Boolean(Episodes.splitTurns(snapshot.messages).replies[turn - 1]);
}

// NOTE: [design thought] a question about the answer just given waits until that answer is
// complete on the page (a settled snapshot with a reply to the episode's last turn). Waiting, the
// record keeps the rule, not the decision: it is run again when the question is finally asked,
// since answers, a snooze or more turns may have come in meanwhile.
async function askWhenSettled(record, rule) {
  if (!Modes[rule](record, Date.now())) return;
  if (replySettled(await load(`snap:${record.chatKey}`), record.end)) {
    await ask(record.id, rule);
    return;
  }
  await updateEpisode(record.id, (current) => ({ ...current, dueAsk: { rule, since: current.dueAsk?.since ?? Date.now() } }));
  chrome.alarms.create(`ask|${record.id}`, { delayInMinutes: 1 });
}

// Ask the question that waited for the reply: once the reply is complete, or after it waited
// ASK_WAIT_MINUTES (the page may never settle: its tab closed, or the site shows no clear end).
async function askDue(id) {
  const record = await load(`episode:${id}`);
  if (!record?.dueAsk) return;
  const complete = replySettled(await load(`snap:${record.chatKey}`), record.end);
  if (!complete && Date.now() < record.dueAsk.since + ASK_WAIT_MINUTES * 60000) {
    chrome.alarms.create(`ask|${id}`, { delayInMinutes: 1 });         // still being written: wait on
    return;
  }
  let rule = null;
  await updateEpisode(id, (current) => {          // the record's chain lets only one caller take it
    if (!current.dueAsk) return current;
    rule = current.dueAsk.rule;
    const { dueAsk, ...rest } = current;
    return rest;
  });
  chrome.alarms.clear(`ask|${id}`);
  if (rule) await ask(id, rule);
}

// Something on a page closed (a ratings page or a pop-up): pop-ups refused there because it was
// open are offered now.
async function offerRefused(tabId) {
  for (const [, record] of await loadAll("episode:")) {
    if (record.refused?.tabId !== tabId) continue;
    const { rule, view } = record.refused;
    await updateEpisode(record.id, ({ refused, ...rest }) => rest);
    await ask(record.id, rule, view);
  }
}

// ---------------- answers from the panel and the check-in page ----------------
// The episode's last turn a page (or pop-up) knew, in the record's numbering: the page sends the
// episode's first and last turn as it knew them, and older turns loaded above since renumber the
// record (afterSync) but not the page; the distance from the first turn stays.
function pageEnd(record, message) {
  return message.start === undefined ? message.end : record.start + message.end - message.start;
}

// A ratings page is on the screen (it may also be a newer state of one already shown).
async function onPanelShown(message, sender) {
  const record = await updateEpisode(message.id, (current) => ({ ...current, askedEnd: Math.max(current.askedEnd ?? 0, pageEnd(current, message)),
                                                                 panelTabs: [...new Set([...(current.panelTabs || []), sender.tab.id])] }));
  // (a queued question shown in the extension's tab is its site's current one until it is answered)
  if (record && Modes.viaQueue(record)) {
    await serialized(`qstate:${record.site}`, async () => save(`qstate:${record.site}`, { ...((await load(`qstate:${record.site}`)) || {}), current: record.id }));
  }
  await updateBadge();
}

// A pop-up was visible for the first time. The confirm pop-up asks nothing about the advice, so
// it leaves askedEnd alone: the first ratings page still comes (lib/modes.js).
async function onOfferSeen(message) {
  if (message.asked === "offer_invite") { await count("asked_offer_invite_seen"); return; }      // an invitation asks nothing yet
  await updateEpisode(message.id, (current) => (message.asked === "offer_confirm"
    ? { ...current, confirmAskedAt: current.confirmAskedAt ?? Date.now() }
    : { ...current, askedEnd: Math.max(current.askedEnd ?? 0, pageEnd(current, message)) }));
  await count(`asked_${message.asked}`);
  await updateBadge();
}

// The participant is done with a ratings page (answered, closed, skipped, snoozed, or moved it to
// a tab): copies of it open in other tabs close, and pop-ups that waited for it come.
async function panelFinished(id, tabId) {
  let others = [];
  await updateEpisode(id, (current) => {
    others = (current.panelTabs || []).filter((tab) => tab !== tabId);
    return { ...current, panelTabs: [] };
  });
  for (const tab of others) chrome.tabs.sendMessage(tab, { type: "close_panel", id }).catch(() => {});
  if (tabId !== undefined) await offerRefused(tabId);
}

// Free text leaves the computer only after redaction, like everything else.
function redactAnswers(answers, names) {
  return Object.fromEntries(Object.entries(answers).map(([key, value]) =>
    [key, typeof value === "string" ? Redact.redact(value, names).text : value]));
}

async function onRatingSubmitted(message) {
  const settings = await getSettings();
  let before = null, stale = false, stage = message.stage;
  const record = await updateEpisode(message.id, (current) => {
    if (["done", "removed"].includes(current.status)) return current;
    // NOTE: [edge case callout] a page built before other answers came in (left open in another
    // tab) would overwrite the newer answers with older ones: its answers are ignored
    if (message.basedOn !== current.versions) { stale = true; return current; }
    before = current;
    // a page shown while the episode was open but answered after it ended answers the end's question
    if (current.finalDue) stage = "final";
    else if (current.status !== "open" && ["first", "temp"].includes(stage)) stage = Modes.closingStage(current);
    const answeredEnd = message.end === undefined ? current.end : pageEnd(current, message);
    // (a question of its site's queue is finished: queueOfferedAt goes)
    const { dueAsk, queueOfferedAt, ...rest } = current;
    let next = { ...rest, answers: message.rating, versions: current.versions + 1, answeredEnd,
                 askedEnd: Math.max(current.askedEnd ?? 0, answeredEnd), finalDue: false, snoozedUntil: null, remindAt: null };
    if (next.status === "pending") next.status = "rated";
    return next;
  });
  if (stale) await count("stale_answers");
  if (!before) return;
  chrome.alarms.clear(`remind|${record.id}`);
  chrome.alarms.clear(`ask|${record.id}`);
  if (!record.checkin) {
    // NOTE: [design thought] the check-in counts from the episode's first request, not from its
    // end or from the answers: an episode can go on for a while, and answers can come days later
    // (one found on another device days later gets it a week after its first answers at the earliest)
    const dueAt = Math.max(record.openedAt + settings.followupSeconds * 1000, record.source === "app" ? Date.now() + 7 * DAY_MS : 0);
    await updateEpisode(record.id, (current) => ({ ...current, checkin: { dueAt, doneAt: null } }));
    chrome.alarms.create(`checkin|${record.id}`, { when: dueAt });
  }
  // NOTE: [design thought] the answers go with the conversation they are about (turns
  // opening..answeredEnd), both redacted on this computer
  const conversation = await transcript(record, record.answeredEnd, settings);
  await upload("episode_rating", {
    episode: record.id, site: record.site, source: record.source ?? "web", mode: record.mode, stage, version: record.versions,
    turns: record.answeredEnd - record.start + 1, opening_turn: record.opening - record.start + 1, open: record.status === "open",
    closed_by: record.closedBy, opened_at: record.openedAt, closed_at: record.closedAt,
    rating: redactAnswers(message.rating, settings.redactNames), related_earlier: record.related.length,
    transcript: conversation?.messages ?? null, redacted: conversation?.counts ?? null,
  }, settings);
  await count(record.versions === 1 ? "rated" : "updated");
  await updateBadge();
  // frequent mode: turns that came while the page was open and did not reach it get their pop-up
  if (record.status === "open" && !ownText(record)) await askWhenSettled(record, "onExtended");
}

async function onCheckinSubmitted(message) {
  const settings = await getSettings();
  const record = await load(`episode:${message.id}`);
  if (!record?.checkin || record.checkin.doneAt) return;
  const later = (await loadAll("episode:")).filter(([, other]) => (other.related || []).includes(record.id)).length;
  chrome.alarms.clear(`checkin|${record.id}`);
  // NOTE: [edge case callout] an episode whose complete conversation did not go yet (it ended while
  // tracking was off) sends it now, before the record lets go of the text; while tracking is still
  // off, the record keeps the text until it is on again (sendWaitingTranscripts)
  await sendTranscript(record.id);
  // an episode from 0.4: the conversation as the participant reviewed it on the check-in page (as
  // 0.4 promised), redacted once more; `transcript_edited` says whether they deleted anything
  const reviewed = Questions.conversationGoes(record, excluded(settings, record.url)) === "at_checkin" &&
                   (record.messages || record.status === "open") && typeof message.transcript === "string";
  await updateEpisode(record.id, (current) => {
    const next = { ...current, checkin: { ...current.checkin, doneAt: Date.now() } };
    const owed = current.answers && current.messages && !current.transcriptSent && !textStays(current, settings);
    return current.status === "open" || owed ? next : doneRecord(next);      // an open one becomes done when it ends
  });
  await upload("checkin", { episode: record.id, site: record.site, source: record.source ?? "web", mode: record.mode,
                            answers: redactAnswers(message.answers, settings.redactNames), related_later: later,
                            ...(reviewed ? { transcript: Redact.redact(message.transcript, settings.redactNames).text,
                                             transcript_edited: Boolean(message.edited) } : {}) }, settings);
  await count("checked_in");
  await updateBadge();
}

// The episode is no longer asked about: "No" (not advice) on an episode without answers. An open
// one is marked and its chat closes it (so its later turns go to the advice judge only, and its
// text goes once the chat is settled); a closed one is deleted.
async function removeEpisode(id) {
  let gone = null;
  await updateEpisode(id, (record) => {
    if (record.status === "removed") return record;          // removed before: its chat deletes it
    // NOTE: [design thought] the participant's latest answer counts: a "No" from a page or pop-up
    // left open in another tab removes the episode even after answers (the page then says so); the
    // upload tells the study team that answers already sent belong to a removed episode
    gone = record;
    return record.status === "open" ? { ...withoutText(record), status: "removed", openingText: "", answers: null } : null;
  });
  if (!gone) return null;
  for (const alarm of ["pause", "ask", "remind", "checkin"]) chrome.alarms.clear(`${alarm}|${id}`);
  // one found among conversations read from the site, or held by the walk, is not asked about again
  // if found again
  if (gone.source === "app" || gone.source === "past" || gone.heldBy) await rememberDecided(id);
  if (gone.status === "open") { if (ownText(gone)) { kickHistory(); settleHanded(); } else advance(gone.chatKey); }
  await updateBadge();
  return gone;
}

async function onNotAdvice(message) {
  const gone = await removeEpisode(message.id);
  if (!gone) return;
  await serialized("queue", async () => save("queue", ((await load("queue")) || []).filter((event) => event.payload.episode !== gone.id)));
  await count("not_advice");
  // counts only: no text, no answers
  await upload("not_advice", { episode: gone.id, site: gone.site, source: gone.source ?? "web", mode: gone.mode, turns: gone.end - gone.start + 1,
                               opening_turn: gone.opening - gone.start + 1, open: gone.status === "open",
                               closed_by: gone.closedBy, had_answers: Boolean(gone.answers) }, await getSettings());
}

// ✕ on a page of an episode that has answers: they stand as they are. On the final page this
// makes them the final ones. (A page without answers has no ✕: a conversation cannot be skipped,
// only answered, put off with "later (1 h)", or marked as not advice.)
async function onPanelClosed(message) {
  if (message.stage === "final") {
    await updateEpisode(message.id, (record) => (record.finalDue ? { ...record, finalDue: false } : record));
  }
  await updateBadge();
}

// "later (1 h)": nothing is asked about the episode for an hour; then the page comes back (or a
// notification, if its chat is not open in a tab).
async function onSnoozed(message) {
  const until = Date.now() + SNOOZE_MINUTES * 60000;
  await updateEpisode(message.id, ({ dueAsk, ...record }) => ({ ...record, snoozedUntil: until, remindAt: until }));
  chrome.alarms.clear(`ask|${message.id}`);
  chrome.alarms.create(`remind|${message.id}`, { when: until });
}

async function onReminder(id) {
  await updateEpisode(id, (current) => ({ ...current, snoozedUntil: null, remindAt: null }));
  await ask(id, "waitingPage");
}

// The update pop-up's outcome: yes (the panel opened on the page), no, no answer in time, or
// superseded (a ratings page took its place).
async function onUpdateAnswer(message) {
  const record = await load(`episode:${message.id}`);
  await count(`update_${message.answer}`);
  if (record) {
    await upload("prompt", { episode: record.id, source: record.source ?? "web", mode: record.mode, prompt: "update", answer: message.answer,
                             turns: record.end - record.start + 1 }, await getSettings());
  }
}

// The confirm pop-up's outcome (combined mode): yes, no, no answer in time, or superseded (a
// ratings page took its place, and asks the question itself). Yes spares the later ratings page
// the question; No is "not advice", as on that page, whose copies in other tabs close too.
async function onConfirmAnswer(message, tabId) {
  const record = await load(`episode:${message.id}`);
  await count(`confirm_${message.answer}`);
  if (record) {
    await upload("prompt", { episode: record.id, source: record.source ?? "web", mode: record.mode, prompt: "confirm", answer: message.answer,
                             turns: record.end - record.start + 1 }, await getSettings());
  }
  if (message.answer === "yes") await updateEpisode(message.id, (current) => ({ ...current, confirmedAt: current.confirmedAt ?? Date.now() }));
  if (message.answer === "no" && record) await panelFinished(message.id, tabId).then(() => onNotAdvice(message));
  else await offerRefused(tabId);
}

// The extension icon shows how many questions wait: ratings pages (lib/modes.js `waiting`) and
// check-ins that are due.
async function updateBadge() {
  const now = Date.now();
  const settings = await getSettings();
  // (a queued question whose kind is off, or whose site is excluded, cannot be asked: it does not count)
  const askable = (record) => !Modes.viaQueue(record) || (kindOn(settings, record) && !excluded(settings, record.url));
  const waiting = (await loadAll("episode:")).filter(([, record]) => (Modes.waiting(record) && askable(record)) || Modes.checkinDue(record, now)).length;
  await chrome.action.setBadgeText({ text: waiting ? String(waiting) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#4f5bd5" });
}

// A question nobody answered by the time the episode's check-in is due (followupSeconds after its
// first request) is dropped: an ended episode never answered goes (with its text), and final
// answers that never came leave the earlier ones as the final ones.
async function expireWaiting() {
  const settings = await getSettings();
  const limit = Date.now() - settings.followupSeconds * 1000;
  // NOTE: [edge case callout] 0.3 kept no start time, only the end (the update gives a 0.3 record
  // its end as start, but the heartbeat a new worker sends at once can come before that)
  // (an episode from another device counts from when it was found; a past one never annotated goes,
  // with its text, PAST_EXPIRE_DAYS after it was found)
  const recent = (record) => (record.detectedAt ?? record.openedAt ?? record.closedAt) > limit;
  for (const [, record] of await loadAll("episode:")) {
    if (record.source === "past") {
      if (record.status === "pending" && Date.now() > record.detectedAt + PAST_EXPIRE_DAYS * DAY_MS) {
        await updateEpisode(record.id, (current) => (current.answers ? current : null));
        await count("expired_past");
      }
      continue;
    }
    if (recent(record)) continue;
    if (record.status === "pending") {
      let expired = false;
      await updateEpisode(record.id, (current) => (current.status === "pending" && !recent(current) ? ((expired = true), null) : current));
      if (expired) await count("expired");
    } else if (record.finalDue) {
      await updateEpisode(record.id, (current) => ({ ...current, finalDue: false }));
    }
  }
  await updateBadge();
}

// ---------------- conversations read from the site itself (0.6, opt-in) ----------------
// With readPast or readApps on (settings page, after the participant agreed), the worker reads the
// participant's conversation list and, one at a time, the conversations that changed, through a
// loaded tab of the site (content/history.js asks the site's own API: lib/history/<site>.js). Their
// user turns are sorted by who sent them (lib/history.js): past turns (before the participant
// joined) and app turns (after it, not seen on the web) are judged here, by a walk through the
// conversation with the same two judges and rules as on the web; web turns were judged on the web.
// An open episode is held by one side at a time (record.heldBy): the web chat that judges its turns,
// or the walk ("history"). When the holder meets the other side's turns it hands the episode over
// instead of ending it, so an advice conversation can move between the phone and the web.
// Storage:
//   hlist:<host>        the listed conversations, newest first ({id, u: updated, c: created}), when page 1
//                       was listed, and how far back the list has been walked (cursor, end, reached)
//   hstate:<host>       the site's reading state: when to read again, a pause it asked for, blocked,
//                       the account read (a hash), a conversation to read first
//   hist:<host>/<id>    a conversation read from the site: its user turns' loose hashes and times, exact
//                       ids (to notice an edit when it is read again), and the walk's judging state (as a
//                       chat's, lib/episodes.js); no text
//   htext:<host>/<id>   (chrome.storage.session: never sent to the chat pages, gone when the browser
//                       closes) its text as last read, without the turns that may not be read
//   hdone               ids of episodes found so that the participant answered No or skipped: never asked again
//   qstate:<site>       the site's invitations: when the last one came, today's past ones, misses in a row
//   historyEpoch        bumped when a switch changes and at "delete all data": answers to requests made
//                       before are dropped
const DAY_MS = 24 * 3600 * 1000;
const HISTORY_SITES = STUDY_CONFIG.historySites;
const LIST_EVERY_MS = 20 * 60000;      // page 1 of a site's conversation list this often
const ANSWER_WAIT_MS = 20000;          // a tab that does not answer a request within this is passed over
const PAST_TURNS_JUDGED = 10;          // a past conversation: the advice judge on its first 10 past turns at most ...
const PAST_WINDOW_TURNS = 10;          // ... and a past episode is the request and the 9 turns after it, at most
const PAST_SCAN_MAX = 150;             // past conversations looked at, at most
const PAST_EXPIRE_DAYS = 30;           // a past episode never answered goes this long after it was found
const READ_TRIES_MAX = 5;              // a conversation that fails to read this often is left until it changes on the site
const JUDGE_TRIES_MAX = 5;             // a turn the judge refuses (or fails on) this often counts as not judged by the walk
const YOUNG_TURN_MS = 5 * 60000;       // a turn this young may still prove to be sent on the web (its snapshot is on its way)
const LIVE_WAIT_MS = 2 * 60000;        // a web turn after turns from elsewhere waits for the walk while it gets on (each step within this) ...
const LIVE_WAIT_MAX_MS = 15 * 60000;   // ... this long at most
const WEB_WAIT_MS = 5 * 60000;         // ... and the walk this long for the web page to take the episode over
const HISTORY_SUBMIT_GAP_MS = 15000, HISTORY_DAILY_MAX = 200, JUDGE_QUEUE_BUSY = 2;
const INVITE_GAP_MS = 4 * 3600 * 1000, PAST_INVITES_A_DAY = 2, PAST_MISSES_MAX = 3, BUSY_PAGE_MS = 5 * 60000;    // (a day: any 24 hours)
const historyOn = (settings) => Boolean(settings.readPast || settings.readApps);
// Reading, judging and asking about conversations read from a site happen only while tracking is on
// (participant ID set, not paused), the site is not excluded, and a switch is on.
const historyAllowed = (settings, host) => historyOn(settings) && !trackingOff(settings) && !excluded(settings, `https://${host}/`);
const hostOf = (url) => new URL(url).hostname;
const epochNow = async () => (await load("historyEpoch")) || 0;
async function loadText(key) { return (await chrome.storage.session.get(`htext:${key}`))[`htext:${key}`]; }
async function waitingTexts() { return Object.keys(await chrome.storage.session.get(null)).filter((name) => name.startsWith("htext:")); }
// the kind an episode belongs to, for the switches: found among past turns, or (from elsewhere) app
const kindOf = (record) => (record.source === "past" ? "past" : record.source === "app" || record.heldBy === "history" ? "app" : "web");
const kindOn = (settings, record) => ({ past: settings.readPast, app: settings.readApps, web: true })[kindOf(record)];
// the episode's key for the study team, to pay each past conversation once: its chat, its request's
// turn and the site's time of it (no hash of any text: it could be checked against guesses)
const fingerprint = (record) => `${Episodes.hash(record.chatKey)}-${record.opening}-${(record.openedAt || 0).toString(36)}`;

// What may be read of `host` now (lib/history.js windows)
async function historyWindows(host, settings) {
  const joinedAt = await load("joinedAt");
  const windows = History.windows({ host, joinedAt, pastBefore: (await load("pastBefore")) ?? joinedAt, floor: (await load("deletedAt")) || 0,
                                    trackingLog: (await load("trackingLog")) || [], aliveLog: (await load("aliveLog")) || [], now: Date.now(),
                                    lookbackDays: STUDY_CONFIG.pastLookbackDays, readPast: settings.readPast, readApps: settings.readApps });
  // (the gaps of the part of the extension's own log that was dropped as it grew)
  return { ...windows, off: [...windows.off, ...((await load("aliveGaps")) || [])] };
}

// ---- reading ----
// Every minute while a switch is on (alarm hread): one request to one site, if one is due.
// NOTE: [design thought] one conversation at a time: no other conversation is read while one waits to
// be judged (the storage and the judge stay small), except one a web page waits for; the list's
// first page (no text) is refreshed meanwhile
async function historyTick() {
  const settings = await getSettings();
  if (!historyOn(settings) || trackingOff(settings) || !(await load("joinedAt"))) return;
  const busy = (await waitingTexts()).length > 0;
  if (busy) kickHistory();
  const config = (await load("hconfig")) || {};
  for (const host of HISTORY_SITES) {
    if (!historyAllowed(settings, host) || config.history?.[host] === false) continue;
    const state = (await load(`hstate:${host}`)) || {};
    if (await historyStep(host, settings, state, busy)) return;
  }
}

// One request to `host`: a conversation a page waits for first, then page 1 of the list (every 20
// min, and the pages after it while they hold only new or changed conversations), then the next
// conversation to read, then one more page further back. Returns whether one went.
async function historyStep(host, settings, state, busy) {
  const now = Date.now();
  if (state.blocked || (state.waitUntil ?? 0) > now) return false;
  const tabs = (await chrome.tabs.query({ url: `https://${host}/*` })).filter((tab) => !tab.discarded && tab.status === "complete");
  if (!tabs.length) return false;
  const list = (await load(`hlist:${host}`)) || { items: [], listedAt: 0, cursor: null, end: false, reached: null, refresh: null };
  const windows = await historyWindows(host, settings);
  let request = null;
  // (a read carries the list's time of the conversation: what the walk compares with next time)
  const listedU = (id) => list.items.find((item) => item.id === id)?.u ?? null;
  if (state.priority) request = { what: "read", id: state.priority, listedU: listedU(state.priority), reason: "asked" };
  else if (now - list.listedAt >= LIST_EVERY_MS) request = { what: "list", cursor: null, refresh: true };
  else if (list.refresh !== null && list.refresh !== undefined) request = { what: "list", cursor: list.refresh, refresh: true };
  else if (!busy) {
    const next = await nextToRead(host, list, windows, settings);
    const since = settings.readPast ? windows.pastFrom : windows.appFrom;
    if (next) request = { what: "read", id: next.id, listedU: listedU(next.id), reason: next.reason };
    else if (!list.end && (list.reached ?? Infinity) > since) request = { what: "list", cursor: list.cursor };
  }
  if (!request) return false;
  await save(`hstate:${host}`, { ...state, priority: request.reason === "asked" ? null : state.priority ?? null });
  const epoch = await epochNow();
  let reply = null;
  for (const tab of tabs) {
    reply = await Promise.race([chrome.tabs.sendMessage(tab.id, { type: "history_fetch", ...request, windows }).catch(() => null),
                                new Promise((resolve) => setTimeout(() => resolve(null), ANSWER_WAIT_MS))]);
    if (reply) break;
  }
  // switched off, deleted or paused meanwhile: what came back is dropped
  if ((await epochNow()) !== epoch || !historyAllowed(await getSettings(), host)) return true;
  await historyReply(host, request, reply);
  return true;
}

// The next conversation to read: one whose walk a browser restart cut off (its text went), then one
// changed since joining that was not read at its latest change (it may have turns from elsewhere),
// newest first, then a past one never read, newest first. A conversation that is gone, too long, or
// failed to read (READ_TRIES_MAX times, or not again yet) waits for a newer change on the site.
async function nextToRead(host, list, windows, settings) {
  const now = Date.now();
  const known = new Map((await loadAll(`hist:${host}/`)).map(([, hist]) => [hist.id, hist]));
  const texts = new Set((await waitingTexts()).map((name) => name.slice("htext:".length)));
  const stranded = [...known.values()].find((hist) => hist.judge && !texts.has(hist.key) &&
                                             (hist.judge.judgedThrough < hist.turns.length || hist.judge.pending));
  if (stranded) return { id: stranded.id, reason: "again" };
  // NOTE: [edge case callout] compared with the list's own time as it was when the conversation was
  // read (a site's list and its conversation can give different times for the same change)
  const waits = (hist, item) => hist && (hist.failedU === item.u ? hist.failures >= READ_TRIES_MAX || hist.retryAt > now
                                                                 : hist.listedU === item.u);
  if (settings.readApps) {
    const changed = list.items.find((item) => item.u >= windows.appFrom && !waits(known.get(item.id), item));
    if (changed) return { id: changed.id, reason: "app" };
  }
  if (!settings.readPast || !(await load("joinedChecked")) || (await pastLeft()) <= 0 ||
      [...known.values()].filter((hist) => hist.pastRead).length >= PAST_SCAN_MAX) return null;
  const past = list.items.find((item) => (item.c ?? item.u) < windows.pastBefore && item.u >= windows.pastFrom &&
                                         (!known.has(item.id) || (!known.get(item.id).judge && !waits(known.get(item.id), item))));
  return past ? { id: past.id, reason: "past" } : null;
}

// How many more past conversations may be found: at most pastLimit waiting or annotated (skipped ones
// and "No" do not count)
async function pastLeft() {
  return STUDY_CONFIG.pastLimit - (await loadAll("episode:")).filter(([, record]) => record.source === "past").length;
}

// What the tab answered. For the list, the site's own pauses are kept: 429 (it asked to wait: from 30
// minutes up to 6 hours, doubling), 401 (signed out, after one new token: an hour), 403 or a page
// instead of data (blocked: nothing until the browser starts again); no answer or another error: 10
// minutes. For one conversation, a failure is that conversation's (tried again later, at most
// READ_TRIES_MAX times), and 404 means it is gone. The site is read for one personal account only:
// the first one read.
async function historyReply(host, request, reply) {
  const state = (await load(`hstate:${host}`)) || {};
  const now = Date.now();
  const pause = (ms, extra = {}) => save(`hstate:${host}`, { ...state, waitUntil: now + ms, ...extra });
  const key = `${host}/${request.id}`;
  if (!reply?.ok && request.what === "read" && reply?.status !== 429) {
    if (reply?.status === 404) return forgetConversation(host, request.id, request.listedU);
    if (reply?.status === 401) return pause(3600 * 1000, { signedOut: true });
    // NOTE: [edge case callout] one conversation that cannot be read (an error of the site's for it, a
    // reader that trips over it, an answer too slow) must not stop the others
    return serialized(`hist:${key}`, async () => {
      const hist = (await load(`hist:${key}`)) || { key, id: request.id, host, turns: [], ids: [], judge: null };
      const failures = hist.failedU === request.listedU ? (hist.failures || 0) + 1 : 1;
      await save(`hist:${key}`, { ...hist, failedU: request.listedU, failures, retryAt: now + 10 * 60000 * 2 ** (failures - 1) });
    });
  }
  if (!reply) return pause(10 * 60000);
  if (!reply.ok) {
    if (reply.status === 429) {
      const wait = Math.min(Math.max(state.backoffMs ? 2 * state.backoffMs : 30 * 60000, reply.retryAfterMs ?? 0), 6 * 3600 * 1000);
      return pause(wait, { backoffMs: wait });
    }
    if (reply.status === 401) return pause(3600 * 1000, { signedOut: true });
    if (reply.status === 403 || reply.blocked) return save(`hstate:${host}`, { ...state, blocked: true });
    return pause(10 * 60000);
  }
  // NOTE: [design thought] another account (a family member's, a work one) or a team workspace is
  // never read: only the personal account first read after the participant agreed. For a site whose
  // reader cannot say which account is signed in (Grok), one account in this browser is assumed, under
  // this install's own code; a list page that looks like another account's (sameAccount) pauses it
  const bound = await load(`haccount:${host}`);
  const account = reply.account ?? (reply.accountKnown === false ? `assumed-${await load("installId")}` : null);
  if (!account || reply.personal !== true || (bound && bound !== account)) return pause(3600 * 1000, { otherAccount: true });
  if (request.what === "list" && reply.accountKnown === false && !(await sameAccount(host, reply.page))) return pause(3600 * 1000, { otherAccount: true });
  if (!bound) await save(`haccount:${host}`, account);
  await save(`hstate:${host}`, { ...state, backoffMs: 0, signedOut: false, otherAccount: false, waitUntil: 0 });
  if (request.what === "list") return mergeList(host, request, reply.page);
  if (reply.gone) return forgetConversation(host, request.id, request.listedU);
  if (reply.tooLong) {
    return serialized(`hist:${key}`, async () => save(`hist:${key}`, { key, id: request.id, host, tooLong: true, listedU: request.listedU,
                                                                        turns: [], ids: [], judge: null }));
  }
  return historyConversation(host, reply.conversation, request.listedU, request.reason === "past");
}

// For a site whose reader cannot name the account: does this list page look like the same account's?
// Not if none of its conversations is known although some are older than the newest one known (that is
// someone else's history; a page of conversations all new since the last look is fine).
async function sameAccount(host, page) {
  const list = (await load(`hlist:${host}`))?.items || [];
  if (!list.length || !page.items.length) return true;
  const known = new Set(list.map((item) => item.id)), newest = Math.max(...list.map((item) => item.u));
  return page.items.some((item) => known.has(item.id)) || page.items.every((item) => item.updatedAt > newest);
}

// A page of the list, newest first: merged in. Page 1 (no cursor) starts a refresh, which goes on to the
// next page while a page holds only conversations that are new or changed (the participant may have
// had many since the last look, on the phone); the walk back through older pages goes on from where it
// stopped. How far back it got counts only the list's own order (pinned conversations, which the site
// puts first whatever their time, and items without a time do not count).
function mergeList(host, request, page) {
  return serialized(`hlist:${host}`, async () => {
    const list = (await load(`hlist:${host}`)) || { items: [], listedAt: 0, cursor: null, end: false, reached: null, refresh: null };
    const byId = new Map(list.items.map((item) => [item.id, item]));
    const unseen = page.items.filter((item) => byId.get(item.id)?.u !== item.updatedAt);
    for (const item of page.items) byId.set(item.id, { id: item.id, u: item.updatedAt, c: item.createdAt ?? null });
    const regular = page.items.filter((item) => !item.pinned && Number.isFinite(item.updatedAt)).map((item) => item.updatedAt);
    const oldest = regular.length ? Math.min(...regular) : null;
    const next = { ...list, items: [...byId.values()].sort((a, b) => b.u - a.u).slice(0, 3000) };
    if (request.refresh) {
      if (request.cursor === null) next.listedAt = Date.now();
      // (the first refresh also starts the walk back)
      if (!list.listedAt) Object.assign(next, { cursor: page.next ?? null, end: !page.next });
      next.refresh = list.listedAt && page.next && unseen.length === page.items.length ? page.next : null;
    } else {
      Object.assign(next, { cursor: page.next ?? null, end: !page.next });
    }
    if (!request.refresh || !list.listedAt) next.reached = Math.min(list.reached ?? Infinity, oldest ?? Infinity);
    await save(`hlist:${host}`, next);
  });
}

// A conversation is gone from the site (deleted there): its copy goes, and a note that it is gone
// stays (it is not asked for again unless the list shows it changed). Episodes found in it without
// answers go; one with answers ends now, without its text (the participant deleted it).
async function forgetConversation(host, id, listedU = null) {
  const key = `${host}/${id}`, hist = await load(`hist:${key}`);
  await serialized(`hist:${key}`, async () => {
    await save(`hist:${key}`, { key, id, host, gone: true, listedU, turns: [], ids: [], judge: null });
    await chrome.storage.session.remove(`htext:${key}`);
  });
  const chat = hist?.chat ?? (await chatKey({ key }));
  for (const [, record] of await loadAll("episode:")) {
    if (record.chatKey !== chat || record.heldBy !== "history") continue;
    if (!record.answers && record.source !== "web") { await updateEpisode(record.id, () => null); continue; }
    if (record.status === "open") {
      await episodeClosed({ id: record.id, start: record.start, opening: record.opening, end: record.end, closedBy: "gone", openedAt: record.openedAt }, null);
    }
    await updateEpisode(record.id, (current) => ({ ...withoutText(current), keepText: true, walk: null, finalDue: false }));
  }
  await updateBadge();
}

// One conversation, read whole from the site: {id, url, title, createdAt, updatedAt, messages:
// [{role, content, at, h, bare}]} (content null for turns that may not be read). A conversation read
// before keeps its judgments up to its first turn that changed (an edit); from there on it is judged
// again. `past`: it was read as a past conversation (they are looked at PAST_SCAN_MAX at most).
async function historyConversation(host, conversation, listedU = null, past = false) {
  const started = generation;
  const key = `${host}/${conversation.id}`;
  const chat = await chatKey({ key });                   // the chat's key on the web (a new chat's first key)
  const user = conversation.messages.filter((m) => m.role === "user");
  const ids = Episodes.turnIds(user.map((m) => m.content ?? `\u0000${m.h}`));
  let vanished = null;
  await serialized(`hist:${key}`, async () => {
    const before = await load(`hist:${key}`);
    let judge = before?.judge || { ...Episodes.newChat({ key, site: SITE_CONFIGS[host].name, now: Date.now() }), episodeId: null };
    let same = 0;
    while (before?.judge && same < before.ids.length && same < ids.length && before.ids[same] === ids[same]) same++;
    // NOTE: [edge case callout] a judgment in flight about a turn that changed: its label is about the
    // old text, so it is dropped and the turn judged again
    if (judge.pending && same < judge.pending.turn) judge = { ...judge, pending: null };
    if (before?.judge && same < judge.judgedThrough) {
      // NOTE: [edge case callout] an open episode that began before the changed turn ends there (as on
      // the web); one that opened at or after it never happened (it keeps answers already given)
      const open = judge.state === "episode" ? judge : null;
      const { chat: rewound, closed } = Episodes.rewind(judge, same + 1);
      judge = { ...rewound, episodeId: null, webWaitSince: null };
      if (open && closed) judge.closing = { ...closed, id: open.episodeId };
      else if (open) vanished = open.episodeId;
    }
    if (started !== generation) return;
    const { failedU, failures, retryAt, gone, tooLong, ...kept } = before || {};
    await save(`hist:${key}`, { ...kept, key, id: conversation.id, chat, host, site: SITE_CONFIGS[host].name, url: conversation.url,
                                title: conversation.title || "", createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
                                listedU: listedU ?? conversation.updatedAt, pastRead: Boolean(before?.pastRead || past),
                                readAt: Date.now(), ids, turns: user.map((m) => ({ h: m.h, at: m.at, bare: Boolean(m.bare) })), judge });
    await chrome.storage.session.set({ [`htext:${key}`]: { messages: conversation.messages.map(({ role, content }) => ({ role, content })),
                                                          version: ((await loadText(key))?.version || 0) + 1 } });
  });
  if (vanished) {
    await updateEpisode(vanished, (record) => (record.heldBy !== "history" ? record : record.answers
      ? closedRecord(record, { status: "rated", finalDue: false }, { end: record.end, closedBy: "edited" }, record.messages) : null));
  }
  kickHistory(key);
}

// ---- the walk: judging the turns read from the site ----
// The conversations read from the site, one after the other, one judgment at a time in the whole
// extension: a conversation a web page waits for first, then those with turns from elsewhere, then
// past ones. Runs again afterwards if asked to while it runs.
let historyRunning = false, historyAgain = false, historyFirst = null;
async function kickHistory(first = null) {
  if (first) historyFirst = first;
  if (historyRunning) { historyAgain = true; return; }
  historyRunning = true;
  try {
    do {
      historyAgain = false;
      const hists = (await loadAll("hist:")).map(([, hist]) => hist).filter((hist) => hist.judge);
      const joinedAt = (await load("joinedAt")) || 0;
      const rank = (hist) => (hist.judge.pending ? 0 : hist.key === historyFirst ? 1 : hist.updatedAt >= joinedAt ? 2 : 3);
      historyFirst = null;
      for (const hist of hists.sort((a, b) => rank(a) - rank(b))) await settleHistory(hist.key);
    } while (historyAgain);
  } catch (error) {
    console.error("history", error);
    chrome.alarms.create("hjudge|", { delayInMinutes: RETRY_MINUTES });
  } finally {
    historyRunning = false;
  }
}

// Save the walk's state of a conversation (and `extra` fields of it), unless the conversation was
// read again since `expected` was loaded (its new reading decides then). Returns whether it was saved.
function saveJudge(key, expected, judge, started, extra = {}) {
  return serialized(`hist:${key}`, async () => {
    const hist = await load(`hist:${key}`);
    if (!hist || started !== generation || JSON.stringify(hist.judge) !== JSON.stringify(expected)) return false;
    await save(`hist:${key}`, { ...hist, ...extra, judge });
    return true;
  });
}

// May a history judgment be submitted now? One at a time in the whole extension (the one in flight
// goes first), at least 15 s apart, at most 200 a day, and only while the study's judge is not busy:
// the participants' turns on the web go first. Returns the time to look again, or 0.
let lastHistorySubmit = 0, judgeHealth = { at: 0, waiting: 0 };
async function historyMayJudge(key, settings) {
  if ((await loadAll("hist:")).some(([, hist]) => hist.judge?.pending && hist.key !== key)) return Date.now() + 60000;
  if (running.size) return Date.now() + 60000;
  if (Date.now() < lastHistorySubmit + HISTORY_SUBMIT_GAP_MS) return lastHistorySubmit + HISTORY_SUBMIT_GAP_MS;
  const day = Math.floor(Date.now() / DAY_MS), budget = (await load("hjudged")) || {};
  if (budget.day === day && budget.count >= HISTORY_DAILY_MAX) return (day + 1) * DAY_MS;
  if (Date.now() > judgeHealth.at + 60000) {
    try {
      const response = await fetch(`${settings.serverUrl}/health`, { signal: AbortSignal.timeout(10000) });
      judgeHealth = { at: Date.now(), waiting: (await response.json()).waiting ?? 0 };
    } catch (error) {
      judgeHealth = { at: Date.now(), waiting: Infinity };
    }
  }
  return judgeHealth.waiting > JUDGE_QUEUE_BUSY ? Date.now() + 5 * 60000 : 0;
}

async function historySubmitted() {
  lastHistorySubmit = Date.now();
  const day = Math.floor(Date.now() / DAY_MS);
  await serialized("hjudged", async () => {
    const budget = (await load("hjudged")) || {};
    await save("hjudged", { day, count: budget.day === day ? budget.count + 1 : 1 });
  });
}

// The walk through one conversation read from the site, in order, until every turn is judged (as
// settle does for a chat on the web).
async function settleHistory(key) {
  const started = generation;
  for (;;) {
    const settings = await getSettings();
    const hist = await load(`hist:${key}`), text = await loadText(key);
    if (!hist?.judge || started !== generation || !historyAllowed(settings, hist.host)) return;
    const { userTurns, replies } = Episodes.splitTurns((text?.messages || []).map((m) => ({ role: m.role, content: m.content ?? "" })));
    const page = text ? { userTurns, replies, started } : null;
    const judge = hist.judge;
    const store = (next, extra) => saveJudge(key, judge, next, started, extra);

    // a closing noted before the worker stopped: finish it (as finishClosing does for a chat)
    if (judge.closing) {
      await episodeClosed(judge.closing, page);
      await store({ ...judge, closing: null });
      continue;
    }
    // the open episode: still this walk's? (its record says who holds it), and as long as the walk says
    if (judge.state === "episode") {
      const next = await followHistoryEpisode(hist, judge, page, settings);
      if (next !== judge) { await store(next); continue; }
      // a past episode is complete as found (its window): it ends once its record is there
      if (judge.pastPending && (await load(`episode:${judge.episodeId}`))) { await store(closeHistory(judge, "window")); continue; }
    }

    if (judge.pending) {
      chrome.alarms.create(`hjudge|${key}`, { delayInMinutes: 1 });
      const result = await collect(judge.pending.id, settings);
      if (started !== generation) return;
      if (result.state === "waiting") continue;
      if (result.state === "done") {
        await applyHistoryLabel(hist, judge, result.label, store, settings);
        await count("judged_history");
        continue;
      }
      if (result.state === "unreachable") return;
      if (result.state === "unknown") { await store({ ...judge, pending: null }); continue; }       // (the server restarted)
      await store(failedOnce(judge, judge.pending.turn));
      chrome.alarms.create(`hjudge|${key}`, { delayInMinutes: RETRY_MINUTES });
      return;
    }

    const turn = judge.judgedThrough + 1;
    if (turn > hist.turns.length) {
      if (judge.state === "episode") {
        const ended = await historyEpisodeOver(hist, judge, settings);
        if (ended) { await store(closeHistory(judge, ended)); continue; }
      }
      // nothing more needs the text; a web turn that waited for these turns goes on
      await serialized(`hist:${key}`, async () => {
        if ((await loadText(key))?.version === text?.version) await chrome.storage.session.remove(`htext:${key}`);
      });
      if (!hist.pastScanned) await store(judge, { pastScanned: true });
      if ((await load(`chat:${hist.chat}`))?.waitedSince) advance(hist.chat);
      return;
    }
    if (!page) return;                       // its text went (the browser restarted): judged when it is read again

    const owners = History.owners(hist.turns, { sentlog: (await load(`sentlog:${hist.chat}`)) || [], windows: await historyWindows(hist.host, settings) });
    const owner = owners[turn - 1], at = hist.turns[turn - 1].at;
    // a young turn may still prove to be sent on the web (its snapshot is on its way), unless a later
    // turn of the conversation is already known as sent there
    if (owner === "app" && Date.now() < at + YOUNG_TURN_MS && !owners.slice(turn).includes("web")) {
      chrome.alarms.create(`hjudge|${key}`, { when: at + YOUNG_TURN_MS });
      return;
    }
    // NOTE: [edge case callout] a turn the judge keeps refusing (a very long pasted text, a failing
    // job) would stop this walk, and with it all reading: after JUDGE_TRIES_MAX tries it counts as a
    // turn this walk does not judge
    const tries = judge.tries?.turn === turn ? judge.tries.count : 0;
    if (tries >= JUDGE_TRIES_MAX) {
      const next = judge.state === "episode" ? closeHistory(judge, "off") : judge;
      await store({ ...next, judgedThrough: turn, segmentStart: turn + 1, tries: null, retryAt: null });
      continue;
    }
    if ((judge.retryAt ?? 0) > Date.now()) { chrome.alarms.create(`hjudge|${key}`, { when: judge.retryAt }); return; }

    if (judge.state === "episode") {
      if (owner === "web") {
        // the conversation went on on the web: the web page takes the episode over (background.js
        // takeFromElsewhere) and the walk waits for that a little; else the episode ends here
        const since = judge.webWaitSince ?? Date.now();
        if (Date.now() < since + WEB_WAIT_MS) {
          if (!judge.webWaitSince) await store({ ...judge, webWaitSince: since });
          if ((await load(`chat:${hist.chat}`))?.waitedSince) advance(hist.chat);
          chrome.alarms.create(`hjudge|${key}`, { delayInMinutes: 1 });
          return;
        }
        await store({ ...closeHistory(judge, "web"), judgedThrough: turn, segmentStart: turn + 1 });
        continue;
      }
      if (owner !== "app") {
        await store({ ...closeHistory(judge, "off"), judgedThrough: turn, segmentStart: turn + 1 });
        continue;
      }
      // NOTE: [design thought] the cut and the quiet day are measured by the turns' own times here:
      // a turn sent a week after the request, or after a day without any, starts afresh
      if (at >= judge.openedAt + settings.cutDays * DAY_MS || at - hist.turns[turn - 2].at > settings.endQuietMinutes * 60000) {
        await store(closeHistory(judge, at >= judge.openedAt + settings.cutDays * DAY_MS ? "cut" : "quiet"));
        continue;
      }
    } else {
      const past = owner === "past" && !hist.pastFound && (hist.pastJudged || 0) < PAST_TURNS_JUDGED && (await pastLeft()) > 0;
      if (owner !== "app" && !past) {
        // a turn this walk does not judge: the search starts after it
        await store({ ...judge, judgedThrough: turn, segmentStart: turn + 1 });
        continue;
      }
      if (owner === "app" && turn === judge.segmentStart && turn > 1) {
        // turns from elsewhere right after an open episode (the web page's, or one handed over) continue it
        const taken = await takeEpisode(hist, turn, settings);
        if (taken) { await store({ ...judge, state: "episode", ...taken }); continue; }
      }
    }
    const later = await historyMayJudge(key, settings);
    if (later) {
      // (a wait shorter than the alarms' minute goes by a timer: a web page may be waiting for this walk)
      if (later - Date.now() < 60000) setTimeout(() => kickHistory(key), later - Date.now());
      chrome.alarms.create(`hjudge|${key}`, { when: Math.max(later, Date.now() + 60000) });
      return;
    }
    let job = Episodes.nextJob(judge, userTurns, replies);
    if (job.kind === "continuation" && !job.previous) job = { ...job, ...(await previousFromRecord(judge)) };
    const id = await submit({ ...job, source: owner }, { site: hist.site }, settings);
    if (started !== generation) return;
    if (!id) {
      await store(failedOnce(judge, turn));
      chrome.alarms.create(`hjudge|${key}`, { delayInMinutes: RETRY_MINUTES });
      return;
    }
    await historySubmitted();
    // hash: the turn's text, which a new reading can change before the label comes
    await store({ ...judge, pending: { id, kind: job.kind, turn, sentAt: at, owner, hash: Episodes.hash(userTurns[turn - 1]) } });
  }
}

// A label came for the walk's judgment in flight: as Episodes.applyLabel on the web, with two
// differences: an advice request among past turns is a past episode of at most PAST_WINDOW_TURNS turns
// (no continuation judgments, one per conversation), and the past turns judged are counted.
async function applyHistoryLabel(hist, judge, label, store, settings) {
  const job = judge.pending;
  let { chat: next, closed } = Episodes.applyLabel(judge, job, label);
  const extra = {};
  if (job.kind === "advice" && job.owner === "past") {
    extra.pastJudged = (hist.pastJudged || 0) + 1;
    if (next.state === "episode") {
      // the past episode: the request and the turns after it, while they are past turns in a row,
      // before its cut, PAST_WINDOW_TURNS at most
      const windows = await historyWindows(hist.host, settings);
      const owners = History.owners(hist.turns, { sentlog: (await load(`sentlog:${hist.chat}`)) || [], windows });
      let end = job.turn;
      while (end < hist.turns.length && end - job.turn + 1 < PAST_WINDOW_TURNS && owners[end] === "past" &&
             hist.turns[end].at < next.openedAt + settings.cutDays * DAY_MS) end++;
      next = { ...next, end, judgedThrough: end, pastPending: true };
      extra.pastFound = true;
    }
  }
  if (job.kind === "advice" && next.state === "episode") next = { ...next, episodeId: episodeId(hist.chat, next.segmentStart, next.opening, next.openedAt) };
  // a change of topic: noted first, then the record closes
  if (closed) next = { ...next, episodeId: null, closing: { ...closed, id: judge.episodeId } };
  await store(next, extra);
}

// The open episode of the walk ends (closedBy): noted in its state, then closed (as closeEpisode does
// on the web)
function closeHistory(judge, closedBy) {
  const { chat: next, closed } = Episodes.closeOpen(judge, closedBy);
  return { ...next, episodeId: null, webWaitSince: null, pastPending: false, closing: { ...closed, id: judge.episodeId } };
}

// A judgment of `turn` that failed (refused by the server, or failed there): counted, and tried again
// later, a little later each time
function failedOnce(judge, turn) {
  const count = (judge.tries?.turn === turn ? judge.tries.count : 0) + 1;
  return { ...judge, pending: null, tries: { turn, count }, retryAt: Date.now() + RETRY_MINUTES * 60000 * 2 ** (count - 1) };
}

// The previous turn and its reply for a continuation judgment, from the episode's own copy, when the
// text read from the site has none (a turn the page sent close to a pause: its text stays on the page)
async function previousFromRecord(judge) {
  const record = await load(`episode:${judge.episodeId}`);
  const { userTurns, replies } = Episodes.splitTurns(record?.messages || []);
  return { previous: userTurns.at(-1) || "", reply: replies.at(-1) || "" };
}

// Every turn read is judged and the walk holds an open episode: does it end now? A past one at once
// (its window is complete); one from elsewhere at its cut, or once quiet for endQuietMinutes by the
// turns' own times, which a list fetched after that shows to be over (no newer turn). Else null, with
// an alarm to look again.
async function historyEpisodeOver(hist, judge, settings) {
  if (judge.pastPending) return "window";
  const cut = judge.openedAt + settings.cutDays * DAY_MS, quietAt = hist.turns[judge.end - 1].at + settings.endQuietMinutes * 60000;
  if (Date.now() >= cut) return "cut";
  const list = await load(`hlist:${hist.host}`);
  const listed = list?.items.find((item) => item.id === hist.id);
  if (Date.now() >= quietAt && list?.listedAt >= quietAt && listed?.u === hist.listedU) return "quiet";
  chrome.alarms.create(`hjudge|${hist.key}`, { when: Math.min(cut, Math.max(quietAt, Date.now()) + LIST_EVERY_MS) });
  return null;
}

// The record of the walk's open episode, as the judgments say: created when it opened (unless the
// participant answered No or skipped it before), with its later turns when it grew. Returns the
// walk's state, changed if the walk lets the episode go: the web page took it over, it is gone, or
// the participant said No meanwhile (it then ends as "removed").
async function followHistoryEpisode(hist, judge, page, settings) {
  const record = await load(`episode:${judge.episodeId}`);
  const letGo = { ...judge, state: "searching", episodeId: null, segmentStart: judge.end + 1, opening: null, end: null, openedAt: null,
                  webWaitSince: null, pastPending: false };
  if (!record) {
    if (((await load("hdone")) || []).includes(judge.episodeId)) return letGo;
    if (!page || !historyAllowed(settings, hist.host)) return judge;
    const source = judge.pastPending ? "past" : "app";
    const openingText = page.userTurns[judge.opening - 1] || "";
    const fresh = {
      id: judge.episodeId, chatKey: hist.chat, site: hist.site, url: hist.url, source, heldBy: "history", walk: hist.key,
      mode: source === "past" ? "past" : "combined", start: judge.segmentStart, opening: judge.opening, end: judge.end,
      openedAt: judge.openedAt, detectedAt: Date.now(), closedAt: null, closedBy: null, openingText,
      related: await relatedEpisodes(openingText, settings), status: "open", answers: null, versions: 0, answeredEnd: null,
      askedEnd: null, finalDue: false, panelTabs: [], title: hist.title, conversationCreatedAt: hist.createdAt,
      messages: historyMessages(page, judge.segmentStart, judge.end), turnHashes: hist.turns.slice(judge.segmentStart - 1, judge.end).map((turn) => turn.h),
      lastTurnAt: hist.turns[judge.end - 1].at,
    };
    if (page.started !== generation || (await load(`episode:${fresh.id}`))) return judge;
    await save(`episode:${fresh.id}`, fresh);
    await count(`found_${source}`);
    await updateBadge();
    return judge;
  }
  if (record.heldBy !== "history" || record.walk !== hist.key) return letGo;
  if (record.status === "removed") return closeHistory(judge, "removed");       // "No" while it was going on
  if (record.status !== "open") return letGo;
  if (record.end < judge.end && page) {
    // NOTE: [design thought] only the new turns are added from the site's copy: the episode's own text
    // of its earlier turns (from the web page, if it was handed over) stays as it is
    await updateEpisode(record.id, (current) => (current.heldBy !== "history" || current.end >= judge.end ? current : {
      ...current, end: judge.end, grew: true, lastTurnAt: hist.turns[judge.end - 1].at,
      messages: [...(current.messages || []), ...historyMessages(page, current.end + 1, judge.end)],
      turnHashes: [...(current.turnHashes || []), ...hist.turns.slice(current.end, judge.end).map((turn) => turn.h)] }));
    await updateBadge();
  }
  return judge;
}

// The text of turns from..to of a conversation read from the site; replies were cut to 8 KB there
function historyMessages(page, from, to) {
  return Episodes.episodeMessages(page.userTurns, page.replies, from, to);
}

// The loose hashes of an open episode's turns start..end, and their text: an episode the walk holds
// (or that was handed to it) keeps them; one the web page holds has them in its chat's copy.
async function episodeTurns(record) {
  if (record.heldBy === "history") return { hashes: record.turnHashes || [], messages: record.messages || null };
  const chat = await load(`chat:${record.chatKey}`), snapshot = await load(`snap:${record.chatKey}`);
  const { userTurns, replies } = Episodes.splitTurns(snapshot?.messages || []);
  const shift = snapshot ? Episodes.findOffset(chat?.ids || [], Episodes.turnIds(userTurns)) : -1;
  if (shift < 0 || chat?.episodeId !== record.id) return { hashes: [], messages: null };
  return { hashes: userTurns.slice(record.start - 1 + shift, record.end + shift).map(Episodes.looseHash),
           messages: Episodes.episodeMessages(userTurns, replies, record.start + shift, record.end + shift) };
}

// Turn `turn` (from elsewhere) comes right after the turns of an open episode of this chat: the web
// page's (its turns are this conversation's turns before `turn`), or one handed to the walk, or one
// this walk held before its state was cleared (switches, a new reading: then the turns before `turn`
// are the first ones of the episode, from its own start). The walk takes it, with its turn numbers
// moved to the conversation's, and judges `turn` as its continuation. Returns the walk's episode
// fields, or null.
async function takeEpisode(hist, turn, settings) {
  const hashes = hist.turns.map((entry) => entry.h);
  const hists = new Map((await loadAll("hist:")).map(([, entry]) => [entry.key, entry]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [, record] of await loadAll("episode:")) {
    if (record.chatKey !== hist.chat || record.status !== "open" || record.source === "past") continue;
    if (Date.now() >= record.openedAt + settings.cutDays * DAY_MS) continue;
    // (held by another walk that still holds it: not this one's)
    if (record.heldBy === "history" && record.walk && record.walk !== hist.key && hists.get(record.walk)?.judge?.episodeId === record.id) continue;
    const { hashes: own, messages } = await episodeTurns(record);
    if (!own.length) continue;
    // all of its turns end right before `turn`; or, for one the walk held, its first turns from its own start
    let length = own.length;
    if (!same(hashes.slice(turn - 1 - length, turn - 1), own)) {
      length = turn - record.start;
      if (record.heldBy !== "history" || length < 1 || length >= own.length || !same(hashes.slice(record.start - 1, turn - 1), own.slice(0, length))) continue;
    }
    const start = turn - length;
    if (start < 1) continue;
    let taken = null;
    await updateEpisode(record.id, (current) => {
      if (current.status !== "open" || current.end !== record.end || (current.heldBy ?? "web") !== (record.heldBy ?? "web")) return current;
      const shift = start - current.start;
      const moved = (value) => (value === null || value === undefined ? value : value + shift);
      taken = { episodeId: current.id, segmentStart: start, opening: current.opening + shift, end: turn - 1, openedAt: current.openedAt };
      return { ...current, heldBy: "history", walk: hist.key, takenAt: Date.now(), start, opening: current.opening + shift,
               end: current.end + shift, answeredEnd: moved(current.answeredEnd), askedEnd: moved(current.askedEnd),
               messages: current.messages ?? messages, turnHashes: current.turnHashes ?? own,
               lastTurnAt: current.lastTurnAt ?? hist.turns[turn - 2].at };
    });
    if (!taken) continue;
    // (a web page's episode: its chat lets it go at its next look, the asking moves to the queue)
    for (const alarm of ["pause", "ask", "heldcut"]) chrome.alarms.clear(`${alarm}|${record.id}`);
    await count("taken_by_walk");
    return taken;
  }
  return null;
}

// Episodes answered No, or skipped: found again (after an edit, or when turned on again) they are
// not asked about again
function rememberDecided(id) {
  return serialized("hdone", async () => save("hdone", [...((await load("hdone")) || []), id].slice(-2000)));
}

// ---- hand-overs between the web page and the walk ----
// The web chat's open episode meets turns the page did not see sent (another device, most likely), or
// goes quiet, while readApps is on: it is handed to the walk instead of ending (its text from the
// page, its turns' loose hashes to be found again). `closed` gives its turns. Returns whether it went.
async function handOff(id, closed, page, url) {
  let handed = false;
  const messages = page && Episodes.episodeMessages(page.userTurns, page.replies, closed.start, closed.end);
  await updateEpisode(id, (current) => {
    // (handed over before, and the worker stopped before the chat let it go: the same again)
    if (current.status === "open" && current.heldBy === "history") handed = true;
    if (current.status !== "open" || (current.heldBy ?? "web") !== "web") return current;
    handed = true;
    const shift = closed.opening - current.opening;
    const moved = (value) => (value === null || value === undefined ? value : value + shift);
    return { ...current, heldBy: "history", walk: null, handedAt: Date.now(), lastTurnAt: page?.snapshot?.changedAt ?? Date.now(),
             start: closed.start, opening: closed.opening, end: closed.end,
             answeredEnd: moved(current.answeredEnd), askedEnd: moved(current.askedEnd), messages: messages ?? current.messages,
             turnHashes: page ? page.userTurns.slice(closed.start - 1, closed.end).map(Episodes.looseHash) : current.turnHashes };
  });
  if (!handed) return false;
  for (const alarm of ["pause", "ask"]) chrome.alarms.clear(`${alarm}|${id}`);
  // the conversation is read next; an episode no walk takes ends at its cut at the latest
  const record = await load(`episode:${id}`);
  chrome.alarms.create(`heldcut|${id}`, { when: Math.max(record.openedAt + (await getSettings()).cutDays * DAY_MS, Date.now() + 60000) });
  await readFirst(url);
  return true;
}

// Ask for the conversation of this page address to be read first
async function readFirst(url) {
  const host = hostOf(url), id = SITE_CONFIGS[host]?.conversationId(new URL(url));
  if (!id || !HISTORY_SITES.includes(host)) return;
  await serialized(`hstate:${host}`, async () => save(`hstate:${host}`, { ...((await load(`hstate:${host}`)) || {}), priority: id }));
  historyTick();
}

// An episode handed over to the walk that no walk holds (none took it, or its walk's state was
// cleared): it ends once quiet for endQuietMinutes after its last turn, unless the site's list shows
// the conversation changed after it was handed over (a walk will read it), and at its cut at the
// latest. Ending at the cut counts as such only if turns from elsewhere did join it (else it ends
// quiet, as on the web). One the participant answered No to meanwhile goes.
async function settleHanded() {
  const settings = await getSettings();
  const hists = new Map((await loadAll("hist:")).map(([, hist]) => [hist.key, hist]));
  for (const [, record] of await loadAll("episode:")) {
    if (record.heldBy !== "history" || !["open", "removed"].includes(record.status)) continue;
    if (record.walk && hists.get(record.walk)?.judge?.episodeId === record.id) continue;          // a walk holds it
    if (record.walk) await updateEpisode(record.id, (current) => ({ ...current, walk: null }));
    const close = (closedBy) => episodeClosed({ id: record.id, start: record.start, opening: record.opening, end: record.end, closedBy,
                                                openedAt: record.openedAt }, null);
    if (record.status === "removed") { await close("removed"); continue; }
    const host = hostOf(record.url), id = SITE_CONFIGS[host]?.conversationId(new URL(record.url));
    const listed = (await load(`hlist:${host}`))?.items.find((item) => item.id === id);
    // (the list's time is the site's, the hand-over's this computer's: CLOCK_MARGIN_MS between them)
    const changed = listed && listed.u > (record.handedAt ?? record.takenAt ?? 0) + History.CLOCK_MARGIN_MS;
    const quietAt = (record.lastTurnAt ?? record.handedAt ?? record.openedAt) + settings.endQuietMinutes * 60000;
    if (Date.now() >= record.openedAt + settings.cutDays * DAY_MS) await close(record.grew ? "cut" : "quiet");
    else if (Date.now() >= quietAt && !changed) await close("quiet");
  }
}

// The web page continues an episode held by the walk (an episode found on another device, or one the
// web page handed over before): turn `turn` was sent on the page right after turns it did not see
// sent. Waits (up to LIVE_WAIT_MS) until the walk has judged the conversation up to `turn - 1`, the
// conversation read first; an open episode held by the walk whose turns are the page's turns ending
// there is taken over (heldBy web), and `turn` gets a continuation judgment. Returns the chat (changed
// if taken), or null while it waits.
async function takeFromElsewhere(key, chat, page, settings) {
  const turn = chat.judgedThrough + 1;
  const { userTurns, snapshot } = page;
  const proceed = () => (chat.waitedSince ? { ...chat, waitedSince: null, waitProgress: null, waitProgressAt: null } : chat);
  if (!settings.readApps || !historyAllowed(settings, hostOf(snapshot.url)) || chat.state !== "searching" || turn !== chat.segmentStart ||
      turn < 2 || turn > userTurns.length) return proceed();
  const ids = Episodes.turnIds(userTurns), sent = new Set(snapshot.sent);
  if (sent.has(ids[turn - 2]) || !sent.has(ids[turn - 1])) return proceed();
  const hashes = userTurns.map(Episodes.looseHash);
  const hist = (await loadAll("hist:")).map(([, entry]) => entry).find((entry) => entry.chat === key && entry.judge);
  const index = hist ? hist.turns.map((entry) => entry.h).lastIndexOf(hashes[turn - 2]) : -1;
  if (!(index >= 0 && hist.judge.judgedThrough >= index + 1 && !hist.judge.pending)) {
    // NOTE: [design thought] the turn waits while the walk gets on with these turns (each new judgment
    // starts the wait again), at most LIVE_WAIT_MAX_MS in all; it goes on without them if the walk
    // makes no progress for LIVE_WAIT_MS
    const now = Date.now(), progress = hist?.judge?.judgedThrough ?? -1;
    if (!chat.waitedSince) await readFirst(snapshot.url);
    const since = chat.waitedSince ?? now, moved = progress !== chat.waitProgress;
    const last = moved ? now : chat.waitProgressAt ?? since;
    if (now >= since + LIVE_WAIT_MAX_MS || now >= last + LIVE_WAIT_MS) return proceed();
    return { waiting: true, chat: { ...chat, waitedSince: since, waitProgress: progress, waitProgressAt: last } };
  }
  for (const [, record] of await loadAll("episode:")) {
    // (one taken over before whose chat does not hold it: the worker stopped between the two writes)
    const lost = record.heldBy === "web" && chat.episodeId !== record.id;
    if (record.chatKey !== key || record.status !== "open" || (record.heldBy !== "history" && !lost) || record.source === "past" || !record.turnHashes?.length) continue;
    if (Date.now() >= record.openedAt + settings.cutDays * DAY_MS) continue;
    const length = record.turnHashes.length, start = turn - length;
    if (start < 1 || JSON.stringify(hashes.slice(start - 1, turn - 1)) !== JSON.stringify(record.turnHashes)) continue;
    let taken = false;
    await updateEpisode(record.id, (current) => {
      if (current.status !== "open" || (current.heldBy !== "history" && !lost)) return current;
      taken = true;
      // NOTE: [design thought] its turn numbers become the page's; the page's copy holds its text from now on
      const shift = start - current.start;
      const moved = (value) => (value === null || value === undefined ? value : value + shift);
      // (its turns' hashes and text are the chat's copy's from now on)
      const { messages, walk, turnHashes, ...rest } = current;
      return { ...rest, heldBy: "web", start, opening: current.opening + shift, end: turn - 1, answeredEnd: moved(current.answeredEnd),
               askedEnd: moved(current.askedEnd) };
    });
    if (!taken) continue;
    chrome.alarms.clear(`heldcut|${record.id}`);
    await count("taken_over");
    if (Modes.asksAtPauses(record.mode)) await armPause(await load(`episode:${record.id}`));
    return { ...chat, state: "episode", episodeId: record.id, segmentStart: start, opening: record.opening + start - record.start, end: turn - 1,
             openedAt: record.openedAt, waitedSince: null, waitProgress: null, waitProgressAt: null };
  }
  return proceed();
}

// ---- switches, deletion ----
// A reading switch changed: every walk starts again from scratch (records and the remembered
// decisions keep it from asking twice; an open episode a walk held is taken up again by the new walk,
// or ends by itself: settleHanded), and requests under way are dropped. For a kind turned off:
// - found among past turns, or among turns from elsewhere (source past, app), without answers: it goes
//   (one the web page took over ends as "removed" through its chat);
// - with answers: they stay, with the check-in, but none of its text is sent any more (keepText), and
//   final answers are no longer asked;
// - a web episode handed to the walk ends ("stopped") and is the web's again; if turns from elsewhere
//   had joined it, its text stays on the computer.
async function historySwitched(stopped) {
  await serialized("historyEpoch", async () => save("historyEpoch", (await epochNow()) + 1));
  for (const [name] of [...(await loadAll("hist:")), ...(await loadAll("hlist:"))]) await remove(name);
  for (const name of await waitingTexts()) await chrome.storage.session.remove(name);
  for (const [, record] of await loadAll("episode:")) {
    if (record.heldBy === "history" && record.walk) await updateEpisode(record.id, (current) => ({ ...current, walk: null }));
    const kind = record.source === "past" ? "past" : record.source === "app" || record.heldBy === "history" ? "app" : null;
    if (!kind || !stopped.includes(kind)) continue;
    const close = (closedBy) => episodeClosed({ id: record.id, start: record.start, opening: record.opening, end: record.end, closedBy,
                                                openedAt: record.openedAt }, null);
    if ((record.source ?? "web") === "web") {
      if (record.status === "open") await close("stopped");
      await updateEpisode(record.id, (current) => ({ ...(current.grew ? { ...withoutText(current), keepText: true } : current),
                                                     heldBy: "web", walk: null, finalDue: false }));
      continue;
    }
    if (!record.answers) {
      if (record.status === "open" && record.heldBy === "web") { await removeEpisode(record.id); continue; }
      await updateEpisode(record.id, () => null);
      for (const alarm of ["pause", "ask", "remind", "checkin", "heldcut"]) chrome.alarms.clear(`${alarm}|${record.id}`);
      continue;
    }
    if (record.status === "open" && record.heldBy !== "web") await close("stopped");
    await updateEpisode(record.id, (current) => ({ ...withoutText(current), keepText: true, finalDue: false }));
  }
  await settleHanded();
  await updateBadge();
}

// The participant agreed to (or stopped) reading: recorded for the study team, with the version of
// the text they agreed to
async function consentChanged(before, after, settings) {
  for (const [field, feature] of [["readPast", "read_past"], ["readApps", "read_apps"]]) {
    if (Boolean(before[field]) === Boolean(after[field])) continue;
    await upload("consent", { feature, accepted: Boolean(after[field]), version: STUDY_CONFIG.historyConsentVersion }, settings);
  }
}

// ---- the queue: one question at a time per site ----
// Episodes found among conversations read from the site (and web ones the walk holds) are asked about
// through their site's queue (lib/modes.js viaQueue, queueItem): a page of that site gets an
// invitation without any conversation text; its answers are given in the extension's own tab (the
// chat company's page never shows the old request, nor the answers about it). One item per site at a
// time; invitations at most every 4 hours per site, past ones at most twice a day and not after 3
// missed in a row, and never while the participant is in the middle of a conversation there.
async function offerQueued(view) {
  const settings = await getSettings(), now = Date.now();
  if (!view.url || trackingOff(settings) || excluded(settings, view.url)) return false;
  const queue = (await load(`qstate:${view.site}`)) || {};
  if (now < (queue.invitedAt ?? 0) + INVITE_GAP_MS) return false;
  // not while the participant is in the middle of a conversation here (a send or a change within 5 min:
  // the log of sends stays when a chat that is not advice lets go of its copy)
  const chat = await load(`chat:${view.key}`), snapshot = await load(`snap:${view.key}`);
  const lastSent = ((await load(`sentlog:${view.key}`)) || []).at(-1)?.at ?? 0;
  if (chat?.state === "episode" || now < Math.max(snapshot?.changedAt ?? 0, lastSent) + BUSY_PAGE_MS) return false;
  // past ones: at most PAST_INVITES_A_DAY in any 24 hours, and none after PAST_MISSES_MAX missed in a row
  const recentPast = (queue.pastTimes || []).filter((at) => at > now - DAY_MS);
  const pastHeld = (queue.pastMisses ?? 0) >= PAST_MISSES_MAX || recentPast.length >= PAST_INVITES_A_DAY;
  const records = (await loadAll("episode:")).map(([, record]) => record)
    .filter((record) => record.site === view.site && kindOn(settings, record) && !(pastHeld && record.source === "past"));
  const item = Modes.queueItem(records, now, settings.followupSeconds, queue.current);
  // (not about the chat on the screen, nor the next one instead: the participant may be about to go on there)
  if (!item || item.record.chatKey === view.key) return false;
  const invite = { id: item.record.id, site: item.record.site, source: item.record.source ?? "web", stage: item.decision.stage,
                   update: item.decision.show === "update", answered: item.record.versions > 0, closedBy: item.record.closedBy,
                   openedAt: item.record.openedAt, reward: STUDY_CONFIG.pastReward, pastLimit: STUDY_CONFIG.pastLimit };
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(view.tabId, { type: "offer_invite", invite, settings: panelSettings(settings) });
  } catch (error) { /* tab closed, or a page without the content script */ }
  if (!response?.shown) return false;
  const past = item.record.source === "past";
  await save(`qstate:${view.site}`, { ...queue, invitedAt: now, current: item.record.id, pastTimes: past ? [...recentPast, now] : recentPast });
  await updateEpisode(item.record.id, (current) => ({ ...current, invites: (current.invites || 0) + 1 }));
  await count(`asked_invite_${item.record.source ?? "web"}`);
  return true;
}

// A question about an episode asked through the queue, at an occasion of the live rules (it ended, a
// snooze is over): the queue of its site invites on the page of that site the participant looked at
// last (or not, by its pacing). If they are on another site, an episode from another device whose
// question waits gets a notification, if it is its site's current question, at most once every
// INVITE_GAP_MS per site (a past one gets none: it is optional).
async function askQueued(record, rule, settings) {
  const view = await load("lastView"), now = Date.now();
  if (view?.site === record.site) return offerQueued(view);
  if (rule !== "waitingPage" || record.source === "past" || trackingOff(settings) || !kindOn(settings, record) || excluded(settings, record.url)) return false;
  const queue = (await load(`qstate:${record.site}`)) || {};
  if (now < (queue.notifiedAt ?? 0) + INVITE_GAP_MS) return false;
  const records = (await loadAll("episode:")).map(([, other]) => other).filter((other) => other.site === record.site && kindOn(settings, other));
  if (Modes.queueItem(records, now, settings.followupSeconds, queue.current)?.record.id !== record.id) return false;
  chrome.notifications.create(`rate|${record.id}`, {
    type: "basic", iconUrl: "icons/icon128.png", title: "Advice Tracker: a quick question",
    message: `A conversation on ${record.site} looked like a request for advice. Click to answer a few questions (about 5-10 min).`,
  });
  await save(`qstate:${record.site}`, { ...queue, notifiedAt: now, current: record.id });
  await count("asked_notification");
  return true;
}

// The invitation's outcome: open (the extension tab opens), later or timeout (the next one comes after
// INVITE_GAP_MS; for a past one, a miss), stop (no more past conversations: readPast off), superseded
async function onInviteAnswer(message, tabId) {
  // NOTE: [edge case callout] the settings are read and written at once, before anything slow (an
  // upload): a pause or exclusion made meanwhile on the settings page must not be undone
  if (message.answer === "stop") await updateSettings({ readPast: false });
  const settings = await getSettings();
  const record = await load(`episode:${message.id}`);
  await count(`invite_${message.answer}`);
  if (record) {
    await upload("prompt", { episode: record.id, source: record.source ?? "web", mode: record.mode, prompt: "invite", answer: message.answer,
                             invites_before: (record.invites || 1) - 1, incentive_shown: record.source === "past" }, settings);
    await serialized(`qstate:${record.site}`, async () => {
      const queue = (await load(`qstate:${record.site}`)) || {};
      const miss = record.source === "past" && ["later", "timeout"].includes(message.answer);
      await save(`qstate:${record.site}`, { ...queue, pastMisses: message.answer === "open" ? 0 : (queue.pastMisses ?? 0) + (miss ? 1 : 0) });
    });
  }
  if (message.answer === "open") openCheckin(`?item=${encodeURIComponent(message.id)}`);
  if (message.answer !== "open") await offerRefused(tabId);
}

// The card's first question (the extension tab): yes (the questions follow), no (not advice), skip
// (a past one: not annotated)
async function onCardAnswer(message) {
  const record = await load(`episode:${message.id}`);
  if (!record) return;
  await count(`card_${message.answer}`);
  await upload("prompt", { episode: record.id, source: record.source ?? "web", mode: record.mode, prompt: "card", answer: message.answer,
                           incentive_shown: record.source === "past" }, await getSettings());
  if (message.answer === "yes") await updateEpisode(record.id, (current) => ({ ...current, confirmedAt: current.confirmedAt ?? Date.now() }));
  if (message.answer === "no") await onNotAdvice(message);
  if (message.answer === "skip") await onPastSkipped(message);
  if (message.answer !== "yes") await serialized(`qstate:${record.site}`, async () => {
    const queue = (await load(`qstate:${record.site}`)) || {};
    await save(`qstate:${record.site}`, { ...queue, pastMisses: message.answer === "skip" ? (queue.pastMisses ?? 0) + 1 : queue.pastMisses ?? 0 });
  });
}

// The past conversation's questions are answered: they go with its conversation (from the advice
// request on, redacted), and the record lets go of the text.
async function onPastSubmitted(message) {
  const settings = await getSettings();
  let answered = null;
  await updateEpisode(message.id, (current) => {
    if (current.source !== "past" || current.answers || current.status !== "pending") return current;
    answered = { ...current, answers: message.answers, versions: 1, answeredEnd: current.end, confirmedAt: current.confirmedAt ?? Date.now() };
    return answered;
  });
  if (!answered) return;
  const conversation = await transcript(answered, answered.end, settings);
  await upload("past_annotation", {
    episode: answered.id, fingerprint: fingerprint(answered), site: answered.site, source: "past", opened_at: answered.openedAt,
    conversation_created_at: answered.conversationCreatedAt ?? null, detected_at: answered.detectedAt,
    days_since: Math.round((Date.now() - answered.openedAt) / DAY_MS), turns: answered.end - answered.start + 1,
    opening_turn: answered.opening - answered.start + 1, answers: redactAnswers(message.answers, settings.redactNames),
    related_earlier: answered.related.length, transcript: conversation?.messages ?? null, redacted: conversation?.counts ?? null,
    ...(await studyClock()),
  }, settings);
  await updateEpisode(answered.id, (current) => doneRecord(current));
  await count("past_annotated");
  await updateBadge();
}

// Skip: the participant does not annotate this past conversation. It goes (nothing is sent but the
// fact), and is not asked about again.
async function onPastSkipped(message) {
  let gone = null;
  await updateEpisode(message.id, (current) => (current.source === "past" && !current.answers ? ((gone = current), null) : current));
  if (!gone) return;
  await rememberDecided(gone.id);
  await count("past_skipped");
  await upload("past_skipped", { episode: gone.id, fingerprint: fingerprint(gone), site: gone.site, source: "past", opened_at: gone.openedAt },
               await getSettings());
  await updateBadge();
}

// When the participant joined, whether that is known or estimated (installs updated from 0.5), and
// this install's random id: for the study team, to pay each past conversation once and to tell
// installs apart
async function studyClock() {
  return { joined_at: (await load("joinedAt")) ?? null, joined_estimated: Boolean(await load("joinedEstimated")),
           install_id: (await load("installId")) ?? null };
}

// ---------------- uploads ----------------
async function upload(type, payload, settings) {
  const started = generation;
  const event = { type, participant_id: settings.participantId, sent_at: Date.now(), payload };
  if (await post(event, settings)) return;
  await serialized("queue", async () => {
    const queue = (await load("queue")) || [];
    // NOTE: [edge case callout] dropped, not queued: an event of an episode marked not advice
    // while it was on its way, and anything after "delete all data" began meanwhile (checked last,
    // with no wait before the write, so a deleted conversation cannot come back through the queue)
    const recordless = type === "not_advice" || type === "past_skipped";       // their record is gone on purpose
    const episode = payload.episode && !recordless ? await load(`episode:${payload.episode}`) : null;
    if ((payload.episode && !recordless && (!episode || episode.status === "removed")) || started !== generation) return;
    await save("queue", [...queue, event]);
    chrome.alarms.create("flush", { delayInMinutes: 30 });
  });
}

async function post(event, settings) {
  try {
    const response = await fetch(`${settings.serverUrl}/events`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Study-Key": settings.studyKey },
      body: JSON.stringify(event), signal: AbortSignal.timeout(25000),
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}

// An event waiting in the queue, as it may go now: the participant may have marked its episode as
// not advice, excluded its site or paused tracking since it was queued. Returns the event to post,
// "wait" (a conversation waits while tracking is off), or null (it does not go).
async function queuedEvent(event) {
  const settings = await getSettings();
  if (!event.payload.episode || event.type === "not_advice" || event.type === "past_skipped") return event;
  const record = await load(`episode:${event.payload.episode}`);
  if (!record || record.status === "removed") return null;
  if (event.type === "episode_transcript") return textStays(record, settings) ? null : trackingOff(settings) ? "wait" : event;
  // answers go, without the conversation once the participant excluded its site (a conversation
  // already on its way otherwise goes as it was sent: with answers, or reviewed at a 0.4 check-in,
  // or chosen to be shared in 0.3)
  if (event.payload.transcript && excluded(settings, record.url)) {
    const { transcript_edited, ...payload } = event.payload;
    return { ...event, payload: { ...payload, transcript: null, redacted: null } };
  }
  return event;
}

async function flushQueue() {
  const settings = await getSettings();
  const started = generation;
  await serialized("queue", async () => {
    const remaining = [];
    for (const queued of (await load("queue")) || []) {
      if (started !== generation) return;            // "delete all data" meanwhile: nothing more goes out
      const event = await queuedEvent(queued);
      // (an event that waits, or could not go, stays as it may go now: without a conversation that stays)
      if (event === "wait") remaining.push(queued);
      else if (event && !(await post(event, settings))) remaining.push(event);
    }
    if (started !== generation) return;
    await save("queue", remaining);
    if (remaining.length) chrome.alarms.create("flush", { delayInMinutes: 30 });
  });
}

// ---------------- is the extension tracking? (heartbeat, status, uninstall) ----------------
// The five chat sites, as the manifest lists them for the content script ("https://chatgpt.com/*", ...)
const STUDY_SITES = chrome.runtime.getManifest().content_scripts[0].matches.filter((match) => match.startsWith("https://"));

// What the study needs to know for each day (payment is withheld for days without tracking): is
// tracking paused, and on which of the five sites can the extension capture? A site is lost when
// the participant excluded it in the settings, or withheld the extension's access to it in Chrome
// (chrome://extensions -> Site access).
async function trackingStatus(settings) {
  const excludedSites = [], withoutAccess = [], listening = [];
  for (const match of STUDY_SITES) {
    const host = new URL(match.replace("*", "")).hostname;
    const isExcluded = excluded(settings, `https://${host}/`);
    const permitted = await chrome.permissions.contains({ origins: [match] });
    if (isExcluded) excludedSites.push(host);
    if (!permitted) withoutAccess.push(host);
    if (permitted && !isExcluded) listening.push(host);
  }
  return { tracking: Boolean(settings.participantId) && !settings.paused && listening.length > 0, paused: settings.paused, paused_at: settings.pausedAt,
           listening_sites: listening, excluded_sites: excludedSites, sites_without_access: withoutAccess,
           read_past: Boolean(settings.readPast), read_apps: Boolean(settings.readApps) };
}

// Twice a day: the extension is still installed, whether it is tracking, and counts only (IRB
// protocol). No heartbeat means Chrome was not running, or the extension was turned off or removed.
async function heartbeat() {
  const settings = await getSettings();
  if (!settings.participantId) return;          // nothing to report before the participant set up the extension
  const stats = (await load("stats")) || {};
  const episodes = (await loadAll("episode:")).map(([, episode]) => episode);
  await upload("heartbeat", {
    version: chrome.runtime.getManifest().version, rating_mode: settings.ratingMode, ...(await trackingStatus(settings)),
    previous_heartbeat_at: (await load("heartbeatAt")) ?? null, ...stats,
    open_episodes: episodes.filter((episode) => episode.status === "open").length,
    waiting_rating: episodes.filter(Modes.waiting).length,
    waiting_checkin: episodes.filter((episode) => episode.checkin && !episode.checkin.doneAt).length,
    waiting_past: episodes.filter((episode) => episode.source === "past" && episode.status === "pending").length,
    history: await historyStates(), ...(await studyClock()),
  }, settings);
  await save("heartbeatAt", Date.now());
  await noteAlive();
  await fetchStudyConfig(settings);
  await checkJoined(settings);
}

// The heartbeat, if the last one is about 12 hours old. The alarm comes here, and so does every
// start of the worker, which Chrome may start for the alarm itself: one at a time, so the second
// finds the heartbeat just sent.
// NOTE: [design thought] an hour of slack: a missed alarm fires once when Chrome starts again and
// then keeps its old grid, so the next one can come less than 12 hours after a heartbeat sent at
// that start
function heartbeatIfDue() {
  return serialized("heartbeat", async () => {
    if (Date.now() < ((await load("heartbeatAt")) || 0) + (HEARTBEAT_MINUTES - 60) * 60000) return;
    await expireWaiting();
    await heartbeat();
  });
}

// NOTE: [edge case callout] Chrome may drop alarms when it restarts, and creating an alarm again
// starts its clock again: a participant who closes Chrome every evening would never reach the
// 12-hour mark. So the alarm is created only when it is missing, timed from the last heartbeat.
async function keepHeartbeatAlarm() {
  if (await chrome.alarms.get("heartbeat")) return;
  const next = Math.max(((await load("heartbeatAt")) || 0) + HEARTBEAT_MINUTES * 60000, Date.now() + 60000);
  chrome.alarms.create("heartbeat", { when: next, periodInMinutes: HEARTBEAT_MINUTES });
}

// A change of what is tracked (paused or resumed, sites excluded or access withheld, the
// participant ID set) is reported at once, so the study sees when it happened, not only at the
// next heartbeat.
async function statusChanged() {
  const settings = await getSettings();
  await setUninstallUrl(settings);
  const status = await trackingStatus(settings);
  // (without a participant ID nothing is tracked: logged as such, though not reported to anyone)
  await noteTracking(status);
  if (!settings.participantId) return;
  await upload("status", status, settings);
}

// From now on tracking is on for these sites (for none while paused): the tracking log. A turn of a
// conversation read from the site itself that was sent while tracking was off for its site is never
// read (lib/history.js), also not one typed in the site's phone app.
function noteTracking(status) {
  return serialized("trackingLog", async () => {
    const log = (await load("trackingLog")) || [];
    const on = status.tracking ? status.listening_sites : [];
    if (JSON.stringify(log.at(-1)?.on) === JSON.stringify(on)) return;
    // NOTE: [design thought] a long log is shortened at its start; what it drops counts as off from
    // then on (the safe side: nothing of that time is read)
    const longer = [...log, { at: Date.now(), on }];
    await save("trackingLog", longer.length > 300 ? [{ at: longer[0].at, on: [] }, ...longer.slice(-299)] : longer);
  });
}

// NOTE: [design thought] before 0.6 the extension kept neither when the participant joined nor when
// tracking was on. At the update the earliest chat or episode stands for the start (marked as
// estimated), the past ends there (and earlier if the study server's first event of the participant
// says so: checkJoined), and tracking counts as off until the update (0.5 kept no pauses): nothing
// typed on another device before the update is read.
function seedStudyClock(settings) {
  return serialized("joinedAt", async () => {
    if (await load("joinedAt")) return;
    const starts = [...(await loadAll("chat:")).map(([, chat]) => chat.firstSeen), ...(await loadAll("episode:")).map(([, record]) => record.openedAt)];
    const now = Date.now(), joinedAt = Math.min(now, ...starts.filter(Number.isFinite));
    const status = await trackingStatus(settings);
    await save("trackingLog", [{ at: joinedAt, on: [] }, { at: now, on: status.tracking ? status.listening_sites : [] }]);
    await save("pastBefore", joinedAt);              // (refined by the study server's date: checkJoined)
    await save("joinedEstimated", true);
    await save("joinedAt", joinedAt);
  });
}

// When the participant ID was first set: the participant's turns before it are past conversations,
// those after it belong to the study (seen on the web, or typed elsewhere).
function noteJoined() {
  return serialized("joinedAt", async () => {
    if (await load("joinedAt")) return;
    const now = Date.now();
    await save("pastBefore", now);
    await save("joinedAt", now);
  });
}

// When the extension ran (at most every 4 hours): a turn read from a site later that was sent more
// than a day away from any of these counts as sent while the extension was not tracking
// (lib/history.js offPeriods), as the study counts a day without a heartbeat as a day without tracking
function noteAlive() {
  return serialized("aliveLog", async () => {
    const log = (await load("aliveLog")) || [];
    if (log.length && Date.now() < log.at(-1) + 4 * 3600 * 1000) return;
    // a long log is shortened at its start: the gaps in what it drops are kept (aliveGaps)
    const longer = [...log, Date.now()];
    if (longer.length > 600) {
      const dropped = longer.splice(0, longer.length - 500);
      const gaps = History.offPeriods("", [], [...dropped, longer[0]], 0);
      await save("aliveGaps", [...((await load("aliveGaps")) || []), ...gaps]);
    }
    await save("aliveLog", longer);
  });
}

// For the heartbeat: how reading each site's conversations goes (ok, not yet, waiting after the
// site asked for a pause, signed out, another account, blocked, or no reader for that site)
async function historyStates() {
  const states = {};
  for (const match of STUDY_SITES) {
    const host = new URL(match.replace("*", "")).hostname;
    const state = (await load(`hstate:${host}`)) || null;
    states[host] = !HISTORY_SITES.includes(host) ? "unsupported" : !state ? "not_yet" : state.blocked ? "blocked" : state.otherAccount
      ? "other_account" : state.signedOut ? "signed_out" : (state.waitUntil ?? 0) > Date.now() ? "waiting" : "ok";
  }
  return states;
}

// NOTE: [edge case callout] an install made again (Chrome removed the extension, "Load unpacked"
// again) starts its own clock: the participant's study weeks before it would count as past. The study
// server knows when the participant ID first reported (GET /joined, proposed for the server): the past
// ends there at the latest. Past turns are read only once the server was asked (a server without the
// route answers 404: then this install's own date stands).
async function checkJoined(settings) {
  if (!settings.participantId || (await load("joinedChecked"))) return;
  try {
    const query = new URLSearchParams({ participant_id: settings.participantId });
    const response = await fetch(`${settings.serverUrl}/joined?${query}`, { headers: { "X-Study-Key": settings.studyKey }, signal: AbortSignal.timeout(10000) });
    if (!response.ok && response.status !== 404) return;
    const serverJoined = response.ok ? (await response.json()).joined_at : null;
    if (Number.isFinite(serverJoined)) await save("pastBefore", Math.min((await load("pastBefore")) ?? Infinity, serverJoined));
    await save("joinedChecked", true);
  } catch (error) { /* offline: asked again at the next heartbeat or switch */ }
}

// The study server can switch reading off for a site without a new release (GET /config:
// {history: {"chatgpt.com": false}}); a server without it leaves things as they are
async function fetchStudyConfig(settings) {
  try {
    const response = await fetch(`${settings.serverUrl}/config`, { headers: { "X-Study-Key": settings.studyKey }, signal: AbortSignal.timeout(10000) });
    if (response.ok) await save("hconfig", await response.json());
  } catch (error) { /* offline: the last one stands */ }
}

// When the extension is removed, Chrome opens this address: the study server records that the
// participant uninstalled it. (The page cannot be a header-protected request, so the study key
// goes in the address; it ships in every copy of the extension anyway.)
async function setUninstallUrl(settings) {
  const query = new URLSearchParams({ participant_id: settings.participantId, key: settings.studyKey });
  await chrome.runtime.setUninstallURL(`${settings.serverUrl}/uninstalled?${query}`);
}

// What "Hold my answers on this computer" held before 0.5: sent, or deleted, as the participant
// chooses on the settings page.
async function onHeld(message) {
  await serialized("queue", async () => {
    if (message.send) await save("queue", [...((await load("queue")) || []), ...((await load("held")) || [])]);
    await remove("held");
  });
  // their episodes keep their way of sending the conversation (episodes from 0.4: after a review at
  // the check-in), or never send it
  for (const [, record] of await loadAll("episode:")) {
    if (!record.heldAnswers) continue;
    await updateEpisode(record.id, ({ heldAnswers, ...current }) => (message.send ? current : { ...withoutText(current), keepText: true }));
  }
  if (message.send) { await flushQueue(); await sendWaitingTranscripts(); }
}

// "Delete all data on this computer" (settings page): everything but the settings, and every
// timer. Judging loops that were running stop writing (the generation changed), snapshots taken
// before now are ignored, and open chat pages forget which of their turns were sent.
async function deleteAll() {
  generation += 1;
  // NOTE: [edge case callout] until every open chat page has forgotten the turns sent on it, a
  // snapshot from it still lists them: none is taken in meanwhile (a page that does not answer
  // within 2 s has no content script, or is cut off from this extension)
  deletingSince = Infinity;
  // NOTE: [design thought] also kept: when the participant joined, when tracking was on and when the
  // extension ran, this install's id, the reading's epoch (no conversation content); without them,
  // conversations of the study period would count as past ones. Reading conversations from the sites
  // stops (both switches off: the participant agrees again to turn it on), and nothing from before
  // now is ever read again (deletedAt is the floor of lib/history.js windows).
  const kept = {};
  for (const name of ["settings", "heartbeatAt", "joinedAt", "joinedEstimated", "joinedChecked", "pastBefore", "trackingLog", "aliveLog", "aliveGaps", "installId",
                      "historyEpoch", "hconfig", ...HISTORY_SITES.map((host) => `haccount:${host}`)]) {
    const value = await load(name);
    if (value !== undefined) kept[name] = value;
  }
  const before = kept.settings ? { ...kept.settings } : null;
  if (kept.settings) kept.settings = { ...kept.settings, readPast: false, readApps: false };
  kept.historyEpoch = (kept.historyEpoch || 0) + 1;
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await chrome.storage.local.set(kept);
  const forget = (tab) => Promise.race([chrome.tabs.sendMessage(tab.id, { type: "forget" }).catch(() => {}),
                                        new Promise((resolve) => setTimeout(resolve, 2000))]);
  await Promise.all((await chrome.tabs.query({})).map(forget));
  deletingSince = Date.now();
  await save("deletedAt", deletingSince);
  await chrome.alarms.clearAll();
  await keepHeartbeatAlarm();
  await updateBadge();
  // the switches were turned off with the data: reported as any opt-out is (the settings' own change
  // event does not fire for a cleared store)
  if (before) { await consentChanged(before, kept.settings, kept.settings); await statusChanged(); }
}

// Change some settings at once from their stored values (other pages may have changed others meanwhile)
function updateSettings(changes) {
  return serialized("settings", async () => {
    await chrome.storage.local.set({ settings: { ...((await load("settings")) || {}), ...changes } });
  });
}

function openCheckin(query) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`ui/checkin.html${query}`) });
}

// ---------------- event wiring ----------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // the two messages whose callers wait for an answer
  if (message.type === "panel_episode") {
    Promise.all([load(`episode:${message.id}`), getSettings()])
      .then(([record, settings]) => sendResponse({ episode: record ? panelEpisode(record, message.stage, settings) : null }));
    return true;
  }
  if (message.type === "delete_all") {
    deleteAll().then(() => sendResponse({ ok: true }));
    return true;
  }

  // NOTE: [design thought] answer at once and do the work in the background: a judgment can take
  // minutes, and a listener that keeps its caller waiting that long is stopped by Chrome
  sendResponse({ ok: true });
  const tabId = sender.tab?.id;
  // what the participant did with a ratings page: first close its copies in other tabs
  const finished = (then) => panelFinished(message.id, tabId).then(() => then(message));
  switch (message.type) {
    case "snapshot": onSnapshot(message, sender); break;
    case "view": onView(message, sender); break;
    case "activity": onActivity(message); break;
    case "rating_shown": onPanelShown(message, sender); break;
    case "offer_seen": onOfferSeen(message); break;
    case "rating_submitted": finished(onRatingSubmitted); break;
    case "not_advice": finished(onNotAdvice); break;
    case "rating_closed": finished(onPanelClosed); break;
    case "rating_snoozed": finished(onSnoozed); break;
    case "open_rating_tab":
      finished(() => openCheckin(`?rate=${encodeURIComponent(message.id)}&stage=${encodeURIComponent(message.stage || "")}`));
      break;
    case "checkin_submitted": onCheckinSubmitted(message); break;
    case "update_answer": onUpdateAnswer(message).then(() => offerRefused(tabId)); break;
    case "confirm_answer": onConfirmAnswer(message, tabId); break;
    case "invite_answer": onInviteAnswer(message, tabId); break;
    case "card_answer": onCardAnswer(message); break;
    case "past_submitted": onPastSubmitted(message); break;
    case "flush": flushQueue(); break;
    case "held": onHeld(message); break;
    case "panel_gone": offerRefused(tabId); break;              // a page went without an answer ("No", or dealt with elsewhere)
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const [kind, name] = alarm.name.split("|");      // e.g. "quiet|chatgpt.com/<id>", "pause|<episode>", "flush"
  if (kind === "judge" || kind === "quiet") advance(name);
  else if (kind === "hjudge") kickHistory(name || null);
  else if (kind === "hread") { await historyTick(); await settleHanded(); }
  else if (kind === "heldcut") await settleHanded();
  else if (kind === "pause") await onPause(name);
  else if (kind === "ask") await askDue(name);         // the reply did not settle yet
  else if (kind === "remind") await onReminder(name);
  else if (kind === "checkin") {
    // one notification, on the day; after that the check-in waits under the extension icon
    const record = await updateEpisode(name, (current) => (current.checkin ? { ...current, checkin: { ...current.checkin, notifiedAt: Date.now() } } : current));
    if (record && Modes.checkinDue(record, Date.now())) {
      chrome.notifications.create(`checkin|${name}`, {
        type: "basic", iconUrl: "icons/icon128.png", title: "Advice Tracker: two-week check-in",
        message: "How did it go? Tell us what you decided after asking an AI assistant for advice (about 5-10 min).",
        requireInteraction: true,
      });
    }
    await updateBadge();
  } else if (kind === "flush") await flushQueue();
  else if (kind === "heartbeat") await heartbeatIfDue();
});

chrome.notifications.onClicked.addListener((id) => {
  const [kind, episode] = id.split("|");
  chrome.notifications.clear(id);
  openCheckin(kind === "rate" ? `?rate=${encodeURIComponent(episode)}` : `?checkin=${encodeURIComponent(episode)}`);
});

// After a browser restart (alarms may be lost) or an update: restart the timers of the episodes,
// then look at every chat that still has text (which also finishes closings a stop interrupted).
async function resumeAll() {
  const soon = Date.now() + 60000;
  for (const [, record] of await loadAll("episode:")) {
    if (record.status === "open" && Modes.asksAtPauses(record.mode) && !ownText(record)) await armPause(record);
    if (record.status === "open" && record.heldBy === "history" && !record.walk) {
      chrome.alarms.create(`heldcut|${record.id}`, { when: Math.max(record.openedAt + (await getSettings()).cutDays * DAY_MS, soon) });
    }
    if (record.checkin && !record.checkin.doneAt && !record.checkin.notifiedAt) {
      chrome.alarms.create(`checkin|${record.id}`, { when: Math.max(record.checkin.dueAt, soon) });
    }
    if (record.remindAt) chrome.alarms.create(`remind|${record.id}`, { when: Math.max(record.remindAt, soon) });
    if (record.dueAsk) chrome.alarms.create(`ask|${record.id}`, { when: soon });
  }
  for (const [name] of await loadAll("snap:")) advance(name.slice("snap:".length));
  await expireWaiting();
  if (((await load("queue")) || []).length) chrome.alarms.create("flush", { delayInMinutes: 1 });
  // a change of the settings the worker did not see (it was updated or stopped meanwhile)
  await forgetExcluded();
  await sendWaitingTranscripts();
  await keepHistoryAlarm();
  kickHistory();
}

// Reading conversations from the site: an alarm every minute while a switch is on
async function keepHistoryAlarm() {
  const settings = await getSettings();
  if (!historyOn(settings)) { await chrome.alarms.clear("hread"); return; }
  if (!(await chrome.alarms.get("hread"))) chrome.alarms.create("hread", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await getSettings();
  // NOTE: [edge case callout] before 0.4 an episode ended after 10 quiet minutes; episodes now
  // last until the topic changes or a day goes by, so the old default is replaced
  if (details.reason === "update" && settings.endQuietMinutes === 10) settings.endQuietMinutes = DEFAULT_SETTINGS.endQuietMinutes;
  // NOTE: [design thought] the update to 0.5 keeps the promises earlier versions made:
  // - "Hold my answers on this computer" is gone, but what it held is not sent without asking: it
  //   waits under "held", with the episodes it belongs to, and the settings page (opened now)
  //   offers to send or delete it;
  // - an episode from 0.4 was to send its conversation only after a review at its check-in: the
  //   check-in page still offers that review for it, and nothing goes on its own before
  // - an episode that 0.3 (main) recorded had its own choice of what to share, made when it was
  //   rated: its text is never sent now (what 0.3 queued or held goes as the participant chose
  //   then). 0.3 kept no start time and no answer count: its end stands for the start (the
  //   check-in date, the expiry of a question; expireWaiting also reads it so). An episode still
  //   going on at the update had no record yet: it gets one as a 0.5 episode, whose note says that
  //   the conversation goes with the answers
  if (details.reason === "update" && /^0\.[0-4]\./.test(details.previousVersion || "")) {
    const held = settings.localOnly ? (await load("queue")) || [] : [];
    if (settings.localOnly) {
      await serialized("queue", async () => {
        await save("held", [...((await load("held")) || []), ...((await load("queue")) || [])]);
        await remove("queue");
      });
    }
    const heldEpisodes = new Set(held.map((event) => event.payload.episode).filter(Boolean));
    for (const [, record] of await loadAll("episode:")) {
      await updateEpisode(record.id, (current) => {
        if (!current.mode) {           // 0.3 (its answers are in `rating`)
          return { ...current, keepText: true, openedAt: current.openedAt ?? current.closedAt ?? Date.now(),
                   answers: current.answers ?? current.rating ?? null, versions: current.versions ?? (current.rating ? 1 : 0) };
        }
        return { ...current, reviewAtCheckin: true, ...(heldEpisodes.has(record.id) ? { heldAnswers: true } : {}) };
      });
    }
  }
  if (settings.participantId) await seedStudyClock(settings);
  if (!(await load("installId"))) await save("installId", crypto.randomUUID());
  const wasHolding = Boolean(settings.localOnly);
  delete settings.localOnly;
  delete settings.followupDays;        // (before 0.6.1; getSettings converted it to followupSeconds)
  await save("settings", settings);
  if (!settings.participantId || wasHolding) chrome.runtime.openOptionsPage();
  // NOTE: [design thought] participants updated from an earlier version see the new, optional reading
  // of past and other-device conversations once (it stays off unless they agree there)
  else if (details.reason === "update" && /^0\.[0-5]\./.test(details.previousVersion || "")) {
    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#history") });
  }
  await resumeAll();
});
// a browser start: sites that refused the reading (HTTP 403) are tried again
chrome.runtime.onStartup.addListener(async () => {
  for (const [name, state] of await loadAll("hstate:")) if (state.blocked) await save(name, { ...state, blocked: false });
  await noteAlive();
  await resumeAll();
});

// the settings page or the popup changed what is tracked (or the participant ID): report it, let go
// of the text of a site excluded now, and send what waited for tracking to be on again
// ("delete all data" clears the settings and writes them back: that is no change)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings?.oldValue || !changes.settings.newValue) return;
  const before = changes.settings.oldValue, after = changes.settings.newValue;
  const differs = (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]);
  if (["participantId", "paused", "excludedHosts", "serverUrl", "studyKey"].some(differs)) {
    (after.participantId ? noteJoined() : Promise.resolve()).then(statusChanged);
  }
  if (differs("excludedHosts")) forgetExcluded();
  // reading past conversations, or those from other devices, turned on or off: recorded (with the
  // version of the text agreed to), and the walks start again (opting out stops it, and its unanswered
  // episodes go)
  if (differs("readPast") || differs("readApps")) {
    const stopped = [["readPast", "past"], ["readApps", "app"]].filter(([field]) => before[field] && !after[field]).map(([, kind]) => kind);
    historySwitched(stopped).then(() => consentChanged(before, after, after)).then(statusChanged).then(keepHistoryAlarm)
      .then(() => checkJoined(after)).then(() => fetchStudyConfig(after));
  }
  if (trackingOff({ ...DEFAULT_SETTINGS, ...before }) && !trackingOff({ ...DEFAULT_SETTINGS, ...after })) {
    sendWaitingTranscripts().then(flushQueue);         // the conversations that waited, also in the queue
  }
});
// Chrome's site access for the extension changed (chrome://extensions -> Site access)
chrome.permissions.onAdded.addListener(statusChanged);
chrome.permissions.onRemoved.addListener(statusChanged);

// whenever the worker starts: a heartbeat if one is due, its alarm is there, and the uninstall
// address is current
heartbeatIfDue().then(keepHeartbeatAlarm);
noteAlive();
getSettings().then(setUninstallUrl);
