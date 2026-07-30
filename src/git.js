"use strict";
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

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
    execFile(
      "git",
      ["--no-pager", ...args],
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

async function tryGit(cwd, args, fallback = "") {
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

/** Best guess at the branch this work forked from, for a "branch vs base" review scope. */
async function detectBase(root, head) {
  const candidates = [];
  const upstream = (
    await tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
  ).trim();
  if (upstream) candidates.push(upstream);
  for (const n of ["origin/prerelease", "origin/main", "origin/master", "origin/develop", "main", "master"]) {
    candidates.push(n);
  }
  const headSha = (await tryGit(root, ["rev-parse", "HEAD"])).trim();
  for (const ref of candidates) {
    // The branch's own remote counterpart is not a review base — it is the
    // same line of work, so its diff is just "what I have not pushed yet".
    if (ref === head || ref.endsWith("/" + head)) continue;
    const ok = await tryGit(root, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"]);
    if (!ok.trim()) continue;
    const mb = (await tryGit(root, ["merge-base", ref, "HEAD"])).trim();
    if (!mb || mb === headSha) continue; // nothing on this branch relative to ref
    return { ref, mergeBase: mb };
  }
  return null;
}

async function overview(root) {
  const [nameRaw, branchRaw, headRaw] = await Promise.all([
    tryGit(root, ["rev-parse", "--show-toplevel"]),
    tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    tryGit(root, ["rev-parse", "HEAD"]),
  ]);
  const branch = branchRaw.trim();
  const [worktrees, branches, remoteBranches, tags, stashes, base] = await Promise.all([
    listWorktrees(root),
    listRefs(root, "refs/heads"),
    listRefs(root, "refs/remotes"),
    listRefs(root, "refs/tags"),
    listStashes(root),
    detectBase(root, branch),
  ]);
  return {
    name: path.basename(nameRaw.trim() || root),
    root,
    branch,
    head: headRaw.trim(),
    base,
    worktrees,
    branches,
    remoteBranches,
    tags,
    stashes,
  };
}

async function listWorktrees(root) {
  const out = await tryGit(root, ["worktree", "list", "--porcelain"]);
  const list = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), name: path.basename(line.slice(9)) };
      list.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice(7).replace("refs/heads/", "");
    } else if (cur && line === "detached") {
      cur.branch = "(detached)";
    }
  }
  return list;
}

async function listRefs(root, ns) {
  const out = await tryGit(root, [
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
  const out = await tryGit(root, ["stash", "list", `--format=%gd${US}%H${US}%s`]);
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

async function log(root, { limit = 200, skip = 0, rev = null, file = null, all = false } = {}) {
  const args = ["log", `--format=${LOG_FORMAT}`, `--max-count=${limit}`, `--skip=${skip}`];
  if (all) args.push("--all");
  if (rev) args.push(rev);
  if (file) args.push("--", file);
  return parseLog(await tryGit(root, args));
}

async function commitMeta(root, sha) {
  const out = await git(root, ["show", "--no-patch", `--format=${LOG_FORMAT}`, sha]);
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

/**
 * A scope is what we are diffing. Everything downstream (file list, diff, full
 * file content) is expressed in terms of one:
 *   {type:'worktree'}                — working tree + index vs HEAD (+ untracked)
 *   {type:'commit', sha}             — a single commit vs its first parent
 *   {type:'range', base, head}       — base...head, e.g. branch vs origin/main
 *
 * Commits resolve to an explicit two-dot pair rather than the tempting `sha^!`.
 * `sha^!` excludes *every* parent, so a merge commit diffs to nothing at all,
 * and a root commit has no `^` to exclude and silently diffs the wrong way
 * round. Naming both endpoints avoids both traps.
 */
let emptyTreeCache = null;
async function emptyTree(root) {
  // Hardcoding 4b825dc… only works for sha1 repos; ask git instead.
  if (!emptyTreeCache) emptyTreeCache = (await git(root, ["hash-object", "-t", "tree", "/dev/null"])).trim();
  return emptyTreeCache;
}

async function scopeArgs(root, scope) {
  if (scope.type === "commit") {
    const parents = (await tryGit(root, ["rev-list", "--parents", "-n", "1", scope.sha]))
      .trim()
      .split(" ")
      .slice(1);
    // First parent only: for a merge that means "what this merge brought in",
    // which is what a reviewer is looking at.
    const from = parents[0] || (await emptyTree(root));
    return [from, scope.sha];
  }
  if (scope.type === "range") return [`${scope.base}...${scope.head}`];
  return ["HEAD"]; // worktree
}

async function changedFiles(root, scope) {
  const args = await scopeArgs(root, scope);
  const [ns, num] = await Promise.all([
    tryGit(root, ["diff", "--no-color", "--name-status", "-M", ...args]),
    tryGit(root, ["diff", "--no-color", "--numstat", "-M", ...args]),
  ]);
  const files = mergeFileLists(ns, num);
  if (scope.type === "worktree") {
    const untracked = (
      await tryGit(root, ["ls-files", "--others", "--exclude-standard"])
    )
      .split("\n")
      .filter(Boolean);
    const staged = new Set(
      (await tryGit(root, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean)
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
  for (const raw of text.split("\n")) {
    if (!inHunk) {
      if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) binary = true;
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
    const body = raw.slice(1).replace(/\r$/, "");
    if (c === "+") rows.push({ t: "add", n: newNo++, s: body });
    else if (c === "-") rows.push({ t: "del", o: oldNo++, s: body });
    else if (c === " ") rows.push({ t: "ctx", o: oldNo++, n: newNo++, s: body });
    else if (c === "\\") continue; // "\ No newline at end of file"
    else if (raw === "") continue;
  }
  return { rows, binary };
}

async function fileDiff(root, scope, file, context = 1000000) {
  const sargs = await scopeArgs(root, scope);
  // `--numstat` reports binaries as `-  -` and costs one cheap call, which is
  // far better than streaming a megabyte of unified diff to discover the same.
  const stat = (await tryGit(root, ["diff", "--no-color", "--numstat", "-M", ...sargs, "--", file]))
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
  if (!text.trim() && scope.type === "worktree") {
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
  if (scope.type === "worktree") {
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
    const rev = scope.type === "commit" ? scope.sha : scope.type === "range" ? scope.head : "HEAD";
    try {
      text = await git(root, ["show", `${rev}:${file}`]);
    } catch (e) {
      return { error: e.message };
    }
  }
  if (!text.length) return { rows: [], empty: true };
  return { rows: splitLines(text).map((s, i) => ({ t: "ctx", o: i + 1, n: i + 1, s })) };
}

/** Full repository file tree at a revision (Fork's "File Tree" tab). */
async function tree(root, scope) {
  const rev = scope.type === "commit" ? scope.sha : scope.type === "range" ? scope.head : "HEAD";
  const out = await tryGit(root, ["ls-tree", "-r", "--name-only", rev]);
  const paths = out.split("\n").filter(Boolean);
  if (scope.type === "worktree") {
    // Brand-new files are not in any tree yet, but they are the ones most
    // worth browsing right after an agent run.
    const extra = (await tryGit(root, ["ls-files", "--others", "--exclude-standard"]))
      .split("\n")
      .filter(Boolean)
      .filter((p) => {
        try {
          return !fs.statSync(path.join(root, p)).isDirectory();
        } catch {
          return false;
        }
      });
    paths.push(...extra);
    paths.sort();
  }
  return paths;
}

module.exports = {
  git,
  tryGit,
  repoRoot,
  overview,
  log,
  commitMeta,
  changedFiles,
  fileDiff,
  fileContent,
  tree,
  detectBase,
};
