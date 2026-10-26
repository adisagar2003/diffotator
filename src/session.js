"use strict";
/**
 * A review that outlives the command that opened it. The review page keeps
 * running in its own background process, so the agent can be told about a
 * question, answer it, and keep listening — without the page closing in
 * between. The CLI (`diffotator`, `diffotator answer`, `diffotator wait`) and
 * the Stop hook all reach a running review through this file; one session file
 * per repository records where it is and the secret the agent must present.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { dataDir } = require("./drafts");

const BIN = path.join(__dirname, "..", "bin", "diffotator.js");
const keyFor = (root) => crypto.createHash("sha1").update(root).digest("hex").slice(0, 16);
const fileFor = (root) => path.join(dataDir(), "sessions", keyFor(root) + ".json");

function read(root) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(root), "utf8"));
  } catch {
    return null;
  }
}

/** Written by the review process once it is listening. Only this user can read the secret. */
function write(root, info) {
  const file = fileFor(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
}

function remove(root, pid = process.pid) {
  const s = read(root);
  if (s && s.pid === pid) fs.rmSync(fileFor(root), { force: true });
}

const newToken = () => crypto.randomBytes(24).toString("hex");
/** What a review was opened for; a run that asks for something else gets its own. */
const wantOf = (opts) => JSON.stringify([opts.base || null, opts.title || null, opts.walkthrough || null]);
const urlOf = (s) => `http://127.0.0.1:${s.port}`;
const agentHeaders = (s) => ({ "x-diffotator-token": s.token, "content-type": "application/json" });

/** The running review for `root`, or null when there is none (a stale file is cleaned up). */
async function alive(root) {
  const s = read(root);
  if (!s) return null;
  try {
    const r = await fetch(urlOf(s) + "/api/agent/ping", { headers: agentHeaders(s) });
    if (r.ok) return { ...s, finished: !!(await r.json()).finished };
  } catch {}
  fs.rmSync(fileFor(root), { force: true });
  return null;
}

/**
 * Start the review process for `root` (or rejoin the one already open) and
 * resolve with its session. `opts` are the review's flags, passed through.
 * An open review is rejoined when nothing different was asked for; one that
 * was already sent, or opened on another walkthrough or base, is replaced —
 * otherwise a new review would show the old one, or hand back its feedback.
 */
async function ensure(root, opts = {}) {
  const running = await alive(root);
  const asksNothing = wantOf(opts) === wantOf({});
  if (running && !running.finished && (asksNothing || running.want === wantOf(opts))) return { ...running, reused: true };
  if (running) {
    try {
      process.kill(running.pid, "SIGTERM");
    } catch {}
    fs.rmSync(fileFor(root), { force: true });
  }
  const args = [BIN, "__serve", "-C", root];
  if (opts.base) args.push("--base", opts.base);
  if (opts.title) args.push("--title", opts.title);
  if (opts.walkthrough) args.push("--walkthrough", opts.walkthrough);
  if (opts.port) args.push("--port", String(opts.port));
  spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const s = read(root);
    if (s && (!running || s.pid !== running.pid)) return { ...s, reused: false };
  }
  throw new Error("the review did not start within 10 seconds");
}

/**
 * Wait for the next thing the agent should hear: a question or the finished
 * review. Renews the long-poll until one arrives; a review that has gone away
 * reads as closed.
 */
async function waitNext(s) {
  for (;;) {
    let ev;
    try {
      const r = await fetch(urlOf(s) + "/api/agent/next", { headers: agentHeaders(s) });
      ev = await r.json();
    } catch {
      return { type: "done", decision: "dismissed", output: "Review session closed without feedback." };
    }
    if (ev.type !== "none") return ev;
  }
}

/** Send the agent's answer to the page. */
async function answer(s, id, text) {
  const r = await fetch(urlOf(s) + "/api/agent/answer", { method: "POST", headers: agentHeaders(s), body: JSON.stringify({ id, text }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `answer failed (${r.status})`);
  return body;
}

module.exports = { read, write, remove, newToken, wantOf, alive, ensure, waitNext, answer, urlOf };
