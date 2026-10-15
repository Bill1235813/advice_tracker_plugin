// In-situ rating panel (BITE-style pop-up, Fig. 2), shown on the chat page when the episode's
// rating mode asks for answers (lib/modes.js). Unless the participant confirmed the episode
// before, step 1 asks "Did you ask for advice here?", quoting the turn the judge flagged (No = a
// classifier error). Step 2 asks the three ratings and five details (all required), with the
// earlier answers filled in when they are being updated. The conversation itself is not shown here:
// the participant reviews it at the day-14 check-in, before it is stored. A second, smaller
// pop-up offers that update ("Update your ratings?") and disappears by itself; a third one, with
// no conversation text, asks about an episode from another chat site and answers in a tab.
// An open page stays current: the background sends it the episode's newer state (more turns, the
// complete reply, or a new request when the episode ended), and everything typed into it stays.
// All are rendered inside shadow roots, so the host page's CSS cannot restyle them and vice versa.
(function (root) {
  const QUOTE_CHARS = 600;
  // what the panel says, by the stage the rating mode asked at
  const INTRO = {
    first: "It looked like you asked the AI for advice here. A few quick questions about the answer so far:",
    temp: "You moved to another conversation. How was the advice so far? You can update these answers later.",
    update: "Your advice conversation continued. Change any answer that is different now:",
    final: "The topic changed, so this advice conversation has ended. Your final answers, please:",
    end: "This conversation seems to have ended. It looked like you asked the AI for advice here:",
  };

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
    textarea, select { width: 100%; box-sizing: border-box; font: inherit; padding: 6px; border: 1px solid #d9d9d3; border-radius: 6px; }
    .checks label { display: block; margin: 3px 0; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .actions button { flex: 1; padding: 8px; border-radius: 8px; border: 1px solid #d9d9d3; background: #f1f1ec; cursor: pointer; font: inherit; }
    .actions .primary { background: #4f5bd5; color: #fff; border-color: #4f5bd5; }
    .minimized .body { display: none; }
    .note { font-size: 11.5px; color: #647084; margin-top: 8px; }
    .done { color: #1e7f4f; font-weight: 600; }
    .offer { position: fixed; right: 18px; bottom: 18px; width: 330px; background: #fff; color: #1f2328;
      border: 1px solid #d9d9d3; border-left: 4px solid #4f5bd5; border-radius: 10px; padding: 12px 14px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 14px/1.4 system-ui, sans-serif; z-index: 2147483647; }
    .offer .actions { margin-top: 10px; }
    .offer .left { font-size: 11.5px; color: #647084; margin-top: 6px; }
  `;
  const waiting = [];            // pages asked for while another one was open

  function styled(host) {
    const shadow = host.attachShadow({ mode: "open" });
    // NOTE: [edge case callout] a <style> tag injected into the page would be subject to the
    // chat site's Content-Security-Policy; a constructed stylesheet adopted by the shadow root
    // is not, so the panel renders the same on every site
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
    return shadow;
  }

  function send(message) {
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  // The episode as the background sees it now (the conversation may have grown since the request
  // was made), or null if it is gone (removed meanwhile); the request's own copy if the
  // background cannot be reached.
  async function latest(episode) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "panel_episode", id: episode.id, stage: episode.stage });
      return reply ? reply.episode : episode;
    } catch (error) {
      return episode;
    }
  }

  // Show the ratings page. Returns "shown", "refreshed" (a page of this episode was open here and
  // now shows the newer request), or "queued" (another page is open; this one follows when it closes).
  function show(episode, settings) {
    const offer = document.getElementById("advice-tracker-offer");
    if (offer) offer.dispatchEvent(new CustomEvent("superseded"));      // a page replaces a pop-up
    if (refresh(episode, settings)) return "refreshed";
    if (document.getElementById("advice-tracker-host")) {
      waiting.push({ episode, settings });
      return "queued";
    }
    render(episode, settings);
    return "shown";
  }

  // A newer state of an episode whose page is open here, or waiting behind another page: the page
  // takes it in place (with no stage given, it keeps its own). Returns false when no page of
  // this episode is here.
  function refresh(episode, settings) {
    const open = document.getElementById("advice-tracker-host");
    if (open?.dataset.episode === episode.id) {
      if (!open.update(episode)) {
        // answers came in elsewhere since the page was built: it is built again, with them
        open.remove();
        render({ ...episode, stage: episode.stage || open.dataset.stage }, settings);
      }
      return true;
    }
    const queued = waiting.find((item) => item.episode.id === episode.id);
    if (queued) queued.episode = { ...episode, stage: episode.stage || queued.episode.stage };
    return Boolean(queued);
  }

  // The participant dealt with this episode in another tab: its page here goes.
  function close(id) {
    const index = waiting.findIndex((item) => item.episode.id === id);
    if (index >= 0) waiting.splice(index, 1);
    const open = document.getElementById("advice-tracker-host");
    if (open?.dataset.episode === id) open.finish(null);
  }

  function render(episode, settings) {
    const host = document.createElement("div");
    host.id = "advice-tracker-host";
    host.dataset.episode = episode.id;
    host.dataset.stage = episode.stage;
    host.dataset.end = episode.end;
    const shadow = styled(host);
    let current = episode;               // the request this page answers; host.update puts in a newer one
    const opening = episode.openingText.length > QUOTE_CHARS ? episode.openingText.slice(0, QUOTE_CHARS) + " …" : episode.openingText;
    const previous = episode.previous;
    const answered = Boolean(episode.answered);
    const questions = [...Questions.RATINGS, ...Questions.DETAILS];
    shadow.innerHTML = `
      <div class="panel">
        <div class="head"><b>${answered ? "Update your answers" : "Quick check-in"} (research study)</b>
          <button id="tab" class="tab" title="If typing here does not work, answer in a separate tab">open in a tab</button>
          <button id="min">minimize</button>
          <button id="later" title="Asks again in an hour; also listed under the extension icon" ${answered ? "hidden" : ""}>later (1 h)</button>
          <button id="close" title="${answered ? "Close; your earlier answers stay" : "Skip this conversation"}">✕</button></div>
        <div class="body">
          <div class="why"><span id="intro">${Questions.escape(INTRO[episode.stage] || INTRO.end)}</span> <span class="site">(${Questions.escape(episode.site)})</span></div>
          <div class="quote">${Questions.escape(opening)}</div>
          <div id="confirm" ${episode.confirmed ? "hidden" : ""}><span class="q"><b>Did you ask for advice here?</b></span>
            <div class="actions"><button id="no">No</button><button class="primary" id="yes">Yes</button></div></div>
          <div id="form" ${episode.confirmed ? "" : "hidden"}>
            ${Questions.render(questions)}
            <div class="actions"><button class="primary" id="submit">${answered ? "Save" : "Submit"}</button></div>
          </div>
          <div class="note">${answered ? "Your earlier answers are filled in." : `About 5 to 10 minutes now, and a short check-in in ${settings.followupDays} days.`}</div>
        </div>
      </div>`;
    Questions.fill(shadow, questions, previous);
    document.body.appendChild(host);
    // the background counts a page as asked only once it is really on the screen
    send({ type: "rating_shown", id: episode.id, end: episode.end });

    // NOTE: [edge case callout] chat apps listen for keystrokes on the whole document (claude.ai
    // routes them to its composer and swallows them), which left this panel's text boxes dead
    // on Claude. Keyboard and clipboard events are stopped at the host so the page never sees
    // them; the "open in a tab" button is the fallback for pages that capture even earlier.
    for (const type of ["keydown", "keyup", "keypress", "input", "paste", "cut", "copy", "beforeinput"]) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }

    const panel = shadow.querySelector(".panel");
    const byId = (id) => shadow.getElementById(id);

    // NOTE: [design thought] a newer state of the request (more turns, the complete reply, a new
    // stage) changes only the words around the form; the form itself is not rebuilt, so answers
    // and the cursor stay where they are. Returns false if answers came in elsewhere since this
    // page was built.
    host.update = (newer) => {
      if (newer.basedOn !== current.basedOn) return false;
      const stage = newer.stage || current.stage;
      const moved = newer.end !== current.end || stage !== current.stage;
      current = { ...newer, stage };
      host.dataset.stage = stage;
      host.dataset.end = current.end;              // the episode's last turn this page knows (tests read it)
      byId("intro").textContent = INTRO[stage] || INTRO.end;
      if (moved) send({ type: "rating_shown", id: current.id, end: current.end });
      return true;
    };
    const finish = async (message) => {
      host.remove();
      if (message) send({ ...message, id: current.id });
      // the next page waiting behind this one, as it is now (skipping episodes that are gone)
      for (let next = waiting.shift(); next; next = waiting.shift()) {
        const fresh = await latest(next.episode);
        if (fresh) { render(fresh, next.settings); break; }
      }
    };
    host.finish = finish;
    byId("tab").onclick = () => finish({ type: "open_rating_tab", stage: current.stage });
    byId("min").onclick = () => panel.classList.toggle("minimized");
    byId("later").onclick = () => finish({ type: "rating_snoozed" });
    // ✕ skips an episode that has no answers yet; with earlier answers it only closes the panel
    byId("close").onclick = () => finish({ type: answered ? "rating_closed" : "rating_dismissed", stage: current.stage });
    byId("yes").onclick = () => { byId("confirm").hidden = true; byId("form").hidden = false; };
    byId("no").onclick = () => {
      send({ type: "not_advice", id: current.id });
      host.update = () => true;          // nothing more to show about this episode
      shadow.querySelector(".body").innerHTML = '<p class="done">Thank you. This conversation was removed from the study.</p>';
      setTimeout(() => finish(null), 2500);
    };
    byId("submit").onclick = () => {
      const { answers, missing } = Questions.read(shadow, questions);
      if (missing.length) { alert("Please answer all the questions marked *."); return; }
      finish({ type: "rating_submitted", stage: current.stage, end: current.end, basedOn: current.basedOn,
               rating: { ...answers, ratedAt: Date.now() } });
    };
  }

  // A small pop-up with Yes / No that goes away by itself after settings.updateSeconds of the page
  // being visible. `onYes` runs on Yes; the background hears when it was first seen (offer_seen,
  // counted as `asked`) and the answer (yes, no, timeout, or superseded when a ratings page takes
  // its place). Returns false when something is already open.
  function popup(episode, settings, question, asked, onYes) {
    if (document.getElementById("advice-tracker-host") || document.getElementById("advice-tracker-offer")) return false;
    const host = document.createElement("div");
    host.id = "advice-tracker-offer";
    const shadow = styled(host);
    shadow.innerHTML = `
      <div class="offer"><b>Advice Tracker</b> (research study)<br>${Questions.escape(question)}
        <div class="actions"><button id="no">No</button><button class="primary" id="yes">Yes</button></div>
        <div class="left" id="left"></div></div>`;
    document.body.appendChild(host);
    let left = settings.updateSeconds, seen = false;
    const byId = (id) => shadow.getElementById(id);
    const tick = () => { byId("left").textContent = `Closes by itself in ${left} s.`; };
    const markSeen = () => {
      if (seen || document.hidden) return;
      seen = true;
      send({ type: "offer_seen", id: episode.id, end: episode.end, asked });
    };
    // NOTE: [design thought] the countdown runs only while the page is visible: a pop-up on a tab
    // in the background would otherwise vanish before anyone could see it
    const timer = setInterval(() => {
      if (document.hidden) return;
      markSeen();
      left -= 1;
      tick();
      if (left <= 0) finish("timeout");
    }, 1000);
    const finish = (answer) => {
      clearInterval(timer);
      host.remove();
      send({ type: "update_answer", id: episode.id, answer });
      if (answer === "yes") onYes();
    };
    byId("yes").onclick = () => finish("yes");
    byId("no").onclick = () => finish("no");
    host.addEventListener("superseded", () => finish("superseded"));
    tick();
    markSeen();
    return true;
  }

  // "Update your ratings?" (or "Rate this conversation now?" before any answer); Yes opens the
  // ratings page with the conversation as it is now and the earlier answers filled in.
  function offerUpdate(episode, settings) {
    const question = episode.answered ? "Your advice conversation continued. Update your ratings?"
                                      : "Rate this advice conversation now? (about 5 to 10 minutes)";
    return popup(episode, settings, question, "offer_update", async () => {
      const fresh = await latest(episode);
      if (fresh) show(fresh, settings);
    });
  }

  // An episode from another chat site: the question names the site but shows none of its text
  // (this page belongs to another company), and Yes answers in an extension tab.
  function offerTab(episode, settings) {
    const question = `About your advice conversation on ${episode.site}: ${episode.answered ? "update your ratings" : "rate it now"}? ` +
                     "It opens in a separate tab.";
    return popup(episode, settings, question, "offer_tab", () => send({ type: "open_rating_tab", id: episode.id, stage: episode.stage }));
  }

  root.RatingPanel = { show, refresh, close, offerUpdate, offerTab };
})(self);
