#!/usr/bin/env node
"use strict";
const { execFile } = require("child_process");
const path = require("path");
const G = require("../src/git");
const { createServer } = require("../src/server");

const HELP = `
diffotator — Fork-style git review in the browser, annotations back to your agent.

Usage:
  diffotator [review] [options]

Options:
  -C, --cwd <dir>     Repository to review (default: cwd)
  -b, --base <ref>    Base ref for the branch-vs-base scope (default: auto-detected)
  -p, --port <n>      Port to listen on (default: random free port)
      --no-open       Do not launch a browser
      --title <s>     Header title for the session
  -h, --help

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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
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

  let done = false;
  const finish = (out, decision) => {
    if (done) return;
    done = true;
    if (out) process.stdout.write(out.endsWith("\n") ? out : out + "\n");
    server.close(() => process.exit(0));
    // Sockets from the browser can keep the server alive; do not wait forever.
    setTimeout(() => process.exit(0), 300).unref();
  };

  const server = createServer({ root, finish, title: opts.title });
  server.listen(opts.port || 0, "127.0.0.1", () => {
    const url = `http://localhost:${server.address().port}`;
    process.stderr.write(`\n  diffotator  ${path.basename(root)}\n  ${url}\n\n`);
    if (opts.open) openBrowser(url);
  });

  const bail = () => finish("Review session closed without feedback.", "dismissed");
  process.on("SIGINT", bail);
  process.on("SIGTERM", bail);
}

main().catch((e) => {
  process.stderr.write(`diffotator: ${(e && e.stack) || e}\n`);
  process.exit(1);
});
