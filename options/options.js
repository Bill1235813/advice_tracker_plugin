const FIELDS = ["participantId", "serverUrl", "studyKey", "endQuietMinutes"];
const DEFAULTS = { followupSeconds: 7 * 24 * 3600, endQuietMinutes: 7 * 24 * 60, ratingMode: STUDY_CONFIG.ratingMode || "combined" };

// NOTE: [design thought] the research team's settings (the study server and key, the follow-up and quiet times)
// are hidden from participants (0.6.12): their values still load and save with the rest. The team opens
// options.html?advanced to see and change them for a test.
const forTeam = new URLSearchParams(location.search).has("advanced");
document.getElementById("advanced").hidden = !forTeam;
document.getElementById("advanced").open = forTeam;

async function load() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  for (const field of FIELDS) document.getElementById(field).value = settings[field] ?? DEFAULTS[field] ?? "";
  // (lib/modes.js: settings saved before 0.6.1 hold the follow-up time in days)
  document.getElementById("followupSeconds").value = Modes.followupSeconds(settings);
  document.getElementById("excludedHosts").value = (settings.excludedHosts || []).join("\n");
  document.getElementById("redactNames").value = (settings.redactNames || []).join("\n");
  document.getElementById("paused").checked = !!settings.paused;
  showPauseRules();
  document.getElementById("readPast").checked = !!settings.readPast;
  const mode = document.querySelector(`#rating-mode input[value="${settings.ratingMode || DEFAULTS.ratingMode}"]`);
  if (mode) mode.checked = true;
  // what "Hold my answers on this computer" (before 0.5) held back
  const { held = [] } = await chrome.storage.local.get("held");
  document.getElementById("held").hidden = !held.length;
  document.getElementById("held-count").textContent = `${held.length} upload(s)`;
}

// The study's rules for a pause (0.6.14) are on the page while the box is ticked: before Save pauses, and while paused
function showPauseRules() {
  document.getElementById("pause-rules").hidden = !document.getElementById("paused").checked;
}
document.getElementById("paused").onchange = showPauseRules;

// NOTE: [edge case callout] the popup can pause or resume tracking while this page is open, and an
// invitation, a card or "Delete all data" can turn reading past conversations off: the boxes follow, so a
// later Save here does not quietly undo it
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings?.newValue) return;
  const settings = changes.settings.newValue;
  document.getElementById("paused").checked = Boolean(settings.paused);
  showPauseRules();
  document.getElementById("readPast").checked = Boolean(settings.readPast);
});

// NOTE: [design thought] one click agrees to reading past conversations, next to the text it agrees to (0.6.11):
// the box saves itself at once, with no separate "I agree" box and no Save. Another click stops it (the
// background then deletes the past conversations found and not annotated, and reports the change). Only this
// field is written, onto the settings as stored now, so other fields typed on the page wait for Save.
document.getElementById("readPast").onchange = async (event) => {
  const readPast = event.target.checked;
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, readPast } });
  document.getElementById("past-saved").textContent = readPast ? "on, saved" : "off, saved";
};

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
  // NOTE: [edge case callout] the field's min="1" does not stop a click on Save: a negative or zero time
  // would make every check-in due at once and delete every unanswered question at the next start
  const followupSeconds = Math.round(Number(document.getElementById("followupSeconds").value));
  if (!(followupSeconds >= 1)) {
    alert("Please enter the follow-up time as a whole number of seconds, 1 or more (604800 = 7 days).");
    return;
  }
  // (the same for the quiet time: zero or less would end every advice conversation as soon as it opens;
  // an empty field keeps the default)
  const quietField = document.getElementById("endQuietMinutes").value.trim();
  const endQuietMinutes = quietField === "" ? DEFAULTS.endQuietMinutes : Math.round(Number(quietField));
  if (!(endQuietMinutes >= 1 && endQuietMinutes <= 10080)) {
    alert("Please enter the minutes without activity as a whole number from 1 to 10080 (10080 = 7 days).");
    return;
  }
  // since when tracking is paused (the heartbeat reports it): kept while it stays paused
  const pausedAt = !paused ? null : (settings.paused && settings.pausedAt) || Date.now();
  const next = {
    ...settings,
    participantId: document.getElementById("participantId").value.trim(),
    serverUrl: document.getElementById("serverUrl").value.trim().replace(/\/$/, ""),
    studyKey: document.getElementById("studyKey").value.trim(),
    followupSeconds,
    endQuietMinutes,
    excludedHosts: lines("excludedHosts").map(siteOf).filter(Boolean),          // lib/sites.js: "https://www.Claude.ai/new" -> "claude.ai"
    redactNames: lines("redactNames"),
    paused, pausedAt,                // (reading past conversations is saved by its own box, and stays as stored)
    ratingMode: document.querySelector("#rating-mode input:checked")?.value || DEFAULTS.ratingMode,
  };
  delete next.followupDays;          // (days, before 0.6.1: followupSeconds replaces it)
  delete next.readApps;              // (the switch for other devices, before 0.6.11: they are always read)
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
  load();              // (reading past conversations is off now)
};

load();
