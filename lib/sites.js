// Per-site DOM selectors for reading the conversation off the page, and where each site keeps
// the conversation's id in its URL.
// NOTE: [edge case callout] chat UIs change their markup without notice (BITE reports the
// same); when a site stops being captured, fix its entry here and check with the
// "Show captured messages" button in the popup. Selectors are ordered user-first so
// the role check below stays simple. A URL pattern that stops matching is safe but costly:
// every page load then looks like a new chat, so a chat continued after a reload is judged
// from scratch, without its earlier turns as context.
// Attachments are recorded as tags, never as contents: "[image]" for every picture in a message
// (content/capture.js), "[file: name]" for every element matching `files` below.
// NOTE: [edge case callout] the file selectors are guesses at each site's file chips and must be
// checked on the live sites (popup -> "Show captured messages" after uploading a file).
// isNewChat: the site's page for starting a new chat. Together with a conversation id it decides
// which pages count as "a conversation" for the switching and combined rating modes (settings
// pages do not).
// generating: an element that is on the page only while the assistant is still writing (the stop
// button); a page showing it never counts as settled, so nothing is asked about a half-written
// reply, or about a "Thinking…" line that sits still for a minute.
// NOTE: [edge case callout] the stop-button selectors must be checked on the live sites too (a
// selector that never matches falls back to "2 s without changes"; one that always matches
// delays the questions by up to 5 minutes, see ASK_WAIT_MINUTES in background.js)
const FILE_CHIPS = '[data-testid*="file" i], [class*="attachment" i], [class*="file-chip" i], [class*="file-preview" i]';
const STOP_BUTTON = 'button[data-testid="stop-button"], button[aria-label*="stop" i]';

const SITE_CONFIGS = {
  "chatgpt.com": {
    name: "ChatGPT",
    messages: "[data-message-author-role]",
    role: (el) => el.getAttribute("data-message-author-role") === "user" ? "user" : "assistant",
    files: FILE_CHIPS,
    generating: STOP_BUTTON,
    conversationId: (location) => location.pathname.match(/\/c\/([\w-]+)/)?.[1],          // /c/<id>, /g/<project>/c/<id>
    isNewChat: (location) => location.pathname === "/",
  },
  "claude.ai": {
    name: "Claude",
    messages: '[data-testid="user-message"], .font-claude-message, .font-claude-response',
    role: (el) => el.matches('[data-testid="user-message"]') ? "user" : "assistant",
    files: FILE_CHIPS,
    generating: STOP_BUTTON,
    conversationId: (location) => location.pathname.match(/^\/chat\/([\w-]+)/)?.[1],     // /chat/<id>; a new chat is /new
    isNewChat: (location) => ["/new", "/"].includes(location.pathname),
  },
  "gemini.google.com": {
    name: "Gemini",
    messages: "user-query, model-response",
    role: (el) => el.tagName.toLowerCase() === "user-query" ? "user" : "assistant",
    files: FILE_CHIPS,
    generating: STOP_BUTTON,
    conversationId: (location) => location.pathname.match(/\/app\/([\w-]+)/)?.[1],       // /app/<id>, /u/1/app/<id>
    isNewChat: (location) => /^\/(u\/\d+\/)?app\/?$/.test(location.pathname),
  },
  "grok.com": {
    name: "Grok",
    messages: ".message-bubble",
    role: (el) => el.closest(".items-end") ? "user" : "assistant",
    files: FILE_CHIPS,
    generating: STOP_BUTTON,
    conversationId: (location) => location.pathname.match(/\/(?:c|chat)\/([\w-]+)/)?.[1],
    isNewChat: (location) => location.pathname === "/",
  },
  "www.perplexity.ai": {
    name: "Perplexity",
    messages: 'h1[class*="query"], div[class*="query"] > span, .prose',
    role: (el) => el.matches(".prose") ? "assistant" : "user",
    files: FILE_CHIPS,
    generating: STOP_BUTTON,
    conversationId: (location) => location.pathname.match(/^\/search\/([\w.-]+)/)?.[1],
    isNewChat: (location) => location.pathname === "/",
  },
  // test only: tests/mock_chat.html served from the laptop with `python -m http.server 8080`;
  // like ChatGPT, a new mock chat gets its id (?c=<id>) when its first turn is sent
  "localhost": {
    name: "MockChat",
    messages: "[data-message-author-role]",
    role: (el) => el.getAttribute("data-message-author-role") === "user" ? "user" : "assistant",
    files: FILE_CHIPS,
    generating: STOP_BUTTON,
    conversationId: (location) => new URLSearchParams(location.search).get("c"),
    isNewChat: (location) => !new URLSearchParams(location.search).get("c"),
  },
};

self.SITE_CONFIGS = SITE_CONFIGS;
