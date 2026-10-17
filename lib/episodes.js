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
//   pending        the judgment in flight, {id, kind, turn, sentAt, hash (of the judged turn's text),
//                  label (once it came, if the page changed meanwhile)}; set by the background worker
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

  // NOTE: [design thought] the same message read from the page and from the site's own API (past and
  // other-device conversations, lib/history.js) can differ in spacing, markdown marks and where the
  // attachment tags sit; its loose form keeps only letters and digits (lowercase, the first 300), enough
  // to tell whether two copies are the same message without keeping its text
  function loose(text) {
    return text.replace(/\[(?:image|file: [^\]]*)\]/g, " ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 300);
  }
  const looseHash = (text) => hash(loose(text));

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
  // NOTE: [edge case callout] compared by their texts' hashes, without the occurrence numbers: older
  // turns loaded above that repeat a text ("ok") renumber the occurrences of every later copy, and
  // the order of a run of turns already tells repeated texts apart
  const plain = (id) => id.split(":")[0];
  function findOffset(known, ids) {
    for (let d = 0; d + known.length <= ids.length; d++) {
      if (known.every((id, i) => plain(ids[d + i]) === plain(id))) return d;
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
  //  1. the page loaded older turns above the settled ones (lazy loading): renumber the state
  //  2. a settled turn changed or disappeared (an edit): rewind to it
  //  3. turns that were not sent on a watched page (a past chat's history, or turns typed on
  //     another device) are never judged; they end an open episode and the search restarts after them
  // Returns the updated chat and the episode that closed, if any (at most one: after step 2 or 3
  // closes an episode the chat is searching, so nothing else can close).
  // NOTE: [design thought] the background keeps a copy of the chat while it is needed (an unjudged
  // turn, an open episode: mergeWindow fills a partial page in from it). Without one, a page that
  // shows only part of the chat lines up with the settled turns by their ids. Older turns above
  // them are history, whether or not the page reaches the chat's end; a part that starts below
  // the chat's first turn changes nothing, unless it has new turns: then the chat is numbered from
  // the page's first turn on. `whole`: the snapshot holds the chat from its first settled turn on
  // (the background's copy, lined up with the chat), so it cannot start below it.
  function sync(chat, userTurns, sent, whole = false) {
    const ids = turnIds(userTurns);
    let next = chat, closed = null;
    const at = lineUp(chat.ids, ids, whole);
    if (at === null) {
      let same = 0;
      while (same < chat.ids.length && same < ids.length && plain(chat.ids[same]) === plain(ids[same])) same++;
      ({ chat: next, closed } = rewind(next, same + 1));
    } else {
      const end = at + ids.length;                 // where the page ends among the settled turns
      if (at < 0 || (at > 0 && end > chat.ids.length)) {
        const moved = (turn) => (turn === null ? null : turn - at);
        next = { ...next, judgedThrough: next.judgedThrough - at, segmentStart: Math.max(1, next.segmentStart - at),
                 opening: moved(next.opening), end: moved(next.end),
                 pending: next.pending && { ...next.pending, turn: next.pending.turn - at } };
      }
      if (end < chat.ids.length || (at > 0 && end === chat.ids.length)) {
        // a part of the settled turns, nothing after them: nothing to judge (the settled turns
        // below the page keep their ids)
        return { chat: at > 0 ? chat : { ...next, ids: ids.concat(chat.ids.slice(end)) }, closed: null };
      }
    }
    // NOTE: [edge case callout] a judgment in flight about a turn edited since (a typo fixed right
    // after sending): its label is about the old text, so it is dropped and the turn judged again
    if (next.pending?.hash && plain(ids[next.pending.turn - 1] || "") !== next.pending.hash) next = { ...next, pending: null };
    while (!next.pending && next.judgedThrough < ids.length && !sent.has(ids[next.judgedThrough])) {
      if (next.state === "episode") ({ chat: next, closed } = closeOpen(next, "history"));
      next = { ...next, judgedThrough: next.judgedThrough + 1, segmentStart: next.judgedThrough + 2 };
    }
    return { chat: { ...next, ids: ids.slice(0, next.judgedThrough) }, closed };
  }

  // Where the page's turn ids sit among the settled ones (`known`): the place of ids[0] (negative:
  // older turns loaded above), or null when they do not line up (an edit). When repeated texts
  // ("ok", "[image]") allow several places: the chat's start first (a chat grows at its end), then
  // older turns above (the background's copy, when there is one, always holds the chat from its
  // start), then a part further down.
  // `whole`: places further down are ruled out (see sync).
  function lineUp(known, ids, whole = false) {
    if (!known.length) return 0;
    const asTurns = (list) => list.map((id) => ({ text: plain(id), reply: "" }));
    const order = (place) => (place.at === 0 ? 0 : place.at < 0 ? 1 : 2);
    const found = placements(asTurns(known), asTurns(ids)).filter((place) => !whole || place.at <= 0);
    return found.sort((a, b) => order(a) - order(b) || byFit(a, b))[0]?.at ?? null;
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

  // ---------------- lining up the turns a page shows with the turns known before ----------------
  // A chat page may show only part of a long chat (Claude, Grok and Perplexity keep only the turns
  // near the screen in the page; others load older messages when the participant scrolls up), add
  // new turns below, or go on differently from an edited turn. The content script lines up what the
  // page shows with what it showed before (placeTurns), and the background lines up each snapshot
  // with its stored copy (mergeWindow), so turn numbers keep counting from the chat's first turn.
  // Both work on turns {text, reply}: a user message and the assistant's reply to it.
  // NOTE: [design thought] by position, not by a set of turn ids: an id counts repeated texts
  // ("ok", "continue") among the turns on the page, so the same id names another turn once some
  // turns are no longer rendered. Repeated texts are told apart by their replies.

  function turnsOf(messages) {
    const { userTurns, replies } = splitTurns(messages);
    return userTurns.map((text, k) => ({ text, reply: replies[k] }));
  }
  function messagesOf(turns) {
    return turns.flatMap((turn) => [{ role: "user", content: turn.text }, ...(turn.reply ? [{ role: "assistant", content: turn.reply }] : [])]);
  }

  // Two replies to the same text disagree when neither is empty or the start of the other (a reply
  // still being written grows at its end).
  // NOTE: [edge case callout] a reply can also change while it is written in ways that are not
  // growth (a table or a formula rendered once complete): replies break ties between the places
  // and edits the texts allow, and a turn is put after all known ones for its reply only when a
  // message was just sent (placeTurns) or the page saw that many turns arrive (mergeWindow)
  const disagree = (a, b) => Boolean(a && b && !a.startsWith(b) && !b.startsWith(a));

  // Every place `shown` can sit among `known`: shown[k] is known[at + k] wherever both exist, with
  // equal texts, and at least one turn is in both. at < 0: the first -at shown turns come before
  // known[0] (`above`); shown turns after known's last are new (`added`). `disagree`: how many of
  // the turns in both have replies that disagree.
  // NOTE: [performance improvement] each place compares texts until the first difference, so this is
  // about linear in the number of turns unless most texts repeat; an index of the known texts would
  // find the candidate places directly
  function placements(known, shown) {
    const found = [];
    if (!shown.length) return found;
    for (let at = 1 - shown.length; at < known.length; at++) {
      let fits = true, disagreeing = 0;
      for (let k = Math.max(0, -at); k < shown.length && at + k < known.length && fits; k++) {
        fits = known[at + k].text === shown[k].text;
        if (disagree(known[at + k].reply, shown[k].reply)) disagreeing++;
      }
      if (fits) found.push({ at, above: Math.max(0, -at), added: Math.max(0, at + shown.length - known.length), disagree: disagreeing });
    }
    return found;
  }
  // the best place first: the fewest disagreeing replies, a place the texts line up at before one
  // after all known turns (`after`, below), then the fewest turns above and new turns below (a chat
  // grows at its end; older turns come in above only when the participant scrolls up), then the
  // earliest
  const byFit = (a, b) => a.disagree - b.disagree || Boolean(a.after) - Boolean(b.after) || a.above - b.above || a.added - b.added ||
                          a.at - b.at;
  // after all known turns: every shown turn is new (no turn in both, so no reply disagrees)
  const afterAll = (known, shown) => ({ at: known.length, above: 0, added: shown.length, disagree: 0, after: true });

  // The turns of `known` and `shown` together, `shown` placed at `at`: the page's copy of a turn in
  // both is the newer one, but the known reply stays while the page's is only its start (still
  // empty, or being written again).
  function joinTurns(known, shown, at) {
    const turns = [];
    for (let p = Math.min(at, 0); p < Math.max(known.length, at + shown.length); p++) {
      const before = known[p], now = shown[p - at];      // undefined outside each list
      const keeps = before && now && (before.reply || "").startsWith(now.reply || "");
      turns.push(before && now ? { text: now.text, reply: keeps ? before.reply || "" : now.reply } : now || before);
    }
    return turns;
  }

  // An edited turn: `shown` agrees with known turns at.. for `common` turns, then goes on
  // differently (the longest such run; then the one whose replies disagree least, then the latest).
  // `disagree`: as for a place. Null when no run of turns goes on differently.
  function findEdit(known, shown) {
    let best = null;
    for (let at = 0; at < known.length; at++) {
      let common = 0, disagreeing = 0;
      while (at + common < known.length && common < shown.length && known[at + common].text === shown[common].text) {
        if (disagree(known[at + common].reply, shown[common].reply)) disagreeing++;
        common++;
      }
      const goesOn = common > 0 && common < shown.length && at + common < known.length;
      if (goesOn && (!best || common > best.common || (common === best.common && disagreeing <= best.disagree))) {
        best = { at, common, disagree: disagreeing };
      }
    }
    return best;
  }
  const editTurns = (known, shown, edit) => known.slice(0, edit.at).concat(joinTurns(known.slice(edit.at, edit.at + edit.common), shown, 0));
  // NOTE: [edge case callout] an edited turn whose earlier turns repeat other texts ("[image]",
  // "ok") can also fit a place, with replies that disagree: the edit wins when its replies agree better
  const editWins = (edit, place) => Boolean(edit) && (!place || edit.disagree < place.disagree);

  // Where the user turns a page shows now (`shown`, {text, reply} in order) sit among the ones it
  // showed before (`known`, in the chat's order). `expected`: how many messages the participant
  // sent that are not on the page yet. Returns the known turns as they are now (`known`), the
  // place of shown[0] among them (`at`), how many turns were added above (`above`), the first
  // known turn an edit replaced (`editedFrom`), and how many turns at the end of `shown` are new
  // (`fresh`): only those can be messages just sent. Also `disagree` (replies of the turns in both
  // that disagree) and `after` (placed after all known turns). Turns that do not line up at all:
  // at = -1.
  function placeTurns(known, shown, expected = 0) {
    if (!known.length) return { known: shown, at: 0, above: 0, editedFrom: null, fresh: shown.length, disagree: 0, after: false };
    const candidates = placements(known, shown);
    // NOTE: [edge case callout] a page that shows only the newest turn, a repeated text sent just
    // now ("continue"): its place could also be after all known turns, the one place left when
    // the reply on the page disagrees with every earlier copy of the text
    if (candidates.length && expected >= shown.length) candidates.push(afterAll(known, shown));
    const place = candidates.sort(byFit)[0], edit = findEdit(known, shown);
    if (editWins(edit, place)) {
      return { known: editTurns(known, shown, edit), at: edit.at, above: 0, editedFrom: edit.at + edit.common,
               fresh: shown.length - edit.common, disagree: edit.disagree, after: false };
    }
    if (place) {
      return { known: joinTurns(known, shown, place.at), at: Math.max(place.at, 0), above: place.above, editedFrom: null,
               fresh: place.added, disagree: place.disagree, after: Boolean(place.after) };
    }
    return { known, at: -1, above: 0, editedFrom: null, fresh: 0, disagree: 0, after: false };
  }

  // The prompt of a reply that a page shows at its top without its prompt (only the messages near
  // the screen are rendered, and the reply is long): the turn of `known` whose reply it is, if
  // just one. Null otherwise.
  function promptOf(known, messages) {
    const leading = messages[0]?.role === "assistant" ? messages[0].content : "";
    const owners = leading ? known.filter((turn) => turn.reply && !disagree(turn.reply, leading)) : [];
    return owners.length === 1 ? { text: owners[0].text, reply: leading } : null;
  }

  // The chat as the background keeps it: the stored copy `older` with the page's messages `newer`
  // placed in it. `fresh` (from the content script, see placeTurns): how many of the page's turns
  // were new to the page since its last snapshot (more cannot be new to the stored copy, unless it
  // missed some), or null when the page had not shown the chat before (a reload, the chat opened
  // again: then every turn is new to the page, but not to the chat). `claimed`: the page lists turns
  // sent there. Returns {messages, pageShift, storedShift, storedKeep}: the chat now, and where the
  // turns went: page turn k is turn k + pageShift of the chat (null: the page was not placed),
  // stored turn p is turn p + storedShift, and only stored turns before storedKeep are still there.
  //   the page shows the whole chat, or part of it (a window, older turns above, new turns below)
  //                                         -> the stored turns with the page's in place
  //   an edited turn                        -> the stored turns before it + the page from there
  //   nothing lines up, and nothing is new to the page or sent there (it shows a part the stored
  //   copy lacks)                           -> the stored copy
  //   anything else (the first turn shown was edited, another chat) -> the page
  // A reply at the top of the page whose prompt is not rendered gets its prompt back from the
  // stored copy (promptOf; the content script does the same when it saw that turn itself).
  function mergeWindow(older, newer, { fresh = null, claimed = true } = {}) {
    const olderTurns = turnsOf(older), lead = promptOf(olderTurns, newer);
    const newerTurns = (lead ? [lead] : []).concat(turnsOf(newer));
    // (the page's own turn k is turn k + 1 of newerTurns when its prompt was put back)
    const result = (turns, pageShift, storedShift, storedKeep) => ({ messages: messagesOf(turns), storedShift, storedKeep,
                                                                     pageShift: pageShift === null ? null : pageShift + (lead ? 1 : 0) });
    if (!olderTurns.length) return result(newerTurns, 0, 0, 0);
    if (!newerTurns.length) return result(olderTurns, null, 0, Infinity);
    const bound = fresh ?? Infinity;
    const candidates = placements(olderTurns, newerTurns);
    if (candidates.length && fresh !== null && fresh >= newerTurns.length) candidates.push(afterAll(olderTurns, newerTurns));
    // NOTE: [edge case callout] a place that adds more new turns than the page saw arrive comes last:
    // a window whose first turns repeat the chat's last ones would otherwise add them again
    const beyond = (candidate) => (candidate.added > bound ? 1 : 0);
    const place = candidates.sort((a, b) => beyond(a) - beyond(b) || byFit(a, b))[0];
    const edit = fresh === 0 ? null : findEdit(olderTurns, newerTurns);
    if (editWins(edit, place)) return result(editTurns(olderTurns, newerTurns, edit), edit.at, 0, edit.at + edit.common);
    if (place) return result(joinTurns(olderTurns, newerTurns, place.at), Math.max(place.at, 0), place.above, Infinity);
    if (fresh === 0 || !claimed) return result(olderTurns, null, 0, Infinity);
    return result(newerTurns, 0, 0, 0);
  }

  // The ids of turns of `from` (user turns), as the ids of the same turns in `to`, where turn p of
  // `from` is turn p + shift of `to`; turns from `keep` on are gone (null)
  function renumber(from, to, shift, keep = Infinity) {
    const fromIds = turnIds(from), toIds = turnIds(to);
    return (id) => {
      const p = fromIds.indexOf(id);
      return p >= 0 && p < keep ? toIds[p + shift] ?? null : null;
    };
  }

  const api = { splitTurns, hash, loose, looseHash, turnIds, newChat, adviceTurns, nextJob, applyLabel, closeOpen, rewind, findOffset, sync, episodeMessages,
                turnsOf, mergeWindow, placeTurns, promptOf, renumber, lineUp, MAX_CONTEXT_TURNS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Episodes = api;
})(typeof self !== "undefined" ? self : globalThis);
