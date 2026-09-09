// Study-wide settings baked into the extension before it is handed to participants, so the
// only thing a participant types is their participant ID. Fill in the hosted server's URL
// and the study key after deploying the Space (plugin/README.md, "Hosting the server").
const STUDY_CONFIG = {
  serverUrl: "https://bill1235813-advice-tracker.hf.space",
  studyKey: "lEHEDGTSxNbcgtB6mmcBV2kMoLFLwKSX",
};
self.STUDY_CONFIG = STUDY_CONFIG;
