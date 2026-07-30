#!/usr/bin/env node
"use strict";
/* Smallest thing that fails if the logic breaks. `node test.js` */
const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const G = require("./src/git");
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
