// Background service worker: the only place that stores data, talks to the study server,
// and decides when to prompt. Pipeline per conversation (mirrors BITE, Fig. 1):
//   snapshot from the page -> idle for IDLE_MINUTES -> /classify (user turns only)
//   -> seeking_advice in a tracked domain? -> in-situ rating panel on the page
//   -> follow-up notification followupDays later -> ui/checkin.html
// Conversations that are not advice requests are deleted as soon as the label comes back.
importScripts("config.js", "lib/redact.js", "lib/similarity.js");

const DEFAULT_SETTINGS = {
  participantId: "", serverUrl: STUDY_CONFIG.serverUrl, studyKey: STUDY_CONFIG.studyKey, paused: false, localOnly: false,
  followupDays: 14, idleMinutes: 1, trackedDomains: ["relationships", "health", "career"],
  shareDefault: "ask",     // "full" | "ratings" | "ask": chosen once in the settings page
  excludedHosts: [], redactNames: [], relatedThreshold: 0.5,
};

// ---------------- storage helpers ----------------
async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function getConversations() {
  const { conversations } = await chrome.storage.local.get("conversations");
  return conversations || {};
}
async function saveConversation(conversation) {
  const conversations = await getConversations();
  conversations[conversation.key] = conversation;
  await chrome.storage.local.set({ conversations });
}
async function deleteConversation(key) {
  const conversations = await getConversations();
  delete conversations[key];
  const { stats } = await chrome.storage.local.get("stats");
  const next = { ...(stats || {}), discarded: ((stats || {}).discarded || 0) + 1 };
  await chrome.storage.local.set({ conversations, stats: next });
}

// ---------------- capture ----------------
async function onSnapshot(message, sender) {
  const settings = await getSettings();
  const host = new URL(message.url).hostname;
  if (settings.paused || settings.excludedHosts.includes(host)) return;
  const conversations = await getConversations();
  const firstUserMessage = message.messages.find((m) => m.role === "user")?.content;
  let initialMessageCount = message.messages.length;
  for (const other of Object.values(conversations)) {
    // NOTE: [edge case callout] chat URLs change after the first message (chatgpt.com/ ->
    // chatgpt.com/c/<id>), so the same chat can arrive under two keys; the earlier generic
    // entry with the same opening message is superseded by this one
    if (other.key !== message.key && other.site === message.site && ["captured", "classified"].includes(other.status)
        && other.messages?.find((m) => m.role === "user")?.content === firstUserMessage) {
      initialMessageCount = Math.min(initialMessageCount, other.initialMessageCount ?? initialMessageCount);
      delete conversations[other.key];
      chrome.alarms.clear(`classify|${other.key}`);
    }
  }
  // NOTE: [design thought] a conversation counts only if it grows while the extension is
  // watching: opening an old chat from the sidebar shows its messages, but nothing new is
  // asked, so it is never classified. Continuing an old chat does count (and the whole thread
  // is then the conversation).
  const existing = conversations[message.key] || { key: message.key, site: message.site, firstSeen: message.capturedAt,
                                                   status: "captured", initialMessageCount };
  if (existing.status === "done") return;
  existing.url = message.url;
  existing.tabId = sender.tab?.id;
  existing.messages = message.messages;
  existing.userText = message.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  existing.updatedAt = message.capturedAt;
  conversations[message.key] = existing;
  await chrome.storage.local.set({ conversations });
  // (re)classify once the exchange has been quiet for a while, or right away when the user leaves
  if (existing.status === "captured" || existing.status === "classified") {
    // NOTE: [edge case callout] chrome.alarms cannot fire sooner than 30 s, so the "user left
    // the tab" case classifies directly instead of through an alarm
    if (message.reason === "idle") await classify(message.key);
    else chrome.alarms.create(`classify|${message.key}`, { delayInMinutes: Math.max(settings.idleMinutes, 0.5) });
  }
}

// ---------------- classification ----------------
const CLASSIFY_TIMEOUT_MS = 10 * 60 * 1000;   // the server queues requests FIFO; a busy pilot can take minutes
const inFlight = new Set();                   // conversation keys with a /classify request running

async function classify(key) {
  if (inFlight.has(key)) return;              // an alarm and an idle snapshot can both ask
  inFlight.add(key);
  try { await classifyOnce(key); } finally { inFlight.delete(key); }
}

async function classifyOnce(key) {
  const settings = await getSettings();
  const conversation = (await getConversations())[key];
  if (!conversation || !conversation.userText) return;
  const messageCount = conversation.messages.length;
  if (messageCount <= (conversation.initialMessageCount ?? 0)) return;   // a past conversation that was only opened
  if (conversation.classification && conversation.classification.messageCount === messageCount) return;
  const userTurns = conversation.messages.filter((m) => m.role === "user").map((m) => m.content);
  let result;
  try {
    // NOTE: [design thought] only the user's turns are sent for the intent decision, the same
    // input the ShareChat judge used; the assistant's replies stay on the device unless the
    // participant later chooses to share the conversation.
    const response = await fetch(`${settings.serverUrl}/classify`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Study-Key": settings.studyKey },
      body: JSON.stringify({ participant_id: settings.participantId, site: conversation.site, user_turns: userTurns }),
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`server ${response.status}`);   // 503 = queue full
    result = await response.json();
  } catch (error) {
    chrome.alarms.create(`classify|${key}`, { delayInMinutes: 10 });   // unreachable, busy or timed out: retry later
    return;
  }
  conversation.classification = { ...result, classifiedAt: Date.now(), messageCount };
  const tracked = result.intent === "seeking_advice" && settings.trackedDomains.includes(result.domain);
  if (!tracked) {
    // keep only a count for non-advice conversations; the text is dropped immediately
    if (conversation.status !== "rated") await deleteConversation(key);
    return;
  }
  conversation.status = conversation.status === "rated" ? "rated" : "classified";
  conversation.domain = result.domain;
  conversation.related = await findRelated(conversation, settings);
  await saveConversation(conversation);
  if (conversation.status === "classified") await promptRating(conversation, settings);
}

async function findRelated(conversation, settings) {
  // BITE links a later event to an earlier interaction by Jaccard overlap; here a new advice
  // conversation about the same decision counts as a downstream event for the earlier one
  const related = [];
  for (const other of Object.values(await getConversations())) {
    if (other.key === conversation.key || other.status === "captured" || !other.userText) continue;
    if (Similarity.jaccard(conversation.userText, other.userText) >= settings.relatedThreshold) related.push(other.key);
  }
  return related;
}

async function promptRating(conversation, settings) {
  const payload = { key: conversation.key, site: conversation.site, domain: conversation.domain,
    reasoning: conversation.classification.reasoning, messages: conversation.messages };
  const tabs = await chrome.tabs.query({ url: conversation.url.split("#")[0] + "*" });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "show_rating", conversation: payload, settings });
      return;
    } catch (error) { /* tab has no content script (navigated away); fall through */ }
  }
  chrome.notifications.create(`rate|${conversation.key}`, {
    type: "basic", iconUrl: "icons/icon128.png", title: "Advice Tracker: quick check-in",
    message: `Your ${conversation.site} conversation about ${conversation.domain} looked like an advice request. Click to rate it (2 min).`,
  });
}

// ---------------- ratings, follow-ups, uploads ----------------
async function onRatingSubmitted(message) {
  const settings = await getSettings();
  const conversation = (await getConversations())[message.key];
  if (!conversation) return;
  conversation.rating = message.rating;
  conversation.sharedTranscript = message.transcript;    // already redacted + user-edited, or null
  conversation.status = "rated";
  conversation.followup = { dueAt: Date.now() + settings.followupDays * 24 * 3600 * 1000, doneAt: null };
  if (message.rating.share === "none") delete conversation.messages;
  await saveConversation(conversation);
  chrome.alarms.create(`followup|${message.key}`, { when: conversation.followup.dueAt });
  await upload("rating", {
    key: message.key, site: conversation.site, domain: conversation.domain, url: conversation.url,
    classification: conversation.classification, rating: message.rating,
    transcript: message.transcript, related: conversation.related, num_messages: conversation.messages?.length,
  }, settings);
}

async function onFollowupSubmitted(message) {
  const settings = await getSettings();
  const conversation = (await getConversations())[message.key];
  if (!conversation) return;
  conversation.followup = { ...(conversation.followup || {}), doneAt: Date.now(), answers: message.answers };
  conversation.status = "done";
  delete conversation.messages;     // nothing left to do with the text; keep the labels
  await saveConversation(conversation);
  await upload("followup", { key: message.key, site: conversation.site, domain: conversation.domain,
    answers: message.answers, rating: conversation.rating }, settings);
}

async function upload(type, payload, settings) {
  const event = { type, participant_id: settings.participantId, sent_at: Date.now(), payload };
  if (settings.localOnly) { await enqueue(event); return; }
  try {
    const response = await fetch(`${settings.serverUrl}/events`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Study-Key": settings.studyKey },
      body: JSON.stringify(event) });
    if (!response.ok) throw new Error(response.statusText);
  } catch (error) {
    await enqueue(event);
    chrome.alarms.create("flush", { delayInMinutes: 30 });
  }
}
async function enqueue(event) {
  const { queue } = await chrome.storage.local.get("queue");
  await chrome.storage.local.set({ queue: [...(queue || []), event] });
}
async function flushQueue() {
  const settings = await getSettings();
  if (settings.localOnly) return;
  const { queue } = await chrome.storage.local.get("queue");
  const remaining = [];
  for (const event of queue || []) {
    try {
      const response = await fetch(`${settings.serverUrl}/events`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Study-Key": settings.studyKey },
        body: JSON.stringify(event) });
      if (!response.ok) remaining.push(event);
    } catch (error) { remaining.push(event); }
  }
  await chrome.storage.local.set({ queue: remaining });
  if (remaining.length) chrome.alarms.create("flush", { delayInMinutes: 30 });
}

function openCheckin(query) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`ui/checkin.html${query}`) });
}

// ---------------- event wiring ----------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "snapshot": await onSnapshot(message, sender); break;
      case "rating_submitted": await onRatingSubmitted(message); break;
      case "followup_submitted": await onFollowupSubmitted(message); break;
      case "rating_snoozed": chrome.alarms.create(`remind|${message.key}`, { delayInMinutes: 60 }); break;
      case "rating_dismissed": {
        const conversation = (await getConversations())[message.key];
        if (conversation) { conversation.status = "dismissed"; delete conversation.messages; await saveConversation(conversation); }
        break;
      }
      case "not_advice": {
        const conversation = (await getConversations())[message.key];
        await upload("misclassification", { key: message.key, classification: conversation?.classification }, await getSettings());
        await deleteConversation(message.key);
        break;
      }
      case "classify_now": await classify(message.key); break;
      case "open_rating_tab": openCheckin(`?rate=${encodeURIComponent(message.key)}`); break;
      case "flush": await flushQueue(); break;
    }
    sendResponse({ ok: true });
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const [kind, key] = alarm.name.split("|");
  if (kind === "classify") await classify(key);
  else if (kind === "remind") { const c = (await getConversations())[key]; if (c && c.status === "classified") await promptRating(c, await getSettings()); }
  else if (kind === "followup") {
    chrome.notifications.create(`followup|${key}`, {
      type: "basic", iconUrl: "icons/icon128.png", title: "Advice Tracker: two-week follow-up",
      message: "How did it go? Tell us what you decided after asking the AI assistant for advice (5 min).",
      requireInteraction: true,
    });
  } else if (kind === "flush") await flushQueue();
  else if (kind === "heartbeat") await heartbeat();
});

async function heartbeat() {
  const settings = await getSettings();
  const { conversations = {}, stats = {} } = await chrome.storage.local.get(["conversations", "stats"]);
  const rows = Object.values(conversations);
  await upload("heartbeat", {
    version: chrome.runtime.getManifest().version, paused: settings.paused,
    advice: rows.filter((c) => ["classified", "rated", "done"].includes(c.status)).length,
    pending_rating: rows.filter((c) => c.status === "classified").length,
    discarded: stats.discarded || 0,
  }, settings);
}

chrome.notifications.onClicked.addListener((id) => {
  const [kind, key] = id.split("|");
  chrome.notifications.clear(id);
  openCheckin(kind === "rate" ? `?rate=${encodeURIComponent(key)}` : `?followup=${encodeURIComponent(key)}`);
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.local.set({ settings });
  chrome.alarms.create("heartbeat", { periodInMinutes: 12 * 60 });
  if (!settings.participantId) chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("heartbeat", { periodInMinutes: 12 * 60 }));
