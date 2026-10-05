// Content script: reads the conversation off the chat page and forwards snapshots to the
// background worker. Nothing is judged or uploaded here; the page only ever sees a serialised
// list of {role, content} messages.
//
// Besides the messages, a snapshot lists which user turns the participant was seen SENDING on
// this page: a turn that appears shortly after Enter or a Send button was pressed. Only those
// turns are ever judged, so opening a past chat never sends its history anywhere.
(function () {
  const config = SITE_CONFIGS[location.hostname];
  if (!config) return;

  const SETTLE_MS = 2000;           // snapshot once the page has been still for this long ...
  const MAX_WAIT_MS = 10000;        // ... or at the latest this long after it started changing
  const SEND_WINDOW_MS = 120000;    // a send gesture claims a user turn that appears within this time

  let conversation = null;          // {key, temporary, aliasOf, seen, sent}: the chat this page shows
  let sends = [];                   // times of send gestures not yet matched to a new user turn
  let lastSignature = "";
  let timer = null, changingSince = 0;

  function extractMessages() {
    const messages = [];
    for (const node of document.querySelectorAll(config.messages)) {
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

  // Which chat the page shows. Chat URLs carry the conversation's id (chatgpt.com/c/<id>), except
  // a brand-new chat, which gets its id only when its first turn is sent. Until then it has a
  // temporary key; when the URL gains an id right after a send, it is the same chat, and the
  // snapshot tells the background that the new key is an alias of the temporary one.
  function followConversation() {
    const id = config.conversationId(location);
    const urlKey = id ? `${location.hostname}/${id}` : null;
    if (conversation && (urlKey ? urlKey === conversation.key : conversation.temporary)) return;
    if (conversation && conversation.temporary && urlKey && (conversation.sent.size || sends.length)) {
      conversation = { ...conversation, key: urlKey, temporary: false, aliasOf: conversation.key };
      return;
    }
    // a different chat: opened from the sidebar, or a new one started
    conversation = { key: urlKey || `${location.hostname}/new-${Date.now().toString(36)}`, temporary: !urlKey,
                     aliasOf: null, seen: new Set(), sent: new Set() };
    sends = [];
  }

  function snapshot() {
    clearTimeout(timer);
    timer = null;
    changingSince = 0;
    followConversation();
    const messages = extractMessages();
    const userTurns = messages.filter((m) => m.role === "user").map((m) => m.content);
    // NOTE: [design thought] user turns not seen before on this page are matched with recent send
    // gestures, newest first (new turns appear at the bottom). Turns left without a gesture are
    // history: a past chat rendering, or older messages loading above.
    const now = Date.now();
    sends = sends.filter((time) => now - time < SEND_WINDOW_MS);
    const fresh = Episodes.turnIds(userTurns).filter((id) => !conversation.seen.has(id));
    const claimed = Math.min(fresh.length, sends.length);
    for (const id of fresh.slice(fresh.length - claimed)) conversation.sent.add(id);
    sends.splice(0, claimed);
    for (const id of fresh) conversation.seen.add(id);

    if (!userTurns.length) return;
    const length = messages.reduce((total, m) => total + m.content.length, 0);
    const signature = `${conversation.key}|${messages.length}|${length}|${conversation.sent.size}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    chrome.runtime.sendMessage({
      type: "snapshot", key: conversation.key, aliasOf: conversation.aliasOf, site: config.name, url: location.href,
      messages, sent: [...conversation.sent], capturedAt: now,
    }).catch(() => {});
  }

  // NOTE: [pedagogical] a debounce with a cap: every change restarts the 2 s timer, so a reply
  // that is still streaming is captured once it is complete, but at least every 10 s
  const observer = new MutationObserver(() => {
    const now = Date.now();
    changingSince = changingSince || now;
    clearTimeout(timer);
    timer = setTimeout(snapshot, Math.max(0, Math.min(SETTLE_MS, changingSince + MAX_WAIT_MS - now)));
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // send gestures: Enter in a text box (Shift+Enter is a new line), or a button labelled send/submit.
  // NOTE: [edge case callout] the page may have switched chats since the last snapshot ("New chat",
  // then a quick question): follow it first, so the gesture is credited to the chat it was made in
  function recordSend() {
    followConversation();
    sends.push(Date.now());
  }
  function isEditable(element) {
    return element.isContentEditable || element.tagName === "TEXTAREA" || (element.tagName === "INPUT" && element.type === "text");
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && isEditable(event.target)) recordSend();
  }, true);
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("button");
    if (!button) return;
    const label = ["aria-label", "data-testid", "id", "title", "type"].map((name) => button.getAttribute(name) || "").join(" ");
    if (/send|submit/i.test(label)) recordSend();
  }, true);

  // leaving the tab: capture the last state now rather than after the debounce
  document.addEventListener("visibilitychange", () => { if (document.hidden) snapshot(); });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "show_panel") {
      RatingPanel.show(message.episode, message.settings);
      sendResponse({ shown: true });
    } else if (message.type === "debug_capture") {
      followConversation();
      sendResponse({ site: config.name, key: conversation.key, aliasOf: conversation.aliasOf,
                     sent: conversation.sent.size, messages: extractMessages() });
    }
  });

  snapshot();
})();
