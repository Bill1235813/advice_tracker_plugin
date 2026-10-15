// Extension page with everything that waits for the participant: episodes not rated yet (a
// snoozed panel, a notification, "open in a tab") and day-14 check-ins that are due. The
// questions come from lib/questions.js, the same lists the rating panel uses. The check-in is
// also where the participant reviews the conversation: it is stored only with the check-in, after
// they deleted whatever they do not want us to keep (names, e-mails, numbers are removed already).
//   ?rate=<id>      opened from a notification or the panel's "open in a tab"; also works for an
//                   episode that is still going on, or that has answers to update (&stage=<stage>:
//                   the question the panel asked, e.g. temp after a move to another site)
//   ?checkin=<id>   opened from the day-14 notification; ?checkin=all also lists check-ins that
//                   are not due yet (for testing and demos only; nothing links to it)
const STAGES = ["first", "temp", "update", "final", "end"];

async function main() {
  const params = new URLSearchParams(location.search);
  const stored = await chrome.storage.local.get(null);
  const settings = stored.settings || {};
  const episodes = Object.entries(stored).filter(([name]) => name.startsWith("episode:")).map(([, episode]) => episode)
    .sort((a, b) => a.openedAt - b.openedAt);
  const list = document.getElementById("list");
  const now = Date.now();
  for (const episode of episodes) {
    // the check-in once it is due (with ?checkin=, also before: for testing and demos)
    const checkinDue = Modes.checkinDue(episode, now) ||
      (Modes.checkinDue(episode, Infinity) && ["all", episode.id].includes(params.get("checkin")));
    // waiting for answers (lib/modes.js: an ended episode never answered, final answers still
    // due, an open episode the participant was asked about), or the one this tab was opened for
    const requested = params.get("rate") === episode.id && ["open", "pending", "rated"].includes(episode.status);
    if (Modes.waiting(episode) || requested) list.appendChild(ratingCard(episode, settings, stored, requested ? params.get("stage") : null));
    if (checkinDue) list.appendChild(checkinCard(episode, episodes, settings, stored));
  }
  if (!list.children.length) list.innerHTML = '<p class="empty">Nothing is waiting for you right now. Episodes to rate and due check-ins appear here.</p>';
  const focus = params.get("rate") ? `rate-${params.get("rate")}` : `checkin-${params.get("checkin")}`;
  document.getElementById(`card-${focus}`)?.scrollIntoView();
}

// The episode's conversation: kept in the record until its check-in, else (an episode still going
// on) taken from the chat's latest snapshot
function messagesOf(episode, stored) {
  if (episode.messages) return episode.messages;
  const { userTurns, replies } = Episodes.splitTurns(stored[`snap:${episode.chatKey}`]?.messages || []);
  return Episodes.episodeMessages(userTurns, replies, episode.start, episode.end);
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
function ratingCard(episode, settings, stored, asked) {
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
                                       stage, end: episode.end, basedOn: episode.versions });
    const later = Modes.checkinDue(episode, Date.now()) ? " The two-week check-in for this conversation is below."
                                                        : " We will check back about two weeks after you first asked.";
    card.innerHTML = `<p class="done">Thank you.${later}</p>`;
  };
  return card;
}

function checkinCard(episode, episodes, settings, stored) {
  const card = newCard(episode, "checkin");
  const later = episodes.filter((other) => (other.related || []).includes(episode.id)).length;
  const days = Math.round((Date.now() - episode.openedAt) / 86400000);
  // the conversation to review: the episode's messages, redacted as they will be stored
  const messages = messagesOf(episode, stored);
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
                                       transcript, edited: review ? transcript !== review.text : false });
    card.innerHTML = '<p class="done">Thank you, that completes this conversation.</p>';
  };
  return card;
}

main();
