// Extension page with everything that waits for the participant: episodes not rated yet (a
// snoozed panel, a notification, "open in a tab") and day-14 check-ins that are due. The
// questions come from lib/questions.js, the same lists the rating panel uses.
//   ?rate=<id>      opened from a notification or the panel's "open in a tab"
//   ?checkin=<id>   opened from the day-14 notification; ?checkin=all lists every open check-in
const SHARE_OPTIONS = [["full", "your answers and the conversation (names, e-mails, numbers removed)"],
                       ["ratings", "your answers only"], ["none", "nothing for this conversation"]];

async function main() {
  const params = new URLSearchParams(location.search);
  const stored = await chrome.storage.local.get(null);
  const settings = stored.settings || {};
  const episodes = Object.entries(stored).filter(([name]) => name.startsWith("episode:")).map(([, episode]) => episode)
    .sort((a, b) => a.closedAt - b.closedAt);
  const list = document.getElementById("list");
  const now = Date.now();
  for (const episode of episodes) {
    const checkinDue = episode.status === "rated" && (episode.checkin.dueAt <= now || ["all", episode.id].includes(params.get("checkin")));
    if (episode.status === "pending") list.appendChild(ratingCard(episode, settings));
    else if (checkinDue) list.appendChild(checkinCard(episode, episodes));
  }
  if (!list.children.length) list.innerHTML = '<p class="empty">Nothing is waiting for you right now. Episodes to rate and due check-ins appear here.</p>';
  const focus = params.get("rate") || params.get("checkin");
  document.getElementById(`card-${focus}`)?.scrollIntoView();
}

function quote(text) {
  return `<div class="quote">${Questions.escape(text.length > 1200 ? text.slice(0, 1200) + " …" : text)}</div>`;
}

// NOTE: [edge case callout] each card is its own <form>: radio buttons that share a name form one
// group per form, so two cards asking "helpful" at once do not clear each other's answer
function newCard(episode) {
  const card = document.createElement("form");
  card.className = "card";
  card.id = `card-${episode.id}`;
  card.onsubmit = (event) => event.preventDefault();
  return card;
}

function ratingCard(episode, settings) {
  const card = newCard(episode);
  const redacted = Redact.redactMessages(episode.messages, settings.redactNames || []);
  const transcript = redacted.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  const preselected = settings.shareDefault === "ask" ? "" : settings.shareDefault || "";
  card.innerHTML = `<h2>${Questions.escape(episode.site)} · ${new Date(episode.closedAt).toLocaleString()}</h2>
    <p class="meta">It looked like you asked the AI for advice here:</p>${quote(episode.openingText)}
    <div class="confirm"><b>Did you ask for advice here?</b><br>
      <button type="button" class="yes">Yes</button> <button type="button" class="secondary no">No</button></div>
    <div class="form" hidden>
      ${Questions.render(Questions.RATINGS)}
      <p class="optional">Optional</p>
      ${Questions.render(Questions.OPTIONAL)}
      <div class="item"><span class="q">Share with the research team: <span class="req">*</span></span>
        ${SHARE_OPTIONS.map(([value, label]) => `<label class="choice"><input type="radio" name="share" value="${value}"
          ${value === preselected ? "checked" : ""}> ${label}</label>`).join("")}
        <details><summary>Review or edit the conversation before sharing</summary>
          <textarea class="transcript">${Questions.escape(transcript)}</textarea></details></div>
      <button type="button" class="submit">Submit</button></div>`;
  card.querySelector(".yes").onclick = () => { card.querySelector(".confirm").hidden = true; card.querySelector(".form").hidden = false; };
  card.querySelector(".no").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "not_advice", id: episode.id });
    card.innerHTML = '<p class="done">Thank you. This conversation was removed from the study.</p>';
  };
  card.querySelector(".submit").onclick = async () => {
    const ratings = Questions.read(card, Questions.RATINGS);
    const share = card.querySelector('input[name="share"]:checked')?.value;
    if (ratings.missing.length || !share) { alert("Please answer the questions marked *."); return; }
    const rating = { ...ratings.answers, ...Questions.read(card, Questions.OPTIONAL).answers, share, ratedAt: Date.now() };
    await chrome.runtime.sendMessage({ type: "rating_submitted", id: episode.id, rating,
                                       transcript: share === "full" ? card.querySelector(".transcript").value : null });
    card.innerHTML = `<p class="done">Thank you.${share === "none" ? "" : " We will check back in about two weeks."}</p>`;
  };
  return card;
}

function checkinCard(episode, episodes) {
  const card = newCard(episode);
  const later = episodes.filter((other) => (other.related || []).includes(episode.id)).length;
  const days = Math.round((Date.now() - episode.rating.ratedAt) / 86400000);
  // the participant's own description of the decision, if they gave one; else what they asked
  const recall = episode.rating.decision ? `<p class="meta">In your words, you were asking about:</p>${quote(episode.rating.decision)}`
                                         : `<p class="meta">You asked:</p>${quote(episode.openingText || "")}`;
  card.innerHTML = `<h2>${Questions.escape(episode.site)} · ${new Date(episode.closedAt).toLocaleDateString()}</h2>
    <p>About ${days} days ago you asked an AI assistant for advice. What happened since?</p>${recall}
    ${later ? `<p class="meta">Since then you had ${later} more conversation(s) that looked related to this one.</p>` : ""}
    ${Questions.render(Questions.CHECKIN)}
    <button type="button" class="submit">Submit check-in</button>`;
  card.querySelector(".submit").onclick = async () => {
    const { answers, missing } = Questions.read(card, Questions.CHECKIN);
    if (missing.length) { alert("Please say whether you followed the advice and what you did."); return; }
    await chrome.runtime.sendMessage({ type: "checkin_submitted", id: episode.id, answers: { ...answers, answeredAt: Date.now() } });
    card.innerHTML = '<p class="done">Thank you, that completes this conversation.</p>';
  };
  return card;
}

main();
