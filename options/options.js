const FIELDS = ["participantId", "serverUrl", "studyKey", "followupDays", "idleMinutes"];

async function load() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  for (const field of FIELDS) document.getElementById(field).value = settings[field] ?? "";
  document.getElementById("excludedHosts").value = (settings.excludedHosts || []).join("\n");
  document.getElementById("redactNames").value = (settings.redactNames || []).join("\n");
  document.getElementById("localOnly").checked = !!settings.localOnly;
  document.getElementById("paused").checked = !!settings.paused;
  for (const box of document.querySelectorAll("#domains input")) box.checked = (settings.trackedDomains || []).includes(box.value);
  const share = document.querySelector(`#share-default input[value="${settings.shareDefault || "ask"}"]`);
  if (share) share.checked = true;
}

document.getElementById("save").onclick = async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const lines = (id) => document.getElementById(id).value.split("\n").map((s) => s.trim()).filter(Boolean);
  const next = {
    ...settings,
    participantId: document.getElementById("participantId").value.trim(),
    serverUrl: document.getElementById("serverUrl").value.trim().replace(/\/$/, ""),
    studyKey: document.getElementById("studyKey").value.trim(),
    followupDays: Number(document.getElementById("followupDays").value) || 14,
    idleMinutes: Number(document.getElementById("idleMinutes").value) || 1,
    excludedHosts: lines("excludedHosts"), redactNames: lines("redactNames"),
    localOnly: document.getElementById("localOnly").checked, paused: document.getElementById("paused").checked,
    trackedDomains: Array.from(document.querySelectorAll("#domains input:checked")).map((box) => box.value),
    shareDefault: document.querySelector("#share-default input:checked")?.value || "ask",
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
  if (!confirm("Delete every conversation, rating and queued upload stored by the extension on this computer?")) return;
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ settings });
  alert("Deleted.");
};

load();
