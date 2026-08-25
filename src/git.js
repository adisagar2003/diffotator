"use strict";
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const Scope = require("./scope");
const crypto = require("crypto");

const US = "\x1f"; // unit separator
const RS = "\x1e"; // record separator

// 32MB — a single `git show` of a large file has to fit. Bigger blobs are
// rejected earlier by MAX_BLOB.
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_BLOB = 4 * 1024 * 1024;
// A diff past this is not review material; rendering it just costs a stall.
const MAX_DIFF_LINES = 200000;

function git(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    /* quotePath: left alone, git octal-escapes every non-ASCII path it prints,
       so `rocket 🚀.md` comes back as `"rocket \360\237\232\200.md"` — wrong on
       screen and, handed back to git, naming nothing. Every path this module
       reads comes through here, so it is off once rather than unquoted at each
       of the seven places that parse one. A path containing `"` or a control
       byte is still quoted; that one needs `-z` at every call site. */
    execFile(
      "git",
      ["--no-pager", "-c", "core.quotePath=false", ...args],
      { cwd, maxBuffer: MAX_BUFFER, encoding: opts.buffer ? "buffer" : "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          err.message = `git ${args.slice(0, 3).join(" ")}: ${String(stderr || err.message).trim()}`;
          return reject(err);
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * For questions where *absence is a legitimate answer* — does `origin/main`
 * exist, is there an upstream, are there any stashes. Never for reading the
 * review itself: a swallowed failure there returns an empty list, which the
 * Stop hook cannot tell apart from a clean tree, so it would silently decide
 * there is nothing to review. Those calls use `git` and are allowed to throw.
 */
async function probe(cwd, args, fallback = "") {
  try {
    return await git(cwd, args);
  } catch {
    return fallback;
  }
}

async function repoRoot(cwd) {
  const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return out.trim();
}

/**
 * A hash of the working tree's state — `git status` plus the patch against
 * HEAD, not a file list, so an edit in place counts as a change.
 *
 * Two callers now: the Stop hook, which uses it to stay quiet when nothing has
 * moved since the last review, and the open review itself, which uses it to
 * notice that the agent kept working underneath it. One definition, because
 * two answers to "has this changed?" that disagree is the bug.
 */
async function treeFingerprint(root) {
  const [status, patch] = await Promise.all([
    probe(root, ["status", "--porcelain"]),
    probe(root, ["diff", "HEAD"]), // no HEAD yet in a repo with no commits
  ]);
  return crypto.createHash("sha1").update(status).update(patch).digest("hex");
}

/** Best guess at the branch this work forked from, for a "branch vs base" review scope. */
async function detectBase(root, head, forced) {
  const candidates = [];
  if (forced) candidates.push(forced); // --base: first in line, same validation as the rest
  const upstream = (
    await probe(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
  ).trim();
  if (upstream) candidates.push(upstream);
  for (const n of ["origin/prerelease", "origin/main", "origin/master", "origin/develop", "main", "master"]) {
    candidates.push(n);
  }
  const headSha = (await probe(root, ["rev-parse", "HEAD"])).trim();
  for (const ref of candidates) {
    // The branch's own remote counterpart is not a review base — it is the
    // same line of work, so its diff is just "what I have not pushed yet".
    if (ref === head || ref.endsWith("/" + head)) continue;
    const ok = await probe(root, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"]);
    if (!ok.trim()) continue;
    const mb = (await probe(root, ["merge-base", ref, "HEAD"])).trim();
    if (!mb || mb === headSha) continue; // nothing on this branch relative to ref
    return { ref, mergeBase: mb };
  }
  return null;
}

async function overview(root, { base } = {}) {
  const [nameRaw, branchRaw, headRaw] = await Promise.all([
    probe(root, ["rev-parse", "--show-toplevel"]),
    probe(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    probe(root, ["rev-parse", "HEAD"]), // absent in a repo with no commits yet
  ]);
  const branch = branchRaw.trim();
  const [worktrees, branches, remoteBranches, tags, stashes, detectedBase] = await Promise.all([
    listWorktrees(root),
    listRefs(root, "refs/heads"),
    listRefs(root, "refs/remotes"),
    listRefs(root, "refs/tags"),
    listStashes(root),
    detectBase(root, branch, base),
  ]);
  return {
    name: path.basename(nameRaw.trim() || root),
    root,
    branch,
    head: headRaw.trim(),
    base: detectedBase,
    worktrees,
    branches,
    remoteBranches,
    tags,
    stashes,
  };
}

async function listWorktrees(root) {
  const out = await probe(root, ["worktree", "list", "--porcelain"]);
  const list = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), name: path.basename(line.slice(9)) };
      list.push(cur);
    } else if (cur && line.startsWith("HEAD ")) {
      /* A detached worktree has no branch, and the caller still has to be able
         to ask git what it is looking at. It used to get the label "(detached)",
         which is not a revision — git resolves it to nothing, and two detached
         worktrees resolved to the same nothing. The sha is the honest answer. */
      cur.head = line.slice(5);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice(7).replace("refs/heads/", "");
    }
  }
  return list;
}

async function listRefs(root, ns) {
  const out = await probe(root, [
    "for-each-ref",
    `--format=%(refname:short)${US}%(objectname:short)${US}%(upstream:track)${US}%(committerdate:unix)`,
    "--sort=-committerdate",
    ns,
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, sha, track, date] = l.split(US);
      const ahead = /ahead (\d+)/.exec(track || "");
      const behind = /behind (\d+)/.exec(track || "");
      return {
        name,
        sha,
        ahead: ahead ? +ahead[1] : 0,
        behind: behind ? +behind[1] : 0,
        date: +date || 0,
      };
    })
    .filter((r) => !r.name.endsWith("/HEAD"));
}

async function listStashes(root) {
  const out = await probe(root, ["stash", "list", `--format=%gd${US}%H${US}%s`]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [ref, sha, subject] = l.split(US);
      return { ref, sha, subject };
    });
}

const LOG_FORMAT = `%H${US}%P${US}%an${US}%ae${US}%at${US}%D${US}%s${US}%b${RS}`;

function parseLog(out) {
  return out
    .split(RS)
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim())
    .map((rec) => {
      const [sha, parents, author, email, at, refs, subject, body] = rec.split(US);
      return {
        sha,
        short: sha.slice(0, 7),
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        author,
        email,
        date: +at * 1000,
        refs: (refs || "")
          .split(", ")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.replace(/^HEAD -> /, "")),
        isHead: /HEAD/.test(refs || ""),
        subject,
        body: (body || "").trim(),
      };
    });
}

/**
 * `rev` and `file` arrive from a query string. `file` is safe because it goes
 * after `--`; a bare `rev` is not — `git log --output=.git/config` truncates
 * the file it names. Validate it here rather than at each caller: this is
 * where a string stops being data and becomes a git argument.
 */
async function log(root, { limit = 200, skip = 0, rev = null, file = null, all = false, firstParent = false } = {}) {
  const args = ["log", `--format=${LOG_FORMAT}`, `--max-count=${limit}`, `--skip=${skip}`];
  if (all) args.push("--all");
  // The branch's own story: merges are one entry, not everything they brought in.
  if (firstParent) args.push("--first-parent");
  if (rev) args.push(Scope.ref(rev, "rev"));
  if (file) args.push("--", file);
  // A repo with no commits legitimately has no log; anything else is a fault.
  return parseLog(await probe(root, args));
}

async function commitMeta(root, sha) {
  const out = await git(root, ["show", "--no-patch", `--format=${LOG_FORMAT}`, Scope.ref(sha, "sha")]);
  const [c] = parseLog(out);
  return c;
}

const STATUS_LABEL = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "typechange" };

/**
 * numstat writes a rename as one compressed path — `src/{old.ts => new.ts}` or
 * bare `old.ts => new.ts` — while name-status writes the two paths in separate
 * columns. Expand to the destination so the two lists key against each other,
 * otherwise every renamed file reports +0/-0.
 */
function numstatPath(p) {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
  if (braced) return (braced[1] + braced[3] + braced[4]).replace(/\/{2,}/g, "/");
  const bare = / => /.exec(p) ? p.split(" => ")[1] : null;
  return bare || p;
}

/** Merge `--name-status` and `--numstat` into one file list. */
function mergeFileLists(nameStatus, numstat) {
  const stats = new Map();
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [add, del, ...rest] = line.split("\t");
    const p = numstatPath(rest.length > 1 ? rest[rest.length - 1] : rest[0]);
    if (!p) continue;
    stats.set(p, {
      additions: add === "-" ? null : +add,
      deletions: del === "-" ? null : +del,
      binary: add === "-",
    });
  }
  const files = [];
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const cols = line.split("\t");
    const code = cols[0];
    const kind = code[0];
    const oldPath = cols[1];
    const newPath = cols[2] || cols[1];
    const s = stats.get(newPath) || stats.get(oldPath) || {};
    files.push({
      path: newPath,
      oldPath: kind === "R" || kind === "C" ? oldPath : null,
      status: STATUS_LABEL[kind] || "modified",
      code: kind,
      additions: s.additions ?? 0,
      deletions: s.deletions ?? 0,
      binary: !!s.binary,
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Scope resolution — see src/scope.js for what a scope is and which kinds exist
// ---------------------------------------------------------------------------

// Hardcoding 4b825dc… only works for sha1 repos; ask git instead. Keyed by root
// because a sha256 repo in the same process has a different empty tree.
const emptyTreeCache = new Map();
async function emptyTree(root) {
  if (!emptyTreeCache.has(root)) {
    emptyTreeCache.set(root, (await git(root, ["hash-object", "-t", "tree", "/dev/null"])).trim());
  }
  return emptyTreeCache.get(root);
}

/** The three facts a scope kind may need from git, injected so scope.js stays browser-loadable. */
function gitPort(root) {
  return {
    emptyTree: () => emptyTree(root),
    headExists: async () => !!(await probe(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim(),
    parents: async (sha) =>
      (await probe(root, ["rev-list", "--parents", "-n", "1", sha])).trim().split(" ").slice(1),
  };
}

const scopeArgs = (root, scope) => Scope.diffArgs(scope, gitPort(root));

async function changedFiles(root, scope) {
  const args = await scopeArgs(root, scope);
  const [ns, num] = await Promise.all([
    git(root, ["diff", "--no-color", "--name-status", "-M", ...args]),
    git(root, ["diff", "--no-color", "--numstat", "-M", ...args]),
  ]);
  const files = mergeFileLists(ns, num);
  if (Scope.isWorktree(scope)) {
    const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard"]))
      .split("\n")
      .filter(Boolean);
    const staged = new Set(
      (await git(root, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean)
    );
    for (const f of files) f.staged = staged.has(f.path);
    for (const p of untracked) {
      let additions = 0;
      try {
        const st = fs.statSync(path.join(root, p));
        // git lists symlinked/ignored dirs as single entries; they are not reviewable files
        if (st.isDirectory()) continue;
        if (st.size < MAX_BLOB) additions = splitLines(fs.readFileSync(path.join(root, p), "utf8")).length;
      } catch {
        continue;
      }
      files.push({ path: p, oldPath: null, status: "untracked", code: "?", additions, deletions: 0, binary: false, staged: false });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

// ---------------------------------------------------------------------------
// Unified diff parsing
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff for ONE file into rows. We ask git for full context
 * (-U<huge>) so the client holds the whole file and can expand collapsed
 * regions with zero extra round-trips — that is what keeps scrolling snappy.
 */
/**
 * Split file text into display lines. Two traps: a file ending in a newline
 * yields a phantom empty last line, and a CRLF file leaves a stray `\r` at the
 * end of every line that renders as a glyph in the diff.
 */
function splitLines(text) {
  const out = text.split("\n");
  if (out.length > 1 && out[out.length - 1] === "") out.pop();
  for (let i = 0; i < out.length; i++) if (out[i].endsWith("\r")) out[i] = out[i].slice(0, -1);
  return out;
}

function parseUnifiedDiff(text) {
  const rows = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let binary = false;
  let mode = null;
  for (const raw of text.split("\n")) {
    if (!inHunk) {
      if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) binary = true;
      // A chmod produces no hunks at all, so a parser that reads only hunks
      // renders the one reviewable fact — 100644 → 100755 — as +0/−0.
      const mm = /^(old|new) mode (\d+)$/.exec(raw);
      if (mm) {
        mode = mode || {};
        mode[mm[1]] = mm[2];
      }
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldNo = +m[1];
        newNo = +m[2];
        inHunk = true;
      }
      continue;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) {
      oldNo = +m[1];
      newNo = +m[2];
      rows.push({ t: "gap" });
      continue;
    }
    const c = raw[0];
    const cr = raw.endsWith("\r");
    const body = raw.slice(1, cr ? -1 : undefined);
    let row;
    if (c === "+") row = { t: "add", n: newNo++, s: body };
    else if (c === "-") row = { t: "del", o: oldNo++, s: body };
    else if (c === " ") row = { t: "ctx", o: oldNo++, n: newNo++, s: body };
    else {
      // "\ No newline at end of file" is git describing the row above it. Drop
      // it and adding a final newline reads as deleting a line and adding the
      // same line back — a real change rendered as no change.
      if (c === "\\" && rows.length) rows[rows.length - 1].nonl = 1;
      continue;
    }
    // The \r has to leave the body — it renders as a stray glyph — but the row
    // has to remember it, or a CRLF→LF conversion is three red lines beside
    // three green ones of byte-identical text.
    if (cr) row.cr = 1;
    rows.push(row);
  }
  /* A file that is CRLF from top to bottom has not *changed* its line endings,
     and a marker on every row is wallpaper rather than information — one edit to
     a Windows file would badge all of it, both sides. Only asymmetry is worth
     showing: a CRLF row beside an LF one. Judged over the whole file, which is
     what `fileDiff` asks git for. */
  const eol = rows.filter((r) => r.t !== "gap");
  if (eol.length && eol.every((r) => r.cr)) for (const r of eol) delete r.cr;

  const out = { rows, binary };
  if (mode && mode.old && mode.new && mode.old !== mode.new) out.mode = mode;
  return out;
}

async function fileDiff(root, scope, file, context = 1000000) {
  const sargs = await scopeArgs(root, scope);
  // `--numstat` reports binaries as `-  -` and costs one cheap call, which is
  // far better than streaming a megabyte of unified diff to discover the same.
  const stat = (await git(root, ["diff", "--no-color", "--numstat", "-M", ...sargs, "--", file]))
    .split("\t");
  if (stat[0] === "-" && stat[1] === "-") return { rows: [], binary: true };
  const changed = (+stat[0] || 0) + (+stat[1] || 0);
  if (changed > MAX_DIFF_LINES) return { rows: [], tooBig: true, changed };

  const args = ["diff", "--no-color", "--no-ext-diff", `-U${context}`, "-M", ...sargs, "--", file];
  let text = "";
  try {
    text = await git(root, args);
  } catch (e) {
    return { rows: [], binary: false, error: e.message };
  }
  if (!text.trim() && Scope.isWorktree(scope)) {
    // untracked file: synthesise an all-add diff
    const abs = path.join(root, file);
    if (fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      if (st.size > MAX_BLOB) return { rows: [], tooBig: true };
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) return { rows: [], binary: true };
      const content = buf.toString("utf8");
      if (!content.length) return { rows: [], empty: true };
      return { rows: splitLines(content).map((s, i) => ({ t: "add", n: i + 1, s })), binary: false };
    }
  }
  const parsed = parseUnifiedDiff(text);
  if (!parsed.rows.length && !parsed.binary) parsed.empty = true;
  return parsed;
}

/** Whole-file content at a scope's "after" side — for reviewing untouched files. */
async function fileContent(root, scope, file) {
  let text = null;
  if (Scope.isWorktree(scope)) {
    const abs = path.join(root, file);
    if (fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      if (st.size > MAX_BLOB) return { tooBig: true };
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) return { binary: true };
      text = buf.toString("utf8");
    }
  }
  if (text === null) {
    try {
      text = await git(root, ["show", `${Scope.rev(scope)}:${file}`]);
    } catch (e) {
      return { error: e.message };
    }
  }
  if (!text.length) return { rows: [], empty: true };
  return { rows: splitLines(text).map((s, i) => ({ t: "ctx", o: i + 1, n: i + 1, s })) };
}

/** Full repository file tree at a revision (Fork's "File Tree" tab). */
async function tree(root, scope) {
  if (!Scope.isWorktree(scope)) {
    const out = await git(root, ["ls-tree", "-r", "--name-only", Scope.rev(scope)]);
    return out.split("\n").filter(Boolean);
  }
  /* What is on disk right now, which is not the same as any tree: a file that
     is staged but never committed is in no tree yet, and `ls-tree HEAD` missed
     it — as it missed everything in a repo with no commits at all. Both are
     what an agent leaves behind, so ask the index instead. */
  const [cached, others] = await Promise.all([
    git(root, ["ls-files", "--cached"]),
    git(root, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const paths = cached.split("\n").filter(Boolean);
  // git lists ignored/symlinked directories as single "other" entries; those
  // are not reviewable files. Tracked entries are always files, so this only
  // costs a stat per untracked path.
  for (const p of others.split("\n").filter(Boolean)) {
    try {
      if (!fs.statSync(path.join(root, p)).isDirectory()) paths.push(p);
    } catch {
      /* vanished between listing and stat */
    }
  }
  return paths.sort();
}

module.exports = {
  git,
  probe,
  repoRoot,
  overview,
  log,
  commitMeta,
  changedFiles,
  fileDiff,
  fileContent,
  tree,
  detectBase,
  treeFingerprint,
};
