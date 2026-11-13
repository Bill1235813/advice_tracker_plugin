// The extension's two pages of questions (one script; the page's address says which):
// - the quick check-ins (ui/checkin.html): episodes not rated yet (a snoozed panel, a notification, "open
//   in a tab"), and conversations found on the site itself from other devices;
// - the outcomes page (ui/outcomes.html, 0.6.9): every advice conversation whose follow-up is not done,
//   oldest first, at its stage (lib/modes.js followupStage: did you decide, did you act, when, the
//   outcome questions, or the wait after "too early to tell"), and everything about past conversations
//   (their questions, how reading them goes). Both are due by the end of the study (0.6.14).
// The questions come from lib/questions.js, the same lists the rating panel uses. (The conversation
// itself goes with the quick answers, redacted. The outcomes page shows it once more with the outcome
// questions, and a past one with its questions, in a box the participant can edit: 0.6.16, showReview.)
//   ?rate=<id>      opened from a notification or the panel's "open in a tab"; also works for an
//                   episode that is still going on, or that has answers to update (&stage=<stage>:
//                   the question the panel asked, e.g. temp after a move to another site)
//   ?item=<id>      opened from an invitation on a chat page (0.6): an episode found on the site
//                   itself (a past conversation, one from another device, or one that continued there)
//   ?episode=<id>   (outcomes page) opened from the follow-up pop-up: that conversation's card first in view;
//                   ?checkin=all shows the outcome questions of every follow-up not done, whatever its stage
//                   (for testing and demos only; nothing links to it)
// Episodes asked about through their site's queue (lib/modes.js viaQueue) appear one per site: the
// site's current question (queueItem), and the next one once that is answered.
const OUTCOMES = location.pathname.endsWith("/outcomes.html");
const STAGES = ["first", "temp", "update", "final", "end"];
// (for the storage listener at the end: the episodes whose question was answered on this tab, and the
// settings as this page last read them)
const answeredHere = new Set();
let pageSettings = {};
// how many questions wait in each site's queue (the page shows one at a time): for the "1 of N" line
let queueCounts = {};

// (each page counts its own kind: past conversations on the outcomes page, those from elsewhere on the quick one;
// only the questions due now, lib/modes.js queueDue, as the queue asks them: not one answered with nothing new since)
// `onScreen`: ids of the queue cards on this page, which count while they are there (an update's card is no
// longer due once it was shown, yet it still waits for its answer here)
function countQueued(episodes, settings, onScreen = new Set()) {
  const counts = {}, now = Date.now();
  for (const episode of episodes) {
    const due = onScreen.has(episode.id) || Modes.queueDue(episode, now, Modes.followupSeconds(settings));
    if (!due || !queueKindOn(episode, settings) || (episode.source === "past") !== OUTCOMES) continue;
    counts[episode.site] = (counts[episode.site] || 0) + 1;
  }
  return counts;
}

// NOTE: [design thought] the badge on the icon counts every question waiting, the page shows one per
// site: without this line, "4" on the icon and one card here look like a fault
function queueLine(episode) {
  const n = queueCounts[episode.site] || 1;
  const [one, many] = episode.source === "past" ? ["past conversation", "past conversations"]
                                                : ["conversation from elsewhere", "conversations from elsewhere"];
  return n === 1 ? `1/1 ${one} awaiting labeling` : `1/${n} ${many} awaiting labeling`;
}
const QUEUE_SUB = "The next conversation will appear once you label this one.";

async function main() {
  const params = new URLSearchParams(location.search);
  const stored = await chrome.storage.local.get(null);
  const settings = stored.settings || {};
  pageSettings = settings;
  const episodes = Object.entries(stored).filter(([name]) => name.startsWith("episode:")).map(([, episode]) => episode)
    .sort((a, b) => a.openedAt - b.openedAt);
  const list = document.getElementById("list");
  const pastList = document.getElementById("past-list");          // (the outcomes page's past conversations)
  const now = Date.now(), end = Modes.studyEnd(stored, STUDY_CONFIG.studyDays);
  queueCounts = countQueued(episodes, settings);
  // the study's dates in the outcomes page's notes (ui/outcomes.html): when its last week begins, in which the
  // outcome questions of every conversation are due, and when it ends (nothing before the participant joined)
  if (OUTCOMES && Number.isFinite(end)) {
    const day = (at) => new Date(at).toLocaleDateString(undefined, { month: "long", day: "numeric" });
    for (const span of document.querySelectorAll(".due-by")) span.textContent = ` (${day(end)})`;
    for (const span of document.querySelectorAll(".final-from")) span.textContent = ` (from ${day(end - Modes.FINAL_DAYS * 86400000)})`;
  }
  // one question per site from its queue: the one an invitation (or a notification) opened this tab
  // for, else the site's current one
  const asked = params.get("item") || params.get("rate");
  const queued = new Set();
  for (const site of new Set(episodes.map((episode) => episode.site))) {
    // (the outcomes page asks about past conversations, the quick one about those from elsewhere: each its own question)
    const mine = episodes.filter((episode) => episode.site === site && queueKindOn(episode, settings) && (episode.source === "past") === OUTCOMES);
    // (one this tab was opened for, unless its answers are up to date: nothing new since, lib/modes.js stillDue)
    const opened = mine.find((episode) => episode.id === asked && Modes.viaQueue(episode) && Modes.stillDue(episode));
    const item = opened ? { record: opened } : Modes.queueItem(mine, now, Modes.followupSeconds(settings), stored[`qstate:${site}`]?.current);
    if (item) queued.add(item.record.id);
  }
  for (const episode of episodes) {
    episode.text = conversationGoes(episode, settings);
    // the outcomes page: every conversation whose follow-up is not done, at its stage
    if (OUTCOMES && Modes.followupStage(episode, now, end)) list.appendChild(followupCard(episode, episodes, settings, stored, params.get("checkin") === "all"));
    if (Modes.viaQueue(episode)) {
      const askable = !["done", "removed"].includes(episode.status) && !(episode.source === "past" && episode.answers) && queueKindOn(episode, settings);
      // (a past one on the outcomes page, one from another device on the quick check-ins page)
      if (queued.has(episode.id) && askable && (episode.source === "past") === OUTCOMES) (OUTCOMES ? pastList : list).appendChild(itemCard(episode, settings, now));
      continue;
    }
    if (OUTCOMES) continue;
    // waiting for answers (lib/modes.js: an ended episode never answered, final answers still
    // due, an open episode the participant was asked about), or the one this tab was opened for,
    // unless its answers are up to date (nothing new since: lib/modes.js stillDue)
    const requested = params.get("rate") === episode.id && ["open", "pending", "rated"].includes(episode.status) &&
                      Modes.stillDue(episode);
    if (Modes.waiting(episode) || requested) list.appendChild(ratingCard(episode, requested ? params.get("stage") : null, settings));
  }
  if (!list.children.length) {
    list.innerHTML = OUTCOMES ? '<p class="empty">No follow-up is open right now. A week after you ask an AI assistant for advice, its follow-up appears here.</p>'
                              : '<p class="empty">Nothing is waiting for you right now. Advice conversations to rate appear here.</p>';
  }
  if (pastList && !pastList.children.length) {
    pastList.innerHTML = `<p class="empty">${settings.readPast ? "No past conversation is waiting to be annotated right now. When Advice Tracker finds one, it invites you on the site's page."
      : 'Reading your past conversations is off. You can earn money for annotating some: turn it on in the <a href="../options/options.html#history">settings</a>.'}</p>`;
  }
  const focus = params.get("item") ? `item-${params.get("item")}` : params.get("rate") ? `rate-${params.get("rate")}` : null;
  const card = focus ? document.getElementById(`card-${focus}`)
    : document.getElementById(`card-followup-${params.get("episode")}`) || document.getElementById(`card-checkin-${params.get("episode")}`);
  card?.scrollIntoView();
  // (the reminder to look at this page waits while the participant had it open: background.js remindOutcomes)
  if (OUTCOMES) await chrome.storage.local.set({ outcomesSeenAt: Date.now() });
}

// the episode can be asked about: its site is not excluded, and a past one only while past conversations are
// read (conversations from other devices are always read, since 0.6.11)
function queueKindOn(episode, settings) {
  if (isExcluded(new URL(episode.url).hostname, settings.excludedHosts || [])) return false;
  return episode.source !== "past" || Boolean(settings.readPast);
}

// what happens to the episode's conversation (lib/questions.js), as the background decides it
function conversationGoes(episode, settings) {
  return Questions.conversationGoes(episode, isExcluded(new URL(episode.url).hostname, settings.excludedHosts || []));
}

// The conversation of an episode (its turns start..end), for its review: the record's copy once the
// episode ended; while it goes on, its turns in the chat's latest copy, if they are still there
// unchanged (lined up as the background does: older turns may have come in above since)
function reviewMessages(episode, stored) {
  if (episode.messages) return episode.messages;
  if (episode.status !== "open") return [];
  const chat = stored[`chat:${episode.chatKey}`], snapshot = stored[`snap:${episode.chatKey}`];
  const { userTurns, replies } = Episodes.splitTurns(snapshot?.messages || []);
  const shift = Episodes.findOffset(chat?.ids || [], Episodes.turnIds(userTurns), Episodes.expectedOffset(chat, snapshot));
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
  card.dataset.versions = episode.versions ?? 0;         // the answers it was built with (see the listener below)
  card.onsubmit = (event) => event.preventDefault();
  return card;
}

// `asked`: the stage of the question the chat page asked, if this tab was opened from it
function ratingCard(episode, asked, settings) {
  const card = newCard(episode, "rate");
  const questions = [...Questions.RATINGS, ...Questions.DETAILS];
  const answered = episode.versions > 0;
  const confirmed = answered || Boolean(episode.confirmedAt);       // combined mode: Yes in the confirm pop-up
  // the question the chat page asked, else the one that waits (the background corrects a stage
  // that no longer fits, e.g. an episode that ended meanwhile)
  const stage = STAGES.includes(asked) ? asked : Modes.pageDue(episode)?.stage || (answered ? "update" : "first");
  card.innerHTML = `<h2>${Questions.escape(episode.site)} · ${new Date(episode.closedAt || episode.openedAt).toLocaleString()}</h2>
    <p class="meta">It looked like you asked the AI for advice here:</p>${quote(episode.openingText)}
    <div class="confirm" ${confirmed ? "hidden" : ""}><b>Did you ask for advice here?</b> <a class="whatis" href="#advice">what counts as advice?</a><br>
      <button type="button" class="yes">Yes</button> <button type="button" class="secondary no">No</button></div>
    ${answered ? `<p class="meta">Your earlier answers are filled in; please update any that are different now. ${Questions.escape(Questions.UPDATE_NOTE)}</p>` : ""}
    <div class="form" ${confirmed ? "" : "hidden"}>
      ${Questions.render(questions)}
      <p class="meta">${Questions.escape(Questions.CONVERSATION_NOTES[episode.text])}</p>
      <button type="button" class="submit">Submit</button></div>`;
  Questions.fill(card, questions, episode.answers);
  Questions.wire(card, questions);
  card.querySelector(".yes").onclick = () => { card.querySelector(".confirm").hidden = true; card.querySelector(".form").hidden = false; };
  card.querySelector(".no").onclick = async () => {
    answeredHere.add(episode.id);
    await chrome.runtime.sendMessage({ type: "not_advice", id: episode.id });
    card.innerHTML = `<p class="done">${Questions.escape(Questions.NOT_ADVICE_THANKS)}</p>`;
  };
  card.querySelector(".submit").onclick = async () => {
    const { answers, missing } = Questions.read(card, questions);
    if (missing.length) { alert("Please answer all the questions marked *."); return; }
    answeredHere.add(episode.id);
    // (timing: how long the form took, lib/questions.js: it goes with the answers)
    await chrome.runtime.sendMessage({ type: "rating_submitted", id: episode.id, rating: { ...answers, ratedAt: Date.now() },
                                       timing: Questions.timing(card), stage, start: episode.start, end: episode.end, basedOn: episode.versions });
    card.innerHTML = `<p class="done">Thank you.${followupNote(episode, settings)}</p>`;
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
    : answered ? "Your advice conversation continued (for example on your phone or another device). Please update any answer that is different now:"
    : episode.source === "app" ? `On ${when} you had this conversation, which was not recorded as it happened (for example on your phone or another device):`
    : `On ${when} you asked the AI for advice here${ended ? " (this conversation has ended)" : ""}:`;
  // (a past one shows its conversation for review, from the advice request on: showReview below)
  const pastMessages = past ? (episode.messages || []).slice(transcriptFrom(episode.messages || [], episode)) : [];
  card.classList.add("has-queue");
  card.innerHTML = `<h2>${Questions.escape(episode.site)} · ${Questions.escape(when)}${episode.title ? ` · “${Questions.escape(episode.title)}”` : ""}</h2>
    <div class="queue-box"><span class="queue-count" data-site="${Questions.escape(episode.site)}" data-source="${Questions.escape(episode.source || "web")}">${Questions.escape(queueLine(episode))}</span>
      <small>${Questions.escape(QUEUE_SUB)}</small></div>
    <p class="meta intro">${Questions.escape(intro)}</p>${quote(episode.openingText || "")}
    <p class="meta"><a href="${Questions.escape(episode.url)}" target="_blank" rel="noopener">Open this conversation on ${Questions.escape(episode.site)}</a></p>
    ${past ? `<p class="meta"><b>You can earn ${Questions.escape(STUDY_CONFIG.pastReward)} for annotating this past conversation</b>
      (up to ${STUDY_CONFIG.pastLimit} conversations; about 4 to 8 minutes each). If it was not advice, answer No: it is then sent with your No,
      with personal details removed, so we can see what the extension got wrong. Skip is for a conversation you do not want to annotate:
      nothing of it is sent. Both are fine, and never affect your participation. The study team reviews the answers: an annotation of
      low quality is removed and not paid.
      <a href="#" class="stop">Stop asking about past conversations</a></p>` : ""}
    <div class="confirm" ${confirmed ? "hidden" : ""}><b>Did you ask the AI for advice about your own situation in this conversation?</b> <a class="whatis" href="${OUTCOMES ? "checkin.html" : ""}#advice"${OUTCOMES ? ' target="_blank"' : ""}>what counts as advice?</a><br>
      <button type="button" class="yes">Yes</button> <button type="button" class="secondary no">No</button>
      ${past ? '<button type="button" class="secondary skip">Skip this one</button>' : ""}</div>
    ${answered ? `<p class="meta">Your earlier answers are filled in; please update any that are different now. ${Questions.escape(Questions.UPDATE_NOTE)}</p>` : ""}
    <div class="form" ${confirmed ? "" : "hidden"}>
      ${Questions.render(questions)}
      ${pastMessages.length ? REVIEW_BOX : ""}
      <p class="meta">${Questions.escape(Questions.CONVERSATION_NOTES[episode.text] || Questions.CONVERSATION_NOTES.with_answers)}</p>
      <button type="button" class="submit">Submit</button> ${past ? '<button type="button" class="secondary skip">Skip this one</button>' : ""}</div>`;
  Questions.fill(card, questions, episode.answers);
  Questions.wire(card, questions);         // (a past one asks the check-in's questions: "too early to tell" clears the outcome)
  const review = pastMessages.length ? showReview(card, pastMessages) : null;
  // the page counts as asked once it is on the screen (the update rule looks at that)
  chrome.runtime.sendMessage({ type: "rating_shown", id: episode.id, start: episode.start, end: episode.end });
  const done = (text) => { card.innerHTML = `<p class="done">${text}</p>`; };
  card.querySelector(".yes").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "card_answer", id: episode.id, answer: "yes" });
    card.querySelector(".confirm").hidden = true;
    card.querySelector(".form").hidden = false;
  };
  card.querySelector(".no").onclick = async () => {
    answeredHere.add(episode.id);
    await chrome.runtime.sendMessage({ type: "card_answer", id: episode.id, answer: "no" });
    done(Questions.escape(Questions.NOT_ADVICE_THANKS));
  };
  for (const button of card.querySelectorAll(".skip")) {
    button.onclick = async () => {
      answeredHere.add(episode.id);
      await chrome.runtime.sendMessage({ type: "card_answer", id: episode.id, answer: "skip" });
      done("Skipped. This conversation will not be asked about again.");
    };
  }
  card.querySelector(".stop")?.addEventListener("click", async (event) => {
    event.preventDefault();
    if (!confirm("Stop reading your past conversations? Those found and not annotated yet are deleted from this computer.")) return;
    card.dataset.settled = "stopped";              // (its own message stays: see the storage listener)
    const { settings: current = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...current, readPast: false } });
    done("Past conversations are no longer read. You can turn this on again in the settings.");
  });
  card.querySelector(".submit").onclick = async () => {
    const { answers, missing } = Questions.read(card, questions);
    if (missing.length) { alert("Please answer all the questions marked *."); return; }
    if (past) {
      if (review && review.shown === null) return;       // (its conversation is not on the page yet: a moment later)
      answeredHere.add(episode.id);
      const reply = await chrome.runtime.sendMessage({ type: "past_submitted", id: episode.id, answers: { ...answers, answeredAt: Date.now() },
                                                       timing: Questions.timing(card), ...(review ? reviewed(card, review) : {}) });
      // (not taken: it went meanwhile, annotated already here or on another computer, or the limit of past conversations was reached: config.js pastLimit)
      done(reply?.taken === false ? "This past conversation is no longer open: it was annotated already, or the limit of past conversations was reached. Your answers were not sent."
                                  : "Thank you. Your answers and this conversation were sent.");
    } else {
      answeredHere.add(episode.id);
      await chrome.runtime.sendMessage({ type: "rating_submitted", id: episode.id, rating: { ...answers, ratedAt: Date.now() },
                                         timing: Questions.timing(card), stage: decision.stage, start: episode.start, end: episode.end, basedOn: episode.versions });
      done(`Thank you.${followupNote(episode, settings)}`);
    }
  };
  return card;
}

// what comes after the ratings: the follow-up, the follow-up time after the first request (7 days in the
// study; a tester can shorten it on the settings page), unless it began already
function followupNote(episode, settings) {
  if (episode.checkin) return " Its follow-up questions are on your Outcomes page.";
  return ` From about ${Questions.duration(Modes.followupSeconds(settings))} after you first asked, we will ask whether you made a decision and how it went.`;
}

// A conversation as it will be sent ({text, counts}): the background redacts it, since it keeps the table that
// numbers the details removed ([NAME1], [NAME2], ...: lib/redact.js), so the page shows the very text that will go
function redacted(messages) {
  return chrome.runtime.sendMessage({ type: "redact_transcript", messages });
}

// `messages` hold the episode's turns start..end; the conversation that goes starts at the opening (the first
// message that asked for advice): the index of that message
function transcriptFrom(messages, episode) {
  let turn = 0;
  return Math.max(0, messages.findIndex((message) => message.role === "user" && ++turn === episode.opening - episode.start + 1));
}

// ---- the conversation for review (0.6.16) ----
// As the consent form says (step 4): "The Outcomes page also shows you the conversation (your messages and the
// AI's replies) with names, email addresses, phone numbers and similar details already removed. You can delete
// anything else you do not want us to keep. The conversation is then stored on our study server with your
// answers." So the outcome questions of a conversation, and the questions about a past one, come with the
// conversation in a box the participant can edit. What the box holds at Submit goes to the background with the
// answers, with whether it was changed and how long the text was as shown, so the study can tell how much
// participants edit (background.js reviewedTranscript).
const REVIEW_BOX = `<div class="item review"><span class="q">Your conversation, as we will store it</span>
  <p class="meta">This is the conversation (your messages and the AI's replies) with names, e-mail addresses, phone numbers and
    similar details already removed (<span class="removed">…</span>). Each became a numbered label, and the same name gets the
    same label wherever it comes up ([NAME1], [NAME2], ...). <b>You can delete anything else you do not want us to keep</b>: edit
    the text in the box. The conversation is then stored on our study server with your answers.</p>
  <textarea class="transcript"></textarea></div>`;

// Fills the review box of `card` with `messages` as the background redacts them. Returns the review's state:
// `shown` is the text the box was filled with (null until the background has answered).
function showReview(card, messages) {
  const review = { shown: null };
  redacted(messages).then((result) => {
    const box = card.querySelector(".transcript");               // (gone once the card was answered)
    if (!box) return;
    review.shown = result.text;
    box.value = result.text;
    // (how many of each kind: "5 × name, 1 × phone")
    card.querySelector(".removed").textContent = Object.entries(result.counts).map(([kind, count]) => `${count} × ${kind}`).join(", ") || "nothing found";
  });
  return review;
}

// what the review box of `card` holds now, for the message that submits the card's answers
function reviewed(card, review) {
  const transcript = card.querySelector(".transcript").value;
  return { transcript, edited: transcript !== review.shown, shownChars: review.shown.length };
}

// What the participant asked about: their own one-sentence description of the decision, if they gave one;
// else what they asked
function recall(episode) {
  return episode.answers?.decision ? `<p class="meta">In your words, you were asking about:</p>${quote(episode.answers.decision)}`
                                   : `<p class="meta">You asked:</p>${quote(episode.openingText || "")}`;
}

// A conversation whose follow-up is not done (outcomes page), at its stage (lib/modes.js followupStage):
// when it begins, the question it waits for (the same as the pop-up's on the chat page), when it is asked
// again (after "not yet", a planned day, or "too early to tell"), or the outcome questions (checkinCard).
// `all`: the outcome questions whatever the stage (?checkin=all).
// An answer goes to the background, which says what follows (lib/modes.js followupAnswer); the card is then
// built again from the record.
// `askWhen`: the participant just answered "Not yet" to "Did you act?" on this card: it asks when they plan to
function followupCard(episode, episodes, settings, stored, all = false, askWhen = false) {
  const now = Date.now(), end = Modes.studyEnd(stored, STUDY_CONFIG.studyDays);
  const stage = all ? "outcome" : Modes.followupStage(episode, now, end);
  if (stage === "outcome") return checkinCard(episode, episodes, settings, stored);
  const card = newCard(episode, "followup");
  card.dataset.stage = stage;
  const checkin = episode.checkin, decision = checkin.decision || {};
  const day = (at) => Questions.escape(new Date(at).toLocaleDateString());
  // when a waiting follow-up is asked again: at nextAt, or when the study's last week begins if that comes
  // first (then its outcome questions are due: lib/modes.js lastCall)
  const again = () => day(Math.min(checkin.nextAt, Modes.lastCall(checkin, end)));
  // (with two buttons, the first is the secondary one: "Not yet")
  const buttons = (pairs) => pairs.map(([answer, label], index) =>
    `<button type="button" class="${pairs.length > 1 && index === 0 ? "secondary" : ""}" data-answer="${answer}">${Questions.escape(label)}</button>`).join(" ");
  let body;
  if (stage === "later") {
    // (a check-in made before 0.6.9 has no askFrom: its outcome questions come on its day, dueAt)
    body = `<p class="meta">We will ask how this went from ${day(checkin.askFrom ?? checkin.dueAt)}${episode.status === "open" ? ", once the conversation has ended" : ""}.</p>`;
  } else if (stage === "waiting" && Number.isFinite(checkin.dueAt)) {
    // (a wait with a day for the outcome questions is the wait after "too early to tell": lib/modes.js followupAnswer)
    body = `<p class="meta">On ${day(decision.tooEarlyAt ?? decision.at)} it was too early to tell how things turned out. We will ask again on ${again()}.</p>${buttons([["outcome:yes", "I can tell now"]])}`;
  } else if (stage === "waiting" && decision.decided === "no") {
    body = `<p class="meta">You had not decided yet on ${day(decision.at)}. We will ask again on ${again()}.</p>${buttons([["decided:yes", "I have decided now"]])}`;
  } else if (stage === "waiting" && !decision.plannedAt) {
    // ("Later than that, or I am not sure" to "When do you plan to act on it?": asked again a week later)
    body = `<p class="meta">On ${day(decision.at)} you had decided and were not sure when you would act on it. We will ask again on ${again()}.</p>${buttons([["acted:yes", "I have acted on it now"]])}`;
  } else if (stage === "waiting") {
    body = `<p class="meta">You plan to act on your decision by about ${day(decision.plannedAt)}. We will ask again on ${again()}.</p>${buttons([["acted:yes", "I have acted on it now"]])}`;
  } else if (stage === "decided") {
    body = `<p><b>${Questions.escape(Questions.FOLLOWUP.decided)}</b></p>${buttons([["decided:no", "Not yet"], ["decided:yes", "Yes"]])}`;
  } else if (askWhen && decision.acted === "no") {
    // "Not yet" to "did you act?" just now: when they plan to (on a page opened later, "Did you act?" again, as
    // the pop-up asks it)
    body = `<p><b>${Questions.escape(Questions.FOLLOWUP.acted)}</b> Not yet.</p><p><b>${Questions.escape(Questions.FOLLOWUP.when)}</b></p>
      <select name="when">${Questions.ACT_WHEN.map(([value, label]) => `<option value="${value}">${Questions.escape(label)}</option>`).join("")}</select>
      ${buttons([["when:", "OK"]])}`;
  } else {
    body = `<p><b>${Questions.escape(Questions.FOLLOWUP.acted)}</b></p>${buttons([["acted:no", "Not yet"], ["acted:yes", "Yes"]])}`;
  }
  card.innerHTML = `<h2>${Questions.escape(episode.site)} · ${new Date(episode.openedAt).toLocaleDateString()}</h2>${recall(episode)}${body}`;
  // NOTE: [edge case callout] one answer per card: its buttons are disabled once one is clicked, and a card
  // built again waits a moment before it takes a click (a double click would otherwise answer it too)
  const answerButtons = [...card.querySelectorAll("button[data-answer]")];
  for (const button of answerButtons) button.disabled = true;
  setTimeout(() => { for (const button of answerButtons) button.disabled = false; }, 400);
  for (const button of answerButtons) {
    button.onclick = async () => {
      for (const each of answerButtons) each.disabled = true;
      const [step, chosen] = button.dataset.answer.split(":");
      const answer = step === "when" ? card.querySelector('select[name="when"]').value : chosen;
      card.dataset.busy = "yes";                 // (the storage listener leaves it to this answer)
      await chrome.runtime.sendMessage({ type: "followup_answer", id: episode.id, step, answer, where: "page" });
      await rebuildFollowup(episode.id, step === "acted" && answer === "no");
    };
  }
  return card;
}

// The follow-up card of an episode built again from its record as stored now (after an answer here, or
// one given in the pop-up meanwhile); a follow-up that is done or gone says so
async function rebuildFollowup(id, askWhen = false) {
  // (its outcome questions' card, when "too early to tell" put them off)
  const card = document.getElementById(`card-followup-${id}`) || document.getElementById(`card-checkin-${id}`);
  if (!card) return;
  const stored = await chrome.storage.local.get(null);
  const episode = stored[`episode:${id}`];
  if (!episode || !Modes.followupStage(episode, Date.now(), Modes.studyEnd(stored, STUDY_CONFIG.studyDays))) {
    card.innerHTML = '<p class="done">This follow-up is no longer open.</p>';
    return;
  }
  const episodes = Object.entries(stored).filter(([name]) => name.startsWith("episode:")).map(([, record]) => record);
  episode.text = conversationGoes(episode, stored.settings || {});
  card.replaceWith(followupCard(episode, episodes, stored.settings || {}, stored, false, askWhen));
}

// The outcome questions of a conversation: the end of its follow-up.
// NOTE: [design thought] "It is too early to tell" completes the check-in only in the study's last week, when
// the outcome questions are due whatever happened (lib/modes.js finalCall): the form then has its check box.
// Before that it is a button that puts the questions off by two days (the background: followupAnswer), so
// the conversation stays on this page as unanswered and the reminders go on. Where the background would not
// take the button (?checkin=all shows the questions at any stage), the form keeps the check box.
function checkinCard(episode, episodes, settings, stored) {
  const card = newCard(episode, "checkin");
  const now = Date.now(), end = Modes.studyEnd(stored, STUDY_CONFIG.studyDays);
  const final = Modes.finalCall(episode.checkin, now, end);
  const canDefer = !final && Modes.followupStage(episode, now, end) === "outcome";
  const questions = canDefer ? Questions.CHECKIN.filter((item) => item.key !== "too_early") : Questions.CHECKIN;
  const later = episodes.filter((other) => (other.related || []).includes(episode.id)).length;
  const days = Math.round((Date.now() - episode.openedAt) / 86400000);
  // (a tester's short follow-up time brings the check-in on the same day)
  const ago = days < 1 ? "Earlier today" : days === 1 ? "Yesterday" : `About ${days} days ago`;
  // its conversation for review (0.6.16): from the advice request on, as it went with the quick answers. None
  // when the text stays on this computer (an excluded site), or when the record does not hold it.
  const turns = episode.text === "stays" ? [] : reviewMessages(episode, stored);
  const messages = turns.slice(transcriptFrom(turns, episode));
  card.innerHTML = `<h2>${Questions.escape(episode.site)} · ${new Date(episode.openedAt).toLocaleDateString()}</h2>
    <p>${ago} you asked an AI assistant for advice. What happened since?</p>${recall(episode)}
    ${later ? `<p class="meta">Since then you had ${later} more conversation(s) that looked related to this one.</p>` : ""}
    ${final ? `<p class="meta"><b>These answers are due by ${Questions.escape(new Date(end).toLocaleDateString())}, the end of your study</b>, even if you
      have not acted yet or it is too early to tell how things turned out.</p>` : ""}
    ${canDefer ? `<p class="meta">Is it too early to tell how things turned out?
      <button type="button" class="secondary early">Too early to tell: ask me again in ${Modes.ASK_AGAIN_DAYS} days</button></p>` : ""}
    ${Questions.render(questions)}
    ${messages.length ? REVIEW_BOX : ""}
    <button type="button" class="submit">Submit check-in</button>`;
  Questions.wire(card, questions);
  const review = messages.length ? showReview(card, messages) : null;
  const early = card.querySelector(".early");
  if (early) {
    early.onclick = async () => {
      card.dataset.busy = "yes";                  // (the storage listener leaves it to this answer)
      await chrome.runtime.sendMessage({ type: "followup_answer", id: episode.id, step: "outcome", answer: "early", where: "page" });
      await rebuildFollowup(episode.id);
    };
  }
  card.querySelector(".submit").onclick = async () => {
    const { answers, missing } = Questions.read(card, questions);
    if (missing.length) { alert("Please answer all the questions marked *."); return; }
    if (review && review.shown === null) return;  // (its conversation is not on the page yet: a moment later)
    card.dataset.settled = "answered";            // (the storage listener leaves this card alone)
    // (too_early: empty when the form had no such box, so every check-in holds the same answers; timing: how
    // long the form took, lib/questions.js)
    await chrome.runtime.sendMessage({ type: "checkin_submitted", id: episode.id, answers: { too_early: [], ...answers, answeredAt: Date.now() },
                                       timing: Questions.timing(card), ...(review ? reviewed(card, review) : {}) });
    card.innerHTML = '<p class="done">Thank you, that completes this conversation.</p>';
  };
  return card;
}

main();
if (OUTCOMES) {
  renderReading();
  setInterval(renderReading, 60000);         // (a pause the site asked for runs out; a tab was opened)
}

// ---- how reading past conversations goes (0.6 opt-in): one line per site, in plain words ----
// The background keeps each site's reading state in storage (hstate:<host>: a pause the site asked for,
// signed out, another account, blocked; hlist:<host>: the conversations listed; hist:<host>/<id>: the
// ones read). Nothing else shows it to the participant, so a reading that stopped would otherwise look
// like one that found nothing. The same words the study team sees in the heartbeat (background.js
// historyStates), spelled out with what to do.
async function readingStatus(stored) {
  const settings = { ...stored.settings }, now = Date.now();
  const lines = [];
  // (the sites are read for conversations from other devices too, but this box belongs to the past conversations:
  // while their reading is off, the past list says so, and the box is not shown)
  if (!settings.readPast) return null;
  const excluded = (host) => (settings.excludedHosts || []).some((entry) => host === entry || host.endsWith(`.${entry}`));
  const config = stored.hconfig || {};
  const time = (at) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  for (const host of STUDY_CONFIG.historySites || []) {
    const name = SITE_CONFIGS[host]?.name || host;
    const state = stored[`hstate:${host}`] || null;
    const list = stored[`hlist:${host}`] || null;
    const read = Object.keys(stored).filter((key) => key.startsWith(`hist:${host}/`)).length;
    const found = Object.values(stored).filter((record) => record && record.site === name && record.source === "past" && record.chatKey).length;
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: `https://${host}/*` }); } catch (error) { /* no tab access: say nothing about tabs */ }
    let kind = "state", text;
    if (!settings.participantId) text = "not started: enter your participant ID in the settings";
    else if (settings.paused) text = "paused (resume tracking from the extension's icon)";
    else if (excluded(host)) text = "off: you excluded this site";
    else if (config.history?.[host] === false) text = "switched off by the study team for now";
    else if (state?.blocked) { kind = "warn"; text = "stopped by the site until Chrome is restarted"; }
    // (only the account first read on a site is read: background.js historyReply)
    else if (state?.otherAccount) { kind = "warn"; text = "stopped: another account or workspace is open. Please switch back to the account first read here and refresh the page"; }
    else if (state?.signedOut) { kind = "warn"; text = "stopped: signed out. Please sign in and refresh the page"; }
    else if ((state?.waitUntil ?? 0) > now && state?.backoffMs) text = `paused by the site until ${time(state.waitUntil)}`;
    // (any one tab answering is enough: the background tries each until one does)
    else if (state?.noAnswer || (state?.waitUntil ?? 0) > now) { kind = "warn"; text = tabs.length > 1 ? `please refresh one of your ${tabs.length} ${name} tabs` : `please refresh your ${name} tab`; }
    // a site with no tab and nothing read yet is one the participant may not use: not listed
    else if (!tabs.length && !state && !list) continue;
    else if (!tabs.length) text = "not open right now";
    // (Chrome puts an unused tab to sleep; the background skips it, as it cannot answer)
    else if (tabs.every((tab) => tab.discarded)) {
      text = tabs.length > 1 ? `your ${tabs.length} ${name} tabs are asleep: please click one to wake it up` : `your ${name} tab is asleep: please click it to wake it up`;
    }
    else if (!list) text = "waiting its turn";
    else {
      kind = "ok";
      const listed = list.items?.length ?? 0, checked = Math.min(read, listed);
      text = `${list.end && checked >= listed ? "done" : "reading"}: ${checked}/${listed} conversations checked for advice. ${found} advice detected.`;
    }
    lines.push({ name, kind, text });
  }
  const names = (STUDY_CONFIG.historySites || []).map((host) => SITE_CONFIGS[host]?.name || host);
  return { lines, note: lines.length ? null : `Open ${names.slice(0, -1).join(", ")} or ${names.at(-1)} to start.` };
}

// (also the "1/N awaiting labeling" lines of the queue cards, on both pages; the reading box is on the outcomes page)
async function renderReading() {
  const stored = await chrome.storage.local.get(null);
  const onScreen = new Set([...document.querySelectorAll(".card.has-queue")].filter((card) => !card.dataset.settled).map((card) => card.id.replace(/^card-item-/, "")));
  queueCounts = countQueued(Object.entries(stored).filter(([name]) => name.startsWith("episode:")).map(([, episode]) => episode), stored.settings || {}, onScreen);
  for (const line of document.querySelectorAll(".queue-count")) line.textContent = queueLine({ site: line.dataset.site, source: line.dataset.source });
  const box = document.getElementById("reading");
  if (!box) return;
  const status = await readingStatus(stored);
  box.hidden = !status;
  if (!status) return;
  const { lines, note } = status;
  box.innerHTML = `<h2>Past conversations status</h2>` +
    (lines.length ? `<ul>${lines.map((line) => `<li><b>${Questions.escape(line.name)}</b> <span class="${line.kind}">${Questions.escape(line.text)}</span></li>`).join("")}</ul>` : "") +
    (note ? `<p class="note">${Questions.escape(note)}</p>` : "");
}

// NOTE: [edge case callout] this tab can stay open while the participant deals with the same question
// elsewhere (on the chat page, or in another tab). A card whose episode was answered there with nothing
// new since says so instead of asking again (its answers would be refused as stale); one answered there
// about an older turn is built again on those answers; one whose question is gone (removed, deleted,
// no longer read) says it is no longer open. Answers given on this tab's own cards are in answeredHere.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) pageSettings = changes.settings.newValue || {};
  if (Object.keys(changes).some((name) => /^(settings|hconfig|hstate:|hlist:|hist:|qstate:|episode:)/.test(name))) renderReading();
  for (const [name, change] of Object.entries(changes)) {
    if (!name.startsWith("episode:")) continue;
    const id = name.slice("episode:".length), episode = change.newValue;
    // a check-in submitted in another tab: this copy of it says so (the background takes one only)
    const checkin = document.getElementById(`card-checkin-${id}`);
    if (checkin && !checkin.dataset.settled && (!episode || episode.status === "removed" || episode.checkin?.doneAt)) {
      checkin.dataset.settled = "elsewhere";
      checkin.innerHTML = `<p class="done">${episode?.checkin?.doneAt ? "This check-in was already answered elsewhere: nothing more to do here."
                                                                        : "This check-in is no longer open."}</p>`;
    }
    // its outcome questions were put off elsewhere ("too early to tell" in the pop-up on a chat page): the card shows the wait
    if (checkin && !checkin.dataset.settled && !checkin.dataset.busy && episode?.checkin && !episode.checkin.doneAt &&
        episode.checkin.dueAt !== change.oldValue?.checkin?.dueAt) rebuildFollowup(id);
    // a follow-up answered elsewhere (the pop-up on a chat page): its card moves to the stage it is at now
    const followup = document.getElementById(`card-followup-${id}`);
    if (followup && !followup.dataset.busy && (!episode || episode.checkin?.decision?.at !== change.oldValue?.checkin?.decision?.at ||
                                               episode.checkin?.dueAt !== change.oldValue?.checkin?.dueAt)) rebuildFollowup(id);
    if (answeredHere.has(id)) continue;
    for (const kind of ["rate", "item"]) {
      const card = document.getElementById(`card-${kind}-${id}`);
      if (!card || card.dataset.settled) continue;
      // NOTE: [edge case callout] a finished episode takes no more answers (the background ignores
      // them): e.g. its final answers still waited on this page when its check-in was submitted
      if (!episode || episode.status === "removed" || episode.status === "done") {
        card.dataset.settled = "gone";
        card.innerHTML = episode?.status === "done" && episode.checkin?.doneAt
          ? '<p class="done">Your check-in completed this conversation: no more answers are needed here.</p>'
          : '<p class="done">This question is no longer open.</p>';
      } else if (episode.versions !== Number(card.dataset.versions)) {
        if (!Modes.stillDue(episode)) {
          card.dataset.settled = "elsewhere";
          card.innerHTML = '<p class="done">Already answered elsewhere: nothing more to do here.</p>';
        } else {
          episode.text = conversationGoes(episode, pageSettings);
          card.replaceWith(kind === "rate" ? ratingCard(episode, null, pageSettings) : itemCard(episode, pageSettings, Date.now()));
        }
      }
    }
  }
});
