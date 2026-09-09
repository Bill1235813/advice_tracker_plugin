// Per-site DOM selectors for reading the conversation off the page.
// NOTE: [edge case callout] chat UIs change their markup without notice (BITE reports the
// same); when a site stops being captured, fix its entry here and check with the
// "Show captured messages" button in the popup. Selectors are ordered user-first so
// the role check below stays simple.
const SITE_CONFIGS = {
  "chatgpt.com": {
    name: "ChatGPT",
    messages: "[data-message-author-role]",
    role: (el) => el.getAttribute("data-message-author-role") === "user" ? "user" : "assistant",
  },
  "claude.ai": {
    name: "Claude",
    messages: '[data-testid="user-message"], .font-claude-message, .font-claude-response',
    role: (el) => el.matches('[data-testid="user-message"]') ? "user" : "assistant",
  },
  "gemini.google.com": {
    name: "Gemini",
    messages: "user-query, model-response",
    role: (el) => el.tagName.toLowerCase() === "user-query" ? "user" : "assistant",
  },
  "grok.com": {
    name: "Grok",
    messages: ".message-bubble",
    role: (el) => el.closest(".items-end") ? "user" : "assistant",
  },
  "www.perplexity.ai": {
    name: "Perplexity",
    messages: 'h1[class*="query"], div[class*="query"] > span, .prose',
    role: (el) => el.matches(".prose") ? "assistant" : "user",
  },
  // test only: tests/mock_chat.html served from the laptop with `python -m http.server 8080`
  "localhost": {
    name: "MockChat",
    messages: "[data-message-author-role]",
    role: (el) => el.getAttribute("data-message-author-role") === "user" ? "user" : "assistant",
  },
};

self.SITE_CONFIGS = SITE_CONFIGS;
