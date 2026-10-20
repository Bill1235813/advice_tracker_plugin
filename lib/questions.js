// The study's questions, in one place: the rating panel on the chat page (content/rating_panel.js)
// and the extension's check-in page (ui/checkin.js) both build their forms from these lists, so
// the wording cannot drift apart. Items follow the IRB protocol: three ratings and five details
// when the participant is asked about an episode, and the day-14 check-in. Every question must be
// answered (participants are paid for answering them); two check-in questions only when they apply.
// Each item: {key, text, type: "scale" | "select" | "text" | "checks", options, required,
//   unless: <key>            not needed when that check box is ticked ("It is too early to tell"),
//   onlyIf: {key, values}}   needed only when that answer is one of the values
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

  // day 14: outcome, feelings, the AI's role, looking back
  const CHECKIN = [
    { key: "followed", type: "select", required: true, text: "Did you follow the advice?",
      options: [["fully", "Yes, fully"], ["partly", "Yes, partly"], ["plan", "Not yet, but I plan to"], ["against", "No, I decided against it"],
                ["changed", "No, the situation changed or resolved itself"], ["forgot", "No, I forgot about it"]] },
    { key: "did", type: "text", required: true, text: "What did you actually do, or decide? (1-3 sentences)" },
    { key: "outcome", type: "scale", required: true, unless: "too_early", text: "So far, how has the situation turned out?",
      options: ["Much worse", "Somewhat worse", "About the same", "Somewhat better", "Much better"] },
    { key: "too_early", type: "checks", text: "", options: [["yes", "It is too early to tell"]] },
    // same wording as Session 2 of the user study (surveys/user_study_survey), for comparison
    { key: "feel_better", type: "scale", required: true, onlyIf: { key: "followed", values: ["fully", "partly"] }, options: AGREE,
      text: "Did the advice you followed make you feel better? (skip if you did not follow it)" },
    { key: "ai_role", type: "select", required: true, text: "How much did the AI conversation shape what you decided?",
      options: [["deciding", "It was the deciding factor"], ["one_input", "One input among several"], ["small", "A small influence"],
                ["none", "No influence"], ["undecided", "I have not decided yet"]] },
    { key: "sources", type: "checks", required: true, text: "Since then, who or what else have you asked about it?",
      options: [["people", "Friends or family"], ["professional", "A professional"], ["web", "Web search or online communities"],
                ["same_ai", "The same AI assistant again"], ["other_ai", "A different AI assistant"], ["no_one", "No one"]] },
    ...RATINGS.map((item) => ({ ...item, key: `again_${item.key}`, text: `Thinking back now: ${item.text}` })),
    { key: "opinion", type: "select", required: true, text: "Has your opinion of the advice changed since you got it?",
      options: [["worse", "It looks worse now"], ["same", "About the same"], ["better", "It looks better now"]] },
    { key: "comment", type: "text", required: true,
      text: "Anything unexpected, or anything else you want to tell us? (write “no” if there is nothing)" },
  ];

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
      return `<div class="item">${question}${input}</div>`;
    }).join("");
  }

  // The answers in `container` as {key: value}: a number (scales), a string (selects and text,
  // "" when skipped), or a list (checkboxes). Also returns the required items left empty.
  function read(container, items) {
    const answers = {};
    for (const item of items) {
      if (item.type === "scale") {
        const checked = container.querySelector(`input[name="${item.key}"]:checked`);
        answers[item.key] = checked ? Number(checked.value) : null;
      } else if (item.type === "checks") {
        answers[item.key] = [...container.querySelectorAll(`input[name="${item.key}"]:checked`)].map((box) => box.value);
      } else {
        answers[item.key] = container.querySelector(`[name="${item.key}"]`).value.trim();
      }
    }
    // NOTE: [design thought] a second pass, because whether an item is needed can depend on an
    // answer further down the form ("It is too early to tell" sits below the outcome scale)
    const empty = (value) => value === null || value === "" || (Array.isArray(value) && !value.length);
    const needed = (item) => item.required && !(item.unless && !empty(answers[item.unless])) &&
                             !(item.onlyIf && !item.onlyIf.values.includes(answers[item.onlyIf.key]));
    const missing = items.filter((item) => needed(item) && empty(answers[item.key])).map((item) => item.key);
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

  // The conversation as it will be sent, for the review box of the check-in of an episode from
  // 0.4 (whose conversation was to be sent only after this review): every message of the
  // episode, redacted (lib/redact.js must be loaded). Returns {text, counts} with the number of each
  // kind of detail removed.
  function transcript(messages, names) {
    const redacted = Redact.redactMessages(messages || [], names);
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

  // A time in words, in the largest unit that fits it exactly: 1209600 -> "14 days", 120 -> "2 minutes"
  // (the follow-up time, which a test can set in seconds)
  function duration(seconds) {
    const units = [["day", 24 * 3600], ["hour", 3600], ["minute", 60], ["second", 1]];
    const [name, size] = units.find(([, size]) => seconds % size === 0) || units[units.length - 1];
    const count = seconds / size;
    return `${count} ${name}${count === 1 ? "" : "s"}`;
  }

  const api = { RATINGS, DETAILS, CHECKIN, PAST, DOMAINS, render, read, fill, transcript, escape, conversationGoes, CONVERSATION_NOTES,
                duration };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Questions = api;
})(typeof self !== "undefined" ? self : globalThis);
