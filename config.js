// Study-wide settings baked into the extension before it is handed to participants, so the
// only thing a participant types is their participant ID. Fill in the hosted server's URL
// and the study key after deploying the Space (plugin/README.md, "Hosting the server").
const STUDY_CONFIG = {
  serverUrl: "https://bill1235813-advice-tracker.hf.space",
  studyKey: "lEHEDGTSxNbcgtB6mmcBV2kMoLFLwKSX",
};
// ratingMode: when to ask about an advice episode by default ("frequent" | "switching" |
// "periodical" | "combined", see lib/modes.js); the settings page can change it per computer.
STUDY_CONFIG.ratingMode = "switching";
// Past conversations (settings page, opt-in): how far back before joining they are read, how many may
// be found (waiting or annotated), and what each annotation earns (the pop-up says so).
STUDY_CONFIG.pastLookbackDays = 90;
STUDY_CONFIG.pastLimit = 20;
STUDY_CONFIG.pastReward = "$2";
// The sites whose conversation list can be read (a reader in lib/history/<site>.js); the version of
// the consent text on the settings page (uploaded with each consent). A participant's past ends when
// they first installed the extension (the study server's first event of their ID, if earlier).
STUDY_CONFIG.historySites = ["chatgpt.com", "claude.ai", "gemini.google.com", "grok.com", "www.perplexity.ai"];
STUDY_CONFIG.historyConsentVersion = "draft-2026-10-16";
self.STUDY_CONFIG = STUDY_CONFIG;
