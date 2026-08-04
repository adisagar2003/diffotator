"use strict";
/**
 * The review model: everything that turns git data plus annotations into the
 * list of things on screen. No DOM, no globals, no fetch — every input arrives
 * as an argument and every output is returned.
 *
 * This used to live inline in app.js, reading a dozen keys off the `S` global
 * and reaching into `clientWidth` mid-calculation, so none of it could be
 * tested: fold placement, split pairing, comment threading, commit-graph lanes
 * and the height arithmetic the windowed list depends on were only observable
 * by scrolling a browser and squinting.
 *
 * Loadable from both tiers — Node gets `require`, the browser gets
 * `window.RM` — so `node test.js` exercises the same code the page runs.
 */
(function (exp) {
  /**
   * Row heights are derived, never measured: the windowed list keeps a
   * prefix-sum index, so a height that disagreed with the rendered box would
   * make rows drift as you scroll. These must match web/style.css.
   */
  const GEOM = {
    row: 20, // .drow height
    cardHead: 26,
    cardLine: 17,
    cardPad: 14,
    cardMaxLines: 4, // comment bodies are line-clamped to this
    context: 3, // unmodified lines kept either side of a change
  };

  // --- annotation indexing -------------------------------------------------

  const annKey = (file, side, line) => `${file}|${side}|${line}`;

  /** file|side|line → how many comments sit there, for the gutter badges. */
  function annIndex(annotations) {
    const m = new Map();
    for (const a of annotations || []) {
      const k = annKey(a.file, a.side, a.line);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }

  // --- geometry ------------------------------------------------------------

  /**
   * How many lines a comment card will wrap to. `charsPerLine` is measured by
   * the caller and passed in, which is what makes this testable at all.
   */
  function commentLines(a, charsPerLine) {
    const w = Math.max(28, Math.floor(charsPerLine) || 28);
    let n = 0;
    for (const seg of String((a && a.body) || "").split("\n")) n += Math.max(1, Math.ceil(seg.length / w));
    if (a && a.suggestion) n += 1;
    return Math.min(GEOM.cardMaxLines, Math.max(1, n));
  }

  function itemHeight(item, charsPerLine) {
    if (!item || item.k !== "comment") return GEOM.row;
    return GEOM.cardHead + GEOM.cardPad + commentLines(item.a, charsPerLine) * GEOM.cardLine;
  }

  // --- split view ----------------------------------------------------------

  /** Pair a unified row stream into left/right columns for split view. */
  function toSplit(rows) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      const r = rows[i];
      if (r.t === "ctx" || r.t === "gap") {
        out.push({ t: r.t, l: r, r: r });
        i++;
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < rows.length && rows[i].t === "del") dels.push(rows[i++]);
      while (i < rows.length && rows[i].t === "add") adds.push(rows[i++]);
      if (!dels.length && !adds.length) {
        i++;
        continue;
      }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) out.push({ t: "chg", l: dels[k] || null, r: adds[k] || null });
    }
    return out;
  }

  // --- the item list -------------------------------------------------------

  /**
   * Build the flat list the diff pane renders: code rows, comment cards and
   * fold markers, in order.
   *
   * @param {object} input
   * @param {object[]} [input.rows]        parsed diff rows, full context
   * @param {object[]} [input.fullRows]    whole-file rows, for an untouched file
   * @param {object[]} [input.annotations] every annotation in the session
   * @param {string} input.file            the file being shown
   * @param {Set<string>} [input.expanded] fold ids the reader has opened
   * @param {boolean} [input.full]         stop folding entirely
   * @param {string} [input.view]          "split" | "unified" (a request, not a promise)
   * @param {number} [input.context]       unmodified lines to keep around a change
   * @returns {{items: object[], effView: string, singleGutter: boolean, maxLineLen: number}}
   */
  function buildItems(input) {
    const {
      rows,
      fullRows,
      annotations = [],
      file,
      expanded = new Set(),
      full = false,
      view = "split",
      context = GEOM.context,
    } = input;

    // The diff is fetched with full context already, so "Full file" only has to
    // stop folding — swapping in plain content would throw away the add/del marks.
    const haveDiff = !!(rows && rows.length);
    const src = haveDiff ? rows : fullRows || [];
    const noFold = full || !haveDiff;

    // Split only earns its keep when both columns differ. A pure add, a pure
    // delete, or an unchanged file browsed from the File Tree would otherwise
    // burn half the pane on hatching or on a duplicate of itself.
    const hasAdd = src.some((r) => r.t === "add");
    const hasDel = src.some((r) => r.t === "del");
    const singleGutter = !hasAdd && !hasDel;
    const effView = view === "split" && hasAdd && hasDel ? "split" : "unified";
    const units = effView === "split" ? toSplit(src) : src.map((r) => ({ t: r.t, l: r, r: r, uni: r }));
    const idx = annIndex(annotations);

    const interesting = new Array(units.length).fill(false);
    if (!noFold) {
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u.t !== "ctx" && u.t !== "gap") interesting[i] = true;
        const ln = u.r && u.r.n;
        if (ln && idx.has(annKey(file, "new", ln))) interesting[i] = true;
        const lo = u.l && u.l.o;
        if (lo && idx.has(annKey(file, "old", lo))) interesting[i] = true;
      }
    }

    const keep = new Array(units.length).fill(noFold);
    if (!noFold) {
      for (let i = 0; i < units.length; i++) {
        if (!interesting[i]) continue;
        for (let k = Math.max(0, i - context); k <= Math.min(units.length - 1, i + context); k++) keep[k] = true;
      }
    }

    const byLine = new Map();
    for (const a of annotations) {
      if (a.file !== file) continue;
      const k = a.side + ":" + a.line;
      if (!byLine.has(k)) byLine.set(k, []);
      byLine.get(k).push(a);
    }

    const items = [];
    const pushRow = (u, i) => {
      items.push({ k: "row", u, i });
      if (!byLine.size) return;
      // A comment belongs under the line it is about, so it reads like a thread.
      const seen = new Set();
      for (const [side, row] of [
        ["old", u.l],
        ["new", u.r],
      ]) {
        const n = row && (side === "old" ? row.o : row.n);
        if (n == null) continue;
        for (const a of byLine.get(side + ":" + n) || []) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          items.push({ k: "comment", a });
        }
      }
    };

    let i = 0;
    while (i < units.length) {
      if (keep[i]) {
        pushRow(units[i], i);
        i++;
        continue;
      }
      const start = i;
      while (i < units.length && !keep[i]) i++;
      const id = "f" + start;
      if (expanded.has(id)) {
        for (let j = start; j < i; j++) pushRow(units[j], j);
      } else {
        items.push({ k: "fold", id, count: i - start, from: start, to: i });
      }
    }

    // Widest line decides how far the shared pan scrollbar can travel.
    let maxLineLen = 0;
    for (const r of src) if (r.s && r.s.length > maxLineLen) maxLineLen = Math.min(r.s.length, 4000);

    return { items, effView, singleGutter, maxLineLen };
  }

  // --- navigation over the item list ---------------------------------------

  const isChangeRow = (it) => !!it && it.k === "row" && it.u.t !== "ctx" && it.u.t !== "gap";

  /** Which line a row stands for. The new side wins; a pure deletion has only the old. */
  const rowLine = (it) =>
    it && it.k === "row"
      ? it.u.r && it.u.r.n != null
        ? { side: "new", line: it.u.r.n }
        : it.u.l && it.u.l.o != null
        ? { side: "old", line: it.u.l.o }
        : null
      : null;

  /** Index of the row showing `line` on `side`, or -1. */
  const rowIndexFor = (items, side, line) =>
    items.findIndex(
      (it) =>
        it.k === "row" &&
        ((side === "new" && it.u.r && it.u.r.n === line) || (side === "old" && it.u.l && it.u.l.o === line))
    );

  /**
   * Start of the next (or previous) block of changed lines, skipping past the
   * block the reader is standing in. -1 when there is none that way.
   */
  function findChange(items, from, dir) {
    if (dir > 0) {
      let i = from;
      while (i < items.length && isChangeRow(items[i])) i++;
      while (i < items.length && !isChangeRow(items[i])) i++;
      return i < items.length ? i : -1;
    }
    let i = Math.max(0, from - 1);
    while (i >= 0 && isChangeRow(items[i])) i--;
    while (i >= 0 && !isChangeRow(items[i])) i--;
    while (i > 0 && isChangeRow(items[i - 1])) i--;
    return i >= 0 ? i : -1;
  }

  /** Move the line cursor one row. Returns `{index, side, line}` or null. */
  function focusStep(items, focus, dir) {
    const rows = [];
    for (let i = 0; i < items.length; i++) if (items[i].k === "row") rows.push(i);
    if (!rows.length) return null;
    let at = -1;
    if (focus) {
      at = rows.findIndex((i) => {
        const l = rowLine(items[i]);
        return l && l.side === focus.side && l.line === focus.line;
      });
    }
    // No cursor yet → land on the first row rather than stepping from nowhere.
    const pos = at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + dir));
    const index = rows[pos];
    const l = rowLine(items[index]);
    return l ? { index, side: l.side, line: l.line } : null;
  }

  /**
   * Item indices whose text contains `needle`. Windowing means only ~60 rows
   * exist in the DOM, so the browser's own Find cannot see the file.
   */
  function searchHits(items, needle) {
    const q = String(needle || "").toLowerCase();
    const hits = [];
    if (!q) return hits;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.k !== "row") continue;
      const a = it.u.l && it.u.l.s;
      const b = it.u.r && it.u.r.s;
      if ((a && a.toLowerCase().includes(q)) || (b && b.toLowerCase().includes(q))) hits.push(i);
    }
    return hits;
  }

  /** Next path not yet marked viewed, wrapping from `current`. */
  function nextUnviewed(paths, current, isViewed) {
    if (!paths.length) return null;
    const start = Math.max(0, paths.indexOf(current));
    for (let i = 1; i <= paths.length; i++) {
      const p = paths[(start + i) % paths.length];
      if (!isViewed(p)) return p;
    }
    return null;
  }

  // --- commit graph --------------------------------------------------------

  /**
   * Assign each commit a lane, and record which lanes pass through, merge into
   * it, or branch out of it. Pure list-in, list-out; the SVG lives in app.js.
   * @returns {{graph: object[], maxLanes: number}} maxLanes is already capped
   */
  function computeGraph(commits, laneCap = 12) {
    const lanes = [];
    const graph = [];
    let maxLanes = 1;
    const free = (arr) => {
      const i = arr.indexOf(null);
      return i < 0 ? arr.length : i;
    };
    for (const c of commits) {
      const incoming = lanes.slice();
      let lane = incoming.indexOf(c.sha);
      if (lane < 0) {
        lane = free(lanes);
        if (lane === lanes.length) lanes.push(null);
      }
      lanes[lane] = c.parents[0] || null;
      const merges = [];
      for (let i = 0; i < lanes.length; i++) {
        if (i !== lane && incoming[i] === c.sha) {
          merges.push(i);
          lanes[i] = null;
        }
      }
      const branches = [];
      for (const p of c.parents.slice(1)) {
        let l = lanes.indexOf(p);
        if (l < 0) {
          l = free(lanes);
          if (l === lanes.length) lanes.push(null);
          lanes[l] = p;
        }
        branches.push(l);
      }
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
      const outgoing = lanes.slice();
      maxLanes = Math.max(maxLanes, incoming.length, outgoing.length, lane + 1);
      graph.push({ lane, incoming, outgoing, merges, branches });
    }
    return { graph, maxLanes: Math.min(maxLanes, laneCap) };
  }

  // --- sidebar -------------------------------------------------------------

  /**
   * The three scope rows, with their badges and the one that is highlighted.
   * `localCount` is the working tree's own file count, not the open scope's:
   * six local changes are still six while you read a commit. `row` is the row
   * the reader last chose — a commit is reached *from* a row and owns none of
   * its own, so it leaves this alone and the row it came from stays lit.
   */
  function sideRows({ row, localCount, base }) {
    const rows = [{ row: "Local Changes", act: "scope-worktree", ico: "📝", label: "Local Changes" }];
    if (base) rows.push({ row: "Branch", act: "scope-range", ico: "⑂", label: `vs ${base}` });
    rows.push({ row: "All Commits", act: "scope-all", ico: "≡", label: "All Commits" });
    return rows.map((r) => ({
      ...r,
      badge: r.act === "scope-worktree" && localCount != null ? String(localCount) : "",
      active: r.row === row,
    }));
  }

  /**
   * A ref group's rows and its badge. Long lists are capped so the sidebar
   * stays cheap to render; the badge then has to admit it, because a count the
   * rows below do not add up to reads as "that branch is gone" rather than
   * "that branch is hidden".
   */
  function sideGroup(items, cap) {
    const shown = cap && items.length > cap ? items.slice(0, cap) : items;
    return { shown, badge: shown.length < items.length ? `${shown.length}/${items.length}` : String(items.length) };
  }

  exp.GEOM = GEOM;
  exp.annKey = annKey;
  exp.annIndex = annIndex;
  exp.commentLines = commentLines;
  exp.itemHeight = itemHeight;
  exp.toSplit = toSplit;
  exp.buildItems = buildItems;
  exp.rowLine = rowLine;
  exp.rowIndexFor = rowIndexFor;
  exp.findChange = findChange;
  exp.focusStep = focusStep;
  exp.searchHits = searchHits;
  exp.nextUnviewed = nextUnviewed;
  exp.sideRows = sideRows;
  exp.sideGroup = sideGroup;
  exp.computeGraph = computeGraph;
})(typeof module === "object" && module.exports ? module.exports : (window.RM = {}));
