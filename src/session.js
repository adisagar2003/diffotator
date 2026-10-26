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
const errFor = (root) => path.join(dataDir(), "sessions", keyFor(root) + ".err");

function read(root) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(root), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Written by the review process once it is listening. Only this user can read
 * the secrets. Claimed, not overwritten: two reviews started at once for one
 * repo would otherwise leave the file naming one while an agent talks to the
 * other. Written whole, then linked into place, so nobody reads half a file.
 * Resolves false when another live review already owns the repo.
 */
async function claim(root, info) {
  const file = fileFor(root);
  const tmp = `${file}.${info.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  try {
    for (let tries = 0; tries < 2; tries++) {
      try {
        fs.linkSync(tmp, file);
        return true;
      } catch (e) {
        if (e.code !== "EEXIST" || (await alive(root))) return false; // alive() clears a dead owner's file
      }
    }
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Why the review process could not start, for the command that started it. */
const fail = (root, message) => {
  fs.mkdirSync(path.dirname(errFor(root)), { recursive: true });
  fs.writeFileSync(errFor(root), message);
};

function remove(root, pid = process.pid) {
  const s = read(root);
  if (s && s.pid === pid) fs.rmSync(fileFor(root), { force: true });
}

const newToken = () => crypto.randomBytes(24).toString("hex");
/** The link that opens the page: it carries the key the page's requests need. */
const pageUrl = (s) => `http://localhost:${s.port}/?k=${s.pageKey}`;
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
 * - A review that was sent but never collected is rejoined whatever was asked:
 *   its feedback is the reviewer's work and goes to the agent first.
 * - An open review is rejoined when nothing different was asked for, and
 *   replaced when it was opened on another walkthrough, base or title.
 */
async function ensure(root, opts = {}) {
  const running = await alive(root);
  const asksNothing = wantOf(opts) === wantOf({});
  if (running && (running.finished || asksNothing || running.want === wantOf(opts))) return { ...running, reused: true };
  if (running) {
    try {
      process.kill(running.pid, "SIGTERM");
    } catch {}
    fs.rmSync(fileFor(root), { force: true });
    for (let i = 0; i < 30 && isRunning(running.pid); i++) await sleep(100); // it still holds its port
  }
  fs.rmSync(errFor(root), { force: true });
  const args = [BIN, "__serve", "-C", root];
  if (opts.base) args.push("--base", opts.base);
  if (opts.title) args.push("--title", opts.title);
  if (opts.walkthrough) args.push("--walkthrough", opts.walkthrough);
  if (opts.port) args.push("--port", String(opts.port));
  spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const s = read(root);
    if (s && (!running || s.pid !== running.pid)) return { ...s, reused: false };
    if (fs.existsSync(errFor(root))) throw new Error(`the review could not start: ${fs.readFileSync(errFor(root), "utf8")}`);
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
      if (!r.ok) throw new Error(`the review refused this agent: ${ev.error || r.status}`);
    } catch (e) {
      if (/refused/.test(e.message)) throw e;
      return { type: "done", decision: "dismissed", output: "Review session closed without feedback." };
    }
    if (ev.type === "question" || ev.type === "done") return ev;
  }
}

/** Send the agent's answer to the page. */
async function answer(s, id, text) {
  const r = await fetch(urlOf(s) + "/api/agent/answer", { method: "POST", headers: agentHeaders(s), body: JSON.stringify({ id, text }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `answer failed (${r.status})`);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRunning = (pid) => {
  try {
    return process.kill(pid, 0), true;
  } catch {
    return false;
  }
};

module.exports = { read, claim, fail, remove, newToken, wantOf, alive, ensure, waitNext, answer, urlOf, pageUrl };
