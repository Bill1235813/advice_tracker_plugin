// When to ask the participant about an advice episode: the three rating modes, as pure functions
// over the episode record (no Chrome APIs), so the Node tests can check every rule.
//   frequent    the ratings page at the episode's first advice turn; after every later turn of the
//               episode, a small pop-up "Update your ratings?" (it disappears after 30 s)
//   switching   temporary ratings when the participant moves to another conversation; final
//               ratings when the topic changes; after they came back and asked more, the next move
//               to another conversation brings the update pop-up
//   periodical  the ratings page at the first pause (3 minutes without typing in the episode's
//               chat); at later pauses the update pop-up, if the episode has grown since
// An episode keeps the mode it started with, even if the setting changes meanwhile.
// Every rule returns what to do: null (nothing), or {show: "page" | "update", stage}, where
// the stage tells the panel what to say: first, temp, update, final, end.
//
// The fields of an episode record used here (background.js keeps them):
//   mode, status ("open" | "pending" | "rated" | "done" | "removed"), end (its last turn so far),
//   closedBy, answers (the latest submitted answers, or null), answeredEnd (the episode's last turn
//   when they were given), askedEnd (its last turn when the participant last saw a page or pop-up
//   about it), finalDue (switching mode: final answers still wanted), snoozedUntil (after "later
//   (1 h)": nothing is asked before then), checkin ({dueAt, doneAt}: the day-14 check-in)
(function (root) {
  const MODES = ["frequent", "switching", "periodical"];
  // NOTE: [design thought] a snoozed episode is left alone: no pop-ups, no pages, until the snooze ends
  const live = (record, now) => record.status === "open" && !(record.snoozedUntil > now);
  const grownSince = (turn, record) => turn === null || turn === undefined || record.end > turn;
  const asked = (record) => record.askedEnd !== null && record.askedEnd !== undefined;
  // the pop-up offers an update of the answers, or the first answers if there are none yet
  const offer = (record) => ({ show: "update", stage: record.answers ? "update" : "first" });

  // the episode has just opened (its first advice turn was judged)
  function onOpened(record, now = 0) {
    return record.mode === "frequent" && live(record, now) ? { show: "page", stage: "first" } : null;
  }

  // the episode grew by one turn (the continuation judge said "same thread")
  function onExtended(record, now = 0) {
    if (record.mode !== "frequent" || !live(record, now)) return null;
    // the first page has not been on the screen yet (it waited for the reply, or its tab closed)
    if (!asked(record)) return { show: "page", stage: "first" };
    // NOTE: [edge case callout] answers given on a page that already showed this turn cover it
    return grownSince(record.answeredEnd, record) ? offer(record) : null;
  }

  // the participant now looks at another conversation than this episode's chat
  function onOtherConversation(record, now = 0) {
    if (record.mode !== "switching" || !live(record, now)) return null;
    if (!record.answers) return record.askedEnd === record.end ? null : { show: "page", stage: "temp" };
    // NOTE: [design thought] only after they came back and asked more: with nothing new there is
    // nothing to update, and asking at every tab switch would only annoy
    return grownSince(record.answeredEnd, record) && record.askedEnd !== record.end ? offer(record) : null;
  }

  // the episode's chat has had no typing for the pause length
  function onPause(record, now = 0) {
    if (record.mode !== "periodical" || !live(record, now)) return null;
    if (!asked(record)) return { show: "page", stage: "first" };
    return grownSince(record.askedEnd, record) ? offer(record) : null;
  }

  // The episode ended. Returns its new status, and whether final answers are still due
  // (switching mode, a change of topic: until they come, or the participant closes that page).
  function onClosed(record, closedBy) {
    if (record.status === "removed") return { status: "delete", finalDue: false };
    if (!record.answers) return { status: "pending", finalDue: false };
    return { status: "rated", finalDue: record.mode === "switching" && closedBy === "switch" };
  }

  // what the page asked at the end of an episode without answers says: in switching mode a change
  // of topic asks for the final ratings, everything else for the end-of-episode ones
  function closingStage(record) {
    return record.mode === "switching" && record.closedBy === "switch" ? "final" : "end";
  }

  // The page of a question that waits for the participant, or null: an ended episode never
  // answered, final answers still due, or an open episode they were asked about and did not
  // answer. The badge on the extension icon and the check-in page list these.
  function pageDue(record) {
    if (record.status === "pending") return { show: "page", stage: closingStage(record) };
    if (record.finalDue) return { show: "page", stage: "final" };
    if (record.status === "open" && !record.answers && asked(record)) return { show: "page", stage: "first" };
    return null;
  }
  const waiting = (record) => pageDue(record) !== null;

  // the waiting question, asked now (at the end of the episode, or when "later (1 h)" is over)
  function waitingPage(record, now = 0) {
    return record.snoozedUntil > now ? null : pageDue(record);
  }

  // the day-14 check-in can be answered (it counts from the episode's first request)
  function checkinDue(record, now) {
    return Boolean(record.checkin) && !record.checkin.doneAt && record.checkin.dueAt <= now;
  }

  const api = { MODES, onOpened, onExtended, onOtherConversation, onPause, onClosed, closingStage, pageDue, waiting,
                waitingPage, checkinDue };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Modes = api;
})(typeof self !== "undefined" ? self : globalThis);
