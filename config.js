// Study-wide settings baked into the extension before it is handed to participants (the study
// server's URL and the study key), so the only thing a participant types is their participant ID.
const STUDY_CONFIG = {
  serverUrl: "https://advice-relay.tail48c3b3.ts.net",
  studyKey: "lEHEDGTSxNbcgtB6mmcBV2kMoLFLwKSX",
};
// Study servers used before (0.6.5: the server moved off Hugging Face): an install updated from an
// earlier version that still has one of these saved moves to serverUrl; an address typed on the
// settings page stays.
STUDY_CONFIG.retiredServerUrls = ["https://bill1235813-advice-tracker.hf.space"];
// ratingMode: when to ask about an advice episode by default ("frequent" | "switching" |
// "periodical" | "combined", see lib/modes.js); the settings page can change it per computer.
STUDY_CONFIG.ratingMode = "combined";
// Past conversations (settings page, opt-in): how far back before joining they are read, how many may
// be found (waiting or annotated), and what each annotation earns (the pop-up says so).
STUDY_CONFIG.pastLookbackDays = 90;
STUDY_CONFIG.pastLimit = 20;
STUDY_CONFIG.pastReward = "$2";
// A participant who leaves tracking paused gets a Chrome notification after this many hours, and again at
// every full day of the pause (clicking "Resume tracking" on it resumes). The study's rules for a pause:
// under 12 hours nothing happens; from 12 to 24 hours a reminder; from 24 hours to a week the week's payment
// is reduced for the paused time; over a week participation ends (the popup shows them before it pauses).
STUDY_CONFIG.pausedReminderHours = 12;
// The study period (consent form: the study lasts five weeks), in days from when the participant joined:
// new advice conversations are looked for until the end of week 3 (newAdviceDays), open ones are followed
// until the end of week 4 (continueDays), and in the last week every follow-up goes to its outcome
// questions, which are due by the end of week 5 (studyDays; lib/modes.js followupStage). A reminder to look
// at the outcomes page comes every outcomesReminderDays while anything there is unanswered (a follow-up
// that is not finished, a past conversation).
STUDY_CONFIG.newAdviceDays = 21;
STUDY_CONFIG.continueDays = 28;
STUDY_CONFIG.studyDays = 35;
STUDY_CONFIG.outcomesReminderDays = 2;
// The sites whose conversation list can be read (a reader in lib/history/<site>.js); the version of
// the consent text on the settings page (uploaded with each consent). A participant's past ends when
// they first installed the extension (the study server's first event of their ID, if earlier).
STUDY_CONFIG.historySites = ["chatgpt.com", "claude.ai", "gemini.google.com", "grok.com", "www.perplexity.ai"];
STUDY_CONFIG.historyConsentVersion = "2026-11-10c";
self.STUDY_CONFIG = STUDY_CONFIG;
