// The study's questions, in one place: the rating panel on the chat page (content/rating_panel.js)
// and the extension's check-in page (ui/checkin.js) both build their forms from these lists, so
// the wording cannot drift apart. Items follow the IRB protocol: three ratings and five details
// when the participant is asked about an episode, and the outcome questions of its follow-up. Every
// question must be answered (participants are paid for answering them); two outcome questions only
// when they apply.
// Each item: {key, text, type: "scale" | "select" | "text" | "checks", options, required,
//   unless: <key>            not needed when that check box is ticked ("It is too early to tell"),
//   onlyIf: {key, values},   needed only when that answer is one of the values
//   exclusive: [values]}     check boxes that cannot be ticked together with others ("No one")
// An item that does not apply (unless, onlyIf) is answered null: wire() disables or hides it on the
// form, and read() drops an answer it still holds (one chosen before the answer it depends on changed).
(function (root) {
  const EXTENT = ["Not at all", "Slightly", "Moderately", "Very", "Extremely"];
  const AGREE = ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"];

  const RATINGS = [
    { key: "helpful", type: "scale", options: EXTENT, required: true,
      text: "Helpful: how helpful was the AI's advice for your situation?" },
    { key: "trust", type: "scale", options: EXTENT, required: true,
      text: "Trust: how much do you trust the advice you were given?" },
    { key: "harmful", type: "scale", options: EXTENT, required: true,
      text: "Potentially harmful: could following the advice hurt you or someone else?" },
  ];

  // the related-work domains (value = what is uploaded, label = what the participant sees)
  const DOMAINS = [["relationships", "Relationships"], ["career", "Career or work"], ["personal_development", "Personal development"],
                   ["financial", "Money and finances"], ["legal", "Legal matters"], ["health", "Health and wellness"],
                   ["parenting", "Parenting"], ["ethics", "Ethics and morality"], ["other", "Something else"]];

  const DETAILS = [
    { key: "decision", type: "text", required: true, text: "In one sentence, what decision or situation were you asking about?" },
    { key: "domain", type: "select", required: true, options: DOMAINS, text: "Which area of your life is it about?" },
    { key: "advice_received", type: "select", required: true, text: "Did the assistant recommend what to do?",
      options: [["clear", "Yes, clear advice"], ["options", "Partly: it discussed options without recommending one"], ["none", "No"]] },
    { key: "intent", type: "scale", required: true, options: ["Very unlikely", "Unlikely", "Not sure", "Likely", "Very likely"],
      text: "How likely are you to act on it in the next two weeks?" },
    { key: "decided", type: "select", required: true, text: "Had you already made up your mind before asking?",
      options: [["undecided", "No, I was genuinely undecided"], ["leaning", "I was leaning one way"],
                ["decided", "Mostly decided, I wanted a second opinion"], ["execute", "Decided, I wanted help carrying it out"]] },
  ];

  // The outcome questions (the end of the follow-up): outcome, feelings, the AI's role, looking back.
  // "It is too early to tell" (too_early) is on the form only in the study's last week and for a past
  // conversation; before that the participant says it with a button and is asked again two days later
  // (0.6.14, ui/checkin.js checkinCard)
  // (0.6.15: the first question also asks about a plan, and its answers say what the advice did to the decision
  // the participant had in mind: reinforced it, changed it, followed only in part; the second one asks why)
  const FOLLOWED = ["reinforced", "ai_changed", "partly"];       // the answers that say the advice was followed
  const CHECKIN = [
    { key: "followed", type: "select", required: true, text: "Did you follow or plan to follow the advice?",
      options: [["reinforced", "Yes, the AI reinforced my initial decision, and I followed my initial decision"],
                ["ai_changed", "Yes, the AI changed my decision somehow"], ["partly", "Yes, but only partly"],
                ["against", "No, I decided against it"], ["changed", "No, the situation changed or resolved itself"]] },
    { key: "did", type: "text", required: true, text: "What did you actually do, or decide, and why? (1-3 sentences)" },
    { key: "outcome", type: "scale", required: true, unless: "too_early", text: "So far, how has the situation turned out?",
      options: ["Much worse", "Somewhat worse", "About the same", "Somewhat better", "Much better"] },
    { key: "too_early", type: "checks", text: "", options: [["yes", "It is too early to tell"]] },
    // Session 2 of the user study (surveys/user_study_survey) asks "Did the advice you followed make you
    // feel better?"; here it is a statement, as the agree/disagree scale it is answered on needs (0.6.9).
    // It is shown only when the advice was followed (onlyIf)
    { key: "feel_better", type: "scale", required: true, onlyIf: { key: "followed", values: FOLLOWED }, options: AGREE,
      text: "Following the advice made me feel better." },
    { key: "ai_role", type: "select", required: true, text: "How much did the AI conversation shape what you decided?",
      options: [["deciding", "It was the deciding factor"], ["one_input", "One input among several"], ["small", "A small influence"],
                ["none", "No influence"], ["undecided", "I have not decided yet"]] },
    { key: "sources", type: "checks", required: true, exclusive: ["no_one"], text: "Since then, who or what else have you asked about it?",
      options: [["people", "Friends or family"], ["professional", "A professional"], ["web", "Web search or online communities"],
                ["same_ai", "The same AI assistant again"], ["other_ai", "A different AI assistant"], ["no_one", "No one"]] },
    ...RATINGS.map((item) => ({ ...item, key: `again_${item.key}`, text: `Thinking back now: ${item.text}` })),
    { key: "opinion", type: "select", required: true, text: "Has your opinion of the advice changed since you got it?",
      options: [["worse", "It looks worse now"], ["same", "About the same"], ["better", "It looks better now"]] },
    { key: "comment", type: "text", required: true,
      text: "Anything unexpected, or anything else you want to tell us? (write “no” if there is nothing)" },
  ];

  // The follow-up (0.6.9), from a week after the request, one question at a time (a small pop-up on the
  // chat page, or the outcomes page): did they decide, did they act, and if not yet, when they plan to.
  // Then the outcome questions (CHECKIN). lib/modes.js followupAnswer decides what follows each answer;
  // the keys of ACT_WHEN are those of Modes.ACT_DAYS (in how many days).
  const FOLLOWUP = {
    decided: "Did you make a decision yet?",
    acted: "Did you act on this decision yet?",
    when: "When do you plan to act on it?",
  };
  const ACT_WHEN = [["days", "In the next few days"], ["week", "Within a week"], ["weeks", "Within two weeks"],
                    ["month", "Within a month"], ["later", "Later than that, or I am not sure"]];

  // A past conversation (from before the participant joined the study, found with their permission):
  // a variation of the check-in, asked once, at least the follow-up time after the request. Nothing was
  // asked about it at the time, so it first asks what the advice was about (four of the details),
  // then how things went and how the advice looks now (the check-in's questions).
  const PAST = [
    ...DETAILS.filter((item) => ["decision", "domain", "advice_received"].includes(item.key)),
    { ...DETAILS.find((item) => item.key === "decided"), text: "Before asking, had you already made up your mind?" },
    ...CHECKIN,
  ];

  function escape(text) {
    return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // HTML for a list of items; every input is named after its item's key
  function render(items) {
    return items.map((item) => {
      const mark = item.required ? ' <span class="req">*</span>' : "";
      const question = item.text ? `<span class="q">${escape(item.text)}${mark}</span>` : "";
      let input = "";
      if (item.type === "scale") {
        input = `<div class="scale">${item.options.map((label, i) =>
          `<label><input type="radio" name="${item.key}" value="${i + 1}">${i + 1}<br>${escape(label)}</label>`).join("")}</div>`;
      } else if (item.type === "select") {
        input = `<select name="${item.key}"><option value="">choose…</option>${item.options.map(([value, label]) =>
          `<option value="${value}">${escape(label)}</option>`).join("")}</select>`;
      } else if (item.type === "text") {
        input = `<textarea name="${item.key}" rows="2"></textarea>`;
      } else {
        input = `<div class="checks">${item.options.map(([value, label]) =>
          `<label><input type="checkbox" name="${item.key}" value="${value}"> ${escape(label)}</label>`).join("")}</div>`;
      }
      return `<div class="item" data-key="${item.key}">${question}${input}</div>`;
    }).join("");
  }

  const empty = (value) => value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length);
  // the item does not apply, given the other answers: its `unless` box is ticked, or its `onlyIf` answer
  // is not one of the values
  const notApplicable = (item, answers) => Boolean((item.unless && !empty(answers[item.unless])) ||
                                                   (item.onlyIf && !item.onlyIf.values.includes(answers[item.onlyIf.key])));

  // The current answers in `container`, without checking anything (see read)
  function collect(container, items) {
    const answers = {};
    for (const item of items) {
      if (item.type === "scale") {
        const checked = container.querySelector(`input[name="${item.key}"]:checked`);
        answers[item.key] = checked ? Number(checked.value) : null;
      } else if (item.type === "checks") {
        answers[item.key] = [...container.querySelectorAll(`input[name="${item.key}"]:checked`)].map((box) => box.value);
      } else {
        answers[item.key] = container.querySelector(`[name="${item.key}"]`)?.value.trim() ?? "";
      }
    }
    return answers;
  }

  // How long the participant took over the form in `container` (0.6.14: the study team reviews answers
  // that were filled in very fast): when wire() put it on the screen, when the first answer was finished
  // (the first `change`) and when the last one was made, and the seconds between these two. An update
  // submitted without a change has no first answer (null).
  const timings = new WeakMap();
  function timing(container) {
    const { shownAt = null, firstAt = null, lastAt = null } = timings.get(container) ?? {};
    return { shown_at: shownAt, first_answer_at: firstAt, last_answer_at: lastAt, submitted_at: Date.now(),
             seconds: firstAt === null ? null : Math.round((lastAt - firstAt) / 100) / 10 };
  }

  // Keep a rendered form consistent while it is filled in (call once after render and fill):
  // - an item with `unless` is cleared and disabled while its box is ticked ("It is too early to tell"
  //   clears and locks "So far, how has the situation turned out?");
  // - an item with `onlyIf` is shown only while it applies, and cleared when it is hidden;
  // - an `exclusive` check box unticks the item's other boxes, and they untick it.
  // NOTE: [design thought] without this, an answer chosen before the one it depends on changed stays
  // on the form and was sent with it (an outcome together with "too early to tell")
  // It also notes how long the form takes (timing above).
  function wire(container, items) {
    const times = { shownAt: Date.now(), firstAt: null, lastAt: null };
    timings.set(container, times);
    // (a keystroke in a text box: its `change` comes only when the box is left)
    container.addEventListener("input", () => { times.lastAt = Date.now(); });
    const inputs = (key) => [...container.querySelectorAll(`[name="${key}"]`)];
    const clear = (key) => {
      for (const input of inputs(key)) {
        if (input.type === "radio" || input.type === "checkbox") input.checked = false;
        else input.value = "";
      }
    };
    const apply = () => {
      const answers = collect(container, items);
      for (const item of items) {
        if (!item.unless && !item.onlyIf) continue;
        const box = container.querySelector(`.item[data-key="${item.key}"]`);
        const off = notApplicable(item, answers);
        if (off) clear(item.key);
        for (const input of inputs(item.key)) input.disabled = off;
        if (box) {
          box.classList.toggle("na", off);
          if (item.onlyIf) box.hidden = off;
        }
      }
    };
    container.addEventListener("change", (event) => {
      times.firstAt ??= Date.now();
      times.lastAt = Date.now();
      const target = event.target;
      const item = items.find((entry) => entry.key === target?.name);
      if (item?.exclusive && target.type === "checkbox" && target.checked) {
        const alone = item.exclusive.includes(target.value);
        for (const box of inputs(item.key)) {
          if (box !== target && (alone || item.exclusive.includes(box.value))) box.checked = false;
        }
      }
      apply();
    });
    apply();
  }

  // The answers in `container` as {key: value}: a number (scales), a string (selects and text,
  // "" when skipped), or a list (checkboxes). Also returns the required items left empty.
  // An item that does not apply is answered null, whatever the form still holds for it.
  function read(container, items) {
    const answers = collect(container, items);
    // NOTE: [design thought] a second pass, because whether an item is needed can depend on an
    // answer further down the form ("It is too early to tell" sits below the outcome scale)
    const off = new Set(items.filter((item) => notApplicable(item, answers)).map((item) => item.key));
    for (const key of off) answers[key] = null;
    const missing = items.filter((item) => item.required && !off.has(item.key) && empty(answers[item.key])).map((item) => item.key);
    return { answers, missing };
  }

  // Put earlier answers back into a rendered form, so the participant can update them.
  function fill(container, items, answers) {
    for (const item of items) {
      const value = answers?.[item.key];
      if (value === null || value === undefined || value === "") continue;
      if (item.type === "scale") {
        const input = container.querySelector(`input[name="${item.key}"][value="${value}"]`);
        if (input) input.checked = true;
      } else if (item.type === "checks") {
        for (const box of container.querySelectorAll(`input[name="${item.key}"]`)) box.checked = value.includes(box.value);
      } else {
        const field = container.querySelector(`[name="${item.key}"]`);
        if (field) field.value = value;
      }
    }
  }

  // The conversation as it will be sent, for a page that shows it before it goes (a past conversation's
  // card; the review box of the check-in of an episode from 0.4, whose conversation was to be sent only
  // after this review): every message of the episode, redacted (lib/redact.js must be loaded). Returns
  // {text, counts} with the number of each kind of detail removed.
  // (`numbers`: the table of numbered placeholders, lib/redact.js; the background keeps it, so the pages
  // ask the background for this text: message "redact_transcript")
  function transcript(messages, names, numbers = null) {
    const redacted = Redact.redactMessages(messages || [], names, numbers);
    return { text: redacted.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"), counts: redacted.counts };
  }

  // What happens to an episode's conversation: "with_answers" (sent with the answers, and once
  // more, complete, when the episode ends; redacted), "at_checkin" (an episode from 0.4: shown for
  // review at its check-in and sent then), or "stays" (never sent: its site is excluded, its
  // answers were held or deleted before 0.5, or it is from 0.3, which asked what to share when it
  // was rated). background.js acts on it; the notes under the questions say it.
  function conversationGoes(record, siteExcluded) {
    if (record.keepText || record.heldAnswers || siteExcluded) return "stays";
    return record.reviewAtCheckin ? "at_checkin" : "with_answers";
  }
  const CONVERSATION_NOTES = {
    with_answers: "Your answers are sent with this conversation, from the message above on, with names and other personal details removed.",
    at_checkin: "Your answers are sent now; this conversation is shown to you at the two-week check-in and sent only after your review there.",
    stays: "Only your answers are sent; this conversation stays on your computer.",
  };

  // Two things the pages say in more than one place (0.6.14):
  // - after "No" to "Did you ask for advice here?": the conversation is not asked about again. (It goes to the
  //   study with that answer, redacted: what the extension took for advice and the participant did not.)
  // - with earlier answers to update: updating is encouraged, not required, and the study team reviews it later
  const NOT_ADVICE_THANKS = "Thank you. We will not ask about this conversation again.";
  const UPDATE_NOTE = "Updating is encouraged, not required. We review the answers later: answers that clearly needed an update and were " +
                      "left as they were may be flagged as low quality.";

  // A time in words, in the largest unit that fits it exactly: 1209600 -> "14 days", 120 -> "2 minutes"
  // (the follow-up time, which a test can set in seconds)
  function duration(seconds) {
    const units = [["day", 24 * 3600], ["hour", 3600], ["minute", 60], ["second", 1]];
    const [name, size] = units.find(([, size]) => seconds % size === 0) || units[units.length - 1];
    const count = seconds / size;
    return `${count} ${name}${count === 1 ? "" : "s"}`;
  }

  const api = { RATINGS, DETAILS, CHECKIN, PAST, DOMAINS, FOLLOWUP, ACT_WHEN, render, read, fill, wire, timing, notApplicable, transcript, escape,
                conversationGoes, CONVERSATION_NOTES, NOT_ADVICE_THANKS, UPDATE_NOTE, duration };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Questions = api;
})(typeof self !== "undefined" ? self : globalThis);
