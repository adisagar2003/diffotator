"use strict";
/**
 * The walkthrough's rules, with no DOM: what a walkthrough file may say, how it
 * is repaired against the files that actually changed, how a URL hash names a
 * place in it, and what one level of the map contains. The server calls
 * `validate` for `/api/walkthrough`; the page (`web/walk.js`) calls the rest.
 *
 * Shared choke point: the server, the page and `test.js` all load this one file
 * (Node through `require`, the browser as `window.Walkthrough`), so a change to
 * the walkthrough format or a route lands here and nowhere else.
 */
(function (exp) {
  const str = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const base = (p) => p.slice(p.lastIndexOf("/") + 1);
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const LEVELS = ["low", "medium", "high"]; // how carefully to read a file, least first

  /* Ids the walkthrough makes up itself. A block from the file that claims one
     is renamed, so a generated block can never collide with an authored one. */
  const RESERVED = /^(other|root-files)$|^(dir|files|file|ghost):/;

  /** `[label, text]` pairs or `{label, text}` objects, empty labels dropped. */
  function pairs(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((x) => (Array.isArray(x) ? { label: str(x[0]), text: str(x[1]) } : isObj(x) ? { label: str(x.label), text: str(x.text) } : null))
      .filter((x) => x && x.label);
  }

  function countOf(b) {
    return b.files ? b.files.reduce((n, f) => n + 1 + f.tests.length, 0) : b.children.reduce((n, c) => n + c.count, 0);
  }

  function uniqueId(raw, i, seen) {
    // A reserved prefix is rewritten once, before the loop: appending "-2" to
    // "file:x" would never stop matching it. "/" joins parent and child ids in
    // the map, so an authored one could collide with a generated id.
    const want = (str(raw) || "b" + (i + 1)).replace(/^(dir|files|file|ghost):/, "$1-").replace(/\//g, "-");
    let id = want;
    for (let n = 2; seen.has(id) || RESERVED.test(id); n++) id = `${want}-${n}`;
    seen.add(id);
    return id;
  }

  /* A term's source is opened as a file in the repo, so it must stay inside
     the repo: relative, no "..", no drive or root. Anything else is dropped. */
  function repoPath(v) {
    const p = str(v);
    if (!p || /^([\\/]|[A-Za-z]:)/.test(p) || p.includes("\0") || p.split(/[\\/]/).includes("..")) return null;
    return p;
  }

  /** Sibling edges whose ends both survived, named by the ids the author wrote. */
  function siblingEdges(list, kids, alias) {
    const ids = new Set(kids.map((k) => k.id));
    if (!Array.isArray(list)) return [];
    return list.flatMap((e) => {
      if (!isObj(e)) return [];
      const from = alias.get(str(e.from)) || str(e.from), to = alias.get(str(e.to)) || str(e.to);
      return ids.has(from) && ids.has(to) && from !== to ? [{ from, to, label: str(e.label) }] : [];
    });
  }

  /**
   * Repair an agent-written walkthrough against the files that really changed:
   * unknown paths go, a path listed twice keeps its first place, tests nest in
   * the file they test, and anything left out lands in a final "Other" block —
   * so every changed file is reachable exactly once. `raw` that is not an
   * object (missing file, bad JSON) becomes the folder fallback, carrying
   * `error` so the page can say why.
   */
  function validate(raw, paths, error = null) {
    if (!isObj(raw)) return fallbackWalkthrough(paths, error);
    const changed = new Set(paths);
    const placed = new Set();
    const take = (p) => typeof p === "string" && changed.has(p) && !placed.has(p) && (placed.add(p), true);

    const entry = (e) => {
      const p = typeof e === "string" ? e : isObj(e) ? e.path : null;
      if (!take(p)) return null;
      const tests = isObj(e) && Array.isArray(e.tests) ? e.tests.filter(take) : [];
      return { path: p, tests };
    };

    /* `alias` maps the id an author wrote to the id it became, first claimant
       winning, so edges written against "file:x" or "a/b" still connect. */
    const block = (b, i, seen, alias) => {
      if (!isObj(b)) return null;
      const out = { id: uniqueId(b.id, i, seen), label: "", note: str(b.note), big: b.big === true, children: null, files: null, edges: [], count: 0 };
      if (str(b.id) && !alias.has(str(b.id))) alias.set(str(b.id), out.id);
      out.label = str(b.label) || out.id;
      // Children win: a block that has both is a parent, and its stray files go
      // to Other rather than being silently dropped.
      if (Array.isArray(b.children) && b.children.length) {
        const s = new Set(), a = new Map();
        out.children = b.children.map((c, j) => block(c, j, s, a)).filter(Boolean);
        if (!out.children.length) return null;
        out.edges = siblingEdges(b.edges, out.children, a);
      } else if (Array.isArray(b.files)) {
        out.files = b.files.map(entry).filter(Boolean);
        if (!out.files.length) return null;
      } else return null;
      out.count = countOf(out);
      return out;
    };

    const seen = new Set(), alias = new Map();
    const blocks = (Array.isArray(raw.blocks) ? raw.blocks : []).map((b, i) => block(b, i, seen, alias)).filter(Boolean);
    const edges = siblingEdges(raw.edges, blocks, alias);
    const rest = paths.filter((p) => !placed.has(p));
    if (rest.length) {
      const other = { id: "other", label: "Other", note: "", big: false, children: null, files: rest.map((p) => ({ path: p, tests: [] })), edges: [], count: 0 };
      other.count = countOf(other);
      blocks.push(other);
    }

    const seenLink = new Set();
    const links = (Array.isArray(raw.links) ? raw.links : []).flatMap((l) => {
      if (!isObj(l)) return [];
      const from = str(l.from), to = str(l.to), key = from + "\n" + to;
      if (from === to || !changed.has(from) || !changed.has(to) || seenLink.has(key)) return [];
      seenLink.add(key);
      return [{ from, to, label: str(l.label) }];
    });

    // The agent's own read of which files need a careful look; `rank` merges it
    // with what the paths and sizes say.
    const rated = new Set();
    const risk = (Array.isArray(raw.risk) ? raw.risk : []).flatMap((r) => {
      const level = isObj(r) ? str(r.level).toLowerCase() : "";
      if (!LEVELS.includes(level) || !changed.has(r.path) || rated.has(r.path)) return [];
      rated.add(r.path);
      return [{ path: r.path, level, why: str(r.why) }];
    });

    const mr = isObj(raw.mr) && str(raw.mr.url) ? { iid: str(raw.mr.iid), url: str(raw.mr.url) } : null;
    // How sure the agent is that this is safe to merge. A reason not marked ok
    // reads as a concern: better to flag what is fine than to reassure wrongly.
    const conf = isObj(raw.confidence) ? raw.confidence : {};
    const level = str(conf.level).toLowerCase();
    const confidence = ["high", "medium", "low"].includes(level)
      ? {
          level,
          summary: str(conf.summary),
          reasons: (Array.isArray(conf.reasons) ? conf.reasons : [])
            .filter((r) => isObj(r) && str(r.text))
            .map((r) => ({ ok: r.ok === true, text: str(r.text) })),
        }
      : null;
    return {
      title: str(raw.title),
      ticket: str(raw.ticket),
      summary: str(raw.summary),
      changes: pairs(raw.changes),
      decisions: Array.isArray(raw.decisions) ? raw.decisions.filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim()) : [],
      lookHard: str(raw.lookHard),
      domain: pairs(raw.domain),
      terms: (Array.isArray(raw.terms) ? raw.terms : [])
        .filter((t) => isObj(t) && str(t.term))
        .map((t) => ({ term: str(t.term), meaning: str(t.meaning), source: repoPath(t.source) })),
      blocks,
      edges,
      links,
      mr,
      confidence,
      risk,
      fallback: false,
      error,
    };
  }

  function fallbackWalkthrough(paths, error) {
    return {
      title: "", ticket: "", summary: "", changes: [], decisions: [], lookHard: "", domain: [], terms: [],
      blocks: fallback(paths), edges: [], links: [], mr: null, confidence: null, risk: [], fallback: true, error,
    };
  }

  // --- review order ------------------------------------------------------------

  /* Paths that need a careful human read whatever the diff looks like: what runs
     with the repo's secrets, moves money, or is hard to undo. A file on one of
     these stays high even if the agent rates it lower.
     ponytail: matched on the path alone, so `tokenizer.js` reads as auth; the
     agent's `risk` entries are the fix for a file the paths misjudge. */
  const SENSITIVE = [
    [/(^|\/)(\.github\/workflows|\.circleci|\.buildkite)\/|(^|\/)(\.gitlab-ci\.ya?ml|Jenkinsfile|azure-pipelines\.ya?ml)$/i, "CI workflow"],
    [/(^|[\/_.-])(auth|login|session|token|password|secret|credential|crypto|permission|oauth|jwt|sso)/i, "auth or secrets"],
    [/(^|[\/_.-])(billing|payment|invoice|stripe|checkout|subscription|refund)/i, "billing or payments"],
    [/(^|\/)migrations?\/|\.sql$|(^|\/)schema\.prisma$/i, "database migration"],
    [/(^|[\/_.-])(install|updater|auto-?update|release|publish)|(^|\/)(Dockerfile|docker-compose[^/]*|[^/]+\.tf)$/i, "install, release or deploy"],
  ];
  const DEPS = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(\.kts)?)$/;
  const QUIET = /\.(md|mdx|txt|rst|png|jpe?g|gif|svg|ico|webp|snap)$|(^|\/)docs?\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$/i;
  const TEST = /(^|\/)(__tests__|tests?|spec|e2e)\/|(^|\/|[._-])(tests?|spec)\.[^/]+$/i;
  const stem = (p) => base(p).replace(/\..*$/, ""); // cart.service.ts → cart

  /**
   * The changed files a person should read carefully, most first; the rest can
   * be skimmed. Each gets a level (high, medium, low), a score and the reasons:
   * a sensitive path, a dependency change, its size, no test changed with it,
   * sitting in the block the agent marked riskiest. The agent's `risk` entries
   * set the level outright, except that a sensitive path never drops below high.
   * Tests are left out (they are read with the file they check) unless the
   * agent rated one. `files` are the page's files: path, additions, deletions, status.
   */
  function rank(wt, files) {
    const idx = index(wt.blocks);
    const big = new Set();
    const markBig = (list, on) =>
      list.forEach((b) => {
        if (b.files) (on || b.big) && b.files.forEach((f) => big.add(f.path));
        else markBig(b.children, on || b.big);
      });
    markBig(wt.blocks, false);
    const said = new Map((wt.risk || []).map((r) => [r.path, r]));
    const isTest = (p) => TEST.test(p) || !!(idx.get(p) || {}).owner;
    const testStems = new Set(files.map((f) => f.path).filter(isTest).map(stem));
    const out = [];
    for (const f of files) {
      const p = f.path, at = idx.get(p), a = said.get(p);
      if (isTest(p) && !a) continue;
      const add = f.additions || 0, del = f.deletions || 0, churn = add + del;
      const why = [];
      let score = 0, floor = 0;
      if (QUIET.test(p)) why.push("docs, assets or a lockfile");
      else {
        for (const [re, label] of SENSITIVE) if (re.test(p)) (score += 3), (floor = 2), why.push(label);
        if (DEPS.test(p)) (score += 2), why.push("changes dependencies");
        if (churn > 300) (score += 2), why.push(`large change (+${add} −${del})`);
        else if (churn > 50) (score += 1), why.push(`mid-size change (+${add} −${del})`);
        const tested = (at && at.tests.length) || testStems.has(stem(p));
        if (!tested && churn > 50 && f.status !== "deleted") (score += 1), why.push("no test changed with it");
        if (big.has(p)) (score += 1), why.push("in the block marked riskiest");
      }
      let level = score >= 3 ? 2 : score >= 1 ? 1 : 0;
      if (a) {
        level = Math.max(LEVELS.indexOf(a.level), floor);
        if (a.why) why.unshift(a.why);
      }
      out.push({ path: p, level: LEVELS[level], score, why, add, del });
    }
    const lv = (r) => LEVELS.indexOf(r.level);
    return out.sort((x, y) => lv(y) - lv(x) || y.score - x.score || y.add + y.del - (x.add + x.del) || (x.path < y.path ? -1 : 1));
  }

  /**
   * Blocks from folders, for a review nobody wrote a walkthrough for. Runs of
   * single-child folders fold into one block (the file tree's rule); a folder
   * holding both subfolders and files puts its own files in a child block.
   */
  function fallback(paths) {
    const root = { dirs: new Map(), files: [] };
    for (const p of paths) {
      const parts = p.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push(p);
    }
    const leaf = (id, label, files) => ({ id, label, note: "", big: false, children: null, files: files.map((p) => ({ path: p, tests: [] })), edges: [], count: files.length });
    const dirBlock = (name, node, full) => {
      while (node.dirs.size === 1 && !node.files.length) {
        const [n, child] = [...node.dirs][0];
        name += "/" + n;
        full += "/" + n;
        node = child;
      }
      if (!node.dirs.size) return leaf("dir:" + full, name, node.files);
      const children = contents(node, full);
      return { id: "dir:" + full, label: name, note: "", big: false, children, files: null, edges: [], count: children.reduce((n, c) => n + c.count, 0) };
    };
    const contents = (node, full) => {
      const out = [...node.dirs.keys()].sort().map((n) => dirBlock(n, node.dirs.get(n), full ? full + "/" + n : n));
      if (node.files.length) out.push(full ? leaf("files:" + full, base(full) + " files", node.files) : leaf("root-files", "Root files", node.files));
      return out;
    };
    // A review that lives in one deep folder should open on that folder's
    // contents, not on a single box to click through.
    let start = root, prefix = "";
    while (start.dirs.size === 1 && !start.files.length) {
      const [n, child] = [...start.dirs][0];
      prefix = prefix ? prefix + "/" + n : n;
      start = child;
    }
    if (start !== root && !start.dirs.size) return [leaf("dir:" + prefix, prefix, start.files)];
    return contents(start, prefix);
  }

  // --- routes ----------------------------------------------------------------

  /** `#/`, `#/b/<id>/<id>`, `#/f/<file>`, `#/doc/<file>`, `#/commits`. Anything else is home. */
  function parseRoute(hash) {
    let p;
    try {
      p = String(hash || "").replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return { kind: "home" }; // a malformed %-escape in a pasted URL
    }
    if (p[0] === "b" && p.length > 1) return { kind: "block", path: p.slice(1) };
    if (p[0] === "f" && p.length === 2) return { kind: "file", file: p[1] };
    if (p[0] === "doc" && p.length === 2) return { kind: "doc", file: p[1] };
    if (p[0] === "commits" && p.length === 1) return { kind: "commits" };
    return { kind: "home" };
  }

  function formatRoute(r) {
    const enc = encodeURIComponent;
    if (r.kind === "block") return "#/b/" + r.path.map(enc).join("/");
    if (r.kind === "file") return "#/f/" + enc(r.file);
    if (r.kind === "doc") return "#/doc/" + enc(r.file);
    if (r.kind === "commits") return "#/commits";
    return "#/";
  }

  function findBlock(blocks, ids) {
    let level = blocks, found = null;
    for (const id of ids) {
      found = (level || []).find((b) => b.id === id) || null;
      if (!found) return null;
      level = found.children;
    }
    return found;
  }

  /** Where every placed path sits: its block ids, the file it tests, its tests, its area. */
  function index(blocks) {
    const out = new Map();
    const walk = (list, ids, tone) =>
      list.forEach((b, i) => {
        const here = [...ids, b.id];
        const t = tone === null ? (b.id === "other" ? -1 : i) : tone;
        if (b.files)
          for (const f of b.files) {
            out.set(f.path, { ids: here, owner: null, tests: f.tests, tone: t });
            for (const x of f.tests) out.set(x, { ids: here, owner: f.path, tests: [], tone: t });
          }
        else walk(b.children, here, t);
      });
    walk(blocks, [], null);
    return out;
  }

  /** Every file in reading order: block by block, each file followed by its tests. */
  function fileOrder(blocks) {
    const out = [];
    const walk = (list) => list.forEach((b) => (b.files ? b.files.forEach((f) => out.push(f.path, ...f.tests)) : walk(b.children)));
    walk(blocks);
    return out;
  }

  function testTag(p) {
    if (/(^|\/)e2e\/|\.spec\./.test(p)) return "E2E";
    if (/helper/i.test(p)) return "HELP";
    return "TEST";
  }

  /**
   * One level of the map. Each box at this level also shows its own children
   * inside it — a block its sub-blocks or files, a file its tests — so the
   * reader sees two levels at once and can click straight through. Inside a
   * block that holds files, a link leaving the block draws its far end as a
   * "ghost" you can follow. Returns null for a route that no longer exists.
   */
  function buildGraph(wt, route, stats) {
    const home = route.kind === "home";
    const cur = home ? { children: wt.blocks, edges: wt.edges } : route.kind === "block" ? findBlock(wt.blocks, route.path) : null;
    if (!cur) return null;
    const at = home ? [] : route.path;
    const idx = index(wt.blocks);
    const st = (p) => stats.get(p) || { add: 0, del: 0 };
    const sum = (b) => {
      let add = 0, del = 0;
      const walk = (x) => (x.files ? x.files.forEach((f) => [f.path, ...f.tests].forEach((p) => ((add += st(p).add), (del += st(p).del)))) : x.children.forEach(walk));
      walk(b);
      return { add, del };
    };
    const nodes = [], edges = [], visible = new Map();
    const parentTone = home ? null : (idx.get(fileOrder([cur])[0]) || { tone: -1 }).tone;

    const fileNode = (f, parent, tone) => {
      const id = "file:" + f.path, s = st(f.path);
      visible.set(f.path, id);
      nodes.push({
        id, kind: "file", parent, label: base(f.path), sub: "", note: "", big: s.add + s.del > 500, tone, add: s.add, del: s.del,
        tests: f.tests.map((t) => ({ path: t, tag: testTag(t), add: st(t).add })), nav: { kind: "file", file: f.path },
      });
    };
    const blockNode = (b, kind, parent, tone, path) => {
      const s = sum(b);
      nodes.push({
        id: kind === "group" ? b.id : parent + "/" + b.id, kind, parent, label: b.label, sub: `${b.count} file${b.count === 1 ? "" : "s"}`,
        note: b.note, big: b.big, tone, add: s.add, del: s.del, tests: [], nav: { kind: "block", path },
      });
    };

    if (cur.files) {
      for (const f of cur.files) fileNode(f, null, parentTone);
    } else {
      cur.children.forEach((b, i) => {
        const tone = home ? (b.id === "other" ? -1 : i) : parentTone;
        blockNode(b, "group", null, tone, [...at, b.id]);
        if (b.files) b.files.forEach((f) => fileNode(f, b.id, tone));
        else {
          b.children.forEach((c) => blockNode(c, "block", b.id, tone, [...at, b.id, c.id]));
          b.edges.forEach((e, k) => edges.push({ id: `b:${b.id}:${k}`, from: b.id + "/" + e.from, to: b.id + "/" + e.to, label: e.label, kind: "block" }));
        }
      });
      cur.edges.forEach((e, k) => edges.push({ id: `b::${k}`, from: e.from, to: e.to, label: e.label, kind: "block" }));
    }

    // A test is drawn inside its file, so a link to a test lands on that file.
    const resolve = (p) => visible.get(p) || (idx.get(p) && visible.get(idx.get(p).owner)) || null;
    if (cur.files) {
      for (const l of wt.links) {
        const a = resolve(l.from), b = resolve(l.to);
        if (!!a === !!b) continue;
        const far = a ? l.to : l.from, id = "ghost:" + far;
        if (visible.has(far)) continue;
        const where = idx.get(far), s = st(far);
        visible.set(far, id);
        nodes.push({
          id, kind: "ghost", parent: null, label: base(far), sub: "in " + (findBlock(wt.blocks, where.ids) || { label: "Other" }).label, note: "",
          big: false, tone: where.tone, add: s.add, del: s.del, tests: [], nav: { kind: "file", file: far },
        });
      }
    }
    const seen = new Set();
    wt.links.forEach((l, k) => {
      const a = resolve(l.from), b = resolve(l.to);
      if (!a || !b || a === b || seen.has(a + "\n" + b)) return;
      seen.add(a + "\n" + b);
      edges.push({ id: "l:" + k, from: a, to: b, label: l.label, kind: "link" });
    });

    let n = 0;
    for (const node of nodes) if (!node.parent && n < 9) node.n = ++n;
    return { nodes, edges };
  }

  exp.validate = validate;
  exp.fallback = fallback;
  exp.parseRoute = parseRoute;
  exp.formatRoute = formatRoute;
  exp.findBlock = findBlock;
  exp.index = index;
  exp.fileOrder = fileOrder;
  exp.testTag = testTag;
  exp.buildGraph = buildGraph;
  exp.rank = rank;
})(typeof module === "object" && module.exports ? module.exports : (window.Walkthrough = {}));
