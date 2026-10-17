// History reader for claude.ai: reads the participant's conversation list and single conversations
// through the site's own read-only JSON API, from the content script on a claude.ai page.
// Every request is a same-origin GET that carries the page's cookies; nothing is ever written.
// The evidence for every endpoint and field is in spec.md (same folder).
(function (root) {
  // NOTE: [design thought] the sidebar asks for 30 conversations per page
  // ({limit: 30, archived: false} in the site's bundle of 2026-10-14); we ask for the same number,
  // so our requests look like the page's own (only our offsets differ: see PAGE_OVERLAP)
  const PAGE_SIZE = 30;
  // each page starts this many conversations before the previous one ended (see list)
  const PAGE_OVERLAP = 5;
  // conversations made in the chat itself; others (Slack, the browser extension, Claude Code and
  // Cowork sessions) are left out, as the site does when it puts a chat into its own recents list
  // NOTE: [edge case callout] whether the server lists such chats at all, and whether they have a
  // page at /chat/<id>, is not known (spec §2)
  const CHAT_PLATFORMS = new Set(["CLAUDE_AI", "ORBIT_THREAD", "COACH", "VOICE"]);
  // the parent of a conversation's first message (AF in the site's bundle)
  const ROOT = "00000000-0000-4000-8000-000000000000";
  // NOTE: [design thought] the page asks for the freshest copy ("strong") unless a remote flag says
  // otherwise; we do the same, because a stale copy of a chat just continued in the phone app would
  // hide its newest turns
  const CONSISTENCY = "strong";

  // A time from the API ("2026-09-29T19:27:22.511868Z") in ms since 1970, or null.
  // NOTE: [edge case callout] the site adds "Z" to a time written without a time zone before
  // parsing it (x0 in its bundle); without that, Date.parse would read it as the computer's
  // local time and shift it by hours
  function toMs(text) {
    if (!text) return null;
    const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text);
    return Date.parse(hasZone ? text : `${text}Z`);
  }

  // How long a 429 answer asks us to wait: Retry-After is either seconds or an HTTP date.
  // A header that is neither counts as no header (null), so the caller's own back-off applies.
  function retryAfterMs(header) {
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(header);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  }

  // GET one API path as JSON. On an HTTP error: an Error with .status, the API's own .errorType
  // and .errorCode when its body says (null otherwise), and .retryAfterMs when the answer gives one.
  async function getJson(context, path) {
    // NOTE: [edge case callout] fetch is called on its own, not as context.fetch(...): a browser's
    // fetch called as a method of another object (context) throws "Illegal invocation", so a
    // caller may pass window.fetch as it is
    const fetch = context.fetch;
    const response = await fetch(`${context.location.origin}${path}`, {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      const error = new Error(`claude.ai ${path.split("?")[0]}: HTTP ${response.status}`);
      // the API's error body: {"type": "error", "error": {"type": "not_found_error", "message": ...,
      // "details": {"error_code": "chat_conversation_not_found"}}}; a page blocked at the edge is HTML
      const body = await response.json().catch(() => null);
      error.errorType = body?.error?.type ?? null;
      error.errorCode = body?.error?.details?.error_code ?? null;
      // NOTE: [design thought] the site counts a session as signed out on a 401, and on any answer
      // whose code is account_session_invalid, which also comes as a 403 (AQ and L7 in its bundle);
      // such an answer is reported as 401, the status callers read as "signed out"
      error.status = error.errorCode === "account_session_invalid" ? 401 : response.status;
      const wait = retryAfterMs(response.headers.get("retry-after"));
      if (wait !== null) error.retryAfterMs = wait;
      throw error;
    }
    return response.json();
  }

  // The site's own tests for pasted text and for a quote of an earlier reply (Pe and Kr in its bundle)
  const isPasted = (attachment) => attachment.kind === "pasted_text" || attachment.file_name === "" ||
    /^paste(-\d+)?\.txt$/.test(attachment.file_name) || /^Pasted-.*\.txt$/.test(attachment.file_name);
  const isQuote = (attachment) => attachment.kind === "excerpt" || attachment.file_name === "excerpt_from_previous_claude_message.txt";

  // The tags of a prompt's tiles, in the page's order (It in its bundle): uploads, attached text,
  // connected sources, the prompt's own pictures and notes, then attached folders
  function tileTags(message) {
    const tags = [];
    // NOTE: [pedagogical] the API lists uploads twice, in files (older) and files_v2 (newer);
    // the site reads files_v2 when it has any, else files
    const files = message.files_v2?.length ? message.files_v2 : message.files || [];
    for (const file of files) {
      if (file.file_kind === "image") tags.push("[image]");
      // a quote saved as a file: the page draws a "Quote" card
      else if (file.file_kind === "blob" && file.file_name === "excerpt_from_previous_claude_message.txt") tags.push("[file: Quote]");
      else tags.push(`[file: ${file.file_name}]`);
    }
    // text the participant pasted or attached; its contents are never read, only its name and length
    // NOTE: [edge case callout] two rarer kinds, embed_selection and progress_item, are drawn as
    // quote tiles under their file name, which is the tag here too
    for (const attachment of message.attachments || []) {
      const content = attachment.extracted_content ?? "";
      if (isPasted(attachment) && attachment.kind !== "embed_selection") tags.push("[file: Pasted text]");
      else if (isQuote(attachment) && content.trim() !== "") {
        // the page names a quote's tile by its length: "Quote, 3 lines"
        const lines = content.split("\n").length;
        tags.push(`[file: Quote, ${lines} ${lines === 1 ? "line" : "lines"}]`);
      } else tags.push(`[file: ${attachment.file_name}]`);
    }
    // NOTE: [edge case callout] a connected source (a Google Drive file, a GitHub repository) is a
    // card whose shown name we do not know; it is tagged by what it is
    for (const source of message.sync_sources || []) tags.push("[file: Connected source]");
    for (const block of message.content || []) {
      // a picture pasted into the prompt (an image block with its own source, not an upload; an upload's
      // {type: "image", file_uuid} block is the same picture as its files entry, tagged above)
      if (block.type === "image" && !("file_uuid" in block) && ["base64", "url"].includes(block.source?.type)) tags.push("[image]");
      // a note (voice mode) is a card titled by the note (YQ in the bundle)
      // NOTE: [edge case callout] the page draws any other non-text block of a prompt as a generic
      // card; those are tool blocks, and a message of tool results alone is not a prompt, so they
      // get no tag
      if (block.type === "voice_note" || block.type === "bell") tags.push(`[file: ${block.title || "Untitled note"}]`);
    }
    // folders attached in the desktop app, last, under their name
    for (const folder of message.attachedFolders || []) tags.push(`[file: ${folder.displayName || folder.path.split("/").pop() || folder.path}]`);
    return tags;
  }

  // ---- narration the page folds away (replies with tool calls) ----
  // NOTE: [pedagogical] In a reply that uses tools (a web search, say), the page folds the short
  // "narration" before a tool call ("Let me look up current rates.") into the collapsed row of steps,
  // so it is not reply text on the page, and the page reader drops that row. The page decides with a
  // small logistic model: each text between tool calls gets a probability of being worth showing,
  // from 19 features of its words and of its place among the tool calls; below 0.107 it is narration.
  // The numbers are the site's own (es, $g and LJ in its bundle of 2026-10-14). A new build may
  // retrain them; fuzz_fold.js compares this code with the bundle's.
  const NARRATION_BIAS = -3.568243721480921, NARRATION_THRESHOLD = 0.10735388526449063;
  const NARRATION_WEIGHTS = {        // feature: [mean, standard deviation, weight]
    ends_with_colon: [0.2648171500630517, 0.4413285601531415, -0.09393777879356614],
    ends_with_ellipsis: [0, 1, 0],
    ends_with_question: [0.0016813787305590584, 0.040978745260328776, 0.32956751845650506],
    first_word_is_verb_ing: [0.032366540563261874, 0.17700880742038105, 0.09656726836202009],
    followed_by_tool_call: [0.9936948297604036, 0.07917101621966222, -0.035304062313921206],
    has_bullets: [0.02437999159310635, 0.15425825735157178, -0.050711008972480376],
    has_code_fence: [0, 1, 0],
    has_heading: [0.0008406893652795292, 0.028988546658490932, 0.005413155230004535],
    has_link: [0.0004203446826397646, 0.02050230920261824, 0.003663808379189478],
    has_table: [0.002101723413198823, 0.04580598360605948, 0.02978709195305296],
    idx_text_in_turn: [2.3076923076923075, 3.0384949097465355, -0.33831095320395443],
    is_first_text_in_turn: [0.3333333333333333, 0.47150362822843306, 0.6827546313306055],
    n_chars: [130.20050441361917, 560.9132996781615, 3.5189593644600485],
    n_newlines: [0.46027742749054223, 7.323447493240329, 0.25860316778246273],
    n_tool_uses_before_in_turn: [23.437578814627994, 22.43511793129783, -0.8612643549103961],
    n_tools_since_last_text: [7.372425388818831, 10.005381880311246, -0.2747372005541958],
    n_words: [21.6775956284153, 84.49829603949048, 3.736265901036949],
    preceded_by_thinking: [0.41067675493905004, 0.4920600909069021, 0.2784610260283084],
    starts_with_continuation: [0.48213535098781, 0.4997858045900412, -0.6312233072341642],
  };
  // words that carry on from a tool call ("Now let me ..."), and their Japanese and Chinese
  // counterparts (ij, Qt and Ig in the bundle)
  const CONTINUATION = /^\s*(now|next|next,|let me|let's|i'll|i will|first|first,|then|then,|ok|okay|alright|checking|looking|running|trying|good|great|perfect|interesting|hmm|wait|actually|time to|going to|starting|continuing|proceeding|before|after that|also|and|so)\b[,:]?/i;
  const CJK_CONTINUATION = "まず.次に.次は.それから.そして.では.それでは.じゃあ.さて.よし.続いて.さっそく.首先.然后.然後.接着.接著.接下来.接下來.现在.現在我.現在讓.現在來.让我.讓我.我先.我来.我來.好的，.好的,.好，.好,.另外，.另外,.那么.那麼".split(".");
  const CJK_NOT_CONTINUATION = ["まずい、", "まずい。", "まずい！", "まずいで", "まずいな", "まずまず", "まず間違いな", "ではなく", "现在的", "我先前"];

  // The features of one text that do not depend on its place (bJ and I_ in the bundle)
  function textFeatures(text) {
    const lines = text.split("\n");
    const trimmed = text.trim();
    const words = (trimmed.match(/\S+/g) ?? []).length;
    let chars = text.length, wideWords = 0;
    // NOTE: [pedagogical] a Chinese character counts as 3 characters and 2/3 of a word, a kana as
    // 1 more character and 1/3 of a word, so that texts in these scripts score like English ones
    if (/[\u3000-\uffff]/.test(text)) {
      for (const character of text) {
        const code = character.codePointAt(0);
        if ((code >= 19968 && code <= 40959) || (code >= 13312 && code <= 19903) || (code >= 12293 && code <= 12295) ||
            (code >= 63744 && code <= 64255) || (code >= 131072 && code <= 262143)) { chars += code > 65535 ? 2 : 3; wideWords += 2; }
        else if ((code >= 12353 && code <= 12543) || (code >= 12784 && code <= 12799) || (code >= 65381 && code <= 65439)) { chars += 1; wideWords += 1; }
      }
    }
    const bullets = lines.some((line) => /^\s*([-*\u2022]|\d+[.)])\s+/.test(line));
    const table = lines.filter((line) => /\|.*\|/.test(line)).length >= 2;
    const cjk = trimmed.charCodeAt(0) >= 12288;
    const cjkContinues = cjk && CJK_CONTINUATION.some((word) => trimmed.startsWith(word)) && !CJK_NOT_CONTINUATION.some((word) => trimmed.startsWith(word));
    const cjkPrefix = cjk && CJK_CONTINUATION.some((word) => word.length > trimmed.length && word.startsWith(trimmed));
    return {
      n_chars: chars, n_words: (3 * words + wideWords) / 3, n_newlines: lines.length - 1,
      has_code_fence: Number(/```/.test(text)), has_bullets: Number(bullets), has_heading: Number(lines.some((line) => /^#{1,4}\s+/.test(line))),
      has_table: Number(table), has_link: Number(/https?:\/\//.test(text)),
      ends_with_question: Number(/[?\uFF1F\u061F]\s*$/.test(trimmed)), ends_with_colon: Number(/:\s*$/.test(trimmed)),
      ends_with_ellipsis: Number(/(\.\.\.|\u2026)\s*$/.test(trimmed)),
      starts_with_continuation: Number(CONTINUATION.test(trimmed) || (!bullets && !table && (cjkContinues || cjkPrefix))),
      first_word_is_verb_ing: Number(/^\s*\w+ing\b/i.test(trimmed)),
    };
  }

  // The model's probability that each text of a reply is worth showing: a Map from block to number,
  // for the texts that something follows (cp, ly and MP in the bundle)
  // NOTE: [edge case callout] the page may score a text after its own markup pass (cq in its bundle,
  // which turns the old artifact tags into cards); the reader scores the API's text as it is, so a
  // text with such markup can score a little differently. The citation markers the page adds (aK) it
  // strips again before scoring, so they make no difference
  function narrationScores(blocks) {
    const events = [];
    for (const block of blocks) {
      if (block.type === "tool_use" || block.type === "tool_result") events.push({ kind: block.type, block });
      else if (block.type === "thinking" || block.type === "redacted_thinking") events.push({ kind: "thinking", block });
      else if (block.type === "text" && block.hookNotice !== true) events.push({ kind: "text", block });
    }
    // toolsBefore[i]: the tool calls among the first i events
    const toolsBefore = [0];
    for (const event of events) toolsBefore.push(toolsBefore[toolsBefore.length - 1] + Number(event.kind === "tool_use"));
    const scores = new Map();
    let textNumber = -1, previousText = -1;
    events.forEach((event, at) => {
      if (event.kind !== "text") return;
      textNumber++;
      const next = events.findIndex((later, after) => after > at && (later.kind === "tool_use" || later.kind === "text"));
      // NOTE: [edge case callout] the last text of a reply has nothing after it: never narration
      if (next >= 0 && (event.block.text ?? "").trim()) {
        const features = {
          ...textFeatures(event.block.text), idx_text_in_turn: textNumber, is_first_text_in_turn: Number(textNumber === 0),
          n_tool_uses_before_in_turn: toolsBefore[at], n_tools_since_last_text: toolsBefore[at] - toolsBefore[previousText + 1],
          followed_by_tool_call: Number(events[next].kind === "tool_use"), preceded_by_thinking: Number(at > 0 && events[at - 1].kind === "thinking"),
        };
        // NOTE: [pedagogical] logistic regression: a weighted sum of standardised features, squashed to 0..1
        let sum = NARRATION_BIAS;
        for (const [name, [mean, deviation, weight]] of Object.entries(NARRATION_WEIGHTS)) sum += weight * (((features[name] ?? 0) - mean) / deviation);
        scores.set(event.block, 1 / (1 + Math.exp(-sum)));
      }
      previousText = at;
    });
    return scores;
  }

  // The text blocks of a finished reply that the page does not show as text: folded into a row of
  // steps, or held for a steps row that never comes. `allBlocks` are the reply's blocks as the page
  // sees them (pageBlocks). The rules follow the site's own code (LC, Cl, i7 and YB in its bundle) step
  // by step.
  // NOTE: [edge case callout] of the tools the page draws as cards in the reply (Xz and Xr in the
  // bundle), only the artifacts tool is known here; a card made by another tool (a widget, a
  // connector's card) also keeps the text before it shown on the page, but is a step here. Also not
  // modelled: a thinking block right before memory tools is dropped first, and tools hidden by name.
  // Each needs flags and tool lists this reader does not have. The reply is taken as finished (with
  // a stop reason): while it streams the page folds a little differently.
  function foldedNarration(allBlocks) {
    const served = allBlocks.some((block) => block.type === "text" && block.narration_fold !== undefined);
    // the server's own verdicts, when it sent any, replace the model (al in the bundle)
    const scores = served ? new Map() : narrationScores(allBlocks);
    const blocks = allBlocks.filter((block) => !(block.type === "tool_use" && block.hidden_in_chat === true));
    // a tool call drawn as a card, and its result
    const cardIds = new Set(blocks.filter((block) => block.type === "tool_use" && block.name === "artifacts").map((block) => block.id));
    const isCard = (block) => (block.type === "tool_use" && cardIds.has(block.id)) || (block.type === "tool_result" && "tool_use_id" in block && cardIds.has(block.tool_use_id));
    const hasText = (block) => block.type === "text" && Boolean(block.text?.trim());
    const servedFolded = (block) => block.type === "text" && block.narration_fold === "folded" && !block.citations?.length;
    const emptyThinking = (block) => !block.thinking?.trim() && !block.summaries?.length && !block.cut_off;
    // show, hide or undecided: the server's verdict first, else the model's (i7)
    const verdict = (block) => {
      if (block.fromSendToUser || block.fromSendUserMessage) return "show";
      const fold = block.narration_fold ?? block.narration_fold_hold;
      if (fold !== undefined) return fold === "folded" ? "hide" : fold === "shown" ? "show" : "undecided";
      const score = scores.get(block);
      return score === undefined ? "undecided" : score < NARRATION_THRESHOLD ? "hide" : "show";
    };
    // what a block does to a run of text (Cl): a step ends it and can take it, a "blocking" block ends
    // it and keeps it shown, a transparent one is passed over
    const kindOf = (block) => {
      if (isCard(block)) return "blocking";
      if (block.type === "tool_use_summary" || block.type === "tool_result" || block.type === "token_budget") return "transparent";
      if (block.type === "thinking") return block.alternative_display_type === "working" && !block.thinking?.trim() && !block.summaries?.length ? "transparent" : "step";
      if (block.type === "tool_use") return "step";
      if (block.type === "text") return block.hookNotice === true ? "blocking" : hasText(block) && !servedFolded(block) ? "run" : "transparent";
      return "blocking";
    };

    // 1. Runs of text (LC): a run may fold only if every text in it is narration, none has
    //    citations, and a step comes right after it
    const foldable = new Set();
    const runs = [];
    for (let at = 0; at < blocks.length;) {
      if (kindOf(blocks[at]) !== "run") { at++; continue; }
      const run = [];
      let end = "end", show = false;
      for (; at < blocks.length; at++) {
        const kind = kindOf(blocks[at]);
        if (kind === "run") {
          run.push(blocks[at]);
          if (blocks[at].citations?.length || verdict(blocks[at]) !== "hide") show = true;
        } else if (kind !== "transparent") { end = kind; break; }
      }
      const folds = !show && end === "step";
      if (folds) run.forEach((block) => foldable.add(block));
      runs.push({ run, folds, chars: run.reduce((sum, block) => sum + block.text.length, 0) });
    }
    // NOTE: [edge case callout] a reply whose every text would fold (it ends with a tool call) keeps
    // its longest run (the last of equally long ones) shown
    if (foldable.size && runs.every((entry) => entry.folds)) {
      const longest = runs.reduce((best, entry) => (entry.chars >= best.chars ? entry : best));
      longest.run.forEach((block) => foldable.delete(block));
    }

    // 2. Where each block goes (YB): the open row of steps (row), or the groups so far (groups:
    //    rows of steps, and content shown as it is); cards wait in `cards` until the next content,
    //    and served narration waits in `held` for the row of its tool call
    let row = [], cards = [];
    const groups = [];
    const held = new Map();
    const closeRow = () => { if (row.length) { groups.push({ steps: true, blocks: row }); row = []; } };
    const show = (block) => {
      closeRow();
      if (cards.length) groups.push({ steps: false, blocks: cards });
      groups.push({ steps: false, blocks: [block] });
      cards = [];
    };
    // into the open row; else into the last row of steps, even one before shown content; else a new row
    const joinRow = (block) => {
      for (const waiting of held.values()) row.push(...waiting);
      held.clear();
      const lastRow = groups.findLast((group) => group.steps);
      if (row.length || !lastRow) row.push(block);
      else lastRow.blocks.push(block);
    };
    const rowJustBefore = () => row.length > 0 || groups[groups.length - 1]?.steps === true;
    const anchorOf = (block) => block.display_group && (block.display_group.run?.anchor_id ?? block.display_group.id);
    // the display group of the newest tool call in the row just before (A in the bundle)
    const lastAnchor = () => {
      const steps = row.length ? row : groups[groups.length - 1]?.steps ? groups[groups.length - 1].blocks : [];
      const call = steps.findLast((block) => block.type === "tool_use");
      return call && anchorOf(call);
    };
    // the first thing after `at` that is not passed over: is it a step tool call? (E in the bundle)
    const stepFollows = (at) => {
      for (const later of blocks.slice(at + 1)) {
        if (later.type === "tool_use") return !isCard(later);
        if (!["thinking", "tool_result", "token_budget", "tool_use_summary"].includes(later.type) && !(later.type === "text" && (!hasText(later) || foldable.has(later)))) return false;
      }
      return false;
    };
    // does a tool call of this anchor's group come before anything shown? (j in the bundle)
    const anchorFollows = (at, anchor) => {
      for (const later of blocks.slice(at + 1)) {
        if (later.type === "tool_use") {
          if (isCard(later)) return false;
          if (anchorOf(later) === anchor) return true;
          if (later.name !== "hub_workspace_setup") return false;
        } else if (!["thinking", "tool_result", "token_budget", "tool_use_summary"].includes(later.type) &&
                   !(later.type === "text" && (!hasText(later) || (servedFolded(later) && later.run_anchor_id === anchor)))) return false;
      }
      return false;
    };
    blocks.forEach((block, at) => {
      if (block.type === "thinking") {
        if (block.alternative_display_type === "working") {
          if (block.thinking?.trim() || block.summaries?.length) row.push(block);
        } else if (!(block.stop_timestamp && emptyThinking(block))) joinRow(block);   // an empty finished thinking is left out
      } else if (block.type === "tool_use_summary") joinRow(block);
      else if (isCard(block)) cards.push(block);
      else if (block.type === "tool_use") {
        const waiting = held.get(anchorOf(block));
        if (waiting) { row.push(...waiting); held.delete(anchorOf(block)); }
        row.push(block);
      } else if (block.type === "text" && hasText(block)) {
        const hook = block.hookNotice === true;          // a hook's notice is always shown
        if (!hook && servedFolded(block)) {
          // NOTE: [edge case callout] narration the server folded goes into a row only with the
          // anchor of a tool call's group (run_anchor_id) next to it; without one it is shown
          const anchor = block.run_anchor_id;
          if (anchor !== undefined && !cards.length && lastAnchor() === anchor) joinRow(block);
          else if (anchor !== undefined && !cards.length && anchorFollows(at, anchor)) held.set(anchor, [...(held.get(anchor) || []), block]);
          else show(block);
        } else if (!hook && foldable.has(block) && !cards.length && rowJustBefore()) joinRow(block);
        else if (!hook && foldable.has(block) && !cards.length && stepFollows(at)) row.push(block);
        else show(block);
      } else if (!["text", "tool_result", "token_budget"].includes(block.type)) show(block);
    });
    closeRow();
    if (cards.length) groups.push({ steps: false, blocks: cards });
    // what is not shown as content: folded into a row, or held for a row that never came
    const shown = new Set(groups.filter((group) => !group.steps).flatMap((group) => group.blocks));
    return new Set(blocks.filter((block) => block.type === "text" && !shown.has(block)));
  }

  // A message's blocks as the page renders them (hA, i8 and oI in its bundle): a first text that is
  // empty is dropped, and so are bookkeeping markers; a connector's text is shown as thinking, and a
  // reply sent through the send_to_user tool call (a tool chats get behind a feature flag) is text:
  // its input.message, without the <cc-memory> tags the model may put around remembered files
  // NOTE: [edge case callout] a message without content blocks keeps its words in .text
  // (the site does the same: qO in its bundle)
  function pageBlocks(message) {
    const blocks = message.content || [{ type: "text", text: message.text || "" }];
    const first = blocks[0]?.type === "text" && !blocks[0].text?.trim() ? 1 : 0;
    return blocks.slice(first).filter((block) => block.type !== "process_group_marker").map(pageBlock);
  }
  function pageBlock(block) {
    if (block.type === "connector_text") return { type: "thinking", thinking: block.connector_text, summaries: [], cut_off: false };
    if (block.type === "tool_use" && block.name === "send_to_user" && !block.integration_name && !block.mcp_server_url && !block.is_mcp_app) {
      // NOTE: [edge case callout] a call without a message is an empty text (Xd gives ""), not a step
      const message = typeof block.input?.message === "string" ? block.input.message : "";
      const text = message.replace(/<cc-memory(?:\s+filenames="[^"<>]*")?\s*>|<\/cc-memory\s*>/g, "");
      return { type: "text", text, stopped: true, collapsible: false, fromSendToUser: true };
    }
    return block;
  }

  // The words of a message as the page shows them: attachments as tags first (the page draws
  // its tiles above the bubble), then its text blocks. Thinking, tool calls and their results,
  // bookkeeping blocks and folded narration are not shown as text.
  function messageText(message) {
    const tags = message.sender === "human" ? tileTags(message) : [];
    const blocks = pageBlocks(message);
    const folded = message.sender === "human" ? new Set() : foldedNarration(blocks);
    const texts = blocks.filter((block) => block.type === "text" && !folded.has(block)).map((block) => withoutOldTags(block.text ?? "").trim());
    return [...tags, texts.filter(Boolean).join("\n\n")].filter(Boolean).join("\n");
  }

  // Replies written before late 2024 keep their thinking and artifacts inside the text, as
  // <antThinking>...</antThinking> and <antArtifact ...>...</antArtifact>; the page hides the
  // first and draws the second as a card, so neither is reply text
  // (what is left keeps at most one blank line in a row, as the page reader's text does)
  function withoutOldTags(text) {
    return text.replace(/<antThinking>[\s\S]*?(?:<\/antThinking>|$)/g, "")
               .replace(/<antArtifact\b[^>]*>[\s\S]*?(?:<\/antArtifact>|$)/g, "")
               .replace(/\n{3,}/g, "\n\n");
  }

  // The messages of the branch the page shows, in order. The steps follow the site's own tree code
  // (JF, WK, vy, aZ and $a in its bundle), one by one.
  // NOTE: [pedagogical] with tree=True the API returns every version of the chat: an edited
  // prompt or a retried reply is a sibling (same parent) of the one it replaced, and
  // current_leaf_message_uuid is the last message of the version the participant last looked at
  function shownBranch(conversation) {
    const all = conversation.chat_messages;
    const byUuid = new Map(all.map((message) => [message.uuid, message]));

    // 1. A prompt no reply answers (yet) stays out of the tree: kept are every reply, every prompt a
    //    reply answers, old messages without parent ids, and the ancestors of all of these.
    // NOTE: [edge case callout] the site tests a missing parent as === undefined; a null parent
    // (not seen in any source) counts as missing here too, so an old chat cannot lose its prompts
    const answered = new Set(all.filter((message) => message.sender === "assistant").map((message) => message.parent_message_uuid));
    const kept = new Set();
    for (const message of all) {
      if (message.sender !== "assistant" && !answered.has(message.uuid) && message.parent_message_uuid != null) continue;
      for (let at = message; at && !kept.has(at.uuid); at = byUuid.get(at.parent_message_uuid)) kept.add(at.uuid);
    }
    const tree = all.filter((message) => kept.has(message.uuid));
    const dangling = all.filter((message) => !kept.has(message.uuid) && message.sender === "human");

    // 2. Each message's parent. Chats from before branching have no parent ids: the parent is then
    //    the message with the nearest earlier index (an index can be missing).
    const byIndex = new Map(tree.map((message) => [message.index, message]));
    const parentOf = new Map();
    const childrenOf = new Map();
    for (const message of tree) {
      let parent = message.parent_message_uuid;
      for (let index = message.index - 1; !parent && index >= 0; index--) parent = byIndex.get(index)?.uuid;
      parent = parent || ROOT;
      parentOf.set(message.uuid, parent);
      childrenOf.set(parent, [...(childrenOf.get(parent) || []), message.uuid]);
    }

    // 3. The leaf: the server's, or the last message of the tree when the server's is not in it.
    //    Walking up from the leaf picks, at each fork, the child on the leaf's path. With no leaf at
    //    all, nothing is picked, and the page takes the first child at every fork.
    let leaf = conversation.current_leaf_message_uuid;
    if (leaf && !parentOf.has(leaf)) leaf = tree[tree.length - 1]?.uuid;
    const picked = new Map();
    for (let at = leaf, seen = new Set(); parentOf.has(at) && !seen.has(at); at = parentOf.get(at)) {
      seen.add(at);
      picked.set(parentOf.get(at), childrenOf.get(parentOf.get(at)).indexOf(at));
    }

    // 4. The branch: from the root down, the picked child at each step.
    // NOTE: [edge case callout] the site throws on a cycle in the tree; we stop at it
    const branch = [];
    for (let at = ROOT, seen = new Set(); childrenOf.has(at) && !seen.has(at); at = branch[branch.length - 1].uuid) {
      seen.add(at);
      branch.push(byUuid.get(childrenOf.get(at)[picked.get(at) || 0]));
    }

    // 5. A prompt still waiting for its reply is shown after the branch: the server's leaf if it is
    //    one, else the last one whose parent ends the branch.
    const end = branch.length ? branch[branch.length - 1].uuid : ROOT;
    const waiting = dangling.find((message) => message.uuid === conversation.current_leaf_message_uuid) ||
                    dangling.filter((message) => (message.parent_message_uuid ?? ROOT) === end).pop();
    return waiting ? [...branch, waiting] : branch;
  }

  const reader = {
    host: "claude.ai",

    // The participant's own organization, whose chats are read: {org, personal, accountId}, or null
    // when there is nothing to read (signed out, or no organization that can chat).
    // NOTE: [design thought] the page shows the chats of one organization at a time (the lastActiveOrg
    // cookie), and a participant with a Team plan can switch between it and their own. The reader
    // always reads their own (personal) organization instead, whichever one the page shows: a Team
    // workspace is never read, and a chat listed weeks ago is read in the organization it was listed
    // in. `personal` is false when the account has no organization of its own that can chat; then
    // nothing should be read. accountId tells one account from another on the same browser.
    async auth(context) {
      let account;
      try {
        account = await getJson(context, "/api/account");
      } catch (error) {
        if (error.status === 401) return null;       // signed out
        throw error;
      }
      // NOTE: [edge case callout] an organization can come without capabilities; the site reads
      // them as none (iO in its bundle)
      const chatOrgs = (account.memberships ?? []).map((membership) => membership.organization)
        .filter((organization) => (organization?.capabilities ?? []).includes("chat"));
      // a Team or Enterprise workspace, as the site tells them apart (tQ and BG in its bundle)
      const isWorkspace = (organization) => organization.raven_type === "enterprise" || organization.capabilities.includes("raven");
      // NOTE: [edge case callout] an account has one organization of its own (the site calls every
      // one that is not a workspace "Personal"); were there several, the first is taken, in the
      // API's order, so the choice does not change from one page to the next
      const own = chatOrgs.find((organization) => !isWorkspace(organization));
      const org = own ?? chatOrgs[0];
      return org ? { org: org.uuid, personal: Boolean(own), accountId: account.uuid } : null;
    },

    // One page of the conversation list, most recently updated first. cursor: the offset (null = 0).
    async list(context, auth, cursor) {
      const offset = cursor || 0;
      // NOTE: [design thought] the same query as the sidebar: archived chats stay out, as they do
      // there; starred and project chats are in it
      const page = await getJson(context, `/api/organizations/${auth.org}/chat_conversations_v2` +
                                          `?limit=${PAGE_SIZE}&offset=${offset}&archived=false&consistency=${CONSISTENCY}`);
      // NOTE: [edge case callout] the sidebar drops archived items even from this query (o8s in the
      // site's bundle), e.g. one archived while the page was being fetched; so do we
      const items = page.data
        .filter((item) => !item.is_archived && !item.session_id && (!item.platform || CHAT_PLATFORMS.has(item.platform)))
        .map((item) => ({ id: item.uuid, title: item.name || "", createdAt: toMs(item.created_at), updatedAt: toMs(item.updated_at) }));
      // NOTE: [edge case callout] offsets shift while we page. A chat updated meanwhile jumps to the
      // top: it comes again on page 1 (and a later page repeats one; the caller keeps ids it has
      // seen). A chat deleted or archived above our place moves every later one up by one, so the
      // first chat of the next page would be skipped for good: each page therefore starts
      // PAGE_OVERLAP chats before the previous one ended. More removals than that between two pages
      // can still skip chats.
      // NOTE: [pedagogical] the step is counted in pages of the API, not in the items we kept, as
      // the site's own getNextPageParam does (has_more ? pages * limit : undefined)
      const next = page.has_more && page.data.length ? offset + PAGE_SIZE - PAGE_OVERLAP : null;
      return { items, next };
    },

    // One conversation as the page shows it: the current branch, in order; null if it is gone.
    // replyInProgress: its last reply has no stop reason yet, so it is still being written (in
    // the phone app, say) and its text is only the part written so far: read it again later.
    async read(context, auth, id) {
      let conversation;
      try {
        // the query the page sends when it opens a chat (xi in its bundle, with its default consistency)
        conversation = await getJson(context, `/api/organizations/${auth.org}/chat_conversations/${id}` +
                                              "?tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true" +
                                              `&consistency=${CONSISTENCY}`);
      } catch (error) {
        // NOTE: [design thought] "gone" is what the site itself counts as gone (yk / Dh in its bundle):
        // the error chat_conversation_not_found, or 410. Any other 404 or 403 (no access, an edge
        // page) is thrown, so the caller does not record a chat as deleted
        if ((error.errorType === "not_found_error" && error.errorCode === "chat_conversation_not_found") || error.status === 410) return null;
        throw error;
      }

      // Like the page reader: a message with nothing to show is skipped, and a reply that comes
      // in several messages in a row is one reply
      const branch = shownBranch(conversation);
      const shown = [];
      for (const message of branch) {
        const role = message.sender === "human" ? "user" : "assistant";
        const content = messageText(message);
        const previous = shown[shown.length - 1];
        if (!content) continue;
        if (role === "assistant" && previous?.role === "assistant") previous.content += `\n\n${content}`;
        else shown.push({ role, content, at: toMs(message.created_at) });
      }
      // NOTE: [edge case callout] the page counts a reply without a stop reason as still streaming
      // (S5 in its bundle); whether replies from before 2025 always carry one is not known (spec §3)
      const last = branch[branch.length - 1];
      return {
        id: conversation.uuid,
        title: conversation.name || "",
        createdAt: toMs(conversation.created_at),
        updatedAt: toMs(conversation.updated_at),
        messages: shown,
        replyInProgress: last?.sender === "assistant" && last.stop_reason == null,
      };
    },

    // The page of a conversation; project chats live at /chat/<id> too
    pathOf(id, item) {
      return `/chat/${id}`;
    },

    toMs,             // exposed for the tests
    shownBranch,      // exposed for the tests (fuzz_branch.js compares it with the site's own code)
    foldedNarration,  // exposed for the tests (fuzz_fold.js compares it with the site's own code)
    narrationScores,  // exposed for the tests (the same)
  };

  root.HISTORY_READERS = root.HISTORY_READERS || {};
  root.HISTORY_READERS[reader.host] = reader;
  if (typeof module !== "undefined" && module.exports) module.exports = reader;
})(typeof self !== "undefined" ? self : globalThis);
