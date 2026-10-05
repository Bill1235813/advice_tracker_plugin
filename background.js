// Background service worker: the only place that stores data, talks to the study server and
// decides when to ask the participant something. For every chat:
//   snapshot from the page -> each user turn the participant SENT is judged, one at a time, in
//   order (lib/episodes.js: the advice judge while searching, the continuation judge inside an
//   episode) -> an episode closes on a topic switch, after endQuietMinutes without activity, or
//   when its tab closes -> rating panel on the page (or a notification) -> check-in
//   followupDays later -> answers uploaded when the participant presses Submit.
// Storage (chrome.storage.local):
//   settings        participant id, server, preferences (options page)
//   snap:<chat>     the chat's latest messages, kept only while a turn is unjudged or an episode
//                   is open, and deleted as soon as the chat is settled
//   chat:<chat>     the chat's episode state: turn numbers and hashes, no text
//   alias:<key>     a second key of a chat (a new chat's URL gains its id after the first turn)
//   episode:<id>    a closed episode: its text until it is rated, then only the answers
//   queue, stats    uploads waiting for the network; counts for the heartbeat
importScripts("config.js", "lib/episodes.js", "lib/similarity.js");

const DEFAULT_SETTINGS = {
  participantId: "", serverUrl: STUDY_CONFIG.serverUrl, studyKey: STUDY_CONFIG.studyKey, paused: false, localOnly: false,
  followupDays: 14, endQuietMinutes: 10,
  shareDefault: "ask",     // "full" | "ratings" | "ask": chosen once in the settings page
  excludedHosts: [], redactNames: [], relatedThreshold: 0.5,
};
const POLL_WAIT_S = 20;      // one long-poll for a label (Chrome stops a worker that waits > 30 s for a response)
const RETRY_MINUTES = 2;     // after a failed judgment, or when the server cannot be reached

// ---------------- storage helpers ----------------
async function load(name) { return (await chrome.storage.local.get(name))[name]; }
async function save(name, value) { await chrome.storage.local.set({ [name]: value }); }
async function remove(name) { await chrome.storage.local.remove(name); }
async function getSettings() { return { ...DEFAULT_SETTINGS, ...((await load("settings")) || {}) }; }
async function loadAll(prefix) {
  const everything = await chrome.storage.local.get(null);
  return Object.entries(everything).filter(([name]) => name.startsWith(prefix));
}

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

// ---------------- snapshots from the chat pages ----------------
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
  const settings = await getSettings();
  if (settings.paused || settings.excludedHosts.includes(new URL(message.url).hostname)) return;
  const key = await chatKey(message);
  const kept = await serialized(`snap:${key}`, async () => {
    const chat = await load(`chat:${key}`);
    // a chat in which nothing was ever sent while watched (a past chat, only opened) is not kept
    if (!chat && !message.sent.length) return false;
    if (!chat) await save(`chat:${key}`, Episodes.newChat({ key, site: message.site, now: Date.now() }));
    const stored = await load(`snap:${key}`);
    const same = stored && JSON.stringify(stored.messages) === JSON.stringify(message.messages);
    await save(`snap:${key}`, {
      messages: message.messages, url: message.url, site: message.site, tabId: sender.tab.id, tabClosed: false,
      sent: [...new Set([...(stored?.sent || []), ...message.sent])],
      changedAt: same ? stored.changedAt : Date.now(),        // the quiet timer counts from here
      version: (stored?.version || 0) + 1,
    });
    return true;
  });
  if (kept) advance(key);
}

async function onTabClosed(tabId) {
  for (const [name, snapshot] of await loadAll("snap:")) {
    if (snapshot.tabId !== tabId) continue;
    const key = name.slice("snap:".length);
    await serialized(name, async () => {
      const latest = await load(name);
      if (latest) await save(name, { ...latest, tabClosed: true, version: latest.version + 1 });
    });
    advance(key);
  }
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
// the open episode if the chat has gone quiet or its tab is closed, and drop the text.
async function settle(key) {
  for (;;) {
    const settings = await getSettings();
    const snapshot = await load(`snap:${key}`);
    let chat = await load(`chat:${key}`);
    if (!snapshot || !chat) return;
    const { userTurns, replies } = Episodes.splitTurns(snapshot.messages);
    let closed;
    ({ chat, closed } = Episodes.sync(chat, userTurns, new Set(snapshot.sent)));
    if (closed) await recordEpisode(chat, closed, userTurns, replies, snapshot);
    await save(`chat:${key}`, chat);

    if (chat.pending) {
      // a judgment is in flight: collect its label. The alarm resumes this loop if Chrome stops
      // the worker meanwhile (it does so after 30 s without events).
      chrome.alarms.create(`judge|${key}`, { delayInMinutes: 1 });
      const result = await collect(chat.pending.id, settings);
      if (result.state === "waiting") continue;
      if (result.state === "done") {
        ({ chat, closed } = Episodes.applyLabel(chat, chat.pending, result.label));
        if (closed) await recordEpisode(chat, closed, userTurns, replies, snapshot);
        await save(`chat:${key}`, chat);
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
      if (settings.paused) return;
      const id = await submit(job, chat, settings);
      if (!id) { chrome.alarms.create(`judge|${key}`, { delayInMinutes: RETRY_MINUTES }); return; }
      await save(`chat:${key}`, { ...chat, pending: { id, kind: job.kind, turn: job.turn } });
      continue;
    }

    // every turn on the page is settled
    chrome.alarms.clear(`judge|${key}`);
    if (chat.state === "episode") {
      const quietAt = snapshot.changedAt + settings.endQuietMinutes * 60000;
      if (!snapshot.tabClosed && Date.now() < quietAt) {
        chrome.alarms.create(`quiet|${key}`, { when: quietAt });
        return;
      }
      ({ chat, closed } = Episodes.closeOpen(chat, snapshot.tabClosed ? "tab_closed" : "quiet"));
      await recordEpisode(chat, closed, userTurns, replies, snapshot);
      await save(`chat:${key}`, chat);
    }
    // nothing needs the text any more: delete it, unless a newer snapshot came in meanwhile
    const deleted = await serialized(`snap:${key}`, async () => {
      if ((await load(`snap:${key}`))?.version !== snapshot.version) return false;
      await remove(`snap:${key}`);
      return true;
    });
    if (deleted) return;
  }
}

async function submit(job, chat, settings) {
  try {
    const response = await fetch(`${settings.serverUrl}/judge`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Study-Key": settings.studyKey },
      body: JSON.stringify({ participant_id: settings.participantId, site: chat.site, ...job }),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) return null;          // 503 = queue full
    return (await response.json()).id;
  } catch (error) {
    return null;                             // offline, or the server is asleep
  }
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

// ---------------- episodes and prompts ----------------
async function recordEpisode(chat, closed, userTurns, replies, snapshot) {
  // the id is derived from the episode itself, so recording it twice (the worker was stopped
  // between recording and saving the chat) keeps one copy
  const id = `${Episodes.hash(chat.key)}-${closed.start}-${closed.opening}`;
  if (await load(`episode:${id}`)) return;
  const settings = await getSettings();
  const openingText = userTurns[closed.opening - 1];
  // BITE links a later event to an earlier interaction by word overlap; here a new episode about
  // the same decision is linked to the earlier one, and the check-in mentions it
  const related = (await loadAll("episode:")).map(([, other]) => other)
    .filter((other) => other.openingText && Similarity.jaccard(openingText, other.openingText) >= settings.relatedThreshold)
    .map((other) => other.id);
  const episode = {
    id, chatKey: chat.key, site: chat.site, url: snapshot.url, tabId: snapshot.tabId,
    start: closed.start, opening: closed.opening, end: closed.end, closedBy: closed.closedBy, closedAt: Date.now(),
    messages: Episodes.episodeMessages(userTurns, replies, closed.start, closed.end), openingText, related,
    status: "pending",
  };
  await save(`episode:${id}`, episode);
  await count("episodes");
  await askToRate(episode);
  await updateBadge();
}

// The panel on the page where the chat was, or a notification when that tab is gone.
async function askToRate(episode) {
  const settings = await getSettings();
  try {
    const response = await chrome.tabs.sendMessage(episode.tabId, {
      type: "show_panel",
      episode: { id: episode.id, site: episode.site, openingText: episode.openingText, messages: episode.messages },
      settings: { shareDefault: settings.shareDefault, redactNames: settings.redactNames, followupDays: settings.followupDays },
    });
    if (response?.shown) return;
  } catch (error) { /* tab closed, or showing a page without the content script */ }
  // NOTE: [design thought] notifications never show conversation text (IRB protocol)
  chrome.notifications.create(`rate|${episode.id}`, {
    type: "basic", iconUrl: "icons/icon128.png", title: "Advice Tracker: a quick question",
    message: `A conversation on ${episode.site} looked like a request for advice. Click to answer a few questions (about 2 min).`,
  });
}

async function onRatingSubmitted(message) {
  const settings = await getSettings();
  const episode = await load(`episode:${message.id}`);
  if (!episode || episode.status !== "pending") return;
  const { messages, ...rest } = episode;          // the conversation's text is not kept any longer
  if (message.rating.share === "none") {
    // nothing is shared for this conversation, so there is nothing to follow up on either
    await save(`episode:${episode.id}`, { ...rest, openingText: "", status: "done", rating: { share: "none" } });
  } else {
    const dueAt = Date.now() + settings.followupDays * 24 * 3600 * 1000;
    await save(`episode:${episode.id}`, { ...rest, status: "rated", rating: message.rating, checkin: { dueAt, doneAt: null } });
    chrome.alarms.create(`checkin|${episode.id}`, { when: dueAt });
    await upload("episode_rating", {
      episode: episode.id, site: episode.site, turns: episode.end - episode.start + 1,
      opening_turn: episode.opening - episode.start + 1, closed_by: episode.closedBy, closed_at: episode.closedAt,
      rating: message.rating, transcript: message.rating.share === "full" ? message.transcript : null,
      related_earlier: episode.related.length,
    }, settings);
  }
  await count("rated");
  await updateBadge();
}

async function onCheckinSubmitted(message) {
  const settings = await getSettings();
  const episode = await load(`episode:${message.id}`);
  if (!episode || episode.status !== "rated") return;
  const later = (await loadAll("episode:")).filter(([, other]) => (other.related || []).includes(episode.id)).length;
  await save(`episode:${episode.id}`, { ...episode, openingText: "", status: "done",
                                        checkin: { ...episode.checkin, doneAt: Date.now() } });
  await upload("checkin", { episode: episode.id, site: episode.site, answers: message.answers, related_later: later }, settings);
  await count("checked_in");
  await updateBadge();
}

async function onNotAdvice(message) {
  const episode = await load(`episode:${message.id}`);
  if (!episode) return;
  await remove(`episode:${message.id}`);
  await count("not_advice");
  // a classifier error, with counts only: no text, no answers
  await upload("not_advice", { episode: episode.id, site: episode.site, turns: episode.end - episode.start + 1,
                               opening_turn: episode.opening - episode.start + 1, closed_by: episode.closedBy }, await getSettings());
  await updateBadge();
}

async function onDismissed(message) {
  if (!(await load(`episode:${message.id}`))) return;
  await remove(`episode:${message.id}`);          // skipped: its text is deleted right away
  await count("dismissed");
  await updateBadge();
}

// The extension icon shows how many episodes wait for an answer (ratings + due check-ins).
async function updateBadge() {
  const now = Date.now();
  const waiting = (await loadAll("episode:")).filter(([, episode]) =>
    episode.status === "pending" || (episode.status === "rated" && episode.checkin.dueAt <= now)).length;
  await chrome.action.setBadgeText({ text: waiting ? String(waiting) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#4f5bd5" });
}

// ---------------- uploads ----------------
async function upload(type, payload, settings) {
  const event = { type, participant_id: settings.participantId, sent_at: Date.now(), payload };
  if (settings.localOnly || !(await post(event, settings))) {
    await serialized("queue", async () => save("queue", [...((await load("queue")) || []), event]));
    chrome.alarms.create("flush", { delayInMinutes: 30 });
  }
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

async function flushQueue() {
  const settings = await getSettings();
  if (settings.localOnly) return;
  await serialized("queue", async () => {
    const remaining = [];
    for (const event of (await load("queue")) || []) if (!(await post(event, settings))) remaining.push(event);
    await save("queue", remaining);
    if (remaining.length) chrome.alarms.create("flush", { delayInMinutes: 30 });
  });
}

// Twice a day: the extension is still installed, with counts only (IRB protocol).
async function heartbeat() {
  const settings = await getSettings();
  const stats = (await load("stats")) || {};
  const episodes = (await loadAll("episode:")).map(([, episode]) => episode);
  await upload("heartbeat", {
    version: chrome.runtime.getManifest().version, paused: settings.paused, ...stats,
    waiting_rating: episodes.filter((episode) => episode.status === "pending").length,
    waiting_checkin: episodes.filter((episode) => episode.status === "rated").length,
  }, settings);
}

function openCheckin(query) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`ui/checkin.html${query}`) });
}

// ---------------- event wiring ----------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // NOTE: [design thought] answer at once and do the work in the background: a judgment can take
  // minutes, and a listener that keeps its caller waiting that long is stopped by Chrome
  sendResponse({ ok: true });
  switch (message.type) {
    case "snapshot": onSnapshot(message, sender); break;
    case "rating_submitted": onRatingSubmitted(message); break;
    case "checkin_submitted": onCheckinSubmitted(message); break;
    case "not_advice": onNotAdvice(message); break;
    case "rating_dismissed": onDismissed(message); break;
    case "rating_snoozed": chrome.alarms.create(`remind|${message.id}`, { delayInMinutes: 60 }); break;
    case "open_rating_tab": openCheckin(`?rate=${encodeURIComponent(message.id)}`); break;
    case "flush": flushQueue(); break;
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const [kind, name] = alarm.name.split("|");      // e.g. "quiet|chatgpt.com/<id>", "checkin|<episode>", "flush"
  if (kind === "judge" || kind === "quiet") advance(name);
  else if (kind === "remind") {
    const episode = await load(`episode:${name}`);
    if (episode?.status === "pending") await askToRate(episode);
  } else if (kind === "checkin") {
    chrome.notifications.create(`checkin|${name}`, {
      type: "basic", iconUrl: "icons/icon128.png", title: "Advice Tracker: two-week check-in",
      message: "How did it go? Tell us what you decided after asking an AI assistant for advice (about 5 min).",
      requireInteraction: true,
    });
    await updateBadge();
  } else if (kind === "flush") await flushQueue();
  else if (kind === "heartbeat") await heartbeat();
});

chrome.notifications.onClicked.addListener((id) => {
  const [kind, episodeId] = id.split("|");
  chrome.notifications.clear(id);
  openCheckin(kind === "rate" ? `?rate=${encodeURIComponent(episodeId)}` : `?checkin=${encodeURIComponent(episodeId)}`);
});

chrome.tabs.onRemoved.addListener((tabId) => { onTabClosed(tabId); });

// After a browser restart (alarms may be lost) or an update: look at every chat that still has text.
async function resumeAll() {
  for (const [name] of await loadAll("snap:")) advance(name.slice("snap:".length));
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await save("settings", settings);
  chrome.alarms.create("heartbeat", { periodInMinutes: 12 * 60 });
  if (!settings.participantId) chrome.runtime.openOptionsPage();
  await resumeAll();
});
chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create("heartbeat", { periodInMinutes: 12 * 60 });
  await resumeAll();
});
