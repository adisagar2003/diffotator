"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const G = require("./git");
const Scope = require("./scope");
const { render } = require("./feedback");
const D = require("./drafts");
const W = require("./walkthrough");
const { createTalk } = require("./talk");

const WEB = path.join(__dirname, "..", "web");
// The scope vocabulary is shared with the browser, so it is served out of src
// rather than duplicated into web/.
const SHARED = { "/scope.js": path.join(__dirname, "scope.js"), "/walkthrough.js": path.join(__dirname, "walkthrough.js") };
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
  "GET /api/overview": async ({ root, title, base, walkthrough }) => ({
    ...(await G.overview(root, { base })),
    title,
    walkthrough: !!walkthrough,
    draft: D.loadDraft(root),
  }),

  /* Read on every request, not once at start: the agent may still be writing
     the file when the page first asks, and a rewrite should show on reload.
     Whatever the file says is repaired against this scope's changed files. */
  "GET /api/walkthrough": async ({ root, scope, walkthrough }) => {
    const paths = (await G.changedFiles(root, scope)).map((f) => f.path);
    if (!walkthrough) return W.validate(null, paths);
    try {
      return W.validate(JSON.parse(fs.readFileSync(walkthrough, "utf8")), paths);
    } catch (e) {
      return W.validate(null, paths, `Couldn't read the walkthrough file: ${e.message}`);
    }
  },

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
      G.fileDiff(root, scope, file, undefined, q.get("ws") === "1"),
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

  // --- asking the agent mid-review (see src/talk.js) -------------------------

  "POST /api/ask": async ({ body, talk }) => {
    const b = await body();
    const text = typeof b.text === "string" ? b.text.trim().slice(0, 4000) : "";
    if (!text) throw httpError(400, "a question needs some text");
    const c = b.context && typeof b.context === "object" ? b.context : null;
    const context =
      c && typeof c.file === "string" && c.file
        ? {
            file: c.file.slice(0, 500),
            side: c.side === "old" ? "old" : "new",
            line: Number.isInteger(c.line) && c.line > 0 ? c.line : null,
            text: typeof c.text === "string" ? c.text.slice(0, 500) : "",
          }
        : null;
    return { id: talk.ask(text, context).id };
  },

  "GET /api/thread": async ({ talk }) => talk.thread(),

  "GET /api/agent/ping": async ({ talk }) => ({ ok: true, finished: talk.finished() }),

  "GET /api/agent/next": async ({ talk, q, agentDone }) => {
    const ev = await talk.next(Math.min(+q.get("timeout") || 25000, 60000));
    if (ev.type === "done") agentDone();
    return ev;
  },

  "POST /api/agent/answer": async ({ body, talk }) => {
    const b = await body();
    const text = typeof b.text === "string" ? b.text.trim().slice(0, 20000) : "";
    if (!text) throw httpError(400, "an answer needs some text");
    const item = talk.answer(Number.isInteger(b.id) ? b.id : null, text);
    if (!item) throw httpError(404, "no open question to answer");
    return { id: item.id };
  },

  "POST /api/submit": async ({ root, body, submit, talk }) => {
    const payload = await body();
    const result = {
      decision: payload.decision || "annotated",
      output: render({ ...payload, repo: path.basename(root) }),
    };
    submit(result);
    talk.finish(result.decision, result.output);
    D.clearDraft(root);
    return { ok: true };
  },
};

/**
 * @param {object} opts
 * @param {string} opts.root   repo root
 * @param {string} [opts.title] header title for the session
 * @param {string} [opts.base] forced base ref for the branch-vs-base scope
 * @param {string} [opts.walkthrough] path of the agent-written walkthrough JSON
 * @returns {http.Server} with an extra `submitted` promise that resolves to
 *   `{decision, output}` when the reviewer submits. The caller owns teardown
 *   and process exit — this module knows nothing about either.
 */
function createServer({ root, title, base, walkthrough, token = null, onAgentDone = () => {} }) {
  let onSubmit;
  const submitted = new Promise((resolve) => (onSubmit = resolve));
  const talk = createTalk();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const q = url.searchParams;
    try {
      const route = ROUTES[`${req.method} ${p}`];
      /* Who may call what. The agent's routes need the session's secret, which
         only the agent's own commands can read. Everything else the page sends
         must carry a custom header: a page on another site cannot add one
         without the browser asking this server first, and it never says yes —
         so no website can submit a review or put words in the agent's ear. */
      // A page on another site that renamed itself to 127.0.0.1 (DNS rebinding)
      // still sends its own name as Host, so only our own names get in.
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || "")) {
        throw httpError(403, "unknown host");
      }
      if (p.startsWith("/api/agent/")) {
        if (!token || req.headers["x-diffotator-token"] !== token) throw httpError(403, "not this review's agent");
      } else if (req.method === "POST" && req.headers["x-diffotator"] !== "1") {
        throw httpError(403, "requests must come from the diffotator page");
      }
      if (route) {
        return json(
          res,
          200,
          await route({
            root,
            title,
            base,
            walkthrough,
            q,
            body: () => readBody(req),
            submit: onSubmit,
            talk,
            agentDone: onAgentDone,
            get scope() {
              return Scope.parse(q.get("scope"));
            },
          })
        );
      }
      if (req.method === "GET" && !p.startsWith("/api/")) return serveStatic(p, res);
      res.writeHead(404).end("not found");
    } catch (e) {
      json(res, (e && e.status) || 500, { error: String((e && e.message) || e) });
    }
  });

  server.submitted = submitted;
  server.talk = talk;
  return server;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = { createServer, ROUTES };
