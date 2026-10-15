// Study-wide settings baked into the extension before it is handed to participants, so the
// only thing a participant types is their participant ID. Fill in the hosted server's URL
// and the study key after deploying the Space (plugin/README.md, "Hosting the server").
const STUDY_CONFIG = {
  serverUrl: "https://bill1235813-advice-tracker.hf.space",
  studyKey: "lEHEDGTSxNbcgtB6mmcBV2kMoLFLwKSX",
};
// ratingMode: when to ask about an advice episode by default ("frequent" | "switching" |
// "periodical", see lib/modes.js); the settings page can change it per computer.
STUDY_CONFIG.ratingMode = "switching";
self.STUDY_CONFIG = STUDY_CONFIG;
