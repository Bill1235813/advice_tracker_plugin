async function refresh() {
  const { settings = {}, conversations = {}, stats = {} } = await chrome.storage.local.get(["settings", "conversations", "stats"]);
  const rows = Object.values(conversations);
  const now = Date.now();
  document.getElementById("n-advice").textContent = rows.filter((c) => ["classified", "rated", "done"].includes(c.status)).length;
  document.getElementById("n-pending").textContent = rows.filter((c) => c.status === "classified").length;
  document.getElementById("n-due").textContent = rows.filter((c) => c.status === "rated" && c.followup && !c.followup.doneAt && c.followup.dueAt <= now).length;
  document.getElementById("n-discarded").textContent = stats.discarded || 0;
  document.getElementById("status").innerHTML = settings.participantId
    ? `<div>Participant <b>${settings.participantId}</b>${settings.paused ? ' · <span class="warn">paused</span>' : ""}${settings.localOnly ? " · local-only" : ""}</div>`
    : '<div class="warn">No participant ID set - open Settings.</div>';
  document.getElementById("pause").textContent = settings.paused ? "Resume tracking" : "Pause tracking";
}

document.getElementById("open-checkin").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("ui/checkin.html?followup=all") });
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
    out.textContent = `${result.site} · ${result.key}\n` + result.messages.map((m) => `${m.role}: ${m.content.slice(0, 160)}`).join("\n");
  } catch (error) {
    out.textContent = "This tab is not a supported chat site (or the page has not finished loading).";
  }
};
refresh();
