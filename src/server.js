"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const G = require("./git");
const Scope = require("./scope");
const { render } = require("./feedback");
const D = require("./drafts");

const WEB = path.join(__dirname, "..", "web");
// The scope vocabulary is shared with the browser, so it is served out of src
// rather than duplicated into web/.
const SHARED = { "/scope.js": path.join(__dirname, "scope.js") };
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

function serveStatic(p, res) {
  const file = SHARED[p] || path.join(WEB, p === "/" ? "index.html" : p.replace(/^\/+/, ""));
  if ((!SHARED[p] && !file.startsWith(WEB)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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
}

/**
 * One entry per endpoint, keyed by "METHOD /path". A handler takes the request
 * context and returns the JSON body; throwing becomes a 500. This replaced an
 * eight-branch if-chain where each arm re-parsed the scope and hand-rolled its
 * own method check — adding an endpoint is now one entry, and the whole surface
 * is readable at a glance.
 *
 * Context: `root`, `title`, `q` (query params), `scope` (parsed lazily, because
 * most endpoints have no scope to validate), `body()`, `submit(result)`.
 */
const ROUTES = {
  "GET /api/overview": async ({ root, title, base }) => ({
    ...(await G.overview(root, { base })),
    title,
    draft: D.loadDraft(root),
  }),

  "POST /api/draft": async ({ root, body }) => {
    D.saveDraft(root, await body());
    return { ok: true };
  },

  "GET /api/prefs": async () => D.loadPrefs(),

  "POST /api/prefs": async ({ body }) => {
    D.savePrefs(await body());
    return { ok: true };
  },

  "GET /api/commits": async ({ root, q }) => ({
    commits: await G.log(root, {
      limit: +(q.get("limit") || 300),
      skip: +(q.get("skip") || 0),
      rev: q.get("rev") || null,
      file: q.get("file") || null,
      all: q.get("all") === "1",
      firstParent: q.get("firstParent") === "1",
    }),
  }),

  "GET /api/commit": async ({ root, q }) => {
    const sha = q.get("sha");
    const [meta, files] = await Promise.all([
      G.commitMeta(root, sha),
      G.changedFiles(root, { type: "commit", sha }),
    ]);
    return { meta, files };
  },

  "GET /api/files": async ({ root, scope }) => ({ files: await G.changedFiles(root, scope) }),

  "GET /api/diff": async ({ root, scope, q }) => {
    const file = q.get("file");
    const [diff, full] = await Promise.all([
      G.fileDiff(root, scope, file),
      q.get("full") === "1" ? G.fileContent(root, scope, file) : Promise.resolve(null),
    ]);
    return { file, diff, full };
  },

  "GET /api/file": async ({ root, scope, q }) => ({
    file: q.get("file"),
    full: await G.fileContent(root, scope, q.get("file")),
  }),

  "GET /api/tree": async ({ root, scope }) => ({ paths: await G.tree(root, scope) }),

  /* The same markdown the agent would get, without sending it or clearing the
     draft. One renderer, so what you paste into a PR is not a second, drifting
     rendering of the review. */
  "POST /api/preview": async ({ root, body }) => {
    const payload = await body();
    return { markdown: render({ ...payload, repo: path.basename(root) }) };
  },

  "POST /api/submit": async ({ root, body, submit }) => {
    const payload = await body();
    submit({
      decision: payload.decision || "annotated",
      output: render({ ...payload, repo: path.basename(root) }),
    });
    D.clearDraft(root);
    return { ok: true };
  },
};

/**
 * @param {object} opts
 * @param {string} opts.root   repo root
 * @param {string} [opts.title] header title for the session
 * @param {string} [opts.base] forced base ref for the branch-vs-base scope
 * @returns {http.Server} with an extra `submitted` promise that resolves to
 *   `{decision, output}` when the reviewer submits. The caller owns teardown
 *   and process exit — this module knows nothing about either.
 */
function createServer({ root, title, base }) {
  let onSubmit;
  const submitted = new Promise((resolve) => (onSubmit = resolve));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const q = url.searchParams;
    try {
      const route = ROUTES[`${req.method} ${p}`];
      if (route) {
        return json(
          res,
          200,
          await route({
            root,
            title,
            base,
            q,
            body: () => readBody(req),
            submit: onSubmit,
            get scope() {
              return Scope.parse(q.get("scope"));
            },
          })
        );
      }
      if (req.method === "GET" && !p.startsWith("/api/")) return serveStatic(p, res);
      res.writeHead(404).end("not found");
    } catch (e) {
      json(res, 500, { error: String((e && e.message) || e) });
    }
  });

  server.submitted = submitted;
  return server;
}

module.exports = { createServer, ROUTES };
