// The study's questions, in one place: the rating panel on the chat page (content/rating_panel.js)
// and the extension's check-in page (ui/checkin.js) both build their forms from these lists, so
// the wording cannot drift apart. Items follow the IRB protocol: three required ratings when an
// episode ends, optional items after them, and the day-14 check-in.
// Each item: {key, text, type: "scale" | "select" | "text" | "checks", options, required}.
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

  const OPTIONAL = [
    { key: "decision", type: "text", text: "In one sentence, what decision or situation were you asking about?" },
    { key: "domain", type: "select", options: DOMAINS, text: "Which area of your life is it about?" },
    { key: "advice_received", type: "select", text: "Did the assistant recommend what to do?",
      options: [["clear", "Yes, clear advice"], ["options", "Partly: it discussed options without recommending one"], ["none", "No"]] },
    { key: "intent", type: "scale", options: ["Very unlikely", "Unlikely", "Not sure", "Likely", "Very likely"],
      text: "How likely are you to act on it in the next two weeks?" },
    { key: "decided", type: "select", text: "Had you already made up your mind before asking?",
      options: [["undecided", "No, I was genuinely undecided"], ["leaning", "I was leaning one way"],
                ["decided", "Mostly decided, I wanted a second opinion"], ["execute", "Decided, I wanted help carrying it out"]] },
  ];

  // day 14: outcome, feelings, the AI's role, looking back
  const CHECKIN = [
    { key: "followed", type: "select", required: true, text: "Did you follow the advice?",
      options: [["fully", "Yes, fully"], ["partly", "Yes, partly"], ["plan", "Not yet, but I plan to"], ["against", "No, I decided against it"],
                ["changed", "No, the situation changed or resolved itself"], ["forgot", "No, I forgot about it"]] },
    { key: "did", type: "text", required: true, text: "What did you actually do, or decide? (1-3 sentences)" },
    { key: "outcome", type: "scale", text: "So far, how has the situation turned out?",
      options: ["Much worse", "Somewhat worse", "About the same", "Somewhat better", "Much better"] },
    { key: "too_early", type: "checks", text: "", options: [["yes", "It is too early to tell"]] },
    // same wording as Session 2 of the user study (surveys/user_study_survey), for comparison
    { key: "feel_better", type: "scale", options: AGREE,
      text: "Did the advice you followed make you feel better? (skip if you did not follow it)" },
    { key: "ai_role", type: "select", text: "How much did the AI conversation shape what you decided?",
      options: [["deciding", "It was the deciding factor"], ["one_input", "One input among several"], ["small", "A small influence"],
                ["none", "No influence"], ["undecided", "I have not decided yet"]] },
    { key: "sources", type: "checks", text: "Since then, who or what else have you asked about it?",
      options: [["people", "Friends or family"], ["professional", "A professional"], ["web", "Web search or online communities"],
                ["same_ai", "The same AI assistant again"], ["other_ai", "A different AI assistant"], ["no_one", "No one"]] },
    ...RATINGS.map((item) => ({ ...item, key: `again_${item.key}`, text: `Thinking back now: ${item.text}`, required: false })),
    { key: "opinion", type: "select", text: "Has your opinion of the advice changed since you got it?",
      options: [["worse", "It looks worse now"], ["same", "About the same"], ["better", "It looks better now"]] },
    { key: "comment", type: "text", text: "Anything unexpected, or anything else you want to tell us? (optional)" },
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
    const answers = {}, missing = [];
    for (const item of items) {
      if (item.type === "scale") {
        const checked = container.querySelector(`input[name="${item.key}"]:checked`);
        answers[item.key] = checked ? Number(checked.value) : null;
      } else if (item.type === "checks") {
        answers[item.key] = [...container.querySelectorAll(`input[name="${item.key}"]:checked`)].map((box) => box.value);
      } else {
        answers[item.key] = container.querySelector(`[name="${item.key}"]`).value.trim();
      }
      if (item.required && (answers[item.key] === null || answers[item.key] === "")) missing.push(item.key);
    }
    return { answers, missing };
  }

  const api = { RATINGS, OPTIONAL, CHECKIN, DOMAINS, render, read, escape };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Questions = api;
})(typeof self !== "undefined" ? self : globalThis);
