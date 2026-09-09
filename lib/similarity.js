// Lexical similarity between two conversations' user turns (BITE uses the same Jaccard
// heuristic to link a later event to an earlier LLM interaction). Runs on-device, so no
// text has to leave the browser to decide whether two conversations are about the same
// decision.
(function (root) {
  const STOPWORDS = new Set(("a an the and or but if then so of to in on at for from with by as is are was were be been " +
    "am i me my mine we our you your he she it they them his her its their this that these those what which who whom " +
    "how when where why do does did have has had can could should would will just not no yes about into over also " +
    "very really any some more most much many like get got want need know think make made").split(" "));

  function tokens(text) {
    return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)));
  }

  function jaccard(textA, textB) {
    const a = tokens(textA), b = tokens(textB);
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared += 1;
    return shared / (a.size + b.size - shared);
  }

  const api = { tokens, jaccard };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Similarity = api;
})(typeof self !== "undefined" ? self : globalThis);
