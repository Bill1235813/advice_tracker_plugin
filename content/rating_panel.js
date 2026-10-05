// In-situ rating panel (BITE-style pop-up, Fig. 2), shown on the chat page when an advice
// episode ends. Step 1 asks "Did you ask for advice here?", quoting the turn the judge flagged
// (No = a classifier error: the episode is deleted). Step 2 asks the three required ratings, the
// optional items and what to share. Rendered inside a shadow root so the host page's CSS cannot
// restyle it and vice versa.
(function (root) {
  const SHARE_LABEL = { full: "your answers and the conversation (names, e-mails, numbers removed)",
                        ratings: "your answers only", none: "nothing" };
  const QUOTE_CHARS = 600;

  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; right: 18px; bottom: 18px; width: 430px; max-height: 88vh; overflow: auto;
      background: #fff; color: #1f2328; border: 1px solid #d9d9d3; border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 14px/1.45 system-ui, sans-serif; z-index: 2147483647; }
    .head { padding: 12px 16px; background: #eeeffb; border-bottom: 1px solid #d9d9d3; display: flex; gap: 8px; align-items: center; }
    .head b { flex: 1; }
    .head button { border: none; background: none; cursor: pointer; font-size: 13px; color: #4f5bd5; padding: 0; }
    .head .tab { color: #647084; }
    .body { padding: 12px 16px; }
    .why { color: #647084; font-size: 13px; }
    .quote { background: #f3f4fb; border-left: 3px solid #4f5bd5; padding: 8px 12px; margin: 8px 0 12px; white-space: pre-wrap;
      font-size: 13px; max-height: 160px; overflow: auto; }
    .item { margin: 10px 0; }
    .item .q { display: block; margin-bottom: 4px; font-weight: 600; }
    .req { color: #b3403a; }
    .scale { display: flex; gap: 4px; }
    .scale label { flex: 1; text-align: center; font-size: 12px; color: #1f2328; cursor: pointer;
      padding: 4px 2px; border: 1px solid #d9d9d3; border-radius: 6px; background: #fff; }
    .scale label:hover { border-color: #4f5bd5; }
    .scale label:has(input:checked) { background: #eeeffb; border-color: #4f5bd5; color: #4f5bd5; font-weight: 600; }
    .scale input { display: block; margin: 0 auto 3px; }
    input[type=radio], input[type=checkbox], select { accent-color: #4f5bd5; }
    .optional { margin-top: 16px; padding-top: 6px; border-top: 1px solid #e4e4de; color: #647084; font-size: 12.5px; }
    .share-line { font-size: 13px; } .share-line button { border: none; background: none; color: #4f5bd5; cursor: pointer; font: inherit; }
    textarea, select { width: 100%; box-sizing: border-box; font: inherit; padding: 6px; border: 1px solid #d9d9d3; border-radius: 6px; }
    details { margin-top: 8px; } summary { cursor: pointer; color: #4f5bd5; }
    .transcript { min-height: 140px; font-size: 12px; font-family: ui-monospace, monospace; }
    .share label, .checks label { display: block; margin: 3px 0; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .actions button { flex: 1; padding: 8px; border-radius: 8px; border: 1px solid #d9d9d3; background: #f1f1ec; cursor: pointer; font: inherit; }
    .actions .primary { background: #4f5bd5; color: #fff; border-color: #4f5bd5; }
    .minimized .body { display: none; }
    .note { font-size: 11.5px; color: #647084; margin-top: 8px; }
    .done { color: #1e7f4f; font-weight: 600; }
  `;
  const waiting = [];            // episodes that ended while a panel was already open

  function show(episode, settings) {
    if (document.getElementById("advice-tracker-host")) {
      if (!waiting.some((item) => item.episode.id === episode.id)) waiting.push({ episode, settings });
      return;
    }
    const host = document.createElement("div");
    host.id = "advice-tracker-host";
    const shadow = host.attachShadow({ mode: "open" });
    const redacted = Redact.redactMessages(episode.messages, settings.redactNames || []);
    const transcriptText = redacted.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
    const redactionNote = Object.entries(redacted.counts).map(([kind, count]) => `${count} ${kind}`).join(", ");
    const opening = episode.openingText.length > QUOTE_CHARS ? episode.openingText.slice(0, QUOTE_CHARS) + " …" : episode.openingText;
    const askEachTime = settings.shareDefault === "ask";

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
          <button id="min">minimize</button>
          <button id="later" title="Reminds you in an hour; also listed under the extension icon">later (1 h)</button>
          <button id="close" title="Skip this conversation">✕</button></div>
        <div class="body">
          <div class="why">A conversation on <b>${Questions.escape(episode.site)}</b> seems to have ended. It looked like you asked the AI for advice here:</div>
          <div class="quote">${Questions.escape(opening)}</div>
          <div id="confirm"><span class="q"><b>Did you ask for advice here?</b></span>
            <div class="actions"><button id="no">No</button><button class="primary" id="yes">Yes</button></div></div>
          <div id="form" hidden>
            ${Questions.render(Questions.RATINGS)}
            <div class="optional">Optional</div>
            ${Questions.render(Questions.OPTIONAL)}
            <div class="item share">
              <div class="share-line" id="share-line" ${askEachTime ? "hidden" : ""}>
                Sharing with the research team: <b>${SHARE_LABEL[settings.shareDefault] || ""}</b> (your default)
                <button id="share-change">change for this conversation</button></div>
              <div id="share-choice" ${askEachTime ? "" : "hidden"}><span class="q">Share with the research team:</span>
                <label><input type="radio" name="share" value="full" ${settings.shareDefault === "full" ? "checked" : ""}>
                  your answers and the conversation below (names, e-mails, numbers removed)</label>
                <label><input type="radio" name="share" value="ratings" ${settings.shareDefault === "ratings" ? "checked" : ""}> your answers only</label>
                <label><input type="radio" name="share" value="none" ${settings.shareDefault === "none" ? "checked" : ""}> nothing for this conversation</label></div>
              <details><summary>Review or edit the conversation before sharing</summary>
                <div class="note">Automatically removed: ${redactionNote || "nothing detected"}. Delete anything else you do not want to share.</div>
                <textarea class="transcript" id="transcript">${Questions.escape(transcriptText)}</textarea></details></div>
            <div class="actions"><button class="primary" id="submit">Submit</button></div>
          </div>
          <div class="note">About two minutes now, and a short check-in in ${settings.followupDays} days. Skipping never affects your participation.</div>
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
    const byId = (id) => shadow.getElementById(id);
    const finish = (message) => {
      host.remove();
      if (message) chrome.runtime.sendMessage({ ...message, id: episode.id }).catch(() => {});
      const next = waiting.shift();
      if (next) show(next.episode, next.settings);
    };
    byId("tab").onclick = () => finish({ type: "open_rating_tab" });
    byId("min").onclick = () => panel.classList.toggle("minimized");
    byId("later").onclick = () => finish({ type: "rating_snoozed" });
    byId("close").onclick = () => finish({ type: "rating_dismissed" });
    byId("yes").onclick = () => { byId("confirm").hidden = true; byId("form").hidden = false; };
    byId("no").onclick = () => {
      chrome.runtime.sendMessage({ type: "not_advice", id: episode.id }).catch(() => {});
      shadow.querySelector(".body").innerHTML = '<p class="done">Thank you. This conversation was removed from the study.</p>';
      setTimeout(() => finish(null), 2500);
    };
    byId("share-change").onclick = () => { byId("share-line").hidden = true; byId("share-choice").hidden = false; };
    byId("submit").onclick = () => {
      const ratings = Questions.read(shadow, Questions.RATINGS);
      if (ratings.missing.length) { alert("Please answer the three rating questions marked *."); return; }
      const optional = Questions.read(shadow, Questions.OPTIONAL).answers;
      // NOTE: [design thought] with "ask me every time" nothing is pre-selected: the participant
      // makes the sharing choice for each conversation actively
      const share = shadow.querySelector('input[name="share"]:checked')?.value;
      if (!share) { alert("Please choose what to share with the research team."); return; }
      finish({ type: "rating_submitted", rating: { ...ratings.answers, ...optional, share, ratedAt: Date.now() },
               transcript: share === "full" ? byId("transcript").value : null });
    };
  }

  root.RatingPanel = { show };
})(self);
