// When to ask the participant about an advice episode: the four rating modes, as pure functions
// over the episode record (no Chrome APIs), so the Node tests can check every rule.
//   frequent    the ratings page at the episode's first advice turn; after every later turn of the
//               episode, a small pop-up "Update your ratings?" (it disappears after 30 s)
//   switching   temporary ratings when the participant moves to another conversation; final
//               ratings when the topic changes (or a week after the first request: the cut); after
//               they came back and asked more, the next move to another conversation brings the
//               update pop-up
//   periodical  the ratings page at the first pause (3 minutes without typing in the episode's
//               chat); at later pauses the update pop-up, if the episode has grown since
//   combined    at the first advice turn only a small pop-up "Did you ask for advice here?" (it
//               also disappears after 30 s); the ratings page at the first pause, move to another
//               conversation or change of topic, whichever comes first; later pauses and moves
//               bring the update pop-up if the episode has grown since; a change of topic (or the
//               cut a week after the first request) asks for the final ratings
// An episode keeps the mode it started with, even if the setting changes meanwhile.
// Every rule returns what to do: null (nothing), or {show: "page" | "update" | "confirm", stage},
// where the stage tells the panel what to say: first, temp, update, final, end.
//
// The fields of an episode record used here (background.js keeps them):
//   mode, status ("open" | "pending" | "rated" | "done" | "removed"), end (its last turn so far),
//   closedBy, answers (the latest submitted answers, or null), answeredEnd (the episode's last turn
//   when they were given), askedEnd (its last turn when the participant last saw a page or pop-up
//   about it; the confirm pop-up does not count), finalDue (switching and combined modes: final
//   answers still wanted), snoozedUntil (after "later (1 h)": nothing is asked before then),
//   checkin ({dueAt, doneAt}: the day-14 check-in), confirmAskedAt and confirmedAt (combined mode:
//   when the confirm pop-up was first on the screen, and when the participant answered Yes there)
(function (root) {
  const MODES = ["frequent", "switching", "periodical", "combined"];
  // the occasions besides the episode's own turns that a mode asks at
  const asksAtPauses = (mode) => mode === "periodical" || mode === "combined";
  const asksAtMoves = (mode) => mode === "switching" || mode === "combined";
  // An episode asked about through its site's queue (background.js offerQueued) instead of by the rules
  // below: a past one, and one the walk through conversations read from the site holds (found among
  // turns from another device, or handed over by the web page), or held last when it ended
  const viaQueue = (record) => record.source === "past" || record.heldBy === "history";
  // NOTE: [design thought] a snoozed episode is left alone: no pop-ups, no pages, until the snooze ends
  const live = (record, now) => record.status === "open" && !(record.snoozedUntil > now) && !viaQueue(record);
  const grownSince = (turn, record) => turn === null || turn === undefined || record.end > turn;
  const asked = (record) => record.askedEnd !== null && record.askedEnd !== undefined;
  // the pop-up offers an update of the answers, or the first answers if there are none yet
  const offer = (record) => ({ show: "update", stage: record.answers ? "update" : "first" });
  // combined mode: "Did you ask for advice here?" alone, until it has been on the screen once or a
  // ratings page came first; a ratings page asks it before the ratings if it is still unanswered
  const confirmDue = (record) => !record.confirmAskedAt && !record.confirmedAt && !asked(record);
  const CONFIRM = { show: "confirm", stage: "first" };

  // the episode has just opened (its first advice turn was judged)
  function onOpened(record, now = 0) {
    if (record.mode === "combined") return live(record, now) && confirmDue(record) ? CONFIRM : null;
    return record.mode === "frequent" && live(record, now) ? { show: "page", stage: "first" } : null;
  }

  // the episode grew by one turn (the continuation judge said "same thread")
  function onExtended(record, now = 0) {
    // combined mode: the confirm pop-up, if it has not been on the screen yet (its tab closed)
    if (record.mode === "combined") return live(record, now) && confirmDue(record) ? CONFIRM : null;
    if (record.mode !== "frequent" || !live(record, now)) return null;
    // the first page has not been on the screen yet (it waited for the reply, or its tab closed)
    if (!asked(record)) return { show: "page", stage: "first" };
    // NOTE: [edge case callout] answers given on a page that already showed this turn cover it
    return grownSince(record.answeredEnd, record) ? offer(record) : null;
  }

  // the participant now looks at another conversation than this episode's chat
  function onOtherConversation(record, now = 0) {
    if (!asksAtMoves(record.mode) || !live(record, now)) return null;
    if (record.mode === "combined") return pageThenOffers(record, "temp");
    if (!record.answers) return record.askedEnd === record.end ? null : { show: "page", stage: "temp" };
    // NOTE: [design thought] only after they came back and asked more: with nothing new there is
    // nothing to update, and asking at every tab switch would only annoy
    return grownSince(record.answeredEnd, record) && record.askedEnd !== record.end ? offer(record) : null;
  }

  // the episode's chat has had no typing for the pause length
  function onPause(record, now = 0) {
    if (!asksAtPauses(record.mode) || !live(record, now)) return null;
    return pageThenOffers(record, "first");
  }

  // Periodical and combined modes: the ratings page the first time, then the pop-up whenever the
  // episode has grown since the participant last saw a page or pop-up about it.
  // NOTE: [design thought] in combined mode a pause and a move share this, so whichever comes
  // first brings the page and the other one finds it asked
  function pageThenOffers(record, stage) {
    if (!asked(record)) return { show: "page", stage };
    return grownSince(record.askedEnd, record) ? offer(record) : null;
  }

  // a change of topic asks for the final ratings, even when ratings were given before; so does the
  // cut a week after the episode's first request (background.js), which completes it the same way
  const finalAtSwitch = (mode, closedBy) => (mode === "switching" || mode === "combined") && (closedBy === "switch" || closedBy === "cut");

  // The episode ended. Returns its new status, and whether final answers are still due
  // (switching and combined modes, a change of topic: until they come, or the participant closes
  // that page).
  function onClosed(record, closedBy) {
    if (record.status === "removed") return { status: "delete", finalDue: false };
    if (!record.answers) return { status: "pending", finalDue: false };
    return { status: "rated", finalDue: finalAtSwitch(record.mode, closedBy) };
  }

  // what the page asked at the end of an episode without answers says: in switching and combined
  // modes a change of topic asks for the final ratings, everything else for the end-of-episode ones
  function closingStage(record) {
    return finalAtSwitch(record.mode, record.closedBy) ? "final" : "end";
  }

  // The page of a question that waits for the participant, or null: an ended episode never
  // answered, final answers still due, or an open episode they were asked about and did not
  // answer. The badge on the extension icon and the check-in page list these.
  function pageDue(record) {
    if (record.source === "past") return null;        // optional (paid), asked through its site's queue only: queueDue
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

  // ---- the queue (viaQueue): one question at a time per site ----
  // Returns {show: "queued" | "page" | "update", stage} or null:
  //   past  once, followupDays after its request: "Did you ask for advice here?" (Yes / No / Skip),
  //         then the past questions (lib/questions.js PAST)
  //   other never answered: the same question (Yes / No), then the ratings; final answers due: the
  //         final page; grown since the answers (more turns from elsewhere): an update
  const DAY = 24 * 3600 * 1000;
  function queueDue(record, now, followupDays) {
    if (!viaQueue(record) || record.snoozedUntil > now || ["removed", "done"].includes(record.status)) return null;
    if (record.source === "past") {
      return record.status === "pending" && now >= record.openedAt + followupDays * DAY ? { show: "queued", stage: "past" } : null;
    }
    if (!record.answers) return { show: "queued", stage: record.status === "open" ? "first" : closingStage(record) };
    if (record.finalDue) return { show: "page", stage: "final" };
    return grownSince(record.answeredEnd, record) && (record.askedEnd ?? 0) < record.end ? offer(record) : null;
  }

  // The site's question now: the one it asked last and the participant did not finish (`current`), as
  // long as it is due; else from other devices first (they are recent; oldest first), then past ones
  // (newest first)
  function queueItem(records, now, followupDays, current = null) {
    const due = records.map((record) => ({ record, decision: queueDue(record, now, followupDays) })).filter((item) => item.decision);
    const kept = due.find((item) => item.record.id === current);
    if (kept) return kept;
    const past = (item) => (item.record.source === "past" ? 1 : 0);
    due.sort((a, b) => past(a) - past(b) || (past(a) ? b.record.openedAt - a.record.openedAt : a.record.openedAt - b.record.openedAt));
    return due[0] || null;
  }

  // the day-14 check-in can be answered (it counts from the episode's first request)
  function checkinDue(record, now) {
    return Boolean(record.checkin) && !record.checkin.doneAt && record.checkin.dueAt <= now;
  }

  const api = { MODES, asksAtPauses, asksAtMoves, onOpened, onExtended, onOtherConversation, onPause, onClosed, closingStage,
                pageDue, waiting, waitingPage, checkinDue, viaQueue, queueDue, queueItem };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Modes = api;
})(typeof self !== "undefined" ? self : globalThis);
