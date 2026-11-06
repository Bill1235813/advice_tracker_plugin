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
// In every mode, answers are asked again (an update, or the final ratings) only when the episode
// has new input: a message in it after the version the participant answered (upToDate below).
// A pause, a move to another conversation, a change of topic or the cut alone never asks again.
// An episode keeps the mode it started with, even if the setting changes meanwhile.
// Every rule returns what to do: null (nothing), or {show: "page" | "update" | "confirm", stage},
// where the stage tells the panel what to say: first, temp, update, final, end.
//
// The fields of an episode record used here (background.js keeps them):
//   mode, status ("open" | "pending" | "rated" | "done" | "removed"), end (its last turn so far),
//   closedBy, answers (the latest submitted answers, or null), answeredEnd (the episode's last turn
//   when they were given), askedEnd (its last turn when the participant last saw a page or pop-up
//   about it; the confirm pop-up does not count), finalDue (switching and combined modes: final
//   answers still wanted, set at the close only with new input since the answers: finalAsked), snoozedUntil (after "later (1 h)": nothing is asked before then),
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
  // NOTE: [design thought] the researcher's rule for every update (the update pop-up, a ratings page
  // that asks again, the final answers at a change of topic or the cut): it needs new input, i.e.
  // at least one more message in the episode after the version answered last (answeredEnd). A
  // pause, a move to another conversation, a change of topic or the cut alone brings nothing new
  // to rate. Answers whose version is not known count as covering the episode as it is.
  const upToDate = (record) => Boolean(record.answers) && record.end <= (record.answeredEnd ?? record.end);
  // Final answers asked when the episode closed count only with new input since the answers: a flag
  // set before 0.6.2, at a change of topic right after the answers, asks nothing any more.
  const finalAsked = (record) => Boolean(record.finalDue) && !upToDate(record);
  // A ratings page or pop-up about the episode is still worth showing (the update pop-up's Yes, a
  // notification, a tab opened for it): no answers yet, or new input since the answers.
  const stillDue = (record) => !upToDate(record);
  // A ratings page that waited behind another page on a tab, about an episode with answers: only with
  // new input since the participant last saw a page or pop-up about it too (they may have refused
  // that update meanwhile), or final answers due.
  const waitedDue = (record) => !record.answers || finalAsked(record) || (stillDue(record) && (record.askedEnd ?? 0) < record.end);
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
    // NOTE: [edge case callout] answers given on a page that already showed this turn cover it
    if (upToDate(record)) return null;
    // the first page has not been on the screen yet (it waited for the reply, or its tab closed)
    if (!asked(record)) return { show: "page", stage: "first" };
    return grownSince(record.answeredEnd, record) ? offer(record) : null;
  }

  // the participant now looks at another conversation than this episode's chat
  function onOtherConversation(record, now = 0) {
    if (!asksAtMoves(record.mode) || !live(record, now)) return null;
    if (record.mode === "combined") return pageThenOffers(record, "temp");
    if (!record.answers) return record.askedEnd === record.end ? null : { show: "page", stage: "temp" };
    // NOTE: [design thought] only after they came back and asked more: with nothing new there is
    // nothing to update, and asking at every tab switch would only annoy
    return !upToDate(record) && record.askedEnd !== record.end ? offer(record) : null;
  }

  // the episode's chat has had no typing for the pause length
  function onPause(record, now = 0) {
    if (!asksAtPauses(record.mode) || !live(record, now)) return null;
    return pageThenOffers(record, "first");
  }

  // Periodical and combined modes: the ratings page the first time, then the pop-up whenever the
  // episode has grown since the participant last saw a page or pop-up about it, and only with new
  // input since the answers (upToDate: answers whose version is not known never bring the page again).
  // NOTE: [design thought] in combined mode a pause and a move share this, so whichever comes
  // first brings the page and the other one finds it asked
  function pageThenOffers(record, stage) {
    if (upToDate(record)) return null;
    if (!asked(record)) return { show: "page", stage };
    return grownSince(record.askedEnd, record) ? offer(record) : null;
  }

  // a change of topic asks for the final ratings when the episode has new input since the ratings
  // given before (onClosed); so does the cut a week after the episode's first request (background.js),
  // which completes it the same way
  const finalAtSwitch = (mode, closedBy) => (mode === "switching" || mode === "combined") && (closedBy === "switch" || closedBy === "cut");

  // The episode ended. Returns its new status, and whether final answers are still due
  // (switching and combined modes, a change of topic: until they come, or the participant closes
  // that page).
  function onClosed(record, closedBy) {
    if (record.status === "removed") return { status: "delete", finalDue: false };
    if (!record.answers) return { status: "pending", finalDue: false };
    // with no new input since the answers, the last answers stand as the final ones
    return { status: "rated", finalDue: finalAtSwitch(record.mode, closedBy) && !upToDate(record) };
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
    if (finalAsked(record)) return { show: "page", stage: "final" };
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
  //   past  once, the follow-up time after its request: "Did you ask for advice here?" (Yes / No /
  //         Skip), then the past questions (lib/questions.js PAST)
  //   other never answered: the same question (Yes / No), then the ratings; final answers due: the
  //         final page; grown since the answers (more turns from elsewhere): an update
  const DAY = 24 * 3600 * 1000;
  function queueDue(record, now, followupSeconds) {
    if (!viaQueue(record) || record.snoozedUntil > now || ["removed", "done"].includes(record.status)) return null;
    if (record.source === "past") {
      return record.status === "pending" && now >= record.openedAt + followupSeconds * 1000 ? { show: "queued", stage: "past" } : null;
    }
    if (!record.answers) return { show: "queued", stage: record.status === "open" ? "first" : closingStage(record) };
    if (finalAsked(record)) return { show: "page", stage: "final" };
    return !upToDate(record) && (record.askedEnd ?? 0) < record.end ? offer(record) : null;
  }

  // The site's question now: the one it asked last and the participant did not finish (`current`), as
  // long as it is due; else from other devices first (they are recent; oldest first), then past ones
  // (newest first)
  function queueItem(records, now, followupSeconds, current = null) {
    const due = records.map((record) => ({ record, decision: queueDue(record, now, followupSeconds) })).filter((item) => item.decision);
    const kept = due.find((item) => item.record.id === current);
    if (kept) return kept;
    const past = (item) => (item.record.source === "past" ? 1 : 0);
    due.sort((a, b) => past(a) - past(b) || (past(a) ? b.record.openedAt - a.record.openedAt : a.record.openedAt - b.record.openedAt));
    return due[0] || null;
  }

  // The follow-up time in seconds: the follow-up questions begin this long after an episode's first
  // request, and a past conversation's question comes this long after its request (7 days in the
  // study since 0.6.9, when the conversation is complete at the latest; the settings page can shorten
  // it for a test). Settings saved before 0.6.1 hold it in days (followupDays).
  function followupSeconds(settings) {
    return settings.followupSeconds ?? ((settings.followupDays ?? 7) * DAY) / 1000;
  }

  // ---- the follow-up (0.6.9): did the participant decide, did they act, and how did it turn out ----
  // An answered episode gets record.checkin (background.js onRatingSubmitted):
  //   askFrom   the follow-up begins (the follow-up time after the first request)
  //   decision  the latest answers: {decided: "yes" | "no", acted: "yes" | "no", actWhen, plannedAt, at}
  //   nextAt    nothing is asked before then: a day after "not yet decided", or the day they plan to act
  //   dueAt     the outcome questions are ready from then on (null until the answers say so)
  //   doneAt    the outcome questions were answered
  // (a check-in made before 0.6.9 has only dueAt and doneAt: its outcome questions come at dueAt, as then)
  // The follow-up's stage now; `studyEnd`: when the participant's study period ends (studyEnd below).
  //   null       no follow-up (no answers yet), or done
  //   "later"    not begun: before askFrom, the conversation still going on, or a question about it still waits
  //   "decided"  ask "Did you make a decision yet?"
  //   "acted"    ask "Did you act on this decision yet?" (and if not, when they plan to)
  //   "waiting"  nothing to ask before nextAt
  //   "outcome"  the outcome questions are ready: they acted, they plan to act only after the study
  //              period (or do not know when), or it is the study's last day
  function followupStage(record, now, studyEnd = Infinity) {
    const checkin = record.checkin;
    if (!checkin || checkin.doneAt || record.status === "removed") return null;
    if (Number.isFinite(checkin.dueAt) && checkin.dueAt <= now) return "outcome";
    const askFrom = checkin.askFrom ?? Infinity;
    if (record.status === "open" || now < askFrom || waiting(record)) return "later";
    if (now >= lastCall(checkin, studyEnd)) return "outcome";
    if ((checkin.nextAt ?? 0) > now) return "waiting";
    return checkin.decision?.decided === "yes" ? "acted" : "decided";
  }
  // NOTE: [design thought] whatever the answers, the outcome questions come on the study's last day,
  // or when the follow-up begins if that is later (a conversation in the study's last week)
  const lastCall = (checkin, studyEnd) => Math.max(checkin.askFrom ?? Infinity, studyEnd - DAY);
  // the stages in which a question waits for the participant (the badge, the reminders)
  const followupAsks = (stage) => stage === "decided" || stage === "acted" || stage === "outcome";

  // When the participant's study period ends: studyDays after they joined (the study server's first
  // event of their participant ID, if earlier than this install's: stored.pastBefore)
  function studyEnd(stored, studyDays) {
    return (stored.pastBefore ?? stored.joinedAt ?? Infinity) + studyDays * DAY;
  }

  // When they plan to act: in how many days ("later" or not sure: no day)
  const ACT_DAYS = { days: 3, week: 7, weeks: 14, month: 30 };

  // The follow-up after an answer: `step` is the question answered ("decided", "acted", "when"), `answer`
  // its answer. Returns the new record.checkin, or null when the question is no longer open (answered
  // meanwhile elsewhere, or the outcome questions are already ready):
  //   decided yes   -> the next question: did you act on it?
  //   decided no    -> asked again in a day
  //   acted yes     -> the outcome questions, now
  //   acted no      -> the next question: when do you plan to act?
  //   when <choice> -> within the study period: "did you act?" again on that day; after it, or not sure:
  //                    the outcome questions, now
  function followupAnswer(record, step, answer, now, studyEnd) {
    const stage = followupStage(record, now, studyEnd);
    if (!["decided", "acted", "waiting"].includes(stage)) return null;
    const checkin = record.checkin, decided = checkin.decision?.decided === "yes";
    const decision = { ...checkin.decision, at: now };
    if (step === "decided" && !decided) {
      return answer === "yes" ? { ...checkin, nextAt: null, decision: { ...decision, decided: "yes", decidedAt: now } }
                              : { ...checkin, nextAt: now + DAY, decision: { ...decision, decided: "no" } };
    }
    if (step === "acted" && answer === "yes") {
      return { ...checkin, nextAt: null, dueAt: now, decision: { ...decision, decided: "yes", decidedAt: decision.decidedAt ?? now, acted: "yes", actedAt: now } };
    }
    if (step === "acted" && decided) return { ...checkin, nextAt: null, decision: { ...decision, acted: "no" } };
    if (step === "when" && checkin.decision?.acted === "no") {
      const plannedAt = ACT_DAYS[answer] ? now + ACT_DAYS[answer] * DAY : null;
      return plannedAt !== null && plannedAt < studyEnd
        ? { ...checkin, nextAt: plannedAt, decision: { ...decision, actWhen: answer, plannedAt } }
        : { ...checkin, nextAt: null, dueAt: now, decision: { ...decision, actWhen: answer, plannedAt } };
    }
    return null;
  }

  // the outcome questions can be answered now (with no study end given: only once the answers made them ready)
  function checkinDue(record, now, studyEnd = Infinity) {
    return followupStage(record, now, studyEnd) === "outcome";
  }

  const api = { MODES, asksAtPauses, asksAtMoves, onOpened, onExtended, onOtherConversation, onPause, onClosed, closingStage,
                pageDue, waiting, waitingPage, checkinDue, viaQueue, queueDue, queueItem, followupSeconds, upToDate, stillDue, waitedDue,
                followupStage, followupAsks, followupAnswer, lastCall, studyEnd, ACT_DAYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Modes = api;
})(typeof self !== "undefined" ? self : globalThis);
