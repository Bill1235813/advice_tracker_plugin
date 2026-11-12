// The test build's timings (the branch "test" only; main and v0.6 have no such file): the study's times, which
// the settings page's "Test timings" can shorten, so that a tester does not wait a week for the follow-up, two
// days for a reminder or five weeks for the study's end. Never give this build to a participant.
// NOTE: [design thought] one setting compresses the whole study: "One study day lasts" (24 hours by default).
// Every time the study counts in days or hours (`study: true` below) lasts that many study days or hours, so
// with a 5-minute day the five weeks take 35 x 5 = 175 minutes and every rule keeps its place in them (the end
// of week 3, the last week's outcome questions, the three days after a week's reminder). A time typed in its own
// field is taken as it is, in real time. The times of the chat page and of the extension's own rhythm
// (`study: false`) never follow the study day.
// The fields of settings.testTimings are what the tester typed ({day: "5m", followup: "10m"}): the text, not a
// number, so the page shows it again as it was typed.
(function (root) {
  const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
  const UNITS = { s: SECOND, m: MINUTE, h: HOUR, d: DAY };
  // (the study's times that config.js holds are read from it; the others are as in background.js, which a Node
  // test checks: tests/node/test_test_timings.js)
  const CONFIG = root.STUDY_CONFIG || {};

  // name (settings.testTimings), the study's time, whether it follows the study day, and what the settings page
  // calls it; `group` starts a new part of the page
  const TIMINGS = [
    { name: "day", ms: DAY, study: false, group: "The study's clock", label: "One study day lasts",
      help: "every time marked * follows it: with 5m, the five weeks last about 3 hours" },
    { name: "pause", ms: 3 * MINUTE, study: false, group: "Quick questions on the chat page",
      label: "The quick questions open after this long without typing in the advice chat" },
    { name: "popup", ms: 30 * SECOND, study: false, label: "The small windows close by themselves after",
      help: "Did you ask for advice here?, Update your ratings?, a follow-up question; the time runs while the page is in front" },
    { name: "snooze", ms: HOUR, study: false, label: "“later (1 h)” puts a question off for" },
    { name: "cut", ms: 7 * DAY, study: true, label: "An advice conversation ends this long after its first request *" },
    { name: "quiet", ms: 7 * DAY, study: true, label: "... or after this long without a message in its chat *" },
    { name: "questionExpire", ms: 14 * DAY, study: true, label: "Quick questions never answered are dropped this long after the request *",
      help: "checked at each status signal and each start of the extension" },
    { name: "followup", ms: 7 * DAY, study: true, group: "Follow-up and Outcomes",
      label: "The follow-up questions (decided? acted?) begin this long after the request *" },
    { name: "followupGap", ms: 4 * HOUR, study: true, label: "Follow-up pop-ups about different conversations come at most every *" },
    { name: "outcomesReminder", ms: (CONFIG.outcomesReminderDays ?? 2) * DAY, study: true,
      label: "The reminder to open the Outcomes page comes every *" },
    { name: "weekReminder", ms: (CONFIG.weekReminderDays ?? 3) * DAY, study: true, group: "The study's weeks (a week is 7 study days)",
      label: "After the reminder at the end of a week, the participant has this long *" },
    { name: "pausedReminder", ms: (CONFIG.pausedReminderHours ?? 12) * HOUR, study: true, group: "A pause of tracking",
      label: "While tracking is paused, the first reminder comes after *", help: "then one at every full study day of the pause" },
    { name: "listEvery", ms: 20 * MINUTE, study: false, group: "Other devices and past conversations",
      label: "Each site's conversation list is read every", help: "at most once a minute, while a page of the site is open" },
    { name: "inviteGap", ms: 4 * HOUR, study: true, label: "Invitations on a site's page come at most every *",
      help: "and at most 2 past conversations in any study day" },
    { name: "pastExpire", ms: 42 * DAY, study: true, label: "Past conversations never annotated are dropped this long after they were found *" },
    { name: "heartbeat", ms: 12 * HOUR, study: false, group: "The study server",
      label: "The status signal goes every", help: "the extension then also asks for messages from the team" },
    { name: "messageAgain", ms: 4 * HOUR, study: true, label: "A message from the team closed with “Later” comes back after *" },
  ];

  // "90s", "2.5m", "12h", "7d" -> milliseconds; null for anything else (an empty field: the study's time)
  function parse(text) {
    const match = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(String(text ?? "").trim().toLowerCase());
    return match && Number(match[1]) > 0 ? Number(match[1]) * UNITS[match[2]] : null;
  }

  // milliseconds -> in the largest unit it fills: 604800000 -> "7d", 2100000 -> "35m", 150000 -> "2.5m"
  function format(ms) {
    const [unit, size] = Object.entries(UNITS).reverse().find(([, unitMs]) => ms >= unitMs) || ["s", SECOND];
    return `${Math.round((ms / size) * 100) / 100}${unit}`;
  }

  // Every timing as it is now, in milliseconds: the one typed (`typed`: settings.testTimings), else the study's,
  // which lasts as many study days or hours as the study says when it follows the study day
  function effective(typed = {}) {
    const day = parse(typed.day) ?? DAY, times = {};
    for (const timing of TIMINGS) {
      times[timing.name] = parse(typed[timing.name]) ?? (timing.study ? (timing.ms * day) / DAY : timing.ms);
    }
    return times;
  }

  // The settings with the five times they hold themselves replaced by the test times, once a test time is typed
  // (else they stay as stored, as on main)
  // NOTE: [pedagogical] the worker multiplies cutDays by its study day (background.js DAY_MS), so cutDays is in
  // study days; the other four are plain seconds and minutes
  function overlay(settings) {
    const typed = settings.testTimings || {};
    if (!Object.values(typed).some((text) => parse(text) !== null)) return settings;
    const times = effective(typed);
    return { ...settings, followupSeconds: Math.max(1, Math.round(times.followup / SECOND)), endQuietMinutes: times.quiet / MINUTE,
             cutDays: times.cut / times.day, pauseMinutes: times.pause / MINUTE, updateSeconds: Math.max(1, Math.round(times.popup / SECOND)) };
  }

  // On a page of the extension: lib/modes.js counts in study days, and the settings get the test times. Call it
  // with the stored settings before anything reads either.
  function apply(settings = {}) {
    if (root.Modes) root.Modes.setTimings({ day: effective(settings.testTimings).day });
    return overlay(settings);
  }

  const api = { TIMINGS, parse, format, effective, overlay, apply, DAY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TestTimings = api;
})(typeof self !== "undefined" ? self : globalThis);
