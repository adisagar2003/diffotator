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
const DEFAULT_MIN_FILES = 3;

/**
 * `Math.max` propagates NaN rather than ignoring it, so a typo in a shell
 * profile used to leave `minFiles` NaN — and `files.length < NaN` is false for
 * every count, which deletes the threshold instead of clamping it. A value we
 * cannot read falls back to the default *and says so*: an ignored setting is
 * not one of the "nothing worth looking at" reasons this module stays quiet
 * about, and the symptom otherwise is a review on every single turn with
 * nothing on screen explaining why.
 */
function readMinFiles(raw) {
  if (!raw) return { minFiles: DEFAULT_MIN_FILES };
  const n = +raw;
  // Reported rather than announced: `config()` is a getter, and a getter that
  // writes to stderr says the same thing again every time anyone asks — including
  // `hook --install`, which has no business mentioning the threshold. `decide`
  // owns the telling, because that is where the value is actually used.
  if (!Number.isFinite(n)) return { minFiles: DEFAULT_MIN_FILES, badMinFiles: raw };
  return { minFiles: Math.max(1, n) };
}

function config() {
  return {
    enabled: !OFF.test(process.env.DIFFOTATOR_HOOK || ""),
    ...readMinFiles(process.env.DIFFOTATOR_HOOK_MIN_FILES),
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
    G.probe(root, ["status", "--porcelain"]),
    G.probe(root, ["diff", "HEAD"]), // no HEAD yet in a repo with no commits
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
  // A threshold we could not read is not one of the silent reasons below: the
  // setting is being ignored, and the symptom — a review every single turn — has
  // nothing on screen explaining itself.
  if (cfg.badMinFiles !== undefined && opts.minFiles === undefined) {
    process.stderr.write(
      `diffotator hook: DIFFOTATOR_HOOK_MIN_FILES=${cfg.badMinFiles} is not a number — using ${cfg.minFiles}\n`
    );
  }
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

  // A git failure must not read as "nothing to review" — that is the one way
  // this gate can be wrong and stay silent about it. We still allow the turn to
  // end (a review tool that cannot read the repo has no business holding the
  // agent hostage over its own failure), but `failed` makes `run` say so out
  // loud instead of filing it under the silent reasons above.
  let files;
  try {
    files = await G.changedFiles(root, { type: "worktree" });
  } catch (e) {
    return { ...allow(), failed: true, why: `git-error(${(e && e.message) || e})`, root };
  }
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
    // The ordinary reasons are all "nothing worth looking at", and saying so
    // every turn is noise. A failure is not one of them: unreviewed changes may
    // be sitting there, so it is reported whether or not anyone asked for debug.
    if (d.failed) process.stderr.write(`diffotator hook: could not inspect the repository — ${d.why}\n`);
    else if (process.env.DIFFOTATOR_DEBUG) process.stderr.write(`diffotator hook: allow (${d.why})\n`);
    return stopOutput(null);
  }

  const { decision, output } = await openReview(d.root);

  // Record what was on screen either way: approving and then dismissing the
  // next identical Stop should both stay quiet.
  D.saveHookState(d.root, { reviewed: d.fingerprint, decision });

  return stopOutput(decision === "annotated" && output ? output : null);
}

module.exports = { run, decide, fingerprint, config, stopOutput };
