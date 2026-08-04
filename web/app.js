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
  diff: null, // {rows, binary, tooBig}
  fullRows: null,
  view: "split",
  full: false,
  tab: "changes",
  items: [],
  expanded: new Set(),
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
    scrollToIndex(i, center) {
      if (heightOf && (!offsets || offsets.length !== state.count() + 1)) reindex();
      const y = topOf(i);
      container.scrollTop = Math.max(0, center ? y - container.clientHeight / 2 : y - 60);
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
            `<div class="side-item" data-act="rev" data-rev="${esc(w.branch || "HEAD")}">
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
  S.diff = null;
  S.fullRows = null;
  S.treePaths = null;
  $("#scopeChip").textContent = Scope.label(scope);
  if (!keepCommits) collapseCommits(scope.type !== "commit");
  sidebar();
  const { files } = await api("files", scopeParams(), { cached: true });
  if (seq !== scopeSeq) return;
  S.files = files;
  render();
  // The File Tree pane is scope-specific and was just invalidated; without this
  // it stays empty until the reader happens to toggle tabs.
  if (S.tab === "tree") {
    await loadTree();
    if (seq !== scopeSeq) return; // a newer scope won while the tree was in flight
  }
  const first = files[0];
  if (first) selectFile(first.path);
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

/** Next file that has not been marked viewed, wrapping from the current one. */
const nextUnviewed = () =>
  RM.nextUnviewed(
    S.files.map((f) => f.path),
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
  return `<div class="tnode${sel}${seen}" data-file="${esc(path)}" style="padding-left:${6 + depth * 12}px" title="${esc(path)}">
    <span class="caret">${seen ? "✓" : ""}</span>
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
  const f = e.target.closest(".tnode[data-file]");
  if (f) selectFile(f.dataset.file);
});

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
let loadTimer = null;
async function selectFile(path) {
  S.selFile = path;
  S.expanded.clear();
  renderFileTree();
  syncViewedToggle();
  if (S.tab === "commit") setTab("changes");
  $("#diffBody").scrollTop = 0;
  // Most files land in well under 100ms; a spinner that fast reads as a flicker.
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    if (S.selFile === path && !S.diff && !S.fullRows) diffVL.setEmpty("Loading…");
  }, 150);

  S.diff = null;
  S.fullRows = null;
  if (S.tab === "tree") {
    const { full } = await api("file", { ...scopeParams(), file: path }, { cached: true });
    if (S.selFile !== path) return;
    clearTimeout(loadTimer);
    S.diff = null;
    S.fullRows = full && full.rows ? full.rows : null;
    S.fullMeta = full;
    renderDiff();
    return;
  }
  const r = await api("diff", { ...scopeParams(), file: path, full: "1" }, { cached: true });
  if (S.selFile !== path) return;
  clearTimeout(loadTimer);
  S.diff = r.diff;
  S.fullRows = r.full && r.full.rows ? r.full.rows : null;
  S.fullMeta = r.full;
  renderDiff();
  // warm the next file so j/k feels instant
  const i = S.files.findIndex((f) => f.path === path);
  const nx = S.files[i + 1];
  if (nx) api("diff", { ...scopeParams(), file: nx.path, full: "1" }, { cached: true });
}

const annKey = RM.annKey;
const annIndex = () => RM.annIndex(S.ann);

/** Hand the current state to the review model and keep what it returns. */
function buildItems() {
  const out = RM.buildItems({
    rows: S.diff && S.diff.rows,
    fullRows: S.fullRows,
    annotations: S.ann,
    file: S.selFile,
    expanded: S.expanded,
    full: S.full,
    view: S.view,
  });
  S.items = out.items;
  S.effView = out.effView;
  S.singleGutter = out.singleGutter;
  sizePan(out.maxLineLen * S.charW + 24);
}

/** One scrollbar pans every `.txt` in lockstep — see `.side{overflow:hidden}`. */
function sizePan(contentW) {
  const body = $("#diffBody");
  const bar = $("#hscroll");
  const gut = S.effView === "split" ? 48 : S.singleGutter ? 48 : 96;
  const visible = (body.clientWidth || 800) / (S.effView === "split" ? 2 : 1) - gut;
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

  fold(item, top) {
    return `<div class="fold" style="top:${top}px" data-fold="${item.id}">
      <span>⌄</span> ${item.count} unmodified line${item.count === 1 ? "" : "s"} — click to expand</div>`;
  },

  row(item, top, index) {
    const u = item.u;
    const lang = extOf(S.selFile);
    const hit = S.search.hitSet && S.search.hitSet.has(index)
      ? S.search.hits[S.search.idx] === index ? " hit cur" : " hit"
      : "";
    const idx = S.annIdx;
    const foc = S.focus;

    const gutHtml = (side, num, cls) => {
      if (num == null) return `<div class="gut"></div>`;
      const n = idx.get(annKey(S.selFile, side, num));
      return `<div class="gut ${cls}${n ? " hasc" : ""}" data-side="${side}" data-line="${num}">
        <span class="plus">+</span>${num}${n ? `<span class="cmtbadge">${n}</span>` : ""}</div>`;
    };

    if (S.effView === "unified") {
      const r = u.uni;
      if (r.t === "gap") return `<div class="fold" style="top:${top}px">⋯</div>`;
      const cls = r.t === "add" ? "add" : r.t === "del" ? "del" : "";
      const focused = foc && foc.line === (r.n ?? r.o) && foc.file === S.selFile ? " focus" : "";
      const gutters = S.singleGutter
        ? gutHtml("new", r.n ?? r.o ?? null, cls)
        : gutHtml("old", r.o ?? null, cls) + gutHtml("new", r.n ?? null, cls);
      return `<div class="drow${focused}${hit}" style="top:${top}px">
        <div class="side only">
          ${gutters}
          <div class="txt ${cls}"><span class="pan">${HL.highlight(r.s, lang)}</span></div>
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
    const focL = foc && foc.side === "old" && L && foc.line === L.o ? " focus" : "";
    const focR = foc && foc.side === "new" && R && foc.line === R.n ? " focus" : "";
    return `<div class="drow${focL || focR}${hit}" style="top:${top}px">
      <div class="side">
        ${gutHtml("old", L ? L.o ?? null : null, lcls)}
        <div class="txt ${L ? lcls : "empty"}"><span class="pan">${lh ?? ""}</span></div>
      </div>
      <div class="side">
        ${gutHtml("new", R ? R.n ?? null : null, rcls)}
        <div class="txt ${R ? rcls : "empty"}"><span class="pan">${rh ?? ""}</span></div>
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

function renderDiff() {
  S.annIdx = annIndex();
  const f = S.files.find((x) => x.path === S.selFile);
  const path = S.selFile || "";
  const parts = path.split("/");
  const name = parts.pop();
  const head = $("#diffHeader");

  if (!path) {
    head.innerHTML = "";
    S.items = [];
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

  head.innerHTML = `
    <span class="fp" title="${esc(path)}">${esc(parts.join("/"))}${parts.length ? "/" : ""}<b>${esc(name)}</b></span>
    ${f ? `<span class="plus">+${f.additions}</span><span class="minus">−${f.deletions}</span>` : ""}
    ${f && f.oldPath ? `<span style="color:var(--muted)">← ${esc(f.oldPath)}</span>` : ""}
    <span class="grow"></span>
    ${(() => {
      // Position is about progress through the review, so it only means
      // something in the changed-files list — not while browsing the repo.
      if (S.tab === "tree") return "";
      const i = S.files.findIndex((x) => x.path === path);
      return i >= 0 ? `<span class="pos">${i + 1} of ${S.files.length}</span>` : "";
    })()}
    <div class="nav"><button data-nav="prev" title="Previous change (p)">▲</button><button data-nav="next" title="Next change (n)">▼</button></div>`;

  const meta = S.diff || S.fullMeta || {};
  const alt = S.fullMeta || {};
  const problem =
    meta.error || alt.error
      ? `Could not read this file.<br><span class="hint">${esc(meta.error || alt.error)}</span>`
      : meta.binary || alt.binary
      ? "Binary file — nothing to diff."
      : meta.tooBig || alt.tooBig
      ? `Diff is too large to render${meta.changed ? ` (${meta.changed.toLocaleString()} changed lines)` : ""}.` +
        `<br><span class="hint">Review it in your editor instead.</span>`
      : meta.empty && !(S.fullRows && S.fullRows.length)
      ? f && f.status === "deleted"
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

$("#diffBody").addEventListener("click", (e) => {
  const fold = e.target.closest(".fold[data-fold]");
  if (fold) {
    S.expanded.add(fold.dataset.fold);
    buildItems();
    diffVL.refresh();
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
  if (gut) openPopover(gut, S.selFile, gut.dataset.side, +gut.dataset.line);
});

$("#diffHeader").addEventListener("click", (e) => {
  const b = e.target.closest("[data-nav]");
  if (b) jumpChange(b.dataset.nav === "next" ? 1 : -1);
});

function jumpChange(dir) {
  const cur = Math.floor($("#diffBody").scrollTop / ROW);
  const i = RM.findChange(S.items, cur, dir);
  if (i >= 0) diffVL.scrollToIndex(i, true);
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
  if (jump && hits.length) diffVL.scrollToIndex(hits[0], true);
  diffVL.refresh();
}
function stepSearch(d) {
  const h = S.search.hits;
  if (!h.length) return;
  S.search.idx = (S.search.idx + d + h.length) % h.length;
  $("#searchCount").textContent = `${S.search.idx + 1}/${h.length}`;
  diffVL.scrollToIndex(h[S.search.idx], true);
  diffVL.refresh();
}
function openSearch() {
  $("#searchBar").hidden = false;
  $("#searchInput").select();
  $("#searchInput").focus();
}
function closeSearch() {
  const pane = curPane();
  $("#searchBar").hidden = true;
  S.search = { q: "", hits: [], idx: 0 };
  diffVL.refresh();
  restoreFocus(pane);
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
  S.focus = { file: S.selFile, side: next.side, line: next.line };
  diffVL.scrollToIndex(next.index, false);
  diffVL.refresh();
}

/** Comment on the focused line, scrolling it into the DOM first if needed. */
function commentOnFocus() {
  if (!S.focus) {
    moveFocus(1);
    if (!S.focus) return;
  }
  const find = () =>
    [...document.querySelectorAll(".gut[data-line]")].find(
      (x) => +x.dataset.line === S.focus.line && x.dataset.side === S.focus.side
    );
  let g = find();
  if (!g) {
    const i = RM.rowIndexFor(S.items, S.focus.side, S.focus.line);
    if (i >= 0) diffVL.scrollToIndex(i, true);
    g = find();
  }
  if (g) openPopover(g, S.selFile, S.focus.side, S.focus.line);
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
  const nx = nextUnviewed();
  if (nx) selectFile(nx);
}

$("#chkFull").onchange = (e) => {
  S.full = e.target.checked;
  renderDiff();
};

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
      body: JSON.stringify({ ann: S.ann, viewed: [...S.viewed] }),
    }).catch(() => {});
  }, 250);
}
function loadDraft() {
  const d = S.ov && S.ov.draft;
  if (!d) return;
  S.ann = d.ann || [];
  S.viewed = new Set(d.viewed || []);
}

function lineText(file, side, line) {
  const src = (S.diff && S.diff.rows) || S.fullRows || [];
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
  const pane = curPane();
  $("#popover").hidden = true;
  S.popFor = null;
  restoreFocus(pane);
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
    await selectFile(a.file);
  }
  const target = RM.rowIndexFor(S.items, a.side, a.line);
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
  const pane = curPane();
  $("#modal").hidden = true;
  restoreFocus(pane);
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
  const pane = curPane();
  $("#helpSheet").hidden = true;
  restoreFocus(pane);
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
   dismissal routes through here rather than each remembering separately.

   Take the pane *before* hiding anything: hiding a focused element blurs it, so
   by the time this runs `document.activeElement` is usually `<body>`, which is in
   no pane at all. It landed on the diff anyway, but only via `curPane()`'s
   fallback — right answer, no idea why. Callers that hide something pass the pane
   they read first; the file filter, which hides nothing, can still ask. */
function restoreFocus(pane) {
  $(PANE_SCROLLER[pane || curPane()]).focus();
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
  const files = S.tab === "tree" ? S.treePaths || [] : S.files.map((f) => f.path);
  const i = files.indexOf(S.selFile);
  switch (key) {
    case "j":
      if (i < files.length - 1) selectFile(files[i + 1]);
      break;
    case "k":
      if (i > 0) selectFile(files[i - 1]);
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
      $("#chkFull").checked = !$("#chkFull").checked;
      $("#chkFull").onchange({ target: $("#chkFull") });
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
