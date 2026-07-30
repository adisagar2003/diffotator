"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const G = require("./git");
const { render } = require("./feedback");
const D = require("./drafts");

const WEB = path.join(__dirname, "..", "web");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 20e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parseScope(q) {
  const type = q.get("scope") || "worktree";
  if (type === "commit") return { type: "commit", sha: q.get("sha") };
  if (type === "range") return { type: "range", base: q.get("base"), head: q.get("head") || "HEAD" };
  return { type: "worktree" };
}

/**
 * @param {object} opts
 * @param {string} opts.root      repo root
 * @param {function} opts.finish  called with the final stdout payload; owns process exit
 */
function createServer({ root, finish, title }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const q = url.searchParams;

    try {
      // ---- static -------------------------------------------------------
      if (req.method === "GET" && !p.startsWith("/api/")) {
        const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
        const file = path.join(WEB, rel);
        if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.writeHead(404).end("not found");
          return;
        }
        const body = fs.readFileSync(file);
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
          "Content-Length": body.length,
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }

      // ---- api ----------------------------------------------------------
      if (p === "/api/overview") {
        const ov = await G.overview(root);
        return json(res, 200, { ...ov, title, draft: D.loadDraft(root) });
      }

      if (p === "/api/draft" && req.method === "POST") {
        D.saveDraft(root, await readBody(req));
        return json(res, 200, { ok: true });
      }

      if (p === "/api/commits") {
        const commits = await G.log(root, {
          limit: +(q.get("limit") || 300),
          skip: +(q.get("skip") || 0),
          rev: q.get("rev") || null,
          file: q.get("file") || null,
          all: q.get("all") === "1",
        });
        return json(res, 200, { commits });
      }

      if (p === "/api/commit") {
        const sha = q.get("sha");
        const [meta, files] = await Promise.all([
          G.commitMeta(root, sha),
          G.changedFiles(root, { type: "commit", sha }),
        ]);
        return json(res, 200, { meta, files });
      }

      if (p === "/api/files") {
        const scope = parseScope(q);
        return json(res, 200, { files: await G.changedFiles(root, scope) });
      }

      if (p === "/api/diff") {
        const scope = parseScope(q);
        const file = q.get("file");
        const [diff, full] = await Promise.all([
          G.fileDiff(root, scope, file),
          q.get("full") === "1" ? G.fileContent(root, scope, file) : Promise.resolve(null),
        ]);
        return json(res, 200, { file, diff, full });
      }

      if (p === "/api/file") {
        const scope = parseScope(q);
        return json(res, 200, { file: q.get("file"), full: await G.fileContent(root, scope, q.get("file")) });
      }

      if (p === "/api/tree") {
        return json(res, 200, { paths: await G.tree(root, parseScope(q)) });
      }

      if (p === "/api/submit" && req.method === "POST") {
        const payload = await readBody(req);
        const out = render({ ...payload, repo: path.basename(root) });
        D.clearDraft(root);
        json(res, 200, { ok: true });
        // Let the browser paint its confirmation screen before we tear down.
        setTimeout(() => finish(out, payload.decision || "annotated"), 400);
        return;
      }

      res.writeHead(404).end("not found");
    } catch (e) {
      json(res, 500, { error: String((e && e.message) || e) });
    }
  });

  return server;
}

module.exports = { createServer };
