#!/usr/bin/env node
"use strict";
/* Builds site/demo/: the real diffotator page plus a recording of one review,
 * so the website (diffotator.vercel.app) can run the actual app with no server
 * behind it. Maintainers run it after changing web/ or the sample change; the
 * website serves what it writes. site/demo/demo.js stands in for the server by
 * answering the page's /api calls from the recording.
 *
 *   node scripts/build-demo.js <repo> <base> <walkthrough.json>
 */
const fs = require("fs");
const path = require("path");
const G = require("../src/git");
const Scope = require("../src/scope");
const W = require("../src/walkthrough");

const [repoArg, base, wtPath] = process.argv.slice(2);
if (!repoArg || !base || !wtPath) {
  process.stderr.write("usage: node scripts/build-demo.js <repo> <base> <walkthrough.json>\n");
  process.exit(1);
}
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "site", "demo");

(async () => {
  const root = await G.repoRoot(repoArg);
  const raw = JSON.parse(fs.readFileSync(wtPath, "utf8"));
  const overview = { ...(await G.overview(root, { base })), title: raw.title, walkthrough: true, draft: null };
  const branch = await G.log(root, { rev: `${base}..HEAD`, limit: 500, firstParent: true });

  // Every scope the page can reach: the branch, and each commit alone or up to it.
  const scopes = [{ type: "range", base, head: "HEAD" }, { type: "worktree" }];
  for (const c of branch) scopes.push({ type: "commit", sha: c.sha }, { type: "range", base, head: c.sha });

  const recorded = {};
  for (const scope of scopes) {
    const files = await G.changedFiles(root, scope);
    const diffs = {}, full = {};
    for (const f of files) {
      diffs[f.path] = await G.fileDiff(root, scope, f.path);
      full[f.path] = await G.fileContent(root, scope, f.path);
    }
    const paths = files.map((f) => f.path);
    recorded[Scope.encode(scope)] = { files, diffs, full, tree: await G.tree(root, scope), walkthrough: W.validate(raw, paths) };
  }

  const commitMeta = {};
  for (const c of branch) commitMeta[c.sha] = { meta: await G.commitMeta(root, c.sha), files: await G.changedFiles(root, { type: "commit", sha: c.sha }) };

  // Domain docs the walkthrough links to, read at the branch head.
  const docs = {};
  for (const t of raw.terms || []) if (t.source) docs[t.source] = await G.fileContent(root, { type: "range", base, head: "HEAD" }, t.source);

  const data = { overview, commits: { branch, all: await G.log(root, { limit: 500 }) }, commitMeta, scopes: recorded, docs };
  // The website is public: no path from the machine that made the recording.
  const json = JSON.stringify(data).split(root).join("~/" + path.basename(root));
  if (json.includes(path.dirname(root))) throw new Error("a local path is still in the recording");

  // The page itself, copied from web/ with root-relative paths made relative,
  // and the stand-in server loaded before anything asks it for data.
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "vendor"), { recursive: true });
  for (const f of ["app.js", "walk.js", "ask.js", "style.css", "highlight.js", "keys.js", "review-model.js"]) fs.copyFileSync(path.join(ROOT, "web", f), path.join(OUT, f));
  for (const f of ["canvas.js", "canvas.css"]) fs.copyFileSync(path.join(ROOT, "web", "vendor", f), path.join(OUT, "vendor", f));
  for (const f of ["scope.js", "walkthrough.js"]) fs.copyFileSync(path.join(ROOT, "src", f), path.join(OUT, f));
  // feedback.js is CommonJS; the stand-in renders "what Claude reads" with it.
  fs.writeFileSync(
    path.join(OUT, "feedback.js"),
    `(function(){var module={exports:{}};var require=function(){return window.Scope};\n${fs.readFileSync(path.join(ROOT, "src", "feedback.js"), "utf8")}\nwindow.Feedback=module.exports;})();\n`
  );
  let html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8").replace(/(href|src)="\//g, '$1="');
  html = html.replace('<script src="scope.js"></script>', '<script src="scope.js"></script>\n<script src="feedback.js"></script>\n<script src="demo.js"></script>');
  if (!html.includes('src="demo.js"')) throw new Error("index.html changed shape: could not insert demo.js");
  // Vercel serves this page at /demo (no trailing slash), where relative paths
  // would resolve from the site root; the base tag pins them to the folder.
  html = html.replace("<head>", '<head>\n<base href="/demo/">');
  fs.writeFileSync(path.join(OUT, "index.html"), html.replace("<title>diffotator</title>", "<title>diffotator — live demo</title>"));
  fs.copyFileSync(path.join(ROOT, "site-src", "demo.js"), path.join(OUT, "demo.js"));
  fs.writeFileSync(path.join(OUT, "data.json"), json);
  process.stderr.write(`demo: ${Object.keys(recorded).length} scopes, ${recorded[Scope.encode(scopes[0])].files.length} files → ${path.relative(ROOT, OUT)}\n`);
})().catch((e) => {
  process.stderr.write(String((e && e.stack) || e) + "\n");
  process.exit(1);
});
