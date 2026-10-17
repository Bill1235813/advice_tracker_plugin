// Gemini (gemini.google.com): read the participant's conversation list and past conversations,
// with their times, the way the site's own page does (see spec.md for the evidence).
//
// Gemini has no JSON API. The page talks to one endpoint, batchexecute, and names the call by an
// RPC id: MaZiqc is ListConversations and hNvQHb is ListConversationTurns, the calls the page makes
// to show its sidebar and a chat. This reader sends nothing else (never GzXR5e DeleteConversation,
// MUAZcd UpdateConversation, ...).
// NOTE: [pedagogical] batchexecute speaks JSPB: a protobuf message written as a JSON array in
// which field n sits at index n-1, unset fields are null and trailing ones are cut off. That is
// why everything below is read by position, e.g. a list row's time is row[5] (field 6). (The
// envelope's own rows, "wrb.fr", "er", "xsrf", start with their name, so there field n is at n.)
(function (root) {
  // NOTE: [thought process] the site itself asks for 13 to 60 list rows (it fits a page to the
  // window height) and for 10 turns, or 100 when it looks further back in a conversation
  const LIST_PAGE_SIZE = 50;
  const TURN_PAGE_SIZE = 100;
  // The list filter today's page sends: field 3 "asked by the web app" and field 10, which the page
  // calls "unpartitioned": pinned and other chats in one chain of pages, newest activity first.
  // NOTE: [thought process] with its feature flag 45821351 off, the page asks twice instead,
  // [1, null, 1] for the pinned chats and [0, null, 1] for the rest. One chain keeps the reader's
  // first page the newest chats, which is what the extension asks the first page for.
  const ALL_CHATS = [null, null, 1, null, null, null, null, null, null, 1];
  // The page copies these parameters of its own address onto every request, hl defaulting to
  // en-US; authuser and pageId among them pick the Google account or the brand page it shows
  const PAGE_PARAMS = ["e", "hl", "gl", "jsmode", "mjsmode", "deb", "opt", "route", "hotswaps", "authuser", "pageId", "duul", "nuul", "_hostType"];
  // the page numbers its requests (_reqid) upwards from a random start; so does this reader
  let requestNumber = 100000 + Math.floor(Math.random() * 900000);

  // Placeholders and markup in the answer's Markdown that the page draws as something else
  const IMAGE_PLACEHOLDER = /https?:\/\/googleusercontent\.com\/(?:image_generation_content|generated_image)\/\d+/g;
  // NOTE: [edge case callout] only an <Image> whose src is "image_agent_tag_..." is a picture the
  // page draws (one the image agent found): an answer about Next.js has real <Image src="/logo.png" /> code in it
  const IMAGE_AGENT_TAG = /<Image\b[^>]*\bsrc=["']image_agent_tag_[^"']*["'][^>]*>/g;
  const CARD_PLACEHOLDER = /https?:\/\/googleusercontent\.com\/card_content\/\d+/g;
  const CHIP_LINK = /\[([^\]]+)\]\(https?:\/\/googleusercontent\.com\/\w+\/\d+[^)]*\)/g;   // [Louvre](<chip>)
  const OTHER_PLACEHOLDER = /https?:\/\/googleusercontent\.com\/\w+\/\d+/g;     // Canvas, Deep Research, maps... chips
  // <FollowUp>...</FollowUp> (the opening tag not itself closed with "/>"), or a lone <FollowUp .../>
  const SUGGESTION_TAGS = /<(FollowUp|ElicitationsGroup|Elicitation|GenerateWidget)\b[^>]*(?<!\/)>[\s\S]*?<\/\1>|<(?:FollowUp|ElicitationsGroup|Elicitation|GenerateWidget)\b[^>]*>/g;
  const CITATION = / ?\[cite:\s*\d+(?:\s*,\s*\d+)*\]/g;

  // A time on the wire is a protobuf Timestamp, [seconds, nanoseconds]
  function toMs(time) {
    return Array.isArray(time) ? time[0] * 1000 + Math.floor((time[1] || 0) / 1e6) : null;
  }

  // The rows of a batchexecute response. The body is ")]}'" (it stops the text from running as a
  // script), then for each chunk a line with its length and a line of JSON holding a list of rows.
  // NOTE: [pedagogical] JSON never contains a raw line break (they are written \n), so each
  // chunk is exactly one line and the length lines can be skipped
  function rowsOf(text) {
    return text.split("\n").filter((line) => line.startsWith("[")).flatMap((line) => JSON.parse(line));
  }

  // The ["xsrf", token, [user id]] message anywhere inside a value, or null
  // NOTE: [pedagogical] protobuf extensions (and a MessageSet is made of nothing else) sit in a JSON
  // object keyed by field number, {"48448350": [...]}; Object.values walks arrays and objects alike
  function findXsrf(value) {
    if (!value || typeof value !== "object") return null;
    if (value[0] === "xsrf" && typeof value[1] === "string") return value;
    for (const part of Object.values(value)) {
      const found = findXsrf(part);
      if (found) return found;
    }
    return null;
  }

  function httpError(response) {
    const error = new Error(`Gemini answered HTTP ${response.status}`);
    error.status = response.status;
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) error.retryAfterMs = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    return error;
  }

  // One call: POST {f.req: [[[rpc id, arguments as a JSON string, null, "generic"]]], at: token}.
  // Returns the call's payload (its JSON decoded), or throws.
  async function rpc(context, auth, rpcId, args, isRetry = false) {
    const query = new URLSearchParams({ rpcids: rpcId, "source-path": context.location.pathname, bl: auth.bl, "f.sid": auth.sid, ...auth.pageParams });
    query.set("_reqid", String(requestNumber++));
    query.set("rt", "c");
    const body = new URLSearchParams({ "f.req": JSON.stringify([[[rpcId, JSON.stringify(args), null, "generic"]]]), at: auth.at });
    const response = await context.fetch(`${context.location.origin}${auth.endpoint}data/batchexecute?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "X-Same-Domain": "1" },
      body: body.toString(),
      credentials: "same-origin",
    });
    const text = await response.text();
    const isBatchexecute = text.startsWith(")]}'");
    const rows = isBatchexecute ? rowsOf(text) : [];
    // NOTE: [thought process] the token comes from the page's HTML, so it is as old as the page.
    // When it has expired, the server answers with an "er" row (the request's error) whose field
    // 10 is a MessageSet holding, as extension 48448350, ["xsrf", fresh token, [user id]]. The
    // page takes the token only if the user id is its own (S06Grb) and then retries; so does this
    // reader, once. auth keeps the fresh token for later calls.
    const xsrf = findXsrf(rows.filter((row) => row[0] === "er"));
    if (xsrf && !isRetry && auth.accountId && Array.isArray(xsrf[2]) && xsrf[2][0] === auth.accountId) {
      auth.at = xsrf[1];
      return rpc(context, auth, rpcId, args, true);
    }
    if (!response.ok) throw httpError(response);
    // NOTE: [edge case callout] a page instead of data (a sign-in page, a "sorry" page) is thrown as
    // a SyntaxError, as JSON.parse would throw it: the extension's sign that the site does not want
    // to be read now (content/history.js)
    if (!isBatchexecute) throw new SyntaxError("Gemini answered with a page instead of batchexecute data");
    // the call's row: ["wrb.fr", rpc id, payload as a JSON string, null, null, error, "generic"]
    const row = rows.find((candidate) => candidate[0] === "wrb.fr" && candidate[1] === rpcId);
    if (row && typeof row[2] === "string") return JSON.parse(row[2]);
    // NOTE: [edge case callout] a call can also fail inside an HTTP 200, and is then thrown (never
    // read as "nothing there"): the call's row has no payload but a status at row[5] with a
    // BardErrorInfo code, or an "er" row stands for the whole request. 1096 is what exporters see
    // when Google limits them: it is reported as 429 so that callers back off. Anything else is 500.
    const rpcError = row ? row[5] : null;
    const error = new Error(`Gemini ${rpcId} returned no data: ${row ? JSON.stringify(rpcError) : "an error row"}`);
    error.status = /\b1096\b/.test(JSON.stringify(rpcError)) ? 429 : 500;
    error.rpcError = rpcError;
    throw error;
  }

  // A deleted conversation: HTTP 404, or BardErrorInfo 1167 (as exporters see it)
  function isGone(error) {
    return error.status === 404 || /\b1167\b/.test(JSON.stringify(error.rpcError));
  }

  // Whether the page shows a list row's chat at all (its test lTd, as for a chat it opens): not
  // marked hidden (row[3]), and not one of two kinds the page names only in minified code (row[20]
  // set, row[23] = 4). Chats inside a project are kept: the sidebar leaves them to the project's page.
  function shownByPage(row) {
    return !row[3] && !row[20] && row[23] !== 4;
  }

  // The answer the page shows for one turn, as Markdown, or "" if there is none (yet)
  function replyOf(response) {
    if (!response) return "";
    // NOTE: [pedagogical] "Redo" keeps every draft of the answer in response[0]; response[3]
    // names the draft the page shows (the page falls back to the first one)
    const drafts = response[0] || [];
    const shown = drafts.find((draft) => draft[0] === response[3]) || drafts[0];
    // NOTE: [edge case callout] response[9] = false: not final; with response[10] = true the
    // participant stopped it (the page shows what was written), otherwise it is still being written
    if (!shown || (response[9] === false && response[10] !== true)) return "";
    // The answer's Markdown is draft[1][0] (the page allows a draft without it). Thinking
    // (draft[37]), search and tool steps (response[1], [4], [5]), and the sources of citations
    // live in other slots and are left out.
    let text = (shown[1] && shown[1][0]) || "";
    // a card (weather, ...): its text is in draft[22], put where the card's placeholder is
    const cardText = (shown[22] && shown[22][0]) || "";
    text = text.replace(CARD_PLACEHOLDER, () => cardText);
    // each picture in the answer (made by Gemini, or found by its image agent) becomes "[image]",
    // first, as the page reader writes the pictures in a reply
    const images = [...(text.match(IMAGE_PLACEHOLDER) || []), ...(text.match(IMAGE_AGENT_TAG) || [])].map(() => "[image]");
    // NOTE: [thought process] spaces before a line break and runs of blank lines are tidied the
    // way the page reader tidies a reply's text, so both copies read alike
    text = text.replace(CHIP_LINK, "$1")      // a link to a chip keeps its words
      .replace(IMAGE_PLACEHOLDER, "").replace(OTHER_PLACEHOLDER, "")
      .replace(IMAGE_AGENT_TAG, "")
      .replace(SUGGESTION_TAGS, "")          // suggested follow-ups: chips, not text
      .replace(CITATION, "")                 // "[cite: 1]": a citation chip on the page
      .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return [...images, text].filter(Boolean).join("\n");
  }

  // The messages of one turn: the participant's prompt, then the answer; both carry the turn's time
  function messagesOf(turn) {
    const at = toMs(turn[4]);
    const messages = [];
    // NOTE: [edge case callout] the page treats the request part (turn[2]) and its prompt as optional
    const prompt = (turn[2] && turn[2][0]) || [];
    // Uploads sit in prompt[4]: groups whose 4th slot lists the files, each
    // [.., file type, name, ...]; file type 1 is a picture. The page shows them above the text.
    const files = (prompt[4] || []).flatMap((group) => (group && group[3]) || []);
    const tags = files.map((file) => (file[1] === 1 ? "[image]" : `[file: ${file[2]}]`));
    // NOTE: [thought process] the page shows each line of a prompt as a paragraph, and the page
    // reader writes paragraphs apart by a blank line; so does this reader
    const text = (prompt[0] || "").replace(/\s*\n\s*/g, "\n\n").trim();
    if (tags.length || text) messages.push({ role: "user", content: [...tags, text].filter(Boolean).join("\n"), at });
    const reply = replyOf(turn[3]);
    if (reply) messages.push({ role: "assistant", content: reply, at });
    return messages;
  }

  const reader = {
    host: "gemini.google.com",

    // What every call needs, from the page's inline <script data-id="_gd">
    // (window.WIZ_global_data = {...}): at = SNlM0e, bl = cfb2h, f.sid = FdrFJe, the endpoint's
    // folder = eptZe; the account: its user id S06Grb (accountId, also for a fresh token, see rpc),
    // its index QrtxK ("0" for the first signed-in account) and its address oPEP7c (for personal).
    // NOTE: [thought process] a content script cannot read the page's variables, but it can read
    // this script's text. Signed out, the page has no SNlM0e: null.
    async auth(context) {
      const script = context.document.querySelector('script[data-id="_gd"]');
      if (!script) throw new Error("Gemini page data (WIZ_global_data) not found");
      const value = (key) => (script.textContent.match(new RegExp(`"${key}":"([^"]*)"`)) || [])[1];
      if (!value("SNlM0e")) return null;
      const address = new URLSearchParams(context.location.search);
      const pageParams = { hl: "en-US" };
      for (const name of PAGE_PARAMS) if (address.get(name)) pageParams[name] = address.get(name);
      // "/u/1" in the address of a second signed-in account; an address with ?authuser=1 has none,
      // but the page's QrtxK still says "1"
      const pathAccount = (context.location.pathname.match(/^\/u\/\d+(?=\/|$)/) || [""])[0];
      const index = value("QrtxK");
      const folder = value("eptZe") || "/_/BardChatUi/";
      return {
        at: value("SNlM0e"),
        bl: value("cfb2h"),
        sid: value("FdrFJe"),
        pageParams,
        accountId: value("S06Grb") || null,
        // NOTE: [edge case callout] a Google Workspace account (work, school) has its own domain;
        // only a gmail.com address is surely a personal account. A personal account with another
        // address, or a page without oPEP7c, is taken as not personal, and so is never read.
        personal: /@(?:gmail|googlemail)\.com$/i.test(value("oPEP7c") || ""),
        // for links (pathOf): the account's /u/<n>, however the page was opened
        account: pathAccount || (index && index !== "0" ? `/u/${index}` : ""),
        // NOTE: [edge case callout] the exporters send a second account's calls to /u/<n>/... (as
        // the page's address does). Whether eptZe already says so on such a page is not known, so
        // the address's prefix is added only when it is missing.
        endpoint: folder.startsWith("/u/") ? folder : pathAccount + folder,
      };
    },

    // One page of the conversation list, newest activity first, pinned chats among the others.
    // Request [page size, page token, filter]; answer [null, next page token, rows], a row [id,
    // title, pinned, hidden, icon, [seconds, nanos] of the last activity, ...]. The list has no
    // creation time. `cursor` is null for the first page, then the `next` of the page before;
    // `next` null is the end.
    // NOTE: [edge case callout] a page can come back with no items and a `next` (all its rows were
    // left out): only `next` null ends the list
    async list(context, auth, cursor) {
      let page;
      try {
        page = await rpc(context, auth, "MaZiqc", [LIST_PAGE_SIZE, cursor, ALL_CHATS]);
      } catch (error) {
        // NOTE: [thought process] Google stops paging at about 600 chats (the page's own sidebar
        // too): a later page then comes back refused, with a BardErrorInfo, as exporters see it. A
        // refusal there ends the list, as it ends their scans: asked again, it only refuses again.
        // (An "er" row, an HTTP error or a page instead of data is still thrown.)
        if (cursor && /BardErrorInfo/.test(JSON.stringify(error.rpcError))) return { items: [], next: null };
        throw error;
      }
      return {
        items: (page[2] || []).filter(shownByPage).map((row) => ({
          id: row[0].replace(/^c_/, ""),     // "c_5c1e7d90a2b4f368" -> the id in the page's address
          title: row[1] || "",
          createdAt: null,
          updatedAt: toMs(row[5]),
          pinned: row[2] === true,
          account: auth.account,             // for pathOf
        })),
        // NOTE: [edge case callout] a server handing back the page token it was given would make a
        // scan loop for ever: the list ends there
        next: page[1] && page[1] !== cursor ? page[1] : null,
      };
    },

    // One conversation, in page order, or null if it does not exist. Its turns come newest first,
    // TURN_PAGE_SIZE at a time: [turns, next cursor, null, documents]. A turn is
    // [[c id, r id], [c id, parent r id, parent rc id], prompt, response, [seconds, nanos]].
    // NOTE: [thought process] the page shows every turn it gets, in the order it gets them, with
    // no choosing between versions of an edited prompt; so the reader takes them all too, and
    // reads what the page shows. Only the drafts of an answer need choosing (replyOf).
    async read(context, auth, id) {
      const turns = [];
      const cursors = new Set();
      let cursor = null;
      try {
        do {
          // [1]: the page's dark-theme flag; the last 1: sent under flag 45675814 (on today)
          const page = await rpc(context, auth, "hNvQHb", [`c_${id}`, TURN_PAGE_SIZE, cursor, 1, [1], [4], null, 1]);
          turns.push(...(page[0] || []));
          cursor = page[1] || null;
          // NOTE: [thought process] a cursor seen before would loop for ever; half a conversation
          // is not returned in its place, since it would be annotated as if it were whole
          if (cursor && cursors.has(cursor)) throw new Error("Gemini hNvQHb repeated a cursor");
          cursors.add(cursor);
        } while (cursor);
      } catch (error) {
        if (isGone(error)) return null;
        throw error;
      }
      turns.reverse();     // oldest first, as the page shows them
      // The title is not in the turns: ask for the conversation's own list row, as the page does
      // NOTE: [edge case callout] if that call fails, the turns already read are kept: the title is
      // then "" and the update time the newest turn's (the same time as the row's, see spec §3)
      let row = null;
      try {
        const metadata = await rpc(context, auth, "MaZiqc", [1, null, [null, null, 1, null, 1, `c_${id}`]]);
        row = (metadata[2] || [])[0] || null;
      } catch (error) {
        if (isGone(error)) return null;
      }
      if (!turns.length && !row) return null;
      const times = turns.map((turn) => toMs(turn[4])).filter((time) => time !== null);
      return {
        id,
        title: row ? row[1] || "" : "",
        createdAt: times.length ? times[0] : null,     // the first turn of the chain
        updatedAt: row ? toMs(row[5]) : times.length ? times[times.length - 1] : null,
        messages: turns.flatMap(messagesOf),
        account: auth.account,                         // for pathOf
      };
    },

    // The page of a conversation: /app/<id>, under /u/<n> for a second account
    // NOTE: [edge case callout] a Gem's chats are shown at /gem/<gem id>/<id>; the chat key is
    // the same id, and /app/<id> is the site's generic link to any conversation. A brand page
    // (?pageId=) is not in the link: opened from it, the link shows the person's own account.
    pathOf(id, item) {
      return `${(item && item.account) || ""}/app/${id}`;
    },
  };

  root.HISTORY_READERS = root.HISTORY_READERS || {};
  root.HISTORY_READERS[reader.host] = reader;
  if (typeof module !== "undefined" && module.exports) module.exports = reader;
})(typeof self !== "undefined" ? self : globalThis);
