// Content script: reads the conversation off the chat page and forwards snapshots to the
// background worker. Nothing is judged or uploaded here; the page only ever sees a serialised
// list of {role, content} messages.
//
// Besides the messages, a snapshot lists which user turns the participant was seen SENDING on
// this page: a turn that appears shortly after Enter or a Send button was pressed. Only those
// turns are ever judged, so opening a past chat never sends its history anywhere.
// Two small signals serve the rating modes (lib/modes.js): "view" when the page starts showing a
// conversation (switching and combined modes: moving to another conversation), and "activity"
// while the participant types (periodical and combined modes: pauses). Neither carries any text.
(function () {
  const config = SITE_CONFIGS[location.hostname];
  if (!config) return;

  const SETTLE_MS = 2000;           // snapshot once the page has been still for this long ...
  const MAX_WAIT_MS = 10000;        // ... or at the latest this long after it started changing
  const SEND_WINDOW_MS = 30000;     // a send gesture claims a user turn that appears within this time
  const ACTIVITY_EVERY_MS = 15000;  // while typing, at most one "activity" message per 15 s

  let conversation = null;          // {key, temporary, aliasOf, seen, sent, viewed}: the chat this page shows
  let sends = [];                   // times of send gestures not yet matched to a new user turn
  let lastSignature = "";
  let timer = null, changingSince = 0, lastChange = 0, lastActivity = 0;
  let lastView = { key: null, at: 0 };

  // A message's text, with its attachments as tags: "[image]" per picture, "[file: name]" per file
  // chip (the chip's visible text is its name). Contents of attachments are never read.
  function messageText(node) {
    let text = (node.innerText || "").trim();
    const tags = [];
    for (const chip of node.querySelectorAll(config.files)) {
      const name = (chip.getAttribute("title") || chip.innerText || "").trim().split("\n")[0];
      if (!name || tags.includes(`[file: ${name}]`)) continue;
      tags.push(`[file: ${name}]`);
      text = text.replace(chip.innerText.trim(), "").trim();      // the name now lives in the tag
    }
    // NOTE: [edge case callout] small images are icons and avatars, not uploads
    for (const image of node.querySelectorAll("img")) {
      if (image.closest(config.files)) continue;
      if (image.width >= 48 || image.height >= 48 || image.naturalWidth >= 48) tags.push("[image]");
    }
    return [...tags, text].filter(Boolean).join("\n");
  }

  function extractMessages() {
    const messages = [];
    for (const node of document.querySelectorAll(config.messages)) {
      const content = messageText(node);
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
  // `userTurns`, when known: the number of user turns the page shows now.
  function followConversation(userTurns = null) {
    const id = config.conversationId(location);
    const urlKey = id ? `${location.hostname}/${id}` : null;
    if (conversation && (urlKey ? urlKey === conversation.key : conversation.temporary)) {
      // e.g. a library or settings page first (not a conversation), then the new-chat page
      if (!conversation.viewed) reportView();
      return;
    }
    if (conversation?.temporary && urlKey && (conversation.sent.size || sends.length)) {
      // NOTE: [edge case callout] the new id names the same chat only if the page shows no more
      // user turns than were seen or sent here; otherwise a stray Enter on the new-chat page,
      // followed by opening an old chat, would make that old chat an alias and its last turn
      // "sent". With no turns on the page yet (still rendering) the next snapshot decides.
      const shown = userTurns ?? extractMessages().filter((m) => m.role === "user").length;
      if (shown === 0) return;
      if (shown <= conversation.seen.size + sends.length) {
        conversation = { ...conversation, key: urlKey, temporary: false, aliasOf: conversation.key };
        if (!conversation.viewed) reportView();
        return;
      }
    }
    // a different chat: opened from the sidebar, or a new one started
    conversation = { key: urlKey || `${location.hostname}/new-${Date.now().toString(36)}`, temporary: !urlKey,
                     aliasOf: null, seen: new Set(), sent: new Set(), viewed: false };
    sends = [];
    reportView();
  }

  function notify(type) {
    chrome.runtime.sendMessage({ type, key: conversation.key, aliasOf: conversation.aliasOf, site: config.name,
                                 url: location.href }).catch(() => {});
  }
  // the page shows this conversation now (it was opened, started, its tab or window came to the
  // front); settings and other pages of the site are not conversations
  function reportView() {
    const conversationPage = config.conversationId(location) || config.isNewChat(location);
    if (document.hidden || !conversationPage) return;
    conversation.viewed = true;
    // a tab coming to the front fires two events (visibility, then window focus): one view
    const now = Date.now();
    if (lastView.key === conversation.key && now - lastView.at < 1000) return;
    lastView = { key: conversation.key, at: now };
    notify("view");
  }
  // the participant is typing in this conversation
  function reportActivity() {
    const now = Date.now();
    if (now - lastActivity < ACTIVITY_EVERY_MS) return;
    lastActivity = now;
    followConversation();
    notify("activity");
  }

  function snapshot() {
    clearTimeout(timer);
    timer = null;
    changingSince = 0;
    const messages = extractMessages();
    const userTurns = messages.filter((m) => m.role === "user").map((m) => m.content);
    followConversation(userTurns.length);
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
    // NOTE: [design thought] "settled": the page has been still for the settle time and shows no
    // sign of a reply still being written (the site's stop button, lib/sites.js), so a reply on
    // it is complete. Stillness alone is not enough: a "Thinking…" line can sit unchanged for a
    // minute. The background waits for a settled page before asking about the answer just
    // given; the 10 s cap also takes snapshots of replies still being written.
    const generating = Boolean(config.generating && document.querySelector(config.generating));
    const settled = now - lastChange >= SETTLE_MS - 50 && !generating;
    const length = messages.reduce((total, m) => total + m.content.length, 0);
    const signature = `${conversation.key}|${messages.length}|${length}|${conversation.sent.size}|${settled}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    chrome.runtime.sendMessage({
      type: "snapshot", key: conversation.key, aliasOf: conversation.aliasOf, site: config.name, url: location.href,
      messages, sent: [...conversation.sent], settled, capturedAt: now,
    }).catch(() => {});
  }

  // NOTE: [pedagogical] a debounce with a cap: every change restarts the 2 s timer, so a reply
  // that is still streaming is captured once it is complete, but at least every 10 s
  const observer = new MutationObserver(() => {
    const now = Date.now();
    lastChange = now;
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
    lastActivity = 0;               // a send always counts as activity
    reportActivity();
  }
  // chat composers are text areas or editable divs; one-line inputs are search and rename boxes
  function isEditable(element) {
    return element.isContentEditable || element.tagName === "TEXTAREA";
  }
  document.addEventListener("keydown", (event) => {
    if (!isEditable(event.target)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) recordSend();
    else reportActivity();
  }, true);
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("button");
    if (!button) return;
    const label = ["aria-label", "data-testid", "id", "title", "type"].map((name) => button.getAttribute(name) || "").join(" ");
    if (/send|submit/i.test(label)) recordSend();
  }, true);

  // leaving the tab: capture the last state now rather than after the debounce; coming back to
  // it: the page shows this conversation again
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) snapshot();
    else { followConversation(); reportView(); }
  });
  // moving between two windows that are both visible changes no visibility, only the focus
  window.addEventListener("focus", () => { followConversation(); reportView(); });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (["show_panel", "offer_update", "offer_confirm", "refresh_panel"].includes(message.type)) {
      // NOTE: [design thought] a conversation from another chat site is never put into this
      // page: the page's own scripts could read it (the background sends offer_tab instead)
      if (message.episode.site !== config.name) { sendResponse({ shown: false, refreshed: false }); return; }
      if (message.type === "refresh_panel") {
        sendResponse({ refreshed: RatingPanel.refresh(message.episode, message.settings) });
        return;
      }
      const offer = message.type === "offer_confirm" ? RatingPanel.offerConfirm : RatingPanel.offerUpdate;
      const result = message.type === "show_panel" ? RatingPanel.show(message.episode, message.settings)
                                                   : (offer(message.episode, message.settings) ? "shown" : "busy");
      sendResponse({ shown: result === "shown" || result === "refreshed", refreshed: result === "refreshed",
                     queued: result === "queued", busy: result === "busy" });
    } else if (message.type === "offer_tab") {
      sendResponse(RatingPanel.offerTab(message.episode, message.settings) ? { shown: true } : { busy: true });
    } else if (message.type === "close_panel") {
      RatingPanel.close(message.id);
    } else if (message.type === "forget") {
      // "delete all data": the turns sent on this page so far are history from now on
      conversation?.sent.clear();
      sends = [];
    } else if (message.type === "debug_capture") {
      followConversation();
      sendResponse({ site: config.name, key: conversation.key, aliasOf: conversation.aliasOf,
                     sent: conversation.sent.size, messages: extractMessages() });
    }
  });

  snapshot();          // also reports the first view: the conversation is new to this page
})();
