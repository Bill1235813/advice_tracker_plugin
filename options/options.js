const FIELDS = ["participantId", "serverUrl", "studyKey", "followupDays", "endQuietMinutes"];
const DEFAULTS = { followupDays: 14, endQuietMinutes: 24 * 60, ratingMode: STUDY_CONFIG.ratingMode || "switching" };

async function load() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  for (const field of FIELDS) document.getElementById(field).value = settings[field] ?? DEFAULTS[field] ?? "";
  document.getElementById("excludedHosts").value = (settings.excludedHosts || []).join("\n");
  document.getElementById("redactNames").value = (settings.redactNames || []).join("\n");
  document.getElementById("localOnly").checked = !!settings.localOnly;
  document.getElementById("paused").checked = !!settings.paused;
  const mode = document.querySelector(`#rating-mode input[value="${settings.ratingMode || DEFAULTS.ratingMode}"]`);
  if (mode) mode.checked = true;
}

document.getElementById("save").onclick = async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const lines = (id) => document.getElementById(id).value.split("\n").map((s) => s.trim()).filter(Boolean);
  const next = {
    ...settings,
    participantId: document.getElementById("participantId").value.trim(),
    serverUrl: document.getElementById("serverUrl").value.trim().replace(/\/$/, ""),
    studyKey: document.getElementById("studyKey").value.trim(),
    followupDays: Number(document.getElementById("followupDays").value) || DEFAULTS.followupDays,
    endQuietMinutes: Number(document.getElementById("endQuietMinutes").value) || DEFAULTS.endQuietMinutes,
    excludedHosts: lines("excludedHosts"), redactNames: lines("redactNames"),
    localOnly: document.getElementById("localOnly").checked, paused: document.getElementById("paused").checked,
    ratingMode: document.querySelector("#rating-mode input:checked")?.value || DEFAULTS.ratingMode,
  };
  await chrome.storage.local.set({ settings: next });
  document.getElementById("saved").textContent = "saved";
  if (!next.localOnly) chrome.runtime.sendMessage({ type: "flush" });
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
};

load();
