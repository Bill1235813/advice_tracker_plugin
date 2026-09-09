// Content script: reads the conversation off the chat page and forwards snapshots to the
// background worker. Nothing is classified or uploaded here; the page only ever sees a
// serialised list of {role, content} messages.
(function () {
  const config = SITE_CONFIGS[location.hostname];
  if (!config) return;

  const SNAPSHOT_DEBOUNCE_MS = 2000;
  let lastSignature = "";
  let timer = null;

  function extractMessages() {
    const nodes = Array.from(document.querySelectorAll(config.messages));
    const messages = [];
    for (const node of nodes) {
      const content = (node.innerText || "").trim();
      if (!content) continue;
      const role = config.role(node);
      const previous = messages[messages.length - 1];
      // nested selectors can match a container and its child: keep the longer text once
      if (previous && previous.role === role && (previous.content.includes(content) || content.includes(previous.content))) {
        if (content.length > previous.content.length) previous.content = content;
        continue;
      }
      messages.push({ role, content });
    }
    return messages;
  }

  function conversationKey() {
    // chat URLs carry the conversation id (chatgpt.com/c/<id>, claude.ai/chat/<id>, ...);
    // a brand-new chat is keyed by the site until the URL updates
    return location.hostname + location.pathname;
  }

  function snapshot(reason) {
    const messages = extractMessages();
    if (!messages.some((m) => m.role === "user")) return;
    const signature = conversationKey() + "|" + messages.length + "|" + messages[messages.length - 1].content.length;
    if (signature === lastSignature && reason !== "idle") return;
    lastSignature = signature;
    chrome.runtime.sendMessage({
      type: "snapshot", reason, key: conversationKey(), site: config.name, url: location.href,
      messages, capturedAt: Date.now(),
    }).catch(() => {});
  }

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => snapshot("mutation"), SNAPSHOT_DEBOUNCE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // leaving the tab is the best available signal that the exchange is over
  document.addEventListener("visibilitychange", () => { if (document.hidden) snapshot("idle"); });
  window.addEventListener("beforeunload", () => snapshot("idle"));

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "show_rating") {
      RatingPanel.show(message.conversation, message.settings);
      sendResponse({ shown: true });
    } else if (message.type === "debug_capture") {
      sendResponse({ site: config.name, key: conversationKey(), messages: extractMessages() });
    }
    return true;
  });

  snapshot("load");
})();
