// In-situ rating panel (BITE-style pop-up, Fig. 2): shown on the chat page right after a
// conversation is classified as seeking advice in a tracked domain. Rendered inside a
// shadow root so the host page's CSS cannot restyle it and vice versa.
(function (root) {
  // NOTE: [design thought] the six BITE items, reworded so each asks one distinct thing:
  // helpful = did it move your decision forward, accurate = were the facts right, relevant =
  // was it about your situation rather than generic. Keys are unchanged for comparability.
  const ITEMS = [
    ["helpful", "Helpful: did the responses move you forward on what to do?"],
    ["accurate", "Accurate: as far as you can tell, were the facts and claims correct?"],
    ["relevant", "Specific: did they address your particular situation, rather than give generic advice?"],
    ["trust", "Trust: how much do you trust the advice you were given?"],
    ["clear", "Clear: how easy were the responses to understand and follow?"],
    ["harmful", "Harmful: could following the responses have hurt you or someone else?"],
  ];
  const SHARE_LABEL = { full: "your ratings and the conversation (names, e-mails, numbers removed)",
                        ratings: "your ratings only", none: "nothing" };
  const EXTENT = ["Not at all", "Slightly", "Moderately", "Very", "Extremely"];
  const DOMAIN_LABEL = { relationships: "relationships", health: "health", career: "career or work", other: "your situation" };

  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; right: 18px; bottom: 18px; width: 420px; max-height: 88vh; overflow: auto;
      background: #fff; color: #1f2328; border: 1px solid #d9d9d3; border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 14px/1.45 system-ui, sans-serif; z-index: 2147483647; }
    .head { padding: 12px 16px; background: #eeeffb; border-bottom: 1px solid #d9d9d3; display: flex; gap: 8px; align-items: center; }
    .head b { flex: 1; }
    .head button { border: none; background: none; cursor: pointer; font-size: 13px; color: #4f5bd5; }
    .head .tab { color: #647084; }
    .body { padding: 12px 16px; }
    .why { color: #647084; font-size: 12.5px; margin-bottom: 10px; }
    .item { margin: 10px 0; }
    .item .q { display: block; margin-bottom: 4px; font-weight: 600; }
    .item .q .req { color: #b3403a; } .item .q .opt { color: #647084; font-weight: normal; font-size: 12px; }
    .scale { display: flex; gap: 4px; }
    .scale label { flex: 1; text-align: center; font-size: 12px; color: #1f2328; cursor: pointer;
      padding: 4px 2px; border: 1px solid #d9d9d3; border-radius: 6px; background: #fff; }
    .scale label:hover { border-color: #4f5bd5; }
    .scale label:has(input:checked) { background: #eeeffb; border-color: #4f5bd5; color: #4f5bd5; font-weight: 600; }
    .scale input { display: block; margin: 0 auto 3px; accent-color: #4f5bd5; }
    input[type=radio], select { accent-color: #4f5bd5; }
    .share-line { font-size: 13px; } .share-line button { border: none; background: none; color: #4f5bd5; cursor: pointer; font: inherit; }
    textarea, select, input[type=text] { width: 100%; box-sizing: border-box; font: inherit; padding: 6px; border: 1px solid #d9d9d3; border-radius: 6px; }
    textarea { min-height: 56px; }
    details { margin-top: 8px; } summary { cursor: pointer; color: #4f5bd5; }
    .transcript { min-height: 140px; font-size: 12px; font-family: ui-monospace, monospace; }
    .share label { display: block; margin: 3px 0; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .actions button { flex: 1; padding: 8px; border-radius: 8px; border: 1px solid #d9d9d3; background: #f1f1ec; cursor: pointer; font: inherit; }
    .actions .primary { background: #4f5bd5; color: #fff; border-color: #4f5bd5; }
    .minimized .body { display: none; }
    .note { font-size: 11.5px; color: #647084; margin-top: 6px; }
  `;

  function show(conversation, settings) {
    document.getElementById("advice-tracker-host")?.remove();
    const host = document.createElement("div");
    host.id = "advice-tracker-host";
    const shadow = host.attachShadow({ mode: "open" });
    const redacted = Redact.redactMessages(conversation.messages, settings.redactNames || []);
    const transcriptText = redacted.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
    const redactionNote = Object.entries(redacted.counts).map(([k, v]) => `${v} ${k}`).join(", ");

    // NOTE: [edge case callout] a <style> tag injected into the page would be subject to the
    // chat site's Content-Security-Policy; a constructed stylesheet adopted by the shadow root
    // is not, so the panel renders the same on every site
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
    shadow.innerHTML = `
      <div class="panel">
        <div class="head"><b>Quick check-in (research study)</b>
          <button id="tab" class="tab" title="If typing here does not work, answer in a separate tab">open in a tab</button>
          <button id="min">minimize</button><button id="later">later</button><button id="close">✕</button></div>
        <div class="body">
          <div class="why">This looked like a request for advice about <b>${DOMAIN_LABEL[conversation.domain] || conversation.domain}</b>.
            Two minutes of questions now, and a short follow-up in ${settings.followupDays} days. Your answers are only stored on this computer until you choose to share.</div>
          ${ITEMS.map(([key, question]) => `
            <div class="item"><span class="q">${question} <span class="req">*</span></span>
              <div class="scale">${EXTENT.map((label, i) => `<label><input type="radio" name="${key}" value="${i + 1}">${i + 1}<br>${label}</label>`).join("")}</div>
            </div>`).join("")}
          <div class="item"><span class="q">In one sentence, what decision or situation were you asking about? <span class="opt">(optional)</span></span>
            <input type="text" id="decision"></div>
          <div class="item"><span class="q">Did the assistant recommend what to do? <span class="opt">(optional)</span></span>
            <select id="advice_received"><option value="">choose…</option><option value="clear">Yes, clear advice</option>
              <option value="options">Partly - discussed options without recommending</option><option value="none">No</option></select></div>
          <div class="item"><span class="q">How likely are you to act on it in the next two weeks? <span class="opt">(optional)</span></span>
            <div class="scale">${["Very unlikely", "Unlikely", "Not sure", "Likely", "Very likely"].map((label, i) => `<label><input type="radio" name="intent" value="${i + 1}">${i + 1}<br>${label}</label>`).join("")}</div></div>
          <div class="item"><span class="q">Had you already made up your mind before asking? <span class="opt">(optional)</span></span>
            <select id="decided"><option value="">choose…</option><option value="undecided">No, genuinely undecided</option>
              <option value="leaning">Leaning one way</option><option value="decided">Mostly decided, wanted a second opinion</option>
              <option value="execute">Decided, wanted help carrying it out</option></select></div>
          <div class="item share">
            <div class="share-line" id="share-line" ${settings.shareDefault === "ask" ? "hidden" : ""}>
              Sharing with the research team: <b>${SHARE_LABEL[settings.shareDefault] || ""}</b> (your default)
              <button id="share-change">change for this conversation</button></div>
            <div id="share-choice" ${settings.shareDefault === "ask" ? "" : "hidden"}><span class="q">Share with the research team:</span>
            <label><input type="radio" name="share" value="full" ${settings.shareDefault !== "ratings" && settings.shareDefault !== "none" ? "checked" : ""}> the ratings and the conversation below (names, e-mails, numbers removed)</label>
            <label><input type="radio" name="share" value="ratings" ${settings.shareDefault === "ratings" ? "checked" : ""}> the ratings only</label>
            <label><input type="radio" name="share" value="none" ${settings.shareDefault === "none" ? "checked" : ""}> nothing for this conversation</label></div>
            <details><summary>Review or edit the conversation before sharing</summary>
              <div class="note">Automatically removed: ${redactionNote || "nothing detected"}. Delete anything else you do not want to share.</div>
              <textarea class="transcript" id="transcript">${escapeHtml(transcriptText)}</textarea></details></div>
          <div class="actions"><button id="not-advice">Not an advice request</button><button class="primary" id="submit">Submit</button></div>
          <div class="note">Skipping never affects your participation.</div>
        </div>
      </div>`;
    document.body.appendChild(host);

    // NOTE: [edge case callout] chat apps listen for keystrokes on the whole document (claude.ai
    // routes them to its composer and swallows them), which left this panel's text boxes dead
    // on Claude. Keyboard and clipboard events are stopped at the host so the page never sees
    // them; the "open in a tab" button is the fallback for pages that capture even earlier.
    for (const type of ["keydown", "keyup", "keypress", "input", "paste", "cut", "copy", "beforeinput"]) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }

    const panel = shadow.querySelector(".panel");
    shadow.getElementById("tab").onclick = () => { host.remove(); send({ type: "open_rating_tab", key: conversation.key }); };
    shadow.getElementById("share-change").onclick = () => {
      shadow.getElementById("share-line").hidden = true;
      shadow.getElementById("share-choice").hidden = false;
    };
    shadow.getElementById("min").onclick = () => panel.classList.toggle("minimized");
    shadow.getElementById("close").onclick = () => { host.remove(); send({ type: "rating_dismissed", key: conversation.key }); };
    shadow.getElementById("later").onclick = () => { host.remove(); send({ type: "rating_snoozed", key: conversation.key }); };
    shadow.getElementById("not-advice").onclick = () => { host.remove(); send({ type: "not_advice", key: conversation.key }); };
    shadow.getElementById("submit").onclick = () => {
      const ratings = {};
      for (const [key] of ITEMS) ratings[key] = valueOf(shadow, key);
      if (Object.values(ratings).some((v) => v === null)) { alert("Please answer all six rating questions."); return; }
      const share = valueOf(shadow, "share", "full");
      send({
        type: "rating_submitted", key: conversation.key,
        rating: {
          ...ratings, intent: valueOf(shadow, "intent"), decision: shadow.getElementById("decision").value.trim(),
          advice_received: shadow.getElementById("advice_received").value, decided: shadow.getElementById("decided").value,
          share, ratedAt: Date.now(),
        },
        transcript: share === "full" ? shadow.getElementById("transcript").value : null,
      });
      host.remove();
    };
  }

  function valueOf(shadow, name, fallback = null) {
    const checked = shadow.querySelector(`input[name="${name}"]:checked`);
    return checked ? (isNaN(checked.value) ? checked.value : Number(checked.value)) : fallback;
  }
  function send(message) { chrome.runtime.sendMessage(message).catch(() => {}); }
  function escapeHtml(text) { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  root.RatingPanel = { show };
})(self);
