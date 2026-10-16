// Per-site DOM selectors for reading the conversation off the page, and where each site keeps
// the conversation's id in its URL. content/capture.js reads, for each site:
//   turns        the elements that hold one message each (the participant's or the assistant's);
//                the outermost match counts, and hidden ones (display: none) do not
//   role(turn)   "user" or "assistant"
//   text         inside a turn, the elements that hold the message's text (if none match: the
//                whole turn), so that labels, toolbars and thinking blocks around them stay out
//   noise        what is never part of a message, inside a turn or its text: thinking blocks and
//                their summaries and timers, screen-reader-only labels ("You said:"), buttons,
//                citation chips, code-block headers
//   files        file chips in the participant's message: "[file: <name>]" (fileName(chip), when
//                given, reads the name; else the chip's title or label, else its first line)
//   images       pictures the participant uploaded: "[image]" each. Attachments are recorded as
//                tags, never as contents.
//   generating   an element that is on the page only while the assistant is still writing (the
//                stop button); a page showing it never counts as settled, so nothing is asked
//                about a half-written reply, or about a "Thinking…" line that sits still for a
//                minute. A selector that never matches falls back to "2 s without changes"; one
//                that always matches delays the questions by up to 5 minutes (ASK_WAIT_MINUTES).
//   sends        buttons that send a message without saying so (suggested follow-up questions,
//                send buttons labelled in the participant's language); optional
//   conversationId(location), isNewChat(location): see below
// The layouts below were collected in October 2026 from the sites' own code, saved pages and
// maintained exporters. Each site serves more than one layout at a time (rollouts, signed in or
// not, A/B tests), so the selectors list them newest first.
// NOTE: [edge case callout] chat UIs change their markup without notice (BITE reports the
// same); when a site stops being captured, fix its entry here and check with the
// "Show captured messages" button in the popup. Selectors use data-* attributes and semantic
// class names where they exist: labels are translated, and hashed class names change with every
// build. A URL pattern that stops matching is safe but costly: every page load then looks like a
// new chat, so a chat continued after a reload is judged from scratch, without its earlier
// turns as context.
// isNewChat: the site's pages for starting a new chat. Together with a conversation id it decides
// which pages count as "a conversation" for the switching and combined rating modes (settings
// pages do not).
const SCREEN_READER_ONLY = ".sr-only, .cdk-visually-hidden, .visually-hidden";
// KaTeX writes every formula twice: as MathML for screen readers, and as what is seen
const MATH_COPY = ".katex-mathml";

const SITE_CONFIGS = {
  "chatgpt.com": {
    name: "ChatGPT",
    // three layouts at once: the signed-in app shell of Sept 2026 (one "unit" per message, its
    // role at the end of its key, e.g. "fallback-turn-0:2:assistant"; earlier chats stay in the
    // page as hidden pages), the signed-out one at /uc/<id>, and the older one
    turns: '[data-chatgpt-search-unit-key]:not([data-app-shell-active-page="false"] *), [data-content-search-unit-key]:not([data-app-shell-active-page="false"] *), ' +
           "li[data-message-role], [data-message-author-role]",
    role: (turn) => {
      const key = turn.getAttribute("data-chatgpt-search-unit-key") || turn.getAttribute("data-content-search-unit-key");
      const role = key ? key.split(":").pop() : turn.getAttribute("data-message-role") || turn.getAttribute("data-message-author-role");
      return role === "user" ? "user" : "assistant";
    },
    text: '[data-user-message-bubble] [data-search-result-target], [data-markdown-text-style="assistant-message"], [data-markdown-copy="contents"], ' +
          "[data-user-message-copy], [data-assistant-markdown-root], [data-assistant-markdown], .markdown, .whitespace-pre-wrap",
    noise: `${SCREEN_READER_ONLY}, ${MATH_COPY}, h4[data-conversation-role], h4[data-message-attribution], [data-markdown-copy="exclude"], ` +
           'a[data-testid="chatgpt-citation"], [data-testid="webpage-citation-pill"], ' +
           '[data-d-component="popover-trigger"]:has(> [data-d-component="badge"][data-d-hoverable]), [data-prompt-link-href], ' +
           '[data-assistant-reasoning-summary], details[data-cot], [data-user-message-bubble] span[aria-hidden="true"], ' +
           'pre [class~="select-none"], .turn-action-controls, [data-message-actions], button:not(.entity-underline), ' +
           '[data-d-component="image"]:has(img[src*="purpose=inline"])',              // previews of cited web pages
    files: '[class~="group/resource-card"], [data-message-author-role="user"] .truncate.font-semibold',
    images: '[data-chatgpt-search-unit-key] img, img[data-user-image], img[alt="Uploaded image"]',
    generating: 'form[data-chatgpt-composer] button[aria-label="Stop"], form[data-chatgpt-composer] button:has(svg path[d^="M4.5 5.75"]), ' +
                '[data-talvt-turn-state="in_progress"], button[data-composer-submit][aria-label="Stop generating"], button[data-testid="stop-button"]',
    sends: 'button[class~="group/suggested-followup"]',
    // /c/<id>, /g/<project or GPT>/c/<id>, and /uc/<id> when signed out
    conversationId: (location) => location.pathname.match(/^\/(?:g\/[^/]+\/)?u?c\/([0-9a-f-]{8,})/i)?.[1],
    isNewChat: (location) => /^\/(?:g\/[^/]+(?:\/project)?\/?)?$/.test(location.pathname),       // /, a project's or a GPT's page
  },
  "claude.ai": {
    name: "Claude",
    // not turns: the previous chat kept on screen while the next one loads ([data-stale]), the
    // animated copy of a prompt just sent, and prompts queued while Claude is answering
    // (.font-claude-response, inside the assistant message, is also used by side panels: not a turn)
    turns: ['[data-cds="UserMessage"]', '[data-testid="assistant-message"]', "[data-is-streaming]", '[data-testid="user-message"]']
      .map((selector) => `${selector}:not([data-stale] *, [data-sent-bubble-preview] *, [data-testid="pending-queue-row"] *)`).join(", "),
    role: (turn) => (turn.matches('[data-cds="UserMessage"], [data-testid="user-message"]') ? "user" : "assistant"),
    text: '[data-testid="user-message"], .standard-markdown, .progressive-markdown',
    // [data-cds="TurnStatus"]: the thinking summary ("Addressing foot pain concerns ..."), shown
    // once and copied once for screen readers; [data-timeline-text]: the thinking itself, opened
    noise: `${SCREEN_READER_ONLY}, ${MATH_COPY}, .ckv-sr-only, [data-cds="TurnStatus"], [data-timeline-text], [data-cds="MessageActions"], ` +
           '[role="toolbar"], time, button, [data-cds="Icon"], .group\\/copy > .font-small, a.group\\/tag',
    files: '[data-testid="file-thumbnail"]:not([data-cds="MessageAttachmentsImage"])',
    images: '[data-cds="MessageAttachmentsImage"]',
    generating: '[data-testid="chat-input-stop"], [data-is-streaming="true"], button[aria-label="Stop response"]',
    conversationId: (location) => location.pathname.match(/^\/chat\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i)?.[1],
    isNewChat: (location) => /^\/(?:new|chat\/new|project\/[^/]+)?\/?$/.test(location.pathname),
  },
  "gemini.google.com": {
    name: "Gemini",
    // side panels (Deep Research, Canvas, thinking steps) are not part of the conversation
    turns: ["user-query", "model-response"].map((tag) => `${tag}:not(deep-research-immersive-panel *, immersive-panel *, context-sidebar *)`).join(", "),
    role: (turn) => (turn.tagName.toLowerCase() === "user-query" ? "user" : "assistant"),
    text: ".query-text, .model-response-text",
    // the prompt carries a screen-reader copy of itself ("You said" + its first 100 characters)
    noise: `${SCREEN_READER_ONLY}, ${MATH_COPY}, model-thoughts, .thoughts-container, thinking-overlay, .response-container-header, ` +
           ".code-block-decoration, source-footnote, sources-carousel-inline, source-inline-chips, source-inline-chip, .source-inline-chip-container, " +
           "sources-list, .response-footer, follow-up, .follow-up-container, elicitations, elicitations-group, mini-app, message-actions, " +
           ".table-footer, .export-sheets-button, .generated-image-controls, immersive-entry-chip, gem-processing-card, .time-estimation-message, " +
           '.luminous-actions-container, .luminous-toggle-container, .user-query-container.edit-mode, button, [role="button"], mat-icon, gem-icon',
    files: 'user-query-file-preview [data-test-id="uploaded-file"]',
    images: 'user-query-file-preview img[data-test-id="uploaded-img"], user-query-file-preview img.preview-image',
    generating: '.send-button.stop, .send-button button:has(mat-icon[fonticon="stop"]), button[aria-label="Stop response"]',
    sends: ".send-button:not(.stop) button, button.follow-up-button, .update-button button",     // Update: an edited prompt
    // /app/<id>, /u/1/app/<id>, /gem/<gem>/<id>; ids are hex (so /app/download is not a chat)
    conversationId: (location) => location.pathname.match(/^\/(?:u\/\d+\/)?(?:app|gem\/[\w-]+)\/([0-9a-f]{10,})(?:\/|$)/)?.[1],
    isNewChat: (location) => /^\/(?:u\/\d+\/)?(?:app|gem\/[\w-]+)?\/?$/.test(location.pathname),
  },
  "grok.com": {
    name: "Grok",
    // a turn is the message's row: uploads sit above the bubble, in the row
    turns: 'div[id^="response-"]:has([data-testid="user-message"], [data-testid="assistant-message"], .message-bubble)',
    role: (turn) => (turn.querySelector('[data-testid="user-message"]') ||
                     (!turn.querySelector('[data-testid="assistant-message"]') && turn.classList.contains("items-end")) ? "user" : "assistant"),
    // the thinking canvas renders its steps with the answer's class too ([data-canvas-prose])
    text: ".response-content-markdown:not([data-canvas-prose])",
    noise: `${SCREEN_READER_ONLY}, ${MATH_COPY}, .thinking-container, .message-bubble div[role="button"][aria-label], a.citation, .no-copy, ` +
           '[data-testid="code-block"] .select-none, .t-copy-label-swap, section.inline-media-container, section.auth-notification, ' +
           ".message-bubble p.text-fg-secondary.italic, .action-buttons, .order-first, button",
    files: '[class~="group/chip"]:not(:has(img, video))',
    images: '[class~="group/chip"]:has(img, video)',
    fileName: (chip) => (chip.querySelector(".truncate") || chip).textContent.trim(),        // its button's label says "Open attachment"
    generating: 'form[data-composer] button[aria-label="Stop model response"], [data-testid="canvas-working-indicator"], ' +
                'div[id^="response-"] .action-buttons.pointer-events-none:empty',
    sends: '[data-slot="follow-up-suggestions"] button, div.flex.flex-col.gap-1.mt-2.items-start.w-full > button',
    // /c/<id>; a chat in a project: /project/<id>?chat=<id>; a private chat stays at / (no id)
    conversationId: (location) => location.pathname.match(/^\/c\/([0-9a-f-]{36})/i)?.[1] ??
                                  (location.pathname.startsWith("/project/") ? new URLSearchParams(location.search).get("chat") : null),
    isNewChat: (location) => /^\/(?:c|chat)?\/?$/.test(location.pathname) ||
                             (/^\/project\/[^/]+\/?$/.test(location.pathname) && !new URLSearchParams(location.search).get("chat")),
  },
  "www.perplexity.ai": {
    name: "Perplexity",
    // one partition per sender and question (Oct 2026: the question's carries data-workflow-entry),
    // then the bubble of Sept 2026, then the query block and answer of earlier layouts
    turns: '.group\\/partition, [data-workflow-final-text], .group\\/user-bubble, .group\\/query, div[id^="markdown-content-"]',
    role: (turn) => (turn.matches('[data-workflow-entry], .group\\/user-bubble, .group\\/query') ||
                     turn.querySelector('[data-message-bubble="right"]') ? "user" : "assistant"),
    text: '.prose, [data-renderer="lm"], .select-text',
    noise: `${SCREEN_READER_ONLY}, ${MATH_COPY}, :has(> .group\\/step-header), .thought, [data-workflow-thinking-row], ` +
           "[data-pplx-citation], .citation, .citation-nbsp, [data-pplx-selection-chrome], pre figcaption, " +
           '[data-testid="code-language-indicator"], [data-testid="toggle-query-expand-button"], [data-inline-type="image"], ' +
           '[data-workflow-text-footer], [class*="group-hover/user-bubble:opacity-100"], button:not([data-asset-chip])',
    files: "[data-asset-chip]:not([data-media-kind])",
    images: '[data-asset-chip][data-media-kind="image"]',
    generating: 'button:has(use[*|href="#pplx-icon-player-stop-filled"]), button[aria-label^="Stop response" i], button[data-testid="stop-button"]',
    sends: "div.border-t.border-subtlest.pt-5 button",          // the related follow-up questions
    // /search/<slug>, and /projects/<project>/<slug>; a new chat goes / -> /search/new/<uuid> -> /search/<slug>
    conversationId: (location) => location.pathname.match(/^\/search\/(?!new(?:\/|$))([^/]+)/)?.[1] ??
                                  location.pathname.match(/^\/(?:projects|spaces)\/[^/]+\/([^/]+)/)?.[1],
    isNewChat: (location) => /^\/(?:search\/new(?:\/[^/]*)?)?\/?$/.test(location.pathname),
  },
  // test only: tests/mock_chat.html served from the laptop with `python -m http.server 8080`;
  // like ChatGPT, a new mock chat gets its id (?c=<id>) when its first turn is sent
  "localhost": {
    name: "MockChat",
    turns: "[data-message-author-role]",
    role: (turn) => (turn.getAttribute("data-message-author-role") === "user" ? "user" : "assistant"),
    noise: SCREEN_READER_ONLY,
    files: '[data-testid*="file" i]',
    images: "img",
    generating: 'button[data-testid="stop-button"]',
    conversationId: (location) => new URLSearchParams(location.search).get("c"),
    isNewChat: (location) => !new URLSearchParams(location.search).get("c"),
  },
};

// A line of the settings page's "Never capture on these sites" as a site: "https://www.Claude.ai/new"
// -> "claude.ai"
function siteOf(entry) {
  return entry.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/:?#]/)[0].replace(/^(\*\.|www\.)/, "");
}

// A site the participant excluded: its hostname, a domain it belongs to, or its bare name is on
// their list ("perplexity.ai", "www.perplexity.ai" and "perplexity" all exclude www.perplexity.ai).
// The background worker and the chat pages use the same rule; lines saved by older versions are
// read the same way.
function isExcluded(host, excludedHosts) {
  const names = host.split(".").slice(0, -1).filter((label) => label !== "www");       // www.perplexity.ai -> perplexity
  return excludedHosts.map(siteOf).some((site) => site && (host === site || host.endsWith(`.${site}`) || names.includes(site)));
}

self.SITE_CONFIGS = SITE_CONFIGS;
self.isExcluded = isExcluded;
self.siteOf = siteOf;
