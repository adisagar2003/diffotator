"use strict";
/* The "Ask your agent" panel and the merge-confidence chip. The reviewer asks
 * a question about the change without leaving the page; the agent hears it
 * (through the server's /api/agent routes and `diffotator answer`) and its
 * answer appears here, while the review stays open. The chip shows how sure
 * the agent is that the change is safe to merge, from the walkthrough's
 * `confidence`, and opens this panel so the reviewer can ask why.
 *
 * app.js calls `Ask.init` at boot and `Ask.toggle` / `closeAsk` from its
 * keyboard handler; walk.js calls `Ask.confidence` whenever the walkthrough
 * loads; the comment popover calls `Ask.ask` for "Ask agent now". Like walk.js,
 * it only touches app.js's globals ($, S, esc, lineText…) once the page runs.
 */
(function () {
  const A = { items: [], listening: false, seenAt: 0, timer: null, context: null, confidence: null, error: "" };
  const SEEN_KEY = "diffotator.askSeen"; // answers already read survive a reload
  try {
    A.seenAt = +sessionStorage.getItem(SEEN_KEY) || 0;
  } catch {}
  const markSeen = () => {
    A.seenAt = Date.now();
    try {
      sessionStorage.setItem(SEEN_KEY, A.seenAt);
    } catch {}
  };
  const LEVEL = { high: "High", medium: "Medium", low: "Low" };
  const isOpen = () => !$("#askPanel").hidden;
  const pending = () => A.items.some((x) => x.answer === null);

  /* Just enough markdown for an answer: code blocks, `code`, **bold**, paragraphs. */
  function md(s) {
    return s
      .split(/```[^\n]*\n?/)
      .map((part, i) =>
        i % 2
          ? `<pre>${esc(part.replace(/\n$/, ""))}</pre>`
          : esc(part)
              .replace(/`([^`\n]+)`/g, "<code>$1</code>")
              .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
              .split(/\n{2,}/)
              .filter((p) => p.trim())
              .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
              .join("")
      )
      .join("");
  }

  const where = (c) => (c && c.file ? c.file + (c.line ? ":" + c.line : "") : "");

  /* What the reviewer is looking at: the line under the cursor, or the open file. */
  function currentContext() {
    const walkOff = window.Walk && Walk.isOn() && !S.only; // on the map, no file is "this"
    if (!walkOff && S.focus && (!S.only || S.focus.file === S.only)) {
      const { file, side, line } = S.focus;
      return { file, side, line, text: lineText(file, side, line) || "" };
    }
    return S.only ? { file: S.only, side: "new", line: null, text: "" } : null;
  }

  async function refresh() {
    clearTimeout(A.timer);
    try {
      const t = await (await fetch("/api/thread")).json();
      A.items = t.items || [];
      A.listening = !!t.listening;
      draw();
    } catch {} // the review is closing; the next poll (if any) tries again
    // Poll only while something can change on screen: an open panel or a question in flight.
    if (isOpen() || pending()) A.timer = setTimeout(refresh, 1500);
  }

  /** Ask now. On failure the question waits in the box with the reason under it. */
  async function ask(text, context) {
    A.error = "";
    $("#askSend").disabled = true;
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-diffotator": "1" },
        body: JSON.stringify({ text, context }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `couldn't ask (${r.status})`);
      open();
      $("#askBody").value = "";
      A.context = null;
      await refresh();
    } catch (e) {
      open();
      $("#askBody").value = text;
      A.context = context;
      A.error = `Not sent: ${e.message}`;
    } finally {
      $("#askSend").disabled = false;
      draw();
    }
  }

  function send() {
    const text = $("#askBody").value.trim();
    if (!text) return $("#askBody").focus();
    ask(text, A.context);
  }

  function open(text) {
    const was = isOpen();
    $("#askPanel").hidden = false;
    if (!was) A.context = currentContext();
    if (text) $("#askBody").value = text;
    markSeen();
    draw();
    if (!was) refresh();
    $("#askBody").focus();
  }

  function toggle() {
    isOpen() ? closeAsk() : open();
  }

  function confidence(c) {
    A.confidence = c || null;
    const chip = $("#confChip");
    chip.hidden = !c;
    if (!c) return draw();
    chip.className = `chip conf conf-${c.level}`;
    chip.innerHTML = `<span class="dot"></span><span class="lbl">Merge confidence </span>${LEVEL[c.level]}`;
    chip.title = c.summary || "How sure your agent is that this is safe to merge";
    draw();
  }

  function draw() {
    const unread = A.items.filter((x) => x.answer !== null && x.answeredAt > A.seenAt).length;
    if (isOpen()) markSeen();
    $("#askBadge").hidden = isOpen() || !unread;
    $("#askBadge").textContent = unread;
    if (!isOpen()) return;

    $("#askStatus").className = "ask-status " + (A.listening ? "on" : "busy");
    $("#askStatus").textContent = A.listening ? "Your agent is listening" : "Your agent is busy. Questions wait in line.";

    const c = A.confidence;
    $("#askConf").hidden = !c;
    if (c) {
      $("#askConf").innerHTML = `<div class="ac-head"><span class="chip conf conf-${c.level}"><span class="dot"></span>${LEVEL[c.level]}</span> <b>Merge confidence</b></div>
        ${c.summary ? `<p>${esc(c.summary)}</p>` : ""}
        ${c.reasons.length ? `<ul>${c.reasons.map((r) => `<li class="${r.ok ? "ok" : "warn"}"><span>${r.ok ? "✓" : "!"}</span>${esc(r.text)}</li>`).join("")}</ul>` : ""}
        <button class="btn ghost" data-why>Ask why</button>`;
    }

    $("#askThread").innerHTML = A.items.length
      ? A.items
          .map(
            (x) => `<div class="ask-q">${x.context && x.context.file ? `<div class="ask-where">${esc(where(x.context))}</div>` : ""}${esc(x.text)}</div>
          ${x.answer === null ? `<div class="ask-a wait">Waiting for your agent<span class="dots"></span></div>` : `<div class="ask-a">${md(x.answer)}</div>`}`
          )
          .join("")
      : `<p class="ask-empty">Ask anything about this change. Your agent answers here, and the review stays open.</p>`;
    $("#askCtx").innerHTML = A.context
      ? `<span class="chip">About ${esc(where(A.context))}</span><button class="x" data-drop title="Ask without it">✕</button>`
      : "";
    $("#askErr").textContent = A.error;
    $("#askErr").hidden = !A.error;
    // Something new in the thread: show it.
    const sig = A.items.map((x) => x.id + (x.answer === null ? "?" : "!")).join();
    if (sig !== A.sig) (A.sig = sig), ($(".ask-scroll").scrollTop = 1e9);
  }

  function init() {
    $("#btnAsk").onclick = toggle;
    $("#confChip").onclick = () => open();
    $("#askClose").onclick = () => closeAsk();
    $("#askSend").onclick = send;
    $("#askCtx").addEventListener("click", (e) => {
      if (e.target.closest("[data-drop]")) (A.context = null), draw();
    });
    $("#askConf").addEventListener("click", (e) => {
      if (e.target.closest("[data-why]")) open(`Why is merge confidence ${LEVEL[A.confidence.level].toLowerCase()}? What would make it higher?`);
    });
    // Enter sends, Shift+Enter is a new line; ⌘⏎ here means this box, not the review.
    $("#askBody").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      send();
    });
    refresh(); // a reload mid-conversation picks the thread back up
  }

  window.Ask = { init, toggle, ask, confidence, isOpen };
})();
