"use strict";
/* The walkthrough view — what diffotator opens on. It draws the home page (the
 * MR summary, the domain background and the map), moves between levels of the
 * map like pages of a website, and shows a file, the commits or a domain doc in
 * the same spot. `app.js` calls it from boot, from every scope change and from
 * its keydown handler; for the file view it reuses app.js's own diff stream,
 * narrowed to one file through `S.only`.
 *
 * Loaded before app.js and only calls app.js's globals ($, S, api, render, …)
 * once the page is running, so the load order cannot bite.
 */
(function () {
  const WT = window.Walkthrough;
  const PALETTE = ["#c08bff", "#22d3ee", "#ff6fb5", "#3fdc6a", "#ffb340", "#58a6ff", "#f78c6c", "#e3b341"];
  const MODE_KEY = "diffotator.mode";
  const HOME = { kind: "home" };
  const W = {
    ready: false,
    wt: null,
    idx: new Map(),
    order: [],
    route: HOME,
    trail: [],
    canvas: null,
    mapSeq: 0,
    loadSeq: 0,
    viewports: new Map(),
    focusMem: new Map(),
    headOpen: true,
    overlay: null,
    tlHome: null,
  };
  const colorOf = (tone) => (tone >= 0 ? PALETTE[tone % PALETTE.length] : "#9aa4b8");
  const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);

  // --- mode --------------------------------------------------------------------

  const isOn = () => document.body.classList.contains("mode-walk");
  function savedMode() {
    try {
      return sessionStorage.getItem(MODE_KEY) || "walk";
    } catch {
      return "walk"; // storage blocked: the default is the walkthrough
    }
  }
  function setMode(mode) {
    try {
      sessionStorage.setItem(MODE_KEY, mode);
    } catch {}
    document.body.classList.toggle("mode-walk", mode === "walk");
    document.body.classList.toggle("mode-classic", mode !== "walk");
    $("#btnClassic").textContent = mode === "walk" ? "Classic" : "Walkthrough";
    $("#btnClassic").title = mode === "walk" ? "Today's full diff view (⇧C)" : "Back to the walkthrough (⇧C)";
    if (mode === "walk") {
      if (S.tab !== "changes") setTab("changes"); // the walkthrough has no File Tree tab to leave it on
      return show();
    }
    leave(W.route);
    W.route = HOME;
    render();
  }

  // --- data --------------------------------------------------------------------

  async function load() {
    const seq = ++W.loadSeq;
    let wt;
    try {
      wt = await api("walkthrough", scopeParams());
    } catch (e) {
      wt = WT.validate(null, S.files.map((f) => f.path), `Couldn't load the walkthrough: ${e.message}`);
    }
    if (seq !== W.loadSeq) return false;
    W.wt = wt;
    W.idx = WT.index(wt.blocks);
    W.order = WT.fileOrder(wt.blocks);
    return true;
  }

  async function init() {
    // Wired here, not at load: this file loads before app.js defines `$`.
    /* A clicked bar button would keep focus and then claim Enter and Space,
       which on the map mean "open this box". Keyboard focus is left alone. */
    const click = (sel, fn) => $(sel).addEventListener("click", (e) => (e.detail && e.currentTarget.blur(), fn()));
    click("#btnClassic", () => setMode(isOn() ? "classic" : "walk"));
    click("#walkBack", back);
    click("#walkHead", toggleHead);
    click("#walkCommits", () => go({ kind: "commits" }));
    $("#walkInfo").addEventListener("click", (e) => {
      const a = e.target.closest("a[href^='#/']");
      if (a) e.preventDefault(), (location.hash = a.getAttribute("href"));
    });
    window.addEventListener("hashchange", () => isOn() && location.hash !== W.shown && show());
    await load();
    W.ready = true;
    setMode(savedMode());
  }

  /** Every scope change: the file set moved, so the walkthrough is re-checked against it. */
  async function onScope() {
    if (!W.ready) return;
    if ((await load()) && isOn()) show();
  }

  // --- routes ------------------------------------------------------------------

  /* Draws now, not on the hashchange that follows, so a caller (the comments
     panel) can rely on the page being there; the listener skips what was
     already drawn. */
  const go = (r) => {
    const h = WT.formatRoute(r);
    if (location.hash !== h) location.hash = h;
    show();
  };
  // Saved pan/zoom and focus belong to one scope's map: a commit's map is a different picture.
  const memKey = (r) => scopeId() + "|" + WT.formatRoute(r);
  function up(r) {
    if (r.kind === "file") {
      const at = W.idx.get(r.file);
      return at ? { kind: "block", path: at.ids } : HOME;
    }
    if (r.kind === "block" && r.path.length > 1) return { kind: "block", path: r.path.slice(0, -1) };
    return HOME;
  }
  /* Back means "where I came from" while there is somewhere in this tab to go
     back to, and "one level up" for a page opened straight from a link. */
  function back() {
    if (W.trail.length > 1) history.back();
    else go(up(W.route));
  }
  function depth(r) {
    if (r.kind === "home") return 0;
    if (r.kind === "block") return r.path.length;
    if (r.kind === "file") return ((W.idx.get(r.file) || {}).ids || []).length + 1;
    return 1;
  }
  function valid(r) {
    if (r.kind === "block") return !!WT.findBlock(W.wt.blocks, r.path);
    if (r.kind === "file") return S.files.some((f) => f.path === r.file);
    return true;
  }

  function show() {
    if (!W.ready || !isOn()) return;
    let r = WT.parseRoute(location.hash);
    if (!valid(r)) {
      r = HOME;
      // Keep the address bar, the history and the Back trail in agreement.
      if (location.hash && location.hash !== "#/") history.replaceState(null, "", location.pathname + location.search + "#/");
    }
    W.shown = location.hash;
    const prev = W.route;
    const key = WT.formatRoute(r);
    if (W.trail[W.trail.length - 2] === key) W.trail.pop();
    else if (W.trail[W.trail.length - 1] !== key) W.trail.push(key);
    leave(prev, r);
    W.route = r;
    document.body.dataset.route = r.kind === "home" || r.kind === "block" ? "map" : r.kind;
    crumbs(r);
    fileInfo(r);
    hint(r);
    if (r.kind === "file") showFile(r.file);
    else if (r.kind === "commits") showCommits();
    else if (r.kind === "doc") showDoc(r.file);
    else showMap(r);
    const d = depth(r) - depth(prev);
    const el = r.kind === "file" ? $("#rightPane") : $("#walkView");
    el.classList.remove("wk-in-deeper", "wk-in-back", "wk-in-side");
    void el.offsetWidth; // restart the animation
    el.classList.add(d > 0 ? "wk-in-deeper" : d < 0 ? "wk-in-back" : "wk-in-side");
  }

  /** Undo what the previous page borrowed from app.js before the next one draws. */
  function leave(prev, next) {
    if (W.canvas) {
      W.canvas.unmount();
      W.canvas = null;
    }
    W.mapSeq++;
    if (prev.kind === "commits" && W.tlHome) {
      W.tlHome.parent.insertBefore($("#timelinePane"), W.tlHome.next);
      W.tlHome = null;
    }
    if (!next || next.kind !== "file") clearOnly();
  }

  // --- the bar: back, breadcrumbs, file facts ------------------------------------

  function crumbs(r) {
    $("#walkBack").hidden = r.kind === "home";
    $("#walkHead").hidden = r.kind !== "home" || W.wt.fallback;
    $("#walkHead").textContent = W.headOpen ? "Hide summary" : "Show summary";
    $("#walkCommits").hidden = !S.tl;
    const parts = [{ label: "Home", r: HOME }];
    const ids = r.kind === "block" ? r.path : r.kind === "file" ? (W.idx.get(r.file) || {}).ids || [] : [];
    ids.forEach((_, i) => {
      const b = WT.findBlock(W.wt.blocks, ids.slice(0, i + 1));
      if (b) parts.push({ label: b.label, r: { kind: "block", path: ids.slice(0, i + 1) } });
    });
    if (r.kind === "file") parts.push({ label: baseName(r.file), title: r.file });
    if (r.kind === "doc") parts.push({ label: r.file });
    if (r.kind === "commits") parts.push({ label: "Commits" });
    $("#walkCrumbs").innerHTML = parts
      .map((p, i) =>
        i === parts.length - 1
          ? `<b title="${esc(p.title || p.label)}">${esc(p.label)}</b>`
          : `<button data-crumb="${i}">${esc(p.label)}</button><span class="wk-sep">›</span>`
      )
      .join("");
    $("#walkCrumbs").onclick = (e) => {
      const b = e.target.closest("[data-crumb]");
      if (b) go(parts[+b.dataset.crumb].r);
    };
  }

  function fileInfo(r) {
    const box = $("#walkInfo");
    const at = r.kind === "file" && W.idx.get(r.file);
    if (!at) return (box.innerHTML = "");
    const area = WT.findBlock(W.wt.blocks, at.ids);
    const link = (p, cls) => `<a href="${esc(WT.formatRoute({ kind: "file", file: p }))}" class="${cls}" title="${esc(p)}">${esc(baseName(p))}</a>`;
    box.innerHTML =
      `<span class="wk-chip" style="--c:${colorOf(at.tone)}">${esc(area ? area.label : "")}</span>` +
      (at.owner ? `<span>Test for ${link(at.owner, "wk-code")}</span>` : at.tests.length ? `<span>Tested by ${at.tests.map((t) => link(t, "wk-test")).join(", ")}</span>` : "");
  }

  // --- home and blocks: the map ----------------------------------------------

  function headHtml() {
    const wt = W.wt;
    const title = esc(wt.title || S.ov.title || S.ov.name);
    if (wt.fallback) {
      return `<div id="wkHead" class="wk-head wk-one"><div class="wk-card"><h2>This review</h2><h1>${title}</h1>
        <p>No walkthrough was written for this review, so the blocks below follow the folders.</p>
        ${wt.error ? `<p class="wk-err">${esc(wt.error)}</p>` : ""}</div></div>`;
    }
    const mr = `<div class="wk-card wk-mr"><h2>What this change does ${wt.ticket ? `<span class="chip">${esc(wt.ticket)}</span>` : ""}</h2><h1>${title}</h1>
      ${wt.summary ? `<p>${esc(wt.summary)}</p>` : ""}
      ${wt.changes.length ? `<ul>${wt.changes.map((c) => `<li><b>${esc(c.label)}:</b> ${esc(c.text)}</li>`).join("")}</ul>` : ""}
      ${wt.decisions.map((d) => `<p class="wk-dec">Decision: ${esc(d)}</p>`).join("")}
      ${wt.lookHard ? `<div class="wk-look"><b>Look hardest at</b> ${esc(wt.lookHard)}</div>` : ""}
      ${wt.error ? `<p class="wk-err">${esc(wt.error)}</p>` : ""}</div>`;
    const terms = wt.terms.length
      ? `<div class="wk-terms">${wt.terms
          .map((t, i) => `<button data-term="${i}" title="${esc(t.meaning || t.source || "")}"${t.source ? "" : " disabled"}>${esc(t.term)}${t.source ? " ↗" : ""}</button>`)
          .join("")}</div>`
      : "";
    const dom = wt.domain.length || wt.terms.length
      ? `<div class="wk-card wk-dom"><h2>Know this first</h2>${wt.domain.length ? `<dl>${wt.domain.map((d) => `<dt>${esc(d.label)}</dt><dd>${esc(d.text)}</dd>`).join("")}</dl>` : ""}${terms}</div>`
      : "";
    return `<div id="wkHead" class="wk-head${dom ? "" : " wk-one"}${W.headOpen ? "" : " wk-closed"}">${mr}${dom}</div>`;
  }

  function showMap(r) {
    const view = $("#walkView");
    view.innerHTML = (r.kind === "home" ? headHtml() : "") + `<div id="walkCanvas" class="wk-canvas"></div>`;
    view.onclick = (e) => {
      const t = e.target.closest("[data-term]");
      if (t && !t.disabled) go({ kind: "doc", file: W.wt.terms[+t.dataset.term].source });
    };
    const el = $("#walkCanvas");
    if (!W.wt.blocks.length) return void (el.innerHTML = `<div class="wk-empty">No changes in this scope.</div>`);
    const stats = new Map(S.files.map((f) => [f.path, { add: f.additions || 0, del: f.deletions || 0 }]));
    const g = WT.buildGraph(W.wt, r, stats);
    if (!g) return go(HOME);
    if (!window.WalkCanvas) return void (el.innerHTML = `<div class="wk-empty">The map didn't load. Use the file list on the left, or Classic (⇧C).</div>`);
    el.innerHTML = `<div class="wk-empty">Laying out…</div>`;
    const key = memKey(r), seq = W.mapSeq;
    WalkCanvas.mount(el, {
      nodes: g.nodes,
      edges: g.edges,
      palette: PALETTE,
      viewport: W.viewports.get(key),
      focus: W.focusMem.get(key),
      onOpen: (n) => {
        W.focusMem.set(key, n.id);
        go(n.nav);
      },
      onOpenTest: (p) => go({ kind: "file", file: p }),
      onViewport: (v) => W.viewports.set(key, v),
    }).then(
      (ctl) => {
        if (!ctl) return;
        if (seq !== W.mapSeq) return ctl.unmount(); // the reader already moved on
        W.canvas = ctl;
      },
      (e) => {
        if (seq === W.mapSeq) el.innerHTML = `<div class="wk-empty">The map couldn't be laid out (${esc(e.message)}). Use the file list on the left, or Classic (⇧C).</div>`;
      }
    );
  }

  function toggleHead() {
    W.headOpen = !W.headOpen;
    const head = $("#wkHead");
    if (head) head.classList.toggle("wk-closed", !W.headOpen);
    $("#walkHead").textContent = W.headOpen ? "Hide summary" : "Show summary";
  }

  // --- a file: app.js's stream, narrowed to one file -----------------------------

  function showFile(file) {
    showOnly(file);
  }

  function stepFile(d) {
    const order = W.order.filter((p) => S.files.some((f) => f.path === p));
    const next = order[order.indexOf(W.route.file) + d];
    if (next) go({ kind: "file", file: next });
  }
  function toggleTests() {
    const at = W.idx.get(W.route.file);
    if (!at) return;
    if (at.owner) go({ kind: "file", file: at.owner });
    else if (at.tests.length) go({ kind: "file", file: at.tests[0] });
  }

  // --- commits and docs, in the same spot -------------------------------------------

  function showCommits() {
    const view = $("#walkView");
    if (!S.tl) {
      view.innerHTML = `<div class="wk-empty">Commits show for a branch review. This one is your working tree.</div>`;
      return;
    }
    view.innerHTML = `<div class="wk-commits-head">Pick a commit to narrow the whole review to it; Back returns to the map.</div>`;
    const tl = $("#timelinePane");
    W.tlHome = { parent: tl.parentNode, next: tl.nextSibling };
    view.appendChild(tl);
    $("#timeline").focus({ preventScroll: true }); // so the arrow keys scroll the list
  }

  async function showDoc(file) {
    const view = $("#walkView");
    view.innerHTML = `<div class="wk-doc" tabindex="-1"><div class="wk-empty">Loading ${esc(file)}…</div></div>`;
    view.firstElementChild.focus({ preventScroll: true }); // so the arrow keys scroll the doc
    const seq = W.mapSeq;
    let res;
    try {
      res = await api("file", { ...scopeParams(), file });
    } catch {
      res = { full: { error: true } };
    }
    if (seq !== W.mapSeq) return;
    const full = res.full || {};
    view.firstElementChild.innerHTML = full.rows
      ? `<pre>${full.rows.map((r) => esc(r.s)).join("\n")}</pre>`
      : `<div class="wk-empty">Couldn't open ${esc(file)}.</div>`;
  }

  // --- go to any file -----------------------------------------------------------------

  function closeOverlay() {
    if (!W.overlay) return false;
    W.overlay.remove();
    W.overlay = null;
    return true;
  }
  function palette() {
    closeOverlay();
    const el = document.createElement("div");
    el.className = "wk-pal";
    el.innerHTML = `<div class="wk-pal-box" role="dialog" aria-label="Go to file"><input placeholder="Go to file…" spellcheck="false" aria-label="File name"><div class="wk-pal-list" role="listbox"></div></div>`;
    document.body.appendChild(el);
    W.overlay = el;
    const input = el.querySelector("input"), list = el.querySelector(".wk-pal-list");
    const all = [...W.order, ...S.files.map((f) => f.path).filter((p) => !W.idx.has(p))].filter((p) => S.files.some((f) => f.path === p));
    let hits = [], sel = 0;
    const draw = () => {
      const q = input.value.toLowerCase();
      hits = all.filter((p) => p.toLowerCase().includes(q)).slice(0, 50);
      sel = Math.min(sel, Math.max(0, hits.length - 1));
      list.innerHTML =
        hits
          .map((p, i) => {
            const at = W.idx.get(p);
            const where = at ? (WT.findBlock(W.wt.blocks, at.ids) || {}).label || "" : "";
            return `<div class="wk-pal-it${i === sel ? " on" : ""}" role="option" style="--c:${colorOf(at ? at.tone : -1)}" data-p="${esc(p)}"><b>${esc(baseName(p))}</b><span>${esc(where)} · ${esc(p)}</span></div>`;
          })
          .join("") || `<div class="wk-empty">No file matches.</div>`;
      const on = list.querySelector(".on");
      if (on) on.scrollIntoView({ block: "nearest" });
    };
    const pick = (p) => {
      closeOverlay();
      go({ kind: "file", file: p });
    };
    input.addEventListener("input", () => ((sel = 0), draw()));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") (sel = Math.min(hits.length - 1, sel + 1)), draw();
      else if (e.key === "ArrowUp") (sel = Math.max(0, sel - 1)), draw();
      else if (e.key === "Enter" && hits[sel]) pick(hits[sel]);
      else if (e.key === "Escape") closeOverlay();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    list.addEventListener("click", (e) => {
      const it = e.target.closest("[data-p]");
      if (it) pick(it.dataset.p);
    });
    el.addEventListener("mousedown", (e) => e.target === el && closeOverlay());
    draw();
    input.focus();
  }

  // --- keyboard -----------------------------------------------------------------------

  function hint(r) {
    const k = (x) => `<kbd>${x}</kbd>`;
    const map = `<span>${k("←")}${k("↑")}${k("→")}${k("↓")} move</span><span>${k("⏎")} open</span><span>${k("1")}–${k("9")} jump</span>`;
    const file = `<span>${k("j")}${k("k")} file</span><span>${k("n")}${k("p")} change</span><span>${k("c")} comment</span><span>${k("f")} full</span>`;
    $("#walkHint").innerHTML =
      (r.kind === "file" ? file : r.kind === "home" || r.kind === "block" ? map : "") +
      (r.kind === "home" ? "" : `<span>${k("⌫")} back</span>`) +
      `<span>${k("/")} find file</span><span>${k("?")} all keys</span>`;
  }

  // The app's single-key shortcuts act on the hidden stream; on the map they would
  // mark or fold a file nobody can see, so the map keeps only these.
  const MAP_KEEPS = "?bt";

  /** The walkthrough's turn at a keystroke, after app.js's typing guard. True if taken. */
  function key(e) {
    const k = e.key;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (!isOn()) {
      if (plain && k === "C") return e.preventDefault(), setMode("walk"), true;
      return false;
    }
    if (W.overlay) return false;
    const take = (fn) => (e.preventDefault(), fn(), true);
    // ⌘K only: ctrl+k is the pane-switching key.
    if (e.metaKey && !e.ctrlKey && !e.altKey && k.toLowerCase() === "k") return take(palette);
    if (!plain) return false;
    const r = W.route, map = r.kind === "home" || r.kind === "block", ctl = W.canvas;
    const tgt = e.target instanceof Element ? e.target : null;
    // A focused button or link keeps Enter and Space: it is what the reader is pressing.
    if ((k === "Enter" || k === " ") && tgt && tgt.closest("button, a, [role=button]")) return false;
    // The doc and commits pages scroll natively; the hidden diff stream must not see these.
    if ((r.kind === "doc" || r.kind === "commits") && /^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End)$/.test(k)) return true;
    if (k === "/") return take(palette);
    if (k === "C") return take(() => setMode("classic"));
    if (k === "h") return take(() => go({ kind: "commits" }));
    if (k === "b") return take(() => document.body.classList.toggle("wk-noleft"));
    if (k === "Backspace" && r.kind !== "home") return take(back);
    if (map) {
      const dir = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[k];
      if (dir) return take(() => ctl && ctl.move(dir));
      if (k === "j" || k === "k") return take(() => ctl && ctl.step(k === "j" ? 1 : -1));
      if (k === "Enter" || k === " ") return take(() => ctl && ctl.activate());
      if (/^[1-9]$/.test(k)) return take(() => ctl && ctl.openNumber(+k));
      if (k === "g") return take(() => go(HOME));
      if (k === "0") return take(() => ctl && ctl.fit());
      if (k === "+" || k === "=") return take(() => ctl && ctl.zoom(1));
      if (k === "-") return take(() => ctl && ctl.zoom(-1));
      if (k === "m" && r.kind === "home") return take(toggleHead);
    }
    if (r.kind === "file") {
      if (k === "j" || k === "k") return take(() => stepFile(k === "j" ? 1 : -1));
      if (k === "T") return take(toggleTests);
      return false;
    }
    if (k.length === 1 && Keys.SHORTCUTS.includes(k) && !MAP_KEEPS.includes(k)) return take(() => {});
    return false;
  }

  /** Escape with nothing else open: close the file finder, or go back. */
  function escape() {
    if (!isOn()) return false;
    if (closeOverlay()) return true;
    if (W.route.kind === "home") return false;
    back();
    return true;
  }

  /** One line for the send dialog when this is someone else's change. */
  function sendNote() {
    return W.wt && W.wt.mr
      ? ` This is someone else's change: questions get answered in chat; other comments become draft review comments you check before anything is posted.`
      : "";
  }

  window.Walk = {
    init,
    onScope,
    isOn,
    key,
    escape,
    sendNote,
    openFile: (p) => go({ kind: "file", file: p }),
  };
})();
