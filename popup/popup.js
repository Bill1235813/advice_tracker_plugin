async function refresh() {
  const stored = await chrome.storage.local.get(null);
  const settings = stored.settings || {}, stats = stored.stats || {};
  const episodes = Object.entries(stored).filter(([name]) => name.startsWith("episode:")).map(([, episode]) => episode);
  const now = Date.now();
  document.getElementById("n-found").textContent = stats.episodes || 0;
  // the same questions the badge on the icon counts (lib/modes.js)
  document.getElementById("n-pending").textContent = episodes.filter(Modes.waiting).length;
  document.getElementById("n-due").textContent = episodes.filter((e) => Modes.checkinDue(e, now)).length;
  document.getElementById("n-removed").textContent = stats.not_advice || 0;
  // past conversations found that can be annotated now (followupDays after the request), and the switch
  document.getElementById("n-past").textContent = episodes.filter((e) => Modes.queueDue(e, now, settings.followupDays ?? 14)?.stage === "past").length;
  document.getElementById("history-note").innerHTML = `<a href="#" id="history-link">${settings.readPast || settings.readApps
    ? "Past and other-device conversations: on (change)" : "New: past conversations ($2 each) and other devices: turn on"}</a>`;
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
refresh();
