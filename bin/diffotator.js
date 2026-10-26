#!/usr/bin/env node
"use strict";
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const G = require("../src/git");
const { createServer } = require("../src/server");
const hook = require("../src/hook");
const { browserCommand, setupAgent } = require("../src/platform");
const Session = require("../src/session");
const { formatEvent } = require("../src/talk");

const HELP = `
diffotator — Fork-style git review in the browser, annotations back to your agent.

Usage:
  diffotator [review] [options]      Open a review now
  diffotator setup                   Teach your agent the /diffotator command
                                     (run it again after every upgrade)
  diffotator answer [--id <n>] <text>
                                     Answer the reviewer's question (- reads stdin),
                                     then wait for their next message
  diffotator wait                    Wait for the reviewer's next message
  diffotator hook                    Stop-hook mode (reads hook JSON on stdin)
  diffotator hook --install          Add the Stop hook to ~/.claude/settings.json
  diffotator hook --uninstall        Remove it again

Options:
  -C, --cwd <dir>     Repository to review (default: cwd)
  -b, --base <ref>    Base ref for the branch-vs-base scope (default: auto-detected)
  -p, --port <n>      Port to listen on (default: random free port)
      --no-open       Do not launch a browser
      --title <s>     Header title for the session
      --walkthrough <path>
                      Walkthrough JSON written by the agent (see /diffotator).
                      Opens on the branch-vs-base range.
  -h, --help

Stop hook:
  Reviews fire automatically when a turn leaves changes worth looking at.
  DIFFOTATOR_HOOK=off            Disable without uninstalling
  DIFFOTATOR_HOOK_MIN_FILES=3    Fewest changed files that will open a review

Output (stdout, for agent consumption):
  "# Question from the reviewer"  — they asked something; the review stays open
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
    else if (a === "--walkthrough") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) {
        process.stderr.write("diffotator: --walkthrough needs a file path\n");
        process.exit(1);
      }
      o.walkthrough = path.resolve(v);
    }
    else if (a === "--no-open") o.open = false;
    else if (a === "--id") o.id = parseInt(argv[++i], 10) || null;
    // The first word that isn't a flag can be a command, wherever -C and friends went.
    else if (!o.cmd && !rest.length && (a === "answer" || a === "wait" || a === "__serve")) o.cmd = a;
    else rest.push(a);
  }
  o.rest = rest;
  if (!o.cmd && rest[0] && !o.base) o.base = rest[0];
  return o;
}

function openBrowser(url) {
  const [cmd, args] = browserCommand(process.platform, url);
  execFile(cmd, args, () => {});
}

function setup() {
  const { installed, source } = setupAgent();
  const say = (s = "") => process.stdout.write(s + "\n");
  say(installed ? `Claude Code: installed the /diffotator command (${installed})` : "Claude Code: not found (no ~/.claude folder), skipped.");
  say("Another agent? Add this file to its instructions:");
  say(`  ${source}`);
  say();
  say("Then ask your agent: use diffotator to review <pull request link>");
}

/** What the agent reads on stdout: the reviewer's question, or the finished review. */
function printEvent(ev) {
  const out = formatEvent(ev);
  if (out) process.stdout.write(out.endsWith("\n") ? out : out + "\n");
}

/* Ctrl-C stops listening, not the review: the page stays open in the browser. */
function keepPageOnInterrupt() {
  process.on("SIGINT", () => {
    process.stderr.write("\nStopped listening. The review is still open in your browser; `diffotator wait` listens again.\n");
    process.exit(130);
  });
}

/** Open (or rejoin) the review for `root` and wait for the first thing the agent should hear. */
async function review(root, opts) {
  const s = await Session.ensure(root, opts);
  if (s.finished) {
    process.stderr.write("diffotator: handing over a review that was sent earlier. Run diffotator again to start a new one.\n");
    return printEvent(await Session.waitNext(s));
  }
  const url = Session.pageUrl(s);
  process.stderr.write(`\n  diffotator  ${path.basename(root)}\n  ${url}${s.reused ? "  (already open)" : ""}\n\n`);
  if (opts.open) openBrowser(url); // rejoined too: its tab may be long closed
  keepPageOnInterrupt();
  printEvent(await Session.waitNext(s));
}

/** `diffotator answer` / `diffotator wait`: talk to the review that is open for this repo. */
async function converse(root, { id, text, waitOnly }) {
  const s = await Session.alive(root);
  if (!s) {
    process.stderr.write(`diffotator: no review is open for ${root}\n`);
    process.exit(1);
  }
  if (!waitOnly) {
    if (!text) {
      process.stderr.write('diffotator: say something — diffotator answer --id <n> "<your answer>" (or - to read stdin)\n');
      process.exit(1);
    }
    await Session.answer(s, id, text);
  }
  keepPageOnInterrupt();
  printEvent(await Session.waitNext(s));
}

/**
 * The review itself, in its own background process (started by Session.ensure).
 * It stays up while the reviewer and the agent talk, and leaves once the agent
 * has been handed the finished review, when replaced, or after 12 hours with
 * no requests at all.
 */
function serve(root, opts) {
  const token = Session.newToken();
  const pageKey = Session.newToken();
  let leaving = false;
  const leave = () => {
    if (leaving) return;
    leaving = true;
    Session.remove(root);
    setTimeout(() => process.exit(0), 800).unref(); // let the page paint its "sent" screen
  };
  const server = createServer({ root, title: opts.title, base: opts.base, walkthrough: opts.walkthrough, token, pageKey, onAgentDone: leave });
  let idle;
  const awake = () => {
    clearTimeout(idle);
    idle = setTimeout(leave, 12 * 60 * 60 * 1000).unref();
  };
  server.on("request", awake);
  awake();
  process.on("SIGTERM", leave);
  server.on("error", (e) => {
    Session.fail(root, e.message);
    process.exit(1);
  });
  server.listen(opts.port || 0, "127.0.0.1", async () => {
    const info = { port: server.address().port, pid: process.pid, token, pageKey, root, want: Session.wantOf(opts), startedAt: Date.now() };
    if (!(await Session.claim(root, info))) process.exit(0); // another review for this repo won the race
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
  if (argv[0] === "setup") return setup();
  if (argv[0] === "hook") {
    if (argv.includes("--install")) return installHook(false);
    if (argv.includes("--uninstall")) return installHook(true);
    // Hook mode: stdout carries JSON for the harness and nothing else.
    const result = await hook.run({
      openReview: async (root) => {
        const s = await Session.ensure(root, {});
        if (!s.reused) openBrowser(Session.pageUrl(s));
        return Session.waitNext(s);
      },
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

  if (opts.cmd === "__serve") return serve(root, opts);
  if (opts.cmd === "answer" || opts.cmd === "wait") {
    let text = opts.rest.join(" ").trim();
    if (text === "-") text = await new Promise((r) => {
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => r(raw.trim()));
    });
    await converse(root, { id: opts.id, text, waitOnly: opts.cmd === "wait" });
  } else await review(root, opts);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`diffotator: ${(e && e.stack) || e}\n`);
  process.exit(1);
});
