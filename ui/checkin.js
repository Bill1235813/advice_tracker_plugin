// Extension page for the two-week follow-up (and for ratings that could not be shown on the
// chat page). Questions mirror Session 2 of the user study so plug-in and survey outcomes
// line up: followed? what did you do? did it make you feel better? AI's role, outcome,
// other sources, then the six response items again.
const EXTENT = ["Not at all", "Slightly", "Moderately", "Very", "Extremely"];
const ITEMS = [
  ["helpful", "Helpful: did the responses move you forward on what to do?"],
  ["accurate", "Accurate: as far as you can tell, were the facts and claims correct?"],
  ["relevant", "Specific: did they address your particular situation, rather than give generic advice?"],
  ["trust", "Trust: how much do you trust the advice you were given?"],
  ["clear", "Clear: how easy were the responses to understand and follow?"],
  ["harmful", "Harmful: could following the responses have hurt you or someone else?"]];

function scale(name, labels = EXTENT) {
  return `<div class="scale">${labels.map((label, i) => `<label><input type="radio" name="${name}" value="${i + 1}">${i + 1}<br>${label}</label>`).join("")}</div>`;
}
function esc(text) { return (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
function value(card, name) { const el = card.querySelector(`input[name="${name}"]:checked`); return el ? Number(el.value) : null; }

async function main() {
  const params = new URLSearchParams(location.search);
  const { conversations = {}, settings = {} } = await chrome.storage.local.get(["conversations", "settings"]);
  window.shareDefault = settings.shareDefault || "ask";
  const list = document.getElementById("list");
  let shown = 0;
  const now = Date.now();
  for (const conversation of Object.values(conversations)) {
    // pending ratings are always listed (a snoozed or dismissed-by-accident panel is found here)
    const wantsRating = conversation.status === "classified";
    const followupDue = conversation.status === "rated" && conversation.followup && !conversation.followup.doneAt &&
      (params.get("followup") === conversation.key || conversation.followup.dueAt <= now || params.get("followup") === "all");
    if (wantsRating) { list.appendChild(ratingCard(conversation)); shown += 1; }
    else if (followupDue) { list.appendChild(followupCard(conversation)); shown += 1; }
  }
  if (!shown) list.innerHTML = '<p class="empty">Nothing is waiting for you right now. Snoozed ratings and due follow-ups appear here.</p>';
}

function header(conversation) {
  const first = (conversation.messages || []).find((m) => m.role === "user");
  const recall = first ? first.content : (conversation.rating?.decision || "(conversation text no longer stored)");
  return `<h2>${esc(conversation.site)} · ${esc(conversation.domain)}</h2>
    <div class="meta">${new Date(conversation.firstSeen).toLocaleString()}</div>
    <div class="quote">${esc(recall.slice(0, 1200))}</div>`;
}

function ratingCard(conversation) {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `${header(conversation)}
    <p>This looked like a request for advice. Please rate the conversation.</p>
    ${ITEMS.map(([k, q]) => `<div class="item"><span class="q">${q}</span>${scale(k)}</div>`).join("")}
    <div class="item"><span class="q">In one sentence, what decision or situation were you asking about?</span><input type="text" name="decision"></div>
    <div class="item"><span class="q">How likely are you to act on the advice in the next two weeks?</span>${scale("intent", ["Very unlikely", "Unlikely", "Not sure", "Likely", "Very likely"])}</div>
    <div class="item"><span class="q">Share with the research team:</span>
      <select name="share"><option value="full">ratings and the (redacted) conversation</option><option value="ratings">ratings only</option><option value="none">nothing</option></select></div>
    <button class="submit">Submit</button> <button class="secondary not-advice">Not an advice request</button>`;
  if (window.shareDefault !== "ask") card.querySelector('[name="share"]').value = window.shareDefault;
  card.querySelector(".submit").onclick = async () => {
    const rating = {};
    for (const [k] of ITEMS) rating[k] = value(card, k);
    if (Object.values(rating).some((v) => v === null)) { alert("Please answer all six rating questions."); return; }
    rating.intent = value(card, "intent");
    rating.decision = card.querySelector('[name="decision"]').value.trim();
    rating.share = card.querySelector('[name="share"]').value;
    rating.ratedAt = Date.now();
    const transcript = rating.share === "full" && conversation.messages
      ? Redact.redactMessages(conversation.messages, []).messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n") : null;
    await chrome.runtime.sendMessage({ type: "rating_submitted", key: conversation.key, rating, transcript });
    card.innerHTML = `<p class="done">Thank you. We will check back in about two weeks.</p>`;
  };
  card.querySelector(".not-advice").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "not_advice", key: conversation.key });
    card.remove();
  };
  return card;
}

function followupCard(conversation) {
  const card = document.createElement("div");
  card.className = "card";
  const related = (conversation.related || []).length ? `<p class="meta">You later had ${conversation.related.length} more conversation(s) that looked related to this one.</p>` : "";
  card.innerHTML = `${header(conversation)}${related}
    <p>About ${Math.round((Date.now() - conversation.rating.ratedAt) / 86400000)} days ago you asked for advice here. What happened since?</p>
    <div class="item"><span class="q">Did you follow the advice?</span>
      <select name="followed"><option value="">choose…</option><option value="fully">Yes, fully</option><option value="partly">Yes, partly</option>
        <option value="plan">Not yet, but I plan to</option><option value="against">No, I decided against it</option>
        <option value="changed">No, the situation changed or resolved itself</option><option value="forgot">No, I forgot about it</option></select></div>
    <div class="item"><span class="q">What did you actually do, or decide? (1-3 sentences)</span><textarea name="did"></textarea></div>
    <div class="item"><span class="q">Did the advice you followed make you feel better?</span>${scale("feel_better", ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"])}</div>
    <div class="item"><span class="q">What role did the AI conversation play in what you decided?</span>
      <select name="ai_role"><option value="">choose…</option><option value="deciding">The deciding factor</option><option value="one_input">One input among several</option>
        <option value="small">A small influence</option><option value="none">No influence</option><option value="undecided">I have not decided yet</option></select></div>
    <div class="item"><span class="q">So far, how has the situation turned out?</span>${scale("outcome", ["Much worse", "Somewhat worse", "About the same", "Somewhat better", "Much better"])}
      <label><input type="checkbox" name="too_early"> too early to tell</label></div>
    <div class="item checks"><span class="q">Since then, have you consulted anyone or anything else about it?</span>
      ${["Friends or family", "A professional", "Web search or online communities", "The same AI assistant again", "A different AI assistant", "No one"]
        .map((label) => `<label><input type="checkbox" name="sources" value="${label}"> ${label}</label>`).join("")}</div>
    <p><b>Thinking back now, with what you know today:</b></p>
    ${ITEMS.map(([k, q]) => `<div class="item"><span class="q">${q}</span>${scale("re_" + k)}</div>`).join("")}
    <div class="item"><span class="q">Has your opinion of the advice changed?</span>
      <select name="opinion"><option value="">choose…</option><option value="worse">It looks worse now</option><option value="same">About the same</option><option value="better">It looks better now</option></select></div>
    <div class="item"><span class="q">Anything unexpected, or anything else you want to tell us? (optional)</span><textarea name="comment"></textarea></div>
    <button class="submit">Submit follow-up</button>`;
  card.querySelector(".submit").onclick = async () => {
    const answers = {
      followed: card.querySelector('[name="followed"]').value, did: card.querySelector('[name="did"]').value.trim(),
      feel_better: value(card, "feel_better"), ai_role: card.querySelector('[name="ai_role"]').value,
      outcome: value(card, "outcome"), too_early: card.querySelector('[name="too_early"]').checked,
      sources: Array.from(card.querySelectorAll('[name="sources"]:checked')).map((el) => el.value),
      rerating: Object.fromEntries(ITEMS.map(([k]) => [k, value(card, "re_" + k)])),
      opinion: card.querySelector('[name="opinion"]').value, comment: card.querySelector('[name="comment"]').value.trim(),
      answeredAt: Date.now(),
    };
    if (!answers.followed || !answers.did) { alert("Please say whether you followed the advice and what you did."); return; }
    await chrome.runtime.sendMessage({ type: "followup_submitted", key: conversation.key, answers });
    card.innerHTML = `<p class="done">Thank you - that completes this conversation.</p>`;
  };
  return card;
}

main();
