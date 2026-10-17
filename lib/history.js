// Conversations read from the chat site itself (0.6, with the participant's opt-in): their past
// conversations from before they joined the study, and the conversations they have in the site's
// phone or desktop apps after joining (these appear in the website's conversation list too). As pure
// functions (no Chrome APIs), so the Node tests can check every rule. The background worker and the
// chat pages (content/history.js) both load this file.
//
// Each user turn read from the site has its text and when it was sent. Its owner decides who judges
// it:
//   web   the participant was seen sending it on a watched page: the live path (background.js settle)
//         judged it already
//   past  sent before the participant joined (and within the lookback): judged here if readPast is on
//   app   sent after joining, not seen on the web, while tracking was on for the site and the
//         extension was running: judged here if readApps is on (the site's apps, another device, or
//         a send the page capture missed)
//   off   anything else (tracking off for the site then, before "delete all data", older than the
//         lookback, no time): never judged, and its text never leaves the chat page
// For each path the other one's turns are boundaries, as history turns are in Episodes.sync: they
// end an open episode, and the search starts again after them.
(function (root) {
  const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
  // NOTE: [design thought] a send on the page is logged when the snapshot that shows it comes in,
  // seconds after the site's own time stamp; a turn with no letters or digits (a picture alone) can be
  // told apart by time only, so its window is narrow
  const SAME_SEND_MS = 30 * MINUTE, SAME_SEND_BARE_MS = 3 * MINUTE;
  // NOTE: [edge case callout] the computer's clock (pauses, the extension's own log) and the site's
  // clock (turn times) can differ by minutes: a turn this close to a time tracking was off counts as off
  const CLOCK_MARGIN_MS = 10 * MINUTE;
  // the extension counts as running at a turn's time only if it logged that it ran within a day of it
  // (the study counts a day without a heartbeat as a day without tracking)
  const ALIVE_MS = DAY;

  // The periods when turns on `host` are never read, as [from, to] pairs: tracking off for the site
  // (paused, excluded, site access withheld: `trackingLog` [{at, on: [hosts]}], from background.js
  // noteTracking), widened by the clock margin; and gaps of more than two days between the times the
  // extension ran (`aliveLog`, ms), less a day at each end.
  function offPeriods(host, trackingLog, aliveLog, now) {
    const periods = [];
    trackingLog.forEach((entry, i) => {
      if (entry.on.includes(host)) return;
      const to = i + 1 < trackingLog.length ? trackingLog[i + 1].at : now;
      periods.push([entry.at - CLOCK_MARGIN_MS, to + CLOCK_MARGIN_MS]);
    });
    for (let i = 1; i < aliveLog.length; i++) {
      if (aliveLog[i] - aliveLog[i - 1] > 2 * ALIVE_MS) periods.push([aliveLog[i - 1] + ALIVE_MS, aliveLog[i] - ALIVE_MS]);
    }
    return periods;
  }

  // What may be read of `host` now, as the background worker hands it to the page reading the site:
  // {pastFrom, pastBefore, appFrom, off, readPast, readApps}. `pastBefore`: the end of the past (when
  // the participant joined); `floor`: the last "delete all data" (nothing before it is read again).
  function windows({ host, joinedAt, pastBefore = joinedAt, floor = 0, trackingLog = [], aliveLog = [], now, lookbackDays,
                     readPast, readApps }) {
    return { pastFrom: Math.max(floor, joinedAt - lookbackDays * DAY), pastBefore: Math.min(pastBefore, joinedAt),
             appFrom: Math.max(floor, joinedAt), off: offPeriods(host, trackingLog, aliveLog, now),
             readPast: Boolean(readPast), readApps: Boolean(readApps) };
  }

  // A turn's kind by its time alone: "past", "app" (a turn sent on the web is "app" here too: only the
  // background's log of sends tells them apart) or "off". Kinds that are turned off are "off".
  function timeKind(at, w) {
    if (!Number.isFinite(at)) return "off";
    if (at >= w.pastFrom && at < w.pastBefore) return w.readPast ? "past" : "off";
    if (at < w.appFrom || !w.readApps || w.off.some(([from, to]) => at >= from && at <= to)) return "off";
    return "app";
  }

  // The owner of each user turn ({h: loose hash, at}) of a conversation. `sentlog`: [{h, at}], the
  // loose hashes of the turns sent on watched pages (background.js); each entry stands for one turn
  // only: the nearest one in time with the same loose text, so an "ok" sent on the web and another
  // "ok" sent in the app are told apart. `bare`: the turn has no letters or digits (a picture alone).
  function owners(turns, { sentlog = [], windows: w }) {
    const web = new Set();
    for (const entry of sentlog) {
      let best = -1;
      turns.forEach(({ h, at, bare }, i) => {
        const gap = Math.abs(entry.at - at);
        if (web.has(i) || !Number.isFinite(at) || h !== entry.h || gap > (bare ? SAME_SEND_BARE_MS : SAME_SEND_MS)) return;
        if (best < 0 || gap < Math.abs(entry.at - turns[best].at)) best = i;
      });
      if (best >= 0) web.add(best);
    }
    return turns.map(({ at }, i) => {
      const kind = timeKind(at, w);
      // a web turn is one the page saw sent while tracking was on: past or off by time, it stays so
      return web.has(i) && kind === "app" ? "web" : kind;
    });
  }

  // A conversation read from the site, as the page hands it to the worker (content/history.js): each
  // user turn's loose hash and time, its text only if its time may be read (the replies to it the
  // same), replies cut to REPLY_MAX characters (more than the judge reads); null if it has more than
  // TURNS_MAX user turns (such a conversation is not read).
  // NOTE: [design thought] a turn sent while tracking was off never leaves the chat page, not even
  // into the extension's own storage
  const REPLY_MAX = 8000, TURNS_MAX = 400;
  // The site's title of the conversation is a summary of its first turns: it goes only if the first
  // turn may be read.
  function forWorker(conversation, w) {
    const user = conversation.messages.filter((m) => m.role === "user");
    if (user.length > TURNS_MAX) return null;
    const { id, url, createdAt, updatedAt } = conversation;
    const title = user.length && timeKind(user[0].at, w) !== "off" ? conversation.title ?? "" : "";
    let open = false;
    const messages = conversation.messages.map((m) => {
      if (m.role !== "user") return { role: m.role, content: open ? m.content.slice(0, REPLY_MAX) : null, at: m.at ?? null };
      open = timeKind(m.at, w) !== "off";
      return { role: "user", content: open ? m.content : null, at: m.at, h: root.Episodes.looseHash(m.content), bare: root.Episodes.loose(m.content) === "" };
    });
    return { id, url, title, createdAt, updatedAt, messages };
  }

  const api = { offPeriods, windows, timeKind, owners, forWorker, SAME_SEND_MS, SAME_SEND_BARE_MS, CLOCK_MARGIN_MS, ALIVE_MS, REPLY_MAX, TURNS_MAX };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.History = api;
})(typeof self !== "undefined" ? self : globalThis);
