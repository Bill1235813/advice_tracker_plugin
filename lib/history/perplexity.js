// History reader for www.perplexity.ai: reads the participant's thread list and single threads
// through the site's own JSON API, from the content script on a www.perplexity.ai page.
// Every request carries the page's cookies and only reads: two GETs (the session, one thread)
// and the list's POST, which only reads (it sends its paging as a JSON body). Nothing that marks
// a thread viewed (/rest/thread/mark_viewed) or changes it is ever sent.
// The evidence for every endpoint and field is in spec.md (same folder); "bundle" below means the
// site's production JavaScript of 2026-10-15, saved in scratch/refs/perplexity/pplx_live/assets.
(function (root) {
  // NOTE: [design thought] the site sends ?version=2.18&source=default and X-App-ApiVersion: 2.18
  // with every API call (pa and ma in platform-core__v2-CSqVohyg.js); asking the same way keeps
  // our requests looking like the page's own
  const API_VERSION = "2.18";
  const PAGE_SIZE = 20;            // the list's pages ({limit: 20} in useThreadsQuery__v2-Zs3xIVb9.js)
  const ENTRIES_PER_PAGE = 100;    // the thread page's later pages (Xn in spa-metadata__v2-B56GxLu4.js)
  const MAX_ENTRIES = 1010;        // where the site stops reading a thread (Zn in spa-metadata)
  // the kinds of answer blocks the thread page says it can show (en in spa-metadata); the server
  // shapes its answer by this list, so we send the page's list to get the page's answer
  const BLOCK_USE_CASES = ("answer_modes media_items inline_entity_cards place_widgets finance_widgets news_widgets " +
    "shopping_widgets search_result_widgets inline_images inline_assets placeholder_cards diff_blocks entity_group_v2 " +
    "refinement_filters canvas_mode maps_preview answer_tabs preserve_latex in_context_suggestions pending_followups " +
    "inline_claims unified_assets workflow_steps workflow_widgets navigation_results background_agents").split(" ");
  // threads that are not chats at /search/<id>: Computer tasks (/computer/tasks/<id>) and Pages
  // (/page/<id>), as the site routes them (rg in spa-shell__v2-CphZkXoN.js)
  const NOT_CHATS = new Set(["asi", "article"]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // file types the page draws as a picture or a video, by the end of the file's address
  // (yr in platform-core; Do in ask-input__v2-BkhDTF42.js)
  const IMAGE_TYPES = new Set("png jpg jpeg jpe jp2 gif bmp tiff tif svg webp ico avif heic heif".split(" "));
  const VIDEO_TYPES = new Set("mp4 webm mov avi mkv".split(" "));
  // the display items that describe a digest article, which the page hides with the upload they
  // name (Ff, If, Lf in ThreadEntries__v2-DqUU4Q61.js)
  const DIGEST_TYPE = "pplx.digest_article.type", DIGEST_UPLOAD = "pplx.digest_article.attachment_identity";

  // A time from the API in ms since 1970, or null. Times come in two forms:
  // "2026-10-14T09:12:03.511236+00:00" and, without a time zone, "2026-10-14T09:29:53.830105".
  // NOTE: [edge case callout] the site adds "Z" to a time written without a zone (oa in
  // platform-core); without that, Date.parse would read it as the computer's local time
  function toMs(text) {
    if (!text) return null;
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
    return Date.parse(hasZone ? text : `${text}Z`);
  }

  // How long a 429 answer asks us to wait: Retry-After is either seconds or an HTTP date
  // (the site reads both: Zo in platform-core)
  function retryAfterMs(header) {
    if (!header) return null;
    const seconds = Number(header);
    return Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(header) - Date.now());
  }

  // One API call, as JSON: a GET, or a POST when there is a body. On an HTTP error: an Error with
  // .status (and .retryAfterMs when the site says how long to wait).
  async function request(context, auth, path, body) {
    const headers = { "X-App-ApiClient": "default", "X-App-ApiVersion": API_VERSION };
    // NOTE: [pedagogical] the page names the account it reads in this header on every call (ae in
    // platform-core, added by ls): the signed-in user's own id, or the id of another account the
    // tab was switched to; without it the server answers for the first account signed in
    if (auth?.accountId) headers["X-Pplx-Account"] = auth.accountId;
    if (body) headers["Content-Type"] = "application/json";
    const response = await context.fetch(`${context.location.origin}${path}`, {
      method: body ? "POST" : "GET",
      credentials: "include",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      // NOTE: [edge case callout] a 403 with the header cf-mitigated: challenge is Cloudflare's
      // bot check, not a missing permission; it passes once the page itself is reloaded
      const error = new Error(`www.perplexity.ai ${path.split("?")[0]}: HTTP ${response.status}`);
      error.status = response.status;
      const wait = retryAfterMs(response.headers.get("retry-after"));
      if (wait !== null) error.retryAfterMs = wait;
      throw error;
    }
    return response.json();
  }

  // The id our chat key uses for a thread slug: the id in the page's address. Since 2026 the site
  // rewrites an old address /search/<title words>-<22 letters> to /search/<uuid> as soon as the
  // page starts (Na and Ia in spa-metadata, called by bootstrap__v2-weEctc50.js), and links to
  // threads the same way; new threads have a bare uuid as their slug already.
  // NOTE: [pedagogical] the 22 letters are the thread's 16-byte uuid in base64url, with "." for "-"
  // (so that "-" can separate the title words): "SzvqWM32Q5isAeHIAqdrpg" is 4b3bea58-cdf6-...
  function chatKeyOf(slug) {
    if (UUID.test(slug) || !slug.includes("-")) return slug;
    const letters = slug.slice(slug.lastIndexOf("-") + 1).replace(/\./g, "-");
    try {
      const bytes = atob(letters.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - letters.length % 4) % 4));
      if (bytes.length !== 16) return slug;
      const hex = [...bytes].map((byte) => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } catch {
      return slug;            // not base64: the site keeps such an address as it is (Dn in spa-metadata)
    }
  }

  // An uploaded file as the page shows it: "[image]" for a picture, "[file: <name>]" otherwise.
  // An upload is the file's address ("https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/
  // <user>/<id>/IMG_2041.jpeg?AWSAccessKeyId=..."); the page reads its kind from the end of the
  // address and its name from the last part of the path, or calls it "File" when that cannot be
  // read (tr in platform-core).
  // NOTE: [edge case callout] the page draws a video as a thumbnail too, but the extension's page
  // reader tags only pictures and file chips, so a video gets no tag here either
  function attachmentTag(url) {
    const type = url.split("?")[0].split("#")[0].split(".").pop().toLowerCase();
    if (IMAGE_TYPES.has(type)) return "[image]";
    if (VIDEO_TYPES.has(type)) return null;
    let name;
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop());
    } catch {
      name = "File";          // not an address, or a name that is not valid percent-encoding ("100%.txt")
    }
    return `[file: ${name}]`;
  }

  // The text the page shows for a piece of markdown, read the way the extension's page reader
  // reads it (content/capture.js shownText): a paragraph has an empty line before and after it, a
  // heading, table row or code block a line break; inside a paragraph a single line break is a
  // space (the site's parser makes it a "SoftBreak", drawn as " ", copyUtils__v2-BHP_rgOX.js).
  // NOTE: [design thought] a list item counts as a paragraph: the site draws its text inside a <p>
  // (<li><p>...</p></li> in a real saved page), and the page reader puts an empty line around a <p>.
  // The participant's question goes through the same markdown renderer as the answers (Pr in
  // Workflow__v2-klrHItl_.js), so "line one\nline two" shows as "line one line two". This is a
  // deliberately small part of markdown: math, nested structure, HTML and setext headings are left
  // as written. The extension compares the API's text with the page's by letters and digits only
  // (Episodes.looseHash), so line breaks and markdown marks do not decide a match.
  function shownText(markdown, isReply) {
    const blocks = [];          // {text, paragraph}
    let open = null;            // the paragraph or list item that a next line continues
    let code = null;            // the lines of the code block being read
    let previous = "";
    for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) {                  // a code fence opens or closes a code block
        if (code) blocks.push({ text: code.join("\n"), paragraph: false });
        code = code ? null : [];
        open = null;
      } else if (code) {
        code.push(line);                                  // code is shown as written
      } else if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/.test(line)) {
        open = null;                                      // an empty line, a rule, a table's |---|---|
      } else if (line.trim().startsWith("|")) {           // a table row: its cells, tab-separated
        const cells = line.trim().replace(/^\||\|$/g, "").split("|");
        blocks.push({ text: cells.map((cell) => inline(cell.trim(), isReply)).join("\t"), paragraph: false });
        open = null;
      } else {
        // a heading, list item or quote starts with its marker, which is not shown
        const marker = line.match(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/)?.[1] ?? "";
        let words = line.slice(line.indexOf(marker) + marker.length).trim();
        if (marker.startsWith("#")) words = words.replace(/\s+#+$/, "");      // "## Title ##"
        const text = inline(words, isReply);
        if (open && (!marker || (marker.startsWith(">") && open.quote))) {
          // NOTE: [pedagogical] two spaces at the end of a line make a real line break ("hard break")
          open.text += (/ {2,}$/.test(previous) ? "\n" : " ") + text;
        } else {
          open = { text, paragraph: !marker.startsWith("#"), quote: marker.startsWith(">") };
          blocks.push(open);
          if (marker.startsWith("#")) open = null;          // a heading is one line
        }
      }
      previous = line;
    }
    if (code) blocks.push({ text: code.join("\n"), paragraph: false });     // a fence left open
    return blocks.map((block, i) => (i === 0 ? "" : block.paragraph || blocks[i - 1].paragraph ? "\n\n" : "\n") + block.text)
      .join("").replace(/[​⁠]/g, "").replace(/ +\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // One line of markdown without its inline syntax: **bold**, *italics*, ~~struck~~, [links](...)
  // show their words; `code` shows as written. A picture in a question shows its description
  // (ImageComponent: ({alt}) => alt in Workflow's Pr); in a reply it is counted as "[image]" in
  // replyText. In a reply, citation markers ("[1]", "[2][3]") are drawn as source chips, which are
  // not answer text, so they go.
  function inline(text, isReply) {
    // NOTE: [pedagogical] splitting on a capture group keeps the code spans at the odd places
    return text.split(/(`[^`]*`)/).map((part, i) => {
      if (i % 2) return part.slice(1, -1);
      if (isReply) part = part.replace(/[ \t]*\[(?:0|[1-9]\d*)(?:,\s*\{ts:[^\]]*\})?\]/g, "");
      return part.replace(/!\[([^\]]*)\]\([^)]*\)/g, isReply ? "" : "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[\s(])([*_])(?=\S)(.+?)(?<=\S)\2(?=$|[\s).,!?;:])/g, "$1$3")
        .replace(/~~(.+?)~~/g, "$1")
        .replace(/\\([!-/:-@[-`{-~])/g, "$1")
        .replace(/[ \t]+/g, " ");
    }).join("");
  }

  // The answer's markdown, found where the thread page finds it (c in entryAnswer__v2-Q0MwC1Mp.js,
  // Mf and Pf in ThreadEntries):
  // 1. an entry from before blocks existed (2024): `text`, a JSON string of steps whose last
  //    (FINAL) step holds the answer as another JSON string;
  // 2. the markdown blocks the entry names as its answer (structured_answer_block_usages), those
  //    that have text;
  // 3. else the streamed chunks of the "ask_text" markdown blocks (parseAskTextField in spa-metadata
  //    reads only their chunks, not their `answer`);
  // 4. else (since Sept 2026) the "answer" texts of the entry's workflow (its search steps, sources
  //    and "thought" texts are the collapsed "Researched..." part above the answer, not the answer).
  function answerMarkdown(entry) {
    if (entry.blocks === undefined) return legacyAnswer(entry.text);
    const named = (entry.structured_answer_block_usages || [])
      .flatMap((usage) => entry.blocks.filter((block) => block.intended_usage === usage && block.markdown_block))
      .map((block) => textOf(block.markdown_block.chunks, block.markdown_block.answer)).filter(Boolean);
    if (named.length) return named.join("\n\n");
    const askText = entry.blocks.filter((block) => block.intended_usage === "ask_text" && block.markdown_block)
      .flatMap((block) => block.markdown_block.chunks || []).join("");
    if (askText.trim()) return askText;
    return entry.blocks.flatMap((block) => workflowItems(block.workflow_block))
      .filter((item) => item.payload?.text_payload && variantOf(item) === "answer")
      .map((item) => textOf(item.payload.text_payload.chunks, item.payload.text_payload.text))
      .filter(Boolean).join("\n\n");
  }

  // A text the API may send whole or in streamed chunks: the chunks when any has text (a and s in
  // entryAnswer and utils__v2-DGzEvM4K.js), else the whole text if it has any, else ""
  function textOf(chunks, whole) {
    if (chunks?.some((chunk) => chunk.trim())) return chunks.join("");
    return whole?.trim() ? whole : "";
  }

  // All items of a workflow, with the items of workflows nested inside it (_O in spa-shell)
  function workflowItems(workflow) {
    return (workflow?.steps || []).flatMap((step) => (step.items || [])
      .flatMap((item) => [item, ...workflowItems(item.payload?.workflow_payload)]));
  }

  // What a workflow text is: "answer" ("text_final" is the same), "thought", "agent_update" or
  // "user_message"; read on the item, and on its text when the item's own is none of these (yO and
  // bO in spa-shell)
  function variantOf(item) {
    const known = (variant) => (variant === "text_final" ? "answer"
      : ["answer", "thought", "agent_update", "user_message"].includes(variant) ? variant : undefined);
    return known(item.variant) ?? known(item.payload?.text_payload?.variant);
  }

  // The answer of an entry in the old format (legacyParseBackendOutputStr in spa-metadata)
  function legacyAnswer(text) {
    try {
      const parsed = JSON.parse(text);
      const final = Array.isArray(parsed) ? parsed[parsed.length - 1] : null;
      const answer = !final ? parsed : final.step_type === "FINAL" ? JSON.parse(final.content.answer) : {};
      return textOf(answer.chunks, answer.answer);
    } catch {
      return "";              // not JSON: the page shows no answer either
    }
  }

  // A question asked about passages the participant selected starts with them: "<q>passage</q>
  // question", or for several, "<q>\npassage\n</q>" blocks. The page draws the passages as a quote
  // line outside the question's text (Nr in Workflow), and the page reader reads only that text.
  // Like the site (Oc in spa-metadata): every block of the second form goes, else only the first
  // <q>...</q>.
  function splitQuote(query) {
    const blocks = [...query.matchAll(/<q>\n([\s\S]*?)\n<\/q>/g)].map((match) => match[1]);
    if (blocks.length) {
      // several passages are shown numbered, two spaces apart (Ac in spa-metadata)
      const quote = blocks.length === 1 ? blocks[0] : blocks.map((text, i) => `${i + 1}. ${text}`).join("  ");
      return { quote, question: query.replace(/<q>\n[\s\S]*?\n<\/q>/g, "").trim() };
    }
    const first = query.match(/<q>([\s\S]*?)<\/q>/);
    return first ? { quote: first[1], question: query.replace(first[0], "").trim() } : { quote: "", question: query };
  }

  // What the page shows of a question's display metadata (Bf in ThreadEntries; C and A in
  // ScheduledQueryDisplay__v2-BHKhiYQe.js): one line per text item, or a key line and a value line
  // per pair. A question sent with a slash command carries such items (the command's label, then
  // its argument: qv in ask-input), and the page draws them instead of the question's text. Items
  // that describe a digest article are not shown, nor is the upload they name.
  function displayItems(entry) {
    const lines = [], hiddenUploads = new Set();
    for (const item of entry.query_display_metadata?.items || []) {
      const pairs = item.key_value_list_display?.key_values || [];
      if (pairs.some(({ key, value }) => key === DIGEST_TYPE && value === "digest_article_v1")) {
        const upload = pairs.find(({ key }) => key === DIGEST_UPLOAD)?.value;
        if (upload) hiddenUploads.add(upload.split(/[?#]/)[0]);
        continue;
      }
      const shownPairs = pairs.filter(({ key, value }) => key && value);
      if (shownPairs.length) lines.push(...shownPairs.flatMap(({ key, value }) => [key, value]));
      else if (item.text_display?.text) lines.push(item.text_display.text);
    }
    return { lines, hiddenUploads };
  }

  // The participant's message as the page shows it: one tag per upload first (the page draws the
  // uploads above the bubble), then the question.
  // NOTE: [design thought] when the page draws no markdown for the question (it has display items,
  // or it is only a quoted passage), the bubble has no markdown root (Tr in adapter__v2-BjDl_e1R.js
  // draws nothing for an empty text), so the page reader reads the whole bubble: the quote line,
  // then the items, one per line
  function questionText(entry) {
    // the page draws no bubble for an entry with neither a question nor uploads (xm in ThreadEntries)
    if (!entry.query_str?.trim() && !entry.attachments?.length) return "";
    const { lines, hiddenUploads } = displayItems(entry);
    const uploads = (entry.attachments || []).filter((url) => !hiddenUploads.has(url.split(/[?#]/)[0]));
    const tags = uploads.map(attachmentTag).filter(Boolean);
    const { quote, question } = splitQuote(entry.query_str || "");
    const markdownText = shownText(question, false);
    const text = !lines.length && markdownText ? markdownText : [quote.replace(/\s+/g, " ").trim(), ...lines].filter(Boolean).join("\n");
    return [...tags, text].filter(Boolean).join("\n");
  }

  // The reply as the page shows it: pictures in it as tags first (as the page reader writes them),
  // then its text, without a reasoning model's "<think>...</think>" at the top
  function replyText(entry) {
    const markdown = answerMarkdown(entry).replace(/^\s*<think>[\s\S]*?(?:<\/think>|$)\s*/, "");
    const pictures = (markdown.match(/!\[[^\]]*\]\([^)]*\)/g) || []).map(() => "[image]");
    return [...pictures, shownText(markdown, true)].filter(Boolean).join("\n");
  }

  // The thread API's address for one page of entries, oldest first, as the page asks for it
  // (Jn and ur in spa-metadata)
  function threadPath(id, cursor) {
    const query = new URLSearchParams({
      with_parent_info: "true", with_schematized_response: "true", version: API_VERSION, source: "default",
      limit: String(ENTRIES_PER_PAGE), offset: "0", from_first: "true", with_first_entry: "false", with_latest_entry: "false",
    });
    for (const useCase of BLOCK_USE_CASES) query.append("supported_block_use_cases", useCase);
    if (cursor) query.set("cursor", cursor);
    return `/rest/thread/${encodeURIComponent(id)}?${query}`;
  }

  const reader = {
    host: "www.perplexity.ai",

    // {accountId, personal} for the account this tab reads, or null when signed out
    async auth(context) {
      // NOTE: [pedagogical] the page writes the signed-in user's id into this tab's sessionStorage
      // as soon as it starts (w in resolveSpaBootstrapState__v2-aGYJXXQF.js), and the account
      // switcher (or ?pplx_account=<id>) another account's id; the content script shares it
      const account = context.document.defaultView.sessionStorage.getItem("pplx-active-account");
      const session = await request(context, { accountId: account }, `/api/auth/session?version=${API_VERSION}&source=default`);
      // NOTE: [pedagogical] signed out, the session is an empty object {} (Hl in platform-core)
      if (!session.user) return null;
      // an Enterprise member's session names its organization, others say "none" (zi in
      // command-palette__v2-DW8dQjqJ.js); such an account is a work account, never read
      const organization = session.user.org_uuid;
      return { accountId: account ?? session.user.id, personal: !organization || organization === "none" };
    },

    // One page of the thread list, most recently updated first. The cursor is the offset of the
    // page's first thread (null for the first page).
    async list(context, auth, cursor) {
      const offset = cursor ?? 0;
      // NOTE: [pedagogical] this POST only reads: the list takes its paging as a JSON body
      const page = await request(context, auth, `/rest/thread/list_ask_threads?version=${API_VERSION}&source=default`,
        { limit: PAGE_SIZE, ascending: false, offset });
      // NOTE: [edge case callout] an item without a slug has no page to open; it is left out
      const items = page.filter((thread) => thread.slug && !NOT_CHATS.has(String(thread.mode).toLowerCase())).map((thread) => ({
        id: chatKeyOf(thread.slug),
        title: thread.title,
        // NOTE: [edge case callout] the list has no creation time; read() gives it
        createdAt: null,
        // NOTE: [edge case callout] by its name the time of the thread's last question; read()'s
        // updatedAt is another field (thread_metadata.updated_at), so the two need not be equal
        updatedAt: toMs(thread.last_query_datetime),
      }));
      // NOTE: [pedagogical] every thread of a page says whether another page follows; the site
      // reads the first one's has_next_page (f in useThreadsQuery__v2-Zs3xIVb9.js)
      // NOTE: [edge case callout] paging is by offset: a thread updated while we page moves to the
      // top, and the threads below it shift down one place, so a thread can come twice
      return { items, next: page[0]?.has_next_page ? offset + PAGE_SIZE : null };
    },

    // One thread, its entries oldest first, or null if it does not exist (or has no entries).
    // Throws when the thread could not be read whole.
    async read(context, auth, id) {
      const entries = [];
      const entryIds = new Set();
      const cursors = new Set();
      let thread = null, cursor = null, readCount = 0;
      do {
        let page;
        try {
          page = await request(context, auth, threadPath(id, cursor));
        } catch (error) {
          if (error.status === 404) return null;
          throw error;
        }
        // NOTE: [design thought] on a page that is not "success" the site only stops loading
        // (ur in spa-metadata). Here a thread cut short would look as if its later turns had been
        // edited away, and an empty one as if deleted, so the read fails and is tried again later.
        if (page.status !== "success") throw new Error(`www.perplexity.ai /rest/thread: status ${page.status}`);
        const pageEntries = page.entries ?? [], helperEntries = page.background_entries ?? [];
        // the end, as the site sees it: a page with neither entries nor helper entries (Bn)
        if (!pageEntries.length && !helperEntries.length) break;
        thread ??= page.thread_metadata;
        for (const entry of pageEntries) {
          // NOTE: [edge case callout] a page can start with the previous page's last entry again
          // (an exporter built from live answers says so); the site merges pages by backend_uuid (Kn)
          const entryId = entry.backend_uuid ?? entry.uuid;
          if (entryIds.has(entryId)) continue;
          if (entryId) entryIds.add(entryId);
          entries.push(entry);
        }
        readCount += pageEntries.length + helperEntries.length;
        // NOTE: [edge case callout] the site stops when a cursor comes back a second time (ur)
        const next = page.next_cursor;
        cursor = next && !cursors.has(next) && readCount < MAX_ENTRIES ? next : null;
        cursors.add(cursor);
      } while (cursor);
      if (!entries.length) return null;

      const messages = [];
      // NOTE: [design thought] Perplexity keeps no edit branches: editing a question runs it again
      // in place. Its one kind of branch is a side-by-side answer from two models to one question:
      // two entries, both drawn in the thread (only the answer-mode tabs leave out the one not
      // picked, o in ThreadAnswerModesProviderShared__v2-Dmffow7e.js), so both are kept.
      // background_entries (helper agents) and queued follow-ups (pending_followups blocks) are not
      // turns of the chat.
      for (const entry of entries) {
        const question = questionText(entry);
        // the time the page shows beside the question (Mm in ThreadEntries)
        if (question) messages.push({ role: "user", content: question, at: toMs(entry.entry_created_datetime ?? entry.entry_updated_datetime) });
        const reply = replyText(entry);
        if (reply) messages.push({ role: "assistant", content: reply, at: toMs(entry.entry_updated_datetime) });
      }
      const first = entries[0], last = entries[entries.length - 1];
      return {
        id,
        title: thread?.title ?? first.thread_title ?? first.query_str,
        createdAt: toMs(thread?.created_at ?? first.entry_created_datetime),
        updatedAt: toMs(thread?.updated_at ?? last.entry_updated_datetime),
        messages,
      };
    },

    // The page of a thread: the site links every thread as /search/<id> (spa-shell rg; a thread in a
    // project opens there too)
    pathOf(id) {
      return `/search/${id}`;
    },
  };

  root.HISTORY_READERS = root.HISTORY_READERS || {};
  root.HISTORY_READERS[reader.host] = reader;
  if (typeof module !== "undefined" && module.exports) module.exports = reader;
})(typeof self !== "undefined" ? self : globalThis);
