// Grok (grok.com): the participant's conversation list and their past conversations, read through
// the same-origin REST API that grok.com's own page calls. Evidence and open questions: spec.md.
// Runs as a plain script in the content script on grok.com (fetch sends the page's cookies), and
// under Node for the tests (context.fetch is then a stub).
(function (root) {
  // NOTE: [design thought] every request here is one the page itself sends: the sidebar's list,
  // and, when a conversation is opened, its details, its tree of message ids, and the messages,
  // 30 at a time. None is one of the API's write endpoints (all are GET, except load-responses, a
  // POST whose body is only ids). Whether the server notes such a read, for example by clearing
  // the dot of an unread Grok check-in, is not known (spec.md §10, open question 17).
  const PAGE_SIZE = 60;          // the sidebar asks for 60 conversations per page
  const BATCH_SIZE = 30;         // the page loads at most 30 messages per load-responses call
  const CHAT = "CONVERSATION_KIND_UNSPECIFIED";   // an ordinary chat (not Imagine, a bot or a plugin)

  // Markup in a reply's text that the page draws as something other than text: citation chips and
  // cards (<grok:render>, <grok:richcontent>, <grok type="...">), tool-call cards
  // (<xai:tool_usage_card>), and any other <grok:...>/<xai:...> tag. This is the page's own
  // plain-text rule plus its rule for UI blocks (stripRenderUiElements).
  const REPLY_MARKUP = new RegExp([
    String.raw`<grok:render\b[^>]*(?:\/>|>[\s\S]*?<\/grok:render>)`,
    String.raw`<grok:richcontent\b[\s\S]*?<\/grok:richcontent>`,
    String.raw`<xai:tool_usage_card>[\s\S]*?<\/xai:tool_usage_card>`,
    String.raw`<grok\s[^>]*?\/>`,
    String.raw`<grok\s[^>]*>[\s\S]*?<\/grok>`,
    String.raw`<\/?(?:grok|xai):[^>]*>`,
  ].join("|"), "g");

  // What the page cuts from a participant's message before showing it: the context block the
  // composer may append (stripUiContext), then the id tags of the Imagine and agent composers
  // (stripWireTags). Each pattern is applied once, in this order, as the page does.
  const USER_MARKUP = [
    /\n*<ui_context>[\s\S]*?<\/ui_context>\s*$/,
    /\[references:[@a-f0-9,-]+\]\s*/, /\[audio:[@a-f0-9,-]+\]\s*/, /\[reference_ids:[@a-f0-9,-]+\]\s*/,
    /\[uploaded:[@a-f0-9,\-\s]+\]\s*/, /\[generated:[@a-f0-9,\-\s]+\]\s*/, /\[gen_settings:[^\]]*\]\s*/,
    /\[text(?:\s+id=[a-zA-Z0-9_-]+)?\][\s\S]*?\[\/text\]\s*/g, /\s*<canvas_state>[\s\S]*?<\/canvas_state>\s*$/,
  ];
  const userText = (message) => USER_MARKUP.reduce((text, pattern) => text.replace(pattern, ""), message);

  // The same clean-up the extension's DOM reader applies to the text it reads off the page
  // (content/capture.js). NOTE: [design thought] both roles stay Markdown source here, while the
  // page renders both as Markdown (the participant's too: lists, links, emphasis, and a line's
  // leading spaces as U+00A0). So compare this text with the DOM reader's through Episodes.loose,
  // never exactly: on a real conversation, 6 of 7 participant turns are equal, 7 of 7 loosely (spec §6)
  const tidy = (text) => text.replace(/[​⁠]/g, "").replace(/ +\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // NOTE: [pedagogical] a turn's content can also come as "chunks", protobuf messages in their JSON
  // form (chat_types.proto in the page's code): an input chunk holds one of {text: {text}},
  // {mention: {fileMention|skillMention|botMention: {label, ...}}}, {systemNotificationChunk:
  // {kind, title, body}}, ...; an output chunk one of {text: {text, channel}}, {phaseMarker}, tool
  // cards, renders, ... The page reads them where a turn's plain fields are empty; so does this.
  // Text on these channels is Grok's thinking and its step notes, not its answer (enum Channel,
  // as its name or its number)
  const NOT_ANSWER = new Set(["CHANNEL_ASSISTANT_THINKING", "CHANNEL_ASSISTANT_NOTETAKER_HEADER",
                              "CHANNEL_ASSISTANT_NOTETAKER_SUMMARY", 2, 3, 4]);
  // A system notification of these kinds (enum PromptOrigin) does not make a turn system-written
  const PARTICIPANT_KINDS = new Set([undefined, 0, 3, "PROMPT_ORIGIN_UNSPECIFIED", "PROMPT_ORIGIN_USER"]);

  // The participant's side of a turn, as the page takes it: its text, its attachments' ids, and
  // whether the system wrote it in the participant's place (a scheduled task, a subagent's report,
  // Grok's own check-in). The plain fields come first, the input chunks fill what they lack
  // (deriveResponseFromChunks, enrichSharedResponse, isSystemOriginMessage).
  function participantSide(response) {
    const chunks = response.inputChunks ?? [];
    const chunkText = chunks.map((chunk) => chunk.text?.text ?? chunk.mention?.fileMention?.label ??
                                 chunk.mention?.skillMention?.label ?? chunk.mention?.botMention?.label ?? "").join("");
    const message = response.message || chunkText;
    const fileIds = response.fileAttachments?.length ? response.fileAttachments
                                                     : chunks.map((chunk) => chunk.mention?.fileMention?.fileId).filter(Boolean);
    // NOTE: [edge case callout] the origin the answer carries decides when there is one: "" and
    // "user" are the participant; only a missing origin is looked for elsewhere, as on the page
    let origin = response.metadata?.origin;
    const notification = chunks.find((chunk) => chunk.systemNotificationChunk)?.systemNotificationChunk;
    if (origin == null && notification && !PARTICIPANT_KINDS.has(notification.kind)) origin = "system_notification";
    if (origin == null && /^\s*<system[-_]reminder>/.test(message)) origin = "system_reminder";
    return { message, fileIds, systemWritten: Boolean(origin) && origin !== "user" };
  }

  // A reply's answer from its output chunks, for a reply whose `message` is empty: the answer's
  // pieces of text in order, one paragraph per phase (the parts before and after a tool call), as
  // the page folds them (foldTurn, turnToResponseFields)
  // NOTE: [edge case callout] a reply written by several rollouts at once keeps them all here; the
  // page shows the chosen one
  function chunkAnswer(chunks) {
    const phases = new Map();          // phase index -> that phase's answer so far
    let phase = 0;
    for (const chunk of chunks) {
      phase = chunk.metadata?.phaseIndex ?? chunk.phaseMarker?.phaseIndex ?? phase;
      if (!chunk.text?.text || NOT_ANSWER.has(chunk.text.channel)) continue;
      phases.set(phase, (phases.get(phase) ?? "") + chunk.text.text);
    }
    return [...phases.values()].filter((text) => text.trim()).join("\n\n");
  }

  // An HTTP error as the caller expects it: .status, and .retryAfterMs when the answer says
  function httpError(response, request) {
    const error = new Error(`grok.com ${request}: HTTP ${response.status}`);
    error.status = response.status;
    // NOTE: [edge case callout] Retry-After can also be an HTTP date; only the seconds form is read
    // (grok.com's own client never reads this header, so whether it is sent is unknown)
    const seconds = Number(response.headers.get("Retry-After"));
    if (seconds > 0) error.retryAfterMs = seconds * 1000;
    return error;
  }

  // One request to grok.com's API; its JSON answer
  async function call(context, path, init = {}) {
    const response = await context.fetch(context.location.origin + path, { credentials: "include", ...init });
    if (!response.ok) throw httpError(response, `${init.method || "GET"} ${path}`);
    return response.json();
  }

  // An attachment's details when the message does not carry them: the page asks for them the same way
  async function fetchAsset(context, assetId) {
    try {
      return await call(context, `/rest/assets/${assetId}`);
    } catch (error) {
      // NOTE: [edge case callout] when the lookup fails (403/404: an attachment the participant
      // cannot open any more; 5xx too) the page shows a file chip named "Hidden attachment" (a
      // translated label in other UI languages). A 401 or 429 says something about the session or
      // the pace rather than the file, so it is passed on: the caller waits and reads again later.
      if (error.status && error.status !== 401 && error.status !== 429) return { mimeType: "application/octet-stream", name: "Hidden attachment" };
      throw error;
    }
  }

  // An attachment's tag, as the DOM reader writes the page's chip: "[image]" for a chip that draws
  // a thumbnail (an <img> or a <video>), "[file: <its label>]" for the others. The page draws one
  // for a picture or a video, by the type it gives the file (resolveFileType): its mime type, or
  // the name's extension when the mime type says nothing. SVG drawings, HEIC photos and deleted
  // files get a file icon. A deleted file's label is "Deleted file", an unnamed one's "Untitled"
  // (both translated in other UI languages).
  const VAGUE_TYPES = new Set(["", "text/plain", "application/octet-stream", "application/binary", "video/mp2t"]);
  const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "ico", "webp"]);
  const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi", "mkv"]);
  function attachmentTag(asset) {
    const type = (asset.mimeType ?? "").toLowerCase();
    const extension = /\.([^.]+)$/.exec((asset.name ?? "").toLowerCase())?.[1];
    // NOTE: [edge case callout] the page also falls back to the extension for a precise mime type
    // its table does not list, and a vague type with an unknown extension can still be a video
    // there; both are left out here (rare, and the loose form of a turn ignores its tags)
    const vague = VAGUE_TYPES.has(type) || type.startsWith("text/plain");
    const image = vague ? IMAGE_EXTENSIONS.has(extension)
                        : type.startsWith("image/") && !type.startsWith("image/svg+xml") && type !== "image/heic" && type !== "image/heif";
    const video = vague ? VIDEO_EXTENSIONS.has(extension) : type.startsWith("video/") || type === "application/mp4";
    if (!asset.isDeleted && (image || video)) return "[image]";
    return `[file: ${asset.isDeleted ? "Deleted file" : asset.name || "Untitled"}]`;
  }

  // A participant's attachments as tags, in the order the page shows the chips
  async function attachmentTags(context, response, fileIds) {
    const carried = [], fetched = [];
    for (const assetId of fileIds) {
      const asset = (response.fileAttachmentAssetMetadata ?? []).find((known) => known.assetId === assetId);
      if (asset) carried.push(asset);
      else fetched.push(await fetchAsset(context, assetId));
    }
    // NOTE: [edge case callout] the page adds the chips whose details it had to ask for after the
    // others, each when its answer arrives, so they come last (here in the order asked; on the page
    // in the order answered); files the model made itself get no chip
    return [...carried, ...fetched].filter((asset) => !asset.isModelGenerated).map(attachmentTag);
  }

  // The project a chat is kept in: its workspaces, else its workspaceId, in the page's order
  // (linkedWorkspaceIdsFrom); null for a chat outside any project
  const projectOf = (conversation) => conversation.workspaces?.[0]?.workspaceId || conversation.workspaceId || null;

  const reader = {
    host: "grok.com",

    // NOTE: [design thought] the session lives in HttpOnly cookies that fetch sends by itself, so
    // there is no token to read and nothing to pass on: {} when signed in. Signed in or not is what
    // a one-item list answers. (The page sends this same request, to learn whether an organisation's
    // network policy blocks the participant; 401 is how the page's API client learns, on any
    // request, that the session is gone.) A 403 is not "signed out" (that network policy,
    // Cloudflare): it is passed on.
    // NOTE: [edge case callout] {} says nothing about the account: the caller cannot tell another
    // Grok account, or a Grok Business team, from the participant's own (spec §1, open question 10)
    async auth(context) {
      const path = "/rest/app-chat/conversations?pageSize=1";
      const response = await context.fetch(context.location.origin + path, { credentials: "include" });
      if (response.status === 401) return null;
      if (!response.ok) throw httpError(response, `GET ${path}`);
      return {};
    },

    // One page of the conversation list. cursor: the previous page's nextPageToken (null: first page).
    async list(context, auth, cursor) {
      // excludeProjects=false: the sidebar's history leaves out the chats kept in a project; we want them too
      const query = new URLSearchParams({ pageSize: String(PAGE_SIZE), excludeProjects: "false" });
      if (cursor) query.set("pageToken", cursor);
      const page = await call(context, `/rest/app-chat/conversations?${query}`);
      // NOTE: [design thought] only the participant's own ordinary chats: a private chat (temporary)
      // has no address of its own; Imagine, bot and plugin conversations (kind) live on pages the
      // extension does not read; and a chat someone else owns in a project shared with the
      // participant (viewerIsOwner false) holds that person's messages, not theirs
      // NOTE: [edge case callout] the page also counts as Imagine "director" conversations some
      // whose kind is not set (marked in that browser, or by the model they used); those pass here
      const items = (page.conversations ?? [])
        .filter((conversation) => !conversation.temporary && (conversation.kind ?? CHAT) === CHAT && conversation.viewerIsOwner !== false)
        .map((conversation) => ({
          id: conversation.conversationId,
          title: conversation.title,
          createdAt: Date.parse(conversation.createTime),
          updatedAt: Date.parse(conversation.modifyTime),
          projectId: projectOf(conversation),
        }));
      // the last page carries no token (or an empty one)
      return { items, next: page.nextPageToken || null };
    },

    // One conversation: the branch the page's own REST load shows when it is opened, in page order.
    // null: no such conversation, or not the participant's.
    async read(context, auth, id) {
      // 1. Its title, times and project, asked for as the page asks (with its projects). 404: no
      //    such conversation
      let detail;
      try {
        detail = await call(context, `/rest/app-chat/conversations_v2/${id}?includeWorkspaces=true&includeTaskResult=true`);
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
      // A team switch asked for (the page checks this first): the chat exists, in the participant's
      // other space (their personal one while the page acts for a team, or a team's). Not gone, so
      // an error: the caller keeps what it has and tries again later
      if (detail.teamSwitchPrompt) throw new Error("grok.com: the conversation is in another team space (team switch asked for)");
      // No `conversation`: not the participant's (someone else's, perhaps shared with them).
      // viewerIsOwner false: someone else's chat in a project shared with the participant, whose
      // "human" turns are that person's (the page offers to continue it as a copy)
      const conversation = detail.conversation;
      if (!conversation || conversation.viewerIsOwner === false) return null;

      // 2. The tree of its messages: ids, senders and parents only
      const { responseNodes = [] } = await call(context, `/rest/app-chat/conversations/${id}/response-node`);

      // 3. The current branch. An edited message is a sibling of the original (same parent), so the
      //    messages form a tree. Like the page's REST load, start from the newest node of the main
      //    conversation (side threads, "threadParentId", are not part of it) and follow the parents
      //    to the root. (When the participant opens their own chat, the page shows the branch its
      //    live connection to grok.com sends, which may be another one: spec §5.)
      // NOTE: [pedagogical] the root's parentResponseId names a node that is not in the list, which
      // is what ends the walk; the `includes` check only guards against a cycle in bad data
      const nodes = responseNodes.filter((node) => !node.threadParentId);
      const byId = new Map(nodes.map((node) => [node.responseId, node]));
      const branch = [];
      for (let node = nodes.at(-1); node && !branch.includes(node); node = byId.get(node.parentResponseId)) {
        branch.unshift(node);
      }

      // 4. The messages' contents, BATCH_SIZE at a time (the answer's order is not relied on)
      const responses = new Map();
      for (let start = 0; start < branch.length; start += BATCH_SIZE) {
        const responseIds = branch.slice(start, start + BATCH_SIZE).map((node) => node.responseId);
        const page = await call(context, `/rest/app-chat/conversations/${id}/load-responses`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ responseIds }),
        });
        for (const response of page.responses ?? []) responses.set(response.responseId, response);
      }

      // 5. The messages, cleaned up as the DOM reader cleans the page's text
      const messages = [];
      for (const [k, node] of branch.entries()) {
        const response = responses.get(node.responseId);
        // NOTE: [edge case callout] a reply still being written may not be returned yet
        if (!response) continue;
        // "human" is the participant; the page's chunk views (and exporters) also accept "user"
        const role = response.sender === "human" || response.sender === "user" ? "user" : "assistant";
        let content;
        let at = Date.parse(response.createTime) || null;
        if (role === "user") {
          const side = participantSide(response);
          // a turn the system wrote in the participant's place: the participant did not type it
          if (side.systemWritten) continue;
          const tags = await attachmentTags(context, response, side.fileIds);
          content = [...tags, tidy(userText(side.message))].filter(Boolean).join("\n");
          // When it was sent. Its createTime is when it was saved, with its reply, once the reply was
          // written: 20-50 s after the send in a real capture, minutes after a long think (spec §6).
          // Its reply's thinkingStartTime is when Grok began on it, a fraction of a second after the
          // send. The earlier of the two is taken: a reply regenerated later began later.
          // NOTE: [edge case callout] a turn whose reply is missing (still being written) or has no
          // thinkingStartTime keeps its createTime
          const started = Date.parse(responses.get(branch[k + 1]?.responseId)?.thinkingStartTime);
          if (started < at) at = started;
        } else {
          // the reply's text is its answer only: thinking and tool steps are separate fields
          // (thinkingTrace, steps) and chunks on other channels, which this never reads
          const answer = response.message || chunkAnswer(response.outputChunks ?? []);
          content = tidy(answer.replace(REPLY_MARKUP, ""));
        }
        // e.g. a reply that failed and shows only an error card
        if (!content) continue;
        const previous = messages.at(-1);
        // a reply right after a dropped system turn joins the reply before it, the way the DOM
        // reader joins the parts of one reply
        if (role === "assistant" && previous?.role === "assistant") previous.content += `\n\n${content}`;
        else messages.push({ role, content, at });
      }

      return {
        id,
        title: conversation.title,
        createdAt: Date.parse(conversation.createTime),
        updatedAt: Date.parse(conversation.modifyTime),
        projectId: projectOf(conversation),
        messages,
      };
    },

    // The page of a conversation. `item`: a list item or read()'s answer, both of which carry the
    // project. lib/sites.js reads the chat key id from /c/<id>, and from ?chat=<id> on a project
    // page, where the page shows a chat kept in a project.
    pathOf(id, item) {
      return item?.projectId ? `/project/${item.projectId}?chat=${id}` : `/c/${id}`;
    },
  };

  root.HISTORY_READERS = root.HISTORY_READERS || {};
  root.HISTORY_READERS[reader.host] = reader;
  if (typeof module !== "undefined" && module.exports) module.exports = reader;
})(typeof self !== "undefined" ? self : globalThis);
