// The study rules page (0.6.14). The rules themselves are in ui/rules.html, as in the consent form. This script
// adds the participant's own calendar: the study's weeks count from when they joined (lib/modes.js studyDay), so
// the end of each week, its payment day and the days the extension stops collecting are dates of their own.

// a payment comes this many days after the end of its week: 3 days for the answers a reminder asks for, then 2
// days for the study team's review of the answers
const PAY_DAYS = 5;

async function main() {
  const stored = await chrome.storage.local.get(["pastBefore", "joinedAt", "settings"]);
  // (the test build: a study day as long as the settings page says, lib/test_timings.js)
  TestTimings.apply(stored.settings);
  const DAY = Modes.DAY;
  const start = Modes.studyDay(stored, 0);
  if (!Number.isFinite(start)) return;               // (no participant ID yet: the page says so)
  const date = (days) => new Date(start + days * DAY).toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric" });
  const { newAdviceDays, continueDays, studyDays } = STUDY_CONFIG;
  const today = (Date.now() - start) / DAY;
  const rows = [];
  for (let end = 7; end <= studyDays; end += 7) {
    // what the week is for, and what is paid after it (weeks 1 to 3 each; weeks 4 and 5 together)
    let what, paid = "";
    if (end <= newAdviceDays) {
      what = "Advice conversations are collected; their quick questions are due." +
             (end === newAdviceDays ? " At the end of this week the extension stops looking for new advice conversations." : "");
      paid = `$10, about ${date(end + PAY_DAYS)}`;
    } else if (end <= continueDays) {
      what = "No new advice conversations are collected. Conversations that began before are still followed if you continue them, " +
             "until the end of this week. Follow-up questions go on.";
    } else {
      what = "The outcome questions of every advice conversation, and the past conversations, are due by the end of this week.";
    }
    if (end === studyDays) paid = `$10 for weeks ${continueDays / 7} and ${studyDays / 7}, about ${date(end + PAY_DAYS)}`;
    const now = today >= end - 7 && today < end;
    rows.push(`<tr class="${now ? "now" : ""}"><td class="when"><b>Week ${end / 7}</b>${now ? " (now)" : ""}</td><td class="when">${date(end)}</td>` +
              `<td>${what}</td><td>${paid}</td></tr>`);
  }
  document.getElementById("calendar").innerHTML =
    `<p class="meta">You joined the study on ${date(0)}. A week is each 7 days after that.</p>
     <table><tr><th>Week</th><th>Ends</th><th>What happens</th><th>Payment</th></tr>${rows.join("")}</table>
     ${today >= studyDays ? '<p class="meta">The five weeks of your study are over. Thank you!</p>' : ""}`;
}

main();
