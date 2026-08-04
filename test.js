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
  assert.ok(highlight('x = "hi" // c', "ts").includes('<span class="s">"hi"</span>'), "string token");
  assert.ok(highlight("def f(): # c", "py").includes('<span class="c"># c</span>'), "# is a comment in python");
  assert.ok(!highlight("a #b", "ts").includes('class="c"'), "# is not a comment in ts");
  assert.strictEqual(esc("<script>&"), "&lt;script&gt;&amp;", "html is escaped");
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
  /* The assertions below match the text of app.js, because the wiring they
     protect only exists in a file that needs a document to run. That makes them
     brittle to reformatting on purpose: if one fails after a change that altered
     no behaviour, re-pin the pattern — deleting it removes the only thing holding
     the fix in place. */
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
  /* …and hands it back to the pane it read *first*. Hiding a focused element
     blurs it, so a closer that asks afterwards is asking about `<body>` and only
     lands right through curPane()'s fallback. */
  for (const [body, name] of closers) {
    assert.match(body, /const pane = curPane\(\);/, `${name} reads the pane before hiding anything`);
    assert.match(body, /restoreFocus\(pane\)/, `${name} hands focus back to it`);
  }
  assert.ok(
    !/return \(\$\("#(modal|helpSheet)"\)\.hidden = true\)/.test(app),
    "no dismissal hides an overlay out from under the reader's focus"
  );

  // And the page has to load the policy, or every keystroke throws.
  const html = fs.readFileSync(path.join(__dirname, "web", "index.html"), "utf8");
  assert.match(html, /<script src="\/keys\.js"><\/script>/, "index.html loads keys.js");
  assert.ok(html.indexOf("/keys.js") < html.indexOf("/app.js"), "…before app.js reads window.Keys");
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
