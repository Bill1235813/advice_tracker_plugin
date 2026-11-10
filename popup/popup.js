async function refresh() {
  const stored = await chrome.storage.local.get(null);
  const settings = stored.settings || {}, stats = stored.stats || {};
  const episodes = Object.entries(stored).filter(([name]) => name.startsWith("episode:")).map(([, episode]) => episode);
  const now = Date.now();
  document.getElementById("n-found").textContent = stats.episodes || 0;
  // the same questions the badge on the icon counts (lib/modes.js; background.js updateBadge): one asked
  // through its site's queue only while its kind is on (a past one: while past conversations are read) and its
  // site not excluded (it cannot be asked else)
  const kindOn = (e) => e.source !== "past" || Boolean(settings.readPast);
  const askable = (e) => !Modes.viaQueue(e) || (Boolean(kindOn(e)) && !isExcluded(new URL(e.url).hostname, settings.excludedHosts || []));
  document.getElementById("n-pending").textContent = episodes.filter((e) => Modes.waiting(e) && askable(e)).length;
  // follow-up questions that wait (did you decide, did you act, the outcome questions: lib/modes.js followupStage)
  const end = Modes.studyEnd(stored, STUDY_CONFIG.studyDays);
  document.getElementById("n-due").textContent = episodes.filter((e) => Modes.followupAsks(Modes.followupStage(e, now, end))).length;
  document.getElementById("n-removed").textContent = stats.not_advice || 0;
  // past conversations found that can be annotated now (the follow-up time after the request), and the switch
  document.getElementById("n-past").textContent = episodes.filter((e) => askable(e) && Modes.queueDue(e, now, Modes.followupSeconds(settings))?.stage === "past").length;
  document.getElementById("history-note").innerHTML = `<a href="#" id="history-link">${settings.readPast
    ? "Past conversations: on (change)" : "Past conversations ($2 each): turn on"}</a>`;
  document.getElementById("history-link").onclick = (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#history") });
  };
  const status = document.getElementById("status");
  if (settings.participantId) {
    status.innerHTML = "<div>Participant <b></b></div>";
    status.querySelector("b").textContent = settings.participantId;
    status.firstChild.insertAdjacentHTML("beforeend", ` · ${{ frequent: "Frequent", periodical: "Periodical", combined: "Combined" }[settings.ratingMode] || "Switching"} mode`);
    if (settings.paused) status.firstChild.insertAdjacentHTML("beforeend", ' · <span class="warn">paused</span>');
  } else {
    status.innerHTML = '<div class="warn">No participant ID set: open Settings.</div>';
  }
  // sites where Chrome withholds the extension's access: nothing is captured there
  const blocked = [];
  for (const match of chrome.runtime.getManifest().content_scripts[0].matches.filter((m) => m.startsWith("https://"))) {
    if (!(await chrome.permissions.contains({ origins: [match] }))) blocked.push(new URL(match.replace("*", "")).hostname);
  }
  if (blocked.length) {
    status.insertAdjacentHTML("beforeend", `<div class="warn">No access to ${blocked.join(", ")}: allow it under ` +
                                           "chrome://extensions → Advice Tracker → Details → Site access.</div>");
  }
  document.getElementById("pause").textContent = settings.paused ? "Resume tracking" : "Pause tracking";
}

document.getElementById("open-checkin").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("ui/checkin.html") });
document.getElementById("open-outcomes").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("ui/outcomes.html") });
document.getElementById("options").onclick = () => chrome.runtime.openOptionsPage();
document.getElementById("pause").onclick = async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  // pausedAt: since when tracking is paused (the heartbeat reports it)
  await chrome.storage.local.set({ settings: { ...settings, paused: !settings.paused, pausedAt: settings.paused ? null : Date.now() } });
  refresh();
};
document.getElementById("debug").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const out = document.getElementById("debug-out");
  out.hidden = false;
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "debug_capture" });
    // the count the background keeps for the chat (it stays when the page moves to another chat
    // and back); the page's own count, if the latest messages are not stored yet
    const stored = await chrome.storage.local.get(null);
    const chatKey = stored[`alias:${result.key}`] || result.key;
    const captured = Math.max((stored[`sent:${chatKey}`] || []).length, result.sent);
    out.textContent = `${result.site} · ${result.key}${result.aliasOf ? ` (was ${result.aliasOf})` : ""} · ` +
      `${captured} of your messages captured in this conversation\n` +
      (result.messages.length ? result.messages.map((m) => `${m.role}: ${m.content.slice(0, 160)}`).join("\n")
                              : "No messages found on this page.");
  } catch (error) {
    out.textContent = "This tab is not a supported chat site (or the page has not finished loading).";
  }
};

// Feedback on the study (0.6.12), in the participant's own words: the background redacts it, as every text, and
// sends it (background.js onFeedback).
// NOTE: [design thought] a click outside closes the popup, so the draft is kept while the browser runs
// (chrome.storage.session, in memory only; "Delete all data" clears it too) and comes back when it reopens
const feedbackBox = document.getElementById("feedback-box"), feedbackText = document.getElementById("feedback-text");
const feedbackSend = document.getElementById("feedback-send"), feedbackStatus = document.getElementById("feedback-status");
document.getElementById("feedback").onclick = () => {
  feedbackBox.hidden = !feedbackBox.hidden;
  if (!feedbackBox.hidden) feedbackText.focus();
};
feedbackText.oninput = () => chrome.storage.session.set({ feedbackDraft: feedbackText.value });
feedbackSend.onclick = async () => {
  const text = feedbackText.value.trim();
  if (!text) {
    feedbackStatus.textContent = "Please write your feedback first.";
    return;
  }
  feedbackSend.disabled = true;               // (one feedback per click, even on a double click)
  const reply = await chrome.runtime.sendMessage({ type: "feedback", text });
  const { settings = {} } = await chrome.storage.local.get("settings");
  feedbackText.value = "";
  await chrome.storage.session.remove("feedbackDraft");
  feedbackSend.disabled = false;
  feedbackStatus.textContent = reply?.sent ? "Thank you: sent to the study team."
    : settings.participantId ? "Thank you: it will be sent as soon as the study server can be reached."
    : "Thank you: it will be sent once you save your participant ID in Settings.";
};
chrome.storage.session.get("feedbackDraft").then(({ feedbackDraft }) => {
  if (!feedbackDraft) return;
  feedbackText.value = feedbackDraft;
  feedbackBox.hidden = false;
});
refresh();
