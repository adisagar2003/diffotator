"use strict";
/**
 * Stop-hook mode: let the harness call us instead of waiting to be remembered.
 *
 * A review tool you have to invoke by hand reviews only what you remember to
 * review. Hooking `Stop` means every turn that leaves real changes gets looked
 * at. The whole difficulty is *not* firing:
 *
 *   - nothing uncommitted           → allow, silently
 *   - fewer than N changed files    → allow, silently (a one-line turn is noise)
 *   - tree unchanged since the last review → allow, silently
 *   - the harness says we already blocked once → allow, so we cannot loop
 *
 * Only what survives all four opens a browser.
 */
const crypto = require("crypto");
const G = require("./git");
const D = require("./drafts");

const OFF = /^(0|off|false|no)$/i;

function config() {
  return {
    enabled: !OFF.test(process.env.DIFFOTATOR_HOOK || ""),
    minFiles: Math.max(1, +(process.env.DIFFOTATOR_HOOK_MIN_FILES || 3)),
  };
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => resolve(raw));
    // A harness that opens the pipe but never writes must not hang the turn.
    setTimeout(() => resolve(raw), 2000).unref();
  });
}

/**
 * Identity of the current working tree. Must be content-sensitive: a file list
 * alone would call an edited-in-place file "already reviewed".
 */
async function fingerprint(root) {
  const [status, patch] = await Promise.all([
    G.tryGit(root, ["status", "--porcelain"]),
    G.tryGit(root, ["diff", "HEAD"]),
  ]);
  return crypto.createHash("sha1").update(status).update(patch).digest("hex");
}

const allow = () => ({ verdict: "allow" });

/**
 * Decide whether this Stop should open a review.
 * Split out from `run` so the gate is testable without a browser or a harness.
 */
async function decide(input, opts = {}) {
  const cfg = { ...config(), ...opts };
  if (!cfg.enabled) return { ...allow(), why: "disabled" };
  // Claude Code sets this when a Stop hook already forced a continuation.
  if (input.stop_hook_active) return { ...allow(), why: "already-continued" };

  const cwd = input.cwd || process.cwd();
  let root;
  try {
    root = await G.repoRoot(cwd);
  } catch {
    return { ...allow(), why: "not-a-repo" };
  }

  const files = await G.changedFiles(root, { type: "worktree" });
  if (!files.length) return { ...allow(), why: "clean-tree", root };
  if (files.length < cfg.minFiles)
    return { ...allow(), why: `below-threshold(${files.length}<${cfg.minFiles})`, root };

  const fp = await fingerprint(root);
  const state = D.loadHookState(root);
  if (state.reviewed === fp) return { ...allow(), why: "unchanged-since-review", root };

  return { verdict: "review", root, fingerprint: fp, files: files.length };
}

/** Stop-hook JSON. Omitting `decision` lets the turn end; `block` sends it back to work. */
function stopOutput(feedback) {
  return feedback ? { decision: "block", reason: feedback } : {};
}

async function run({ openReview }) {
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    input = {};
  }

  const d = await decide(input);
  if (d.verdict === "allow") {
    if (process.env.DIFFOTATOR_DEBUG) process.stderr.write(`diffotator hook: allow (${d.why})\n`);
    return stopOutput(null);
  }

  const { decision, output } = await openReview(d.root);

  // Record what was on screen either way: approving and then dismissing the
  // next identical Stop should both stay quiet.
  D.saveHookState(d.root, { reviewed: d.fingerprint, decision });

  return stopOutput(decision === "annotated" && output ? output : null);
}

module.exports = { run, decide, fingerprint, config, stopOutput };
