"use strict";
/* diffotator — Fork-style review UI with agent-bound annotations.
 *
 * Perf contract (this is the whole point of the tool):
 *   - git data is fetched per file, on demand, never inlined into the page
 *   - every long list (commits, diff rows) is windowed: only visible rows exist in the DOM
 *   - rows are fixed-height so windowing needs no measurement pass
 *   - syntax highlighting runs on visible rows only
 */

const $ = (s) => document.querySelector(s);

// The fold/split/threading/graph arithmetic lives in review-model.js so it can
// be tested without a browser; this file is the DOM half.
const RM = window.RM;
// Same deal for the keyboard policy: which keystrokes are ours, and what
// Escape releases. See keys.js.
const Keys = window.Keys;

const LABELS = ["suggestion", "nit", "question", "issue", "praise", "thought", "note", "todo", "chore"];
const LANE_COLORS = ["#e5484d", "#f5a524", "#46a758", "#3e9dd6", "#a97bd6", "#e07ba8", "#5eead4", "#f0c674"];
const ROW = RM.GEOM.row;
const CROW = 26;

const S = {
  ov: null,
  scope: { type: "worktree" },
  scopeName: "Local Changes",
  commitRev: null,
  commits: [],
  graph: [],
  maxLanes: 1,
  selCommit: null,
  files: [],
  selFile: null,
  // One entry per path: {loaded, rows, fullRows, expanded, full, binary, tooBig, error, empty, mode}
  perFile: new Map(),
  desel: new Set(), // scoped keys; empty = everything selected (the default)
  collapsed: new Set(), // scoped keys
  segments: [],
  /* A file shorter than the viewport can never scroll its header to the top, so
     the sticky bar would rename the file we just jumped to. `pinnedSeg` holds
     that file until the reader scrolls for themselves; `pinExpectedTop` is where
     the programmatic scroll left the pane, so the pin's own scroll event does
     not release it. */
  pinnedSeg: null,
  pinExpectedTop: 0,
  treeDiff: null, // File Tree tab keeps the old one-file view
  treeRows: null,
  view: "split",
  tab: "changes",
  items: [],
  ann: [],
  viewed: new Set(),
  focus: null,
  treePaths: null,
  treeOpen: new Set(),
  fileOpen: new Set(),
  filter: "",
  listMode: true, // reviewing is "work the list of files"; browsing is a tree
  charW: 7.5,
  uiCharW: 6.2,
  popFor: null,
  popLabel: "suggestion",
  search: { q: "", hits: [], idx: 0 },
  loadingMore: false,
  commitsDone: false,
};

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------
const cache = new Map();
async function api(path, params = {}, { cached = false } = {}) {
  const q = new URLSearchParams(params);
  const url = `/api/${path}?${q}`;
  if (cached && cache.has(url)) return cache.get(url);
  const p = fetch(url).then((r) => r.json());
  if (cached) cache.set(url, p);
  return p;
}
/* One canonical string names a scope on the wire, in the request cache and in
   per-scope viewed state. Encoding and labelling live in src/scope.js, served
   to this page, so the browser and the git layer cannot drift apart. */
const scopeId = () => Scope.encode(S.scope);
const scopeParams = () => ({ scope: scopeId() });

// ---------------------------------------------------------------------------
// virtual list
// ---------------------------------------------------------------------------
/**
 * Windowed list. Rows are uniform by default; pass `heightOf` when they are
 * not (the diff mixes 20px code lines with taller inline comment cards) and a
 * prefix-sum index keeps lookup O(log n) with no measurement pass.
 */
function vlist(container, rowH, count, renderRow, heightOf) {
  const spacer = container.querySelector(".vspacer");
  const rows = container.querySelector(".vrows");
  let win = [-1, -1];
  let offsets = null;
  let emptyHtml = null;
  const state = { count, rowH };

  function reindex() {
    if (!heightOf) return;
    const n = state.count();
    offsets = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + heightOf(i);
  }
  const total = () => (heightOf ? (offsets ? offsets[offsets.length - 1] : 0) : state.count() * state.rowH);
  const topOf = (i) => (heightOf ? offsets[Math.min(i, offsets.length - 1)] : i * state.rowH);
  function indexAt(y) {
    if (!heightOf) return Math.floor(y / state.rowH);
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function paint(force) {
    const n = state.count();
    // An empty state has to survive repaints — the ResizeObserver fires right
    // after layout and would otherwise blank it out.
    if (!n && emptyHtml != null) {
      spacer.style.height = "0px";
      rows.innerHTML = emptyHtml;
      win = [-1, -1];
      return;
    }
    if (heightOf && (!offsets || offsets.length !== n + 1)) reindex();
    spacer.style.height = total() + "px";
    const st = container.scrollTop;
    const h = container.clientHeight || 400;
    const from = Math.max(0, indexAt(st) - 10);
    let to = from;
    while (to < n && topOf(to) < st + h) to++;
    to = Math.min(n, to + 10);
    if (!force && from === win[0] && to === win[1]) return;
    win = [from, to];
    let html = "";
    for (let i = from; i < to; i++) html += renderRow(i, topOf(i));
    rows.innerHTML = html;
  }
  container.addEventListener("scroll", () => paint(false), { passive: true });
  new ResizeObserver(() => paint(true)).observe(container);
  return {
    refresh: () => {
      win = [-1, -1];
      offsets = null;
      emptyHtml = null;
      paint(true);
    },
    paint,
    state,
    /* Empty states go INSIDE .vrows — replacing the container's children would
       orphan the spacer/rows nodes this closure holds. */
    setEmpty(html) {
      win = [-1, -1];
      offsets = null;
      emptyHtml = `<div class="empty-state">${html}</div>`;
      paint(true);
    },
    /** Which item the viewport starts inside — what the sticky header mirrors. */
    topIndex: () => {
      if (heightOf && (!offsets || offsets.length !== state.count() + 1)) reindex();
      return Math.max(0, Math.min(state.count() - 1, indexAt(container.scrollTop)));
    },
    /* `pad` is how much of what came before stays visible. The default keeps a
       few lines of context above the target; jumping to a file passes 0 so its
       header lands at the very top and the sticky bar names the file you
       clicked rather than the tail of the one above it. */
    scrollToIndex(i, center, pad = 60) {
      if (heightOf && (!offsets || offsets.length !== state.count() + 1)) reindex();
      const y = topOf(i);
      container.scrollTop = Math.max(0, center ? y - container.clientHeight / 2 : y - pad);
      paint(true);
    },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const esc = (s) => HL.esc(String(s ?? ""));
const extOf = (p) => (p || "").split(".").pop().toLowerCase();
function relTime(ms) {
  const d = new Date(ms);
  const now = Date.now();
  const diff = (now - ms) / 1000;
  if (diff < 60) return "just now";
  if (diff < 86400 * 300)
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function measureChar() {
  const probe = (font, sample) => {
    const el = document.createElement("span");
    el.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${font}`;
    el.textContent = sample;
    document.body.appendChild(el);
    const w = el.getBoundingClientRect().width / sample.length;
    el.remove();
    return w;
  };
  S.charW = probe("12.5px/20px var(--mono)", "0".repeat(100)) || 7.5;
  // Proportional average, used to predict how many lines a comment will wrap to.
  S.uiCharW = probe("12.5px/17px var(--ui)", "The quick brown fox jumps over the lazy dog, again and again.") || 6.2;
}

// ---------------------------------------------------------------------------
// sidebar
// ---------------------------------------------------------------------------
function sidebar() {
  const ov = S.ov;
  const changedCount = S.scope.type === "worktree" ? S.files.length : null;
  const active = (name) => (S.scopeName === name ? " active" : "");
  let h = "";
  h += `<div class="side-item${active("Local Changes")}" data-act="scope-worktree">
    <span class="ico">📝</span><span class="lbl">Local Changes</span>
    <span class="badge">${changedCount ?? ""}</span></div>`;
  if (ov.base) {
    h += `<div class="side-item${active("Branch")}" data-act="scope-range">
      <span class="ico">⑂</span><span class="lbl">vs ${esc(ov.base.ref)}</span></div>`;
  }
  h += `<div class="side-item${active("All Commits")}" data-act="scope-all">
    <span class="ico">≡</span><span class="lbl">All Commits</span></div>`;

  const group = (id, title, body) =>
    `<div class="side-group${S.fileOpen.has(id) ? "" : " closed"}" data-group="${id}">
       <span class="caret">▾</span>${title}</div>
     <div class="side-sub${S.fileOpen.has(id) ? "" : " hidden"}" data-sub="${id}">${body}</div>`;

  if (ov.worktrees.length > 1) {
    h += group(
      "wt",
      "Worktrees",
      ov.worktrees
        .map(
          (w) =>
            // A detached worktree has no branch; its HEAD sha is what git can resolve.
            `<div class="side-item" data-act="rev" data-rev="${esc(w.branch || w.head || "HEAD")}">
              <span class="ico">🗂</span><span class="lbl" title="${esc(w.path)}">${esc(w.name)}</span></div>`
        )
        .join("")
    );
  }
  h += group(
    "br",
    `Branches <span class="badge">${ov.branches.length}</span>`,
    ov.branches
      .slice(0, 300)
      .map(
        (b) =>
          `<div class="side-item" data-act="rev" data-rev="${esc(b.name)}">
            <span class="ico">⑂</span><span class="lbl">${esc(b.name)}</span>
            <span class="badge">${b.behind ? b.behind + "↓" : ""}${b.ahead ? b.ahead + "↑" : ""}</span></div>`
      )
      .join("")
  );
  if (ov.tags.length) {
    h += group(
      "tg",
      `Tags <span class="badge">${ov.tags.length}</span>`,
      ov.tags
        .slice(0, 200)
        .map(
          (t) =>
            `<div class="side-item" data-act="rev" data-rev="${esc(t.name)}">
              <span class="ico">🏷</span><span class="lbl">${esc(t.name)}</span></div>`
        )
        .join("")
    );
  }
  if (ov.stashes.length) {
    h += group(
      "st",
      `Stashes <span class="badge">${ov.stashes.length}</span>`,
      ov.stashes
        .map(
          (s) =>
            `<div class="side-item" data-act="commit" data-sha="${s.sha}">
              <span class="ico">📦</span><span class="lbl">${esc(s.subject)}</span></div>`
        )
        .join("")
    );
  }
  if (ov.remoteBranches.length) {
    h += group(
      "rm",
      `Remotes <span class="badge">${ov.remoteBranches.length}</span>`,
      ov.remoteBranches
        .slice(0, 300)
        .map(
          (b) =>
            `<div class="side-item" data-act="rev" data-rev="${esc(b.name)}">
              <span class="ico">☁</span><span class="lbl">${esc(b.name)}</span></div>`
        )
        .join("")
    );
  }
  $("#sideScroll").innerHTML = h;
}

$("#sideScroll").addEventListener("click", async (e) => {
  const g = e.target.closest(".side-group");
  if (g) {
    const id = g.dataset.group;
    S.fileOpen.has(id) ? S.fileOpen.delete(id) : S.fileOpen.add(id);
    sidebar();
    return;
  }
  const it = e.target.closest(".side-item");
  if (!it) return;
  const act = it.dataset.act;
  if (act === "scope-worktree") setScope({ type: "worktree" }, "Local Changes");
  else if (act === "scope-range")
    setScope({ type: "range", base: S.ov.base.ref, head: "HEAD" }, "Branch");
  else if (act === "scope-all") {
    S.scopeName = "All Commits";
    S.commitRev = null;
    collapseCommits(false);
    await loadCommits();
    sidebar();
  } else if (act === "rev") {
    S.scopeName = "All Commits";
    S.commitRev = it.dataset.rev;
    collapseCommits(false);
    await loadCommits();
    sidebar();
  } else if (act === "commit") {
    selectCommit(it.dataset.sha);
  }
});

// ---------------------------------------------------------------------------
// commit list + graph
// ---------------------------------------------------------------------------
function computeGraph(commits) {
  const { graph, maxLanes } = RM.computeGraph(commits);
  S.maxLanes = maxLanes;
  return graph;
}

function graphSvg(g) {
  const W = 13;
  const H = CROW;
  const width = S.maxLanes * W + 8;
  const x = (i) => 6 + Math.min(i, S.maxLanes - 1) * W;
  const col = (i) => LANE_COLORS[i % LANE_COLORS.length];
  let p = "";
  for (let i = 0; i < Math.max(g.incoming.length, g.outgoing.length); i++) {
    if (i === g.lane) continue;
    if (g.incoming[i] && g.outgoing[i] === g.incoming[i])
      p += `<line x1="${x(i)}" y1="0" x2="${x(i)}" y2="${H}" stroke="${col(i)}" stroke-width="1.6"/>`;
  }
  for (const m of g.merges)
    p += `<path d="M${x(m)} 0 C ${x(m)} ${H / 2}, ${x(g.lane)} ${H / 4}, ${x(g.lane)} ${H / 2}" fill="none" stroke="${col(m)}" stroke-width="1.6"/>`;
  for (const b of g.branches)
    p += `<path d="M${x(g.lane)} ${H / 2} C ${x(g.lane)} ${(H * 3) / 4}, ${x(b)} ${H / 2}, ${x(b)} ${H}" fill="none" stroke="${col(b)}" stroke-width="1.6"/>`;
  if (g.incoming[g.lane])
    p += `<line x1="${x(g.lane)}" y1="0" x2="${x(g.lane)}" y2="${H / 2}" stroke="${col(g.lane)}" stroke-width="1.6"/>`;
  if (g.outgoing[g.lane])
    p += `<line x1="${x(g.lane)}" y1="${H / 2}" x2="${x(g.lane)}" y2="${H}" stroke="${col(g.lane)}" stroke-width="1.6"/>`;
  p += `<circle cx="${x(g.lane)}" cy="${H / 2}" r="3.4" fill="${col(g.lane)}" stroke="#1b1c1e" stroke-width="1.4"/>`;
  return `<svg class="graph" width="${width}" height="${H}">${p}</svg>`;
}

const commitVL = vlist(
  $("#commitList"),
  CROW,
  () => S.commits.length,
  (i, top) => {
    const c = S.commits[i];
    if (!c) return "";
    const g = S.graph[i];
    const refs = c.refs
      .map((r) => {
        const cls = r.startsWith("tag: ") ? "tag" : r.includes("/") ? "remote" : "";
        return `<span class="reftag ${cls}">${esc(r.replace("tag: ", ""))}</span>`;
      })
      .join("");
    const merge = c.parents.length > 1 ? " merge" : "";
    const sel = S.selCommit === c.sha ? " sel" : "";
    return `<div class="crow${merge}${sel}" style="top:${top}px" data-sha="${c.sha}">
      ${graphSvg(g)}
      <div class="subj">${refs}${esc(c.subject)}</div>
      <div class="auth">${esc(c.author)}</div>
      <div class="sha">${c.short}</div>
      <div class="when">${relTime(c.date)}</div>
    </div>`;
  }
);

$("#commitList").addEventListener("click", (e) => {
  const r = e.target.closest(".crow");
  if (r) selectCommit(r.dataset.sha);
});

const COMMIT_PAGE = 300;
async function loadMoreCommits() {
  if (S.loadingMore || S.commitsDone) return;
  S.loadingMore = true;
  const { commits } = await api("commits", {
    limit: COMMIT_PAGE,
    skip: S.commits.length,
    ...(S.commitRev ? { rev: S.commitRev } : {}),
  });
  if (commits.length < COMMIT_PAGE) S.commitsDone = true;
  if (commits.length) {
    S.commits = S.commits.concat(commits);
    S.graph = computeGraph(S.commits);
    commitVL.refresh();
  }
  S.loadingMore = false;
}
$("#commitList").addEventListener(
  "scroll",
  () => {
    const el = $("#commitList");
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 400) loadMoreCommits();
  },
  { passive: true }
);

async function loadCommits(select = true) {
  S.commitsDone = false;
  const { commits } = await api("commits", {
    limit: COMMIT_PAGE,
    ...(S.commitRev ? { rev: S.commitRev } : {}),
  });
  if (commits.length < COMMIT_PAGE) S.commitsDone = true;
  S.commits = commits;
  S.graph = computeGraph(commits);
  commitVL.refresh();
  // git answers an unresolvable revision with an empty log, which is also what
  // a branch with no commits looks like. Either way, blanking the pane and
  // saying nothing reads as the click having done nothing at all.
  if (!commits.length)
    commitVL.setEmpty(S.commitRev ? `No commits for <b>${esc(S.commitRev)}</b>.` : "No commits yet.");
  if (select && commits.length) selectCommit(commits[0].sha);
}

async function selectCommit(sha) {
  S.selCommit = sha;
  commitVL.refresh();
  setScope({ type: "commit", sha }, "Commit", true);
  const { meta } = await api("commit", { sha }, { cached: true });
  renderCommitDetail(meta);
}

function renderCommitDetail(m) {
  if (!m) return;
  $("#commitDetail").innerHTML = `
    <div class="subject">${esc(m.subject)}</div>
    <div class="dl">
      <div class="dt">Author</div><div>${esc(m.author)} <span class="mono" style="color:var(--muted)">${esc(m.email)}</span></div>
      <div class="dt">Date</div><div>${new Date(m.date).toLocaleString()}</div>
      ${m.refs.length ? `<div class="dt">Refs</div><div>${m.refs.map((r) => `<span class="reftag">${esc(r)}</span>`).join("")}</div>` : ""}
      <div class="dt">SHA</div><div class="mono">${m.sha}</div>
      <div class="dt">Parents</div><div class="mono">${m.parents.map((p) => p.slice(0, 8)).join("  ") || "—"}</div>
    </div>
    ${m.body ? `<pre>${esc(m.body)}</pre>` : ""}`;
}

function collapseCommits(collapsed) {
  $("#commitPane").classList.toggle("collapsed", collapsed);
  document.querySelector(".hsplit").style.display = collapsed ? "none" : "";
}

// ---------------------------------------------------------------------------
// scope + file list
// ---------------------------------------------------------------------------
let scopeSeq = 0;
async function setScope(scope, name, keepCommits) {
  const seq = ++scopeSeq; // a slower earlier load must not clobber a newer one
  S.scope = scope;
  S.scopeName = name;
  S.selFile = null;
  S.perFile = new Map();
  S.segments = [];
  S.pinnedSeg = null; // a new scope can repeat a path; the old pin means nothing
  S.focus = null; // …and the line cursor was pointing into the old stream
  S.treePaths = null;
  $("#scopeChip").textContent = Scope.label(scope);
  if (!keepCommits) collapseCommits(scope.type !== "commit");
  sidebar();
  const { files } = await api("files", scopeParams(), { cached: true });
  if (seq !== scopeSeq) return;
  S.files = files;
  render();
  fetchStream(); // not awaited: each arrival repaints the stream it lands in
  // The File Tree pane is scope-specific and was just invalidated; without this
  // it stays empty until the reader happens to toggle tabs.
  if (S.tab === "tree") {
    await loadTree();
    if (seq !== scopeSeq) return; // a newer scope won while the tree was in flight
  }
  // The stream shows every selected file, so there is nothing to "open" — the
  // first path is only the cursor j/k and the viewed toggle start from.
  S.selFile = files.length ? files[0].path : null;
}

// ---------------------------------------------------------------------------
// file tree
// ---------------------------------------------------------------------------
function buildTree(paths, meta) {
  const root = { name: "", dir: true, children: new Map(), path: "" };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          dir: !isFile,
          children: new Map(),
          path: parts.slice(0, i + 1).join("/"),
        });
      }
      node = node.children.get(part);
      if (isFile && meta) node.meta = meta.get(p);
    });
  }
  return root;
}

/**
 * `apps/backend/src/services/core/routes/products.ts` costs six rows of tree to
 * show one file. Fold runs of single-child directories into one row so the pane
 * shows files instead of scaffolding.
 */
function compactDir(node) {
  let name = node.name;
  let cur = node;
  while (cur.children.size === 1) {
    const only = [...cur.children.values()][0];
    if (!only.dir) break;
    name += "/" + only.name;
    cur = only;
  }
  return { label: name, node: cur };
}

const STATUS_CODE = { modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", typechange: "T", untracked: "q" };

function renderFileTree() {
  const isTreeTab = S.tab === "tree";
  const paths = isTreeTab ? S.treePaths || [] : S.files.map((f) => f.path);
  const meta = new Map(S.files.map((f) => [f.path, f]));
  const filter = S.filter.toLowerCase();
  const box = $("#fileTree");

  const flat = filter || (S.listMode && !isTreeTab);
  if (flat) {
    const hits = (filter ? paths.filter((p) => p.toLowerCase().includes(filter)) : paths).slice(0, 800);
    box.innerHTML =
      hits.map((p) => fileRow(p, meta.get(p), 0, null)).join("") ||
      `<div class="empty-state">${filter ? "No match" : "No changes"}</div>`;
    return;
  }

  const root = buildTree(paths, meta);
  const out = [];
  const walk = (node, depth) => {
    const kids = [...node.children.values()].sort((a, b) =>
      a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1
    );
    for (const k of kids) {
      if (k.dir) {
        const { label, node: target } = compactDir(k);
        const open = isTreeTab ? S.treeOpen.has(target.path) : !S.treeOpen.has("!" + target.path);
        out.push(
          `<div class="tnode tdir" data-dir="${esc(target.path)}" style="padding-left:${6 + depth * 12}px" title="${esc(target.path)}">
            <span class="caret">${open ? "▾" : "▸"}</span>📁<span class="nm">${esc(label)}</span></div>`
        );
        if (open) walk(target, depth + 1);
      } else {
        out.push(fileRow(k.path, k.meta, depth, k.name));
      }
    }
  };
  walk(root, 0);
  box.innerHTML = out.join("") || `<div class="empty-state">No changes</div>`;
}

// Viewed state is per scope: the same path in the worktree and in a commit are
// different things to have read.
const viewKey = (path) => scopeId() + "|" + path;
const isViewed = (path) => S.viewed.has(viewKey(path));

function setViewed(path, on) {
  const k = viewKey(path);
  on ? S.viewed.add(k) : S.viewed.delete(k);
  changed();
}

/* Selection and collapse are per scope for the same reason viewed is, and they
   are stored as the *exceptions*: an empty `desel` means the whole review is in
   the stream, which is what a fresh scope should show. */
const isSelected = (path) => !S.desel.has(viewKey(path));
function setSelected(path, on) {
  const k = viewKey(path);
  on ? S.desel.delete(k) : S.desel.add(k);
  changed(); // render() → renderDiff() → buildItems() rebuilds the stream; no separate rebuild
  if (!on) refocusOutOf(path);
  if (on) fetchStream(); // a newly selected file may not be loaded yet
}
function selectAll(on) {
  for (const f of S.files) {
    const k = viewKey(f.path);
    on ? S.desel.delete(k) : S.desel.add(k);
  }
  changed();
  if (!on && S.focus) refocusOutOf(S.focus.file);
  if (on) fetchStream();
}
const isCollapsed = (path) => S.collapsed.has(viewKey(path));
function setCollapsed(path, on) {
  const k = viewKey(path);
  on ? S.collapsed.add(k) : S.collapsed.delete(k);
  // Folding a file away moves every segment after it, so the sticky header has
  // to be told; `rebuildStream` is the one path that keeps all of that in step.
  rebuildStream();
  if (on) refocusOutOf(path);
  saveDraft();
}

/**
 * The line cursor cannot stay in a file whose rows just left the stream — a
 * collapse or a deselect. `focusStep` would match nothing, fall back to row 0
 * and teleport the reader to the top of the stream on the next arrow key, which
 * is exactly the `v`-then-↓ flow. Re-anchor on the first row *after* where the
 * file was, which is where `v` is taking them anyway; if the file is gone
 * entirely (deselected, so there is no header left to measure from) there is no
 * honest place below it, so drop the cursor and let the next arrow start over.
 */
function refocusOutOf(path) {
  if (!S.focus || S.focus.file !== path) return;
  const seg = S.segments.find((s) => s.file === path);
  if (seg) {
    for (let i = seg.end; i < S.items.length; i++) {
      const l = S.items[i].k === "row" ? RM.rowLine(S.items[i]) : null;
      if (l) {
        S.focus = { file: S.items[i].f, side: l.side, line: l.line };
        return;
      }
    }
  }
  S.focus = null;
}

function renderProgress() {
  const total = S.files.length;
  const seen = S.files.filter((f) => isViewed(f.path)).length;
  const add = S.files.reduce((a, f) => a + (f.additions || 0), 0);
  const del = S.files.reduce((a, f) => a + (f.deletions || 0), 0);
  const bar = $("#progress");
  bar.hidden = !total;
  if (!total) {
    bar.innerHTML = "";
    return;
  }
  bar.innerHTML =
    `<span class="pfill" style="width:${Math.round((seen / total) * 100)}%"></span>` +
    `<span class="ptext">${seen}/${total} viewed` +
    ` <span class="a">+${add}</span> <span class="d">−${del}</span></span>`;
}

function syncViewedToggle() {
  const box = $("#chkViewed");
  if (box) box.checked = !!(S.selFile && isViewed(S.selFile));
}

/** Next file that has not been marked viewed, wrapping from the current one.
    Only selected files count: the v-loop walks the stream that is on screen. */
const nextUnviewed = () =>
  RM.nextUnviewed(
    S.files.map((f) => f.path).filter(isSelected),
    S.selFile,
    isViewed
  );

function fileRow(path, m, depth, label) {
  const sel = S.selFile === path ? " sel" : "";
  const code = m ? STATUS_CODE[m.status] || "M" : "";
  const n = S.ann.filter((a) => a.file === path).length;
  const seen = m && isViewed(path) ? " seen" : "";
  const stat = m
    ? `<span class="stat"><span class="a">+${m.additions}</span> <span class="d">−${m.deletions}</span></span>`
    : "";
  let name;
  if (label === null) {
    // The filename is the point; keep the last couple of directories for
    // disambiguation and drop the rest rather than letting a deep path push
    // the filename out of the pane. Full path stays in the tooltip.
    const parts = path.split("/");
    const file = parts.pop();
    const near = parts.slice(-2).join("/");
    const prefix = parts.length ? (parts.length > 2 ? "…/" : "") + near + "/" : "";
    name = `<span class="dir-prefix">${esc(prefix)}</span><b>${esc(file)}</b>`;
  } else {
    name = esc(label);
  }
  /* Only changed files can be in the stream, so only they get a checkbox — the
     File Tree tab lists the whole repo and has nothing to select. */
  const box =
    S.tab !== "tree" && m
      ? `<span class="selbox${isSelected(path) ? " on" : ""}" data-sel="${esc(path)}">${isSelected(path) ? "☑" : "☐"}</span>`
      : "";
  return `<div class="tnode${sel}${seen}" data-file="${esc(path)}" style="padding-left:${6 + depth * 12}px" title="${esc(path)}">
    <span class="caret">${seen ? "✓" : ""}</span>
    ${box}
    ${code ? `<span class="st ${code}">${code === "q" ? "?" : code}</span>` : "📄"}
    <span class="nm">${name}</span>
    ${n ? `<span class="cmt">🗨${n}</span>` : ""}
    ${stat}</div>`;
}

$("#fileTree").addEventListener("click", (e) => {
  const d = e.target.closest(".tnode[data-dir]");
  if (d) {
    const p = d.dataset.dir;
    if (S.tab === "tree") {
      S.treeOpen.has(p) ? S.treeOpen.delete(p) : S.treeOpen.add(p);
    } else {
      const k = "!" + p;
      S.treeOpen.has(k) ? S.treeOpen.delete(k) : S.treeOpen.add(k);
    }
    renderFileTree();
    return;
  }
  // The checkbox sits inside the file row, so it has to be answered first.
  const sb = e.target.closest(".selbox[data-sel]");
  if (sb) {
    setSelected(sb.dataset.sel, !isSelected(sb.dataset.sel));
    return;
  }
  const f = e.target.closest(".tnode[data-file]");
  if (f) scrollToFile(f.dataset.file);
});

/** all / none, wherever it is drawn: the file pane's header, or an empty stream. */
function selAllClick(e) {
  if (e.target.closest("[data-selall]")) return selectAll(true), true;
  if (e.target.closest("[data-selnone]")) return selectAll(false), true;
  return false;
}
document.querySelector(".filter-row").addEventListener("click", selAllClick);

function setListMode(on) {
  S.listMode = on;
  $("#segList").classList.toggle("active", on);
  $("#segTree").classList.toggle("active", !on);
  renderFileTree();
}
$("#segList").onclick = () => setListMode(true);
$("#segTree").onclick = () => setListMode(false);

$("#fileFilter").addEventListener("input", (e) => {
  S.filter = e.target.value;
  renderFileTree();
});

// ---------------------------------------------------------------------------
// diff loading + rendering
// ---------------------------------------------------------------------------
let streamSeq = 0;
/** Fetch every selected, not-yet-loaded file, a few at a time, in list order.
    Each arrival re-slots into the stream; the reader reads while it fills. */
async function fetchStream() {
  const seq = ++streamSeq;
  const queue = S.files.map((f) => f.path).filter((p) => isSelected(p) && !(S.perFile.get(p) || {}).loaded);
  const CONCURRENCY = 4;
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const path = queue[next++];
      /* No `full: "1"` here. The diff already arrives with full context, so
         "Full file" only has to stop folding — asking for the whole file as
         well would render every line while the checkbox read unchecked, and
         would make the empty/mode-only notes unreachable. Only the File Tree
         tab, which has no diff, fetches whole files. */
      const r = await api("diff", { ...scopeParams(), file: path }, { cached: true });
      if (seq !== streamSeq) return; // scope changed mid-flight
      const d = r.diff || {};
      S.perFile.set(path, {
        loaded: true,
        rows: d.rows || null,
        fullRows: null,
        expanded: new Set(),
        full: false,
        binary: d.binary,
        tooBig: d.tooBig,
        error: d.error,
        empty: d.empty,
        mode: d.mode,
      });
      rebuildStream();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/** Rebuild items from current per-file state and repaint, keeping scroll.
    `refresh`, not `paint`: paint keeps a stale empty state on screen and only
    reindexes when the item count changes. `refresh` never touches scrollTop. */
function rebuildStream() {
  buildItems();
  diffVL.refresh();
  renderProgress();
  revalidatePin(); // heights moved: the pin may no longer describe anything
  updateStickyHeader(true); // a file arriving can move both the top file and the count
}

/** Sidebar click / j/k target: make sure it's in the stream, then go there. */
function scrollToFile(path) {
  if (S.tab === "tree") return selectTreeFile(path);
  if (!isSelected(path)) return setSelected(path, true), scrollToFile(path);
  /* Nothing else guarantees the stream matches this tab: the File Tree branch
     of buildItems() clears the segments, setTab rebuilds nothing, and at boot
     renderDiff returns before buildItems while there is no selected file. An
     empty list here means stale state, not "no such file" — rebuild rather
     than swallow the click. */
  if (!S.segments.length) buildItems();
  const seg = S.segments.find((s) => s.file === path);
  if (!seg) return;
  S.selFile = path;
  // pad 0: the file's own header lands at the top, so the sticky bar agrees
  // with the row that was just clicked instead of naming the file above it.
  diffVL.scrollToIndex(seg.start, false, 0);
  pinAfterScroll(path);
  renderFileTree();
  syncViewedToggle();
  updateStickyHeader(true);
}

/* --- the header pin -------------------------------------------------------
   Every jump in this file can fall short of what it aimed at: the pane cannot
   scroll past total − clientHeight, so landing in the last file, when that file
   is shorter than the viewport, still leaves an earlier segment at the top.
   `topIndex()` would then name the wrong file, `updateStickyHeader` would
   overwrite the `S.selFile` the jump just set, and `v` would mark a file the
   reader never looked at. So whoever scrolled says which file they *meant*, and
   the header honors that pin until the reader scrolls for themselves — the
   scroll listener releases it the moment scrollTop moves off `pinExpectedTop`.
   Three rules keep it honest: only pin when the pane cannot do better
   (`pinHolds`), always repaint when the pin changes (`setPin`), and re-test it
   whenever heights move (`revalidatePin`). */

/** Does `file` still need a pin? Only when the pane is bottomed out — that is
    the one place a target cannot climb any higher. Anywhere else a jump that did
    not reach the top simply scrolled where it was asked to (centered, say), and
    the viewport is right. */
function pinHolds(file) {
  const body = $("#diffBody");
  const seg = file ? S.segments.find((s) => s.file === file) : null;
  const atEnd = body.scrollTop >= body.scrollHeight - body.clientHeight - 1;
  return !!seg && atEnd && segmentAt(diffVL.topIndex()) !== seg;
}

/** Set (or drop) the pin and repaint. The repaint is not optional: a jump that
    did not move `scrollTop` — the pane was already bottomed out — fires no
    scroll event, so nothing else would ever tell the header, and `v` would go
    on marking the file the viewport happens to start in. */
function setPin(file) {
  S.pinExpectedTop = $("#diffBody").scrollTop; // read back: the browser clamps it
  if (S.pinnedSeg === (file || null)) return;
  S.pinnedSeg = file || null;
  updateStickyHeader(true);
}

function pinAfterScroll(file) {
  setPin(pinHolds(file) ? file : null);
}

/** Heights moved under the pin — a late file arriving above the viewport, a fold
    opening — without any scroll event to release it, and the pinned file may now
    be off screen entirely. Re-run its own test rather than trust it. */
function revalidatePin() {
  if (!S.pinnedSeg) return;
  if (!pinHolds(S.pinnedSeg)) setPin(null);
  else S.pinExpectedTop = $("#diffBody").scrollTop; // reflow may have moved it
}

/** j/k: one file along, in the order the reader is actually looking at.
    In the stream that is the segment list — unselected files are not on screen,
    so walking `S.files` would step onto a file that has no header to land on.
    Where the walk starts is the file under the sticky bar, not `S.selFile`:
    they agree, but the viewport is the source of truth for "where am I". */
function stepFile(dir) {
  if (S.tab === "tree") {
    const files = S.treePaths || [];
    const next = files[files.indexOf(S.selFile) + dir];
    if (next) selectTreeFile(next);
    return;
  }
  const seg = currentSeg();
  // No segment yet (nothing scrolled, nothing selected): `j` opens at the top.
  const next = seg ? S.segments[S.segments.indexOf(seg) + dir] : dir > 0 ? S.segments[0] : null;
  if (next) scrollToFile(next.file);
}

/** File Tree tab: unchanged behavior — fetch whole file, show alone. */
async function selectTreeFile(path) {
  S.selFile = path;
  renderFileTree();
  const { full } = await api("file", { ...scopeParams(), file: path }, { cached: true });
  if (S.selFile !== path) return;
  S.treeRows = full && full.rows ? full.rows : null;
  S.treeDiff = full;
  renderDiff();
}

const annKey = RM.annKey;
const annIndex = () => RM.annIndex(S.ann);

/** Hand the current state to the review model and keep what it returns. */
function buildItems() {
  if (S.tab === "tree") {
    // File Tree keeps the old one-file view: whole file, no stream.
    const out = RM.buildItems({
      fullRows: S.treeRows,
      annotations: S.ann,
      file: S.selFile,
      expanded: new Set(),
      full: true,
      view: S.view,
    });
    S.items = out.items.map((it) => (it.k === "row" ? { ...it, v: out.effView, sg: out.singleGutter } : it));
    S.segments = [];
    sizePan(out.maxLineLen * S.charW + 24);
    return;
  }
  const out = RM.buildStream({
    files: S.files,
    selected: new Set(S.files.map((f) => f.path).filter(isSelected)),
    collapsed: new Set(S.files.map((f) => f.path).filter(isCollapsed)),
    perFile: S.perFile,
    annotations: S.ann,
    view: S.view,
    viewedSet: new Set(S.files.map((f) => f.path).filter(isViewed)),
  });
  S.items = out.items;
  S.segments = out.segments;
  sizePan(out.maxLineLen * S.charW + 24);
}

/** One scrollbar pans every `.txt` in lockstep — see `.side{overflow:hidden}`. */
function sizePan(contentW) {
  const body = $("#diffBody");
  const bar = $("#hscroll");
  /* Segments can mix split and unified, so there is no one effective view to
     read here. `S.view` is the *requested* view — close enough for a scrollbar
     bound, and a conservative gutter errs toward "more scrollable". */
  const gut = 96; // conservative: widest gutter any segment can have
  const visible = (body.clientWidth || 800) / (S.view === "split" ? 2 : 1) - gut;
  S.panMax = Math.max(0, contentW - visible);
  $("#hscrollInner").style.width = contentW + "px";
  bar.classList.toggle("off", S.panMax < 2);
  if (bar.scrollLeft > S.panMax) bar.scrollLeft = S.panMax;
  body.style.setProperty("--hx", -Math.min(bar.scrollLeft, S.panMax) + "px");
}

$("#hscroll").addEventListener(
  "scroll",
  () => $("#diffBody").style.setProperty("--hx", -$("#hscroll").scrollLeft + "px"),
  { passive: true }
);
// shift+wheel / trackpad horizontal gestures land on the diff body, not the bar
$("#diffBody").addEventListener(
  "wheel",
  (e) => {
    const dx = e.shiftKey ? e.deltaY : e.deltaX;
    if (Math.abs(dx) > Math.abs(e.shiftKey ? 0 : e.deltaY)) $("#hscroll").scrollLeft += dx;
  },
  { passive: true }
);

/* Card height is derived, never measured: wrapping is estimated from the pane
   width and the body is line-clamped to that estimate, so the prefix-sum index
   stays exact and nothing jumps while scrolling. The estimate itself lives in
   the review model — this is only the measurement it needs. */
const charsPerComment = () => ($("#diffBody").clientWidth - 150) / (S.uiCharW || 6.2);
const commentLines = (a) => RM.commentLines(a, charsPerComment());
const itemHeight = (i) => RM.itemHeight(S.items[i], charsPerComment());

/* Whitespace nobody can see is still a change. A CRLF line and its LF twin are
   the same glyphs, and so are two lines that differ only in the newline git
   reports as "\ No newline at end of file" — without these the reviewer is
   looking at red rows beside identical green ones with nothing to tell them
   apart. Only rows that carry the flag pay for it. */
const eolMark = (r) =>
  !r
    ? ""
    : (r.cr ? `<span class="eol" title="CRLF line ending">CR</span>` : "") +
      (r.nonl ? `<span class="eol" title="No newline at end of file">no newline</span>` : "");

/**
 * One entry per row kind. The pane started as code rows, then grew fold markers
 * and comment cards, and the if-chain had to be read top to bottom to find out
 * which kinds existed — a table names them, and a fourth kind is one entry.
 */
const ROW_HTML = {
  comment(item, top) {
    const a = item.a;
    const lines = commentLines(a);
    return `<div class="cmtcard" style="top:${top}px;height:${RM.itemHeight(item, charsPerComment())}px" data-cid="${a.id}">
      <div class="cc-head">
        <span class="lbl-pill${a.blocking ? " blocking" : ""}">${esc(a.label)}${a.blocking ? " · blocking" : ""}</span>
        <span class="cc-loc">${a.side === "old" ? "old " : ""}L${a.line}</span>
        <span class="grow"></span>
        <button class="cc-act" data-edit="${a.id}">edit</button>
        <button class="cc-act" data-del="${a.id}">delete</button>
      </div>
      <div class="cc-body" style="-webkit-line-clamp:${lines}">${esc(a.body)}${
        a.suggestion ? `<span class="cc-sug">↳ suggested: ${esc(a.suggestion.split("\n")[0])}</span>` : ""
      }</div>
    </div>`;
  },

  /* Fold ids repeat across the stream ("f12" exists in every file), so the
     marker has to name the file it belongs to or a click would expand the
     wrong one. */
  fold(item, top) {
    return `<div class="fold" style="top:${top}px" data-fold="${item.id}" data-file="${esc(item.f)}">
      <span>⌄</span> ${item.count} unmodified line${item.count === 1 ? "" : "s"} — click to expand</div>`;
  },

  /** The bar between two files: name, counts, position, collapse toggle. */
  fileHeader(item, top) {
    const s = item.stats || {};
    return `<div class="fsh${item.collapsed ? " closed" : ""}${item.viewed ? " seen" : ""}"
        style="top:${top}px" data-fhead="${esc(item.f)}" title="${esc(item.f)}">
      <span class="caret">${item.collapsed ? "▸" : "▾"}</span>
      <span class="fp">${esc(item.f)}</span>
      ${item.viewed ? `<span class="vchip">✓ viewed</span>` : ""}
      ${s.oldPath ? `<span class="old">← ${esc(s.oldPath)}</span>` : ""}
      <span class="grow"></span>
      <span class="pos">${item.idx + 1} of ${item.count}</span>
      <span class="plus">+${s.additions ?? 0}</span><span class="minus">−${s.deletions ?? 0}</span>
    </div>`;
  },

  /* A file whose diff is still in flight, and a file that has no diff to show
     (binary, too big, mode-only). Both are one fixed-height row, so the
     prefix-sum index is exact before the fetch lands and after it does. */
  loading(item, top) {
    return `<div class="fold" style="top:${top}px">Loading ${esc(item.f)}…</div>`;
  },

  note(item, top) {
    return `<div class="fold note" style="top:${top}px">${esc(item.text)}</div>`;
  },

  /* Every read below comes off the item, not off `S`: one stream mixes files,
     and a segment carries its own effective view, gutter shape and path. */
  row(item, top, index) {
    const u = item.u;
    const lang = extOf(item.f);
    const hit = S.search.hitSet && S.search.hitSet.has(index)
      ? S.search.hits[S.search.idx] === index ? " hit cur" : " hit"
      : "";
    const idx = S.annIdx;
    const foc = S.focus;

    const inFocusFile = !!foc && foc.file === item.f;

    const gutHtml = (side, num, cls) => {
      if (num == null) return `<div class="gut"></div>`;
      const n = idx.get(annKey(item.f, side, num));
      return `<div class="gut ${cls}${n ? " hasc" : ""}" data-file="${esc(item.f)}" data-side="${side}" data-line="${num}">
        <span class="plus">+</span>${num}${n ? `<span class="cmtbadge">${n}</span>` : ""}</div>`;
    };

    if ((item.v || "unified") === "unified") {
      const r = u.uni;
      if (r.t === "gap") return `<div class="fold" style="top:${top}px">⋯</div>`;
      const cls = r.t === "add" ? "add" : r.t === "del" ? "del" : "";
      const focused = inFocusFile && foc.line === (r.n ?? r.o) ? " focus" : "";
      const gutters = item.sg
        ? gutHtml("new", r.n ?? r.o ?? null, cls)
        : gutHtml("old", r.o ?? null, cls) + gutHtml("new", r.n ?? null, cls);
      return `<div class="drow${focused}${hit}" style="top:${top}px">
        <div class="side only">
          ${gutters}
          <div class="txt ${cls}"><span class="pan">${HL.highlight(r.s, lang)}${eolMark(r)}</span></div>
        </div></div>`;
    }

    if (u.t === "gap") return `<div class="fold" style="top:${top}px">⋯</div>`;
    const L = u.l;
    const R = u.r;
    let lh, rh;
    if (u.t === "chg" && L && R) [lh, rh] = HL.renderPair(L.s, R.s, lang);
    else {
      lh = L ? HL.highlight(L.s, lang) : null;
      rh = R ? HL.highlight(R.s, lang) : null;
    }
    const lcls = u.t === "chg" ? "del" : "";
    const rcls = u.t === "chg" ? "add" : "";
    const focL = inFocusFile && foc.side === "old" && L && foc.line === L.o ? " focus" : "";
    const focR = inFocusFile && foc.side === "new" && R && foc.line === R.n ? " focus" : "";
    return `<div class="drow${focL || focR}${hit}" style="top:${top}px">
      <div class="side">
        ${gutHtml("old", L ? L.o ?? null : null, lcls)}
        <div class="txt ${L ? lcls : "empty"}"><span class="pan">${lh ?? ""}${eolMark(L)}</span></div>
      </div>
      <div class="side">
        ${gutHtml("new", R ? R.n ?? null : null, rcls)}
        <div class="txt ${R ? rcls : "empty"}"><span class="pan">${rh ?? ""}${eolMark(R)}</span></div>
      </div>
    </div>`;
  },
};

const renderRowHtml = (item, top, index) =>
  item && ROW_HTML[item.k] ? ROW_HTML[item.k](item, top, index) : "";

const diffVL = vlist(
  $("#diffBody"),
  ROW,
  () => S.items.length,
  (i, top) => renderRowHtml(S.items[i], top, i),
  itemHeight
);

/**
 * The Changes tab is one stream: every selected file, back to back, each behind
 * its own header row. There is no "the file" for the pane to describe any more,
 * so the pane header is not written here — `updateStickyHeader` mirrors whatever
 * the viewport is inside, on every scroll tick. The File Tree tab still shows
 * one whole file and still owns its own header, below.
 */
function renderDiff() {
  S.annIdx = annIndex();
  const head = $("#diffHeader");
  if (S.tab === "tree") return renderTreeFile(head);

  if (!S.files.length) {
    head.innerHTML = "";
    head.dataset.file = "";
    S.items = [];
    S.segments = [];
    const base = S.ov.base && S.ov.base.ref;
    diffVL.setEmpty(
      S.scope.type === "worktree"
        ? `Working tree is clean — nothing uncommitted to review.<br><span class="hint">` +
          (base ? `Try <b>vs ${esc(base)}</b> for the whole branch, or ` : `Try `) +
          `<b>All Commits</b> to review a single commit.</span>`
        : `No changes in this scope.`
    );
    return;
  }

  buildItems();
  if (!S.items.length) {
    // Every file unchecked. That is a choice, not a failure — offer the way back.
    diffVL.setEmpty(`Nothing selected. <b data-selall>Select all</b> to fill the stream.`);
  } else if (S.search.q) {
    S.search.hitSet = null;
    runSearch(S.search.q, false);
  } else {
    diffVL.refresh();
  }
  /* Not only on scroll: at boot nothing has scrolled yet, and after a rebuild
     the position counter and the file at the top can both have moved. */
  revalidatePin();
  updateStickyHeader(true);
}

/** File Tree tab: one whole file, its own header, its own empty states. */
function renderTreeFile(head) {
  const path = S.selFile || "";
  head.dataset.file = ""; // the sticky header owns this on the other tab
  if (!path) {
    head.innerHTML = "";
    S.items = [];
    diffVL.setEmpty("Pick a file to read it.");
    return;
  }
  const f = S.files.find((x) => x.path === path);
  const parts = path.split("/");
  const name = parts.pop();
  const meta = S.treeDiff || {};

  // No position counter here: progress is about the review, not about browsing.
  head.innerHTML = `
    <span class="fp" title="${esc(path)}">${esc(parts.join("/"))}${parts.length ? "/" : ""}<b>${esc(name)}</b></span>
    ${f ? `<span class="plus">+${f.additions}</span><span class="minus">−${f.deletions}</span>` : ""}
    ${meta.mode ? `<span class="mode" title="file mode changed">${esc(meta.mode.old)} → ${esc(meta.mode.new)}</span>` : ""}
    ${f && f.oldPath ? `<span style="color:var(--muted)">← ${esc(f.oldPath)}</span>` : ""}
    <span class="grow"></span>
    <div class="nav"><button data-nav="prev" title="Previous change (p)">▲</button><button data-nav="next" title="Next change (n)">▼</button></div>`;

  const problem =
    meta.error
      ? `Could not read this file.<br><span class="hint">${esc(meta.error)}</span>`
      : meta.binary
      ? "Binary file — nothing to diff."
      : meta.tooBig
      ? `Diff is too large to render${meta.changed ? ` (${meta.changed.toLocaleString()} changed lines)` : ""}.` +
        `<br><span class="hint">Review it in your editor instead.</span>`
      : meta.empty && !(S.treeRows && S.treeRows.length)
      ? // A chmod has no content to show, and "Empty file." would be a lie.
        meta.mode
        ? `Mode changed — <b>${esc(meta.mode.old)} → ${esc(meta.mode.new)}</b>.` +
          `<br><span class="hint">No content changed.</span>`
        : f && f.status === "deleted"
        ? "File deleted — it was empty."
        : "Empty file."
      : null;
  if (problem) {
    S.items = [];
    diffVL.setEmpty(problem);
    return;
  }

  buildItems();
  if (S.search.q) {
    S.search.hitSet = null;
    runSearch(S.search.q, false);
    return;
  }
  diffVL.refresh();
}

/** Which file's segment the viewport starts inside. */
const segmentAt = (idx) => {
  let seg = null;
  for (const s of S.segments) {
    if (s.start <= idx) seg = s;
    else break;
  }
  return seg;
};

/** Which file the reader is on: the pin if one is set (see `scrollToFile`),
    otherwise whatever the viewport starts inside. A pin dies with the segment it
    names, so a rebuild that drops the file cannot leave the header stuck. */
function currentSeg() {
  const pinned = S.pinnedSeg ? S.segments.find((s) => s.file === S.pinnedSeg) : null;
  if (S.pinnedSeg && !pinned) S.pinnedSeg = null;
  return pinned || segmentAt(diffVL.topIndex());
}

/** The pane header mirrors the file the reader is on — GitHub's sticky bar. */
function updateStickyHeader(force) {
  if (S.tab === "tree") return; // tree tab: renderTreeFile owns the header
  const seg = currentSeg();
  const head = $("#diffHeader");
  if (!seg) {
    head.innerHTML = "";
    head.dataset.file = ""; // or the next scroll back into this file would find a match and skip
    return;
  }
  if (!force && head.dataset.file === seg.file) return; // cheap on every scroll tick
  head.dataset.file = seg.file;
  // "Full file" is per file now, so the box describes whichever one is on top.
  $("#chkFull").checked = !!(S.perFile.get(seg.file) || {}).full;
  if (S.selFile !== seg.file) {
    S.selFile = seg.file;
    renderFileTree(); // move the 'sel' highlight
    syncViewedToggle();
  }
  const f = S.files.find((x) => x.path === seg.file) || {};
  const i = S.segments.indexOf(seg);
  head.innerHTML = `
    <span class="fp" title="${esc(seg.file)}"><b>${esc(seg.file)}</b></span>
    <span class="plus">+${f.additions ?? 0}</span><span class="minus">−${f.deletions ?? 0}</span>
    <span class="grow"></span>
    <span class="pos">${i + 1} of ${S.segments.length}</span>
    <div class="nav"><button data-nav="prev" title="Previous change (p)">▲</button><button data-nav="next" title="Next change (n)">▼</button></div>`;
}
/* Bound, not passed by reference: the listener would hand the scroll event in
   as `force` and rewrite the header on every tick. */
$("#diffBody").addEventListener(
  "scroll",
  () => {
    /* Only a scroll the reader caused releases the pin. The programmatic scroll
       in `scrollToFile` recorded the position it left behind, so its own scroll
       event lands on the same scrollTop and is ignored. */
    if (S.pinnedSeg && $("#diffBody").scrollTop !== S.pinExpectedTop) S.pinnedSeg = null;
    updateStickyHeader();
  },
  { passive: true }
);

$("#diffBody").addEventListener("click", (e) => {
  // Clicking a file's header folds that file away — the stream's own accordion.
  const fh = e.target.closest(".fsh[data-fhead]");
  if (fh) {
    const p = fh.dataset.fhead;
    setCollapsed(p, !isCollapsed(p));
    return;
  }
  const fold = e.target.closest(".fold[data-fold]");
  if (fold) {
    // Fold state belongs to a file; the marker says which one it came from.
    const st = S.perFile.get(fold.dataset.file);
    if (!st) return;
    st.expanded.add(fold.dataset.fold);
    // Opening a fold grows the stream, which can invalidate a header pin — the
    // one rebuild path knows that; buildItems + refresh on their own did not.
    rebuildStream();
    return;
  }
  const del = e.target.closest("[data-del]");
  if (del) {
    S.ann = S.ann.filter((a) => a.id !== del.dataset.del);
    changed();
    return;
  }
  const edit = e.target.closest("[data-edit]");
  if (edit) {
    const a = S.ann.find((x) => x.id === edit.dataset.edit);
    if (a) openPopover(edit, a.file, a.side, a.line);
    return;
  }
  const gut = e.target.closest(".gut[data-line]");
  if (gut) {
    // The gutter names its own file: line numbers repeat down the stream.
    openPopover(gut, gut.dataset.file, gut.dataset.side, +gut.dataset.line);
    return;
  }
  // `setEmpty` writes its HTML inside #diffBody, so the empty stream's own
  // "Select all" lands here rather than on the file pane's copy.
  selAllClick(e);
});

$("#diffHeader").addEventListener("click", (e) => {
  const b = e.target.closest("[data-nav]");
  if (b) jumpChange(b.dataset.nav === "next" ? 1 : -1);
});

function jumpChange(dir) {
  // Rows are no longer uniform (headers, cards, notes), so scrollTop/ROW is not
  // an item index any more — the list knows which item the viewport starts on.
  /* Start from where the reader thinks they are: a pinned file's own header,
     not the segment the clamped scroll left at the top of the viewport. */
  const pinned = S.pinnedSeg ? currentSeg() : null;
  const from = pinned && pinned.file === S.pinnedSeg ? pinned.start : diffVL.topIndex();
  const i = RM.findChange(S.items, from, dir);
  if (i < 0) return;
  diffVL.scrollToIndex(i, true);
  pinAfterScroll(S.items[i] && S.items[i].f);
}

/* Windowing means only ~60 rows exist in the DOM, so the browser's own Find
   cannot see the file. Search has to be ours. */
function runSearch(q, jump = true) {
  S.search.q = q;
  const hits = RM.searchHits(S.items, q);
  const at = jump ? 0 : S.search.idx;
  S.search.hits = hits;
  S.search.hitSet = new Set(hits);
  // A repaint re-runs the search but must not move the reader: only a new query
  // or an explicit next/prev jumps.
  S.search.idx = Math.min(at, Math.max(0, hits.length - 1));
  $("#searchCount").textContent = hits.length ? `${S.search.idx + 1}/${hits.length}` : q ? "no matches" : "";
  if (jump && hits.length) {
    diffVL.scrollToIndex(hits[0], true);
    pinAfterScroll(S.items[hits[0]] && S.items[hits[0]].f);
  }
  diffVL.refresh();
}
function stepSearch(d) {
  const h = S.search.hits;
  if (!h.length) return;
  S.search.idx = (S.search.idx + d + h.length) % h.length;
  $("#searchCount").textContent = `${S.search.idx + 1}/${h.length}`;
  const at = h[S.search.idx];
  diffVL.scrollToIndex(at, true);
  pinAfterScroll(S.items[at] && S.items[at].f);
  diffVL.refresh();
}
function openSearch() {
  $("#searchBar").hidden = false;
  $("#searchInput").select();
  $("#searchInput").focus();
}
function closeSearch() {
  $("#searchBar").hidden = true;
  S.search = { q: "", hits: [], idx: 0 };
  diffVL.refresh();
  restoreFocus();
}
$("#searchInput").addEventListener("input", (e) => runSearch(e.target.value));
$("#searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    stepSearch(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    closeSearch();
  }
});
$("#searchNext").onclick = () => stepSearch(1);
$("#searchPrev").onclick = () => stepSearch(-1);
$("#searchClose").onclick = closeSearch;

/* A line cursor so a review can be driven without ever reaching for the mouse. */
function moveFocus(dir) {
  const next = RM.focusStep(S.items, S.focus, dir);
  if (!next) return;
  /* The row's own file, not `S.selFile`: stepping off the end of one file lands
     in the next one before the sticky header has caught up with the scroll. */
  S.focus = { file: S.items[next.index].f, side: next.side, line: next.line };
  diffVL.scrollToIndex(next.index, false);
  pinAfterScroll(S.focus.file); // the cursor's file owns the header, reachable or not
  diffVL.refresh();
}

/** Comment on the focused line, scrolling it into the DOM first if needed. */
function commentOnFocus() {
  if (!S.focus) {
    moveFocus(1);
    if (!S.focus) return;
  }
  /* Match the file too, everywhere: the stream has one gutter per file per line
     number, so line+side alone would comment on the first file that has them. */
  const find = () =>
    [...document.querySelectorAll(".gut[data-line]")].find(
      (x) =>
        x.dataset.file === S.focus.file && +x.dataset.line === S.focus.line && x.dataset.side === S.focus.side
    );
  let g = find();
  if (!g) {
    const i = RM.rowIndexFor(S.items, S.focus.side, S.focus.line, S.focus.file);
    if (i >= 0) {
      diffVL.scrollToIndex(i, true);
      pinAfterScroll(S.focus.file);
    }
    g = find();
  }
  if (g) openPopover(g, S.focus.file, S.focus.side, S.focus.line);
}

// ---------------------------------------------------------------------------
// tabs / view toggles
// ---------------------------------------------------------------------------
function setTab(tab) {
  S.tab = tab;
  // 12k paths are only navigable as a tree; a 50-file review is a list.
  setListMode(tab !== "tree");
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $("#commitDetail").hidden = tab !== "commit";
  $("#diffTools").style.visibility = tab === "commit" ? "hidden" : "visible";
  $("#chkViewed").parentElement.hidden = tab === "tree";
  if (tab === "tree" && !S.treePaths) loadTree();
  else renderFileTree();
}

/**
 * The whole repo at the current scope. Changing scope invalidates it, and the
 * guard lives here rather than at the two callers: `setTab` fires this without
 * awaiting it, so a scope change mid-flight would otherwise land one revision's
 * paths next to another revision's contents.
 */
async function loadTree() {
  const seq = scopeSeq;
  const { paths } = await api("tree", scopeParams(), { cached: true });
  if (seq !== scopeSeq) return;
  S.treePaths = paths;
  renderFileTree();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

$("#segSplit").onclick = () => setView("split");
$("#segUnified").onclick = () => setView("unified");
function setView(v) {
  S.view = v;
  $("#segSplit").classList.toggle("active", v === "split");
  $("#segUnified").classList.toggle("active", v === "unified");
  renderDiff();
}
$("#chkViewed").onchange = (e) => toggleViewed(e.target.checked);
function toggleViewed(on) {
  if (!S.selFile) return;
  setViewed(S.selFile, on);
  if (!on) return;
  setCollapsed(S.selFile, true); // GitHub's move: what you have read folds away
  const nx = nextUnviewed();
  if (nx) scrollToFile(nx);
}

/* "Full file" belongs to a file, not to the pane: the stream shows many files
   at once, so the box acts on whichever one the sticky header names and is
   re-read from that file's state on every header update. */
$("#chkFull").onchange = (e) => setFullOnCurrent(e.target.checked);
function setFullOnCurrent(on) {
  if (S.tab === "tree") {
    $("#chkFull").checked = true; // the tree tab only ever shows whole files
    return;
  }
  const st = S.selFile && S.perFile.get(S.selFile);
  if (!st || !st.loaded) {
    // Nothing has arrived to unfold yet — put the box back rather than lie.
    $("#chkFull").checked = false;
    return;
  }
  st.full = on;
  rebuildStream();
}

// ---------------------------------------------------------------------------
// annotations
// ---------------------------------------------------------------------------
/* Drafts live on the server, not in localStorage: localStorage is keyed to the
   origin including the port, and every run binds a new random port, so drafts
   written by one session were invisible to the next. */
let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    fetch("/api/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ann: S.ann,
        viewed: [...S.viewed],
        desel: [...S.desel],
        collapsed: [...S.collapsed],
      }),
    }).catch(() => {});
  }, 250);
}
function loadDraft() {
  const d = S.ov && S.ov.draft;
  if (!d) return;
  S.ann = d.ann || [];
  S.viewed = new Set(d.viewed || []);
  S.desel = new Set(d.desel || []);
  S.collapsed = new Set(d.collapsed || []);
}

function lineText(file, side, line) {
  const st = S.perFile.get(file);
  /* `S.treeRows` is only ever the File Tree tab's one open file — falling back
     to it from the stream would quote another file's line back at the reader. */
  const src = (st && (st.rows || st.fullRows)) || (S.tab === "tree" ? S.treeRows : null) || [];
  for (const r of src) {
    if (side === "new" && r.n === line && r.t !== "del") return r.s;
    if (side === "old" && r.o === line && r.t !== "add") return r.s;
  }
  return "";
}

function openPopover(anchor, file, side, line) {
  const existing = S.ann.find((a) => a.file === file && a.side === side && a.line === line);
  S.popFor = { file, side, line, id: existing ? existing.id : null };
  S.popLabel = existing ? existing.label : "suggestion";
  S.focus = { file, side, line };

  $("#popTitle").textContent = `Line ${line}`;
  $("#popCode").textContent = existing ? existing.code || "" : lineText(file, side, line);
  $("#popLabels").innerHTML = LABELS.map(
    (l) => `<button data-l="${l}" class="${l === S.popLabel ? "on" : ""}">${l}</button>`
  ).join("");
  $("#popBody").value = existing ? existing.body : "";
  $("#popBlocking").checked = existing ? !!existing.blocking : false;
  $("#popSug").value = existing ? existing.suggestion || "" : "";
  $("#popSug").hidden = !(existing && existing.suggestion);
  $("#popAddSug").hidden = !$("#popSug").hidden;
  $("#popDelete").hidden = !existing;

  const pop = $("#popover");
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = 430;
  let left = Math.min(r.left, window.innerWidth - w - 16);
  let top = r.bottom + 6;
  if (top + pop.offsetHeight > window.innerHeight - 10) top = Math.max(46, r.top - pop.offsetHeight - 6);
  pop.style.left = Math.max(8, left) + "px";
  pop.style.top = top + "px";
  $("#popBody").focus();
  renderDiff();
}

function closePopover() {
  $("#popover").hidden = true;
  S.popFor = null;
  restoreFocus();
}
$("#popClose").onclick = closePopover;
$("#popLabels").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-l]");
  if (!b) return;
  S.popLabel = b.dataset.l;
  [...$("#popLabels").children].forEach((c) => c.classList.toggle("on", c === b));
});
$("#popAddSug").onclick = () => {
  $("#popSug").hidden = false;
  $("#popAddSug").hidden = true;
  $("#popSug").value = $("#popCode").textContent;
  $("#popSug").focus();
};
$("#popDelete").onclick = () => {
  if (!S.popFor || !S.popFor.id) return;
  S.ann = S.ann.filter((a) => a.id !== S.popFor.id);
  changed();
  closePopover();
};
$("#popSave").onclick = savePopover;
function savePopover() {
  const p = S.popFor;
  if (!p) return;
  const body = $("#popBody").value.trim();
  const sug = $("#popSug").hidden ? "" : $("#popSug").value;
  if (!body && !sug) {
    closePopover();
    return;
  }
  const rec = {
    id: p.id || "a" + Date.now() + Math.random().toString(36).slice(2, 6),
    file: p.file,
    side: p.side,
    line: p.line,
    label: S.popLabel,
    blocking: $("#popBlocking").checked,
    body,
    suggestion: sug,
    code: $("#popCode").textContent,
    lang: extOf(p.file),
  };
  const i = S.ann.findIndex((a) => a.id === rec.id);
  if (i >= 0) S.ann[i] = rec;
  else S.ann.push(rec);
  changed();
  closePopover();
}

function renderCounts() {
  const n = S.ann.length;
  $("#cmtCount").textContent = n;
  $("#cmtCount").classList.toggle("zero", n === 0);
  $("#cpCount").textContent = n;
}

/**
 * Repaint every surface derived from `S`. Each mutation used to hand-pick its
 * own combination of these — `setViewed` called four, annotation edits called
 * five plus two inline count updates — so forgetting one left a stale comment
 * badge or progress bar with nothing to point at. One list, one place to fix.
 */
function render() {
  sidebar();
  renderFileTree();
  renderProgress();
  renderComments();
  renderCounts();
  syncViewedToggle();
  renderDiff();
}

/** Something the reviewer owns changed: persist it (debounced) and repaint. */
function changed() {
  saveDraft();
  render();
}

function renderComments() {
  $("#cpList").innerHTML =
    S.ann
      .map(
        (a) => `<div class="cp-item" data-id="${a.id}">
        <div class="loc">${esc(a.file)}:${a.line}</div>
        <div><span class="lbl-pill${a.blocking ? " blocking" : ""}">${a.label}${a.blocking ? " · blocking" : ""}</span></div>
        <div class="bd">${esc(a.body)}</div></div>`
      )
      .join("") || `<div class="empty-state">No comments yet.<br>Click a line number to add one.</div>`;
}
$("#cpList").addEventListener("click", async (e) => {
  const it = e.target.closest(".cp-item");
  if (!it) return;
  const a = S.ann.find((x) => x.id === it.dataset.id);
  if (!a) return;
  if (S.selFile !== a.file) {
    if (!S.files.some((f) => f.path === a.file)) setTab("tree");
    await scrollToFile(a.file);
  }
  // Line numbers repeat across a stream, so the file has to be part of the match.
  const target = RM.rowIndexFor(S.items, a.side, a.line, a.file);
  if (target >= 0) diffVL.scrollToIndex(target, true);
  S.focus = { file: a.file, side: a.side, line: a.line };
  renderDiff();
});
$("#btnComments").onclick = () => {
  $("#commentsPanel").hidden = !$("#commentsPanel").hidden;
};

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------
let pendingDecision = "annotated";
function openModal(decision) {
  pendingDecision = decision;
  $("#modalSummary").hidden = false;
  $("#modalConfirm").classList.remove("danger-btn");
  $("#modalConfirm").disabled = false;
  const n = S.ann.length;
  $("#modalTitle").textContent = decision === "approved" ? "Approve" : "Send feedback";
  const seen = S.files.filter((x) => isViewed(x.path)).length;
  const coverage = S.files.length ? ` You viewed ${seen} of ${S.files.length} files.` : "";
  $("#modalSub").textContent =
    decision === "approved"
      ? (n ? `Approving with ${n} comment${n === 1 ? "" : "s"} attached.` : "The agent will be told you approved and will proceed.") + coverage
      : n
      ? `${n} comment${n === 1 ? "" : "s"} will be sent to your agent session.` + coverage
      : "No line comments yet — write an overall summary below, or use Approve instead.";
  $("#modalConfirm").disabled = decision !== "approved" && !n && !$("#modalSummary").value.trim();
  $("#modalConfirm").textContent = decision === "approved" ? "Approve" : "Send to agent";
  $("#modalList").innerHTML = S.ann
    .map(
      (a) =>
        `<div class="mi"><div class="loc">${esc(a.file)}:${a.line}</div>
          <span class="lbl-pill${a.blocking ? " blocking" : ""}">${a.label}</span> ${esc(a.body.slice(0, 160))}</div>`
    )
    .join("");
  $("#modal").hidden = false;
  $("#modalSummary").focus();
}
function closeModal() {
  $("#modal").hidden = true;
  restoreFocus();
}
$("#modalSummary").addEventListener("input", () => {
  if (pendingDecision === "annotated") $("#modalConfirm").disabled = !S.ann.length && !$("#modalSummary").value.trim();
});
$("#btnSend").onclick = () => openModal("annotated");
$("#btnApprove").onclick = () => openModal("approved");
$("#modalCancel").onclick = closeModal;
$("#modalConfirm").onclick = () => submit(pendingDecision);
$("#btnClose").onclick = () => {
  if (S.ann.length && !confirmDiscard()) return;
  submit("dismissed");
};
/* Closing throws away every comment written so far and the agent hears nothing.
   Worth one interstitial rather than a silent loss. */
function confirmDiscard() {
  const n = S.ann.length;
  $("#modalTitle").textContent = "Discard " + n + " comment" + (n === 1 ? "" : "s") + "?";
  $("#modalSub").textContent =
    "Closing sends nothing to the agent. Use “Send feedback” if you want these delivered.";
  $("#modalConfirm").textContent = "Discard and close";
  $("#modalConfirm").classList.add("danger-btn");
  $("#modalSummary").hidden = true;
  $("#modalList").innerHTML = "";
  $("#modal").hidden = false;
  pendingDecision = "dismissed";
  return false;
}

async function submit(decision) {
  $("#modal").hidden = true;
  await fetch("/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      decision,
      summary: $("#modalSummary").value,
      annotations: decision === "dismissed" ? [] : S.ann,
      scope: S.scope,
    }),
  });
  $("#doneIcon").textContent = decision === "approved" ? "✓" : decision === "dismissed" ? "✕" : "→";
  $("#doneTitle").textContent =
    decision === "approved" ? "Changes approved" : decision === "dismissed" ? "Session closed" : "Feedback sent";
  $("#doneSub").textContent =
    decision === "dismissed" ? "No feedback was sent." : "Your agent has it. You can close this tab.";
  $("#done").hidden = false;
}

function closeHelp() {
  $("#helpSheet").hidden = true;
  restoreFocus();
}
$("#btnHelp").onclick = () => ($("#helpSheet").hidden = false);
$("#helpClose").onclick = closeHelp;

// ---------------------------------------------------------------------------
// splitters
// ---------------------------------------------------------------------------
document.querySelectorAll(".vsplit,.hsplit").forEach((sp) => {
  sp.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const target = document.getElementById(sp.dataset.target);
    const horiz = sp.classList.contains("vsplit");
    const start = horiz ? e.clientX : e.clientY;
    const base = horiz ? target.offsetWidth : target.offsetHeight;
    const move = (ev) => {
      const d = (horiz ? ev.clientX : ev.clientY) - start;
      const v = Math.max(120, base + d);
      if (horiz) target.style.width = v + "px";
      else target.style.height = v + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      diffVL.paint(true);
      commitVL.paint(true);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
});

// ---------------------------------------------------------------------------
// pane focus (ctrl + hjkl / arrows)
// ---------------------------------------------------------------------------
/* Focus lands on the scroller, not the pane wrapper, so the browser's own
   arrow/page/space scrolling works once a pane is active; the ring is drawn on
   the wrapper via :focus-within. */
const PANE_SCROLLER = {
  sidebar: "#sideScroll",
  commitPane: "#commitList",
  leftPane: "#fileTree",
  rightPane: "#diffBody",
  commentsPanel: "#cpList",
};
/* Keys double as directions: h=left, j=down, k=up, l=right. */
const PANE_NEIGHBOR = {
  sidebar: { l: "leftPane" },
  commitPane: { h: "sidebar", l: "commentsPanel", j: "leftPane" },
  leftPane: { h: "sidebar", l: "rightPane", k: "commitPane" },
  rightPane: { h: "leftPane", l: "commentsPanel", k: "commitPane" },
  commentsPanel: { h: "rightPane" },
};
const PANE_DIR = { h: "h", j: "j", k: "k", l: "l", ArrowLeft: "h", ArrowDown: "j", ArrowUp: "k", ArrowRight: "l" };

/** Which pane holds focus. Body-level focus counts as the diff, which is where
    the pre-existing line-cursor keys have always applied. */
function curPane() {
  return (
    Object.keys(PANE_NEIGHBOR).find((id) => document.getElementById(id).contains(document.activeElement)) || "rightPane"
  );
}
function movePane(dir) {
  let at = curPane();
  // A collapsed commit pane or a closed comments panel is walked through, not into.
  for (let hops = 0; hops < Object.keys(PANE_NEIGHBOR).length; hops++) {
    const nx = PANE_NEIGHBOR[at][dir];
    if (!nx) return;
    at = nx;
    if (document.getElementById(at).offsetParent) return $(PANE_SCROLLER[at]).focus();
  }
}

/* Anything that takes focus has to give it back. Hiding an overlay while the
   caret is still inside it leaves `document.activeElement` on a box nobody can
   see — and because that box is a textarea, the `typing` guard below then
   swallows every shortcut, so the ↑/↓/c review loop simply stops. Handing focus
   to the pane the reader was already in is the whole of the fix; every
   dismissal routes through here rather than each remembering separately. */
function restoreFocus() {
  $(PANE_SCROLLER[curPane()]).focus();
}

// ---------------------------------------------------------------------------
// keyboard
// ---------------------------------------------------------------------------
/* How to release each thing Escape can dismiss, in the order keys.js ranks
   them. The filter is not an overlay: letting go of it *is* the dismissal. */
const DISMISS = {
  popover: closePopover,
  searchBar: closeSearch,
  modal: closeModal,
  helpSheet: closeHelp,
  fileFilter: restoreFocus,
};
function dismiss() {
  const id = Keys.dismissTarget({
    popover: !$("#popover").hidden,
    searchBar: !$("#searchBar").hidden,
    modal: !$("#modal").hidden,
    helpSheet: !$("#helpSheet").hidden,
    fileFilter: document.activeElement === $("#fileFilter"),
  });
  if (id) DISMISS[id]();
}

document.addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA/.test(e.target.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (!$("#popover").hidden) savePopover();
    else if (!$("#modal").hidden) submit(pendingDecision);
    else openModal("annotated");
    return;
  }
  if (e.key === "Escape") {
    dismiss();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openSearch();
    return;
  }
  if (typing) return;
  // Not before the `typing` guard: ctrl+h/k are macOS text-editing bindings and
  // comment textareas need them more than pane switching does.
  if (e.ctrlKey && !e.metaKey && !e.altKey && PANE_DIR[e.key]) {
    e.preventDefault();
    movePane(PANE_DIR[e.key]);
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    // Outside the diff, arrows belong to the focused pane's own scrolling.
    if (curPane() !== "rightPane") return;
    e.preventDefault();
    moveFocus(e.key === "ArrowDown" ? 1 : -1);
    return;
  }
  /* Defaulted once, for whatever the table owns. Per-case was how `c` ended up
     opening the comment box and then typing a "c" into it. */
  const key = Keys.shortcut(e);
  if (!key) return;
  e.preventDefault();
  switch (key) {
    case "j":
      stepFile(1);
      break;
    case "k":
      stepFile(-1);
      break;
    case "n":
      jumpChange(1);
      break;
    case "p":
      jumpChange(-1);
      break;
    case "s":
      setView(S.view === "split" ? "unified" : "split");
      break;
    case "f":
      setFullOnCurrent(!$("#chkFull").checked);
      break;
    case "v":
      toggleViewed(!isViewed(S.selFile));
      break;
    case "t":
      $("#btnComments").click();
      break;
    case "?":
      $("#helpSheet").hidden = false;
      break;
    case "/":
      $("#fileFilter").focus();
      break;
    case "c":
      commentOnFocus();
      break;
  }
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(async function boot() {
  measureChar();
  S.ov = await api("overview");
  document.title = `${S.ov.name} — diffotator`;
  $("#repoName").textContent = S.ov.title || S.ov.name;
  $("#branchChip").textContent = "⑂ " + S.ov.branch;
  loadDraft();
  render();
  await loadCommits(false); // the initial scope below owns what gets shown
  await setScope({ type: "worktree" }, "Local Changes");
  if (!S.files.length && S.ov.base) {
    await setScope({ type: "range", base: S.ov.base.ref, head: "HEAD" }, "Branch");
  }
})();
