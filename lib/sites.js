// Per-site DOM selectors for reading the conversation off the page, and where each site keeps
// the conversation's id in its URL.
// NOTE: [edge case callout] chat UIs change their markup without notice (BITE reports the
// same); when a site stops being captured, fix its entry here and check with the
// "Show captured messages" button in the popup. Selectors are ordered user-first so
// the role check below stays simple. A URL pattern that stops matching is safe but costly:
// every page load then looks like a new chat, so a chat continued after a reload is judged
// from scratch, without its earlier turns as context.
const SITE_CONFIGS = {
  "chatgpt.com": {
    name: "ChatGPT",
    messages: "[data-message-author-role]",
    role: (el) => el.getAttribute("data-message-author-role") === "user" ? "user" : "assistant",
    conversationId: (location) => location.pathname.match(/\/c\/([\w-]+)/)?.[1],          // /c/<id>, /g/<project>/c/<id>
  },
  "claude.ai": {
    name: "Claude",
    messages: '[data-testid="user-message"], .font-claude-message, .font-claude-response',
    role: (el) => el.matches('[data-testid="user-message"]') ? "user" : "assistant",
    conversationId: (location) => location.pathname.match(/^\/chat\/([\w-]+)/)?.[1],     // /chat/<id>; a new chat is /new
  },
  "gemini.google.com": {
    name: "Gemini",
    messages: "user-query, model-response",
    role: (el) => el.tagName.toLowerCase() === "user-query" ? "user" : "assistant",
    conversationId: (location) => location.pathname.match(/\/app\/([\w-]+)/)?.[1],       // /app/<id>, /u/1/app/<id>
  },
  "grok.com": {
    name: "Grok",
    messages: ".message-bubble",
    role: (el) => el.closest(".items-end") ? "user" : "assistant",
    conversationId: (location) => location.pathname.match(/\/(?:c|chat)\/([\w-]+)/)?.[1],
  },
  "www.perplexity.ai": {
    name: "Perplexity",
    messages: 'h1[class*="query"], div[class*="query"] > span, .prose',
    role: (el) => el.matches(".prose") ? "assistant" : "user",
    conversationId: (location) => location.pathname.match(/^\/search\/([\w.-]+)/)?.[1],
  },
  // test only: tests/mock_chat.html served from the laptop with `python -m http.server 8080`;
  // like ChatGPT, a new mock chat gets its id (?c=<id>) when its first turn is sent
  "localhost": {
    name: "MockChat",
    messages: "[data-message-author-role]",
    role: (el) => el.getAttribute("data-message-author-role") === "user" ? "user" : "assistant",
    conversationId: (location) => new URLSearchParams(location.search).get("c"),
  },
};

self.SITE_CONFIGS = SITE_CONFIGS;
