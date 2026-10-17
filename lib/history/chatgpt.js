// History reader for ChatGPT (chatgpt.com). With the participant's opt-in, the extension's content
// script lists the participant's conversations and reads one conversation, with its timestamps,
// through the same read-only endpoints the site's own page calls (GET only). What each endpoint,
// header and field is, and the evidence for it: spec.md next to this file.
(function (root) {
  // NOTE: [design thought] the page asks for 28 conversations per list page, so we do too. For a
  // conversation it asks for a number of turns that an experiment sets (10 in reports); 100 turns
  // per page, as a maintained exporter (AIExporter) and a community script ask, reads most
  // conversations in one request.
  const LIST_PAGE_SIZE = 28;
  const TURNS_PER_PAGE = 100;

  // One GET to the site. An HTTP error becomes an Error with .status (and .retryAfterMs).
  async function getJson(context, auth, path) {
    const response = await context.fetch(context.location.origin + path, { headers: auth ? auth.headers : {} });
    if (!response.ok) {
      const error = new Error(`GET ${path} returned ${response.status}`);
      error.status = response.status;
      const retryAfterMs = retryAfter(response.headers);
      if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
      throw error;
    }
    return response.json();
  }

  // NOTE: [pedagogical] Retry-After holds either seconds ("30") or an HTTP date. ChatGPT's history
  // endpoints have also been seen sending x-oai-history-initial-retry-after, and some 429s send
  // neither (then the caller picks its own wait).
  function retryAfter(headers) {
    const value = headers.get("retry-after") ?? headers.get("x-oai-history-initial-retry-after");
    if (!value) return null;
    if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
  }

  // Seconds since 1970 (conversation and message times) or an ISO date (list items) -> ms.
  function toMs(time) {
    if (time === null || time === undefined) return null;
    return typeof time === "number" ? Math.round(time * 1000) : Date.parse(time);
  }

  function cookie(document, name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? match[1] : null;
  }

  // An answer that is not of the shape we know (the page then reads the older endpoint instead).
  const unexpected = (message) => Object.assign(new Error(message), { unexpected: true });

  // ------------------------------------------------------------------ the conversation list

  function listItem(conversation) {
    return {
      id: conversation.id,
      title: conversation.title,
      createdAt: toMs(conversation.create_time),
      updatedAt: toMs(conversation.update_time),
      // a project's ("g-p-...") or a custom GPT's ("g-...") id; pathOf puts it in the path
      gizmoId: conversation.gizmo_id ?? null,
    };
  }

  // The pinned conversations, which the list leaves out: GET /backend-api/pins answers an array of
  // pinned items, conversations among them. The page loads them on their own and shows none when
  // that fails; so do we, except when the site asks us to slow down (429) or to sign in again (401).
  // NOTE: [edge case callout] the shape of /pins is read from the page's code; no real answer was seen.
  async function pinnedConversations(context, auth) {
    let pins;
    try {
      pins = await getJson(context, auth, "/backend-api/pins");
    } catch (error) {
      if (error.status === 401 || error.status === 429) throw error;
      return [];
    }
    if (!Array.isArray(pins)) return [];
    return pins.filter((pin) => pin && pin.item_type === "conversation" && pin.item && pin.item.id).map((pin) => listItem(pin.item));
  }

  // ------------------------------------------------------------------ one conversation

  // The current branch from the paged endpoint, which the page tries first: the newest turns,
  // then older pages before the oldest message seen, until there are none.
  async function readPages(context, auth, id) {
    const query = `include_has_versions=true&num_turns=${TURNS_PER_PAGE}`;
    const checked = (page) => {
      if (!page || !Array.isArray(page.messages) || !page.page_info) throw unexpected(`a page of ${id} has no messages or page_info`);
      return page;
    };
    const first = checked(await getJson(context, auth, `/backend-api/conversations/${id}?${query}`));
    let messages = first.messages;                 // oldest first, the current branch only
    let pageInfo = first.page_info;
    const cursors = new Set();
    while (pageInfo.has_previous_page) {
      const cursor = pageInfo.start_cursor;
      // NOTE: [edge case callout] the page itself stops with an error when a cursor comes back; so do
      // we, rather than loop forever (and, like the page, read the older endpoint instead)
      if (cursors.has(cursor)) throw unexpected(`the older pages of ${id} do not advance`);
      cursors.add(cursor);
      const older = checked(await getJson(context, auth, `/backend-api/conversations/${id}/messages?before=${encodeURIComponent(cursor)}&${query}`));
      // NOTE: [edge case callout] pages are not known to overlap; a message already seen is kept once.
      const seen = new Set(messages.map((message) => message.id));
      messages = [...older.messages.filter((message) => !seen.has(message.id)), ...messages];
      pageInfo = older.page_info;
    }
    return { ...first, messages };
  }

  // The current branch from the older endpoint, which returns the whole tree of a conversation:
  // every version of an edited message or a regenerated reply. The branch on screen is the path
  // from current_node up to the root.
  async function readTree(context, auth, id) {
    const tree = await getJson(context, auth, `/backend-api/conversation/${id}`);
    const messages = [];
    for (let nodeId = tree.current_node; tree.mapping[nodeId]; nodeId = tree.mapping[nodeId].parent) {
      const node = tree.mapping[nodeId];
      if (node.message) messages.unshift(node.message);          // the root node has no message
    }
    return { ...tree, messages };
  }

  // Is this message shown on the page as the participant's prompt or as the reply's text?
  // Hidden are: system and tool messages, the assistant calling a tool, messages the site marks
  // hidden (custom instructions, the prompt behind a button), pieces of an answer the site merged
  // into one message, thinking (thoughts, "Thought for 5s"), the notes written while thinking
  // (channel "commentary"), memory context, and code a tool runs. `ids`: every message id read.
  function isShown(message, ids) {
    const role = message.author.role;
    const metadata = message.metadata || {};
    if (role !== "user" && role !== "assistant") return false;
    if (message.recipient && message.recipient !== "all") return false;
    if (metadata.is_visually_hidden_from_conversation) return false;
    // NOTE: [pedagogical] the site can store an answer as fragments plus the one message merged from
    // them (is_merged_message, source_message_ids); the page's answer is the merged one and skips
    // fragments. A fragment whose merged message is missing is the only copy of its text: kept.
    if (metadata.is_message_fragment && ids.has(metadata.merged_message_id)) return false;
    if (role === "assistant" && metadata.is_thinking_preamble_message) return false;
    if (role === "assistant" && message.channel && message.channel !== "final") return false;
    return message.content.content_type === "text" || message.content.content_type === "multimodal_text";
  }

  // The words of a message. A "multimodal_text" message mixes strings with pictures and, for voice,
  // transcripts; the page joins its words with a space.
  function partsText(message) {
    const { content_type: contentType, parts } = message.content;
    if (contentType === "text") return parts.join("");
    const words = parts.map((part) => (typeof part === "string" ? part : part.content_type === "audio_transcription" ? part.text : ""));
    return words.filter(Boolean).join(" ");
  }

  // The participant's message as the DOM reader writes it: a tag per attachment ("[image]" per
  // picture, "[file: <name>]" per file), then the text.
  function userText(message) {
    // NOTE: [pedagogical] an uploaded picture is listed twice: in metadata.attachments and as an
    // image_asset_pointer part whose pointer ("sediment://file_...") ends with the attachment's id.
    // The pointer tells a picture even when its attachment entry has no mime_type.
    const attachments = (message.metadata && message.metadata.attachments) || [];
    const pictures = new Set(message.content.parts.filter((part) => part.content_type === "image_asset_pointer").map((part) => part.asset_pointer.split("://")[1]));
    const isPicture = (attachment) => (attachment.mime_type || "").startsWith("image/") || pictures.has(attachment.id);
    const tags = attachments.map((attachment) => (isPicture(attachment) ? "[image]" : `[file: ${attachment.name}]`));
    const listed = new Set(attachments.map((attachment) => attachment.id));
    for (const picture of pictures) if (!listed.has(picture)) tags.push("[image]");
    // NOTE: [edge case callout] the tags follow the order of metadata.attachments; the page is
    // assumed to show attachments in that order (not checked on a live page).
    return [...tags, tidy(partsText(message))].filter(Boolean).join("\n");
  }

  // The reply's Markdown. An interactive ("DIL") reply keeps widget markup in its parts; the site
  // stores its Markdown version next to it, and uses that as the reply's visible text.
  function replyMarkdown(message) {
    const dil = message.metadata && message.metadata.model_dil_v2;
    // NOTE: [edge case callout] a widget reply without that Markdown version is read from its parts:
    // its cards become their words, but program code in them (DIL.useState) stays text
    if (dil && dil.fallbackMarkdownVersion === 1 && typeof dil.fallbackMarkdown === "string") {
      return dil.fallbackMarkdown.replace(/<escape>([\s\S]*?)<\/escape>/g, "$1");     // <escape> wraps a literal character
    }
    return partsText(message);
  }

  // The reply's text: its Markdown with what the page draws as chips, pictures and widgets made into
  // the words it shows.
  function replyText(markdown) {
    return tidy(withoutCitations(withoutComponents(markdown)));
  }

  // NOTE: [pedagogical] since October 2026 (GPT-6; the real sample S1 in spec.md) a reply can hold
  // UI components, JSX-like tags inside its Markdown that the page draws: <Cite refs={[...]}/> a
  // citation chip, <Entity value="Japan Rail Pass" .../> a name, <Link url title/> a link,
  // <AsyncImageGroup .../> web pictures, <MapWidgetV2 .../> a map, <CodeBlock language="python">
  // ...</CodeBlock> a code editor, <WritingBlock>...</WritingBlock> a draft to copy, <text> and
  // <title> small print and headings, and cards of <box>, <row>, <divider/>, ... (the layout
  // elements of OpenAI's ChatKit widgets, says the Liksu exporter). Code is left as it is (a tag
  // there is code), so fenced blocks, `spans` and CodeBlocks are put aside first and put back at the end.
  const CODE = /<CodeBlock\b[^>]*>[\s\S]*?<\/CodeBlock>|^ {0,3}(`{3,}|~{3,})[^\n]*(?:[\s\S]*?\n {0,3}\1[`~]*[ \t]*$|[\s\S]*)|`[^`\n]+`/gm;
  function withoutComponents(markdown) {
    const code = [];
    const prose = markdown.replace(CODE, (block) => `\u0000${code.push(block.startsWith("<CodeBlock") ? fenced(block) : block) - 1}\u0000`);
    return componentsAsText(prose).replace(/\u0000(\d+)\u0000/g, (placeholder, index) => code[index]);
  }

  // <CodeBlock language="python">code</CodeBlock> as a Markdown fence, the form the model wrote it
  // in (the sample's content reference for it keeps "```python ..."), with a fence longer than any
  // run of backticks in the code
  function fenced(block) {
    const [, attributes, code] = block.match(/^<CodeBlock\b([^>]*)>\n?([\s\S]*?)\n?<\/CodeBlock>$/);
    const fence = "`".repeat(Math.max(3, ...(code.match(/`+/g) || []).map((run) => run.length + 1)));
    return `${fence}${attribute(attributes, "language")}\n${code}\n${fence}`;
  }

  // the value of name="..." (or name='...') among a tag's attributes, or ""
  function attribute(attributes, name) {
    const match = (attributes || "").match(new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`));
    return match ? match[1] ?? match[2] : "";
  }

  function componentsAsText(prose) {
    const words = prose
      // a citation chip goes, with the space before it (the DOM reader drops chips); so do web
      // pictures and maps (read() keeps no pictures)
      .replace(/[ \t]*<(?:Code)?Cite\b[^<>]*>|<\/(?:Code)?Cite>/g, "")
      .replace(/[ \t]*<(?:AsyncImage(?:Group)?|MapWidget(?:V2)?)\b[^<>]*\/>/g, "")
      // an entity shows its name, a link its title; their own text, if they wrap one, stays
      .replace(/<(Entity|Link)\b([^<>]*?)(\/?)>|<\/(?:Entity|Link)>/g, (tag, name, attributes, selfClosing) => {
        if (!selfClosing) return "";
        return name === "Entity" ? attribute(attributes, "value") || attribute(attributes, "name") : attribute(attributes, "title") || attribute(attributes, "url");
      })
      // a draft shows its words; in its older form it sits between ":::writing{...}" and ":::"
      .replace(/<\/?WritingBlock\b[^<>]*>/g, "")
      .replace(/^[ \t]*:::writing\b.*$\n?|^[ \t]*:::[ \t]*$\n?/gm, "");
    return cardsAsLines(words);
  }

  // NOTE: [pedagogical] a card (a <box> of <row>s of <text>, <title>, <divider/>, ...) is drawn as
  // blocks, one per element, and innerText puts each block's words on a line of its own: so do we,
  // for a line that starts with one of these tags or sits inside a container (<box>, <row>, ...).
  // Elsewhere a <text> or <title> tag just goes ("It costs <text>about</text> $5" -> "It costs about $5").
  // NOTE: [edge case callout] the words "<text>" or "<title>" written outside code would go too; a
  // card that is never closed makes the rest of the reply card lines (blank lines dropped); and the
  // data a card names ({turn7business0.address}, the Liksu exporter) is not looked up
  const CONTAINERS = "box|row|col|grid|grid-item|card|list|list-item";
  const LAYOUT_LINE = new RegExp(`^[ \\t]*<\\/?(?:${CONTAINERS}|text|title|caption|badge|divider|icon|spacer)(?=[\\s/>])`);
  const OPENED = new RegExp(`<(?:${CONTAINERS})(?:\\s[^<>]*[^/<>])?>`, "g");       // not <box/>
  const CLOSED = new RegExp(`<\\/(?:${CONTAINERS})>`, "g");
  const INLINE_LAYOUT = /<\/?(?:text|title|caption|badge)(?=[\s/>])[^<>]*>|<(?:divider|icon|spacer)(?=[\s/>])[^<>]*>/g;
  const TAG = /<\/?[A-Za-z][\w.-]*(?:\s[^<>]*)?\/?>/g;
  const count = (text, pattern) => (text.match(pattern) || []).length;
  function cardsAsLines(text) {
    let depth = 0;                                 // how many containers are open
    const lines = text.split("\n").flatMap((line) => {
      const inCard = depth > 0 || LAYOUT_LINE.test(line);
      depth = Math.max(0, depth + count(line, OPENED) - count(line, CLOSED));
      if (!inCard) return [line.replace(INLINE_LAYOUT, "")];
      return line.split(TAG).map((piece) => piece.trimStart()).filter((piece) => piece.trim() !== "");
    });
    return lines.join("\n");
  }

  // NOTE: [pedagogical] a reply of September 2026 (the real sample S2) marks citations and other
  // references inline, between the private use characters U+E200 and U+E201, with U+E202 between
  // the fields: "\uE200cite\uE202turn0search1\uE201". The page draws a chip for a citation (the DOM
  // reader drops chips), and plain text for an entity (its name) or a link (its label). Older
  // replies (2024) wrote citations as "【11†source】".
  function withoutCitations(text) {
    return text
      .replace(/( ?)\uE200([^\uE201]*)\uE201/g, (marker, space, inside) => {
        const [type, ...fields] = inside.split("\uE202");
        let shown = "";
        if (type === "entity") shown = entityName(fields[0]);
        if (type === "url") shown = fields.find((field) => !/^https?:\/\//.test(field)) || fields[0] || "";
        // a chip that goes away takes the space before it along, as on the page
        return shown ? space + shown : "";
      })
      .replace(/ ?【[^】]*†[^】]*】/g, "");
  }

  // an entity marker holds a JSON array: ["car_part", "timing belt", "engine component"]
  function entityName(json) {
    try {
      return JSON.parse(json)[1] || "";
    } catch {
      return "";                                   // NOTE: [edge case callout] not the known shape
    }
  }

  // the same clean-up the DOM reader (content/capture.js) applies to the text it reads
  function tidy(text) {
    return text.replace(/[\u200B\u2060]/g, "").replace(/ +\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  const reader = {
    host: "chatgpt.com",

    // The headers every call sends, who is signed in and whether it is a personal account; null
    // when signed out. The page reads the same values: the access token from GET /api/auth/session;
    // the device id and the workspace from cookies; the language, the build and its number from
    // <html lang data-build data-seq>.
    async auth(context) {
      const session = await getJson(context, null, "/api/auth/session");
      if (!session.accessToken) return null;                        // signed out: the session is {}
      const html = context.document.documentElement;
      const account = cookie(context.document, "_account");
      const workspace = account && account !== "personal" ? account : null;
      const headers = { Authorization: `Bearer ${session.accessToken}` };
      const optional = {
        "OAI-Device-Id": cookie(context.document, "oai-did"),
        "OAI-Language": html.getAttribute("lang"),
        "OAI-Client-Version": html.getAttribute("data-build"),
        "OAI-Client-Build-Number": html.getAttribute("data-seq"),
        // NOTE: [pedagogical] a Team or Enterprise workspace keeps its own conversations; the page
        // names the workspace in this header, and sends none for a personal account
        "ChatGPT-Account-ID": workspace,
      };
      for (const [name, value] of Object.entries(optional)) if (value) headers[name] = value;
      // NOTE: [design thought] the study reads personal accounts only (content/history.js reports
      // `personal`, and background.js reads nothing of a workspace). The session names the person
      // (user.id) and the account in use (account.structure "personal" or "workspace"); the cookie
      // names the workspace the page sends its requests for. Either one naming a workspace is enough.
      const structure = (session.account && session.account.structure) || "personal";
      return { headers, accountId: (session.user && session.user.id) || null, personal: structure === "personal" && !workspace };
    },

    // One page of the list, most recently updated first; the cursor is the offset of the next page.
    // NOTE: [design thought] like the sidebar, the list leaves out archived and pinned conversations.
    // The caller takes a page's oldest time as how far back it has read (background.js mergeList),
    // so a pinned conversation goes on a page whose times reach it: every page adds the pinned ones
    // at least as new as its oldest conversation, and the last page all of them. A pinned one can
    // thus come on several pages (the caller keeps one of each); /pins is asked once per page.
    async list(context, auth, cursor) {
      const offset = cursor ?? 0;
      const page = await getJson(context, auth, `/backend-api/conversations?offset=${offset}&limit=${LIST_PAGE_SIZE}&order=updated&is_archived=false&is_starred=false`);
      const listed = page.items.map(listItem);
      // NOTE: [edge case callout] the list is by offset: a conversation updated while we page
      // moves to the front, and the ones after it shift by one (one may be seen twice or missed).
      const next = offset + page.items.length;
      const last = !(page.items.length > 0 && next < page.total);
      const oldest = Math.min(...listed.map((item) => item.updatedAt));
      const ids = new Set(listed.map((item) => item.id));
      const pinned = (await pinnedConversations(context, auth))
        .filter((item) => !ids.has(item.id) && Number.isFinite(item.updatedAt) && (last || item.updatedAt >= oldest));
      return { items: [...listed, ...pinned].sort((a, b) => b.updatedAt - a.updatedAt), next: last ? null : next };
    },

    // One conversation, its current branch, in page order; null if it does not exist.
    async read(context, auth, id) {
      let conversation;
      try {
        conversation = await readPages(context, auth, id);
      } catch (pagedError) {
        // NOTE: [design thought] the page itself reads the older endpoint when the paged one fails.
        // We do the same, except when the answer is to slow down (429), to sign in again (401), that
        // the site blocks us (403, usually a challenge page) or that the chat is locked (423), and
        // when the request did not reach the site or its answer was not JSON: the older endpoint
        // would answer the same.
        const treeMayHelp = pagedError.status ? ![401, 403, 423, 429].includes(pagedError.status) : pagedError.unexpected === true;
        if (!treeMayHelp) throw pagedError;
        try {
          conversation = await readTree(context, auth, id);
        } catch (treeError) {
          // NOTE: [edge case callout] the conversation is gone only when both endpoints say so: the
          // older one alone may not serve a conversation that exists (spec.md, W1)
          if (treeError.status !== 404) throw treeError;
          if (pagedError.status === 404) return null;
          throw pagedError;
        }
      }

      const ids = new Set(conversation.messages.map((message) => message.id));
      const turns = [];                            // {role, text, at}; a reply's text is its Markdown until the end
      let previous = null;                         // the message just before, if it is shown
      for (const message of conversation.messages) {
        const role = message.author.role;
        const shown = isShown(message, ids);
        const text = !shown ? "" : role === "user" ? userText(message) : replyMarkdown(message);
        const empty = role === "user" ? text === "" : replyText(text) === "";      // e.g. the empty reply after a generated picture
        if (!shown || empty) {
          previous = null;
          continue;
        }
        const last = turns[turns.length - 1];
        if (role === "assistant" && last && last.role === "assistant") {
          // a reply written in several messages is one message, as on the page; its time is that of
          // its first part.
          // NOTE: [pedagogical] a message that comes right after the previous one (nothing between
          // them, the same channel) goes on with its text, even mid-word (a reply continued, a
          // writing block split in two): it is appended as it is. Parts with a tool call or notes
          // between them are separate blocks on the page: a blank line, as the DOM reader writes.
          const continues = previous !== null && previous.channel === message.channel;
          last.text += (continues ? "" : "\n\n") + text;
        } else {
          turns.push({ role, text, at: toMs(message.create_time) });
        }
        previous = message;
      }
      return {
        id,
        title: conversation.title,
        createdAt: toMs(conversation.create_time),
        updatedAt: toMs(conversation.update_time),
        // a project's or a custom GPT's id, when the answer names it (the tree does): for pathOf
        gizmoId: conversation.gizmo_id ?? null,
        messages: turns.map((turn) => ({ role: turn.role, content: turn.role === "user" ? turn.text : replyText(turn.text), at: turn.at })),
      };
    },

    // The page of a conversation, from a list item or read()'s result. A project's or a custom GPT's
    // chat lives under /g/<its id>/; lib/sites.js reads the chat key id from /c/<id> in either form.
    pathOf(id, item) {
      return item && item.gizmoId ? `/g/${item.gizmoId}/c/${id}` : `/c/${id}`;
    },
  };

  root.HISTORY_READERS = root.HISTORY_READERS || {};
  root.HISTORY_READERS[reader.host] = reader;
  if (typeof module !== "undefined" && module.exports) module.exports = reader;
})(typeof self !== "undefined" ? self : globalThis);
