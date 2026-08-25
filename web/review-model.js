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
    fileHeader: 32, // .file-header height in the stream
    cardHead: 26,
    cardLine: 17,
    cardPad: 14,
    cardMaxLines: 4, // comment bodies are line-clamped to this
    context: 3, // unmodified lines kept either side of a change
    chunk: 20, // lines a directional fold click reveals; gaps at or under this open whole
    allViewed: 96, // .avc height in style.css — border-box, must match exactly
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
    if (item && item.k === "fileHeader") return GEOM.fileHeader;
    if (item && item.k === "allviewed") return GEOM.allViewed;
    if (!item || item.k !== "comment") return GEOM.row; // rows, folds, loading, note
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
   * @param {Map<string,{head:number,tail:number}>} [input.expanded]
   *   lines the reader has revealed per fold: `head` from the gap's start,
   *   `tail` from its end. A fold whose reveals meet emits only rows.
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
      expanded = new Map(),
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
      items.push({ k: "row", u, i, f: file });
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
          items.push({ k: "comment", a, f: file });
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
      const count = i - start;
      // Reveals are clamped here, not at write time: a fold can shrink when a
      // comment lands inside it and re-splits the gap, and a stale over-count
      // must not push rows past the gap's end.
      const ex = expanded.get(id) || { head: 0, tail: 0 };
      const head = Math.min(ex.head || 0, count);
      const tail = Math.min(ex.tail || 0, count - head);
      for (let j = start; j < start + head; j++) pushRow(units[j], j);
      if (head + tail < count) {
        items.push({ k: "fold", id, count: count - head - tail, from: start + head, to: i - tail, f: file });
      }
      for (let j = i - tail; j < i; j++) pushRow(units[j], j);
    }

    // Widest line decides how far the shared pan scrollbar can travel.
    let maxLineLen = 0;
    for (const r of src) if (r.s && r.s.length > maxLineLen) maxLineLen = Math.min(r.s.length, 4000);

    return { items, effView, singleGutter, maxLineLen };
  }

  /**
   * The whole review as one flat list: every selected file's items back to
   * back, each behind a fileHeader row. Heights stay derived — header, loading
   * and note rows are fixed — so the windowed list's prefix-sum index is exact
   * before, during and after the per-file diffs arrive.
   */
  function buildStream({ files, selected, collapsed, perFile, annotations = [], view = "split", viewedSet = new Set() }) {
    const items = [];
    const segments = [];
    let maxLineLen = 0;
    let idx = 0;
    const shown = files.filter((f) => selected.has(f.path));
    for (const f of shown) {
      const start = items.length;
      const st = (perFile && perFile.get(f.path)) || {};
      items.push({
        k: "fileHeader",
        f: f.path,
        stats: f,
        collapsed: collapsed.has(f.path),
        viewed: viewedSet.has(f.path),
        full: !!st.full, // the header row carries the Full-file pill's state
        idx: idx++,
        count: shown.length,
      });
      /* A comment about the file itself hangs off its header rather than off a
         line — buildItems threads comments under the line they name, and this
         one names none. Folded with the file, like everything else about it. */
      if (!collapsed.has(f.path)) {
        for (const a of annotations) {
          if (a.file === f.path && a.line == null) items.push({ k: "comment", a, f: f.path });
        }
      }
      if (!collapsed.has(f.path)) {
        if (!st.loaded) {
          items.push({ k: "loading", f: f.path });
        } else if (st.error || st.binary || st.tooBig || (st.empty && !(st.fullRows && st.fullRows.length))) {
          const text = st.error
            ? "Could not read this file."
            : st.binary
            ? "Binary file — nothing to diff."
            : st.tooBig
            ? "Diff too large to render — review it in your editor."
            : st.mode
            ? `Mode changed ${st.mode.old} → ${st.mode.new} — no content changed.`
            : "Empty file.";
          items.push({ k: "note", f: f.path, text });
        } else {
          /* Every arrival used to rebuild EVERY loaded file's rows through
             buildItems, so filling a large stream did quadratic work. The
             body — rows/folds/comment cards plus maxLineLen — is memoized on
             the perFile state object the caller already owns; only the
             fileHeader above (idx/count/collapsed/viewed) is cheap and
             position-dependent, so it stays built fresh every call. The cache
             key covers everything the body depends on besides rows/fullRows
             identity, which is checked separately since a fresh diff arrival
             replaces `st` wholesale rather than mutating rows in place. */
          const annsForFile = annotations.filter((a) => a.file === f.path);
          // Reveal counts are part of the fold's identity now, not just its id —
          // a second click on the same fold must miss the memo.
          const foldKey = [...(st.expanded || new Map())]
            .map(([id, ex]) => `${id}:${ex.head || 0}+${ex.tail || 0}`)
            .sort()
            .join(",");
          const key = view + "|" + !!st.full + "|" + foldKey + "|" + JSON.stringify(annsForFile);
          let memo = st.stream;
          if (!memo || st.streamKey !== key || memo.rows !== st.rows || memo.fullRows !== st.fullRows) {
            const one = buildItems({
              rows: st.rows,
              fullRows: st.fullRows,
              annotations,
              file: f.path,
              expanded: st.expanded || new Map(),
              full: !!st.full,
              view,
            });
            // Rows carry their segment's view so a pure-add file stays unified
            // while its neighbor renders split — exactly the per-file rule
            // today. Stamped once, here, before the body is cached: nothing
            // downstream may mutate a cached item afterward.
            const body = [];
            for (const it of one.items) {
              if (it.k === "row") {
                it.v = one.effView;
                it.sg = one.singleGutter;
              }
              body.push(it);
            }
            memo = { items: body, maxLineLen: one.maxLineLen, rows: st.rows, fullRows: st.fullRows };
            st.stream = memo;
            st.streamKey = key;
          }
          for (const it of memo.items) items.push(it);
          if (memo.maxLineLen > maxLineLen) maxLineLen = memo.maxLineLen;
        }
      }
      segments.push({ file: f.path, start, end: items.length });
    }
    // The review's finish line: every selected file viewed AND folded — the
    // state the v loop leaves behind. Derived, never stored: an item, not
    // app-side chrome, so it scrolls, windowing prices it, and any rebuild
    // that breaks the condition (un-view, un-fold, re-select) removes it.
    if (shown.length && shown.every((f) => viewedSet.has(f.path) && collapsed.has(f.path))) {
      items.push({ k: "allviewed", n: shown.length, comments: annotations.length });
    }
    return { items, segments, maxLineLen };
  }

  // --- navigation over the item list ---------------------------------------

  const isChangeRow = (it) => !!it && it.k === "row" && it.u.t !== "ctx" && it.u.t !== "gap";

  /** Which line a row stands for, as `{side, line}` or null. The new side wins;
      a pure deletion has only the old. Exported because the app has to re-anchor
      the line cursor on a row it picked out of the stream itself. */
  const rowLine = (it) =>
    it && it.k === "row"
      ? it.u.r && it.u.r.n != null
        ? { side: "new", line: it.u.r.n }
        : it.u.l && it.u.l.o != null
        ? { side: "old", line: it.u.l.o }
        : null
      : null;

  /**
   * Index of the row showing `line` on `side`, or -1. `file` is optional; when
   * given, only rows for that file match — needed because line numbers repeat
   * across files in a stream.
   */
  const rowIndexFor = (items, side, line, file) =>
    items.findIndex(
      (it) =>
        it.k === "row" &&
        (file == null || it.f === file) &&
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

  /**
   * Item indices where each change block in [start, end) begins, walking
   * blocks exactly as `findChange` does. Feeds the "change 3 of 12" counter
   * next to the prev/next arrows: the app caches this per (items, file) and
   * counts how many starts fall at or before its anchor.
   */
  function changeStarts(items, start, end) {
    const starts = [];
    let inBlock = false;
    for (let i = start; i < end; i++) {
      const c = isChangeRow(items[i]);
      if (c && !inBlock) starts.push(i);
      inBlock = c;
    }
    return starts;
  }

  /**
   * Move the line cursor one row. Returns `{index, side, line}` or null.
   * `focus.file` is optional but matters in a stream: line numbers repeat across
   * files, so a cursor that does not say which file it is in would re-anchor on
   * the first file with that line number and step from there.
   *
   * `anchorIndex` (item index, optional) stands in for a real focus when there
   * isn't one yet: the cursor is treated as resting just *before* that row, so
   * stepping forward lands on it instead of on row 0 of the whole stream. Used
   * when a pending-focus file (armed by `v` on a still-fetching file) names
   * where the reader actually is.
   */
  function focusStep(items, focus, dir, anchorIndex) {
    const rows = [];
    for (let i = 0; i < items.length; i++) if (items[i].k === "row") rows.push(i);
    if (!rows.length) return null;
    let at = -1;
    if (focus) {
      at = rows.findIndex((i) => {
        if (focus.file != null && items[i].f !== focus.file) return false;
        const l = rowLine(items[i]);
        return l && l.side === focus.side && l.line === focus.line;
      });
    } else if (anchorIndex != null && anchorIndex >= 0) {
      const ai = rows.indexOf(anchorIndex);
      if (ai >= 0) at = ai - 1;
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

  /** First changed row inside `file`'s segment, as {index, side, line}, or
      null (file collapsed/loading/absent). Where the cursor should land when
      a jump brings the reader to this file. */
  function firstChangeRowIn(items, segments, file) {
    const seg = segments.find((s) => s.file === file);
    if (!seg) return null;
    for (let i = seg.start; i < seg.end; i++) {
      if (isChangeRow(items[i])) {
        const l = rowLine(items[i]);
        if (l) return { index: i, side: l.side, line: l.line };
      }
    }
    return null;
  }

  /** Index of the first `row` item at or after `file`'s segment start, scanning
      past the segment's own end into later files if `file` itself is still
      loading (no rows yet). -1 when `file` has no segment or nothing after it
      is a row either (e.g. every remaining file is also still loading). Lets
      the line cursor step from "resting on a still-fetching file" without
      snapping back to the top of the whole stream. */
  function firstRowFrom(items, segments, file) {
    const seg = segments.find((s) => s.file === file);
    if (!seg) return -1;
    for (let i = seg.start; i < items.length; i++) {
      if (items[i].k === "row") return i;
    }
    return -1;
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

  /**
   * The commit timeline panel's whole contract, held where node can test it.
   * `timelineRows` is what the panel shows; `timelineScope` is what a
   * selection means. t = { base, head, sel, mode } with mode "upto" | "only".
   *
   * `commits` arrives newest-first (git log order — the order every git tool
   * trains the eye for). `included` is the affordance that makes a selection's
   * semantics visible: rows outside the current diff render dimmed, so "up to
   * here" reads as "this commit and everything below it" at a glance.
   */
  function timelineRows(commits, sel, mode) {
    const rows = [{ kind: "all", sel: !sel, included: true }];
    const list = commits || [];
    const si = sel ? list.findIndex((c) => c.sha === sel) : -1;
    list.forEach((c, i) =>
      rows.push({
        kind: "commit",
        sha: c.sha,
        short: c.short,
        subject: c.subject,
        sel: sel === c.sha,
        included: !sel || si < 0 || (mode === "only" ? c.sha === sel : i >= si),
      })
    );
    return rows;
  }

  function timelineScope(t) {
    if (!t.sel) return { type: "range", base: t.base, head: t.head };
    if (t.mode === "only") return { type: "commit", sha: t.sel };
    return { type: "range", base: t.base, head: t.sel };
  }

  /**
   * Which commit tag an annotation should carry, or null for none. Tagged at
   * creation, never re-tagged: an existing annotation keeps its tag whatever
   * scope it is edited from, and a new one is tagged exactly when it is
   * written against a single commit's diff. `meta` is that commit's metadata
   * if already fetched; the tag degrades gracefully without it.
   */
  function annCommit(existing, scope, meta) {
    if (existing) return existing.commit || null;
    if (!scope || scope.type !== "commit") return null;
    const m = meta && meta.sha === scope.sha ? meta : null;
    return {
      sha: scope.sha,
      short: m ? m.short : String(scope.sha).slice(0, 7),
      subject: m ? m.subject : "",
    };
  }

  // --- file filter ---------------------------------------------------------

  /**
   * The filter box used to answer exactly one question — "does the path
   * contain this?" — while the questions a reviewer actually asks halfway
   * through are "what have I not read yet?" and "where did I leave comments?".
   * Both were answerable only by scrolling the list and squinting at ticks.
   *
   * The grammar is deliberately tiny: whitespace-separated terms, all of which
   * must match, `!` negates one, and a term that is not a known word is what
   * the box always did — a substring of the path. So `src !viewed` still reads
   * as English, and nobody has to learn anything to keep typing `server`.
   */
  const FILTER_WORDS = {
    viewed: (f) => !!f.viewed,
    unviewed: (f) => !f.viewed,
    commented: (f) => (f.comments || 0) > 0,
    hidden: (f) => f.selected === false, // out of the stream, per the eye toggle
    added: (f) => f.status === "added" || f.status === "untracked",
    untracked: (f) => f.status === "untracked",
    deleted: (f) => f.status === "deleted",
    modified: (f) => f.status === "modified",
    renamed: (f) => f.status === "renamed",
    binary: (f) => !!f.binary,
  };

  /** Terms, pre-resolved. Parsing once per keystroke beats once per row. */
  function parseFilter(q) {
    const terms = [];
    for (const raw of String(q || "").trim().split(/\s+/)) {
      if (!raw) continue;
      const neg = raw[0] === "!";
      const word = (neg ? raw.slice(1) : raw).toLowerCase();
      if (!word) continue;
      const test = FILTER_WORDS[word];
      terms.push(test ? { neg, test } : { neg, text: word });
    }
    return terms;
  }

  /**
   * `file` is `{path, status, viewed, comments, selected, binary}`. Everything
   * but `path` is optional — the File Tree tab lists paths the change never
   * touched, and a word about a status they do not have simply excludes them.
   */
  function matchFile(terms, file) {
    const path = String((file && file.path) || "").toLowerCase();
    for (const t of terms) {
      const hit = t.test ? t.test(file || {}) : path.includes(t.text);
      if (hit === t.neg) return false;
    }
    return true;
  }

  exp.FILTER_WORDS = Object.keys(FILTER_WORDS);
  exp.parseFilter = parseFilter;
  exp.matchFile = matchFile;

  exp.GEOM = GEOM;
  exp.timelineRows = timelineRows;
  exp.timelineScope = timelineScope;
  exp.annCommit = annCommit;
  exp.annKey = annKey;
  /**
   * Put a removed comment back where it was. The comments panel and the send
   * dialog are ordered by this list, so an undo that appends would quietly
   * reorder the review — the comment comes back, but somewhere else, which
   * reads as a second accident rather than the fix for the first.
   */
  function insertAt(list, item, i) {
    const out = (list || []).slice();
    out.splice(Math.max(0, Math.min(i, out.length)), 0, item);
    return out;
  }

  exp.insertAt = insertAt;
  exp.annIndex = annIndex;
  exp.commentLines = commentLines;
  exp.itemHeight = itemHeight;
  exp.toSplit = toSplit;
  exp.buildItems = buildItems;
  exp.buildStream = buildStream;
  exp.rowLine = rowLine;
  exp.rowIndexFor = rowIndexFor;
  exp.findChange = findChange;
  exp.changeStarts = changeStarts;
  exp.focusStep = focusStep;
  exp.searchHits = searchHits;
  exp.nextUnviewed = nextUnviewed;
  exp.sideRows = sideRows;
  exp.sideGroup = sideGroup;
  exp.firstChangeRowIn = firstChangeRowIn;
  exp.firstRowFrom = firstRowFrom;
  exp.computeGraph = computeGraph;
})(typeof module === "object" && module.exports ? module.exports : (window.RM = {}));
