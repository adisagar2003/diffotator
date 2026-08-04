#!/usr/bin/env node
"use strict";
/* Smallest thing that fails if the logic breaks. `node test.js` */
const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const G = require("./src/git");
const Scope = require("./src/scope");
const RM = require("./web/review-model");
const { render } = require("./src/feedback");

// --- feedback rendering ----------------------------------------------------
assert.strictEqual(render({ decision: "approved", annotations: [] }), "The user approved.");
assert.strictEqual(render({ decision: "dismissed" }), "Review session closed without feedback.");
{
  const out = render({
    decision: "annotated",
    repo: "demo",
    scope: { type: "worktree" },
    summary: "Looks close.",
    annotations: [
      { file: "a.ts", side: "new", line: 12, label: "issue", blocking: true, body: "null deref", code: "x.y", lang: "ts" },
      { file: "a.ts", side: "new", line: 3, label: "nit", body: "rename", suggestion: "const foo = 1", lang: "ts" },
    ],
  });
  assert.ok(out.includes("1 blocking comment"), "blocking callout");
  assert.ok(out.indexOf("a.ts:3") < out.indexOf("a.ts:12"), "comments sorted by line");
  assert.ok(out.includes("```ts\nconst foo = 1\n```"), "suggestion block");
  assert.ok(out.includes("Looks close."), "summary included");
}

// A comment tagged with the commit it was written against says so on its
// location line; untagged comments render exactly as before.
{
  const out = render({
    decision: "annotated",
    repo: "demo",
    scope: { type: "range", base: "origin/main" },
    annotations: [
      { file: "a.ts", side: "new", line: 3, label: "nit", body: "rename", commit: { sha: "abcdef1234567890", short: "abcdef1", subject: "feat: add thing" } },
      { file: "a.ts", side: "new", line: 12, label: "issue", body: "untagged" },
    ],
  });
  assert.ok(out.includes('re: commit abcdef1 "feat: add thing"'), "commit tag rendered");
  assert.strictEqual(out.match(/re: commit/g).length, 1, "only the tagged comment carries it");
}

// --- commit timeline (panel contract) ---------------------------------------
{
  const commits = [
    { sha: "c2".repeat(20), short: "c2c2c2c", subject: "second" },
    { sha: "c1".repeat(20), short: "c1c1c1c", subject: "first" },
  ];
  const rows = RM.timelineRows(commits, null);
  assert.strictEqual(rows[0].kind, "all");
  assert.ok(rows[0].sel, "no selection = the full branch row is active");
  assert.strictEqual(rows.length, 3);
  const sel = RM.timelineRows(commits, commits[1].sha);
  assert.ok(!sel[0].sel && sel[2].sel, "selection moves off the all-row onto the commit");
  assert.deepStrictEqual(
    RM.timelineScope({ base: "origin/main", head: "HEAD", sel: null, mode: "only" }),
    { type: "range", base: "origin/main", head: "HEAD" },
    "no selection is the full range whatever the toggle says"
  );
  assert.deepStrictEqual(
    RM.timelineScope({ base: "origin/main", head: "HEAD", sel: "abc123", mode: "upto" }),
    { type: "range", base: "origin/main", head: "abc123" },
    "up-to-here accumulates from the base through the selected commit"
  );
  assert.deepStrictEqual(
    RM.timelineScope({ base: "origin/main", head: "HEAD", sel: "abc123", mode: "only" }),
    { type: "commit", sha: "abc123" },
    "this-commit narrows to the commit alone"
  );

  // Tag at creation, never re-tag.
  const meta = { sha: "abc123", short: "abc123x", subject: "feat: x" };
  assert.deepStrictEqual(
    RM.annCommit(null, { type: "commit", sha: "abc123" }, meta),
    { sha: "abc123", short: "abc123x", subject: "feat: x" },
    "new comment in a commit scope is tagged"
  );
  assert.strictEqual(RM.annCommit(null, { type: "range", base: "b" }, meta), null, "range comments carry nothing");
  assert.deepStrictEqual(
    RM.annCommit(null, { type: "commit", sha: "ffff123" }, meta),
    { sha: "ffff123", short: "ffff123", subject: "" },
    "stale metadata degrades to the sha alone"
  );
  const kept = { commit: { sha: "old", short: "old", subject: "s" } };
  assert.strictEqual(RM.annCommit(kept, { type: "commit", sha: "abc123" }, meta), kept.commit, "edits keep the original tag");
  assert.strictEqual(RM.annCommit({ id: "a1" }, { type: "commit", sha: "abc123" }, meta), null, "an untagged comment stays untagged through edits");
}

// --- highlighter + word diff -----------------------------------------------
{
  global.window = {};
  require("./web/highlight.js");
  const { renderPair, highlight, esc } = global.window.HL;
  const [o, n] = renderPair("const timeout = 30;", "const timeout = 45;", "ts");
  assert.ok(o.includes('<span class="wd"><span class="n">30</span></span>'), "only the changed token is marked");
  assert.ok(n.includes('<span class="wd"><span class="n">45</span></span>'));
  assert.ok(!o.includes('<span class="wd">const'), "unchanged prefix is not marked");
  // a wholly rewritten line gets no word marks — they would be noise
  const [p] = renderPair("aaa bbb ccc", "zzz yyy xxx", "ts");
  assert.ok(!p.includes("wd"), "full rewrite suppresses word diff");
  // Quotes are HTML-escaped now, so a string literal's own quotes render as
  // entities — still "hi" once the browser parses them, and safe wherever this
  // same esc() lands inside an attribute instead of text content.
  assert.ok(highlight('x = "hi" // c', "ts").includes('<span class="s">&quot;hi&quot;</span>'), "string token");
  assert.ok(highlight("def f(): # c", "py").includes('<span class="c"># c</span>'), "# is a comment in python");
  assert.ok(!highlight("a #b", "ts").includes('class="c"'), "# is not a comment in ts");
  assert.strictEqual(esc("<script>&"), "&lt;script&gt;&amp;", "html is escaped");
  assert.strictEqual(esc('a "b" c'), "a &quot;b&quot; c", "quotes are escaped for attribute interpolation");
  assert.ok(!highlight('</div>"', "html").includes("<div"), "markup in source cannot break out");
  delete global.window;
}

/* --- review model ----------------------------------------------------------
   Fold placement, split pairing, comment threading, cursor arithmetic and the
   height estimates the windowed list indexes by. All of this used to be inline
   in app.js reading a global and `clientWidth`, so none of it was assertable. */
{
  const ctx = (i) => ({ t: "ctx", o: i, n: i, s: "line" + i });
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push(ctx(i));
  rows.push({ t: "del", o: 11, s: "old text" });
  rows.push({ t: "add", n: 11, s: "new text" });
  for (let i = 12; i <= 25; i++) rows.push(ctx(i));

  const base = { rows, file: "a.ts", view: "split" };
  const { items, effView, singleGutter } = RM.buildItems(base);
  assert.strictEqual(effView, "split", "both sides present → split earns its keep");
  assert.strictEqual(singleGutter, false);
  // 25 units, only the change is interesting, 3 lines of context either side.
  assert.strictEqual(items[0].k, "fold", "leading unmodified run is folded");
  assert.strictEqual(items[0].count, 7, "fold swallows everything outside the context window");
  assert.strictEqual(items.filter((x) => x.k === "row").length, 7, "change plus 3 context each side");
  assert.strictEqual(items[items.length - 1].count, 11, "trailing run folded too");

  // A fold the reader opened must render its rows instead.
  const opened = RM.buildItems({ ...base, expanded: new Set(["f0"]) });
  assert.strictEqual(opened.items.filter((x) => x.k === "fold").length, 1, "opened fold is gone");
  assert.strictEqual(opened.items[0].k, "row", "…and its rows are back");

  // "Full file" stops folding altogether without losing the add/del marks.
  const full = RM.buildItems({ ...base, full: true });
  assert.ok(!full.items.some((x) => x.k === "fold"), "full view has no folds");
  assert.ok(full.items.some((x) => x.u.t === "chg"), "…and still knows what changed");

  // A comment sits under the line it is about, exactly once, even though the
  // paired unit carries an old line 11 and a new line 11.
  const one = RM.buildItems({ ...base, annotations: [{ id: "x", file: "a.ts", side: "new", line: 11, body: "hm" }] });
  const cmts = one.items.filter((x) => x.k === "comment");
  assert.strictEqual(cmts.length, 1, "one annotation renders one card");
  const chgAt = one.items.findIndex((x) => x.k === "row" && x.u.t === "chg");
  assert.strictEqual(one.items[chgAt + 1].k, "comment", "card follows its line");
  const both = RM.buildItems({
    ...base,
    annotations: [
      { id: "x", file: "a.ts", side: "new", line: 11, body: "new side" },
      { id: "y", file: "a.ts", side: "old", line: 11, body: "old side" },
    ],
  });
  assert.strictEqual(both.items.filter((x) => x.k === "comment").length, 2, "both sides of one row");
  // An annotation on another file must not leak into this one.
  const other = RM.buildItems({ ...base, annotations: [{ id: "z", file: "b.ts", side: "new", line: 11, body: "x" }] });
  assert.strictEqual(other.items.filter((x) => x.k === "comment").length, 0);
  // A comment keeps its line out of a fold even with no change nearby.
  const far = RM.buildItems({ ...base, annotations: [{ id: "q", file: "a.ts", side: "new", line: 2, body: "x" }] });
  assert.ok(far.items.some((x) => x.k === "row" && x.u.r && x.u.r.n === 2), "annotated line survives folding");

  // Split view on a one-sided change would waste half the pane.
  const pureAdd = RM.buildItems({ rows: [{ t: "add", n: 1, s: "a" }], file: "a.ts", view: "split" });
  assert.strictEqual(pureAdd.effView, "unified", "pure add falls back to unified");
  assert.strictEqual(pureAdd.singleGutter, false);
  const untouched = RM.buildItems({ fullRows: [ctx(1), ctx(2)], file: "a.ts", view: "split" });
  assert.strictEqual(untouched.effView, "unified", "an unchanged file has nothing to pair");
  assert.strictEqual(untouched.singleGutter, true, "…and needs one gutter, not two");
  assert.strictEqual(untouched.items.length, 2, "no diff → no folding");

  // Pairing: two deletions against one addition leave a hole, not a shift.
  const paired = RM.toSplit([
    { t: "del", o: 1, s: "a" },
    { t: "del", o: 2, s: "b" },
    { t: "add", n: 1, s: "c" },
  ]);
  assert.strictEqual(paired.length, 2);
  assert.strictEqual(paired[1].r, null, "unmatched deletion pairs against nothing");

  // Navigation.
  assert.strictEqual(RM.findChange(items, 0, 1), chgAt, "next change from the top");
  assert.strictEqual(RM.findChange(items, 7, -1), chgAt, "previous change walks back to the block start");
  assert.strictEqual(RM.findChange(items, chgAt, 1), -1, "no further change to jump to");
  const first = RM.focusStep(items, null, 1);
  assert.deepStrictEqual({ side: first.side, line: first.line }, { side: "new", line: 8 }, "cursor starts on the first row");
  assert.strictEqual(RM.focusStep(items, first, 1).line, 9, "…and steps one row");
  assert.strictEqual(RM.focusStep(items, first, -1).line, 8, "…and clamps at the top");
  assert.strictEqual(RM.rowIndexFor(items, "new", 11), chgAt);
  assert.strictEqual(RM.rowIndexFor(items, "new", 999), -1);
  assert.deepStrictEqual(RM.searchHits(items, "OLD TEXT"), [chgAt], "search is case-insensitive and finds the old side");
  assert.deepStrictEqual(RM.searchHits(items, ""), [], "empty query matches nothing");

  assert.strictEqual(RM.nextUnviewed(["a", "b", "c"], "a", (p) => p === "b"), "c", "skips what was viewed");
  assert.strictEqual(RM.nextUnviewed(["a", "b"], "b", (p) => p === "b"), "a", "wraps around");
  assert.strictEqual(RM.nextUnviewed(["a"], "a", () => true), null, "nothing left to view");

  // Heights must agree with what gets rendered or rows drift while scrolling.
  assert.strictEqual(RM.commentLines({ body: "x".repeat(100) }, 50), 2);
  assert.strictEqual(RM.commentLines({ body: "x".repeat(100), suggestion: "y" }, 50), 3);
  assert.strictEqual(RM.commentLines({ body: "x".repeat(10000) }, 50), RM.GEOM.cardMaxLines, "clamped");
  assert.strictEqual(RM.commentLines({ body: "" }, 50), 1, "an empty body still occupies a line");
  assert.strictEqual(RM.itemHeight({ k: "row" }, 50), RM.GEOM.row);
  assert.strictEqual(
    RM.itemHeight({ k: "comment", a: { body: "x" } }, 50),
    RM.GEOM.cardHead + RM.GEOM.cardPad + RM.GEOM.cardLine
  );

  // Commit graph: a merge occupies one lane and branches out to a second.
  const { graph, maxLanes } = RM.computeGraph([
    { sha: "M", parents: ["A", "B"] },
    { sha: "A", parents: ["C"] },
    { sha: "B", parents: ["C"] },
    { sha: "C", parents: [] },
  ]);
  assert.strictEqual(graph[0].lane, 0, "head sits in the first lane");
  assert.strictEqual(graph[0].branches.length, 1, "a merge branches out to its second parent");
  assert.strictEqual(maxLanes, 2, "two lanes are enough for one merge");
  assert.strictEqual(RM.computeGraph([{ sha: "A", parents: [] }]).maxLanes, 1, "a lone commit needs one lane");
}

/* --- sidebar ---------------------------------------------------------------
   What the sidebar claims: one highlighted row wherever you are, and badges
   that agree with the rows underneath them. Both were HTML strings in app.js,
   so both drifted from the truth with nothing to catch it. */
{
  const rows = (row, localCount) => RM.sideRows({ row, localCount, base: "origin/main" });
  // The count is the working tree's, not the open scope's: 6 local changes are
  // still 6 while you are reading a commit.
  assert.deepStrictEqual(
    rows("All Commits", 6).map((r) => r.badge),
    ["6", "", ""],
    "leaving the worktree scope does not empty its badge"
  );
  assert.strictEqual(rows("All Commits", 0).find((r) => r.act === "scope-worktree").badge, "0");
  // Every row name the app stores lights exactly one row — including while a
  // commit is open, which keeps the row it was reached from.
  for (const row of ["Local Changes", "Branch", "All Commits"]) {
    const lit = rows(row, 3).filter((r) => r.active);
    assert.deepStrictEqual(lit.map((r) => r.row), [row], `${row} highlights its own row`);
  }
  assert.strictEqual(RM.sideRows({ row: "Local Changes", localCount: 1 }).length, 2, "no base ref, no branch row");

  const many = Array.from({ length: 305 }, (_, i) => ({ name: "b" + i }));
  assert.strictEqual(RM.sideGroup(many, 300).shown.length, 300, "long lists stay capped");
  assert.strictEqual(RM.sideGroup(many, 300).badge, "300/305", "a capped badge says what it is hiding");
  assert.deepStrictEqual(RM.sideGroup(many.slice(0, 3), 300), { shown: many.slice(0, 3), badge: "3" });
  assert.strictEqual(RM.sideGroup([{}, {}]).badge, "2", "an uncapped group is still counted");
  assert.strictEqual(RM.sideGroup([]).badge, "0");
}

// --- buildStream: many files, one windowed list ----------------------------
{
  const ctx = (i) => ({ t: "ctx", o: i, n: i, s: "line" + i });
  const mkRows = (n, changeAt) => {
    const rows = [];
    for (let i = 1; i <= n; i++) {
      if (i === changeAt) {
        rows.push({ t: "del", o: i, s: "old" + i });
        rows.push({ t: "add", n: i, s: "new" + i });
      } else rows.push(ctx(i));
    }
    return rows;
  };
  const files = [
    { path: "a.js", additions: 1, deletions: 1, status: "modified" },
    { path: "b.js", additions: 1, deletions: 1, status: "modified" },
    { path: "c.js", additions: 0, deletions: 0, status: "modified" },
  ];
  const perFile = new Map([
    ["a.js", { loaded: true, rows: mkRows(10, 5), expanded: new Set(), full: false }],
    ["b.js", { loaded: true, rows: mkRows(10, 5), expanded: new Set(), full: false }],
    // c.js not loaded yet
  ]);
  const base = {
    files,
    selected: new Set(["a.js", "b.js", "c.js"]),
    collapsed: new Set(),
    perFile,
    annotations: [],
    view: "unified",
    viewedSet: new Set(),
  };

  const out = RM.buildStream(base);
  assert.strictEqual(out.items[0].k, "fileHeader", "stream opens with a header");
  assert.strictEqual(out.items[0].f, "a.js");
  assert.strictEqual(out.segments.length, 3, "one segment per selected file");
  const segB = out.segments[1];
  assert.strictEqual(out.items[segB.start].k, "fileHeader");
  assert.strictEqual(out.items[segB.start].f, "b.js", "segments in file-list order");
  assert.ok(out.items.every((it) => it.f), "every stream item knows its file");
  const segC = out.segments[2];
  assert.strictEqual(out.items[segC.start + 1].k, "loading", "unloaded file holds a placeholder row");
  assert.strictEqual(RM.itemHeight(out.items[0]), RM.GEOM.fileHeader, "header height is fixed");
  assert.strictEqual(RM.itemHeight(out.items[segC.start + 1]), RM.GEOM.row, "loading row is row-height");

  // collapse: segment folds to its header
  const col = RM.buildStream({ ...base, collapsed: new Set(["a.js"]) });
  assert.strictEqual(col.segments[0].end - col.segments[0].start, 1, "collapsed file is header-only");
  assert.strictEqual(col.items[1].k, "fileHeader", "next header follows immediately");
  assert.strictEqual(col.items[1].f, "b.js");

  // selection: deselected file is absent entirely
  const sel = RM.buildStream({ ...base, selected: new Set(["b.js"]) });
  assert.strictEqual(sel.segments.length, 1);
  assert.ok(sel.items.every((it) => it.f === "b.js"), "deselected files leave no trace");

  // none selected: empty stream
  assert.strictEqual(RM.buildStream({ ...base, selected: new Set() }).items.length, 0);

  // binary/error file: header + note, no rows
  const pf2 = new Map(perFile);
  pf2.set("c.js", { loaded: true, binary: true });
  const bin = RM.buildStream({ ...base, perFile: pf2 });
  const segC2 = bin.segments[2];
  assert.strictEqual(bin.items[segC2.start + 1].k, "note", "binary renders as a note row");

  // regression: one selected, loaded file ≡ buildItems output plus its header
  const single = RM.buildStream({ ...base, selected: new Set(["a.js"]) });
  const legacy = RM.buildItems({
    rows: perFile.get("a.js").rows,
    annotations: [],
    file: "a.js",
    expanded: new Set(),
    full: false,
    view: "unified",
  });
  assert.strictEqual(single.items.length, legacy.items.length + 1, "stream = header + same items");
  assert.deepStrictEqual(
    single.items.slice(1).map((it) => it.k),
    legacy.items.map((it) => it.k),
    "same item kinds in the same order"
  );
  assert.strictEqual(single.maxLineLen, legacy.maxLineLen, "pan width carries over");

  // rowIndexFor with the file filter: same line number exists in both files
  const two = RM.buildStream({ ...base, selected: new Set(["a.js", "b.js"]) });
  const inB = RM.rowIndexFor(two.items, "new", 5, "b.js");
  assert.ok(inB > two.segments[1].start, "file-filtered lookup lands in b.js, not a.js");

  /* focusStep in a stream: both files number their lines 1..10, so a cursor that
     does not say which file it is in re-anchors on the first file that has the
     line and walks a.js while the reader is looking at b.js. */
  const rowsIn = (f) =>
    two.items.map((it, i) => ({ it, i })).filter((x) => x.it.k === "row" && x.it.f === f && x.it.u.r && x.it.u.r.n != null);
  const bRows = rowsIn("b.js");
  assert.ok(bRows.length > 2, "b.js has rows to walk");
  const from = { file: "b.js", side: "new", line: bRows[1].it.u.r.n };
  const stepped = RM.focusStep(two.items, from, 1);
  assert.strictEqual(stepped.index, bRows[2].i, "a file-aware cursor steps to the next row in b.js");
  assert.strictEqual(two.items[stepped.index].f, "b.js", "…and never crosses back into a.js");
  assert.strictEqual(
    RM.focusStep(two.items, { ...from, file: undefined }, 1).index,
    rowsIn("a.js")[2].i,
    "a fileless focus keeps the old, file-blind behavior"
  );

  /* Collapsing the file the cursor is in takes its rows out of the stream, and a
     file-aware cursor then matches nothing — focusStep falls back to the first
     row of the *whole* stream, which is a teleport to the top. app.js answers
     this by re-anchoring the cursor (`refocusOutOf`), and `rowLine` is exported
     for it: the app has to name a row it picked out of the stream itself. */
  const folded = RM.buildStream({ ...base, selected: new Set(["a.js", "b.js"]), collapsed: new Set(["b.js"]) });
  const firstRowAt = folded.items.findIndex((it) => it.k === "row");
  assert.strictEqual(folded.items[firstRowAt].f, "a.js", "the first row of the folded stream is back in a.js");
  assert.strictEqual(RM.focusStep(folded.items, from, 1).index, firstRowAt,
    "a cursor in a collapsed file falls back to row 0 — the app must re-anchor it");
  const firstRow = folded.items[firstRowAt];
  assert.deepStrictEqual(RM.rowLine(firstRow), { side: "new", line: firstRow.u.r.n }, "rowLine names a row's line");
  assert.strictEqual(RM.rowLine({ k: "fileHeader", f: "a.js" }), null, "…and only a row has one");
  const delOnly = { k: "row", f: "a.js", u: { t: "del", l: { o: 7, s: "x" }, r: null } };
  assert.deepStrictEqual(RM.rowLine(delOnly), { side: "old", line: 7 }, "a pure deletion is on the old side");

  // the v-loop walks only the selected stream
  const sel2 = ["a.js", "c.js"]; // b.js deselected
  assert.strictEqual(RM.nextUnviewed(sel2, "a.js", (p) => p === "a.js"), "c.js", "next unviewed skips deselected files");
}

// --- allviewed finish item + firstChangeRowIn ------------------------------
{
  const files = [
    { path: "a.js", additions: 1, deletions: 0 },
    { path: "b.js", additions: 1, deletions: 0 },
  ];
  const rows = [
    { t: "ctx", o: 1, n: 1, s: "one" },
    { t: "add", n: 2, s: "two" },
  ];
  const pf = new Map([
    ["a.js", { loaded: true, rows, expanded: new Set(), full: false }],
    ["b.js", { loaded: true, rows, expanded: new Set(), full: false }],
  ]);
  const sel = new Set(["a.js", "b.js"]);

  const done = RM.buildStream({
    files, selected: sel, collapsed: new Set(sel), perFile: pf,
    annotations: [{ file: "a.js", side: "new", line: 2, body: "x" }],
    viewedSet: new Set(sel),
  });
  const last = done.items[done.items.length - 1];
  assert.ok(last.k === "allviewed", "all viewed + all folded → finish item appended last");
  assert.ok(last.n === 2 && last.comments === 1, "finish item carries file and comment counts");
  assert.ok(done.segments.length === 2, "finish item is not a segment");

  const reading = RM.buildStream({ files, selected: sel, collapsed: new Set(), perFile: pf, viewedSet: new Set(sel) });
  assert.ok(!reading.items.some((it) => it.k === "allviewed"), "a file unfolded → still reading, no finish item");

  const part = RM.buildStream({ files, selected: sel, collapsed: new Set(["a.js"]), perFile: pf, viewedSet: new Set(["a.js"]) });
  assert.ok(!part.items.some((it) => it.k === "allviewed"), "one unviewed file → no finish item");

  const none = RM.buildStream({ files, selected: new Set(), collapsed: new Set(), perFile: pf, viewedSet: new Set() });
  assert.ok(!none.items.some((it) => it.k === "allviewed"), "empty selection → no finish item");

  assert.ok(RM.itemHeight({ k: "allviewed" }, 80) === RM.GEOM.allViewed, "allviewed row uses its GEOM height");

  const hit = RM.firstChangeRowIn(reading.items, reading.segments, "b.js");
  assert.ok(hit && hit.side === "new" && hit.line === 2, "firstChangeRowIn skips ctx, finds the add");
  assert.ok(reading.items[hit.index].f === "b.js", "firstChangeRowIn stays inside the file");

  const pf2 = new Map([["a.js", { loaded: true, rows, expanded: new Set(), full: false }]]);
  const loading = RM.buildStream({ files, selected: sel, collapsed: new Set(), perFile: pf2 });
  assert.ok(RM.firstChangeRowIn(loading.items, loading.segments, "b.js") === null, "unloaded file → null");
  assert.ok(RM.firstChangeRowIn(reading.items, reading.segments, "zzz.js") === null, "unknown file → null");

  // firstRowFrom: where an arrow key should land the cursor when it has no
  // real position yet but a pending-focus file names where the reader is.
  const fromB = RM.firstRowFrom(reading.items, reading.segments, "b.js");
  assert.ok(fromB >= reading.segments[1].start && fromB < reading.segments[1].end, "lands inside b.js's own segment when it has rows");
  assert.deepStrictEqual(RM.rowLine(reading.items[fromB]), { side: "new", line: 1 }, "…on its first row, ctx included (not just changes)");
  assert.strictEqual(RM.firstRowFrom(loading.items, loading.segments, "b.js"), -1, "b.js still loading, nothing after it → -1");
  assert.strictEqual(RM.firstRowFrom(reading.items, reading.segments, "zzz.js"), -1, "unknown file → -1");

  // A pending file that never gets a segment of its own to stand on scans past
  // it into whatever comes next, rather than giving up at the segment's own end.
  const files3 = [...files, { path: "c.js", additions: 1, deletions: 0 }];
  const sel3 = new Set(["a.js", "b.js", "c.js"]);
  const pf3 = new Map([
    ["a.js", { loaded: true, rows, expanded: new Set(), full: false }],
    ["c.js", { loaded: true, rows, expanded: new Set(), full: false }],
  ]);
  const skip = RM.buildStream({ files: files3, selected: sel3, collapsed: new Set(), perFile: pf3 });
  const fromBpastC = RM.firstRowFrom(skip.items, skip.segments, "b.js");
  const segC = skip.segments[2];
  assert.ok(fromBpastC >= segC.start && fromBpastC < segC.end, "b.js has no rows of its own → scan continues into c.js");

  // focusStep honors that anchor: forward lands exactly on it instead of on
  // row 0 of the whole stream (the teleport this exists to prevent).
  const anchored = RM.focusStep(reading.items, null, 1, fromB);
  assert.deepStrictEqual({ side: anchored.side, line: anchored.line }, { side: "new", line: 1 }, "anchorIndex seeds the step so dir=1 lands on it");
  assert.deepStrictEqual(
    RM.focusStep(reading.items, null, 1),
    RM.focusStep(reading.items, null, 1, -1),
    "a negative/absent anchorIndex is a no-op — same as today's rows[0] fallback"
  );
}

/* --- buildStream: per-file memoization --------------------------------------
   Every arrival used to rebuild every OTHER loaded file's rows too, so filling
   a large stream did quadratic work. buildStream now caches each file's body
   on the perFile state object the caller owns, keyed on everything the body
   depends on; only the fileHeader stays built fresh every call. */
{
  const ctx = (i) => ({ t: "ctx", o: i, n: i, s: "line" + i });
  const mkRows = (n, changeAt) => {
    const rows = [];
    for (let i = 1; i <= n; i++) {
      if (i === changeAt) {
        rows.push({ t: "del", o: i, s: "old" + i });
        rows.push({ t: "add", n: i, s: "new" + i });
      } else rows.push(ctx(i));
    }
    return rows;
  };
  const files = [
    { path: "a.js", additions: 1, deletions: 1, status: "modified" },
    { path: "b.js", additions: 1, deletions: 1, status: "modified" },
  ];
  const stA = { loaded: true, rows: mkRows(20, 10), expanded: new Set(), full: false };
  const stB = { loaded: true, rows: mkRows(20, 10), expanded: new Set(), full: false };
  const perFile = new Map([
    ["a.js", stA],
    ["b.js", stB],
  ]);
  const mkBase = (overrides) => ({
    files,
    selected: new Set(["a.js", "b.js"]),
    collapsed: new Set(),
    perFile,
    annotations: [],
    view: "split",
    viewedSet: new Set(),
    ...overrides,
  });
  const bodyOf = (out, fileIdx) => out.items.slice(out.segments[fileIdx].start + 1, out.segments[fileIdx].end);

  // 1. identical inputs (same Map, same st objects) → the row items for a file
  //    are the SAME object references both times, and outputs deep-equal.
  const r1 = RM.buildStream(mkBase());
  const r2 = RM.buildStream(mkBase());
  const bodyA1 = bodyOf(r1, 0);
  const bodyA2 = bodyOf(r2, 0);
  assert.strictEqual(bodyA1[0], bodyA2[0], "a.js's first body item is the same object reference across rebuilds");
  assert.deepStrictEqual(r1, r2, "identical inputs produce deep-equal output");

  // 2. opening a fold invalidates just that file's cache and reflects the change.
  const foldItem = bodyA1.find((it) => it.k === "fold");
  assert.ok(foldItem, "fixture has a fold to open");
  stA.expanded = new Set([foldItem.id]);
  const r3 = RM.buildStream(mkBase());
  const bodyA3 = bodyOf(r3, 0);
  assert.notStrictEqual(bodyA3[0], bodyA1[0], "opening a fold invalidates the cached body");
  assert.ok(!bodyA3.some((it) => it.k === "fold" && it.id === foldItem.id), "the opened fold no longer renders as a marker");
  stA.expanded = new Set(); // restore, so later steps compare against the same baseline

  // 3. changing the view invalidates the cache and re-stamps v on the rows.
  const rSplit = RM.buildStream(mkBase({ view: "split" }));
  const rowSplit = bodyOf(rSplit, 0).find((it) => it.k === "row");
  assert.strictEqual(rowSplit.v, "split");
  const rUnified = RM.buildStream(mkBase({ view: "unified" }));
  const rowUnified = bodyOf(rUnified, 0).find((it) => it.k === "row");
  assert.strictEqual(rowUnified.v, "unified", "view change re-stamps v");
  assert.notStrictEqual(rowSplit, rowUnified, "a different view produces a different cached body");

  // 4. adding an annotation on the file invalidates its cache and the card appears.
  const r4a = RM.buildStream(mkBase());
  const ann1 = [{ id: "z1", file: "a.js", side: "new", line: 10, body: "hi" }];
  const r4b = RM.buildStream(mkBase({ annotations: ann1 }));
  const bodyA4a = bodyOf(r4a, 0);
  const bodyA4b = bodyOf(r4b, 0);
  assert.notStrictEqual(bodyA4a[0], bodyA4b[0], "an annotation on this file invalidates its own cache");
  assert.ok(bodyA4b.some((it) => it.k === "comment"), "the comment card appears in the rebuilt body");

  // 5. an annotation on a DIFFERENT file leaves this file's body reference unchanged.
  const ann2 = ann1.concat([{ id: "z2", file: "b.js", side: "new", line: 10, body: "other" }]);
  const r5 = RM.buildStream(mkBase({ annotations: ann2 }));
  const bodyA5 = bodyOf(r5, 0);
  assert.strictEqual(bodyA4b[0], bodyA5[0], "a.js's cache survives an annotation added only to b.js");

  // 6. equivalence: memoized output deep-equals a completely fresh, un-memoized
  //    build — same kinds, same order, same v/sg stamps.
  const freshPerFile = new Map([
    ["a.js", { loaded: true, rows: mkRows(20, 10), expanded: new Set(), full: false }],
    ["b.js", { loaded: true, rows: mkRows(20, 10), expanded: new Set(), full: false }],
  ]);
  const memoized = RM.buildStream(mkBase({ annotations: ann2 }));
  const fresh = RM.buildStream({ ...mkBase({ annotations: ann2 }), perFile: freshPerFile });
  assert.strictEqual(memoized.items.length, fresh.items.length, "same item count");
  for (let i = 0; i < memoized.items.length; i++) {
    assert.strictEqual(memoized.items[i].k, fresh.items[i].k, `item ${i} kind matches`);
    if (memoized.items[i].k === "row") {
      assert.strictEqual(memoized.items[i].v, fresh.items[i].v, `item ${i} v matches`);
      assert.strictEqual(memoized.items[i].sg, fresh.items[i].sg, `item ${i} sg matches`);
    }
  }
  assert.strictEqual(memoized.maxLineLen, fresh.maxLineLen, "maxLineLen matches");
}

/* --- keyboard focus contract -----------------------------------------------
   The keydown handler needs a document, so the two decisions it kept getting
   wrong live in web/keys.js and are asserted here. A helper with the right
   answer is no use if app.js does not apply it, so the wiring — which only
   exists as code in a file that cannot be loaded outside a browser — is pinned
   by reading the source. */
{
  const K = require("./web/keys");
  const app = fs.readFileSync(path.join(__dirname, "web", "app.js"), "utf8");

  // Pressing `c` opened the comment box and then typed a "c" into it: the
  // keystroke reached the textarea it had just focused. Only `case "/"`
  // defaulted, so every other shortcut was one focus call away from the same
  // bug. The handler owns them all now.
  for (const k of K.SHORTCUTS) assert.strictEqual(K.shortcut({ key: k }), k, `${k} is a shortcut`);
  for (const k of "c/") assert.ok(K.SHORTCUTS.includes(k), `${k} focuses a text box, so it must be owned`);
  assert.strictEqual(K.shortcut({ key: "a" }), null, "an unbound key is left to the page");
  assert.strictEqual(K.shortcut({ key: "ArrowDown" }), null, "arrows are handled before the switch");
  assert.strictEqual(K.shortcut({ key: "" }), null, "no key is not a shortcut");
  assert.strictEqual(K.shortcut({ key: "?" }), "?", "shift is not a modifier here — ? is shift+/");
  // …but only unmodified, or defaulting them would eat the browser's own.
  assert.strictEqual(K.shortcut({ key: "c", metaKey: true }), null, "⌘C copies, it does not comment");
  assert.strictEqual(K.shortcut({ key: "f", ctrlKey: true }), null);
  assert.strictEqual(K.shortcut({ key: "v", altKey: true }), null);
  // One preventDefault for whatever the table owns, rather than one case
  // remembering and the next forgetting.
  assert.match(
    app,
    /const key = Keys\.shortcut\(e\);\s*if \(!key\) return;\s*e\.preventDefault\(\);/,
    "the handler defaults every owned shortcut in one place"
  );
  assert.ok(!/case "\/":\s*\n\s*e\.preventDefault\(\)/.test(app), "…and no case defaults on its own");

  // Escape has to release everything that can hold focus. It released four
  // things and not the file filter, which `/` is the documented way into.
  const shut = { popover: false, searchBar: false, modal: false, helpSheet: false, fileFilter: false };
  assert.strictEqual(K.dismissTarget(shut), null, "nothing open, nothing to dismiss");
  for (const id of K.DISMISS_ORDER) {
    assert.strictEqual(K.dismissTarget({ ...shut, [id]: true }), id, `Escape releases ${id}`);
  }
  assert.ok(K.DISMISS_ORDER.includes("fileFilter"), "the filter is escapable at all");
  assert.strictEqual(K.DISMISS_ORDER[K.DISMISS_ORDER.length - 1], "fileFilter", "…and last, being no overlay");
  // Topmost first: a popover over the modal closes itself, and nothing is ever
  // yanked out from under something drawn over it.
  assert.strictEqual(K.dismissTarget({ ...shut, popover: true, modal: true, fileFilter: true }), "popover");
  assert.strictEqual(K.dismissTarget({ ...shut, helpSheet: true, fileFilter: true }), "helpSheet");

  // Every entry needs a close in app.js, or Escape names something the page
  // cannot act on.
  for (const id of K.DISMISS_ORDER) {
    assert.match(app, new RegExp(`^\\s+${id}: \\w+,`, "m"), `app.js knows how to release ${id}`);
  }
  // …and every close hands focus back. Hiding an overlay with the caret still
  // inside leaves document.activeElement on a box nobody can see, and the
  // `typing` guard then swallows every shortcut after it.
  const closers = [...app.matchAll(/function (close\w+)\(\) \{[\s\S]*?\n\}/g)];
  assert.deepStrictEqual(
    closers.map((m) => m[1]).sort(),
    ["closeHelp", "closeModal", "closePopover", "closeSearch"],
    "one named close per dismissal, so there is one place to get this right"
  );
  for (const [body, name] of closers) assert.match(body, /restoreFocus\(\)/, `${name} hands focus back`);
  assert.ok(
    !/return \(\$\("#(modal|helpSheet)"\)\.hidden = true\)/.test(app),
    "no dismissal hides an overlay out from under the reader's focus"
  );

  // And the page has to load the policy, or every keystroke throws.
  const html = fs.readFileSync(path.join(__dirname, "web", "index.html"), "utf8");
  assert.match(html, /<script src="\/keys\.js"><\/script>/, "index.html loads keys.js");
  assert.ok(html.indexOf("/keys.js") < html.indexOf("/app.js"), "…before app.js reads window.Keys");
}

// --- drafts: selection and collapse survive a restart -----------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffo-drafts-"));
  process.env.DIFFOTATOR_DATA_DIR = dir;
  const D = require("./src/drafts");
  const root = "/fake/repo";
  D.saveDraft(root, { ann: [], viewed: ["s|a.js"], desel: ["s|b.js"], collapsed: ["s|a.js"] });
  const back = D.loadDraft(root);
  assert.deepStrictEqual(back.desel, ["s|b.js"], "deselection persisted");
  assert.deepStrictEqual(back.collapsed, ["s|a.js"], "collapse persisted");
  D.saveDraft(root, {}); // nothing left → draft file removed
  assert.strictEqual(D.loadDraft(root), null, "empty draft is cleared");
  delete process.env.DIFFOTATOR_DATA_DIR;
}

// --- git layer against a throwaway repo ------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffotator-test-"));
const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString();
sh("init", "-q", "-b", "main");
sh("config", "user.email", "t@t.t");
sh("config", "user.name", "T");

fs.writeFileSync(path.join(dir, "a.js"), "one\ntwo\nthree\nfour\nfive\n");
sh("add", "-A");
sh("commit", "-qm", "first");

fs.writeFileSync(path.join(dir, "a.js"), "one\nTWO\nthree\nfour\nfive\nsix\n");
fs.writeFileSync(path.join(dir, "new.txt"), "hello\n");

(async () => {
  const root = await G.repoRoot(dir);
  assert.strictEqual(root, fs.realpathSync(dir));

  const files = await G.changedFiles(root, { type: "worktree" });
  const paths = files.map((f) => f.path).sort();
  assert.deepStrictEqual(paths, ["a.js", "new.txt"], "tracked + untracked listed");
  assert.strictEqual(files.find((f) => f.path === "new.txt").status, "untracked");

  const d = await G.fileDiff(root, { type: "worktree" }, "a.js");
  const kinds = d.rows.map((r) => r.t).join(",");
  assert.ok(kinds.includes("del") && kinds.includes("add"), "modified line produces del+add");
  // full context requested → every original line is present
  assert.strictEqual(d.rows.filter((r) => r.t === "ctx").length, 4, "full context retained");
  const added = d.rows.filter((r) => r.t === "add").map((r) => r.s);
  assert.deepStrictEqual(added, ["TWO", "six"]);
  // line numbers must stay in step
  assert.strictEqual(d.rows.find((r) => r.s === "six").n, 6);

  const untracked = await G.fileDiff(root, { type: "worktree" }, "new.txt");
  assert.strictEqual(untracked.rows[0].t, "add", "untracked file renders as all-add");

  const full = await G.fileContent(root, { type: "worktree" }, "a.js");
  assert.strictEqual(full.rows.length, 6, "whole file readable, no phantom trailing line");
  assert.strictEqual(full.rows[5].s, "six");

  const log = await G.log(root, { limit: 5 });
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].subject, "first");
  assert.deepStrictEqual(log[0].parents, []);

  const tree = await G.tree(root, { type: "worktree" });
  assert.deepStrictEqual(tree, ["a.js", "new.txt"], "tree includes the untracked file");

  // commit scope
  sh("add", "-A");
  sh("commit", "-qm", "second");
  const head = (await G.log(root, { limit: 1 }))[0];
  const cf = await G.changedFiles(root, { type: "commit", sha: head.sha });
  assert.deepStrictEqual(cf.map((f) => f.path).sort(), ["a.js", "new.txt"]);

  fs.rmSync(dir, { recursive: true, force: true });
  await awkwardShapes();
  await gitFidelity();
  await draftsAndHook();
  await scopeKinds();
  await brokenAndEmptyRepos();
  await httpSurface();
  console.log("ok — all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

/* Every one of these was a real bug found by pointing the git layer at a repo
   that is not a straight line of ordinary commits. */
async function awkwardShapes() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "diffotator-shapes-"));
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "pipe" }).toString();
  const put = (p, s) => {
    fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
    fs.writeFileSync(path.join(d, p), s);
  };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "T");

  put("old-name.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  put("crlf.txt", "one\r\ntwo\r\n");
  fs.writeFileSync(path.join(d, "logo.bin"), Buffer.from([0, 1, 2, 255, 0]));
  g("add", "-A");
  g("commit", "-qm", "root");
  const ROOT = g("rev-parse", "HEAD").trim();

  g("checkout", "-qb", "feature");
  fs.mkdirSync(path.join(d, "sub"), { recursive: true });
  g("mv", "old-name.ts", "sub/new-name.ts");
  put("sub/new-name.ts", "const a = 1;\nconst b = 22;\nconst c = 3;\n");
  g("add", "-A");
  g("commit", "-qm", "rename+edit");

  g("checkout", "-q", "main");
  put("main-only.ts", "const m = 1;\n");
  g("add", "-A");
  g("commit", "-qm", "main side");
  g("merge", "-q", "--no-ff", "feature", "-m", "merge feature");
  const MERGE = g("rev-parse", "HEAD").trim();

  const root = await G.repoRoot(d);

  // A root commit has no parent to exclude, so `sha^!` diffs it the wrong way.
  const rootFiles = await G.changedFiles(root, { type: "commit", sha: ROOT });
  assert.deepStrictEqual(
    rootFiles.map((f) => f.status).sort(),
    ["added", "added", "added"],
    "root commit is all additions"
  );
  const rootDiff = await G.fileDiff(root, { type: "commit", sha: ROOT }, "old-name.ts");
  assert.ok(rootDiff.rows.every((r) => r.t === "add"), "root commit diff is not reversed");

  // `sha^!` excludes every parent, so a merge diffs to nothing at all.
  const mergeFiles = await G.changedFiles(root, { type: "commit", sha: MERGE });
  assert.ok(mergeFiles.length > 0, "merge commit shows what it merged in");
  const renamed = mergeFiles.find((f) => f.status === "renamed");
  assert.ok(renamed, "rename is detected across the merge");
  assert.strictEqual(renamed.path, "sub/new-name.ts");
  assert.strictEqual(renamed.oldPath, "old-name.ts");
  // numstat compresses renames to `{old => new}`; unexpanded it reports +0/-0.
  assert.strictEqual(renamed.additions, 1, "renamed file keeps its line stats");
  assert.strictEqual(renamed.deletions, 1);

  // The timeline wants the branch's own story: first-parent keeps the merge as
  // one entry instead of spilling the merged branch's commits into the list.
  const full = await G.log(root, { rev: `${ROOT}..HEAD` });
  const story = await G.log(root, { rev: `${ROOT}..HEAD`, firstParent: true });
  assert.strictEqual(full.length, 3, "plain range walk includes the merged-in commit");
  assert.deepStrictEqual(
    story.map((c) => c.subject),
    ["merge feature", "main side"],
    "first-parent walk is the branch's own commits"
  );

  const crlf = await G.fileContent(root, { type: "commit", sha: ROOT }, "crlf.txt");
  assert.deepStrictEqual(crlf.rows.map((r) => r.s), ["one", "two"], "CRLF and phantom line stripped");

  const bin = await G.fileDiff(root, { type: "commit", sha: ROOT }, "logo.bin");
  assert.strictEqual(bin.binary, true, "binary reported, not rendered blank");

  // Files git does not track yet are exactly what an agent just wrote.
  put("brand/new/deep.ts", "const deep = 1;\n");
  const tree = await G.tree(root, { type: "worktree" });
  assert.ok(tree.includes("brand/new/deep.ts"), "untracked files are browsable in the tree");
  const wt = await G.changedFiles(root, { type: "worktree" });
  assert.strictEqual(wt.find((f) => f.path === "brand/new/deep.ts").additions, 1, "no phantom line in count");

  fs.rmSync(d, { recursive: true, force: true });
}

/* git says more about a change than the paths and the +/− counts, and every one
   of these facts used to be parsed away: the real bytes of a filename, the line
   endings, the missing final newline, the file mode, and which revision a
   detached worktree is actually on. A reviewer who cannot see them is being
   shown a change that reads as no change. */
async function gitFidelity() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "diffotator-fidelity-"));
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "pipe" }).toString();
  const put = (p, s) => fs.writeFileSync(path.join(d, p), s);
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "T");

  const ROCKET = "rocket 🚀.md";
  put(ROCKET, "hi\n");
  put("crlf.txt", "one\r\ntwo\r\nthree\r\n");
  put("nonl.txt", "no trailing newline here");
  put("mode.txt", "unchanged\n");
  g("add", "-A");
  g("commit", "-qm", "root");

  put(ROCKET, "hi\nthere\n");
  put("crlf.txt", "one\ntwo\nthree\n");
  put("nonl.txt", "no trailing newline here\nsecond line still no newline");
  fs.chmodSync(path.join(d, "mode.txt"), 0o755);

  const root = await G.repoRoot(d);
  const wt = { type: "worktree" };

  // git C-quotes and octal-escapes a non-ASCII path by default, and a path in
  // that shape cannot be handed back to git — the file becomes unopenable.
  const listed = (await G.changedFiles(root, wt)).map((f) => f.path);
  assert.ok(listed.includes(ROCKET), `changed list carries the real path, got ${JSON.stringify(listed)}`);
  assert.ok((await G.tree(root, wt)).includes(ROCKET), "and so does the tree, not just one of them");
  const rocket = await G.fileDiff(root, wt, ROCKET);
  assert.ok(rocket.rows.some((r) => r.t === "add" && r.s === "there"), "…and the path opens");

  // CRLF → LF changes every line without changing a single glyph, so both sides
  // of the diff render identically unless the row remembers the \r it lost.
  const crlf = await G.fileDiff(root, wt, "crlf.txt");
  const dels = crlf.rows.filter((r) => r.t === "del");
  const adds = crlf.rows.filter((r) => r.t === "add");
  assert.strictEqual(dels.length, 3, "three lines changed");
  assert.deepStrictEqual(dels.map((r) => r.s), adds.map((r) => r.s), "both sides read the same text…");
  assert.ok(dels.every((r) => r.cr), "…so the old side has to say it was CRLF");
  assert.ok(adds.every((r) => !r.cr), "…and the new side has to say it is not");

  // "\ No newline at end of file" is git describing the row above it; dropped,
  // an added final newline reads as a deletion and addition of the same text.
  const nonl = await G.fileDiff(root, wt, "nonl.txt");
  assert.ok(nonl.rows.find((r) => r.t === "del").nonl, "old last line ended without a newline");
  assert.ok(!nonl.rows.find((r) => r.t === "add" && r.s.startsWith("no trailing")).nonl, "its twin did not");
  assert.ok(nonl.rows[nonl.rows.length - 1].nonl, "and the new last line ends without one too");

  // A chmod is the whole change: there are no hunks to carry it, so a parser
  // that only reads hunks shows the file as +0/−0 with nothing to review.
  const mode = await G.fileDiff(root, wt, "mode.txt");
  assert.deepStrictEqual(mode.mode, { old: "100644", new: "100755" }, "mode change survives parsing");
  assert.strictEqual(mode.empty, true, "…and it is the only thing that changed");
  assert.ok(!crlf.mode, "an ordinary edit reports no mode change");

  // "(detached)" is a label for a human. Sent to git as a revision it resolves
  // to nothing, and two detached worktrees would carry the same one.
  const det = d + "-det";
  g("worktree", "add", "-q", "--detach", det, "HEAD");
  const { worktrees } = await G.overview(root);
  const w = worktrees.find((x) => x.name === path.basename(det));
  assert.ok(w, "detached worktree is listed");
  assert.ok(!w.branch, "a detached worktree has no branch name to pass off as a revision");
  assert.match(w.head, /^[0-9a-f]{7,}$/, "…it has a HEAD sha instead");
  const revLog = await G.log(root, { rev: w.branch || w.head, limit: 5 });
  assert.strictEqual(revLog.length, 1, "and that revision resolves to commits");
  assert.strictEqual(worktrees[0].branch, "main", "an attached worktree still reports its branch");

  // --base must actually pin the base: the flag used to be parsed and dropped.
  {
    g("checkout", "-q", "-b", "feature");
    put("feat.txt", "feature work\n");
    g("add", "-A");
    g("commit", "-qm", "feature commit");
    g("branch", "-q", "sidebranch", "main"); // a second valid base candidate

    const forced = await G.overview(root, { base: "sidebranch" });
    assert.strictEqual(forced.base && forced.base.ref, "sidebranch", "--base pins the base");

    const bogus = await G.overview(root, { base: "no-such-ref" });
    assert.ok(bogus.base && bogus.base.ref !== "no-such-ref", "invalid --base falls back to auto-detect");
  }

  g("worktree", "remove", "--force", det);
  fs.rmSync(det, { recursive: true, force: true });
  fs.rmSync(d, { recursive: true, force: true });
}

/* The Stop hook's whole risk is firing when it shouldn't, so the gate is the
   part that needs pinning down — not the browser it eventually opens. */
async function draftsAndHook() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "diffotator-data-"));
  process.env.DIFFOTATOR_DATA_DIR = home;
  delete require.cache[require.resolve("./src/drafts")];
  delete require.cache[require.resolve("./src/hook")];
  const D = require("./src/drafts");
  const H = require("./src/hook");

  const d = fs.mkdtempSync(path.join(os.tmpdir(), "diffotator-hook-"));
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "pipe" }).toString();
  const put = (p, s) => fs.writeFileSync(path.join(d, p), s);
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "T");
  put("a.ts", "const a = 1;\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  const root = await G.repoRoot(d);

  // --- drafts survive a process boundary, which localStorage did not --------
  assert.strictEqual(D.loadDraft(root), null, "no draft to begin with");
  D.saveDraft(root, { ann: [{ id: "a1", file: "a.ts", line: 1, body: "hm" }], viewed: ["worktree|a.ts"] });
  const back = D.loadDraft(root);
  assert.strictEqual(back.ann.length, 1, "annotations round-trip through disk");
  assert.deepStrictEqual(back.viewed, ["worktree|a.ts"], "viewed state round-trips");
  D.clearDraft(root);
  assert.strictEqual(D.loadDraft(root), null, "submitting clears the draft");

  // --- the gate ------------------------------------------------------------
  const at = (input, opts) => H.decide({ cwd: d, ...input }, opts);

  assert.strictEqual((await at({})).verdict, "allow", "clean tree never interrupts");
  assert.strictEqual((await at({})).why, "clean-tree");

  put("a.ts", "const a = 2;\n");
  assert.strictEqual((await at({}, { minFiles: 3 })).verdict, "allow", "a one-file turn is below threshold");
  assert.match((await at({}, { minFiles: 3 })).why, /below-threshold/);

  put("b.ts", "const b = 1;\n");
  put("c.ts", "const c = 1;\n");
  const hit = await at({}, { minFiles: 3 });
  assert.strictEqual(hit.verdict, "review", "three changed files opens a review");
  assert.strictEqual(hit.files, 3);

  // Approving must not re-open on the very next Stop.
  D.saveHookState(root, { reviewed: hit.fingerprint, decision: "approved" });
  const again = await at({}, { minFiles: 3 });
  assert.strictEqual(again.verdict, "allow", "an unchanged tree stays quiet after review");
  assert.strictEqual(again.why, "unchanged-since-review");

  // ...but editing the same file in place must count as new work. A file-list
  // fingerprint would wrongly call this "already reviewed".
  put("a.ts", "const a = 3;\n");
  assert.strictEqual((await at({}, { minFiles: 3 })).verdict, "review", "in-place edits re-open");

  assert.strictEqual((await at({ stop_hook_active: true }, { minFiles: 3 })).verdict, "allow", "cannot loop");
  assert.strictEqual((await at({}, { minFiles: 3, enabled: false })).verdict, "allow", "kill switch");
  assert.strictEqual((await H.decide({ cwd: os.tmpdir() }, { minFiles: 1 })).why, "not-a-repo");

  // --- harness contract ----------------------------------------------------
  assert.deepStrictEqual(H.stopOutput(null), {}, "allowing a stop emits no decision");
  assert.deepStrictEqual(
    H.stopOutput("fix this"),
    { decision: "block", reason: "fix this" },
    "feedback blocks the stop and carries the reason"
  );

  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.DIFFOTATOR_DATA_DIR;
}

/* Every question about a scope is answered by one table entry, so the thing
   worth pinning down is that each kind answers all of them — and that a ref
   arriving from a query string cannot turn into a git option. */
async function scopeKinds() {
  // A sample per kind. Adding a kind without one fails here, which is the point.
  const SAMPLES = {
    worktree: { type: "worktree" },
    commit: { type: "commit", sha: "deadbeefdeadbeefdeadbeef" },
    range: { type: "range", base: "origin/main", head: "HEAD" },
  };
  assert.deepStrictEqual(Object.keys(SAMPLES).sort(), Scope.TYPES.slice().sort(), "every kind has a sample");

  for (const [type, scope] of Object.entries(SAMPLES)) {
    assert.deepStrictEqual(Scope.parse(Scope.encode(scope)), scope, `${type} round-trips through the wire form`);
    assert.ok(Scope.label(scope), `${type} has a label`);
    assert.ok(Scope.rev(scope), `${type} names a revision`);
  }

  assert.strictEqual(Scope.encode(SAMPLES.commit), "commit:deadbeefdeadbeefdeadbeef");
  assert.strictEqual(Scope.encode(SAMPLES.range), "range:origin/main...HEAD");
  assert.strictEqual(Scope.label(SAMPLES.commit), "commit deadbeef", "labels are short");
  assert.strictEqual(Scope.rev(SAMPLES.range), "HEAD", "a range shows its head side");
  assert.strictEqual(Scope.rev(SAMPLES.commit), SAMPLES.commit.sha);

  // Missing and unparseable input.
  assert.deepStrictEqual(Scope.parse(null), { type: "worktree" }, "no scope means the working tree");
  assert.deepStrictEqual(Scope.parse(""), { type: "worktree" });
  assert.strictEqual(Scope.isWorktree(Scope.parse(null)), true);
  assert.strictEqual(Scope.isWorktree(SAMPLES.commit), false);
  assert.throws(() => Scope.parse("wat:1"), /unknown scope/, "an unknown kind is refused, not guessed");
  assert.throws(() => Scope.parse("range:main"), /invalid range/, "a range needs both endpoints");
  assert.throws(() => Scope.parse("commit:"), /invalid sha/);

  // Refs become git arguments, so a leading dash would become an option.
  assert.throws(() => Scope.parse("commit:--upload-pack=evil"), /invalid sha/, "option injection refused");
  assert.throws(() => Scope.parse("range:-x...HEAD"), /invalid base/);
  assert.throws(() => Scope.parse("commit:a b"), /invalid sha/, "whitespace refused");
  assert.throws(() => Scope.encode({ type: "commit", sha: "--evil" }), /invalid sha/, "refused on the way out too");
  // The same check is exported for the revisions that reach git outside a scope.
  assert.strictEqual(Scope.ref("origin/main", "rev"), "origin/main");
  assert.throws(() => Scope.ref("--output=.git/config", "rev"), /invalid rev/);

  // diffArgs names both sides. The git facts arrive through an injected port.
  const port = {
    headExists: async () => true,
    emptyTree: async () => "EMPTYTREE",
    parents: async (sha) => (sha === "rootsha" ? [] : ["parent1", "parent2"]),
  };
  assert.deepStrictEqual(await Scope.diffArgs(SAMPLES.worktree, port), ["HEAD"]);
  assert.deepStrictEqual(
    await Scope.diffArgs(SAMPLES.worktree, { ...port, headExists: async () => false }),
    ["EMPTYTREE"],
    "a repo with no commits diffs against the empty tree"
  );
  assert.deepStrictEqual(
    await Scope.diffArgs({ type: "commit", sha: "rootsha" }, port),
    ["EMPTYTREE", "rootsha"],
    "a root commit has no parent to exclude"
  );
  assert.deepStrictEqual(
    await Scope.diffArgs({ type: "commit", sha: "mergesha" }, port),
    ["parent1", "mergesha"],
    "a merge diffs against its first parent only"
  );
  assert.deepStrictEqual(await Scope.diffArgs(SAMPLES.range, port), ["origin/main...HEAD"]);
}

/* Two repo shapes that used to be read wrong in silence. */
async function brokenAndEmptyRepos() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "diffotator-shapes2-"));
  process.env.DIFFOTATOR_DATA_DIR = home;
  delete require.cache[require.resolve("./src/hook")];
  const H = require("./src/hook");

  // --- a repo with no commits yet: what an agent scaffolding a project leaves.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "diffotator-fresh-"));
  const gf = (...a) => execFileSync("git", a, { cwd: fresh, stdio: "pipe" }).toString();
  gf("init", "-q", "-b", "main");
  gf("config", "user.email", "t@t.t");
  gf("config", "user.name", "T");
  fs.writeFileSync(path.join(fresh, "staged.ts"), "const s = 1;\n");
  fs.writeFileSync(path.join(fresh, "loose.ts"), "const l = 1;\n");
  gf("add", "staged.ts");

  const root = await G.repoRoot(fresh);
  const files = await G.changedFiles(root, { type: "worktree" });
  const byPath = new Map(files.map((f) => [f.path, f]));
  // There is no HEAD to diff against, so a staged file used to vanish entirely.
  assert.ok(byPath.has("staged.ts"), "a staged file shows up before the first commit");
  assert.strictEqual(byPath.get("staged.ts").status, "added");
  assert.ok(byPath.has("loose.ts"), "untracked files still listed");
  // Browsing must survive having no tree to list.
  assert.deepStrictEqual((await G.tree(root, { type: "worktree" })).sort(), ["loose.ts", "staged.ts"]);
  assert.deepStrictEqual(await G.log(root, { limit: 5 }), [], "no commits, no log, no crash");
  assert.strictEqual((await H.decide({ cwd: fresh }, { minFiles: 2 })).verdict, "review", "a fresh repo is reviewable");

  // --- a repo git itself cannot read.
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "diffotator-broken-"));
  const gb = (...a) => execFileSync("git", a, { cwd: bad, stdio: "pipe" }).toString();
  gb("init", "-q", "-b", "main");
  gb("config", "user.email", "t@t.t");
  gb("config", "user.name", "T");
  fs.writeFileSync(path.join(bad, "a.ts"), "const a = 1;\n");
  gb("add", "-A");
  gb("commit", "-qm", "init");
  fs.writeFileSync(path.join(bad, "a.ts"), "const a = 2;\n");
  // The repo still resolves, but reading the diff fails — the one shape where a
  // swallowed error is indistinguishable from "nothing to review".
  fs.writeFileSync(path.join(bad, ".git", "index"), "GARBAGE-NOT-AN-INDEX");
  const badRoot = await G.repoRoot(bad);
  await assert.rejects(() => G.changedFiles(badRoot, { type: "worktree" }), /git diff/, "reading the review is a fault");
  const verdict = await H.decide({ cwd: bad }, { minFiles: 1 });
  assert.strictEqual(verdict.verdict, "allow", "a broken repo does not open a browser");
  assert.match(verdict.why, /^git-error/, "…and says so, instead of claiming the tree is clean");
  assert.strictEqual(verdict.failed, true, "…marked as a failure, not one of the quiet reasons");

  /* A reason nobody can see is still a silent failure, so exercise the real
     entry point: `run` must report this one without DIFFOTATOR_DEBUG, and must
     still let the turn end rather than holding the agent hostage over a broken
     repo it cannot do anything about. */
  const cwd = process.cwd();
  const tty = process.stdin.isTTY;
  const write = process.stderr.write.bind(process.stderr);
  const said = [];
  process.chdir(bad);
  process.stdin.isTTY = true; // no harness on the pipe; do not wait for one
  process.stderr.write = (s) => (said.push(String(s)), true);
  delete process.env.DIFFOTATOR_DEBUG;
  try {
    const out = await H.run({
      openReview: () => assert.fail("a repo we cannot read must not open a browser"),
    });
    assert.deepStrictEqual(out, {}, "the turn still ends");
  } finally {
    process.stderr.write = write;
    process.stdin.isTTY = tty;
    process.chdir(cwd);
  }
  assert.ok(
    said.some((s) => /could not inspect the repository/.test(s)),
    "the failure reaches stderr, not just the return value"
  );

  fs.rmSync(fresh, { recursive: true, force: true });
  fs.rmSync(bad, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.DIFFOTATOR_DATA_DIR;
}

/* The HTTP surface had no test at all: the route table and the session promise
   are what a browser and the CLI actually agree on. */
async function httpSurface() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "diffotator-http-"));
  process.env.DIFFOTATOR_DATA_DIR = home;
  delete require.cache[require.resolve("./src/server")];
  const { createServer, ROUTES } = require("./src/server");

  for (const key of Object.keys(ROUTES)) {
    assert.match(key, /^(GET|POST) \/api\/[a-z]+$/, `route key is "METHOD /path": ${key}`);
  }

  const d = fs.mkdtempSync(path.join(os.tmpdir(), "diffotator-http-repo-"));
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "T");
  fs.writeFileSync(path.join(d, "a.ts"), "const a = 1;\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  fs.writeFileSync(path.join(d, "a.ts"), "const a = 2;\n");

  const root = await G.repoRoot(d);
  const server = createServer({ root, title: "session title" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (p, opts) => (await fetch(base + p, opts)).json();
  const status = async (p, opts) => (await fetch(base + p, opts)).status;

  const ov = await json("/api/overview");
  assert.strictEqual(ov.title, "session title", "the session title reaches the page");
  assert.strictEqual(ov.branch, "main");

  const { files } = await json("/api/files?scope=worktree");
  assert.deepStrictEqual(
    files.map((f) => f.path),
    ["a.ts"]
  );
  const { diff } = await json("/api/diff?scope=worktree&file=a.ts");
  assert.ok(diff.rows.some((r) => r.t === "add" && r.s === "const a = 2;"));
  const head = (await G.log(root, { limit: 1 }))[0];
  const commitScope = await json(`/api/files?scope=commit:${head.sha}`);
  assert.deepStrictEqual(
    commitScope.files.map((f) => f.status),
    ["added"],
    "a commit scope survives the round trip through the query string"
  );

  // Commit metadata and a rev-filtered log: the two endpoints that hand a
  // caller-supplied revision to git *outside* a scope.
  const one = await json(`/api/commit?sha=${head.sha}`);
  assert.strictEqual(one.meta.subject, "init", "commit metadata round-trips");
  assert.deepStrictEqual(
    one.files.map((f) => f.path),
    ["a.ts"]
  );
  assert.strictEqual((await json("/api/commits?rev=main")).commits.length, 1, "a rev-filtered log works");

  // A malformed scope is refused rather than quietly reviewed as the worktree.
  assert.strictEqual(await status("/api/files?scope=commit:--upload-pack=evil"), 500);
  assert.strictEqual(await status("/api/files?scope=nonsense"), 500);

  /* `sha` and `rev` reach git outside a scope, and a revision that git reads as
     an option is not a parse error — `--output=<path>` truncates the file it
     names. Any page in the browser can reach this loopback port, so the check
     has to hold at the HTTP edge, not just in the scope vocabulary. */
  const config = path.join(d, ".git", "config");
  const before = fs.readFileSync(config, "utf8");
  for (const p of [
    "/api/commit?sha=--output%3D.git%2Fconfig",
    "/api/commits?rev=--output%3D.git%2Fconfig",
    "/api/commits?rev=-x",
  ]) {
    assert.strictEqual(await status(p), 500, `refused: ${p}`);
  }
  assert.strictEqual(fs.readFileSync(config, "utf8"), before, "and nothing was written over");
  // Ordinary revisions still work — the check refuses options, not history.
  assert.ok((await json("/api/commits?rev=HEAD")).commits.length, "HEAD is still a revision");
  // …and so are bare revisions, which reach git without a scope to guard them.
  // `git log --output=<path>` truncates the file it names.
  assert.strictEqual(await status("/api/commits?rev=--output=pwned"), 500);
  assert.strictEqual(await status("/api/commit?sha=-x"), 500);
  // Method is part of the route, so a GET to a mutating endpoint is not a 200.
  assert.strictEqual(await status("/api/submit"), 404);
  assert.strictEqual(await status("/api/nope"), 404);
  // Static, including the scope module shared with the git layer.
  assert.strictEqual(await status("/"), 200);
  assert.strictEqual(await status("/scope.js"), 200, "the browser can load the shared scope vocabulary");
  assert.strictEqual(await status("/review-model.js"), 200);
  assert.strictEqual(await status("/keys.js"), 200, "…and the keyboard policy it shares with the page");
  assert.strictEqual(await status("/%2e%2e%2fpackage.json"), 404, "static serving stays inside web/");

  // Submitting resolves the session promise; the server never touches teardown.
  assert.deepStrictEqual(
    await json("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: "annotated",
        summary: "looks close",
        scope: { type: "worktree" },
        annotations: [{ file: "a.ts", side: "new", line: 1, label: "issue", blocking: true, body: "null deref" }],
      }),
    }),
    { ok: true }
  );
  const result = await server.submitted;
  assert.strictEqual(result.decision, "annotated");
  assert.ok(result.output.includes("looks close"), "the summary is rendered for the agent");
  assert.ok(result.output.includes("1 blocking comment"));
  assert.ok(result.output.includes("working tree vs HEAD"), "one scope label, shared with the page");

  await new Promise((r) => server.close(r));
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.DIFFOTATOR_DATA_DIR;
}
