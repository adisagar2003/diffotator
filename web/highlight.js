// Tiny per-line syntax highlighter. Runs only on rows actually on screen
// (~60 at a time), which is why we can get away with regex instead of a real
// lexer — and why there is no 2MB grammar bundle to download.
// ponytail: single-line regex tokenizer. Multi-line strings/JSX/template
// interpolation are approximated; swap in a real lexer only if it ever bites.
(function (g) {
  const KW = new Set(
    ("const let var function return if else for while class extends implements new await async import " +
      "from export default type interface enum namespace declare public private protected readonly static " +
      "abstract try catch finally throw switch case break continue do delete void in of typeof instanceof " +
      "null undefined true false this super yield as satisfies keyof infer never unknown any string number " +
      "boolean object symbol bigint def elif None True False self lambda pass raise with global nonlocal " +
      "assert not and or is print struct impl fn pub mut use match trait where loop move ref crate mod " +
      "unsafe dyn box package func go defer nil chan select end then elsif module require begin rescue " +
      "ensure unless until each puts override sealed internal params foreach when let's").split(/\s+/)
  );

  const HASH_LANGS = /^(py|rb|sh|bash|zsh|yml|yaml|toml|conf|ini|rake|gemfile|dockerfile|makefile|pl|r)$/i;

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  function esc(s) {
    return s.replace(/[&<>]/g, (c) => ESC[c]);
  }

  // one pass: comment | string | number | word | punctuation
  const TOK =
    /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|^\s*\*(?!\/)[^\n]*|<!--[\s\S]*?(?:-->|$))|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|(\b0[xXbBoO][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:?!<>=+\-*/%&|^~@]+)/g;

  function highlight(line, lang) {
    if (!line) return "";
    if (line.length > 2000) return esc(line); // pathological minified line
    const hash = HASH_LANGS.test(lang || "");
    if (hash) {
      const i = line.indexOf("#");
      if (i >= 0 && !/["'`]/.test(line.slice(0, i))) {
        return highlight(line.slice(0, i), "") + '<span class="c">' + esc(line.slice(i)) + "</span>";
      }
    }
    let out = "";
    let last = 0;
    TOK.lastIndex = 0;
    let m;
    while ((m = TOK.exec(line))) {
      if (m.index > last) out += esc(line.slice(last, m.index));
      last = TOK.lastIndex;
      const [all, cm, str, num, word, punct] = m;
      if (cm) out += '<span class="c">' + esc(all) + "</span>";
      else if (str) out += '<span class="s">' + esc(all) + "</span>";
      else if (num) out += '<span class="n">' + esc(all) + "</span>";
      else if (word) {
        const next = line[TOK.lastIndex];
        if (KW.has(word)) out += '<span class="k">' + word + "</span>";
        else if (next === "(") out += '<span class="f">' + word + "</span>";
        else if (/^[A-Z]/.test(word)) out += '<span class="t">' + esc(word) + "</span>";
        else out += esc(word);
      } else if (punct) out += '<span class="p">' + esc(all) + "</span>";
    }
    if (last < line.length) out += esc(line.slice(last));
    return out;
  }

  // Word-level intra-line diff: trim the common prefix and suffix and mark the
  // middle. Cheap (O(n)) and matches what the eye expects for typical edits.
  const SPLIT = /(\w+|\s+|[^\w\s])/g;
  function wordSpans(a, b) {
    const A = a.match(SPLIT) || [];
    const B = b.match(SPLIT) || [];
    let s = 0;
    while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let e = 0;
    while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
    const mid = (arr) => arr.slice(s, arr.length - e).join("");
    const pre = A.slice(0, s).join("");
    return {
      a: { pre, mid: mid(A), post: A.slice(A.length - e).join("") },
      b: { pre, mid: mid(B), post: B.slice(B.length - e).join("") },
    };
  }

  function renderPair(a, b, lang) {
    if (a == null || b == null || !a || !b) {
      return [a == null ? null : highlight(a, lang), b == null ? null : highlight(b, lang)];
    }
    const w = wordSpans(a, b);
    // Whole line changed → the marker adds nothing but noise.
    const changed = Math.max(w.a.mid.length, w.b.mid.length);
    if (changed > 0.75 * Math.max(a.length, b.length)) {
      return [highlight(a, lang), highlight(b, lang)];
    }
    const part = (x) =>
      highlight(x.pre, lang) +
      (x.mid ? '<span class="wd">' + highlight(x.mid, lang) + "</span>" : "") +
      highlight(x.post, lang);
    return [part(w.a), part(w.b)];
  }

  g.HL = { highlight, renderPair, esc };
})(window);
