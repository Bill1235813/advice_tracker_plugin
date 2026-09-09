// Redaction applied to a transcript before it can leave the browser.
// Pattern-based: emails, phone numbers, URLs, long digit runs (cards, account numbers),
// street addresses, @handles, plus any names the participant listed in the options page.
// NOTE: [edge case callout] regexes cannot catch every personal detail (a first name in
// prose, an employer, a diagnosis), which is why the rating panel also lets the
// participant edit the redacted transcript by hand before sharing it.
(function (root) {
  const PATTERNS = [
    ["email", /[\w.+-]+@[\w-]+\.[\w.-]+/g],
    ["url", /https?:\/\/[^\s)]+/g],
    ["phone", /(?:\+?\d{1,3}[\s-])?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g],
    ["number", /\b\d{7,}\b/g],
    ["address", /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way)\b\.?/g],
    ["handle", /(?<![\w])@[A-Za-z0-9_]{3,}/g],
  ];

  function redact(text, names = []) {
    const counts = {};
    let out = text;
    for (const [label, pattern] of PATTERNS) {
      out = out.replace(pattern, () => { counts[label] = (counts[label] || 0) + 1; return `[${label.toUpperCase()}]`; });
    }
    for (const name of names.map((n) => n.trim()).filter((n) => n.length > 1)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`\\b${escaped}\\b`, "gi"), () => { counts.name = (counts.name || 0) + 1; return "[NAME]"; });
    }
    return { text: out, counts };
  }

  function redactMessages(messages, names) {
    let counts = {};
    const redacted = messages.map((m) => {
      const result = redact(m.content, names);
      for (const [k, v] of Object.entries(result.counts)) counts[k] = (counts[k] || 0) + v;
      return { role: m.role, content: result.text };
    });
    return { messages: redacted, counts };
  }

  const api = { redact, redactMessages };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Redact = api;
})(typeof self !== "undefined" ? self : globalThis);
