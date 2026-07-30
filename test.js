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
  assert.strictEqual(full.rows.length, 7, "whole file readable for out-of-diff review");

  const log = await G.log(root, { limit: 5 });
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].subject, "first");
  assert.deepStrictEqual(log[0].parents, []);

  const tree = await G.tree(root, { type: "worktree" });
  assert.deepStrictEqual(tree, ["a.js"]);

  // commit scope
  sh("add", "-A");
  sh("commit", "-qm", "second");
  const head = (await G.log(root, { limit: 1 }))[0];
  const cf = await G.changedFiles(root, { type: "commit", sha: head.sha });
  assert.deepStrictEqual(cf.map((f) => f.path).sort(), ["a.js", "new.txt"]);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("ok — all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
