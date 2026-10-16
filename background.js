// Background service worker: the only place that stores data, talks to the study server and
// decides when to ask the participant something. For every chat:
//   snapshot from the page -> each user turn the participant SENT is judged, one at a time, in
//   order (lib/episodes.js: the advice judge while searching, the continuation judge inside an
//   episode) -> an episode ends at a topic switch, or after endQuietMinutes without activity
//   -> the participant is asked for ratings as the episode's rating mode says (lib/modes.js:
//   frequent, switching, periodical or combined) -> check-in followupDays after the episode's first
//   request.
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
//   alias:<key>     a second key of a chat (a new chat's URL gains its id after the first turn)
//   act:<chat>      when the participant last typed in the chat (pauses: periodical, combined modes)
//   lastView        the conversation the participant looked at last (moves: switching, combined)
//   episode:<id>    an episode from its first advice turn on: its mode, the answers given so far,
//                   and its text from its end until the day-14 check-in
//   queue, stats    uploads waiting for the network; counts for the heartbeat
//   held            uploads that "Hold my answers on this computer" (before 0.5) held back: sent or
//                   deleted only when the participant chooses so on the settings page
//   heartbeatAt     when the last heartbeat was sent
//   deletedAt       when "delete all data" last ran
importScripts("config.js", "lib/sites.js", "lib/episodes.js", "lib/modes.js", "lib/redact.js", "lib/similarity.js", "lib/questions.js");

const DEFAULT_SETTINGS = {
  participantId: "", serverUrl: STUDY_CONFIG.serverUrl, studyKey: STUDY_CONFIG.studyKey, paused: false, pausedAt: null,
  ratingMode: STUDY_CONFIG.ratingMode || "switching",     // "frequent" | "switching" | "periodical" | "combined"
  followupDays: 14,
  endQuietMinutes: 24 * 60,    // an episode also ends after this long without activity in its chat
  pauseMinutes: 3,             // periodical, combined: a pause is this long without typing in the episode's chat
  updateSeconds: 30,           // the update and confirm pop-ups disappear after this long
  excludedHosts: [], redactNames: [], relatedThreshold: 0.5,
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
async function getSettings() { return { ...DEFAULT_SETTINGS, ...((await load("settings")) || {}) }; }
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
  const view = { key: await chatKey(message), tabId: sender.tab.id, site: message.site, at: Date.now() };
  await save("lastView", view);
  for (const [, record] of await loadAll("episode:")) {
    if (record.status === "open" && record.chatKey !== view.key) await ask(record.id, "onOtherConversation", view);
  }
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
    chat = closed ? await closeEpisode(key, chat, closed, page) : await afterSync(before, chat, page, settings);
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

    const job = Episodes.nextJob(chat, userTurns, replies);
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
      const quietAt = snapshot.changedAt + settings.endQuietMinutes * 60000;
      if (Date.now() < quietAt) {
        chrome.alarms.create(`quiet|${key}`, { when: quietAt });
        return;
      }
      ({ chat, closed } = Episodes.closeOpen(chat, "quiet"));
      chat = await closeEpisode(key, chat, closed, page);
    }
    if (await dropText(key, snapshot)) return;
  }
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
    const decision = Modes.onClosed(current, closed.closedBy);
    const waits = Boolean(current.answers) && trackingOff(settings);      // its complete conversation goes once tracking is on
    return decision.status === "delete" ? null : closedRecord(current, decision, closed, messages, waits);
  });
  if (record && closedNow) await ask(record.id, "waitingPage");
  // the complete conversation of an episode with answers (turns may have come after the last answers)
  if (record && closedNow && messages) await sendTranscript(record.id, messages);
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
  await upload("episode_transcript", { episode: claimed.id, site: claimed.site, mode: claimed.mode, closed_by: claimed.closedBy,
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
    if (current.answers) return { ...withoutText(current), keepText: true };
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
    if (record.status === "open") advance(record.chatKey);
    else await forgetEnded(record.id);
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
    basedOn: record.versions, previous: record.answers, answered: record.versions > 0,
    confirmed: record.versions > 0 || Boolean(record.confirmedAt),        // combined mode: Yes in the confirm pop-up
    text: Questions.conversationGoes(record, excluded(settings, record.url)),
  };
}

function panelSettings(settings) {
  return { followupDays: settings.followupDays, updateSeconds: settings.updateSeconds };
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
  if (record.status === "open") {
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
  await updateEpisode(message.id, (current) => ({ ...current, askedEnd: Math.max(current.askedEnd ?? 0, pageEnd(current, message)),
                                                  panelTabs: [...new Set([...(current.panelTabs || []), sender.tab.id])] }));
  await updateBadge();
}

// A pop-up was visible for the first time. The confirm pop-up asks nothing about the advice, so
// it leaves askedEnd alone: the first ratings page still comes (lib/modes.js).
async function onOfferSeen(message) {
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
    const { dueAsk, ...rest } = current;
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
    const dueAt = record.openedAt + settings.followupDays * 24 * 3600 * 1000;
    await updateEpisode(record.id, (current) => ({ ...current, checkin: { dueAt, doneAt: null } }));
    chrome.alarms.create(`checkin|${record.id}`, { when: dueAt });
  }
  // NOTE: [design thought] the answers go with the conversation they are about (turns
  // opening..answeredEnd), both redacted on this computer
  const conversation = await transcript(record, record.answeredEnd, settings);
  await upload("episode_rating", {
    episode: record.id, site: record.site, mode: record.mode, stage, version: record.versions,
    turns: record.answeredEnd - record.start + 1, opening_turn: record.opening - record.start + 1, open: record.status === "open",
    closed_by: record.closedBy, opened_at: record.openedAt, closed_at: record.closedAt,
    rating: redactAnswers(message.rating, settings.redactNames), related_earlier: record.related.length,
    transcript: conversation?.messages ?? null, redacted: conversation?.counts ?? null,
  }, settings);
  await count(record.versions === 1 ? "rated" : "updated");
  await updateBadge();
  // frequent mode: turns that came while the page was open and did not reach it get their pop-up
  if (record.status === "open") await askWhenSettled(record, "onExtended");
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
  await upload("checkin", { episode: record.id, site: record.site, mode: record.mode,
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
  if (gone.status === "open") advance(gone.chatKey);
  await updateBadge();
  return gone;
}

async function onNotAdvice(message) {
  const gone = await removeEpisode(message.id);
  if (!gone) return;
  await serialized("queue", async () => save("queue", ((await load("queue")) || []).filter((event) => event.payload.episode !== gone.id)));
  await count("not_advice");
  // counts only: no text, no answers
  await upload("not_advice", { episode: gone.id, site: gone.site, mode: gone.mode, turns: gone.end - gone.start + 1,
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
    await upload("prompt", { episode: record.id, mode: record.mode, prompt: "update", answer: message.answer,
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
    await upload("prompt", { episode: record.id, mode: record.mode, prompt: "confirm", answer: message.answer,
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
  const waiting = (await loadAll("episode:")).filter(([, record]) => Modes.waiting(record) || Modes.checkinDue(record, now)).length;
  await chrome.action.setBadgeText({ text: waiting ? String(waiting) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#4f5bd5" });
}

// A question nobody answered by the time the episode's check-in is due (followupDays after its
// first request) is dropped: an ended episode never answered goes (with its text), and final
// answers that never came leave the earlier ones as the final ones.
async function expireWaiting() {
  const settings = await getSettings();
  const limit = Date.now() - settings.followupDays * 24 * 3600 * 1000;
  // NOTE: [edge case callout] 0.3 kept no start time, only the end (the update gives a 0.3 record
  // its end as start, but the heartbeat a new worker sends at once can come before that)
  const recent = (record) => (record.openedAt ?? record.closedAt) > limit;
  for (const [, record] of await loadAll("episode:")) {
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
    const episode = payload.episode && type !== "not_advice" ? await load(`episode:${payload.episode}`) : null;
    if ((payload.episode && type !== "not_advice" && (!episode || episode.status === "removed")) || started !== generation) return;
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
  if (!event.payload.episode || event.type === "not_advice") return event;
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
  return { tracking: !settings.paused && listening.length > 0, paused: settings.paused, paused_at: settings.pausedAt,
           listening_sites: listening, excluded_sites: excludedSites, sites_without_access: withoutAccess };
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
  }, settings);
  await save("heartbeatAt", Date.now());
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
  if (settings.participantId) await upload("status", await trackingStatus(settings), settings);
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
  const settings = await load("settings"), heartbeatAt = await load("heartbeatAt");
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ ...(settings ? { settings } : {}), ...(heartbeatAt ? { heartbeatAt } : {}) });
  const forget = (tab) => Promise.race([chrome.tabs.sendMessage(tab.id, { type: "forget" }).catch(() => {}),
                                        new Promise((resolve) => setTimeout(resolve, 2000))]);
  await Promise.all((await chrome.tabs.query({})).map(forget));
  deletingSince = Date.now();
  await save("deletedAt", deletingSince);
  await chrome.alarms.clearAll();
  await keepHeartbeatAlarm();
  await updateBadge();
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
    case "flush": flushQueue(); break;
    case "held": onHeld(message); break;
    case "panel_gone": offerRefused(tabId); break;              // a page went without an answer ("No", or dealt with elsewhere)
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const [kind, name] = alarm.name.split("|");      // e.g. "quiet|chatgpt.com/<id>", "pause|<episode>", "flush"
  if (kind === "judge" || kind === "quiet") advance(name);
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
    if (record.status === "open" && Modes.asksAtPauses(record.mode)) await armPause(record);
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
  const wasHolding = Boolean(settings.localOnly);
  delete settings.localOnly;
  await save("settings", settings);
  if (!settings.participantId || wasHolding) chrome.runtime.openOptionsPage();
  await resumeAll();
});
chrome.runtime.onStartup.addListener(resumeAll);

// the settings page or the popup changed what is tracked (or the participant ID): report it, let go
// of the text of a site excluded now, and send what waited for tracking to be on again
// ("delete all data" clears the settings and writes them back: that is no change)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings?.oldValue || !changes.settings.newValue) return;
  const before = changes.settings.oldValue, after = changes.settings.newValue;
  const differs = (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]);
  if (["participantId", "paused", "excludedHosts", "serverUrl", "studyKey"].some(differs)) statusChanged();
  if (differs("excludedHosts")) forgetExcluded();
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
getSettings().then(setUninstallUrl);
