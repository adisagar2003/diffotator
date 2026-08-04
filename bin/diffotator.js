#!/usr/bin/env node
"use strict";
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const G = require("../src/git");
const { createServer } = require("../src/server");
const hook = require("../src/hook");

const HELP = `
diffotator — Fork-style git review in the browser, annotations back to your agent.

Usage:
  diffotator [review] [options]      Open a review now
  diffotator hook                    Stop-hook mode (reads hook JSON on stdin)
  diffotator hook --install          Add the Stop hook to ~/.claude/settings.json
  diffotator hook --uninstall        Remove it again

Options:
  -C, --cwd <dir>     Repository to review (default: cwd)
  -b, --base <ref>    Base ref for the branch-vs-base scope (default: auto-detected)
  -p, --port <n>      Port to listen on (default: random free port)
      --no-open       Do not launch a browser
      --title <s>     Header title for the session
  -h, --help

Stop hook:
  Reviews fire automatically when a turn leaves changes worth looking at.
  DIFFOTATOR_HOOK=off            Disable without uninstalling
  DIFFOTATOR_HOOK_MIN_FILES=3    Fewest changed files that will open a review

Output (stdout, for agent consumption):
  annotations markdown  — the user left comments
  "The user approved."  — approved with no changes requested
  ""                    — session closed without feedback
`;

function parseArgs(argv) {
  const o = { cwd: process.cwd(), open: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "review" || a === "diff") continue;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a === "-C" || a === "--cwd") o.cwd = argv[++i];
    else if (a === "-b" || a === "--base") o.base = argv[++i];
    else if (a === "-p" || a === "--port") o.port = +argv[++i];
    else if (a === "--title") o.title = argv[++i];
    else if (a === "--no-open") o.open = false;
    else rest.push(a);
  }
  if (rest[0] && !o.base) o.base = rest[0];
  return o;
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], () => {});
}

// The browser needs a moment to paint its confirmation screen before the port
// disappears from under it.
const PAINT_MS = 400;

/**
 * Run one review session to completion. Owns the port, the browser, the signals
 * and the teardown — the HTTP module only reports that a decision arrived.
 * @returns {Promise<{decision: string, output: string}>}
 */
function serveReview(root, { open = true, port = 0, title, base } = {}) {
  const server = createServer({ root, title, base });
  return new Promise((resolve) => {
    const finish = (result) => {
      setTimeout(() => server.close(() => resolve(result)), PAINT_MS);
      // A socket that refuses to close must not hang the turn. A second resolve
      // is a no-op, so this needs no guard flag.
      setTimeout(() => resolve(result), PAINT_MS + 500).unref();
    };
    server.submitted.then(finish);
    server.listen(port, "127.0.0.1", () => {
      const url = `http://localhost:${server.address().port}`;
      process.stderr.write(`\n  diffotator  ${path.basename(root)}\n  ${url}\n\n`);
      if (open) openBrowser(url);
    });
    const bail = () =>
      finish({ decision: "dismissed", output: "Review session closed without feedback." });
    process.on("SIGINT", bail);
    process.on("SIGTERM", bail);
  });
}

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
// Claude Code defaults hooks to 600s. A review is human-paced, so give it a day.
const HOOK_TIMEOUT = 86400;

function hookEntry() {
  return { hooks: [{ type: "command", command: "diffotator hook", timeout: HOOK_TIMEOUT }] };
}

function installHook(remove) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  } catch {}
  cfg.hooks = cfg.hooks || {};
  const list = (cfg.hooks.Stop || []).filter(
    (e) => !(e.hooks || []).some((h) => String(h.command || "").startsWith("diffotator hook"))
  );
  if (!remove) list.push(hookEntry());
  if (list.length) cfg.hooks.Stop = list;
  else delete cfg.hooks.Stop;
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;

  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + ".diffotator-backup");
  fs.writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2) + "\n");
  process.stderr.write(
    `${remove ? "Removed" : "Installed"} the diffotator Stop hook in ${SETTINGS}\n` +
      (remove ? "" : `Reviews open when a turn leaves ${hook.config().minFiles}+ changed files.\n`)
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "hook") {
    if (argv.includes("--install")) return installHook(false);
    if (argv.includes("--uninstall")) return installHook(true);
    // Hook mode: stdout carries JSON for the harness and nothing else.
    const result = await hook.run({
      openReview: (root) => serveReview(root, { open: true }),
    });
    process.stdout.write(JSON.stringify(result));
    return;
  }

  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  let root;
  try {
    root = await G.repoRoot(opts.cwd);
  } catch {
    process.stderr.write(`diffotator: ${opts.cwd} is not a git repository\n`);
    process.exit(1);
  }

  const { output } = await serveReview(root, {
    open: opts.open,
    port: opts.port || 0,
    title: opts.title,
    base: opts.base,
  });
  if (output) process.stdout.write(output.endsWith("\n") ? output : output + "\n");
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`diffotator: ${(e && e.stack) || e}\n`);
  process.exit(1);
});
