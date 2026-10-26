"use strict";
/* The live demo's stand-in server. On the website there is no diffotator
 * process, so this answers the page's /api calls from data.json — a recording
 * of one real review made by scripts/build-demo.js — and shows what Claude
 * would receive instead of sending it anywhere. Loaded before app.js; nothing
 * else calls it.
 */
(function () {
  // Inside the website's frame, the app taking focus must not scroll the page around it.
  if (window.top !== window) {
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (opts) {
      focus.call(this, { ...(opts || {}), preventScroll: true });
    };
    // scrollIntoView scrolls every ancestor, the website included; here it
    // scrolls only the nearest scrolling box inside the app.
    Element.prototype.scrollIntoView = function (opts) {
      const block = (typeof opts === "object" && opts && opts.block) || (opts === false ? "end" : "start");
      let box = this.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      if (!box) return;
      const r = this.getBoundingClientRect(), b = box.getBoundingClientRect();
      box.scrollTop +=
        block === "center" ? r.top + r.height / 2 - (b.top + b.height / 2)
        : block === "end" ? r.bottom - b.bottom
        : block === "nearest" ? (r.top < b.top ? r.top - b.top : r.bottom > b.bottom ? r.bottom - b.bottom : 0)
        : r.top - b.top;
    };
  }
  const realFetch = window.fetch.bind(window);
  const data = realFetch("data.json").then((r) => r.json());
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const empty = { files: [], diffs: {}, full: {}, tree: [], walkthrough: null };
  let lastMarkdown = "";
  // Ask your agent, played back: each question gets a canned answer a moment later.
  const thread = [];
  const CANNED = {
    why: "One gap keeps it at **Medium**: a code's end date is checked when it is added to the cart, but not again at checkout. A code added just before midnight still works after it expires.\n\nTo make it **High**: check the date again in `server/routes/cart.js` before charging, and add one test for it.",
    any: "This is the demo, so this answer is pre-written. In a real review your agent reads your question and the code, and answers here while the review stays open.",
  };

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
    const D = await data;
    const q = url.searchParams;
    const at = D.scopes[q.get("scope") || "worktree"] || empty;
    const body = init.body ? JSON.parse(init.body) : {};
    switch (url.pathname.slice(5)) {
      case "overview":
        return reply(D.overview);
      case "prefs":
        return reply(init.method === "POST" ? { ok: true } : {});
      case "draft":
        return reply({ ok: true }); // comments live in this tab only
      case "commits": {
        const list = (q.get("rev") || "").includes("..") ? D.commits.branch : D.commits.all;
        const skip = +(q.get("skip") || 0);
        return reply({ commits: list.slice(skip, skip + +(q.get("limit") || 300)) });
      }
      case "commit":
        return reply(D.commitMeta[q.get("sha")] || { meta: null, files: [] });
      case "files":
        return reply({ files: at.files });
      case "diff": {
        const f = q.get("file");
        return reply({ file: f, diff: at.diffs[f] || { rows: [], empty: true }, full: q.get("full") === "1" ? at.full[f] || null : null });
      }
      case "file": {
        const f = q.get("file");
        return reply({ file: f, full: at.full[f] || D.docs[f] || { error: "not part of the demo" } });
      }
      case "tree":
        return reply({ paths: at.tree });
      case "walkthrough":
        return reply(at.walkthrough || { blocks: [], edges: [], links: [], terms: [], changes: [], decisions: [], domain: [], fallback: true, error: null });
      case "preview":
        return reply({ markdown: window.Feedback.render({ ...body, repo: D.overview.name }) });
      case "ask": {
        const item = { id: thread.length + 1, text: body.text, context: body.context || null, askedAt: Date.now(), answer: null, answeredAt: null };
        thread.push(item);
        setTimeout(() => {
          item.answer = /confidence/i.test(item.text) ? CANNED.why : CANNED.any;
          item.answeredAt = Date.now();
        }, 1800);
        return reply({ id: item.id });
      }
      case "thread":
        return reply({ items: thread.map((x) => ({ ...x })), listening: true });
      case "submit":
        lastMarkdown = window.Feedback.render({ ...body, repo: D.overview.name });
        return reply({ ok: true });
    }
    return reply({ error: "not part of the demo" }, 404);
  };

  /* After Send, show the exact text Claude would get, then let the visitor
     start again. app.js fills the card and unhides it; we take over from there. */
  addEventListener("DOMContentLoaded", () => {
    const css = document.createElement("style");
    css.textContent =
      ".demo-md{text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;max-width:min(680px,90vw);max-height:46vh;overflow:auto;" +
      "margin:12px auto 16px;padding:14px 16px;background:var(--panel);border:1px solid var(--border);border-radius:10px;font:12.5px/1.55 var(--mono);color:var(--text)}" +
      ".done-card{max-width:min(760px,94vw)}";
    document.head.appendChild(css);
    const done = document.getElementById("done");
    new MutationObserver(() => {
      if (done.hidden || done.dataset.demo) return;
      done.dataset.demo = "1";
      const sub = document.getElementById("doneSub");
      sub.textContent = lastMarkdown ? "This is exactly what your agent reads next:" : "Your agent would carry on from here.";
      if (lastMarkdown) {
        const pre = document.createElement("pre");
        pre.className = "demo-md";
        pre.textContent = lastMarkdown;
        sub.after(pre);
      }
      const again = document.createElement("button");
      again.className = "btn primary";
      again.textContent = "Try it again";
      again.onclick = () => location.reload();
      done.querySelector(".done-card").appendChild(again);
    }).observe(done, { attributes: true, attributeFilter: ["hidden"] });
  });
})();
