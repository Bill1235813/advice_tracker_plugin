// The advice-episode state machine of one chat, as pure functions (no Chrome APIs), so the same
// code runs in the extension's background worker and in the Node tests.
//
// It is the turn-by-turn version of classify_conversation in src/classify_advice_segments.py,
// the pipeline scored on the human labels (tests/test_episodes.js checks that both find the same
// episodes on random chats):
//   searching  the advice judge checks each new user turn, with the earlier user turns of the
//              current segment as context; the first "yes" is the OPENING turn of an episode
//   episode    the continuation judge checks each new turn against the previous user turn and
//              the assistant's reply to it; a "no" (topic switch) closes the episode at the turn
//              before, and the search resumes AT the switching turn, which starts a new segment
//   closing    besides a switch, an episode closes when the chat goes quiet, or when the
//              participant says it was not advice
// An episode's turns are start..end: the segment's turns before the opening stay in as context,
// but never the turns of an earlier, finished episode.
//
// A chat's state holds turn numbers and short hashes only, never text:
//   judgedThrough  user turns 1..judgedThrough are settled (judged, or skipped as history)
//   segmentStart   first turn of the current segment (the advice judge's context starts here)
//   state          "searching" | "episode"; opening and end describe the open episode
//   ids            one id per settled turn (see turnIds), to notice edits and lazy-loaded history
//   openedAt       when the open episode's opening turn was sent (ms since 1970)
//   pending        the judgment in flight, {id, kind, turn, sentAt}; set by the background worker
(function (root) {
  const MAX_CONTEXT_TURNS = 10;        // as in the judge: the segment's first turn + the 9 most recent

  // NOTE: [pedagogical] chat pages list messages in order; turn k is the k-th user message, and its
  // reply is everything the assistant wrote before the next user message (usually one message)
  function splitTurns(messages) {
    const userTurns = [], replies = [];
    for (const message of messages) {
      if (message.role === "user") {
        userTurns.push(message.content);
        replies.push("");
      } else if (userTurns.length) {
        replies[replies.length - 1] = (replies[replies.length - 1] + "\n\n" + message.content).trim();
      }
    }
    return { userTurns, replies };
  }

  // NOTE: [pedagogical] FNV-1a is a tiny non-cryptographic hash: enough to recognise "the same
  // message" without keeping its text
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  // One id per user turn: the hash of its text plus its occurrence number (the first "ok" gets
  // ":1", the second ":2"), so equal texts, such as two image uploads with no text, still get
  // different ids.
  function turnIds(userTurns) {
    const seen = new Map();
    return userTurns.map((text) => {
      const h = hash(text);
      seen.set(h, (seen.get(h) || 0) + 1);
      return `${h}:${seen.get(h)}`;
    });
  }

  function newChat({ key, site, now }) {
    return { key, site, firstSeen: now, judgedThrough: 0, segmentStart: 1, state: "searching",
             opening: null, end: null, openedAt: null, ids: [], pending: null };
  }

  // The user turns sent with an advice judgment: turns segmentStart..turn, with the ones the judge
  // never reads replaced by "" (it shows the segment's first turn and the 9 most recent earlier ones)
  function adviceTurns(userTurns, segmentStart, turn) {
    const shown = new Set([segmentStart, turn]);
    for (let n = Math.max(segmentStart, turn - (MAX_CONTEXT_TURNS - 1)); n < turn; n++) shown.add(n);
    const turns = [];
    for (let n = segmentStart; n <= turn; n++) turns.push(shown.has(n) ? userTurns[n - 1] : "");
    return turns;
  }

  // The next judgment this chat needs, or null when every turn on the page is settled.
  function nextJob(chat, userTurns, replies) {
    const turn = chat.judgedThrough + 1;
    if (turn > userTurns.length) return null;
    if (chat.state === "searching") {
      return { kind: "advice", turn, segment_start: chat.segmentStart, turns: adviceTurns(userTurns, chat.segmentStart, turn) };
    }
    // NOTE: [design thought] the continuation judge needs the assistant's reply to the previous
    // turn; it is sent to the study server's judge for this one decision and never stored there
    return { kind: "continuation", turn, previous: userTurns[turn - 2], reply: replies[turn - 2] || "", current: userTurns[turn - 1] };
  }

  // Apply the judge's label for `job` ({kind, turn, sentAt}). Returns the updated chat and the
  // episode that closed, if any. An episode remembers when its opening turn was sent (`openedAt`):
  // the day-14 check-in counts from there, since an episode can go on for a while.
  function applyLabel(chat, job, label) {
    const next = { ...chat, pending: null };
    let closed = null;
    if (job.kind === "advice") {
      next.judgedThrough = job.turn;
      if (label.advice) Object.assign(next, { state: "episode", opening: job.turn, end: job.turn, openedAt: job.sentAt ?? null });
    } else if (label.continuation) {
      Object.assign(next, { judgedThrough: job.turn, end: job.turn });
    } else {
      // a topic switch: the episode ends at the turn before it, and the search resumes AT the
      // switching turn, which is therefore judged again, now as a possible new opening
      closed = { start: chat.segmentStart, opening: chat.opening, end: job.turn - 1, closedBy: "switch", openedAt: chat.openedAt };
      Object.assign(next, { state: "searching", segmentStart: job.turn, judgedThrough: job.turn - 1, opening: null, end: null,
                            openedAt: null });
    }
    return { chat: next, closed };
  }

  // Close the open episode at its last turn (the chat went quiet, the participant said it was not
  // advice, ...). Later turns, if the participant comes back to this chat, start a fresh search.
  function closeOpen(chat, reason) {
    if (chat.state !== "episode") return { chat, closed: null };
    const closed = { start: chat.segmentStart, opening: chat.opening, end: chat.end, closedBy: reason, openedAt: chat.openedAt };
    // NOTE: [edge case callout] a continuation judgment still in flight belonged to the closed
    // episode: it is dropped, and its turn goes to the advice judge instead
    const pending = chat.pending?.kind === "continuation" ? null : chat.pending;
    const next = { ...chat, state: "searching", segmentStart: chat.end + 1, opening: null, end: null, openedAt: null, pending };
    return { chat: next, closed };
  }

  // Where the settled turns `known` sit inside the page's turns `ids`: 0 normally, d > 0 when the
  // page has loaded d older turns above them, -1 when they are no longer all there unchanged.
  function findOffset(known, ids) {
    for (let d = 0; d + known.length <= ids.length; d++) {
      if (known.every((id, i) => ids[d + i] === id)) return d;
    }
    return -1;
  }

  // Turn `turn` changed (the participant edited it, and the chat continues from the edit):
  // forget the judgments from `turn` on. An open episode that began before `turn` closes there;
  // one that opened at or after it never happened.
  function rewind(chat, turn) {
    let closed = null;
    const next = { ...chat, judgedThrough: turn - 1, pending: null, state: "searching", opening: null, end: null, openedAt: null };
    if (chat.state === "episode" && chat.opening < turn) {
      closed = { start: chat.segmentStart, opening: chat.opening, end: Math.min(chat.end, turn - 1), closedBy: "edited",
                 openedAt: chat.openedAt };
      next.segmentStart = turn;
    } else {
      next.segmentStart = Math.min(chat.segmentStart, turn);
    }
    return { chat: next, closed };
  }

  // Bring the chat's state in line with the page before the next judgment. `sent` holds the ids
  // of the user turns the participant was seen sending on a watched page.
  //  1. the page loaded older turns above the known ones (lazy loading): renumber the state
  //  2. a known turn changed or disappeared (an edit): rewind to it
  //  3. turns that were not sent on a watched page (a past chat's history, or turns typed on
  //     another device) are never judged; they end an open episode and the search restarts after them
  // Returns the updated chat and the episode that closed, if any (at most one: after step 2 or 3
  // closes an episode the chat is searching, so nothing else can close).
  function sync(chat, userTurns, sent) {
    const ids = turnIds(userTurns);
    let next = chat, closed = null;
    const offset = findOffset(chat.ids, ids);
    if (offset > 0) {
      const moved = (turn) => (turn === null ? null : turn + offset);
      next = { ...next, judgedThrough: next.judgedThrough + offset, segmentStart: next.segmentStart + offset,
               opening: moved(next.opening), end: moved(next.end),
               pending: next.pending && { ...next.pending, turn: next.pending.turn + offset } };
    } else if (offset < 0) {
      let same = 0;
      while (same < chat.ids.length && chat.ids[same] === ids[same]) same++;
      ({ chat: next, closed } = rewind(next, same + 1));
    }
    while (!next.pending && next.judgedThrough < ids.length && !sent.has(ids[next.judgedThrough])) {
      if (next.state === "episode") ({ chat: next, closed } = closeOpen(next, "history"));
      next = { ...next, judgedThrough: next.judgedThrough + 1, segmentStart: next.judgedThrough + 2 };
    }
    return { chat: { ...next, ids: ids.slice(0, next.judgedThrough) }, closed };
  }

  // The messages of turns start..end (each user turn and the assistant's reply to it).
  function episodeMessages(userTurns, replies, start, end) {
    const messages = [];
    for (let n = start; n <= end && n <= userTurns.length; n++) {
      messages.push({ role: "user", content: userTurns[n - 1] });
      if (replies[n - 1]) messages.push({ role: "assistant", content: replies[n - 1] });
    }
    return messages;
  }

  // A page that shows only part of a long chat (some sites load older messages when the
  // participant scrolls up, or render a long chat bit by bit): the stored copy `older` fills in
  // the rest, so turn numbers keep counting from the chat's first turn. Returns {messages, offset}:
  // the chat as it is now, and how many stored user turns come before the page's first one.
  //   the page shows the whole chat (perhaps with new turns at the end)  -> the page
  //   the page shows the chat's first turns, the rest is still loading    -> the stored copy
  //   the page shows the chat's last turns (perhaps with new ones)        -> stored turns before them + the page
  //   the page shows turns from the middle (scrolled up in a long chat)   -> the stored copy
  //   anything else (an edited turn, another chat)                        -> the page
  // NOTE: [design thought] the two are lined up by their user turns only: a reply can look
  // different after a reload (a reasoning summary collapsed, a table rendered), and the page's
  // version of a reply is the newer one
  function mergeWindow(older, newer) {
    const olderTurns = splitTurns(older).userTurns, newerTurns = splitTurns(newer).userTurns;
    const startsWith = (list, prefix) => prefix.length <= list.length && prefix.every((text, i) => list[i] === text);
    const asIs = { messages: newer, offset: 0 };
    if (!olderTurns.length || !newerTurns.length || startsWith(newerTurns, olderTurns)) return asIs;
    if (startsWith(olderTurns, newerTurns)) return { messages: older, offset: 0 };
    // the position in `messages` of its user turn number k (counting from 0)
    const userAt = (messages, k) => messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0)[k];
    for (let i = 1; i < olderTurns.length; i++) {           // the longest overlap first
      if (startsWith(newerTurns, olderTurns.slice(i))) {
        return { messages: older.slice(0, userAt(older, i)).concat(newer.slice(userAt(newer, 0))), offset: i };
      }
    }
    // NOTE: [edge case callout] Claude, Grok and Perplexity keep only the turns near the screen in
    // the page, so a participant scrolling up in a long chat shows a window from its middle
    for (let i = 1; i + newerTurns.length < olderTurns.length; i++) {
      if (startsWith(olderTurns.slice(i), newerTurns)) return { messages: older, offset: i };
    }
    return asIs;
  }

  // Where the user turns a page shows now (`shown`, texts in order) sit among those it showed before
  // (`known`, in the chat's order): the page may show a window of a long chat, load older turns
  // above, add new ones below, or go on differently from an edited turn. Returns the known turns
  // as they are now, the place of shown[0] among them (`at`), how many turns were added above
  // (`above`), the first known turn an edit replaced (`editedFrom`), and how many turns at the end
  // of `shown` are new (`fresh`): only those can be messages just sent. Turns that do not line up
  // with the known ones at all (another part of a long chat) change nothing: at = -1.
  // NOTE: [design thought] by position, not by a set of turn ids: an id counts repeated texts
  // ("ok", "yes") among the turns on the page, so the same id can name another turn once some
  // turns are no longer rendered
  function placeTurns(known, shown) {
    const same = (a, i, b, j, n) => { for (let k = 0; k < n; k++) if (a[i + k] !== b[j + k]) return false; return true; };
    if (!known.length) return { known: shown, at: 0, above: 0, editedFrom: null, fresh: shown.length };
    // shown[0] is known turn i: a window, perhaps with new turns after the known ones
    for (let i = 0; i < known.length; i++) {
      const overlap = Math.min(shown.length, known.length - i);
      if (same(known, i, shown, 0, overlap)) {
        return { known: known.concat(shown.slice(overlap)), at: i, above: 0, editedFrom: null, fresh: shown.length - overlap };
      }
    }
    // older turns loaded above: known[0] is shown turn j
    for (let j = 1; j < shown.length; j++) {
      const overlap = Math.min(known.length, shown.length - j);
      if (same(known, 0, shown, j, overlap)) {
        const after = shown.slice(j + known.length);
        return { known: shown.slice(0, j).concat(known, after), at: 0, above: j, editedFrom: null, fresh: after.length };
      }
    }
    // an edited turn: the chat goes on differently from the first turn that differs
    let common = 0;
    while (common < Math.min(known.length, shown.length) && known[common] === shown[common]) common++;
    if (common) return { known: shown, at: 0, above: 0, editedFrom: common, fresh: shown.length - common };
    return { known, at: -1, above: 0, editedFrom: null, fresh: 0 };
  }

  const api = { splitTurns, hash, turnIds, newChat, adviceTurns, nextJob, applyLabel, closeOpen, findOffset, sync, episodeMessages,
                mergeWindow, placeTurns, MAX_CONTEXT_TURNS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Episodes = api;
})(typeof self !== "undefined" ? self : globalThis);
