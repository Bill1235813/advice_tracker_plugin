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
STUDY_CONFIG.pastLimit = 30;
STUDY_CONFIG.pastReward = "$2";
// A participant who leaves tracking paused gets a Chrome notification after this many days, and again
// after as many more while it stays paused (clicking "Resume tracking" on it resumes).
STUDY_CONFIG.pausedReminderDays = 5;
// The study period (consent form: the study lasts five weeks, three of tracking and two for the last
// follow-ups), from when the participant joined: a decision they plan to act on within it is asked about
// again then, one after it goes to its outcome questions at once, and on its last day every follow-up
// goes to them (lib/modes.js followupStage). A reminder to look at the outcomes page comes every
// outcomesReminderDays while a follow-up question waits.
STUDY_CONFIG.studyDays = 35;
STUDY_CONFIG.outcomesReminderDays = 2;
// The sites whose conversation list can be read (a reader in lib/history/<site>.js); the version of
// the consent text on the settings page (uploaded with each consent). A participant's past ends when
// they first installed the extension (the study server's first event of their ID, if earlier).
STUDY_CONFIG.historySites = ["chatgpt.com", "claude.ai", "gemini.google.com", "grok.com", "www.perplexity.ai"];
STUDY_CONFIG.historyConsentVersion = "draft-2026-11-06";
self.STUDY_CONFIG = STUDY_CONFIG;
