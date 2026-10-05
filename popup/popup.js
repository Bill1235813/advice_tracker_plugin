async function refresh() {
  const stored = await chrome.storage.local.get(null);
  const settings = stored.settings || {}, stats = stored.stats || {};
  const episodes = Object.entries(stored).filter(([name]) => name.startsWith("episode:")).map(([, episode]) => episode);
  const now = Date.now();
  document.getElementById("n-found").textContent = stats.episodes || 0;
  document.getElementById("n-pending").textContent = episodes.filter((e) => e.status === "pending").length;
  document.getElementById("n-due").textContent = episodes.filter((e) => e.status === "rated" && e.checkin.dueAt <= now).length;
  document.getElementById("n-removed").textContent = (stats.not_advice || 0) + (stats.dismissed || 0);
  const status = document.getElementById("status");
  if (settings.participantId) {
    status.innerHTML = "<div>Participant <b></b></div>";
    status.querySelector("b").textContent = settings.participantId;
    if (settings.paused) status.firstChild.insertAdjacentHTML("beforeend", ' · <span class="warn">paused</span>');
  } else {
    status.innerHTML = '<div class="warn">No participant ID set: open Settings.</div>';
  }
  document.getElementById("pause").textContent = settings.paused ? "Resume tracking" : "Pause tracking";
}

document.getElementById("open-checkin").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("ui/checkin.html?checkin=all") });
document.getElementById("options").onclick = () => chrome.runtime.openOptionsPage();
document.getElementById("pause").onclick = async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, paused: !settings.paused } });
  refresh();
};
document.getElementById("debug").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const out = document.getElementById("debug-out");
  out.hidden = false;
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "debug_capture" });
    out.textContent = `${result.site} · ${result.key}${result.aliasOf ? ` (was ${result.aliasOf})` : ""} · ${result.sent} turn(s) sent here\n` +
      result.messages.map((m) => `${m.role}: ${m.content.slice(0, 160)}`).join("\n");
  } catch (error) {
    out.textContent = "This tab is not a supported chat site (or the page has not finished loading).";
  }
};
refresh();
