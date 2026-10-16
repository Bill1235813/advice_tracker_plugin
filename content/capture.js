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
  const SEND_WINDOW_MS = 30000;     // a send gesture claims a user turn that appears within this time ...
  const ACTIVITY_EVERY_MS = 15000;  // while typing, at most one "activity" message per 15 s

  let conversation = null;          // {key, temporary, aliasOf, known, sent, viewed}: the chat this page shows
                                    // (known: its user turns this page showed, in order; sent: the places
                                    // among them of the turns the participant sent here)
  let sends = [];                   // send gestures not yet matched to a new user turn: {at, whileGenerating}
  let lastSignature = "";
  let timer = null, changingSince = 0, lastChange = 0, lastActivity = 0;
  let wasGenerating = false, lastGenerating = 0;   // a reply being written at the last snapshot; when one was last seen
  let trackingOff = true;           // paused, this site excluded, or no participant ID yet (the settings say)
  let lastView = { key: null, at: 0 };

  // What a message's text leaves out: the site's noise (thinking blocks, screen-reader labels,
  // buttons, ...) and attachments (they become tags)
  const SKIP = `${config.noise}, ${config.files}, ${config.images}, svg`;
  // pictures in a reply that are not content: website icons, decorations, KaTeX's drawn parts of a formula
  const ICONS = 'img[src*="favicon" i], img[class*="favicon" i], img[class*="icon" i], img[aria-hidden="true"], img[role="presentation"], ' +
                'img[inert], img.katex-svg, img[data-test-id$="file-icon"], img[src*="/32/type/"], img[src*="google_logo_icon"]';
  // an edit box in a turn of the participant's: an earlier prompt is being edited
  const EDITING = 'textarea, [contenteditable="true"][role="textbox"]:not(.cm-content), .edit-mode';

  // the elements matching `selector` inside `root` that are not inside another match: a site's
  // selector may match an element and one inside it, and each message must be read once
  function outermost(root, selector) {
    return [...root.querySelectorAll(selector)].filter((element) => {
      const outer = element.parentElement.closest(selector);
      return !outer || outer === root || !root.contains(outer);
    });
  }

  // `element` is on the page: not hidden with display: none (some sites keep earlier chats, or hidden
  // copies of a message, in the page) or visibility: hidden (Grok hides a chat while it loads, when
  // its text is not complete yet). Being off-screen does not matter. An element with
  // display: contents has no box of its own: its parent decides.
  function shown(element) {
    return element.checkVisibility({ visibilityProperty: true }) ||
           (getComputedStyle(element).display === "contents" && shown(element.parentElement));
  }

  // `element` lies inside a part of `turn` that is not the message (a thinking block, a label, ...)
  function inNoise(element, turn) {
    const noise = element.closest(config.noise);
    return Boolean(noise) && turn.contains(noise);
  }

  // The text of `root` as the page shows it, leaving out the elements that match `skip`.
  // NOTE: [design thought] this is innerText's recipe (the HTML spec's "rendered text"), read from
  // the DOM and the computed styles: spaces collapse as CSS says, a line break goes around each
  // block and two around each paragraph, hidden text is left out. innerText itself returns ""
  // for a turn the page does not render while it is off-screen (content-visibility: auto), so
  // a message's text would change as the participant scrolls; this reading does not.
  // NOTE: [performance improvement] every snapshot reads every turn again; turns that did not
  // change since the last snapshot (no mutation inside them) could keep their text
  function shownText(root, skip) {
    const items = [];            // texts {value, collapsible}, and numbers: line breaks wanted there
    (function walk(element) {
      const style = getComputedStyle(element);
      const keepsSpaces = /^pre|break-spaces/.test(style.whiteSpace), keepsLines = keepsSpaces || style.whiteSpace === "pre-line";
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (style.visibility !== "visible") continue;
          const value = keepsLines ? (keepsSpaces ? child.data : child.data.replace(/[ \t]+/g, " ")) : child.data.replace(/\s+/g, " ");
          items.push({ value, collapsible: !keepsSpaces });
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE || child.matches(skip)) continue;
        if (element.matches("details:not([open])") && child.tagName !== "SUMMARY") continue;    // a closed <details> shows its summary only
        const display = getComputedStyle(child).display;
        if (display === "none") continue;
        if (child.tagName === "BR") { items.push({ value: "\n", collapsible: false }); continue; }
        const breaks = child.tagName === "P" ? 2 : display.startsWith("inline") || display === "contents" || display === "table-cell" ? 0 : 1;
        items.push(breaks);
        walk(child);
        items.push(breaks);
        if (display === "table-cell" && child.nextElementSibling) items.push({ value: "\t", collapsible: false });
      }
    })(root);
    // NOTE: [pedagogical] where several line breaks are wanted in a row (the end of one block and
    // the start of the next), the largest number wins; at the very start and end, none
    // NOTE: [performance improvement] the text is collected in pieces and joined once: adding to
    // one long string and testing its end each time would take time quadratic in its length
    const pieces = [];
    let breaks = 0, lineStart = true;          // the text so far ends a line or a space (or is empty)
    for (const item of items) {
      if (typeof item === "number") { breaks = Math.max(breaks, item); continue; }
      let value = item.value;
      // spaces at the start of a line are not shown (nor are the spaces between two blocks)
      if (item.collapsible && (lineStart || breaks)) value = value.replace(/^ /, "");
      if (!value) continue;
      if (breaks && pieces.length) {
        // the spaces at the end of a line are not shown either
        let last = pieces.pop().replace(/ +$/, "");
        while (!last && pieces.length) last = pieces.pop().replace(/ +$/, "");
        if (last) pieces.push(last);
        pieces.push("\n".repeat(breaks));
      }
      breaks = 0;
      pieces.push(value);
      lineStart = /[\n\t ]$/.test(value);
    }
    return pieces.join("");
  }

  // the name a file chip shows: its title or label, else the first line of its text
  function fileName(chip) {
    if (config.fileName) return config.fileName(chip);
    const named = chip.matches("[title], [aria-label]") ? chip : chip.querySelector("[title], [aria-label]");
    return (named?.getAttribute("title") || named?.getAttribute("aria-label") || chip.textContent || "").trim().split("\n")[0];
  }

  // A message's text, with its attachments as tags: "[image]" per uploaded picture, "[file: name]"
  // per file chip, in the order the page shows them. Contents of attachments are never read.
  // The text is that of the turn's text parts (config.text; the whole turn if it has none),
  // without noise.
  function messageText(turn, role) {
    const parts = config.text ? outermost(turn, config.text).filter((part) => shown(part) && !inNoise(part, turn)) : [];
    const roots = parts.length ? parts : [turn];
    const tidy = (text) => text.replace(/[​⁠]/g, "").replace(/ +\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const text = roots.map((root) => tidy(shownText(root, SKIP))).filter(Boolean).join("\n\n");
    // NOTE: [edge case callout] attachments are recognised by the page's structure, not by the size
    // of a picture: a thumbnail still loading, or off-screen, has no size, and icons, avatars and
    // favicons can be large files drawn small. (An uploaded picture often sits in a button that
    // opens it: attachments are not noise.) In a reply, the pictures inside its text count.
    const tags = [];
    if (role === "user") {
      for (const attachment of outermost(turn, `${config.files}, ${config.images}`)) {
        tags.push(attachment.matches(config.images) ? "[image]" : `[file: ${fileName(attachment)}]`);
      }
    } else {
      for (const root of parts) {
        for (const image of root.querySelectorAll("img")) if (!image.matches(ICONS) && !inNoise(image, turn)) tags.push("[image]");
      }
    }
    return [...tags, text].filter(Boolean).join("\n");
  }

  // The conversation as {role, content} messages. A reply split over several elements (text before
  // and after a thinking block or a tool call) is one message. Null while an earlier prompt is being
  // edited: its text is not on the page then, and reading it as gone would end its episode.
  function extractMessages() {
    const messages = [];
    for (const turn of outermost(document, config.turns).filter(shown)) {
      const role = config.role(turn);
      if (role === "user" && turn.querySelector(EDITING)) return null;
      const content = messageText(turn, role);
      const previous = messages[messages.length - 1];
      if (!content) continue;
      if (role === "assistant" && previous?.role === "assistant") previous.content += `\n\n${content}`;
      else messages.push({ role, content });
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
      // user turns than this page showed or sent here; otherwise a stray Enter on the new-chat
      // page, followed by opening an old chat, would make that old chat an alias and its last turn
      // "sent" (opening a chat from a link also drops pending gestures). With no turns on the page
      // yet (still rendering) the next snapshot decides.
      const onPage = userTurns ?? (extractMessages() || []).filter((m) => m.role === "user").length;
      if (onPage === 0) return;
      if (onPage <= conversation.known.length + sends.length) {
        conversation = { ...conversation, key: urlKey, temporary: false, aliasOf: conversation.key };
        if (!conversation.viewed) reportView();
        return;
      }
    }
    // a different chat: opened from the sidebar, or a new one started
    startConversation(urlKey);
    sends = [];
  }

  function startConversation(urlKey) {
    conversation = { key: urlKey || `${location.hostname}/new-${Date.now().toString(36)}`, temporary: !urlKey,
                     aliasOf: null, known: [], sent: new Set(), viewed: false };
    reportView();
  }

  // the assistant is still writing: the site's stop button (or a similar sign) is on the page, and
  // not in a part of it that is hidden (ChatGPT keeps earlier chats as hidden pages)
  function isGenerating() {
    return [...document.querySelectorAll(config.generating)].some(shown);
  }

  // NOTE: [edge case callout] after the extension is reloaded or updated, this script stays in the
  // open page but is cut off from it (chrome.runtime.id is gone, and sending throws): it stops
  // watching the page then; a reload of the page brings the new one
  function connected() {
    if (chrome.runtime?.id) return true;
    observer.disconnect();
    return false;
  }

  function notify(type) {
    if (!connected()) return;
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
    if (!messages) return;            // an edit box is open; closing it changes the page, and a snapshot follows
    const userTurns = messages.filter((m) => m.role === "user").map((m) => m.content);
    followConversation(userTurns.length);
    // NOTE: [design thought] user turns new to this page (below the turns it showed before) are
    // matched with recent send gestures, newest first. Turns left without a gesture are history:
    // a past chat rendering, or older messages loading above (lib/episodes.js, placeTurns).
    const now = Date.now();
    const generating = isGenerating();
    // a reply that ended since the last snapshot (its stop button went) ended by now: a page can
    // sit still for a long time while the assistant thinks, so nothing was snapshot meanwhile
    if (generating || wasGenerating) lastGenerating = now;
    wasGenerating = generating;
    // ... or, for a message sent while a reply was still being written, within this time after the
    // reply ended: Claude, Grok and Perplexity queue such a message and show it only then
    sends = sends.filter((send) => now - (send.whileGenerating ? Math.max(send.at, lastGenerating) : send.at) < SEND_WINDOW_MS);
    let placed = Episodes.placeTurns(conversation.known, userTurns);
    if (placed.at < 0 && userTurns.length && (conversation.temporary || conversation.aliasOf)) {
      // a chat without an id of its own yet, or one that just got it: turns that do not line up with
      // this page's turns at all are a new chat (Grok's private chats stay at "/"), or its first turns
      // (the gestures of its first messages stay)
      if (conversation.temporary) startConversation(null);
      else conversation = { ...conversation, known: [], sent: new Set() };
      placed = Episodes.placeTurns([], userTurns);
    }
    // the places of the turns sent here move with older turns loaded above; an edit replaces turns
    if (placed.above) conversation.sent = new Set([...conversation.sent].map((at) => at + placed.above));
    if (placed.editedFrom !== null) conversation.sent = new Set([...conversation.sent].filter((at) => at < placed.editedFrom));
    conversation.known = placed.known;
    const claimed = Math.min(placed.fresh, sends.length), end = placed.at + userTurns.length;
    for (let at = end - claimed; at < end; at++) conversation.sent.add(at);
    sends.splice(0, claimed);
    // the background lines up the page's turns with its stored copy by their ids (this page's
    // numbering): the ids of the turns on the page that were sent here
    const ids = Episodes.turnIds(userTurns);
    const sentHere = placed.at < 0 ? [] : ids.filter((id, k) => conversation.sent.has(placed.at + k));

    if (!userTurns.length) return;
    // NOTE: [design thought] "settled": the page has been still for the settle time and shows no
    // sign of a reply still being written (the site's stop button, lib/sites.js), so a reply on
    // it is complete. Stillness alone is not enough: a "Thinking…" line can sit unchanged for a
    // minute. The background waits for a settled page before asking about the answer just
    // given; the 10 s cap also takes snapshots of replies still being written.
    const settled = now - lastChange >= SETTLE_MS - 50 && !generating;
    const length = messages.reduce((total, m) => total + m.content.length, 0);
    const signature = `${conversation.key}|${messages.length}|${length}|${conversation.sent.size}|${settled}`;
    if (signature === lastSignature || !connected()) return;
    lastSignature = signature;
    chrome.runtime.sendMessage({
      type: "snapshot", key: conversation.key, aliasOf: conversation.aliasOf, site: config.name, url: location.href,
      messages, sent: sentHere, settled, capturedAt: now,
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
    if (trackingOff) return;
    followConversation();
    sends.push({ at: Date.now(), whileGenerating: isGenerating() });
    lastActivity = 0;               // a send always counts as activity
    reportActivity();
  }
  // chat composers are text areas or editable divs; one-line inputs are search and rename boxes
  function isEditable(element) {
    return element.isContentEditable || element.tagName === "TEXTAREA";
  }
  document.addEventListener("keydown", (event) => {
    if (!isEditable(event.target)) return;
    // a reply's code block can be an editor (ChatGPT): typing there is not writing a message
    const turn = event.target.closest(config.turns);
    if (turn && config.role(turn) === "assistant") return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) recordSend();
    else reportActivity();
  }, true);
  // NOTE: [edge case callout] some buttons send without saying so: a suggested follow-up question,
  // or a send button labelled in the participant's language (config.sends)
  document.addEventListener("click", (event) => {
    // opening another chat (a link in the sidebar): a gesture that sent nothing must not claim its turns
    const link = event.target.closest?.("a[href]");
    if (link && config.conversationId(new URL(link.href)) !== config.conversationId(location)) sends = [];
    const button = event.target.closest?.("button");
    if (!button || button.matches(config.generating) || button.closest(config.generating)) return;    // Stop is not a send
    const label = ["aria-label", "data-testid", "id", "title", "type"].map((name) => button.getAttribute(name) || "").join(" ");
    if (/send|submit/i.test(label) || (config.sends && button.matches(config.sends))) recordSend();
  }, true);

  // leaving the tab: capture the last state now rather than after the debounce; coming back to
  // it: the page shows this conversation again
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) snapshot();
    else { followConversation(); reportView(); }
  });
  // moving between two windows that are both visible changes no visibility, only the focus
  window.addEventListener("focus", () => { followConversation(); reportView(); });
  // back or forward to another page of the site: pending gestures belong to the page left
  window.addEventListener("popstate", () => { sends = []; });

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
                     sent: conversation.sent.size, messages: extractMessages() || [] });
    }
  });

  // NOTE: [design thought] a message sent while tracking is off is never captured, not even once
  // tracking is back on: no send gesture is recorded meanwhile, and turning tracking off forgets
  // the turns sent here before (the background keeps those it already stored)
  function followSettings(settings = {}) {
    trackingOff = !settings.participantId || Boolean(settings.paused) || isExcluded(location.hostname, settings.excludedHosts || []);
    if (!trackingOff) return;
    conversation?.sent.clear();
    sends = [];
  }
  chrome.storage.local.get("settings").then(({ settings }) => followSettings(settings));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) followSettings(changes.settings.newValue);
  });

  snapshot();          // also reports the first view: the conversation is new to this page
})();
