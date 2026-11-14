// Background service worker: the only place that stores data, talks to the study server and
// decides when to ask the participant something. For every chat:
//   snapshot from the page -> each user turn the participant SENT is judged, one at a time, in
//   order (lib/episodes.js: the advice judge while searching, the continuation judge inside an
//   episode) -> an episode ends at a topic switch, or after endQuietMinutes without activity
//   -> the participant is asked for ratings as the episode's rating mode says (lib/modes.js:
//   frequent, switching, periodical or combined) -> the follow-up, followupSeconds after the episode's
//   first request (7 days): did they decide, did they act, then how it turned out (lib/modes.js
//   followupStage; a pop-up on the chat page, and the outcomes page).
// The study's weeks count from when the participant joined (config.js): new advice conversations are looked
// for until the end of week 3, open ones are followed until the end of week 4, and the follow-ups go on
// until the end of week 5 (0.6.14).
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
//                   and its text from its end until the outcome questions of its follow-up are answered
//                   (the outcomes page shows it for review with those questions: reviewedTranscript)
//   queue, stats    uploads waiting for the network; counts for the heartbeat
//   held            uploads that "Hold my answers on this computer" (before 0.5) held back: sent or
//                   deleted only when the participant chooses so on the settings page
//   heartbeatAt     when the last heartbeat was sent
//   joinedAt        when the participant ID was first set: turns before it are past, after it the study's
//   lastMessageAt   when the participant last sent a message to one of the AI assistants (a time, no text)
//   pausedRemindedAt  when the last reminder of a pause came
//   redactNumbers   the numbers of the placeholders in what was uploaded ([NAME1], [NAME2], ...: lib/redact.js),
//                   under fingerprints of the details, so the same detail gets the same number again
//   teamMessages    the messages for this participant: [{id, title, text, sentAt, receivedAt, readAt}], sent by the
//                   study team or made here (`automatic`: the reminder at the end of a study week)
//   weekStatus      what was found at the end of each paid part of the study, and three days later (weekCheck)
//   feedbackAt      when the participant sent feedback (times, no text): one of the ways to be active in a week
//   trackingLog     [{at, on: [hosts]}]: from `at` on, tracking was on for these sites (none while paused)
//   deletedAt       when "delete all data" last ran
//   appsFrom        (an install updated to 0.6.11 that had not agreed to read other devices) the update: turns from
//                   other devices before it are never read
importScripts("config.js", "lib/sites.js", "lib/episodes.js", "lib/modes.js", "lib/redact.js", "lib/similarity.js", "lib/questions.js",
              "lib/history.js");

const DEFAULT_SETTINGS = {
  participantId: "", serverUrl: STUDY_CONFIG.serverUrl, studyKey: STUDY_CONFIG.studyKey, paused: false, pausedAt: null,
  ratingMode: STUDY_CONFIG.ratingMode || "combined",      // "frequent" | "switching" | "periodical" | "combined"
  followupSeconds: 7 * 24 * 3600,    // the follow-up begins this long after an episode's first request (the settings page can shorten it for a test)
  endQuietMinutes: 7 * 24 * 60,  // an episode also ends after this long without activity in its chat (a day before 0.6.12)
  cutDays: 7,                  // ... and is complete this many days after its first request (as at a change of topic)
  pauseMinutes: 3,            // periodical, combined: a pause is this long without typing in the episode's chat
  updateSeconds: 30,           // the update and confirm pop-ups disappear after this long
  excludedHosts: [], redactNames: [], relatedThreshold: 0.5,
  readPast: false,             // opt-in: read past conversations (before joining) to annotate some (lib/history.js)
  // (the conversations of the sites' apps and other devices since joining are always read, since 0.6.11)
};
const POLL_WAIT_S = 20;      // one long-poll for a label (Chrome stops a worker that waits > 30 s for a response)
const RETRY_MINUTES = 2;     // after a failed judgment, or when the server cannot be reached
const SNOOZE_MINUTES = 60;   // "later (1 h)"
const ASK_WAIT_MINUTES = 5;  // a question about a reply waits at most this long for the reply to be complete
const HEARTBEAT_MINUTES = 12 * 60;
const QUESTION_EXPIRE_DAYS = 14;     // a question about an episode never answered goes this long after its first request
const FOLLOWUP_GAP_MS = 4 * 3600 * 1000;   // follow-up pop-ups about different conversations at most this often
// The study's weeks, in days from when the participant joined (config.js; studyDay below)
const NEW_ADVICE_DAYS = STUDY_CONFIG.newAdviceDays ?? 21;    // new advice conversations are looked for until the end of week 3 ...
const CONTINUE_DAYS = STUDY_CONFIG.continueDays ?? 28;       // ... and open ones are followed until the end of week 4
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
// When the participant last sent a message to one of the AI assistants (a time, no text): the heartbeat
// reports it, since the study's rules ask for some use of the assistants in every week, and from the end of
// week 3 on no message goes to the study server
function noteMessage(at) {
  return serialized("lastMessageAt", async () => {
    if (at > ((await load("lastMessageAt")) ?? 0)) await save("lastMessageAt", at);
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
// (answers given after the episode ended are uploaded with them), and for a past one the text as
// the participant left it in its review box (`review`, until its annotation is queued).
function withoutText(record) {
  const { messages, review, ...rest } = record;
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
    // a new copy begins (none was kept, or the page replaces it), or the stored one goes on (`above`:
    // how many older turns it has taken in above its first turn; `begun`: where a copy begun from
    // the page found the chat's settled turns): the chat finds its settled turns in the copy by
    // these (Episodes.expectedOffset)
    let copy = Math.max(stored?.copy ?? 0, chat?.lined?.copy ?? 0) + 1, above = 0, begun;
    if (stored) {
      // a page that shows only part of a long chat keeps the rest of the stored copy
      // NOTE: [design thought] a turn's id counts the earlier turns with the same text, so the ids
      // of sent turns are renumbered with their turns: the page's from its own numbering, the
      // stored ones where older turns came in above (or an edit replaced them)
      const pageIds = Episodes.turnIds(Episodes.splitTurns(message.messages).userTurns);
      const merged = Episodes.mergeWindow(stored.messages, message.messages, { fresh: message.fresh ?? null, claimed: message.sent.length > 0,
                                                                               sentLast: message.sent.includes(pageIds.at(-1)) });
      const turnsOf = (list) => Episodes.splitTurns(list).userTurns;
      const pageId = merged.pageShift === null ? () => null : Episodes.renumber(turnsOf(message.messages), turnsOf(merged.messages), merged.pageShift);
      const storedId = Episodes.renumber(turnsOf(stored.messages), turnsOf(merged.messages), merged.storedShift, merged.storedKeep);
      messages = merged.messages;
      sent = message.sent.map(pageId).filter(Boolean);
      storedSent = stored.sent.map(storedId).filter(Boolean);
      // the popup's count: the captured turns of the stored copy are renumbered too
      const storedIds = new Set(Episodes.turnIds(turnsOf(stored.messages)));
      captured = captured.map((id) => (storedIds.has(id) ? storedId(id) : id)).filter(Boolean);
      if (merged.storedKeep > 0 && stored.copy !== undefined) {
        copy = stored.copy;
        begun = stored.begun;
        above = stored.above + merged.storedShift;
        // NOTE: [edge case callout] an edit of an older turn loaded above the settled ones (both since
        // the last sync) cuts them off: the chat goes on differently from the cut, so that is where
        // the next sync looks for them, and the edited turn is judged
        const settledAt = Episodes.expectedOffset(chat, stored);
        if (settledAt !== null && merged.storedKeep < settledAt) above -= settledAt - merged.storedKeep;
      }
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
      await noteMessage(message.capturedAt);
    }
    const same = stored && JSON.stringify(stored.messages) === JSON.stringify(messages);
    // whole: the copy holds the chat from its first settled turn on (Episodes.sync). A copy begun
    // from a part of the chat further down (its earlier copy was dropped) stays a part.
    // NOTE: [design thought] a copy begun from the page (none was kept: every turn was synced) finds
    // the settled turns by their texts and the turns new to the page: older turns loaded above whose
    // topmost repeats the chat's first text would otherwise be taken for it, and the settled turns
    // below for new ones
    let whole = stored?.whole ?? true;
    if (!stored) {
      const at = Episodes.lineUp(chat?.ids || [], Episodes.turnIds(Episodes.splitTurns(messages).userTurns), false, null, message.fresh ?? null);
      whole = !(at > 0);
      begun = at === null ? undefined : -at;
    }
    await save(`snap:${key}`, {
      messages, url: message.url, site: message.site, tabId: sender.tab.id, settled: Boolean(message.settled), whole, copy, above, begun,
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
  // a message from the study team has a small window of its own, apart from the questions (0.6.15): it comes
  // also while tracking is paused
  await offerTeamMessage(sender.tab.id, message.url, settings);
  if (notTracking(settings, message.url)) return;
  const view = { key: await chatKey(message), tabId: sender.tab.id, site: message.site, url: message.url, at: Date.now() };
  await save("lastView", view);
  for (const [, record] of await loadAll("episode:")) {
    if (record.status === "open" && record.chatKey !== view.key && !ownText(record)) await ask(record.id, "onOtherConversation", view);
  }
  // a page of the site came to the front: its next question about a conversation read from the site, else
  // a follow-up question (0.6.9), else the reminder of the Outcomes page (0.7)
  if (!(await offerQueued(view)) && !(await offerFollowup(view))) await offerOutcomesReminder(view);
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
    let offset;
    ({ chat, closed, offset } = Episodes.sync(chat, userTurns, new Set(snapshot.sent), snapshot.whole ?? true, Episodes.expectedOffset(chat, snapshot)));
    // where the settled turns sit in this copy now: the next sync looks for them there
    chat = { ...chat, lined: { copy: snapshot.copy, above: snapshot.above, offset } };
    // an open episode followed by turns the page did not see sent (another device, most likely) is
    // handed to the walk through the conversation read from the site, instead of ending
    if (closed?.closedBy === "history" && historyAllowed(settings, hostOf(snapshot.url)) &&
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
    // NOTE: [design thought] the study looks for new advice conversations in its first three weeks only
    // (NEW_ADVICE_DAYS): a turn sent after them that no open episode takes is not judged, and nothing of it
    // goes to the study server. It is settled here as "not advice", so the chat lets go of its text as always.
    // NOTE: [edge case callout] the time is the page's last change before this look (as a judgment's sentAt): a
    // turn sent in the last moments of week 3 whose reply is still being written when the week ends is not judged
    if (job?.kind === "advice" && snapshot.changedAt >= await studyDay(NEW_ADVICE_DAYS)) {
      ({ chat } = Episodes.applyLabel(chat, job, { advice: false }));
      if (stale()) return;
      await save(`chat:${key}`, chat);
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
      // quiet here: the conversation may go on in an app, so the walk takes the episode
      if (closed.closedBy === "quiet" && historyAllowed(settings, hostOf(snapshot.url)) &&
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

// When the open episode of `chat` is complete (cutOf; the record keeps the time of its first request too,
// for a chat from before 0.4 that does not)
async function cutAt(chat, settings) {
  const openedAt = chat.openedAt ?? (await load(`episode:${chat.episodeId}`))?.openedAt ?? Date.now();
  return cutOf(openedAt, settings);
}

// When an episode is complete: cutDays after its first request, and at the end of the study's week 4 at the
// latest (CONTINUE_DAYS: no conversation is followed after it).
// NOTE: [design thought] with the study's numbers the second never comes first (a conversation that began
// before the end of week 3 is complete 7 days later, so by the end of week 4): it is written down here so
// that the rule holds whatever cutDays is (a test can change it on the settings page)
async function cutOf(openedAt, settings) {
  return Math.min(openedAt + settings.cutDays * DAY_MS, await studyDay(CONTINUE_DAYS));
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
    const shift = Episodes.findOffset(chat.ids, Episodes.turnIds(page.userTurns), Episodes.expectedOffset(chat, page.snapshot));
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

// One judgment for the study server's judge. `chat`: the conversation's state ({key, site}: its key names the chat).
// NOTE: [design thought] (0.6.20) the request also carries the chat's code (`chat`): a hash of the chat's key, the
// same one that starts the ids of the chat's episodes (episodeId), so the study team's monitor can show which
// conversation a judgment belongs to, next to its answers and check-ins. It names no text, and the judge never
// gets it (relay 0.6.6 keeps it with the judgment's labels; an older relay ignores the field).
async function submit(job, chat, settings) {
  try {
    const response = await fetch(`${settings.serverUrl}/judge`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Study-Key": settings.studyKey },
      body: JSON.stringify({ participant_id: settings.participantId, site: chat.site, ...redactJob(job, settings.redactNames),
                             chat: Episodes.hash(chat.key) }),
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

// Redaction of what the study stores (answers, conversations, feedback): the placeholders are numbered
// (0.6.15, lib/redact.js: the same name is [NAME1] wherever it comes up again), from the table kept under
// redactNumbers. `work(numbers)` redacts with that table (Redact.redact(text, names, numbers)), which may add
// to it; returns what work returns.
// NOTE: [edge case callout] one redaction at a time (the table's chain), and the table is saved before the
// redacted text is handed back: two uploads at once never give one number to two details, and a number in a
// text that left the computer is never given out again after the worker stops
function withNumbers(work) {
  return serialized("redactNumbers", async () => {
    const numbers = (await load("redactNumbers")) || {};
    const before = JSON.stringify(numbers);
    const result = work(numbers);
    if (JSON.stringify(numbers) !== before) await save("redactNumbers", numbers);
    return result;
  });
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
// NOTE: [edge case callout] only episodes asked before this one (`openedAt`): a past conversation
// found today is older than the web episodes already recorded, so linking it to them would count
// it as a later, related conversation at their check-ins (and them as earlier ones in its upload)
async function relatedEpisodes(openingText, settings, openedAt = Infinity) {
  return (await loadAll("episode:")).map(([, other]) => other)
    .filter((other) => other.openingText && (other.openedAt ?? 0) < openedAt &&
                       Similarity.jaccard(openingText, other.openingText) >= settings.relatedThreshold)
    .map((other) => other.id);
}

async function saveNewRecord(id, chat, page, settings) {
  const openingText = page.userTurns[chat.opening - 1] || "";
  const openedAt = chat.openedAt ?? Date.now();
  const record = {
    id, chatKey: chat.key, site: chat.site, url: page.snapshot.url,
    mode: settings.ratingMode,           // fixed for the episode's whole life
    start: chat.segmentStart, opening: chat.opening, end: chat.end ?? chat.opening, openedAt,
    closedAt: null, closedBy: null, openingText, related: await relatedEpisodes(openingText, settings, openedAt),
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
    // (the final answers are due only if the episode, as it closes, has new input since the answers)
    const decision = Modes.onClosed({ ...current, end: closed.end }, closed.closedBy);
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
  const messagesOut = Episodes.episodeMessages(userTurns, replies, claimed.opening - claimed.start + 1, claimed.end - claimed.start + 1);
  const redacted = await withNumbers((numbers) => Redact.redactMessages(messagesOut, settings.redactNames, numbers));
  // (answer_versions, final_due: when a change of topic or the cut asked no final answers, because
  // nothing was new since the answers, the last episode_rating stands as the final one)
  await upload("episode_transcript", { episode: claimed.id, site: claimed.site, source: claimed.source ?? "web", mode: claimed.mode, closed_by: claimed.closedBy,
                                       answer_versions: claimed.versions, final_due: Modes.pageDue(claimed)?.stage === "final",
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
  // (askAgainDays: lib/modes.js is not loaded on the chat pages, and the follow-up pop-up says "in 2 days")
  return { followupSeconds: settings.followupSeconds, updateSeconds: settings.updateSeconds, askAgainDays: Modes.ASK_AGAIN_DAYS };
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
    const chat = await load(`chat:${record.chatKey}`), snapshot = await load(`snap:${record.chatKey}`);
    const { userTurns, replies } = Episodes.splitTurns(snapshot?.messages || []);
    // NOTE: [edge case callout] the page may have loaded older turns above since the chat was last
    // brought in line with it (its judging loop waits for a label meanwhile): the episode's turns
    // then sit further down in the snapshot, where the copy says. If its known turns are not there
    // unchanged, nothing is sent rather than other turns.
    const shift = Episodes.findOffset(chat?.ids || [], Episodes.turnIds(userTurns), Episodes.expectedOffset(chat, snapshot));
    if (shift < 0) return null;
    messages = Episodes.episodeMessages(userTurns, replies, record.opening + shift, end + shift);
  } else if (record.messages) {
    // the record holds turns start..end only: its turn k is turn start + k - 1 of the chat
    const { userTurns, replies } = Episodes.splitTurns(record.messages);
    messages = Episodes.episodeMessages(userTurns, replies, record.opening - record.start + 1, end - record.start + 1);
  }
  return messages && withNumbers((numbers) => Redact.redactMessages(messages, settings.redactNames, numbers));
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
    // a pop-up can wait unseen on a tab in the background: its tab and the turn it asks about are
    // kept, so it can be withdrawn once the participant deals with that turn elsewhere (withdrawOffers)
    if (type !== "show_panel" && response.shown) await keepOffer(id, tabId, record);
    return true;
  }
  if (rule !== "waitingPage") return false;
  // NOTE: [design thought] notifications never show conversation text (IRB protocol)
  chrome.notifications.create(`rate|${id}`, {
    type: "basic", iconUrl: "icons/icon128.png", title: "Advice Tracker: a quick question",
    message: `A conversation on ${record.site} looked like a request for advice. Click to answer a few questions (about 1 to 2 minutes).`,
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
  // (a queued question shown in the extension's tab is its site's current one until it is answered; but the two
  // pages each show their own kind, 0.6.9, and the chat page asks other devices first: a past card does not take
  // the site's question while one from another device is due there, and an other-device card does not take it
  // from a past question the site is asking now)
  if (record && Modes.viaQueue(record)) {
    const settings = await getSettings(), now = Date.now();
    const due = (other) => kindOn(settings, other) && !excluded(settings, other.url) && Modes.queueDue(other, now, settings.followupSeconds);
    const appDue = record.source === "past" &&
      (await loadAll("episode:")).some(([, other]) => other.site === record.site && other.source !== "past" && Modes.viaQueue(other) && due(other));
    await serialized(`qstate:${record.site}`, async () => {
      const queue = (await load(`qstate:${record.site}`)) || {};
      const held = record.source !== "past" && queue.current && queue.current !== record.id ? await load(`episode:${queue.current}`) : null;
      if (appDue || (held?.source === "past" && due(held))) return;
      await save(`qstate:${record.site}`, { ...queue, current: record.id });
    });
  }
  await updateBadge();
}

// A pop-up was visible for the first time. The confirm pop-up asks nothing about the advice, so
// it leaves askedEnd alone: the first ratings page still comes (lib/modes.js).
async function onOfferSeen(message) {
  if (message.asked === "offer_invite") { await count("asked_offer_invite_seen"); return; }      // an invitation asks nothing yet
  if (message.asked === "offer_reminder") { await count("asked_offer_reminder_seen"); return; }  // (0.7) nor a reminder
  await updateEpisode(message.id, (current) => (message.asked === "offer_confirm"
    ? { ...current, confirmAskedAt: current.confirmAskedAt ?? Date.now() }
    : { ...current, askedEnd: Math.max(current.askedEnd ?? 0, pageEnd(current, message)) }));
  await count(`asked_${message.asked}`);
  await updateBadge();
}

// The participant is done with a ratings page (answered, closed, skipped, snoozed, or moved it to
// a tab): copies of it open in other tabs close, and pop-ups that waited for it come.
async function panelFinished(id, tabId, coveredEnd = Infinity) {
  let others = [];
  await updateEpisode(id, (current) => {
    others = (current.panelTabs || []).filter((tab) => tab !== tabId);
    return { ...current, panelTabs: [] };
  });
  for (const tab of others) chrome.tabs.sendMessage(tab, { type: "close_panel", id }).catch(() => {});
  await withdrawOffers(id, coveredEnd);
  if (tabId !== undefined) await offerRefused(tabId);
}

// A pop-up (or an invitation of the queue) is on a tab: its tab, and the episode's first and last turn as
// they were numbered when it was asked (`record`): pageEnd maps them to the record's numbering later,
// when older turns loaded above have renumbered the record.
async function keepOffer(id, tabId, record) {
  const offer = { tab: tabId, start: record.start, end: record.end };
  await updateEpisode(id, (current) => ({ ...current, offerTabs: [...(current.offerTabs || []).filter((kept) => kept.tab !== tabId), offer] }));
}

// The participant dealt with the episode up to its turn `coveredEnd` (answered it, closed or put off its
// page, answered one of its pop-ups; every turn after "No"): its pop-ups about those turns that still
// wait on tabs (in the background, unseen) go, so none of them asks the same question again when nothing
// new has come since. A pop-up about a later turn stays: that turn is new input for it.
async function withdrawOffers(id, coveredEnd = Infinity) {
  let tabs = [];
  await updateEpisode(id, (current) => {
    if (!current.offerTabs) return current;
    const covered = (offer) => pageEnd(current, offer) <= coveredEnd;
    tabs = current.offerTabs.filter(covered).map((offer) => offer.tab);
    const { offerTabs, ...rest } = current;
    const kept = offerTabs.filter((offer) => !covered(offer));
    return kept.length ? { ...rest, offerTabs: kept } : rest;
  });
  for (const tab of tabs) chrome.tabs.sendMessage(tab, { type: "close_offer", id }).catch(() => {});
}

// The episode's last turn that a page or pop-up message is about, in the record's numbering: the end the
// message carries (a pop-up's, a submitted page's), else the record's own end (closing or putting off a
// page, an invitation: an open page shows the episode as it is now); every turn after a "No" or when the
// episode is gone. Answers withdraw nothing here: only once they count (onRatingSubmitted, not when
// they are refused as stale).
async function coveredEnd(message) {
  if (message.type === "not_advice") return Infinity;
  if (message.type === "rating_submitted") return -Infinity;
  const record = await load(`episode:${message.id}`);
  if (!record) return Infinity;
  return message.end === undefined ? record.end : pageEnd(record, message);
}

// A pop-up was answered (yes, no, an invitation's open, later or stop, or left to time out on the
// screen): its copies about the same turns on other tabs go. Superseded by a page, or withdrawn, it
// was not answered: the copies stay.
async function offerAnswered(message) {
  if (!["yes", "no", "timeout", "open", "later", "stop"].includes(message.answer)) return;
  await withdrawOffers(message.id, await coveredEnd(message));
}

// Free text leaves the computer only after redaction, like everything else (a promise: the placeholders
// are numbered, withNumbers).
function redactAnswers(answers, names) {
  return withNumbers((numbers) => Object.fromEntries(Object.entries(answers).map(([key, value]) =>
    [key, typeof value === "string" ? Redact.redact(value, names, numbers).text : value])));
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
  // the answers count: pop-ups about the turns they cover go, and so does a notification still in the tray
  await withdrawOffers(record.id, record.answeredEnd);
  chrome.notifications.clear(`rate|${record.id}`);
  chrome.alarms.clear(`remind|${record.id}`);
  chrome.alarms.clear(`ask|${record.id}`);
  if (!record.checkin) {
    // NOTE: [design thought] the follow-up counts from the episode's first request, not from its end
    // or from the answers: an episode can go on for a while, and answers can come days later. With the
    // study's 7 days it begins when the conversation is complete at the latest (the cut). One found on
    // another device days later begins the follow-up time after its first answers at the earliest.
    const askFrom = Math.max(record.openedAt, record.source === "app" ? Date.now() : 0) + settings.followupSeconds * 1000;
    await updateEpisode(record.id, (current) => ({ ...current, checkin: { askFrom, nextAt: null, decision: null, dueAt: null, doneAt: null } }));
    await armFollowup(record.id);
  }
  // NOTE: [design thought] the answers go with the conversation they are about (turns
  // opening..answeredEnd), both redacted on this computer; `timing` is how long the form took (0.6.14,
  // lib/questions.js timing: times only), for the study team's review of the answers' quality
  const conversation = await transcript(record, record.answeredEnd, settings);
  await upload("episode_rating", {
    episode: record.id, site: record.site, source: record.source ?? "web", mode: record.mode, stage, version: record.versions,
    turns: record.answeredEnd - record.start + 1, opening_turn: record.opening - record.start + 1, open: record.status === "open",
    closed_by: record.closedBy, opened_at: record.openedAt, closed_at: record.closedAt,
    rating: await redactAnswers(message.rating, settings.redactNames), timing: message.timing ?? null, related_earlier: record.related.length,
    transcript: conversation?.messages ?? null, redacted: conversation?.counts ?? null,
  }, settings);
  await count(record.versions === 1 ? "rated" : "updated");
  await updateBadge();
  // frequent mode: turns that came while the page was open and did not reach it get their pop-up
  if (record.status === "open" && !ownText(record)) await askWhenSettled(record, "onExtended");
}

async function onCheckinSubmitted(message) {
  const settings = await getSettings();
  // NOTE: [edge case callout] the check-in is taken in the record's chain, so two pages submitting it
  // at once (two tabs of the check-in page) send it once: the second finds it done
  let record = null;
  await updateEpisode(message.id, (current) => {
    if (!current.checkin || current.checkin.doneAt) return current;
    record = current;
    return { ...current, checkin: { ...current.checkin, doneAt: Date.now() } };
  });
  if (!record) return;
  const later = (await loadAll("episode:")).filter(([, other]) => (other.related || []).includes(record.id)).length;
  chrome.alarms.clear(`checkin|${record.id}`);
  // NOTE: [edge case callout] an episode whose complete conversation did not go yet (it ended while
  // tracking was off) sends it now, before the record lets go of the text; while tracking is still
  // off, the record keeps the text until it is on again (sendWaitingTranscripts)
  await sendTranscript(record.id);
  // the conversation as the participant left it in the review box of the outcome questions (0.6.16; before,
  // only an episode from 0.4 had the box): never for one whose text stays on this computer
  const reviewed = Questions.conversationGoes(record, excluded(settings, record.url)) !== "stays" &&
                   (record.messages || record.status === "open") && typeof message.transcript === "string";
  await updateEpisode(record.id, (current) => {
    const owed = current.answers && current.messages && !current.transcriptSent && !textStays(current, settings);
    return current.status === "open" || owed ? current : doneRecord(current);      // an open one becomes done when it ends
  });
  // (how the follow-up went, 0.6.9: when it began, the answers about deciding and acting with their times, how
  // often its pop-up was seen and how often "too early to tell" was answered; due_at is when the answers made
  // the outcome questions ready, null when the study's last week did (final_call: they were answered in that
  // week, when they are due whatever the answers were). Times and choices only; `timing` as with the ratings)
  const checkin = record.checkin;
  await upload("checkin", { episode: record.id, site: record.site, source: record.source ?? "web", mode: record.mode,
                            answers: await redactAnswers(message.answers, settings.redactNames), timing: message.timing ?? null, related_later: later,
                            followup: { ask_from: checkin.askFrom ?? null, due_at: checkin.dueAt ?? null, shown: checkin.shown ?? 0,
                                        final_call: Modes.finalCall(checkin, Date.now(), await studyEnd()), ...(checkin.decision || {}) },
                            ...(reviewed ? await reviewedTranscript(message, settings) : {}) }, settings);
  await count("checked_in");
  await updateBadge();
}

// The conversation as the participant left it in a review box of the outcomes page (0.6.16, ui/checkin.js
// showReview), for the upload of the answers it was submitted with. `review`: {transcript: the box's text at
// Submit, edited: whether it differs from the text shown, shownChars: how long the text shown was}.
// NOTE: [thought process] the consent form says of the Outcomes page: "You can delete anything else you do not
// want us to keep. The conversation is then stored on our study server with your answers." The study also wants
// to know how much participants edit, so the upload says whether the text was changed and how long it was before
// and after. For a study conversation the unedited text is on the server as well (it went with the quick answers
// and when the conversation ended: episode_rating, episode_transcript), so there the two can be compared word by
// word; a past conversation's unedited text goes only if the participant changed nothing (finishPastAnnotation).
// NOTE: [edge case callout] the box is free text, so the participant can also type into it: it is redacted once
// more here. Labels already in it ([NAME1], ...) stay as they are (lib/redact.js KEPT).
async function reviewedTranscript(review, settings) {
  const redacted = await withNumbers((numbers) => Redact.redact(review.transcript, settings.redactNames, numbers));
  return { transcript: redacted.text, transcript_edited: Boolean(review.edited),
           transcript_chars: { shown: review.shownChars ?? null, kept: review.transcript.length } };
}

// ---------------- the follow-up (0.6.9): did they decide, did they act, how did it turn out ----------------
// From followupSeconds after the request (lib/modes.js followupStage), a small pop-up on a page of a chat
// site asks about one conversation at a time: "Did you make a decision yet?" (not yet: again two days
// later), then "Did you act on this decision yet?" (not yet: when do you plan to?). Once the outcome
// questions are ready it offers the outcomes page, which lists every conversation whose follow-up is not
// done, oldest first, with the same questions; "too early to tell" there puts them off by two days (0.6.14),
// until the study's last week, when they are due. While anything waits on that page, a notification reminds
// of it every outcomesReminderDays.

// A day of the participant's study period: `days` after they joined (lib/modes.js studyDay; Infinity while
// that is not known, so nothing that counts the study's weeks happens then)
async function studyDay(days) {
  return Modes.studyDay({ pastBefore: await load("pastBefore"), joinedAt: await load("joinedAt") }, days);
}
// When the participant's study period ends
async function studyEnd() {
  return studyDay(STUDY_CONFIG.studyDays);
}

// The follow-up's stage changes with time: when it begins, at nextAt and dueAt, in the study's last week. An
// alarm at the next of these updates the badge (the question itself comes at the next page the participant opens).
async function armFollowup(id) {
  const checkin = (await load(`episode:${id}`))?.checkin, now = Date.now();
  const times = checkin && !checkin.doneAt ? [checkin.askFrom, checkin.nextAt, checkin.dueAt, Modes.lastCall(checkin, await studyEnd())] : [];
  const later = times.filter((at) => Number.isFinite(at) && at > now);
  if (later.length) chrome.alarms.create(`checkin|${id}`, { when: Math.min(...later) });
  else chrome.alarms.clear(`checkin|${id}`);
}

// The participant is in the middle of a conversation on this page: they sent something there, or the page
// changed (an answer being written), within BUSY_PAGE_MS (the log of sends stays when a chat that is not
// advice lets go of its copy)
// NOTE: [design thought] (0.6.18) an advice episode open in the chat no longer counts by itself: an episode
// stays open up to a week, and a participant who stayed in its chat never got an invitation or a follow-up
// there. Its own questions still come first: a page that shows one of the extension's windows refuses
// another (content/rating_panel.js popup)
async function busyOn(view, now) {
  const snapshot = await load(`snap:${view.key}`);
  const lastSent = ((await load(`sentlog:${view.key}`)) || []).at(-1)?.at ?? 0;
  return now < Math.max(snapshot?.changedAt ?? 0, lastSent) + BUSY_PAGE_MS;
}

// A page of a chat site that stays in front gets what a page coming to the front gets (onView): its site's
// next question about a conversation read from the site, else a follow-up question. Every minute (alarm
// hread), with the same pacing (INVITE_GAP_MS per site, FOLLOWUP_GAP_MS) and only once the participant has
// not typed there for BUSY_PAGE_MS (busyOn).
// NOTE: [design thought] (0.6.18) before, these came only when a page came to the front: a participant who
// stayed in one chat never got the question about a conversation from their phone (testers had to click on
// that conversation to see it)
async function offerOnFront() {
  const view = await load("lastView");
  if (!view) return;
  const tab = await chrome.tabs.get(view.tabId).catch(() => null);
  // (the tab the participant looked at last, still the one in front in its window, still on that site)
  if (!tab?.active || !tab.url || hostOf(tab.url) !== hostOf(view.url)) return;
  if (!(await offerQueued(view)) && !(await offerFollowup(view))) await offerOutcomesReminder(view);
}

// A follow-up question on the page the participant just opened (`view`): about the oldest conversation
// whose follow-up asks something now and was not on the screen in the last two days (as after "not yet").
// None while tracking is off, on an excluded site, while they are in the middle of a conversation there,
// or within FOLLOWUP_GAP_MS of the last one.
async function offerFollowup(view) {
  const settings = await getSettings(), now = Date.now();
  if (!view?.url || trackingOff(settings) || excluded(settings, view.url) || (await busyOn(view, now))) return false;
  if (now < ((await load("followupOfferedAt")) ?? 0) + FOLLOWUP_GAP_MS) return false;
  const end = await studyEnd();
  const waiting = (await loadAll("episode:")).map(([, record]) => record).filter((record) => Modes.followupAsks(Modes.followupStage(record, now, end)));
  const due = waiting.filter((record) => now >= (record.checkin.shownAt ?? 0) + Modes.ASK_AGAIN_DAYS * DAY_MS).sort((a, b) => a.openedAt - b.openedAt);
  if (!due.length) return false;
  const record = due[0];
  // NOTE: [design thought] the conversation is named by the participant's own one-sentence summary (their
  // answer "what decision were you asking about?"), and only on a page of its own site: the page of another
  // chat company gets the site and the date alone, as every question about another site
  // (`final`: the study's last week, when the outcome questions are due and "too early to tell" no longer puts them off)
  const item = { id: record.id, site: record.site, openedAt: record.openedAt, stage: Modes.followupStage(record, now, end),
                 final: Modes.finalCall(record.checkin, now, end),
                 summary: view.site === record.site ? record.answers?.decision || "" : "", more: waiting.length - 1 };
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(view.tabId, { type: "offer_followup", item, settings: panelSettings(settings) });
  } catch (error) { /* tab closed, or a page without the content script */ }
  if (!response?.shown) return false;
  await save("followupOfferedAt", now);
  return true;
}

// The follow-up pop-up was on the screen: it counts as that conversation's question for the next two days
async function onFollowupSeen(message) {
  await updateEpisode(message.id, (current) => (current.checkin
    ? { ...current, checkin: { ...current.checkin, shownAt: Date.now(), shown: (current.checkin.shown ?? 0) + 1 } } : current));
  await count("asked_followup");
}

// An answer to a follow-up question, from the pop-up or the outcomes page (`where`): the follow-up goes on as
// lib/modes.js followupAnswer says, the caller hears the stage after it (the pop-up's next step), and the
// answer is uploaded (how long an advice conversation takes to turn into a decision is one of the pilot's
// questions). An answer to a question no longer open (answered meanwhile elsewhere) changes nothing.
async function onFollowupAnswer(message, reply) {
  const now = Date.now(), end = await studyEnd();
  let taken = false;
  const record = await updateEpisode(message.id, (current) => {
    const checkin = Modes.followupAnswer(current, message.step, message.answer, now, end);
    if (!checkin) return current;
    taken = true;
    return { ...current, checkin };
  });
  const stage = record ? Modes.followupStage(record, now, end) : null;
  reply({ stage, nextAt: record?.checkin?.nextAt ?? null });
  if (!taken) return;
  await armFollowup(record.id);
  await updateBadge();
  await count(`followup_${message.step}_${message.answer}`);
  await upload("followup", { episode: record.id, site: record.site, source: record.source ?? "web", mode: record.mode, step: message.step,
                             answer: message.answer, where: message.where, stage, days_since_request: Math.round(((now - record.openedAt) / DAY_MS) * 10) / 10,
                             next_at: record.checkin.nextAt ?? null, planned_at: record.checkin.decision?.plannedAt ?? null,
                             due_at: record.checkin.dueAt ?? null, too_early: record.checkin.decision?.tooEarly ?? 0,
                             shown: record.checkin.shown ?? 0, study_end: Number.isFinite(end) ? end : null }, await getSettings());
}

// Every outcomesReminderDays while anything waits on the outcomes page: a follow-up that is not done (lib/modes.js
// followupOpen: not decided yet, decided and not acted on, the outcome questions, or "too early to tell") or a past
// conversation to annotate. A notification that opens the page, unless the participant had that page open within
// the last outcomesReminderDays; none once everything there is answered. (0.7) And a pop-up on the next chat page
// the participant opens or stays on (offerOutcomesReminder), once, for computers that do not show Chrome's
// notifications. Not a message from the study team (0.6.24 made it one): it bears on no payment.
// NOTE: [edge case callout] as the heartbeat's, the alarm is created only when missing and timed from the
// last check: created again at every browser start, it would never come for someone who closes Chrome daily
const OUTCOMES_REMINDER_DAYS = STUDY_CONFIG.outcomesReminderDays ?? 2;
async function keepOutcomesAlarm() {
  if (await chrome.alarms.get("outcomesReminder")) return;
  const period = OUTCOMES_REMINDER_DAYS * DAY_MS;
  chrome.alarms.create("outcomesReminder", { when: Math.max(((await load("outcomesCheckedAt")) ?? Date.now()) + period, Date.now() + 60000),
                                             periodInMinutes: period / 60000 });
}

// What waits on the Outcomes page: follow-ups not done, and past conversations to annotate
function outcomesWaiting(records, settings, now, end) {
  const followups = records.filter((record) => Modes.followupOpen(Modes.followupStage(record, now, end))).length;
  // (a past conversation waits while the page can ask about it: countQueued in ui/checkin.js)
  const past = records.filter((record) => record.source === "past" && kindOn(settings, record) && !excluded(settings, record.url) &&
                                          Modes.queueDue(record, now, settings.followupSeconds)).length;
  return { followups, past };
}

async function remindOutcomes() {
  const settings = await getSettings(), now = Date.now(), end = await studyEnd();
  await save("outcomesCheckedAt", now);
  if (!settings.participantId) return;
  const records = (await loadAll("episode:")).map(([, record]) => record);
  const { followups, past } = outcomesWaiting(records, settings, now, end);
  // (not when the participant opened the page within the last period: also right after the last reminder, and
  // not long ago when the alarm comes late, after Chrome was closed for days)
  if (!(followups + past) || now < ((await load("outcomesSeenAt")) ?? -Infinity) + OUTCOMES_REMINDER_DAYS * DAY_MS) return;
  // NOTE: [design thought] notifications never show conversation text (IRB protocol): the same words for every
  // follow-up, whatever its stage, and a count of the past conversations with the day they are due (the study's end)
  // NOTE: [design thought] the reminder says "due" only of what is due (0.6.15): the outcome questions are a due
  // task of the study's last week only (ui/rules.html), so before it the reminder asks without a deadline, and in
  // that week (the final call of a follow-up) it names the day; past conversations are due by the same day
  const day = Number.isFinite(end) ? new Date(end).toLocaleDateString(undefined, { month: "long", day: "numeric" }) : "";
  const finalWeek = day && records.some((record) => Modes.followupOpen(Modes.followupStage(record, now, end)) && Modes.finalCall(record.checkin, now, end));
  const asks = followups ? "Please check your Outcomes page for unanswered questions: Have you decided or acted? Did you get an outcome?" +
                           (finalWeek ? ` The outcome questions are due by ${day}, the end of your study.` : "") : "";
  const due = day ? ` (due by ${day})` : "";
  const pastAsks = past ? `${past === 1 ? "One past conversation waits" : `${past} past conversations wait`} for your answers ${followups ? "there too" : "on your Outcomes page"}${due}.` : "";
  chrome.notifications.create("outcomes", {
    type: "basic", iconUrl: "icons/icon128.png", title: "Advice Tracker: unanswered questions",
    message: [asks, pastAsks, "Click to open the page."].filter(Boolean).join(" "),
    requireInteraction: true,
  });
  await save("outcomesReminder", { id: `outcomes-${now.toString(36)}`, text: [asks, pastAsks].filter(Boolean).join(" "), at: now });
  await count("reminded_outcomes");
}

// (0.7) The reminder of the Outcomes page as a pop-up on the chat page the participant opens or stays on (as the
// follow-up's: not while tracking is off, on an excluded site, or while they are in the middle of a conversation
// there), once after each check; "Open the Outcomes page" opens it. Not once they opened that page since, or when
// nothing waits there any more.
async function offerOutcomesReminder(view) {
  const reminder = await load("outcomesReminder");
  if (!reminder) return false;
  const settings = await getSettings(), now = Date.now();
  if (!view?.url || trackingOff(settings) || excluded(settings, view.url) || (await busyOn(view, now))) return false;
  const { followups, past } = outcomesWaiting((await loadAll("episode:")).map(([, record]) => record), settings, now, await studyEnd());
  if (!(followups + past) || ((await load("outcomesSeenAt")) ?? -Infinity) >= reminder.at) {
    await remove("outcomesReminder");
    return false;
  }
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(view.tabId, { type: "offer_reminder", reminder: { id: reminder.id, text: reminder.text },
                                                           settings: panelSettings(settings) });
  } catch (error) { /* tab closed, or a page without the content script */ }
  if (!response?.shown) return false;
  await remove("outcomesReminder");                // (once: the next one comes with the next check)
  return true;
}

// The participant answered the pop-up: "open" opens the Outcomes page ("later", or "timeout" when it closed by itself)
async function onReminderAnswer(message) {
  await count(`outcomes_reminder_${message.answer}`);
  if (message.answer === "open") openOutcomes("");
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
  chrome.notifications.clear(`rate|${id}`);
  // one found among conversations read from the site, or held by the walk, is not asked about again
  // if found again
  if (gone.source === "app" || gone.source === "past" || gone.heldBy) await rememberDecided(id);
  if (gone.status === "open") { if (ownText(gone)) { kickHistory(); settleHanded(); } else advance(gone.chatKey); }
  await updateBadge();
  return gone;
}

async function onNotAdvice(message) {
  const settings = await getSettings();
  // NOTE: [design thought] a conversation the participant labeled, Yes or No, goes to the study with
  // its label: the "No" takes the conversation too (from the turn taken as the advice request on,
  // redacted as with answers), so the study sees what the advice model took for advice and the
  // participant did not. Read before the record goes: an open web episode's text is its chat's
  // snapshot, which settling drops once the episode is removed. The same rules as with answers
  // apply: nothing of an excluded site, or of an episode whose text stays (lib/questions.js).
  const before = await load(`episode:${message.id}`);
  const conversation = before && before.status !== "removed" ? await transcript(before, before.end, settings) : null;
  const gone = await removeEpisode(message.id);
  if (!gone) return;
  await serialized("queue", async () => save("queue", ((await load("queue")) || []).filter((event) => event.payload.episode !== gone.id)));
  await count("not_advice");
  await upload("not_advice", { episode: gone.id, site: gone.site, source: gone.source ?? "web", mode: gone.mode, turns: gone.end - gone.start + 1,
                               opening_turn: gone.opening - gone.start + 1, open: gone.status === "open",
                               closed_by: gone.closedBy, had_answers: Boolean(gone.answers),
                               ...(gone.source === "past" ? { fingerprint: fingerprint(gone), opened_at: gone.openedAt } : {}),
                               transcript: conversation?.messages ?? null, redacted: conversation?.counts ?? null }, settings);
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

// The update pop-up's outcome: yes (the panel opened on the page), no, no answer in time,
// superseded (a ratings page took its place), or withdrawn (dealt with elsewhere: withdrawOffers).
async function onUpdateAnswer(message) {
  const record = await load(`episode:${message.id}`);
  await count(`update_${message.answer}`);
  // (0.6.18) No: the answers still hold for the conversation as the pop-up (or the Quick check-ins page) asked about
  // it, through turn `end`: the update is not listed any more (lib/modes.js updateMissed), until new input comes and
  // the next update is offered
  if (record && message.answer === "no") {
    await updateEpisode(message.id, (current) => ({ ...current, updateDeclinedEnd: Math.max(current.updateDeclinedEnd ?? 0, pageEnd(current, message)) }));
  }
  if (record) {
    // (where: the pop-up on a chat page, or the card on the Quick check-ins page, 0.6.18)
    await upload("prompt", { episode: record.id, source: record.source ?? "web", mode: record.mode, prompt: "update", answer: message.answer,
                             where: message.where ?? "popup", turns: record.end - record.start + 1 }, await getSettings());
  }
  await updateBadge();
}

// The confirm pop-up's outcome (combined mode): yes, no, no answer in time, superseded (a
// ratings page took its place, and asks the question itself), or withdrawn (dealt with elsewhere).
// Yes spares the later ratings page
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

// The extension icon shows how many questions wait: ratings pages (lib/modes.js `waiting`), updates the
// participant was offered and did not give (`updateMissed`, 0.6.18) and follow-up questions (did you
// decide, did you act, the outcome questions).
async function updateBadge() {
  const now = Date.now(), end = await studyEnd();
  const settings = await getSettings();
  // (a queued question whose kind is off, or whose site is excluded, cannot be asked: it does not count)
  const askable = (record) => !Modes.viaQueue(record) || (kindOn(settings, record) && !excluded(settings, record.url));
  // (and the messages from the study team that are not read yet, 0.6.15)
  const waiting = (await loadAll("episode:")).filter(([, record]) => (Modes.waiting(record) && askable(record)) || Modes.updateMissed(record) ||
                                                                      Modes.followupAsks(Modes.followupStage(record, now, end))).length +
                  ((await load("teamMessages")) || []).filter((message) => !message.readAt).length;
  await chrome.action.setBadgeText({ text: waiting ? String(waiting) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#4f5bd5" });
}

// A question nobody answered QUESTION_EXPIRE_DAYS after the episode's first request (the day of its
// check-in before 0.6.9) is dropped: an ended episode never answered goes (with its text), and final
// answers that never came leave the earlier ones as the final ones (its follow-up then begins).
async function expireWaiting() {
  const limit = Date.now() - QUESTION_EXPIRE_DAYS * DAY_MS;
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

// ---------------- conversations read from the site itself (0.6) ----------------
// While tracking is on, the worker reads the participant's conversation list (for their conversations on
// other devices since joining, always since 0.6.11, and their past ones if they agreed to it on the settings
// page) and, one at a time, the conversations that changed, through a
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
const PAST_EXPIRE_DAYS = 42;           // a past episode never answered goes this long after it was found (after the study's end, when they are due)
const READ_TRIES_MAX = 5;              // a conversation that fails to read this often is left until it changes on the site
const JUDGE_TRIES_MAX = 5;             // a turn the judge refuses (or fails on) this often counts as not judged by the walk
const YOUNG_TURN_MS = 5 * 60000;       // a turn this young may still prove to be sent on the web (its snapshot is on its way)
const LIVE_WAIT_MS = 2 * 60000;        // a web turn after turns from elsewhere waits for the walk while it gets on (each step within this) ...
const LIVE_WAIT_MAX_MS = 15 * 60000;   // ... this long at most
const WEB_WAIT_MS = 5 * 60000;         // ... and the walk this long for the web page to take the episode over
const HISTORY_SUBMIT_GAP_MS = 15000, HISTORY_DAILY_MAX = 200, JUDGE_QUEUE_BUSY = 2;
const INVITE_GAP_MS = 4 * 3600 * 1000, PAST_INVITES_A_DAY = 2, PAST_MISSES_MAX = 3, BUSY_PAGE_MS = 5 * 60000;    // (a day: any 24 hours)
const PAST_ASK_RETRY_MINUTES = 10;     // GET /past not answered yet: asked again, and past turns wait, this long
// Reading, judging and asking about conversations read from a site happen only while tracking is on
// (participant ID set, not paused) and the site is not excluded.
const historyAllowed = (settings, host) => !trackingOff(settings) && !excluded(settings, `https://${host}/`);
const hostOf = (url) => new URL(url).hostname;
const epochNow = async () => (await load("historyEpoch")) || 0;
async function loadText(key) { return (await chrome.storage.session.get(`htext:${key}`))[`htext:${key}`]; }
async function waitingTexts() { return Object.keys(await chrome.storage.session.get(null)).filter((name) => name.startsWith("htext:")); }
// whether an episode's kind is asked about: one found among past turns only while past conversations are
// read (the only switch); those from other devices and the web's always
const kindOn = (settings, record) => record.source !== "past" || Boolean(settings.readPast);
// the episode's key for the study team, to pay each past conversation once: its chat, its request's
// turn and the site's time of it (no hash of any text: it could be checked against guesses)
const fingerprint = (record) => `${Episodes.hash(record.chatKey)}-${record.opening}-${(record.openedAt || 0).toString(36)}`;
// the conversation a fingerprint names: its chat's hash (hexadecimal, so without "-"). The limit counts
// conversations, and one is annotated once, whichever of its turns an install took for the request.
const conversationOf = (print) => String(print).split("-")[0];

// What may be read of `host` now (lib/history.js windows)
async function historyWindows(host, settings) {
  const joinedAt = await load("joinedAt");
  const windows = History.windows({ host, joinedAt, pastBefore: (await load("pastBefore")) ?? joinedAt, floor: (await load("deletedAt")) || 0,
                                    appsFrom: (await load("appsFrom")) || 0, trackingLog: (await load("trackingLog")) || [],
                                    aliveLog: (await load("aliveLog")) || [], now: Date.now(), lookbackDays: STUDY_CONFIG.pastLookbackDays,
                                    readPast: settings.readPast });
  // (the gaps of the part of the extension's own log that was dropped as it grew)
  return { ...windows, off: [...windows.off, ...((await load("aliveGaps")) || [])] };
}

// ---- reading ----
// Every minute (alarm hread): one request to one site, if one is due.
// NOTE: [design thought] one conversation at a time: no other conversation is read while one waits to
// be judged (the storage and the judge stay small), except one a web page waits for; the list's
// first page (no text) is refreshed meanwhile
async function historyTick() {
  const settings = await getSettings();
  if (trackingOff(settings) || !(await load("joinedAt"))) return;
  // the past conversations this participant ID annotated on any install (checkPastAnnotated): asked again every
  // hour while past conversations are read, and every few minutes until the study server answered once
  // (when the participant joined is asked with it until the server answered: past turns wait for both)
  const pastWait = (await load("pastAnnotated")) === undefined || !(await load("joinedChecked")) ? PAST_ASK_RETRY_MINUTES * 60000 : 3600 * 1000;
  if (settings.readPast && Date.now() >= ((await load("pastAskedAt")) ?? 0) + pastWait) {
    await checkJoined(settings);
    await checkPastAnnotated(settings);
  }
  if ((await waitingTexts()).length > 0) kickHistory();
  const config = (await load("hconfig")) || {};
  // NOTE: [design thought] (0.6.18) one request a minute to each site at most (before, one in all): the site
  // first in the list took every minute it had something to do (its list, then each of its chats that
  // changed), and a conversation from the phone on another site waited. A conversation is still read only
  // while none waits to be judged, so the site that read one longest ago goes first (readAt).
  const sites = [];
  for (const host of HISTORY_SITES) {
    if (historyAllowed(settings, host) && config.history?.[host] !== false) sites.push({ host, readAt: ((await load(`hstate:${host}`)) || {}).readAt ?? 0 });
  }
  sites.sort((a, b) => a.readAt - b.readAt);
  for (const { host } of sites) {
    const state = (await load(`hstate:${host}`)) || {};
    await historyStep(host, settings, state, (await waitingTexts()).length > 0);
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
  const next = busy ? null : await nextToRead(host, list, windows, settings);
  const since = settings.readPast ? windows.pastFrom : windows.appFrom;
  const olderDue = !busy && !list.end && (list.reached ?? Infinity) > since;
  // NOTE: [design thought] (0.6.18, 0.6.19) right after a refresh of the list, what else waits goes first: a
  // conversation to read, or an older page of the list. With a short time between refreshes (a test) the
  // refresh came every minute, between reads, and the pages after the first were never reached
  const otherFirst = state.lastWhat === "refresh" && (Boolean(next) || olderDue);
  if (state.priority) request = { what: "read", id: state.priority, listedU: listedU(state.priority), reason: "asked" };
  else if (!otherFirst && now - list.listedAt >= LIST_EVERY_MS) request = { what: "list", cursor: null, refresh: true };
  else if (!otherFirst && list.refresh !== null && list.refresh !== undefined) request = { what: "list", cursor: list.refresh, refresh: true };
  else if (next) request = { what: "read", id: next.id, listedU: listedU(next.id), reason: next.reason };
  else if (olderDue) request = { what: "list", cursor: list.cursor };
  if (!request) return false;
  // (lastWhat: "refresh", "list" (an older page) or "read"; readAt: when this site last read a conversation; both
  // for the order above and in historyTick)
  await save(`hstate:${host}`, { ...state, priority: request.reason === "asked" ? null : state.priority ?? null,
                                 lastWhat: request.refresh ? "refresh" : request.what, readAt: request.what === "read" ? now : state.readAt ?? 0 });
  const epoch = await epochNow();
  // NOTE: [design thought] (0.6.24) the site is read with one account (historyReply), and its tabs can show others (a
  // second Google account in its own tab, say). Each tab is told which account that is: a tab of another account
  // answers so without reading anything (content/history.js), and the next tab is asked. Before, the first tab that
  // answered was used, and when it showed another account, reading the site stopped for an hour, also with a tab of
  // the right account open.
  const bound = await load(`haccount:${host}`);
  let reply = null, other = null;
  for (const tab of tabs) {
    const answer = await Promise.race([chrome.tabs.sendMessage(tab.id, { type: "history_fetch", ...request, windows, account: bound ?? null }).catch(() => null),
                                       new Promise((resolve) => setTimeout(() => resolve(null), ANSWER_WAIT_MS))]);
    // (also a tab from before 0.6.24, which reads with any account: what it read is not used)
    if (answer?.ok && bound && answer.accountKnown && answer.account !== bound) { other = answer; continue; }
    if (answer) { reply = answer; break; }
  }
  // (no tab of the account read here: the other account's answer stops the site's reading a while, historyReply)
  reply = reply ?? other;
  // switched off, deleted or paused meanwhile: what came back is dropped
  if ((await epochNow()) !== epoch || !historyAllowed(await getSettings(), host)) return true;
  await historyReply(host, request, reply);
  // (a chat page that waits for the walk is looked at again at once when the read failed or the site's reading
  // stopped: it then goes on without waiting any longer, takeFromElsewhere)
  const after = (await load(`hstate:${host}`)) || {};
  if (!reply?.ok || after.blocked || (after.waitUntil ?? 0) > Date.now()) {
    for (const [, chat] of await loadAll("chat:")) if (chat.waitedSince && chat.key?.startsWith(`${host}/`)) advance(chat.key);
  }
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
  const changed = list.items.find((item) => item.u >= windows.appFrom && !waits(known.get(item.id), item));
  if (changed) return { id: changed.id, reason: "app" };
  if (!settings.readPast || !(await load("joinedChecked")) || (await pastLeft()) <= 0 ||
      [...known.values()].filter((hist) => hist.pastRead).length >= PAST_SCAN_MAX) return null;
  const past = list.items.find((item) => (item.c ?? item.u) < windows.pastBefore && item.u >= windows.pastFrom &&
                                         (!known.has(item.id) || (!known.get(item.id).judge && !waits(known.get(item.id), item))));
  return past ? { id: past.id, reason: "past" } : null;
}

// How many more past conversations may be found: at most pastLimit waiting or annotated (skipped ones
// and "No" do not count), on this computer or, under the same participant ID, on any other install
// (the study server's list: checkPastAnnotated). A conversation counts once, whichever of its turns was
// taken for its request (conversationOf). None until the server answered: not in a past-only read, nor
// among the past turns of a conversation read for its turns from other devices.
async function pastLeft() {
  const elsewhere = await load("pastAnnotated");
  if (elsewhere === undefined) return 0;
  const here = (await loadAll("episode:")).map(([, record]) => record)
    .filter((record) => record.source === "past" && record.status !== "removed").map(fingerprint);
  return STUDY_CONFIG.pastLimit - new Set([...here, ...elsewhere].map(conversationOf)).size;
}

// What the tab answered. For the list, the site's own pauses are kept: 429 (it asked to wait: from 30
// minutes up to 6 hours, doubling), 401 (signed out, after one new token: an hour), 403 or a page
// instead of data (blocked: nothing until the browser starts again); no answer or another error: 10
// minutes. For one conversation, a failure is that conversation's (tried again later, at most
// READ_TRIES_MAX times), and 404 means it is gone. The site is read for one account only: the first
// one read; when no tab shows it, the site waits OTHER_ACCOUNT_WAIT_MS (an hour before 0.6.24: closing the
// other account's tab did not bring the reading back sooner).
const OTHER_ACCOUNT_WAIT_MS = 5 * 60000;
async function historyReply(host, request, reply) {
  const state = (await load(`hstate:${host}`)) || {};
  const now = Date.now();
  const pause = (ms, extra = {}) => save(`hstate:${host}`, { ...state, waitUntil: now + ms, ...extra });
  const key = `${host}/${request.id}`;
  if (!reply?.ok && request.what === "read" && reply?.status !== 429) {
    // NOTE: [edge case callout] a conversation is gone only when the site's reader says so (reply.gone,
    // below: each reader knows what its site counts as deleted); a 404 it throws (an edge page, a
    // workspace no longer reachable) is a failure of this read, which must not delete what was found
    if (reply?.status === 401) return pause(3600 * 1000, { signedOut: true });
    // NOTE: [edge case callout] one conversation that cannot be read (an error of the site's for it, a
    // reader that trips over it, an answer too slow) must not stop the others
    return serialized(`hist:${key}`, async () => {
      const hist = (await load(`hist:${key}`)) || { key, id: request.id, host, turns: [], ids: [], judge: null };
      const failures = hist.failedU === request.listedU ? (hist.failures || 0) + 1 : 1;
      await save(`hist:${key}`, { ...hist, failedU: request.listedU, failures, failedAt: now, retryAt: now + 10 * 60000 * 2 ** (failures - 1) });
    });
  }
  // (noAnswer: the page stayed silent, usually a tab from before the install or an update that has no
  // content script; kept past the pause, so the check-in page keeps asking for a refresh until a tab answers)
  if (!reply) return pause(10 * 60000, { noAnswer: true });
  if (!reply.ok) {
    if (reply.status === 429) {
      const wait = Math.min(Math.max(state.backoffMs ? 2 * state.backoffMs : 30 * 60000, reply.retryAfterMs ?? 0), 6 * 3600 * 1000);
      return pause(wait, { backoffMs: wait });
    }
    if (reply.status === 401) return pause(3600 * 1000, { signedOut: true });
    if (reply.status === 403 || reply.blocked) return save(`hstate:${host}`, { ...state, blocked: true });
    return pause(10 * 60000);
  }
  // NOTE: [design thought] only the account first read after the participant agreed is read, a
  // personal one or a work, school or team one alike (since 0.6.6), never another one later (a family
  // member's, or the participant's other account or workspace: each has its own conversation list,
  // and the walk keeps one per site). For a site whose reader cannot say which account is signed in
  // (Grok), one account in this browser is assumed, under this install's own code; a list page that
  // looks like another account's (sameAccount) pauses it
  const bound = await load(`haccount:${host}`);
  const account = reply.account ?? (reply.accountKnown === false ? `assumed-${await load("installId")}` : null);
  if (!account || (bound && bound !== account)) return pause(OTHER_ACCOUNT_WAIT_MS, { otherAccount: true });
  if (request.what === "list" && reply.accountKnown === false && !(await sameAccount(host, reply.page))) return pause(3600 * 1000, { otherAccount: true });
  if (!bound) await save(`haccount:${host}`, account);
  await save(`hstate:${host}`, { ...state, backoffMs: 0, signedOut: false, otherAccount: false, noAnswer: false, waitUntil: 0 });
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
    // NOTE: [edge case callout] a page of a refresh can repeat items of the page before it (Claude's
    // pages overlap by a few chats; an offset list shifts when a chat moves up): those were new or
    // changed when that page came (else the refresh would have stopped), so they count as such again
    const inRefresh = new Set(request.refresh && request.cursor !== null ? list.refreshSeen || [] : []);
    const unseen = page.items.filter((item) => byId.get(item.id)?.u !== item.updatedAt || inRefresh.has(item.id));
    for (const item of page.items) byId.set(item.id, { id: item.id, u: item.updatedAt, c: item.createdAt ?? null });
    const regular = page.items.filter((item) => !item.pinned && Number.isFinite(item.updatedAt)).map((item) => item.updatedAt);
    const oldest = regular.length ? Math.min(...regular) : null;
    const next = { ...list, items: [...byId.values()].sort((a, b) => b.u - a.u).slice(0, 3000) };
    if (request.refresh) {
      if (request.cursor === null) next.listedAt = Date.now();
      // (the first refresh also starts the walk back)
      if (!list.listedAt) Object.assign(next, { cursor: page.next ?? null, end: !page.next });
      next.refresh = list.listedAt && page.next && unseen.length === page.items.length ? page.next : null;
      next.refreshSeen = next.refresh !== null ? [...inRefresh, ...page.items.map((item) => item.id)].slice(-1000) : [];
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
    const { failedU, failures, failedAt, retryAt, gone, tooLong, ...kept } = before || {};
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
    if (owner === "app") await noteMessage(at);            // (a message sent on another device: a time, as on the web)
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
      const cut = await cutOf(judge.openedAt, settings);
      if (at >= cut || at - hist.turns[turn - 2].at > settings.endQuietMinutes * 60000) {
        await store(closeHistory(judge, at >= cut ? "cut" : "quiet"));
        continue;
      }
    } else {
      // NOTE: [edge case callout] how many past conversations may still be found is known only once the study
      // server said which ones the participant ID annotated (checkPastAnnotated, asked by historyTick): until
      // then a past turn waits, asked again in a few minutes, rather than being passed over for good
      // (and once it said when the participant joined: before that, turns of their study weeks on an earlier
      // install could count as past ones, checkJoined)
      if (owner === "past" && !hist.pastFound && (hist.pastJudged || 0) < PAST_TURNS_JUDGED &&
          ((await load("pastAnnotated")) === undefined || !(await load("joinedChecked")))) {
        chrome.alarms.create(`hjudge|${key}`, { delayInMinutes: PAST_ASK_RETRY_MINUTES });
        return;
      }
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
      // new advice conversations are looked for in the study's first three weeks only, as on the web (settle):
      // a later turn from another device that no open episode takes is not judged
      if (owner === "app" && at >= await studyDay(NEW_ADVICE_DAYS)) {
        await store({ ...judge, judgedThrough: turn, segmentStart: turn + 1 });
        continue;
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
    // (the walk's chat key: the one its episodes' ids start with, episodeId(hist.chat, ...))
    const id = await submit({ ...job, source: owner }, { site: hist.site, key: hist.chat }, settings);
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
  const cut = await cutOf(judge.openedAt, settings), quietAt = hist.turns[judge.end - 1].at + settings.endQuietMinutes * 60000;
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
    if (judge.pastPending) {
      // NOTE: [edge case callout] a past conversation this participant ID annotated already, on an earlier install
      // or another computer (the study server's list: checkPastAnnotated), is not asked about again, also not from
      // another of its turns (a judge that answers otherwise there); nor is one found here before (a walk that
      // started again: the switch was turned off and on). And the limit may have been reached while the
      // judgment was on its way (another install's annotations came meanwhile): then nothing more is found.
      const conversation = Episodes.hash(hist.chat);
      const annotated = ((await load("pastAnnotated")) || []).some((print) => conversationOf(print) === conversation);
      const foundBefore = (await loadAll("episode:")).some(([, other]) => other.source === "past" && other.chatKey === hist.chat &&
                                                                         other.status !== "removed");
      if (annotated || foundBefore) { await rememberDecided(judge.episodeId); return letGo; }
      if ((await pastLeft()) <= 0) return letGo;
    }
    if (!page || !historyAllowed(settings, hist.host)) return judge;
    const source = judge.pastPending ? "past" : "app";
    const openingText = page.userTurns[judge.opening - 1] || "";
    const fresh = {
      id: judge.episodeId, chatKey: hist.chat, site: hist.site, url: hist.url, source, heldBy: "history", walk: hist.key,
      mode: source === "past" ? "past" : "combined", start: judge.segmentStart, opening: judge.opening, end: judge.end,
      openedAt: judge.openedAt, detectedAt: Date.now(), closedAt: null, closedBy: null, openingText,
      related: await relatedEpisodes(openingText, settings, judge.openedAt ?? Infinity), status: "open", answers: null, versions: 0, answeredEnd: null,
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
  const shift = snapshot ? Episodes.findOffset(chat?.ids || [], Episodes.turnIds(userTurns), Episodes.expectedOffset(chat, snapshot)) : -1;
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
    if (Date.now() >= await cutOf(record.openedAt, settings)) continue;
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
// goes quiet: it is handed to the walk instead of ending (its text from the
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
  chrome.alarms.create(`heldcut|${id}`, { when: Math.max(await cutOf(record.openedAt, await getSettings()), Date.now() + 60000) });
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
    if (Date.now() >= await cutOf(record.openedAt, settings)) await close(record.grew ? "cut" : "quiet");
    else if (Date.now() >= quietAt && !changed) await close("quiet");
  }
}

// Whether the walk cannot read the conversation at `url` now: the study team switched the site's reading
// off, the site's reading is stopped or paused (blocked, signed out, another account, a pause the site asked
// for, a tab that did not answer: historyReply), or a read of this conversation failed since `since`.
async function readingStalled(url, since) {
  const host = hostOf(url), id = SITE_CONFIGS[host]?.conversationId(new URL(url));
  if (!id || !HISTORY_SITES.includes(host) || ((await load("hconfig")) || {}).history?.[host] === false) return true;
  const state = (await load(`hstate:${host}`)) || {}, hist = await load(`hist:${host}/${id}`);
  return Boolean(state.blocked) || (state.waitUntil ?? 0) > Date.now() || (hist?.failedAt ?? -Infinity) >= since;
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
  if (!historyAllowed(settings, hostOf(snapshot.url)) || chat.state !== "searching" || turn !== chat.segmentStart ||
      turn < 2 || turn > userTurns.length) return proceed();
  const ids = Episodes.turnIds(userTurns), sent = new Set(snapshot.sent);
  if (sent.has(ids[turn - 2]) || !sent.has(ids[turn - 1])) return proceed();
  const hashes = userTurns.map(Episodes.looseHash);
  const hist = (await loadAll("hist:")).map(([, entry]) => entry).find((entry) => entry.chat === key && entry.judge);
  const index = hist ? hist.turns.map((entry) => entry.h).lastIndexOf(hashes[turn - 2]) : -1;
  if (!(index >= 0 && hist.judge.judgedThrough >= index + 1 && !hist.judge.pending)) {
    // NOTE: [design thought] the turn waits while the walk gets on with these turns (each new judgment
    // starts the wait again), at most LIVE_WAIT_MAX_MS in all; it goes on without them if the walk
    // makes no progress for LIVE_WAIT_MS, and at once if the walk cannot read this conversation now
    // (readingStalled: since 0.6.11 every install reads the sites, so a site whose reading stopped would
    // otherwise hold back the first message of every conversation continued there)
    const now = Date.now(), progress = hist?.judge?.judgedThrough ?? -1;
    if (await readingStalled(snapshot.url, chat.waitedSince ?? now)) return proceed();
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
    if (Date.now() >= await cutOf(record.openedAt, settings)) continue;
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
// Reading past conversations was turned on or off (the only switch since 0.6.11): the walk of every conversation
// that may hold a past turn starts again from scratch (records and the remembered decisions keep it from asking
// twice; an open episode such a walk held is taken up again by the new walk, or ends by itself: settleHanded),
// and site reads under way are dropped.
// NOTE: [thought process] (0.6.24) a conversation begun after joining (on the web or another device) holds no past
// turn, so the switch changes nothing in it: its walk is kept. Before 0.6.24 it was read and judged again too, and
// one answered No could come back as a new question: the walk lets the declined episode go at its first turn
// (hdone), and the search that starts again at the next turn can take that turn for a new request.
// NOTE: [edge case callout] that can still happen in a conversation begun before joining and continued after it.
// Turned off (`stopped`), each past episode found:
// - without answers goes (one the web page took over ends as "removed" through its chat);
// - with answers keeps them, but none of its text is sent any more (keepText).
async function historySwitched(stopped) {
  await serialized("historyEpoch", async () => save("historyEpoch", (await epochNow()) + 1));
  // (a turn before this time is past: lib/history.js windows; a conversation with no known creation time starts again)
  const joinedAt = await load("joinedAt");
  const pastBefore = Math.min((await load("pastBefore")) ?? joinedAt, joinedAt);
  const begunAfter = (hist) => hist.createdAt >= pastBefore && (hist.turns || []).every((turn) => !(turn.at < pastBefore));
  const restarted = new Set();
  for (const [name, hist] of await loadAll("hist:")) {
    if (begunAfter(hist)) continue;
    restarted.add(name.slice("hist:".length));
    await remove(name);
  }
  // (the list is listed again: a conversation whose walk is kept is not read again while its time on the list is the same)
  for (const [name] of await loadAll("hlist:")) await remove(name);
  for (const name of await waitingTexts()) if (restarted.has(name.slice("htext:".length))) await chrome.storage.session.remove(name);
  for (const [, record] of await loadAll("episode:")) {
    if (record.heldBy === "history" && record.walk && restarted.has(record.walk)) await updateEpisode(record.id, (current) => ({ ...current, walk: null }));
    if (!stopped || record.source !== "past") continue;
    if (!record.answers) {
      if (record.status === "open" && record.heldBy === "web") { await removeEpisode(record.id); continue; }
      await updateEpisode(record.id, () => null);
      for (const alarm of ["pause", "ask", "remind", "checkin", "heldcut"]) chrome.alarms.clear(`${alarm}|${record.id}`);
      continue;
    }
    if (record.status === "open" && record.heldBy !== "web") {
      await episodeClosed({ id: record.id, start: record.start, opening: record.opening, end: record.end, closedBy: "stopped",
                            openedAt: record.openedAt }, null);
    }
    await updateEpisode(record.id, (current) => ({ ...withoutText(current), keepText: true, finalDue: false }));
  }
  await settleHanded();
  await updateBadge();
}

// The participant agreed to (or stopped) reading their past conversations: recorded for the study team,
// with the version of the text they agreed to. (Other devices have no switch since 0.6.11: no consent of
// their own; read_apps stays in the status reports, always true.)
async function consentChanged(before, after, settings) {
  if (Boolean(before.readPast) === Boolean(after.readPast)) return;
  await upload("consent", { feature: "read_past", accepted: Boolean(after.readPast), version: STUDY_CONFIG.historyConsentVersion }, settings);
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
  // not while the participant is in the middle of a conversation here
  if (await busyOn(view, now)) return false;
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
                   openedAt: item.record.openedAt, reward: STUDY_CONFIG.pastReward, pastLimit: STUDY_CONFIG.pastLimit,
                   dueBy: Number.isFinite(await studyEnd()) ? await studyEnd() : null };      // (past conversations are due by the study's end)
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(view.tabId, { type: "offer_invite", invite, settings: panelSettings(settings) });
  } catch (error) { /* tab closed, or a page without the content script */ }
  if (!response?.shown) return false;
  await keepOffer(item.record.id, view.tabId, item.record);
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
    message: `A conversation on ${record.site} looked like a request for advice. Click to answer a few questions (about 1 to 2 minutes).`,
  });
  await save(`qstate:${record.site}`, { ...queue, notifiedAt: now, current: record.id });
  await count("asked_notification");
  return true;
}

// The invitation's outcome: open (the extension tab opens), later or timeout (the next one comes after
// INVITE_GAP_MS; for a past one, a miss), stop (no more past conversations: readPast off), superseded,
// or withdrawn (answered elsewhere: not a miss)
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
  // (an invitation answered elsewhere meanwhile, with nothing new since, opens the list instead)
  if (message.answer === "open") {
    const query = record && Modes.stillDue(record) ? `?item=${encodeURIComponent(message.id)}` : "";
    if (record?.source === "past") openOutcomes(query); else openCheckin(query);
  }
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
  // NOTE: [edge case callout] before the participant annotates a past conversation, the study server is asked again
  // which ones this participant ID annotated: since the hourly ask, another computer's annotations may have used up
  // the limit, or annotated this conversation (checkPastAnnotated then drops it, and the page says so)
  if (message.answer === "yes" && record.source === "past") await checkPastAnnotated(await getSettings());
  if (message.answer === "no") await onNotAdvice(message);
  if (message.answer === "skip") await onPastSkipped(message);
  if (message.answer !== "yes") await serialized(`qstate:${record.site}`, async () => {
    const queue = (await load(`qstate:${record.site}`)) || {};
    await save(`qstate:${record.site}`, { ...queue, pastMisses: message.answer === "skip" ? (queue.pastMisses ?? 0) + 1 : queue.pastMisses ?? 0 });
  });
}

// The past conversation's questions are answered: they go with its conversation (from the advice
// request on, redacted), and the record lets go of the text. Returns whether the answers were taken (not
// when the past conversation went meanwhile: annotated elsewhere or over the limit, checkPastAnnotated; or
// was answered already, in another tab).
async function onPastSubmitted(message) {
  let answered = null;
  await updateEpisode(message.id, (current) => {
    if (current.source !== "past" || current.answers || current.status !== "pending") return current;
    // (answerTiming: how long the form took, lib/questions.js timing; it goes with the annotation)
    // (review, 0.6.16: the conversation as the participant left it in the card's review box, kept with the
    // answers until the annotation is queued, so a browser that quits in between does not lose it)
    answered = { ...current, answers: message.answers, answerTiming: message.timing ?? null, versions: 1, answeredEnd: current.end,
                 confirmedAt: current.confirmedAt ?? Date.now(),
                 ...(typeof message.transcript === "string" ? { review: { transcript: message.transcript, edited: message.edited, shownChars: message.shownChars } } : {}) };
    return answered;
  });
  if (!answered) return false;
  await finishPastAnnotation(answered.id);
  return true;
}

// An annotated past episode (its answers saved) is finished: its annotation, with its conversation, goes into
// the upload queue first, then the record lets go of its text, then the queue is sent.
// NOTE: [edge case callout] queued before it is sent: the annotation exists nowhere else, so a browser that quits
// while it is on its way must not lose it (the study pays by the server's list). One that a quit left half done
// (answers saved, not queued or not yet done) is finished at the next start (resumeAll); the queue's check keeps
// it from going twice from here (a resend after a lost answer from the server is possible: the server's list is a set).
async function finishPastAnnotation(id) {
  const settings = await getSettings();
  const record = await load(`episode:${id}`);
  if (!record || record.source !== "past" || !record.answers || record.status !== "pending") return;
  const conversation = await transcript(record, record.end, settings);
  // (0.6.16) the conversation as the participant left it in the card's review box. One they changed goes as they
  // left it, as a text (`transcript_reviewed`), and the automatic one (`transcript`, the list of messages) does
  // not go: for a past conversation nothing was sent before, so what they deleted never leaves the computer.
  // One they left as it was goes as before. (None where the conversation does not go at all: an excluded site.)
  const review = conversation && record.review ? await reviewedTranscript(record.review, settings) : null;
  const event = { type: "past_annotation", participant_id: settings.participantId, sent_at: Date.now(), payload: {
    episode: record.id, fingerprint: fingerprint(record), site: record.site, source: "past", opened_at: record.openedAt,
    conversation_created_at: record.conversationCreatedAt ?? null, detected_at: record.detectedAt,
    days_since: Math.round((Date.now() - record.openedAt) / DAY_MS), turns: record.end - record.start + 1,
    opening_turn: record.opening - record.start + 1, answers: await redactAnswers(record.answers, settings.redactNames),
    timing: record.answerTiming ?? null,
    related_earlier: record.related.length, transcript: review?.transcript_edited ? null : conversation?.messages ?? null,
    redacted: conversation?.counts ?? null,
    ...(review ? { transcript_edited: review.transcript_edited, transcript_chars: review.transcript_chars,
                   ...(review.transcript_edited ? { transcript_reviewed: review.transcript } : {}) } : {}),
    ...(await studyClock()),
  } };
  const started = generation;
  await serialized("queue", async () => {
    const queue = (await load("queue")) || [];
    // ("delete all data" began meanwhile: nothing goes; queued already by a run that was cut short: once)
    if (started !== generation || queue.some((other) => other.type === "past_annotation" && other.payload.episode === id)) return;
    await save("queue", [...queue, event]);
  });
  let finished = false;
  await updateEpisode(id, (current) => (current.answers && current.status === "pending" ? ((finished = true), doneRecord(current)) : current));
  if (finished) await count("past_annotated");
  await updateBadge();
  flushQueue();                                        // (not awaited: the page that sent the answers waits for none of it)
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
// NOTE: [edge case callout] nothing goes without a participant ID (the study server could not tie it to
// anyone): an event made then (a check-in answered after the ID was cleared on the settings page) waits
// in the queue, and goes with the ID once one is saved (flushQueue). Returns whether the event went now.
async function upload(type, payload, settings) {
  const started = generation;
  let event = { type, participant_id: settings.participantId, sent_at: Date.now(), payload };
  const outcome = settings.participantId ? await post(event, settings) : "failed";
  if (outcome === "sent") return true;
  if (outcome === "rejected") event = { ...event, rejections: 1 };
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
  return false;
}

// NOTE: [design thought] the server refused the event itself (400 bad request, 413 too large, 422 not
// valid): sent again unchanged, it is refused again. It is tried REJECTED_RETRIES more times (with the
// queue, every 30 minutes) and then dropped, so it does not go on every 30 minutes for good. Any other
// failure may pass later and is tried until it does: no network, the server down (5xx), the study key
// (401, 403) or the server's address (404) wrong until the settings are fixed, or a request to wait (408, 429).
const REJECTED_RETRIES = 2;
const refusesEvent = (status) => status >= 400 && status < 500 && ![401, 403, 404, 408, 429].includes(status);

// Post one event: "sent", "rejected" (refused for itself) or "failed" (to be tried again)
// NOTE: [edge case callout] half of an emoji (a lone UTF-16 surrogate) in any text, e.g. one a site cut, would make the
// study server refuse the event for good (it stores UTF-8): each string goes well-formed, the half replaced by U+FFFD
// (JSON.stringify calls the replacer for every value)
const wellFormed = (key, value) => (typeof value === "string" ? value.toWellFormed() : value);
async function post(event, settings) {
  try {
    const response = await fetch(`${settings.serverUrl}/events`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Study-Key": settings.studyKey },
      body: JSON.stringify(event, wellFormed), signal: AbortSignal.timeout(25000),
    });
    return response.ok ? "sent" : refusesEvent(response.status) ? "rejected" : "failed";
  } catch (error) {
    return "failed";
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
  // (also the conversation as reviewed on the outcomes page, 0.6.16: a check-in's `transcript`, a past one's `transcript_reviewed`)
  if ((event.payload.transcript || event.payload.transcript_reviewed) && excluded(settings, record.url)) {
    const { transcript_edited, transcript_reviewed, transcript_chars, ...payload } = event.payload;
    return { ...event, payload: { ...payload, transcript: null, redacted: null } };
  }
  return event;
}

async function flushQueue() {
  const settings = await getSettings();
  const started = generation;
  if (!settings.participantId) return;               // (upload: nothing goes without an ID)
  await serialized("queue", async () => {
    const remaining = [];
    for (const queued of (await load("queue")) || []) {
      if (started !== generation) return;            // "delete all data" meanwhile: nothing more goes out
      const found = await queuedEvent(queued);
      const event = found && found !== "wait" && !found.participant_id ? { ...found, participant_id: settings.participantId } : found;
      // (an event that waits, or could not go, stays as it may go now: without a conversation that stays)
      if (event === "wait") { remaining.push(queued); continue; }
      if (!event) continue;
      // (how often the server refused it is kept with it in the queue, not sent)
      const { rejections = 0, ...posted } = event;
      const outcome = await post(posted, settings);
      if (outcome === "failed") remaining.push(event);
      else if (outcome === "rejected" && rejections < REJECTED_RETRIES) remaining.push({ ...event, rejections: rejections + 1 });
      else if (outcome === "rejected") { await count("upload_rejected"); await count(`upload_rejected_${posted.type}`); }
    }
    if (started !== generation) return;
    await save("queue", remaining);
    if (remaining.length) chrome.alarms.create("flush", { delayInMinutes: 30 });
  });
}

// ---------------- is the extension tracking? (heartbeat, status, uninstall) ----------------
// The five chat sites, as the manifest lists them for the content script ("https://chatgpt.com/*", ...)
const STUDY_SITES = chrome.runtime.getManifest().content_scripts[0].matches.filter((match) => match.startsWith("https://"));

// What the study needs to know for each day (its rules count a pause of more than 24 hours, ui/rules.html):
// is tracking paused, and on which of the five sites can the extension capture? A site is lost when
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
           read_past: Boolean(settings.readPast), read_apps: true };
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
    // (0.6.9: how many follow-ups are at each stage, lib/modes.js followupStage)
    followup_stages: followupCounts(episodes, Date.now(), await studyEnd()),
    waiting_past: episodes.filter((episode) => episode.source === "past" && episode.status === "pending").length,
    // (0.6.14: when the participant last sent a message to an AI assistant, a time: the study's rules ask for
    // some use in every week, and from the end of week 3 on no message goes to the study server)
    last_message_at: (await load("lastMessageAt")) ?? null,
    // (0.6.15: how many messages from the study team wait here for the participant's OK)
    unread_messages: ((await load("teamMessages")) || []).filter((message) => !message.readAt).length,
    history: await historyStates(), ...(await studyClock()),
  }, settings);
  await save("heartbeatAt", Date.now());
  await noteAlive();
  await fetchStudyConfig(settings);
  await checkJoined(settings);
  await checkPastAnnotated(settings);
  await fetchTeamMessages(settings);
  await weekCheck();
}

function followupCounts(episodes, now, end) {
  const counts = {};
  for (const episode of episodes) {
    const stage = Modes.followupStage(episode, now, end);
    if (stage) counts[stage] = (counts[stage] || 0) + 1;
  }
  return counts;
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

// ---- reminders while tracking stays paused ----
// NOTE: [design thought] a pause is easy to forget, and the study's rules count it (the popup shows them
// before it pauses, ui/rules.html): under 12 hours nothing happens; from 12 hours on a reminder comes; after
// 24 hours the week's payment is reduced for the paused time; after a week participation ends. A notification
// comes pausedReminderHours after the pause began and at every full day of it (lib/modes.js pausedReminderAt),
// and says which of these holds; "Resume tracking" on it resumes. (0.6.24) It is a message (remindByMessage), shown on
// the chat pages (also while paused) and under the icon until OK, not a notification alone: a computer may not show
// Chrome's notifications. A newer one takes the place of one not read yet, and they go when tracking resumes.
// NOTE: [edge case callout] the alarm is created only when missing, timed from the pause's start and the last
// reminder (pausedRemindedAt): Chrome may drop alarms when it restarts, and a reminder that fell due while
// Chrome was closed comes a minute after its start instead of being skipped. It is cleared whenever tracking
// is not paused.
const PAUSED_REMINDER_HOURS = STUDY_CONFIG.pausedReminderHours ?? 12;
async function keepPausedReminder() {
  const settings = await getSettings();
  if (!settings.paused || !settings.participantId) {
    await chrome.alarms.clear("pausedReminder");
    chrome.notifications.clear("paused");              // (a reminder from before 0.6.24)
    await withdrawReminders("paused");
    return;
  }
  if (await chrome.alarms.get("pausedReminder")) return;
  const since = settings.pausedAt || Date.now();
  // (a reminder of an earlier pause does not count for this one)
  const reminded = Math.max((await load("pausedRemindedAt")) ?? 0, since);
  chrome.alarms.create("pausedReminder", { when: Math.max(Modes.pausedReminderAt(since, reminded, PAUSED_REMINDER_HOURS), Date.now() + 60000) });
}

async function remindPaused() {
  const settings = await getSettings();
  if (!settings.paused) return keepPausedReminder();          // resumed meanwhile: the alarm goes
  const now = Date.now(), hours = (now - (settings.pausedAt || now)) / 3600000;
  const ago = hours < 48 ? `${Math.max(1, Math.round(hours))} hours` : `${Math.round(hours / 24)} days`;
  const rule = hours < 24 ? "Your payment is not affected yet: a pause of more than 24 hours reduces this week's payment."
    : hours < 7 * 24 ? "This week's payment is reduced for the time paused, and a pause of more than a week ends your participation in the study."
    : "A pause of more than a week ends your participation in the study: the study team will contact you.";
  await remindByMessage("paused", "Tracking is still paused", `You paused tracking ${ago} ago. Nothing is recorded while it is paused. ${rule}`, "resume");
  await save("pausedRemindedAt", now);
  await count("reminded_paused");
  await keepPausedReminder();                                 // (the alarm came once: the next reminder's is set)
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

// NOTE: [edge case callout] the limit of pastLimit past conversations is the participant's, not the
// install's: an install made again (or one on a second computer) would count from zero. The study server
// knows which past conversations this participant ID annotated, from any install (GET /past: their
// fingerprints); pastLeft counts them too. Asked at every heartbeat and when reading is turned on; past
// conversations are looked for only once it was asked (a server without the route answers 404: then
// this install's own count stands).
async function checkPastAnnotated(settings) {
  if (!settings.participantId) return;
  await save("pastAskedAt", Date.now());
  let annotated;
  try {
    const query = new URLSearchParams({ participant_id: settings.participantId });
    const response = await fetch(`${settings.serverUrl}/past?${query}`, { headers: { "X-Study-Key": settings.studyKey }, signal: AbortSignal.timeout(10000) });
    if (!response.ok && response.status !== 404) return;
    annotated = response.ok ? (await response.json()).annotated : [];
  } catch (error) { return; }       // offline: asked again (historyTick, the next heartbeat or switch)
  // NOTE: [edge case callout] an answer about a participant ID changed meanwhile is not this ID's list
  if ((await getSettings()).participantId !== settings.participantId) return;
  await save("pastAnnotated", annotated);
  // a past episode found here and not annotated goes: its invitations first (the record names their tabs);
  // nothing if it was answered meanwhile, or dropped by another run
  const drop = async (record, counter, remember) => {
    await withdrawOffers(record.id);
    let dropped = false;
    await updateEpisode(record.id, (current) => (current.answers ? current : ((dropped = true), null)));
    if (!dropped) return;
    if (remember) await rememberDecided(record.id);
    await count(counter);
  };
  // a past conversation found here, not annotated yet, that this ID annotated elsewhere since (from any of its
  // turns): not asked about
  const annotatedConversations = new Set(annotated.map(conversationOf));
  for (const [, record] of await loadAll("episode:")) {
    if (record.source !== "past" || record.answers || !annotatedConversations.has(Episodes.hash(record.chatKey))) continue;
    await drop(record, "past_annotated_elsewhere", true);
  }
  // NOTE: [edge case callout] two installs of one participant ID (two computers) can each find past conversations
  // before the other's are annotated. Once the other's annotations bring the total over the limit, the ones
  // waiting here go (they could not be paid), until it holds again: those found last first, and one the
  // participant said Yes to (is annotating) last. They are not remembered as decided: the participant never
  // answered them.
  const over = -(await pastLeft());
  const waiting = (await loadAll("episode:")).map(([, record]) => record)
    .filter((record) => record.source === "past" && !record.answers && record.status !== "removed")
    .sort((a, b) => Boolean(a.confirmedAt) - Boolean(b.confirmedAt) || b.detectedAt - a.detectedAt);
  for (const record of waiting.slice(0, Math.max(0, over))) await drop(record, "past_over_limit", false);
  await updateBadge();
}

// The study server can switch reading off for a site without a new release (GET /config:
// {history: {"chatgpt.com": false}}); a server without it leaves things as they are
async function fetchStudyConfig(settings) {
  try {
    const response = await fetch(`${settings.serverUrl}/config`, { headers: { "X-Study-Key": settings.studyKey }, signal: AbortSignal.timeout(10000) });
    if (response.ok) await save("hconfig", await response.json());
  } catch (error) { /* offline: the last one stands */ }
}

// ---------------- messages from the study team (0.6.15) ----------------
// The study team can send a participant a message through the study server: to update the extension, about
// something that is due, or that their participation has ended. After every heartbeat (twice a day), and when
// the participant opens the messages page, the extension asks the server for the messages that wait for its
// participant ID (GET /messages: those this ID has not read yet; a server without the route answers 404). A
// message new to this computer is kept (teamMessages), shown as a notification, counted on the icon, and shown
// in a small window on the next page of a chat site. It stays new until the participant clicks OK there, in
// the popup or on the messages page (ui/messages.html, which lists them all). The server hears when a message
// arrived here and when it was read (the events "team_message"), and no longer sends one that was read.
// NOTE: [design thought] a message is shown as text, never as HTML (the pages set textContent), and cut to a
// length: the server is the study's own, but what it sends is not trusted with the extension's pages
const TEAM_TITLE_CHARS = 120, TEAM_TEXT_CHARS = 2000, TEAM_MESSAGES_KEPT = 30;
const TEAM_MESSAGE_GAP_MS = 4 * 3600 * 1000;      // a message closed without OK comes back on a chat page this much later
const TEAM_CHECK_GAP_MS = 60 * 1000;              // the messages page asks the server at most this often
let teamCheckedAt = 0;

async function fetchTeamMessages(settings) {
  if (!settings.participantId) return;
  let waiting;
  try {
    const query = new URLSearchParams({ participant_id: settings.participantId, version: chrome.runtime.getManifest().version });
    const response = await fetch(`${settings.serverUrl}/messages?${query}`, { headers: { "X-Study-Key": settings.studyKey }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return;
    waiting = (await response.json()).messages;
  } catch (error) { return; }       // offline: asked again at the next heartbeat
  // NOTE: [edge case callout] an answer about a participant ID changed meanwhile is not this ID's messages
  if (!Array.isArray(waiting) || (await getSettings()).participantId !== settings.participantId) return;
  // (an id is letters, digits, ".", "_" and "-": it names the message's notification, "team|<id>")
  const valid = (message) => typeof message?.id === "string" && /^[\w.-]{1,80}$/.test(message.id) && typeof message.text === "string" && message.text.trim();
  await addTeamMessages(waiting.filter(valid).map((message) => ({
    id: message.id, title: String(message.title ?? "").trim().slice(0, TEAM_TITLE_CHARS), text: message.text.trim().slice(0, TEAM_TEXT_CHARS),
    sentAt: Number.isFinite(message.sent_at) ? message.sent_at : null })), settings);
}

// Messages that are new to this computer are kept, shown as notifications, counted on the icon, and reported
// to the study server. `messages`: [{id, title, text, sentAt}], from the server or made here (`automatic`: the
// reminder at the end of a study week, weekCheck). One this computer knows already is not new: it is on the
// screen, or read (the server hears that soon).
async function addTeamMessages(messages, settings) {
  const fresh = [];
  await serialized("teamMessages", async () => {
    const kept = (await load("teamMessages")) || [];
    for (const message of messages) {
      if (kept.some((each) => each.id === message.id)) continue;
      const entry = { ...message, receivedAt: Date.now(), readAt: null };
      kept.push(entry);
      fresh.push(entry);
    }
    if (fresh.length) await save("teamMessages", kept.slice(-TEAM_MESSAGES_KEPT));
  });
  for (const message of fresh) {
    chrome.notifications.create(`team|${message.id}`, {
      type: "basic", iconUrl: "icons/icon128.png", title: `Advice Tracker: ${message.title || "a message from the study team"}`,
      message: message.text, requireInteraction: true, ...(message.actionLabel ? { buttons: [{ title: message.actionLabel }] } : {}),
    });
    // (a reminder of a kind is counted where it is made: remindPaused, remindOutcomes)
    if (!message.kind) await count(message.automatic ? "week_reminder" : "team_message_received");
    await upload("team_message", { message: message.id, state: "received", ...(message.automatic ? { automatic: true } : {}) }, settings);
  }
  if (fresh.length) await updateBadge();
}

// The messages page was opened: it shows what the server holds now, not what it held at the last heartbeat
async function checkTeamMessages() {
  if (Date.now() < teamCheckedAt + TEAM_CHECK_GAP_MS) return;
  teamCheckedAt = Date.now();
  await fetchTeamMessages(await getSettings());
}

// A message from the study team that is not read yet, in a small window on the chat page the participant just
// opened: the oldest one that was not put on a chat page within the last TEAM_MESSAGE_GAP_MS. Also while
// tracking is paused (a message may be about the pause); not on a site the participant excluded, where the
// extension shows nothing.
async function offerTeamMessage(tabId, url, settings) {
  if (!settings.participantId || excluded(settings, url)) return false;
  const now = Date.now();
  const message = ((await load("teamMessages")) || []).find((each) => !each.readAt && now >= (each.offeredAt ?? 0) + TEAM_MESSAGE_GAP_MS);
  if (!message) return false;
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: "show_message", message: { id: message.id, title: message.title, text: message.text,
                                                                                      actionLabel: message.actionLabel } });
  } catch (error) { /* tab closed, or a page without the content script */ }
  if (!response?.shown) return false;
  await serialized("teamMessages", async () => {
    const kept = (await load("teamMessages")) || [];
    await save("teamMessages", kept.map((each) => (each.id === message.id ? { ...each, offeredAt: now } : each)));
  });
  return true;
}

// The participant clicked OK on a message (`where`: "chat", "popup" or "page"): it is read. Its notification
// and its windows on chat pages go, and the server hears it (and how long the message waited here).
async function onTeamMessageRead(message) {
  let read = null;
  await serialized("teamMessages", async () => {
    const kept = (await load("teamMessages")) || [];
    const entry = kept.find((each) => each.id === message.id);
    if (!entry || entry.readAt) return;          // (read already, in another place: once)
    entry.readAt = Date.now();
    read = entry;
    await save("teamMessages", kept);
  });
  if (!read) return;
  chrome.notifications.clear(`team|${read.id}`);
  for (const tab of await chrome.tabs.query({})) chrome.tabs.sendMessage(tab.id, { type: "close_message", id: read.id }).catch(() => {});
  await count("team_message_read");
  await upload("team_message", { message: read.id, state: "read", where: message.where ?? null,
                                 seconds_waited: Math.round((read.readAt - read.receivedAt) / 1000), ...(read.automatic ? { automatic: true } : {}),
                                 ...(message.action ? { action: message.action } : {}) },
               await getSettings());
  await updateBadge();
}

// ---------------- the extension's own reminders as messages (0.6.24) ----------------
// A reminder the extension makes itself, of a pause that goes on or of questions waiting on the Outcomes page, is
// shown as the study team's messages are (addTeamMessages): a window on the chat pages, under the icon and on the
// messages page, until OK, and a notification where the computer shows Chrome's notifications. A notification alone
// is not seen by a participant whose computer does not show them. `kind` tells the reminders apart: a newer one of a
// kind takes the place of an older one not read yet, and one that no longer holds goes (withdrawReminders).
// `action`: its button besides OK, which does what the notification's button or click did.
const REMINDER_ACTIONS = { resume: "Resume tracking", outcomes: "Open the Outcomes page" };
async function remindByMessage(kind, title, text, action) {
  await withdrawReminders(kind);
  const now = Date.now();
  await addTeamMessages([{ id: `${kind}-${now.toString(36)}`, title, text, sentAt: now, automatic: true, kind, action,
                           actionLabel: REMINDER_ACTIONS[action] }], await getSettings());
}

// The reminders of `kind` that are not read yet go: from the list, the chat pages and the notifications (the study
// server hears it: state "withdrawn")
async function withdrawReminders(kind) {
  let gone = [];
  await serialized("teamMessages", async () => {
    const kept = (await load("teamMessages")) || [];
    gone = kept.filter((each) => each.kind === kind && !each.readAt);
    if (gone.length) await save("teamMessages", kept.filter((each) => !gone.includes(each)));
  });
  if (!gone.length) return;
  const settings = await getSettings();
  for (const message of gone) {
    chrome.notifications.clear(`team|${message.id}`);
    for (const tab of await chrome.tabs.query({})) chrome.tabs.sendMessage(tab.id, { type: "close_message", id: message.id }).catch(() => {});
    await upload("team_message", { message: message.id, state: "withdrawn", automatic: true }, settings);
  }
  await updateBadge();
}

// A reminder's button was clicked (`where`: "chat", "popup", "page" or "notification"): the reminder is read, and its
// button does what it says
async function onMessageAction(message) {
  const entry = ((await load("teamMessages")) || []).find((each) => each.id === message.id);
  if (!entry?.action) return;
  await onTeamMessageRead({ id: entry.id, where: message.where, action: entry.action });
  // (resuming here is the popup's Resume: the settings change clears the pause and its reminders, keepPausedReminder)
  if (entry.action === "resume") await updateSettings({ paused: false, pausedAt: null });
  if (entry.action === "outcomes") openOutcomes("");
}

// ---------------- the reminder at the end of a study week (0.6.15) ----------------
// The study's rules (ui/rules.html, as the consent form): a payment is made when the participant was active
// in its time (each of weeks 1 to 3; weeks 4 and 5 together) and finished the due tasks; "if at the end of a
// week you were not active or have due tasks left, we send you a reminder", and they have three more days.
// The extension sends that reminder by itself. At the end of each paid part of the study (lib/modes.js
// studyPeriods) it looks at what it holds: was the participant active (an advice conversation, answers to
// questions, feedback), and are due tasks left (in weeks 1 to 3 the quick questions of advice conversations
// never answered; at the end of week 5 the outcome questions). If something is missing, a message says what,
// and by when: it is shown as the study team's messages are (a notification, a window on the chat pages, under
// the icon, until OK). Three days later it looks again. Both times the study server hears what was found (the
// events "week_status"): the study team decides about the payment, the extension only reminds and reports.
// NOTE: [design thought] only what is due is counted as due: a week's end never counts outcome questions
// (they are due at the end of the study), and never a past conversation (optional, paid apart). Both have
// their own reminder every two days (remindOutcomes), which names a day only for what is due then.
// NOTE: [edge case callout] Chrome may be closed when a part ends: the check then runs at the next start
// (the alarm is set again whenever the worker starts, and every heartbeat checks too). A part whose three days
// were over before this version was installed is left alone; one whose three days are over when its end is
// first looked at is reported without a reminder (the day it would name has passed).
const WEEK_REMINDER_DAYS = STUDY_CONFIG.weekReminderDays ?? 3;

function weekCheck() {
  return serialized("weekStatus", async () => {
    const settings = await getSettings(), start = await studyDay(0), now = Date.now();
    if (!settings.participantId || !Number.isFinite(start)) return;
    let status = await load("weekStatus");
    if (!status) {
      status = { since: now, parts: {} };
      // NOTE: [edge case callout] feedback sent before this version was installed has no time (only its count was
      // kept): it counts as sent now, so the week in which the update came does not look inactive because of it
      const sent = (await load("stats")) || {};
      if ((sent.feedback || 0) + (sent.feedback_missed_advice || 0) > 0 && !(await load("feedbackAt"))) await save("feedbackAt", [now]);
    }
    const records = (await loadAll("episode:")).map(([, record]) => record);
    const activity = [...records.flatMap(Modes.recordActivity), ...((await load("feedbackAt")) || []).map((at) => ({ at, kind: "feedback" }))];
    const moments = [];              // the ends and the three-day marks still to come
    for (const period of Modes.studyPeriods(NEW_ADVICE_DAYS, STUDY_CONFIG.studyDays)) {
      const from = start + period.from * DAY_MS, to = start + period.to * DAY_MS, deadline = to + WEEK_REMINDER_DAYS * DAY_MS;
      if (deadline <= status.since) continue;
      const part = status.parts[period.name] || {};
      const by = (kinds) => Modes.activeIn(activity, from, to, kinds);
      const found = (moment, active, more) => ({ week: period.name, moment, ended_at: to, deadline_at: deadline, active,
        active_by: { advice: by(["advice"]), answers: by(["answers"]), feedback: by(["feedback"]) }, due_left: Modes.dueLeft(records, period, to).length, ...more });
      if (now >= to && !part.end) {
        const event = found("end", by(), {});
        // (the reminder: something is missing, and its three days are not over yet)
        const reminded = (!event.active || event.due_left > 0) && now < deadline;
        // NOTE: [edge case callout] active only through advice conversations that were never answered: should the
        // participant answer "No" to all of them (not advice), nothing of the part is left that makes them active.
        // The reminder says so, since no second one comes.
        const answered = records.some((record) => record.source !== "past" && record.status !== "removed" && record.answers &&
                                                   record.openedAt >= from && record.openedAt < to);
        const unsure = event.active && !answered && !by(["answers", "feedback"]);
        part.end = { at: now, active: event.active, due: event.due_left, reminded };
        await save("weekStatus", { ...status, parts: { ...status.parts, [period.name]: part } });
        await upload("week_status", { ...event, reminded }, settings);
        if (reminded) await addTeamMessages([weekReminder(period, event.active, event.due_left, to, deadline, unsure)], settings);
      }
      if (now >= deadline && !part.deadline) {
        // after the part's end, answers and feedback still make its participant active; a new advice conversation does not
        const after = Modes.activeIn(activity, to, deadline, ["answers", "feedback"]);
        const event = found("deadline", by() || after, { active_after_end: after });
        part.deadline = { at: now, active: event.active, due: event.due_left };
        await save("weekStatus", { ...status, parts: { ...status.parts, [period.name]: part } });
        await upload("week_status", event, settings);
      }
      status.parts[period.name] = part;
      moments.push(...(part.end ? [] : [to]), ...(part.deadline ? [] : [deadline]));
    }
    await save("weekStatus", status);
    if (moments.length) chrome.alarms.create("weekCheck", { when: Math.max(Math.min(...moments), now + 60000) });
    else await chrome.alarms.clear("weekCheck");
  });
}

// The reminder's words, as a message (addTeamMessages). `active`, `due`: what was found at the end of the part
// (was the participant active; how many conversations have due questions left), `to`: when it ended,
// `deadline`: three days later; `unsure`: active only through conversations not answered yet (weekCheck).
function weekReminder(period, active, due, to, deadline, unsure = false) {
  const by = new Date(deadline).toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const weeks = period.last ? `weeks ${period.name.replace("-", " and ")}` : `week ${period.name}`;
  const conversations = due === 1 ? "one advice conversation" : `${due} advice conversations`;
  const lines = [];
  if (due && period.last) {
    lines.push(`The outcome questions of ${conversations} are not answered yet. They are due now, even if you have not acted yet or it is too early ` +
               `to tell: please answer them by ${by} (click the Advice Tracker icon, then Outcomes). Answers still missing then are late: you are ` +
               "then paid in proportion to the outcome questions you answered on time, and do not receive the high-quality bonus.");
  } else if (due) {
    lines.push(`The quick questions of ${conversations} are not answered yet. They are due: please answer them by ${by} (click the Advice Tracker ` +
               "icon, then Quick check-ins; if a conversation was not advice, answer No there). Answers still missing then are late: you are then " +
               "paid in proportion to the advice conversations you answered on time, and do not receive the high-quality bonus.");
    if (unsure) {
      lines.push(`If none of them was advice, nothing else shows that you were active in ${weeks}: please then also send concrete feedback by ` +
                 `${by} (Advice Tracker icon, then “Send feedback on the study”), for example about what the extension took for advice.`);
    }
  }
  if (!active) {
    lines.push(`The extension recorded no activity of yours in ${weeks}: ${period.last ? "" : "no advice conversation, "}no answers to its quick ` +
               `questions or outcome questions, no feedback. To stay active, by ${by} answer quick questions or outcome questions that are ` +
               "waiting, if there are any (answering only whether you decided or acted does not count), or send concrete feedback (Advice " +
               "Tracker icon, then “Send feedback on the study”), for example about an advice conversation the extension missed or a possible " +
               `improvement. An advice conversation that starts now does not count for ${weeks}. If you are still ` +
               `not active then, you lose the payment for ${weeks} ($10) and the high-quality bonus.`);
  }
  return { id: `week-${period.name}`, title: `${weeks[0].toUpperCase()}${weeks.slice(1)} of your study ${period.last ? "have" : "has"} ended: please finish by ${by}`,
           text: lines.join("\n\n"), sentAt: to, automatic: true };
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

// Feedback on the study, typed in the popup (0.6.12): free text, redacted on this computer as a free-text
// answer is (names on the participant's list, e-mail addresses, phone numbers, ...) and sent with the
// extension's version. `kind` (0.6.14): "missed_advice" is a report of an advice conversation the extension
// did not ask about (the popup's second box), anything else plain feedback. Says whether it went now; else it
// waits in the queue (offline, or no participant ID yet).
async function onFeedback(message) {
  const settings = await getSettings();
  const { text, counts } = await withNumbers((numbers) => Redact.redact(message.text, settings.redactNames, numbers));
  const kind = message.kind === "missed_advice" ? "missed_advice" : "feedback";
  await count(kind === "feedback" ? "feedback" : "feedback_missed_advice");
  // (when it was sent: feedback is one of the ways to be active in a study week, weekCheck; the last 200 times)
  await serialized("feedbackAt", async () => save("feedbackAt", [...((await load("feedbackAt")) || []), Date.now()].slice(-200)));
  return upload("feedback", { kind, text, redacted: counts, version: chrome.runtime.getManifest().version }, settings);
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
  // extension ran, when they last sent a message, this install's id, the reading's epoch (no conversation content); without them,
  // conversations of the study period would count as past ones. Reading past conversations stops (the
  // participant agrees again to turn it on; other devices are still read), and nothing from before
  // now is ever read again (deletedAt is the floor of lib/history.js windows).
  const kept = {};
  for (const name of ["settings", "heartbeatAt", "joinedAt", "joinedEstimated", "joinedChecked", "pastBefore", "trackingLog", "aliveLog", "aliveGaps", "installId",
                      "lastMessageAt", "pausedRemindedAt", "weekStatus", "feedbackAt", "teamMessages",
                      "historyEpoch", "hconfig", ...HISTORY_SITES.map((host) => `haccount:${host}`)]) {
    const value = await load(name);
    if (value !== undefined) kept[name] = value;
  }
  const before = kept.settings ? { ...kept.settings } : null;
  if (kept.settings) kept.settings = { ...kept.settings, readPast: false };
  kept.historyEpoch = (kept.historyEpoch || 0) + 1;
  // NOTE: [edge case callout] the table of the numbered placeholders (lib/redact.js) lets go of its fingerprints
  // and keeps how many numbers are taken: a name that comes up later then never gets a number that an upload
  // made before now used for another name. The store is emptied in the table's own chain, so a redaction
  // under way finishes first, and one that comes meanwhile finds the counts.
  // (also kept, above: the messages for the participant, what was found at the end of each study week, and
  // when feedback was sent: the study's own words and times, nothing of a conversation)
  await serialized("redactNumbers", async () => {
    const numbers = await load("redactNumbers");
    if (numbers) kept.redactNumbers = Redact.forgetNumbers(numbers);
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    await chrome.storage.local.set(kept);
  });
  const forget = (tab) => Promise.race([chrome.tabs.sendMessage(tab.id, { type: "forget" }).catch(() => {}),
                                        new Promise((resolve) => setTimeout(resolve, 2000))]);
  await Promise.all((await chrome.tabs.query({})).map(forget));
  deletingSince = Date.now();
  await save("deletedAt", deletingSince);
  await chrome.alarms.clearAll();
  await keepHeartbeatAlarm();
  await keepOutcomesAlarm();
  await keepPausedReminder();
  await keepHistoryAlarm();
  await weekCheck();                 // (its alarm went with the others)
  await updateBadge();
  // past conversations were turned off with the data: reported as any opt-out is (the settings' own
  // change event does not fire for a cleared store)
  if (before) { await consentChanged(before, kept.settings, kept.settings); await statusChanged(); }
}

// Change some settings at once from their stored values (other pages may have changed others meanwhile)
function updateSettings(changes) {
  return serialized("settings", async () => {
    await chrome.storage.local.set({ settings: { ...((await load("settings")) || {}), ...changes } });
  });
}

// The extension's two pages of questions: the quick check-ins (ratings) and the outcomes page (0.6.9: the
// follow-ups, and the past conversations)
function openCheckin(query) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`ui/checkin.html${query}`) });
}
function openOutcomes(query) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`ui/outcomes.html${query}`) });
}
// ... and the page of the messages from the study team (0.6.15)
function openMessages() {
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/messages.html") });
}

// ---------------- event wiring ----------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // the two messages whose callers wait for an answer
  if (message.type === "panel_episode") {
    // NOTE: [design thought] a page that waited behind another one (`waited`), and the update pop-up's
    // Yes, ask here for the episode as it is now; a question that is no longer due (removed, or
    // answered meanwhile with nothing new since: lib/modes.js stillDue, waitedDue) is not shown at all
    Promise.all([load(`episode:${message.id}`), getSettings()])
      .then(([record, settings]) => {
        const due = record && record.status !== "removed" && (message.waited ? Modes.waitedDue(record) : Modes.stillDue(record));
        sendResponse({ episode: due ? panelEpisode(record, message.stage, settings) : null });
      });
    return true;
  }
  if (message.type === "delete_all") {
    deleteAll().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "followup_answer") {
    onFollowupAnswer(message, sendResponse);
    return true;
  }
  // (the popup says whether the feedback went now or waits: onFeedback)
  if (message.type === "feedback") {
    onFeedback(message).then((sent) => sendResponse({ sent }));
    return true;
  }
  // (the popup and the messages page show the message as read once it is)
  if (message.type === "message_read") {
    onTeamMessageRead(message).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "message_action") {
    onMessageAction(message).then(() => sendResponse({ ok: true }));
    return true;
  }
  // a conversation as it will be sent, for a page that shows it before it goes (ui/checkin.js): redacted here,
  // where the placeholders get their numbers, so the page shows the very text the upload will hold
  if (message.type === "redact_transcript") {
    getSettings().then((settings) => withNumbers((numbers) => Questions.transcript(message.messages, settings.redactNames, numbers))).then(sendResponse);
    return true;
  }
  // (the page thanks the participant only for answers taken: onPastSubmitted)
  if (message.type === "past_submitted") {
    withdrawOffers(message.id).then(() => onPastSubmitted(message)).then((taken) => sendResponse({ taken }));
    return true;
  }

  // NOTE: [design thought] answer at once and do the work in the background: a judgment can take
  // minutes, and a listener that keeps its caller waiting that long is stopped by Chrome
  sendResponse({ ok: true });
  const tabId = sender.tab?.id;
  // what the participant did with a ratings page: first close its copies in other tabs
  const finished = (then) => coveredEnd(message).then((end) => panelFinished(message.id, tabId, end)).then(() => then(message));
  switch (message.type) {
    case "snapshot": onSnapshot(message, sender); break;
    case "view": onView(message, sender); break;
    case "activity": onActivity(message); break;
    case "rating_shown": onPanelShown(message, sender); break;
    case "offer_seen": onOfferSeen(message); break;
    case "reminder_answer": onReminderAnswer(message); break;
    case "rating_submitted": finished(onRatingSubmitted); break;
    case "not_advice": finished(onNotAdvice); break;
    case "rating_closed": finished(onPanelClosed); break;
    case "rating_snoozed": finished(onSnoozed); break;
    case "open_rating_tab":
      finished(() => openCheckin(`?rate=${encodeURIComponent(message.id)}&stage=${encodeURIComponent(message.stage || "")}`));
      break;
    case "checkin_submitted": onCheckinSubmitted(message); break;
    case "followup_seen": onFollowupSeen(message); break;
    case "open_outcomes": openOutcomes(message.id ? `?episode=${encodeURIComponent(message.id)}` : ""); break;
    case "update_answer": offerAnswered(message).then(() => onUpdateAnswer(message)).then(() => offerRefused(tabId)); break;
    case "confirm_answer": offerAnswered(message).then(() => onConfirmAnswer(message, tabId)); break;
    case "invite_answer": offerAnswered(message).then(() => onInviteAnswer(message, tabId)); break;
    // (the extension tab's card: an answer that ends the question withdraws its invitations too)
    case "card_answer": (["no", "skip"].includes(message.answer) ? withdrawOffers(message.id) : Promise.resolve()).then(() => onCardAnswer(message)); break;
    case "flush": flushQueue(); break;
    case "held": onHeld(message); break;
    case "panel_gone": offerRefused(tabId); break;              // a page went without an answer ("No", or dealt with elsewhere)
    case "open_help": openCheckin("#advice"); break;            // "what counts as advice?" on a chat page
    case "check_messages": checkTeamMessages(); break;          // the messages page was opened
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const [kind, name] = alarm.name.split("|");      // e.g. "quiet|chatgpt.com/<id>", "pause|<episode>", "flush"
  if (kind === "judge" || kind === "quiet") advance(name);
  else if (kind === "hjudge") kickHistory(name || null);
  else if (kind === "hread") { await historyTick(); await settleHanded(); await offerOnFront(); }
  else if (kind === "heldcut") await settleHanded();
  else if (kind === "pause") await onPause(name);
  else if (kind === "ask") await askDue(name);         // the reply did not settle yet
  else if (kind === "remind") await onReminder(name);
  else if (kind === "checkin") {
    // the follow-up's stage changed (it began, two days after "not yet" or "too early to tell", the planned
    // day, the study's last week): the badge says so, and the question comes on the next page the participant opens
    await updateBadge();
    await armFollowup(name);
  } else if (kind === "flush") await flushQueue();
  else if (kind === "heartbeat") await heartbeatIfDue();
  else if (kind === "pausedReminder") await remindPaused();
  else if (kind === "outcomesReminder") await remindOutcomes();
  else if (kind === "weekCheck") await weekCheck();
});

chrome.notifications.onClicked.addListener(async (id) => {
  const [kind, episode] = id.split("|");
  chrome.notifications.clear(id);
  if (kind === "paused") return chrome.runtime.openOptionsPage();
  if (kind === "outcomes") return openOutcomes("");
  // (the page shows the whole message, with its OK; a reminder of questions on the Outcomes page opens that page, as its
  // button does, and is read)
  if (kind === "team") {
    const entry = ((await load("teamMessages")) || []).find((each) => each.id === episode);
    return entry?.action === "outcomes" ? onMessageAction({ id: entry.id, where: "notification" }) : openMessages();
  }
  // (a check-in notification from before 0.6.9 that is still in the tray)
  if (kind === "checkin") return openOutcomes(`?episode=${encodeURIComponent(episode)}`);
  // NOTE: [edge case callout] a notification can stay in the tray after its question was answered
  // another way: with nothing new since, it opens the list of what waits, not the episode again
  const record = await load(`episode:${episode}`);
  openCheckin(record && Modes.stillDue(record) ? `?rate=${encodeURIComponent(episode)}` : "");
});

chrome.notifications.onButtonClicked.addListener(async (id, button) => {
  // (0.6.24: a reminder's button, onMessageAction)
  if (id.startsWith("team|")) return onMessageAction({ id: id.slice("team|".length), where: "notification" });
  if (id !== "paused") return;                          // (a pause reminder from before 0.6.24)
  chrome.notifications.clear(id);
  await count(button === 0 ? "paused_reminder_resume" : "paused_reminder_stay");
  // (the settings change resumes tracking the way the popup does, and clears the reminder's alarm)
  if (button === 0) await updateSettings({ paused: false, pausedAt: null });
});

// After a browser restart (alarms may be lost) or an update: restart the timers of the episodes,
// then look at every chat that still has text (which also finishes closings a stop interrupted).
async function resumeAll() {
  const soon = Date.now() + 60000;
  for (const [, record] of await loadAll("episode:")) {
    if (record.status === "open" && Modes.asksAtPauses(record.mode) && !ownText(record)) await armPause(record);
    if (record.status === "open" && record.heldBy === "history" && !record.walk) {
      chrome.alarms.create(`heldcut|${record.id}`, { when: Math.max(await cutOf(record.openedAt, await getSettings()), soon) });
    }
    if (record.checkin && !record.checkin.doneAt) await armFollowup(record.id);
    if (record.remindAt) chrome.alarms.create(`remind|${record.id}`, { when: Math.max(record.remindAt, soon) });
    if (record.dueAsk) chrome.alarms.create(`ask|${record.id}`, { when: soon });
    if (record.source === "past" && record.answers && record.status === "pending") await finishPastAnnotation(record.id);
  }
  for (const [name] of await loadAll("snap:")) advance(name.slice("snap:".length));
  await expireWaiting();
  if (((await load("queue")) || []).length) chrome.alarms.create("flush", { delayInMinutes: 1 });
  // a change of the settings the worker did not see (it was updated or stopped meanwhile)
  await forgetExcluded();
  await sendWaitingTranscripts();
  await keepHistoryAlarm();
  await keepOutcomesAlarm();
  kickHistory();
}

// Reading conversations from the site: an alarm every minute (historyTick does nothing while tracking is off)
async function keepHistoryAlarm() {
  if (!(await chrome.alarms.get("hread"))) chrome.alarms.create("hread", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await getSettings();
  // NOTE: [edge case callout] before 0.4 an episode ended after 10 quiet minutes, and before 0.6.12 after a quiet
  // day; it now lasts until the topic changes or a week goes by. An install updated from an earlier version that
  // still has an old default saved (every Save on the settings page writes it) moves to the new one, while a time
  // typed on the settings page (a test) stays.
  if (details.reason === "update" && (settings.endQuietMinutes === 10 ||
      (/^0\.([0-5]\.|6\.([0-9]|1[01])$)/.test(details.previousVersion || "") && settings.endQuietMinutes === 24 * 60))) {
    settings.endQuietMinutes = DEFAULT_SETTINGS.endQuietMinutes;
  }
  // NOTE: [edge case callout] an install saves the server address with its settings, so an update keeps
  // it: one that still has a study server used before moves to the current one (0.6.5), while an
  // address typed on the settings page (a test server, say) stays
  if (details.reason === "update" && (STUDY_CONFIG.retiredServerUrls || []).includes(settings.serverUrl)) {
    settings.serverUrl = DEFAULT_SETTINGS.serverUrl;
  }
  // NOTE: [edge case callout] 0.6.9 begins the follow-up a week after the request (the check-in came after
  // two weeks before): an install updated from an earlier version that still has the old default saved moves
  // to the new one, while a time typed on the settings page (a test) stays. Check-ins made before keep their day.
  if (details.reason === "update" && /^0\.([0-5]\.|6\.[0-8]$)/.test(details.previousVersion || "") && settings.followupSeconds === 14 * 24 * 3600) {
    settings.followupSeconds = DEFAULT_SETTINGS.followupSeconds;
  }
  // NOTE: [design thought] since 0.6.11 the conversations of the sites' apps and other devices are always read
  // (the settings page has no switch for them any more). An install updated from an earlier version whose
  // participant had not turned them on reads only what comes after the update (they never agreed to more),
  // and shows the settings page once, where the text says so.
  const appsTurnedOn = details.reason === "update" && /^0\.([0-5]\.\d+|6\.([0-9]|10))$/.test(details.previousVersion || "") &&
                       settings.readApps !== true && !(await load("appsFrom"));
  if (appsTurnedOn) await save("appsFrom", Date.now());
  // (0.7) a reminder of the Outcomes page that 0.6.24 made as a message, not read yet, goes: it is a pop-up now
  if (details.reason === "update" && details.previousVersion === "0.6.24") await withdrawReminders("outcomes");
  delete settings.readApps;
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
  // NOTE: [design thought] participants updated from before 0.6 see the reading of past and other-device
  // conversations once (past ones stay off unless they agree there), and so do those whose other devices are
  // read from this update on
  else if (details.reason === "update" && (/^0\.[0-5]\./.test(details.previousVersion || "") || appsTurnedOn)) {
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
    (after.participantId ? noteJoined() : Promise.resolve()).then(statusChanged).then(keepPausedReminder);
  }
  if (differs("excludedHosts")) forgetExcluded();
  // NOTE: [edge case callout] what the study server said about the earlier participant ID (the past conversations
  // it annotated; when it first reported, which ends the past) does not hold for a new one (a typo corrected):
  // asked again, and past turns wait meanwhile. (Not at the first setup: nothing was asked without an ID.)
  if (differs("participantId")) {
    const corrected = Boolean(before.participantId && after.participantId);
    (corrected ? load("joinedAt").then(async (joinedAt) => { if (joinedAt) await save("pastBefore", joinedAt); await remove("joinedChecked"); }) : Promise.resolve())
      .then(() => remove("pastAnnotated")).then(() => checkJoined(after)).then(() => checkPastAnnotated(after));
  }
  // reading past conversations turned on or off: recorded (with the version of the text agreed to), and the
  // walks start again (opting out stops it, and its unanswered past episodes go)
  if (Boolean(before.readPast) !== Boolean(after.readPast)) {
    historySwitched(!after.readPast).then(() => consentChanged(before, after, after)).then(statusChanged).then(keepHistoryAlarm)
      .then(() => checkJoined(after)).then(() => checkPastAnnotated(after)).then(() => fetchStudyConfig(after));
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
keepPausedReminder();
weekCheck();
noteAlive();
getSettings().then(setUninstallUrl);
