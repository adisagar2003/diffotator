"use strict";
/**
 * Unsent review work, persisted outside the browser.
 *
 * The obvious home is localStorage, and it is wrong: localStorage is scoped to
 * the full origin *including the port*, and every invocation binds a fresh
 * random port. Drafts written on :47601 are invisible on :47602, so they never
 * actually survived a second run. Cookies dodge that (host-scoped, port-blind)
 * but cap at ~4KB and die with the browser profile. Disk survives all of it,
 * including a browser running on a different machine over SSH.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function dataDir() {
  if (process.env.DIFFOTATOR_DATA_DIR) return process.env.DIFFOTATOR_DATA_DIR;
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? path.join(xdg, "diffotator") : path.join(os.homedir(), ".local", "share", "diffotator");
}

const keyFor = (root) => crypto.createHash("sha1").update(root).digest("hex").slice(0, 16);
const fileFor = (root, kind) => path.join(dataDir(), kind, keyFor(root) + ".json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a truncated draft.
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false; // a lost draft must never take the review session down
  }
}

/** @returns {{ann: object[], viewed: string[], root: string}|null} */
function loadDraft(root) {
  const d = readJson(fileFor(root, "drafts"));
  if (!d || d.root !== root) return null;
  return { ann: d.ann || [], viewed: d.viewed || [] };
}

function saveDraft(root, { ann = [], viewed = [] } = {}) {
  if (!ann.length && !viewed.length) return clearDraft(root);
  return writeJson(fileFor(root, "drafts"), { root, ann, viewed, at: Date.now() });
}

function clearDraft(root) {
  try {
    fs.unlinkSync(fileFor(root, "drafts"));
  } catch {}
  return true;
}

/**
 * What the Stop hook remembers between turns: the fingerprint of the working
 * tree it last showed you. Without it, approving a review and letting the agent
 * say one more sentence would pop the browser straight back open.
 */
function loadHookState(root) {
  return readJson(fileFor(root, "hook")) || {};
}

function saveHookState(root, state) {
  return writeJson(fileFor(root, "hook"), { root, ...state, at: Date.now() });
}

module.exports = { dataDir, loadDraft, saveDraft, clearDraft, loadHookState, saveHookState };
