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
  // (and the updates the participant was offered and did not give, 0.6.18: lib/modes.js updateMissed)
  document.getElementById("n-pending").textContent = episodes.filter((e) => (Modes.waiting(e) && askable(e)) || Modes.updateMissed(e)).length;
  // follow-ups that have begun and are not finished, as the outcomes page lists them and its reminder counts them
  // (did you decide, did you act, the outcome questions, or a wait for one of these: lib/modes.js followupOpen)
  const end = Modes.studyEnd(stored, STUDY_CONFIG.studyDays);
  document.getElementById("n-due").textContent = episodes.filter((e) => Modes.followupOpen(Modes.followupStage(e, now, end))).length;
  // where the participant is in the study: its weeks count from when they joined (lib/modes.js studyDay), new advice
  // conversations are collected in the first three, open ones followed in the fourth, everything is due in the fifth
  const days = (now - Modes.studyDay(stored, 0)) / 86400000;
  const week = document.getElementById("study-week");
  if (!(days >= 0)) week.textContent = "";                // (no participant ID yet)
  else if (days >= STUDY_CONFIG.studyDays) week.textContent = "The study's five weeks are over. Thank you!";
  else {
    const doing = days >= STUDY_CONFIG.continueDays ? `all outcome questions are due by ${new Date(end).toLocaleDateString()}`
      : days >= STUDY_CONFIG.newAdviceDays ? "no new advice conversations are collected; follow-ups go on"
      : "advice conversations are collected";
    week.textContent = `Study week ${Math.floor(days / 7) + 1} of ${STUDY_CONFIG.studyDays / 7}: ${doing}.`;
  }
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
  // Messages from the study team (0.6.15, background.js): each one that is not read yet, with its OK; the
  // messages page lists them all. The team's words are set as text, never as HTML.
  const unread = (stored.teamMessages || []).filter((message) => !message.readAt);
  document.getElementById("team-messages").replaceChildren(...unread.map((message) => {
    const item = document.createElement("div");
    item.className = "team";
    item.innerHTML = '<b></b><div class="text"></div><button class="primary">OK, I have read it</button>';
    item.querySelector("b").textContent = message.title || "A message from the study team";
    item.querySelector(".text").textContent = message.text;
    item.querySelector("button").onclick = async () => {
      await chrome.runtime.sendMessage({ type: "message_read", id: message.id, where: "popup" });
      refresh();
    };
    return item;
  }));
  document.getElementById("messages").textContent = `Messages from the study team${unread.length ? ` (${unread.length} new)` : ""}`;
}

document.getElementById("open-checkin").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("ui/checkin.html") });
document.getElementById("open-outcomes").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("ui/outcomes.html") });
document.getElementById("options").onclick = () => chrome.runtime.openOptionsPage();
document.getElementById("rules").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("ui/rules.html") });
document.getElementById("messages").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("ui/messages.html") });
// NOTE: [design thought] a pause counts in the study's rules (ui/rules.html), so the popup shows them before it
// pauses (0.6.14): "Pause tracking" opens the box, and only the box's own button pauses. Resuming needs no second click.
const pauseBox = document.getElementById("pause-box");
async function setPaused(paused) {
  const { settings = {} } = await chrome.storage.local.get("settings");
  pauseBox.hidden = true;
  if (Boolean(settings.paused) === paused) return;        // (a second click: the pause keeps its start)
  // pausedAt: since when tracking is paused (the heartbeat reports it, and the reminders count from it)
  await chrome.storage.local.set({ settings: { ...settings, paused, pausedAt: paused ? Date.now() : null } });
  refresh();
}
document.getElementById("pause").onclick = async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (settings.paused) return setPaused(false);
  pauseBox.hidden = !pauseBox.hidden;
};
document.getElementById("pause-confirm").onclick = () => setPaused(true);
document.getElementById("pause-cancel").onclick = () => { pauseBox.hidden = true; };
document.getElementById("debug").onclick = async () => {
  const out = document.getElementById("debug-out");
  // (0.6.21) the same button closes the output again, as the feedback buttons close their box
  if (!out.hidden) {
    out.hidden = true;
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // NOTE: [edge case callout] (0.6.18) Chrome shows a popup at most 600 pixels high, and the buttons fill it:
  // the output, right under its button, is scrolled into view, before and after the tab answers (before, it
  // was at the very bottom, out of sight, so the button seemed to do nothing)
  out.hidden = false;
  out.textContent = "Reading this tab...";
  out.scrollIntoView({ block: "nearest" });
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "debug_capture" });
    // the count the background keeps for the chat (it stays when the page moves to another chat
    // and back); the page's own count, if the latest messages are not stored yet
    const stored = await chrome.storage.local.get(null);
    const chatKey = stored[`alias:${result.key}`] || result.key;
    const captured = Math.max((stored[`sent:${chatKey}`] || []).length, result.sent);
    // (0.6.22) each message the page shows with its turn in the conversation, and a note when the page shows only
    // part of it: a site such as ChatGPT draws only some turns at a time (after its tab comes back to the front,
    // or in a long chat), and the page's list holds only those; the extension keeps track of every turn
    const known = stored[`chat:${chatKey}`]?.ids || [];
    const { userTurns } = Episodes.splitTurns(result.messages);
    const first = Episodes.firstTurnOnPage(known, Episodes.turnIds(userTurns));
    const total = first === null ? known.length : Math.max(known.length, first - 1 + userTurns.length);
    const last = first === null ? null : first - 1 + userTurns.length;
    const part = first !== null && (first > 1 || last < total)
      ? `The page shows ${first === last ? `turn ${first}` : `turns ${first} to ${last}`} of ${total} now: the site draws only part ` +
        "of a conversation at a time (scroll up or down to see the others).\n" : "";
    let turn = first === null ? null : first - 1;
    const lines = result.messages.map((m) => {
      if (m.role === "user" && turn !== null) turn += 1;
      return `${m.role === "user" && turn !== null ? `turn ${turn} · ` : ""}${m.role}: ${m.content.slice(0, 160)}`;
    });
    out.textContent = `${result.site} · ${result.key}${result.aliasOf ? ` (was ${result.aliasOf})` : ""} · ` +
      `${captured} of your messages captured in this conversation\n` + part +
      (lines.length ? lines.join("\n") : "No messages found on this page.");
  } catch (error) {
    out.textContent = "This tab is not a supported chat site (or the page has not finished loading).";
  }
  out.scrollIntoView({ block: "nearest" });
};

// Feedback on the study (0.6.12), in the participant's own words: the background redacts it, as every text, and
// sends it (background.js onFeedback). The same box takes a report of an advice conversation the extension did not
// ask about (0.6.14, "Report an advice conversation we missed"): the study wants to know what its advice model
// misses, as "No" tells it what the model wrongly took for advice. `feedbackKind` says which of the two the box is for.
// NOTE: [design thought] a click outside closes the popup, so the draft (and its kind) is kept while the browser runs
// (chrome.storage.session, in memory only; "Delete all data" clears it too) and comes back when it reopens
const feedbackBox = document.getElementById("feedback-box"), feedbackText = document.getElementById("feedback-text");
const feedbackSend = document.getElementById("feedback-send"), feedbackStatus = document.getElementById("feedback-status");
const PLACEHOLDERS = {
  feedback: "Anything you want the study team to know: what worked, what did not, a question, an idea to improve the extension...",
  missed_advice: "Which AI assistant, about when, and in a sentence what you asked advice about. Please do not paste the conversation.",
};
let feedbackKind = "feedback";
function openFeedback(kind) {
  // (the same button again closes the box; the other one turns it into its kind)
  feedbackBox.hidden = !feedbackBox.hidden && feedbackKind === kind;
  feedbackKind = kind;
  feedbackText.placeholder = PLACEHOLDERS[kind];
  chrome.storage.session.set({ feedbackKind: kind });
  if (!feedbackBox.hidden) feedbackText.focus();
}
document.getElementById("feedback").onclick = () => openFeedback("feedback");
document.getElementById("missed").onclick = () => openFeedback("missed_advice");
feedbackText.placeholder = PLACEHOLDERS.feedback;
feedbackText.oninput = () => chrome.storage.session.set({ feedbackDraft: feedbackText.value });
feedbackSend.onclick = async () => {
  const text = feedbackText.value.trim();
  if (!text) {
    feedbackStatus.textContent = feedbackKind === "missed_advice" ? "Please describe the conversation first." : "Please write your feedback first.";
    return;
  }
  feedbackSend.disabled = true;               // (one feedback per click, even on a double click)
  const reply = await chrome.runtime.sendMessage({ type: "feedback", text, kind: feedbackKind });
  const { settings = {} } = await chrome.storage.local.get("settings");
  feedbackText.value = "";
  await chrome.storage.session.remove("feedbackDraft");
  feedbackSend.disabled = false;
  feedbackStatus.textContent = reply?.sent ? "Thank you: sent to the study team."
    : settings.participantId ? "Thank you: it will be sent as soon as the study server can be reached."
    : "Thank you: it will be sent once you save your participant ID in Settings.";
};
chrome.storage.session.get(["feedbackDraft", "feedbackKind"]).then(({ feedbackDraft, feedbackKind: kind }) => {
  if (!feedbackDraft) return;
  feedbackKind = kind === "missed_advice" ? kind : "feedback";
  feedbackText.placeholder = PLACEHOLDERS[feedbackKind];
  feedbackText.value = feedbackDraft;
  feedbackBox.hidden = false;
});
refresh();
