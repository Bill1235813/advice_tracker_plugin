// In-situ rating panel (BITE-style pop-up, Fig. 2), shown on the chat page when the episode's
// rating mode asks for answers (lib/modes.js). Unless the participant confirmed the episode
// before, step 1 asks "Did you ask for advice here?", quoting the turn the judge flagged (No = a
// classifier error). Step 2 asks the three ratings and five details (all required), with the
// earlier answers filled in when they are being updated; the answers are uploaded with the
// conversation they are about, redacted (background.js). A conversation cannot be skipped: without
// answers the panel has no ✕, only "later (1 h)" and No. A second, smaller
// pop-up offers that update ("Update your ratings?") and disappears by itself; a third one, with
// no conversation text, asks about an episode from another chat site and answers in a tab; a
// fourth one (combined mode) asks only step 1, quoting the request, right after the first advice
// turn, and also disappears by itself (after Yes, the ratings page later starts at step 2). A fifth
// one (0.6.9) is the follow-up about a conversation from a week or more ago: did you decide, did you
// act, and then the way to its outcome questions, or "too early to tell" (offerFollowup). A sixth one
// (0.6.15) is not a question: a message from the study team, in a window of its own at the top right
// (showMessage).
// An open page stays current: the background sends it the episode's newer state (more turns, the
// complete reply, or a new request when the episode ended), and everything typed into it stays.
// All are rendered inside shadow roots, so the host page's CSS cannot restyle them and vice versa.
(function (root) {
  const QUOTE_CHARS = 600;
  // what the panel says, by the stage the rating mode asked at
  const INTRO = {
    first: "It looked like you asked the AI for advice here. A few quick questions about the answer so far:",
    temp: "You moved to another conversation. How was the advice so far? You can update these answers later.",
    update: "Your advice conversation continued. Please update any answer that is different now:",
    final: "The topic changed, so this advice conversation has ended. Your final answers, please:",
    end: "This conversation seems to have ended. It looked like you asked the AI for advice here:",
    // the final page of an episode that a week after its first request is complete (closedBy "cut")
    cut: "A week has passed since you first asked, so this advice conversation is now complete. Your final answers, please:",
  };
  const introOf = (stage, episode) => (stage === "final" && episode.closedBy === "cut" ? INTRO.cut : INTRO[stage] || INTRO.end);

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
    .whatis { color: #4f5bd5; font-weight: normal; font-size: 12px; text-decoration: underline; cursor: pointer; margin-left: 4px; }
    .req { color: #b3403a; }
    .item.na { opacity: .45; } .item.na .req { visibility: hidden; }
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
    .followup .bar { display: flex; gap: 8px; align-items: baseline; }
    .followup .bar .state { flex: 1; font-size: 11.5px; color: #647084; }
    .followup .bar button { border: none; background: none; cursor: pointer; font: inherit; font-size: 12.5px; color: #4f5bd5; padding: 0; }
    .followup .body { margin-top: 6px; }
    .followup.minimized { width: auto; max-width: 330px; padding: 6px 12px; }
    .followup.minimized .body { display: none; }
    .followup select { margin-top: 6px; }
    .followup a { color: #4f5bd5; }
    .offer.message { top: 18px; bottom: auto; width: 360px; }
    .message .text { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 6px; max-height: 45vh; overflow: auto; }
  `;
  const waiting = [];            // pages asked for while another one was open
  // NOTE: [edge case callout] the extension was updated or reloaded while a page or pop-up was open:
  // nothing can be sent from it any more, so it says so instead of vanishing with the answer.
  // Reloading the page does not bring it back; questions that still wait for an answer are listed
  // under the extension icon (a confirm question also comes back with the ratings page, an update
  // offer when the conversation goes on).
  const UPDATED = "Advice Tracker was updated meanwhile, so this could not be sent. Please reload this page. " +
                  "Questions that still wait for an answer are listed under the Advice Tracker icon → <b>Quick check-ins</b> and <b>Outcomes</b>.";

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

  // NOTE: [edge case callout] after the extension is reloaded or updated, the scripts already in the
  // page are cut off from it (chrome.runtime.id is gone and sending throws): nothing is sent then
  function send(message) {
    if (chrome.runtime?.id) chrome.runtime.sendMessage(message).catch(() => {});
  }

  // the request as it is quoted
  function shortened(text) {
    return text.length > QUOTE_CHARS ? text.slice(0, QUOTE_CHARS) + " …" : text;
  }

  // The episode as the background sees it now (the conversation may have grown since the request
  // was made), or null if it is gone (removed meanwhile) or no longer due (answered meanwhile with
  // nothing new since: lib/modes.js stillDue; `waited`: a page that waited behind another one, held
  // to waitedDue); the request's own copy if the background cannot be reached.
  async function latest(episode, waited = false) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "panel_episode", id: episode.id, stage: episode.stage, waited });
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

  // The participant dealt with this episode elsewhere: its pop-up here goes, unanswered.
  function closeOffer(id) {
    const offer = document.getElementById("advice-tracker-offer");
    if (offer?.dataset.episode === id) offer.withdraw();
  }

  // The participant dealt with this episode in another tab: its page here goes.
  function close(id) {
    const index = waiting.findIndex((item) => item.episode.id === id);
    if (index >= 0) waiting.splice(index, 1);
    const open = document.getElementById("advice-tracker-host");
    if (open?.dataset.episode === id) open.finish(null);
  }

  // The follow-up pop-up, or its minimized bar, goes (with its countdown)
  function dismissFollowup() {
    document.getElementById("advice-tracker-followup")?.dismiss();
  }

  function render(episode, settings) {
    dismissFollowup();                       // (a page replaces the follow-up pop-up)
    const host = document.createElement("div");
    host.id = "advice-tracker-host";
    host.dataset.episode = episode.id;
    host.dataset.stage = episode.stage;
    host.dataset.end = episode.end;
    const shadow = styled(host);
    let current = episode;               // the request this page answers; host.update puts in a newer one
    const opening = shortened(episode.openingText);
    const previous = episode.previous;
    const answered = Boolean(episode.answered);
    const questions = [...Questions.RATINGS, ...Questions.DETAILS];
    shadow.innerHTML = `
      <div class="panel">
        <div class="head"><b>${answered ? "Update your answers" : "Quick check-in"} (research study)</b>
          <button id="tab" class="tab" title="If typing here does not work, answer in a separate tab">open in a tab</button>
          <button id="min">minimize</button>
          <button id="later" title="Asks again in an hour; also listed under the extension icon" ${answered ? "hidden" : ""}>later (1 h)</button>
          <button id="close" title="Close; your earlier answers stay" ${answered ? "" : "hidden"}>✕</button></div>
        <div class="body">
          <div class="why"><span id="intro">${Questions.escape(introOf(episode.stage, episode))}</span> <span class="site">(${Questions.escape(episode.site)})</span>
            <a href="#" id="whatis" class="whatis">what counts as advice?</a></div>
          <div class="quote">${Questions.escape(opening)}</div>
          <div id="confirm" ${episode.confirmed ? "hidden" : ""}><span class="q"><b>Did you ask for advice here?</b></span>
            <div class="actions"><button id="no">No</button><button class="primary" id="yes">Yes</button></div></div>
          <div id="form" ${episode.confirmed ? "" : "hidden"}>
            ${Questions.render(questions)}
            <div class="actions"><button class="primary" id="submit">${answered ? "Save" : "Submit"}</button></div>
          </div>
          <div class="note">${answered ? `Your earlier answers are filled in. ${Questions.escape(Questions.UPDATE_NOTE)}` : `About 1 to 2 minutes now, and a few follow-up questions from about ${Questions.duration(settings.followupSeconds)} after you first asked.`}
            ${Questions.escape(Questions.CONVERSATION_NOTES[episode.text] || Questions.CONVERSATION_NOTES.with_answers)}</div>
        </div>
      </div>`;
    Questions.fill(shadow, questions, previous);
    Questions.wire(shadow, questions);       // (questions that depend on another answer: lib/questions.js)
    document.body.appendChild(host);
    // the background counts a page as asked only once it is really on the screen
    send({ type: "rating_shown", id: episode.id, start: episode.start, end: episode.end });

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
      byId("intro").textContent = introOf(stage, current);
      if (moved) send({ type: "rating_shown", id: current.id, start: current.start, end: current.end });
      return true;
    };
    const finish = async (message) => {
      if (message && !chrome.runtime?.id) {
        shadow.querySelector(".body").innerHTML = `<p class="done">${UPDATED}</p>`;
        return;
      }
      host.remove();
      // a page that goes without an answer ("No", or dealt with in another tab): pop-ups that waited for it come
      send(message ? { ...message, id: current.id } : { type: "panel_gone", id: current.id });
      // the next page waiting behind this one, as it is now (skipping episodes that are gone or no
      // longer due); like any page, it replaces a pop-up that came meanwhile
      for (let next = waiting.shift(); next; next = waiting.shift()) {
        const fresh = await latest(next.episode, true);
        if (!fresh) continue;
        document.getElementById("advice-tracker-offer")?.dispatchEvent(new CustomEvent("superseded"));
        render(fresh, next.settings);
        break;
      }
    };
    host.finish = finish;
    byId("tab").onclick = () => finish({ type: "open_rating_tab", stage: current.stage });
    byId("min").onclick = () => panel.classList.toggle("minimized");
    byId("later").onclick = () => finish({ type: "rating_snoozed" });
    // ✕ (only with earlier answers) closes the panel; the answers stand
    byId("close").onclick = () => finish({ type: "rating_closed", stage: current.stage });
    byId("yes").onclick = () => { byId("confirm").hidden = true; byId("form").hidden = false; };
    byId("whatis").onclick = (event) => { event.preventDefault(); send({ type: "open_help" }); };
    byId("no").onclick = () => {
      if (!chrome.runtime?.id) { shadow.querySelector(".body").innerHTML = `<p class="done">${UPDATED}</p>`; return; }
      send({ type: "not_advice", id: current.id });
      host.update = () => true;          // nothing more to show about this episode
      shadow.querySelector(".body").innerHTML = `<p class="done">${Questions.escape(Questions.NOT_ADVICE_THANKS)}</p>`;
      setTimeout(() => finish(null), 2500);
    };
    byId("submit").onclick = () => {
      const { answers, missing } = Questions.read(shadow, questions);
      if (missing.length) { alert("Please answer all the questions marked *."); return; }
      // (timing: how long the form took, lib/questions.js: it goes with the answers)
      finish({ type: "rating_submitted", stage: current.stage, start: current.start, end: current.end, basedOn: current.basedOn,
               rating: { ...answers, ratedAt: Date.now() }, timing: Questions.timing(shadow) });
    };
  }

  // A small pop-up with Yes / No that goes away by itself after settings.updateSeconds of the page
  // being visible; `html` is its text, already escaped. `onYes` runs on Yes; the background hears
  // when it was first seen (offer_seen, counted as `asked`) and the answer (message `reply`: yes,
  // no, timeout, superseded when a ratings page takes its place, or withdrawn by the background).
  // Returns false when something is already open.
  // (`labels`: other words on the two buttons, and what each answer is called in the reply)
  function popup(episode, settings, html, asked, reply, onYes, labels = { no: "No", yes: "Yes", answers: { no: "no", yes: "yes" } }) {
    if (document.getElementById("advice-tracker-host") || document.getElementById("advice-tracker-offer")) return false;
    // NOTE: [design thought] a question about a conversation going on now comes first: the follow-up
    // pop-up (about one from days ago) goes, and is asked again another day
    dismissFollowup();
    const host = document.createElement("div");
    host.id = "advice-tracker-offer";
    host.dataset.episode = episode.id;
    const shadow = styled(host);
    shadow.innerHTML = `
      <div class="offer"><b>Advice Tracker</b> (research study)<br>${html}
        <div class="actions"><button id="no">${labels.no}</button><button class="primary" id="yes">${labels.yes}</button></div>
        <div class="left" id="left"></div></div>`;
    document.body.appendChild(host);
    let left = settings.updateSeconds, seen = false;
    const byId = (id) => shadow.getElementById(id);
    const tick = () => { byId("left").textContent = `Closes by itself in ${left} s.`; };
    const markSeen = () => {
      if (seen || document.hidden) return;
      seen = true;
      send({ type: "offer_seen", id: episode.id, start: episode.start, end: episode.end, asked });
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
      if (!chrome.runtime?.id && ["yes", "no", "stop"].includes(answer)) {
        shadow.querySelector(".offer").innerHTML = `<b>Advice Tracker</b> (research study)<br>${UPDATED}`;
        return;
      }
      host.remove();
      // (with the turns it asked about: the background withdraws its copies on other tabs that ask the same)
      send({ type: reply, id: episode.id, answer: labels.answers[answer] ?? answer, start: episode.start, end: episode.end });
      if (answer === "yes") onYes();
    };
    byId("yes").onclick = () => finish("yes");
    byId("no").onclick = () => finish("no");
    const whatis = byId("whatis");
    if (whatis) whatis.onclick = (event) => { event.preventDefault(); send({ type: "open_help" }); };
    // the invitation's "Stop asking about past conversations" link answers by itself
    const stop = byId("stop");
    if (stop) stop.onclick = (event) => { event.preventDefault(); finish("stop"); };
    host.addEventListener("superseded", () => finish("superseded"));
    // withdrawn by the background (the participant dealt with the episode elsewhere): it goes, and the
    // background hears it as the answer "withdrawn" (counted, uploaded, pop-ups that waited for it come)
    host.withdraw = () => {
      clearInterval(timer);
      host.remove();
      send({ type: reply, id: episode.id, answer: "withdrawn", start: episode.start, end: episode.end });
    };
    tick();
    markSeen();
    return true;
  }

  // "Update your ratings?" (or "Rate this conversation now?" before any answer); Yes opens the
  // ratings page with the conversation as it is now and the earlier answers filled in.
  function offerUpdate(episode, settings) {
    const question = episode.answered ? "Your advice conversation continued. Update your ratings? (encouraged if anything changed)"
                                      : "Rate this advice conversation now? (about 1 to 2 minutes)";
    const html = `${Questions.escape(question)} <a href="#" id="whatis" class="whatis">what counts as advice?</a>`;
    return popup(episode, settings, html, "offer_update", "update_answer", async () => {
      const fresh = await latest(episode);
      if (fresh) show(fresh, settings);
    });
  }

  // An episode from another chat site: the question names the site but shows none of its text
  // (this page belongs to another company), and Yes answers in an extension tab.
  function offerTab(episode, settings) {
    const question = `About your advice conversation on ${episode.site}: ${episode.answered ? "update your ratings" : "rate it now"}? ` +
                     "It opens in a separate tab.";
    return popup(episode, settings, Questions.escape(question), "offer_tab", "update_answer",
                 () => send({ type: "open_rating_tab", id: episode.id, stage: episode.stage }));
  }

  // Combined mode, right after the first advice turn: "Did you ask for advice here?" alone; the
  // background keeps the answer (No removes the episode, as on the page).
  function offerConfirm(episode, settings) {
    const html = `It looked like you asked the AI for advice here:<div class="quote">${Questions.escape(shortened(episode.openingText))}</div>` +
                 '<b>Did you ask for advice here?</b> <a href="#" id="whatis" class="whatis">what counts as advice?</a><br>If yes, a few questions about the advice follow later.';
    return popup(episode, settings, html, "offer_confirm", "confirm_answer", () => {});
  }

  // An invitation to answer questions about a conversation found on the site itself (0.6: a past one,
  // one from another device, or an update after more turns came from there). It shows no text of that
  // conversation (it is from another day, maybe another device; this page belongs to the chat company),
  // and Open answers in the extension's own tab.
  function offerInvite(invite, settings) {
    const date = Questions.escape(new Date(invite.openedAt).toLocaleDateString());
    const site = Questions.escape(invite.site);
    let html;
    if (invite.source === "past") {
      html = `Advice Tracker found a conversation on ${site} from ${date}, before you joined the study, that may have been a request for advice.` +
             ' <a href="#" id="whatis" class="whatis">what counts as advice?</a>' +
             `<br><b>You can earn ${Questions.escape(invite.reward)} for each past conversation you annotate</b> (up to ${invite.pastLimit}; about 4 to 8 minutes each` +
             `${invite.dueBy ? `; due by ${Questions.escape(new Date(invite.dueBy).toLocaleDateString())}, the end of the study` : ""}).` +
             '<div class="left">If it was not advice, please answer No there (it shows us what the extension got wrong); Skip is for one you do ' +
             'not want to annotate. Both are fine, and never affect your participation.' +
             ' <a href="#" id="stop">Stop asking about past conversations</a></div>';
    } else if (invite.stage === "final") {
      html = `Your advice conversation on ${site} from ${date} has ended (${invite.closedBy === "cut" ? "a week has passed since you first asked" : "the topic changed"}). ` +
             "Your final answers, please?";
    } else if (invite.update) {
      html = `Your advice conversation on ${site} from ${date} continued, for example on your phone or another device. Update your answers? (encouraged if anything changed)`;
    } else {
      html = `Advice Tracker found a conversation on ${site} from ${date} that was not recorded as it happened (for example on your phone ` +
             'or another device). It may have been a request for advice. <a href="#" id="whatis" class="whatis">what counts as advice?</a> ' +
             "Answer a few questions (about 1 to 2 minutes)?";
    }
    return popup({ id: invite.id }, settings, `${html}<div class="left">It opens in a separate tab.</div>`, "offer_invite", "invite_answer", () => {},
                 { no: "Not now", yes: "Open", answers: { no: "later", yes: "open" } });
  }

  // (0.7) The reminder of the Outcomes page after the two-day check (background.js offerOutcomesReminder): a pop-up
  // as the others, once; it closes by itself as they do. Its text is the extension's own, with no conversation text.
  function offerReminder(reminder, settings) {
    return popup({ id: reminder.id }, settings, Questions.escape(reminder.text), "offer_reminder", "reminder_answer", () => {},
                 { no: "Later", yes: "Open the Outcomes page", answers: { no: "later", yes: "open" } });
  }

  // The follow-up (0.6.9) about one advice conversation from a week or more ago, one question at a time:
  // "Did you make a decision yet?", then "Did you act on this decision yet?", and if not yet, when they plan
  // to; once the outcome questions are ready, it offers the outcomes page. The background decides what
  // follows each answer (it answers the message with the follow-up's stage after it). The conversation is
  // named by its site and date, and by the participant's own one-sentence summary only on that site's own
  // page (item.summary is empty elsewhere). Nobody is pressed: "Not yet" minimizes it (asked again two days
  // later), and so does leaving it alone for settings.updateSeconds while it is on the screen. Minimized, it
  // is a small bar that opens again on a click, or goes with ✕. Returns false when a page or another pop-up is open.
  // The outcome questions (0.6.14): before the study's last week "it is too early to tell" puts them off by
  // two days (settings.askAgainDays); in that week (item.final) they are due, and the pop-up says so.
  // NOTE: [edge case callout] an earlier follow-up pop-up, or its minimized bar, is replaced: the chat sites are
  // single-page apps, so a bar left on a tab open for days would otherwise keep every later question off it
  // (the background offers one at most every few hours, and only when it is due)
  function offerFollowup(item, settings) {
    if (["advice-tracker-host", "advice-tracker-offer"].some((id) => document.getElementById(id))) return false;
    dismissFollowup();
    const host = document.createElement("div");
    host.id = "advice-tracker-followup";
    host.dataset.episode = item.id;
    const shadow = styled(host);
    const escape = Questions.escape;
    const date = escape(new Date(item.openedAt).toLocaleDateString());
    const about = `About your advice conversation on ${escape(item.site)} from ${date}` +
                  (item.summary ? `:<div class="quote">${escape(shortened(item.summary))}</div>` : ".");
    const more = item.more ? `<div class="left">${item.more} more on your <a href="#" id="outcomes">Outcomes page</a>.</div>` : "";
    shadow.innerHTML = `
      <div class="offer followup">
        <div class="bar"><b>Advice Tracker</b><span class="state" id="state">(research study)</span>
          <button id="toggle">minimize</button><button id="close" title="Close: asked again another day">✕</button></div>
        <div class="body"><div>${about}</div><div id="step"></div>${more}<div class="left" id="left"></div></div></div>`;
    document.body.appendChild(host);
    for (const type of ["keydown", "keyup", "keypress", "input", "paste", "cut", "copy", "beforeinput"]) {
      host.addEventListener(type, (event) => event.stopPropagation());      // (as on the ratings page)
    }
    const byId = (id) => shadow.getElementById(id);
    const box = shadow.querySelector(".followup");
    let left = settings.updateSeconds, seen = false, touched = false;
    let final = Boolean(item.final);
    const again = `in ${settings.askAgainDays ?? 2} days`;
    const minimize = (state) => {
      clearInterval(timer);
      box.classList.add("minimized");
      byId("state").textContent = state;
      byId("toggle").textContent = "open";
    };
    byId("toggle").onclick = () => {
      if (!box.classList.contains("minimized")) return minimize("a question about a decision");
      box.classList.remove("minimized");
      byId("state").textContent = "(research study)";
      byId("toggle").textContent = "minimize";
    };
    host.dismiss = () => { clearInterval(timer); host.remove(); };
    byId("close").onclick = () => host.dismiss();
    const outcomes = byId("outcomes");
    if (outcomes) outcomes.onclick = (event) => { event.preventDefault(); send({ type: "open_outcomes" }); };
    // it is seen once the page is visible; the countdown then runs while the page is visible and nothing
    // was clicked, and minimizes it (it does not close)
    const markSeen = () => {
      if (seen || document.hidden) return;
      seen = true;
      send({ type: "followup_seen", id: item.id });
    };
    const timer = setInterval(() => {
      if (document.hidden || touched) return;
      markSeen();
      left -= 1;
      byId("left").textContent = `Minimizes by itself in ${left} s.`;
      if (left <= 0) minimize("a question about a decision");
    }, 1000);
    markSeen();
    const buttons = (pairs) => `<div class="actions">${pairs.map(([value, label]) =>
      `<button data-answer="${value}"${["yes", "open", "ok"].includes(value) ? ' class="primary"' : ""}>${label}</button>`).join("")}</div>`;
    const showStep = (name) => {
      const step = byId("step");
      if (name === "when") {
        step.innerHTML = `<b>${escape(Questions.FOLLOWUP.when)}</b><select id="when">${Questions.ACT_WHEN.map(([value, label]) =>
          `<option value="${value}">${escape(label)}</option>`).join("")}</select>${buttons([["ok", "OK"]])}`;
      } else if (name === "outcome" && final) {
        step.innerHTML = "<b>The questions about how it turned out are due by the end of the study</b> (about 4 to 8 minutes), " +
          `even if you have not acted yet or it is too early to tell.${buttons([["later", "Later"], ["open", "Open the Outcomes page"]])}`;
      } else if (name === "outcome") {
        step.innerHTML = `<b>A few questions about how it turned out are ready</b> (about 4 to 8 minutes).${buttons([["later", "Later"], ["open", "Open the Outcomes page"]])}` +
          `<div class="left"><a href="#" id="early">It is too early to tell how it turned out: ask me again ${again}</a></div>`;
        byId("early").onclick = (event) => { event.preventDefault(); clicked("outcome", "early"); };
      } else {
        step.innerHTML = `<b>${escape(Questions.FOLLOWUP[name])}</b>${buttons([["no", "Not yet"], ["yes", "Yes"]])}`;
      }
      // NOTE: [edge case callout] a step's buttons wait a moment before they take a click: a double click on
      // the step before would otherwise answer this one too
      for (const button of step.querySelectorAll("button")) {
        button.disabled = true;
        button.onclick = () => clicked(name, button.dataset.answer);
      }
      setTimeout(() => { for (const button of step.querySelectorAll("button")) button.disabled = false; }, 400);
    };
    const finish = (text, state) => {
      byId("step").innerHTML = `<p class="done">${text}</p>`;
      setTimeout(() => (state ? minimize(state) : host.remove()), 2500);
    };
    const clicked = async (name, value) => {
      touched = true;
      byId("left").textContent = "";
      // (the outcome step's buttons only open the page, or minimize: they stay usable when the bar is opened again;
      // its "too early to tell" is an answer, sent below)
      if (name === "outcome" && value !== "early") {
        if (value === "open") { send({ type: "open_outcomes", id: item.id }); host.dismiss(); }
        else minimize("later: it waits on your Outcomes page");
        return;
      }
      for (const button of byId("step").querySelectorAll("button")) button.disabled = true;      // (one answer per step)
      if (!chrome.runtime?.id) { byId("step").innerHTML = `<p class="done">${UPDATED}</p>`; return; }
      const answer = name === "when" ? byId("when").value : value;
      let reply = null;
      try {
        reply = await chrome.runtime.sendMessage({ type: "followup_answer", id: item.id, step: name, answer, where: "popup" });
      } catch (error) { /* cut off from the extension: below */ }
      if (!reply) { byId("step").innerHTML = `<p class="done">${UPDATED}</p>`; return; }
      // "Not yet" to "did you act?": the follow-up stays there, and the pop-up asks when
      if (name === "acted" && answer === "no" && reply.stage === "acted") return showStep("when");
      // ("too early to tell" was not taken: the study's last week began meanwhile, and the questions are due)
      if (name === "outcome" && reply.stage === "outcome") final = true;
      if (["decided", "acted", "outcome"].includes(reply.stage)) return showStep(reply.stage);
      if (reply.stage === "waiting") {
        return finish(name === "decided" ? `Thank you. We will ask again ${again}.`
          : name === "outcome" ? `Thank you. We will ask again ${again}; until then it stays on your Outcomes page.`
          : `Thank you. We will ask again around ${escape(new Date(reply.nextAt).toLocaleDateString())}.`, "asks again later");
      }
      finish("Already answered elsewhere: nothing more to do here.", null);
    };
    showStep(item.stage);
    return true;
  }

  // A message from the study team (0.6.15, background.js offerTeamMessage): the team's words, as text, in a
  // small window at the top right. It is apart from the questions at the bottom right, so both can be on the
  // page, and it does not go away by itself: OK marks the message as read; Later closes the window, and the
  // message comes back another time (it is also under the extension's icon). While one is on the page, another
  // waits. Returns whether this message is on the page now.
  function showMessage(message) {
    const open = document.getElementById("advice-tracker-message");
    if (open) return open.dataset.message === message.id;
    const host = document.createElement("div");
    host.id = "advice-tracker-message";
    host.dataset.message = message.id;
    const shadow = styled(host);
    shadow.innerHTML = `
      <div class="offer message"><b>Advice Tracker</b> (research study)<br><b id="title"></b><div class="text" id="text"></div>
        <div class="actions"><button id="later">Later</button><button id="ok">OK, I have read it</button><button class="primary" id="act" hidden></button></div></div>`;
    // NOTE: [design thought] textContent, not HTML: whatever the study server sent is shown as plain text
    shadow.getElementById("title").textContent = message.title || "A message from the study team";
    shadow.getElementById("text").textContent = message.text;
    document.body.appendChild(host);
    shadow.getElementById("later").onclick = () => host.remove();
    // (cut off from the extension, e.g. it was just updated: a click cannot be sent, and the message stays new)
    const cutOff = () => {
      if (chrome.runtime?.id) return false;
      shadow.getElementById("text").textContent = "Advice Tracker was updated meanwhile. Please reload this page; the message is under the Advice Tracker icon.";
      shadow.getElementById("ok").hidden = shadow.getElementById("act").hidden = true;
      return true;
    };
    shadow.getElementById("ok").onclick = () => {
      if (cutOff()) return;
      send({ type: "message_read", id: message.id, where: "chat" });
      host.remove();
    };
    // (0.6.24) a reminder of the extension's own has a button that does what it says ("Resume tracking", "Open the
    // Outcomes page", background.js remindByMessage); clicked, the message is read too. Else OK is the main button.
    const act = shadow.getElementById("act");
    if (message.actionLabel) {
      act.textContent = message.actionLabel;
      act.hidden = false;
      act.onclick = () => {
        if (cutOff()) return;
        send({ type: "message_action", id: message.id, where: "chat" });
        host.remove();
      };
    } else {
      shadow.getElementById("ok").className = "primary";
    }
    return true;
  }

  // The message was read elsewhere (the popup, the messages page, another tab): its window here goes
  function closeMessage(id) {
    const open = document.getElementById("advice-tracker-message");
    if (open?.dataset.message === id) open.remove();
  }

  root.RatingPanel = { show, refresh, close, closeOffer, offerUpdate, offerTab, offerConfirm, offerInvite, offerFollowup, offerReminder, showMessage,
                       closeMessage };
})(self);
