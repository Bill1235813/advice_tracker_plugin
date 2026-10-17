const FIELDS = ["participantId", "serverUrl", "studyKey", "followupDays", "endQuietMinutes"];
const DEFAULTS = { followupDays: 14, endQuietMinutes: 24 * 60, ratingMode: STUDY_CONFIG.ratingMode || "switching" };

async function load() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  for (const field of FIELDS) document.getElementById(field).value = settings[field] ?? DEFAULTS[field] ?? "";
  document.getElementById("excludedHosts").value = (settings.excludedHosts || []).join("\n");
  document.getElementById("redactNames").value = (settings.redactNames || []).join("\n");
  document.getElementById("paused").checked = !!settings.paused;
  // NOTE: [design thought] "I agree" is never ticked in advance: turning an option on needs a tick each time
  document.getElementById("readPast").checked = !!settings.readPast;
  document.getElementById("readApps").checked = !!settings.readApps;
  document.getElementById("agree").checked = false;
  shown = { readPast: !!settings.readPast, readApps: !!settings.readApps };
  const mode = document.querySelector(`#rating-mode input[value="${settings.ratingMode || DEFAULTS.ratingMode}"]`);
  if (mode) mode.checked = true;
  // what "Hold my answers on this computer" (before 0.5) held back
  const { held = [] } = await chrome.storage.local.get("held");
  document.getElementById("held").hidden = !held.length;
  document.getElementById("held-count").textContent = `${held.length} upload(s)`;
}

// What the reading options were when this page last showed them: a Save writes an option only if the
// participant changed its box since
let shown = { readPast: false, readApps: false };

// NOTE: [edge case callout] the popup can pause or resume tracking while this page is open, and an
// invitation, a card or "Delete all data" can turn the reading options off: the boxes follow, so a later
// Save here does not quietly undo it
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings?.newValue) return;
  const settings = changes.settings.newValue;
  document.getElementById("paused").checked = Boolean(settings.paused);
  for (const field of ["readPast", "readApps"]) {
    if (Boolean(settings[field]) === shown[field]) continue;
    document.getElementById(field).checked = Boolean(settings[field]);
    shown[field] = Boolean(settings[field]);
  }
});

for (const [id, send] of [["held-send", true], ["held-delete", false]]) {
  document.getElementById(id).onclick = async () => {
    await chrome.runtime.sendMessage({ type: "held", send });
    document.getElementById("held").hidden = true;
  };
}

document.getElementById("save").onclick = async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const lines = (id) => document.getElementById(id).value.split("\n").map((s) => s.trim()).filter(Boolean);
  const paused = document.getElementById("paused").checked;
  // NOTE: [design thought] reading past or other-device conversations needs the participant's
  // agreement to the text above; turning an option off needs nothing (the background then deletes
  // what it found that was not answered, and reports the change)
  const box = (field) => document.getElementById(field).checked;
  const readPast = box("readPast") !== shown.readPast ? box("readPast") : Boolean(settings.readPast);
  const readApps = box("readApps") !== shown.readApps ? box("readApps") : Boolean(settings.readApps);
  const turnsOn = (readPast && !settings.readPast) || (readApps && !settings.readApps);
  if (turnsOn && !document.getElementById("agree").checked) {
    alert('Please read the text about past conversations and other devices, and tick "I have read the above and agree" to turn them on.');
    return;
  }
  // since when tracking is paused (the heartbeat reports it): kept while it stays paused
  const pausedAt = !paused ? null : (settings.paused && settings.pausedAt) || Date.now();
  const next = {
    ...settings,
    participantId: document.getElementById("participantId").value.trim(),
    serverUrl: document.getElementById("serverUrl").value.trim().replace(/\/$/, ""),
    studyKey: document.getElementById("studyKey").value.trim(),
    followupDays: Number(document.getElementById("followupDays").value) || DEFAULTS.followupDays,
    endQuietMinutes: Number(document.getElementById("endQuietMinutes").value) || DEFAULTS.endQuietMinutes,
    excludedHosts: lines("excludedHosts").map(siteOf).filter(Boolean),          // lib/sites.js: "https://www.Claude.ai/new" -> "claude.ai"
    redactNames: lines("redactNames"),
    paused, pausedAt, readPast, readApps,
    ratingMode: document.querySelector("#rating-mode input:checked")?.value || DEFAULTS.ratingMode,
  };
  await chrome.storage.local.set({ settings: next });
  document.getElementById("saved").textContent = "saved";
  load();                     // the sites as they were saved
  chrome.runtime.sendMessage({ type: "flush" });
};

document.getElementById("export").onclick = async () => {
  const data = await chrome.storage.local.get(null);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `advice-tracker-export-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
};

document.getElementById("delete").onclick = async () => {
  if (!confirm("Delete every conversation, answer and queued upload stored by the extension on this computer?")) return;
  // NOTE: [design thought] the background worker deletes, so a judgment it is running cannot
  // write anything back afterwards
  await chrome.runtime.sendMessage({ type: "delete_all" });
  alert("Deleted.");
  load();              // (the reading options are off now)
};

load();
