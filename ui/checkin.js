// Extension page with everything that waits for the participant: episodes not rated yet (a
// snoozed panel, a notification, "open in a tab") and day-14 check-ins that are due. The
// questions come from lib/questions.js, the same lists the rating panel uses. (The conversation
// itself goes with the answers, redacted; the check-in asks how things went. Only an episode from
// 0.4, whose conversation was to be sent after a review here, still shows it for review.)
//   ?rate=<id>      opened from a notification or the panel's "open in a tab"; also works for an
//                   episode that is still going on, or that has answers to update (&stage=<stage>:
//                   the question the panel asked, e.g. temp after a move to another site)
//   ?checkin=<id>   opened from the day-14 notification; ?checkin=all also lists check-ins that
//                   are not due yet (for testing and demos only; nothing links to it)
//   ?item=<id>      opened from an invitation on a chat page (0.6): an episode found on the site
//                   itself (a past conversation, one from another device, or one that continued there)
// Episodes asked about through their site's queue (lib/modes.js viaQueue) appear one per site: the
// site's current question (queueItem), and the next one once that is answered.
const STAGES = ["first", "temp", "update", "final", "end"];

async function main() {
  const params = new URLSearchParams(location.search);
  const stored = await chrome.storage.local.get(null);
  const settings = stored.settings || {};
  const episodes = Object.entries(stored).filter(([name]) => name.startsWith("episode:")).map(([, episode]) => episode)
    .sort((a, b) => a.openedAt - b.openedAt);
  const list = document.getElementById("list");
  const now = Date.now();
  // one question per site from its queue: the one an invitation (or a notification) opened this tab
  // for, else the site's current one
  const asked = params.get("item") || params.get("rate");
  const queued = new Set();
  for (const site of new Set(episodes.map((episode) => episode.site))) {
    const mine = episodes.filter((episode) => episode.site === site && queueKindOn(episode, settings));
    const opened = mine.find((episode) => episode.id === asked && Modes.viaQueue(episode));
    const item = opened ? { record: opened } : Modes.queueItem(mine, now, Modes.followupSeconds(settings), stored[`qstate:${site}`]?.current);
    if (item) queued.add(item.record.id);
  }
  for (const episode of episodes) {
    episode.text = conversationGoes(episode, settings);
    if (Modes.viaQueue(episode)) {
      const askable = !["done", "removed"].includes(episode.status) && !(episode.source === "past" && episode.answers) && queueKindOn(episode, settings);
      if (queued.has(episode.id) && askable) list.appendChild(itemCard(episode, settings, now));
      if (Modes.checkinDue(episode, now)) list.appendChild(checkinCard(episode, episodes, settings, stored));
      continue;
    }
    // the check-in once it is due (with ?checkin=, also before: for testing and demos)
    const checkinDue = Modes.checkinDue(episode, now) ||
      (Modes.checkinDue(episode, Infinity) && ["all", episode.id].includes(params.get("checkin")));
    // waiting for answers (lib/modes.js: an ended episode never answered, final answers still
    // due, an open episode the participant was asked about), or the one this tab was opened for
    const requested = params.get("rate") === episode.id && ["open", "pending", "rated"].includes(episode.status);
    if (Modes.waiting(episode) || requested) list.appendChild(ratingCard(episode, requested ? params.get("stage") : null));
    if (checkinDue) list.appendChild(checkinCard(episode, episodes, settings, stored));
  }
  if (!list.children.length) list.innerHTML = '<p class="empty">Nothing is waiting for you right now. Episodes to rate and due check-ins appear here.</p>';
  const focus = params.get("item") ? `item-${params.get("item")}` : params.get("rate") ? `rate-${params.get("rate")}` : `checkin-${params.get("checkin")}`;
  document.getElementById(`card-${focus}`)?.scrollIntoView();
}

// the episode's kind is turned on (an episode from elsewhere is asked about only while reading it is)
function queueKindOn(episode, settings) {
  if (isExcluded(new URL(episode.url).hostname, settings.excludedHosts || [])) return false;
  return episode.source === "past" ? Boolean(settings.readPast) : episode.source === "app" || episode.heldBy === "history" ? Boolean(settings.readApps) : true;
}

// what happens to the episode's conversation (lib/questions.js), as the background decides it
function conversationGoes(episode, settings) {
  return Questions.conversationGoes(episode, isExcluded(new URL(episode.url).hostname, settings.excludedHosts || []));
}

// The conversation of an episode from 0.4, for its review: the record's copy once the episode
// ended; while it goes on, its turns in the chat's latest copy, if they are still there unchanged
// (lined up as the background does: older turns may have come in above since)
function reviewMessages(episode, stored) {
  if (episode.messages) return episode.messages;
  if (episode.status !== "open") return [];
  const chat = stored[`chat:${episode.chatKey}`], snapshot = stored[`snap:${episode.chatKey}`];
  const { userTurns, replies } = Episodes.splitTurns(snapshot?.messages || []);
  const shift = Episodes.findOffset(chat?.ids || [], Episodes.turnIds(userTurns));
  return shift < 0 ? [] : Episodes.episodeMessages(userTurns, replies, episode.start + shift, episode.end + shift);
}

function quote(text) {
  return `<div class="quote">${Questions.escape(text.length > 1200 ? text.slice(0, 1200) + " …" : text)}</div>`;
}

// NOTE: [edge case callout] each card is its own <form>: radio buttons that share a name form one
// group per form, so two cards asking "helpful" at once do not clear each other's answer
function newCard(episode, kind) {
  const card = document.createElement("form");
  card.className = "card";
  card.id = `card-${kind}-${episode.id}`;
  card.onsubmit = (event) => event.preventDefault();
  return card;
}

// `asked`: the stage of the question the chat page asked, if this tab was opened from it
function ratingCard(episode, asked) {
  const card = newCard(episode, "rate");
  const questions = [...Questions.RATINGS, ...Questions.DETAILS];
  const answered = episode.versions > 0;
  const confirmed = answered || Boolean(episode.confirmedAt);       // combined mode: Yes in the confirm pop-up
  // the question the chat page asked, else the one that waits (the background corrects a stage
  // that no longer fits, e.g. an episode that ended meanwhile)
  const stage = STAGES.includes(asked) ? asked : Modes.pageDue(episode)?.stage || (answered ? "update" : "first");
  card.innerHTML = `<h2>${Questions.escape(episode.site)} · ${new Date(episode.closedAt || episode.openedAt).toLocaleString()}</h2>
    <p class="meta">It looked like you asked the AI for advice here:</p>${quote(episode.openingText)}
    <div class="confirm" ${confirmed ? "hidden" : ""}><b>Did you ask for advice here?</b><br>
      <button type="button" class="yes">Yes</button> <button type="button" class="secondary no">No</button></div>
    ${answered ? '<p class="meta">Your earlier answers are filled in; change any that are different now.</p>' : ""}
    <div class="form" ${confirmed ? "" : "hidden"}>
      ${Questions.render(questions)}
      <p class="meta">${Questions.escape(Questions.CONVERSATION_NOTES[episode.text])}</p>
      <button type="button" class="submit">Submit</button></div>`;
  Questions.fill(card, questions, episode.answers);
  card.querySelector(".yes").onclick = () => { card.querySelector(".confirm").hidden = true; card.querySelector(".form").hidden = false; };
  card.querySelector(".no").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "not_advice", id: episode.id });
    card.innerHTML = '<p class="done">Thank you. This conversation was removed from the study.</p>';
  };
  card.querySelector(".submit").onclick = async () => {
    const { answers, missing } = Questions.read(card, questions);
    if (missing.length) { alert("Please answer all the questions marked *."); return; }
    await chrome.runtime.sendMessage({ type: "rating_submitted", id: episode.id, rating: { ...answers, ratedAt: Date.now() },
                                       stage, start: episode.start, end: episode.end, basedOn: episode.versions });
    const later = Modes.checkinDue(episode, Date.now()) ? " The two-week check-in for this conversation is below."
                                                        : " We will check back about two weeks after you first asked.";
    card.innerHTML = `<p class="done">Thank you.${later}</p>`;
  };
  return card;
}

// An episode found on the site itself (a past conversation, or one from another device) or one that
// continued there: what it was, when, a link to it on the site, then "Did you ask for advice here?"
// (Yes / No, and Skip for a past one), then the questions. A past one shows its conversation as it
// will be sent with the answers.
function itemCard(episode, settings, now) {
  const card = newCard(episode, "item");
  const past = episode.source === "past", answered = episode.versions > 0;
  const decision = Modes.queueDue(episode, now, Modes.followupSeconds(settings)) || Modes.pageDue(episode) || { stage: answered ? "update" : "first" };
  const questions = past ? Questions.PAST : [...Questions.RATINGS, ...Questions.DETAILS];
  const confirmed = answered || Boolean(episode.confirmedAt);
  const when = new Date(episode.openedAt).toLocaleDateString();
  const ended = decision.stage === "final" || decision.stage === "end";
  const why = episode.closedBy === "cut" ? "a week has passed since you first asked" : "the topic changed";
  const intro = past ? `Before you joined the study, on ${when}, you had this conversation with the AI:`
    : decision.stage === "final" ? `This advice conversation from ${when} has ended (${why}). Your final answers, please:`
    : answered ? "Your advice conversation continued (for example on your phone or another device). Change any answer that is different now:"
    : episode.source === "app" ? `On ${when} you had this conversation, which was not recorded as it happened (for example on your phone or another device):`
    : `On ${when} you asked the AI for advice here${ended ? " (this conversation has ended)" : ""}:`;
  const review = past ? Questions.transcript((episode.messages || []).slice(transcriptFrom(episode)), settings.redactNames || []) : null;
  card.innerHTML = `<h2>${Questions.escape(episode.site)} · ${Questions.escape(when)}${episode.title ? ` · “${Questions.escape(episode.title)}”` : ""}</h2>
    <p class="meta">${Questions.escape(intro)}</p>${quote(episode.openingText || "")}
    <p class="meta"><a href="${Questions.escape(episode.url)}" target="_blank" rel="noopener">Open this conversation on ${Questions.escape(episode.site)}</a></p>
    ${past ? `<p class="meta"><b>You can earn ${Questions.escape(STUDY_CONFIG.pastReward)} for annotating this past conversation</b>
      (up to ${STUDY_CONFIG.pastLimit} conversations; about 5-10 minutes). Answer No or Skip if it was not advice: that is fine, and never
      affects your participation. <a href="#" class="stop">Stop asking about past conversations</a></p>` : ""}
    <div class="confirm" ${confirmed ? "hidden" : ""}><b>Did you ask the AI for advice about your own situation in this conversation?</b><br>
      <button type="button" class="yes">Yes</button> <button type="button" class="secondary no">No</button>
      ${past ? '<button type="button" class="secondary skip">Skip this one</button>' : ""}</div>
    ${answered ? '<p class="meta">Your earlier answers are filled in; change any that are different now.</p>' : ""}
    <div class="form" ${confirmed ? "" : "hidden"}>
      ${Questions.render(questions)}
      ${review ? `<div class="item"><span class="q">Your conversation, as it will be sent with your answers</span>
        <p class="meta">Names, e-mail addresses, phone numbers and similar details are removed automatically.</p>
        <pre class="transcript-view">${Questions.escape(review.text)}</pre></div>` : ""}
      <p class="meta">${Questions.escape(Questions.CONVERSATION_NOTES[episode.text] || Questions.CONVERSATION_NOTES.with_answers)}</p>
      <button type="button" class="submit">Submit</button> ${past ? '<button type="button" class="secondary skip">Skip this one</button>' : ""}</div>`;
  Questions.fill(card, questions, episode.answers);
  // the page counts as asked once it is on the screen (the update rule looks at that)
  chrome.runtime.sendMessage({ type: "rating_shown", id: episode.id, start: episode.start, end: episode.end });
  const done = (text) => { card.innerHTML = `<p class="done">${text}</p>`; };
  card.querySelector(".yes").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "card_answer", id: episode.id, answer: "yes" });
    card.querySelector(".confirm").hidden = true;
    card.querySelector(".form").hidden = false;
  };
  card.querySelector(".no").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "card_answer", id: episode.id, answer: "no" });
    done("Thank you. This conversation was removed from the study.");
  };
  for (const button of card.querySelectorAll(".skip")) {
    button.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "card_answer", id: episode.id, answer: "skip" });
      done("Skipped. This conversation will not be asked about again.");
    };
  }
  card.querySelector(".stop")?.addEventListener("click", async (event) => {
    event.preventDefault();
    if (!confirm("Stop reading your past conversations? Those found and not annotated yet are deleted from this computer.")) return;
    const { settings: current = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...current, readPast: false } });
    done("Past conversations are no longer read. You can turn this on again in the settings.");
  });
  card.querySelector(".submit").onclick = async () => {
    const { answers, missing } = Questions.read(card, questions);
    if (missing.length) { alert("Please answer all the questions marked *."); return; }
    if (past) {
      await chrome.runtime.sendMessage({ type: "past_submitted", id: episode.id, answers: { ...answers, answeredAt: Date.now() } });
      done("Thank you. Your answers and this conversation were sent.");
    } else {
      await chrome.runtime.sendMessage({ type: "rating_submitted", id: episode.id, rating: { ...answers, ratedAt: Date.now() },
                                         stage: decision.stage, start: episode.start, end: episode.end, basedOn: episode.versions });
      done(Modes.checkinDue(episode, Date.now()) ? "Thank you." : "Thank you. We will check back about two weeks after you first asked.");
    }
  };
  return card;
}

// the record's messages hold its turns start..end; the transcript starts at the opening
function transcriptFrom(episode) {
  let turn = 0;
  return Math.max(0, (episode.messages || []).findIndex((message) => message.role === "user" && ++turn === episode.opening - episode.start + 1));
}

function checkinCard(episode, episodes, settings, stored) {
  const card = newCard(episode, "checkin");
  const later = episodes.filter((other) => (other.related || []).includes(episode.id)).length;
  const days = Math.round((Date.now() - episode.openedAt) / 86400000);
  // an episode from 0.4: its conversation, redacted as it will be sent, for review
  const messages = episode.text === "at_checkin" ? reviewMessages(episode, stored) : [];
  const review = messages.length ? Questions.transcript(messages, settings.redactNames || []) : null;
  const removed = review ? Object.entries(review.counts).map(([kind, count]) => `${count} ${kind}`).join(", ") || "nothing found" : "";
  // the participant's own description of the decision, if they gave one; else what they asked
  const recall = episode.answers?.decision ? `<p class="meta">In your words, you were asking about:</p>${quote(episode.answers.decision)}`
                                         : `<p class="meta">You asked:</p>${quote(episode.openingText || "")}`;
  card.innerHTML = `<h2>${Questions.escape(episode.site)} · ${new Date(episode.openedAt).toLocaleDateString()}</h2>
    <p>About ${days} days ago you asked an AI assistant for advice. What happened since?</p>${recall}
    ${later ? `<p class="meta">Since then you had ${later} more conversation(s) that looked related to this one.</p>` : ""}
    ${Questions.render(Questions.CHECKIN)}
    ${review ? `<div class="item"><span class="q">Your conversation, as we will store it</span>
      <p class="meta">Names, e-mail addresses, phone numbers and similar details were removed automatically
        (${Questions.escape(removed)}). Delete anything else you do not want us to keep, then submit.</p>
      <textarea class="transcript">${Questions.escape(review.text)}</textarea></div>` : ""}
    <button type="button" class="submit">Submit check-in</button>`;
  card.querySelector(".submit").onclick = async () => {
    const { answers, missing } = Questions.read(card, Questions.CHECKIN);
    if (missing.length) { alert("Please answer all the questions marked *."); return; }
    const transcript = review ? card.querySelector(".transcript").value : null;
    await chrome.runtime.sendMessage({ type: "checkin_submitted", id: episode.id, answers: { ...answers, answeredAt: Date.now() },
                                       ...(review ? { transcript, edited: transcript !== review.text } : {}) });
    card.innerHTML = '<p class="done">Thank you, that completes this conversation.</p>';
  };
  return card;
}

main();
