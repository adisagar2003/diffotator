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

const LABELS = ["suggestion", "nit", "question", "issue", "praise", "thought", "note", "todo", "chore"];
const LANE_COLORS = ["#e5484d", "#f5a524", "#46a758", "#3e9dd6", "#a97bd6", "#e07ba8", "#5eead4", "#f0c674"];
const CONTEXT = 3;
const ROW = 20;
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
  focus: null,
  treePaths: null,
  treeOpen: new Set(),
  fileOpen: new Set(),
  filter: "",
  charW: 7.5,
  popFor: null,
  popLabel: "suggestion",
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
function scopeParams() {
  const s = S.scope;
  if (s.type === "commit") return { scope: "commit", sha: s.sha };
  if (s.type === "range") return { scope: "range", base: s.base, head: s.head };
  return { scope: "worktree" };
}

// ---------------------------------------------------------------------------
// virtual list
// ---------------------------------------------------------------------------
function vlist(container, rowH, count, renderRow) {
  const spacer = container.querySelector(".vspacer");
  const rows = container.querySelector(".vrows");
  let win = [-1, -1];
  const state = { count, rowH };
  function paint(force) {
    const n = state.count();
    spacer.style.height = n * state.rowH + "px";
    const st = container.scrollTop;
    const h = container.clientHeight || 400;
    const from = Math.max(0, Math.floor(st / state.rowH) - 10);
    const to = Math.min(n, Math.ceil((st + h) / state.rowH) + 10);
    if (!force && from === win[0] && to === win[1]) return;
    win = [from, to];
    let html = "";
    for (let i = from; i < to; i++) html += renderRow(i, i * state.rowH);
    rows.innerHTML = html;
  }
  container.addEventListener("scroll", () => paint(false), { passive: true });
  new ResizeObserver(() => paint(true)).observe(container);
  return {
    refresh: () => {
      win = [-1, -1];
      paint(true);
    },
    paint,
    state,
    /* Empty states go INSIDE .vrows — replacing the container's children would
       orphan the spacer/rows nodes this closure holds. */
    setEmpty(html) {
      win = [-1, -1];
      spacer.style.height = "0px";
      rows.innerHTML = `<div class="empty-state">${html}</div>`;
    },
    scrollToIndex(i, center) {
      const target = center
        ? i * state.rowH - container.clientHeight / 2
        : i * state.rowH - 60;
      container.scrollTop = Math.max(0, target);
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
  const s = document.createElement("span");
  s.style.cssText = "position:absolute;visibility:hidden;font:12.5px/20px var(--mono);white-space:pre";
  s.textContent = "0".repeat(100);
  document.body.appendChild(s);
  S.charW = s.getBoundingClientRect().width / 100 || 7.5;
  s.remove();
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
  const lanes = [];
  const res = [];
  let maxLanes = 1;
  const free = (arr) => {
    const i = arr.indexOf(null);
    return i < 0 ? arr.length : i;
  };
  for (const c of commits) {
    const incoming = lanes.slice();
    let lane = incoming.indexOf(c.sha);
    if (lane < 0) {
      lane = free(lanes);
      if (lane === lanes.length) lanes.push(null);
    }
    lanes[lane] = c.parents[0] || null;
    const merges = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && incoming[i] === c.sha) {
        merges.push(i);
        lanes[i] = null;
      }
    }
    const branches = [];
    for (const p of c.parents.slice(1)) {
      let l = lanes.indexOf(p);
      if (l < 0) {
        l = free(lanes);
        if (l === lanes.length) lanes.push(null);
        lanes[l] = p;
      }
      branches.push(l);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const outgoing = lanes.slice();
    maxLanes = Math.max(maxLanes, incoming.length, outgoing.length, lane + 1);
    res.push({ lane, incoming, outgoing, merges, branches });
  }
  S.maxLanes = Math.min(maxLanes, 12);
  return res;
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

async function loadCommits(select = true) {
  const { commits } = await api("commits", {
    limit: 400,
    ...(S.commitRev ? { rev: S.commitRev } : {}),
  });
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
  $("#scopeChip").textContent =
    scope.type === "worktree"
      ? "working tree vs HEAD"
      : scope.type === "range"
      ? `${scope.base}...HEAD`
      : `commit ${String(scope.sha).slice(0, 8)}`;
  if (!keepCommits) collapseCommits(scope.type !== "commit");
  sidebar();
  const { files } = await api("files", scopeParams(), { cached: true });
  if (seq !== scopeSeq) return;
  S.files = files;
  renderFileTree();
  sidebar();
  const first = files[0];
  if (first) selectFile(first.path);
  else {
    S.diff = null;
    renderDiff();
  }
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
  // collapse single-child directory chains the way Fork does not — keep full
  // nesting so paths stay recognisable.
  return root;
}

const STATUS_CODE = { modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", typechange: "T", untracked: "q" };

function renderFileTree() {
  const isTreeTab = S.tab === "tree";
  const paths = isTreeTab ? S.treePaths || [] : S.files.map((f) => f.path);
  const meta = new Map(S.files.map((f) => [f.path, f]));
  const filter = S.filter.toLowerCase();
  const box = $("#fileTree");

  if (filter) {
    const hits = paths.filter((p) => p.toLowerCase().includes(filter)).slice(0, 500);
    box.innerHTML =
      hits
        .map((p) => fileRow(p, meta.get(p), 0, p))
        .join("") || `<div class="empty-state">No match</div>`;
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
        const open = isTreeTab ? S.treeOpen.has(k.path) : !S.treeOpen.has("!" + k.path);
        out.push(
          `<div class="tnode tdir" data-dir="${esc(k.path)}" style="padding-left:${6 + depth * 12}px">
            <span class="caret">${open ? "▾" : "▸"}</span>📁<span class="nm">${esc(k.name)}</span></div>`
        );
        if (open) walk(k, depth + 1);
      } else {
        out.push(fileRow(k.path, k.meta, depth, k.name));
      }
    }
  };
  walk(root, 0);
  box.innerHTML = out.join("") || `<div class="empty-state">No changes</div>`;
}

function fileRow(path, m, depth, label) {
  const sel = S.selFile === path ? " sel" : "";
  const code = m ? STATUS_CODE[m.status] || "M" : "";
  const n = S.ann.filter((a) => a.file === path).length;
  const stat = m
    ? `<span class="stat"><span class="a">+${m.additions}</span> <span class="d">−${m.deletions}</span></span>`
    : "";
  return `<div class="tnode${sel}" data-file="${esc(path)}" style="padding-left:${6 + depth * 12}px" title="${esc(path)}">
    <span class="caret"></span>
    ${code ? `<span class="st ${code}">${code === "q" ? "?" : code}</span>` : "📄"}
    <span class="nm">${esc(label)}</span>
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

$("#fileFilter").addEventListener("input", (e) => {
  S.filter = e.target.value;
  renderFileTree();
});

// ---------------------------------------------------------------------------
// diff loading + rendering
// ---------------------------------------------------------------------------
async function selectFile(path) {
  S.selFile = path;
  S.expanded.clear();
  renderFileTree();
  if (S.tab === "commit") setTab("changes");
  $("#diffBody").scrollTop = 0;

  if (S.tab === "tree") {
    const { full } = await api("file", { ...scopeParams(), file: path }, { cached: true });
    if (S.selFile !== path) return;
    S.diff = null;
    S.fullRows = full && full.rows ? full.rows : null;
    S.fullMeta = full;
    renderDiff();
    return;
  }
  const r = await api("diff", { ...scopeParams(), file: path, full: "1" }, { cached: true });
  if (S.selFile !== path) return;
  S.diff = r.diff;
  S.fullRows = r.full && r.full.rows ? r.full.rows : null;
  S.fullMeta = r.full;
  renderDiff();
  // warm the next file so j/k feels instant
  const i = S.files.findIndex((f) => f.path === path);
  const nx = S.files[i + 1];
  if (nx) api("diff", { ...scopeParams(), file: nx.path, full: "1" }, { cached: true });
}

/** Pair a unified row stream into left/right columns for split view. */
function toSplit(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.t === "ctx" || r.t === "gap") {
      out.push({ t: r.t, l: r, r: r });
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < rows.length && rows[i].t === "del") dels.push(rows[i++]);
    while (i < rows.length && rows[i].t === "add") adds.push(rows[i++]);
    if (!dels.length && !adds.length) {
      i++;
      continue;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) out.push({ t: "chg", l: dels[k] || null, r: adds[k] || null });
  }
  return out;
}

function annKey(file, side, line) {
  return `${file}|${side}|${line}`;
}
function annIndex() {
  const m = new Map();
  for (const a of S.ann) {
    const k = annKey(a.file, a.side, a.line);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function buildItems() {
  // The diff is fetched with full context already, so "Full file" only has to
  // stop folding — swapping in plain content would throw away the add/del marks.
  const haveDiff = !!(S.diff && S.diff.rows && S.diff.rows.length);
  const src = haveDiff ? S.diff.rows : S.fullRows || [];
  const noFold = S.full || !haveDiff;
  // Split only earns its keep when both columns differ. A pure add, a pure
  // delete, or an unchanged file browsed from the File Tree would otherwise
  // burn half the pane on hatching or on a duplicate of itself.
  const hasAdd = src.some((r) => r.t === "add");
  const hasDel = src.some((r) => r.t === "del");
  S.singleGutter = !hasAdd && !hasDel;
  S.effView = S.view === "split" && hasAdd && hasDel ? "split" : "unified";
  const units = S.effView === "split" ? toSplit(src) : src.map((r) => ({ t: r.t, l: r, r: r, uni: r }));
  const idx = annIndex();

  const interesting = new Array(units.length).fill(false);
  if (!noFold) {
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const t = u.t;
      if (t !== "ctx" && t !== "gap") interesting[i] = true;
      const ln = u.r && u.r.n;
      if (ln && idx.has(annKey(S.selFile, "new", ln))) interesting[i] = true;
      const lo = u.l && u.l.o;
      if (lo && idx.has(annKey(S.selFile, "old", lo))) interesting[i] = true;
    }
  }

  const keep = new Array(units.length).fill(noFold);
  if (!noFold) {
    for (let i = 0; i < units.length; i++) {
      if (!interesting[i]) continue;
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(units.length - 1, i + CONTEXT); k++) keep[k] = true;
    }
  }

  const items = [];
  let i = 0;
  while (i < units.length) {
    if (keep[i]) {
      items.push({ k: "row", u: units[i], i });
      i++;
      continue;
    }
    const start = i;
    while (i < units.length && !keep[i]) i++;
    const id = "f" + start;
    if (S.expanded.has(id)) {
      for (let j = start; j < i; j++) items.push({ k: "row", u: units[j], i: j });
    } else {
      items.push({ k: "fold", id, count: i - start, from: start, to: i });
    }
  }
  S.items = items;

  // Widest line decides how far the shared pan scrollbar can travel.
  let maxLen = 0;
  for (const r of src) if (r.s && r.s.length > maxLen) maxLen = Math.min(r.s.length, 4000);
  sizePan(maxLen * S.charW + 24);
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

function renderRowHtml(item, top) {
  if (item.k === "fold") {
    return `<div class="fold" style="top:${top}px" data-fold="${item.id}">
      <span>⌄</span> ${item.count} unmodified line${item.count === 1 ? "" : "s"} — click to expand</div>`;
  }
  const u = item.u;
  const lang = extOf(S.selFile);
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
    return `<div class="drow${focused}" style="top:${top}px">
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
  return `<div class="drow${focL || focR}" style="top:${top}px">
    <div class="side">
      ${gutHtml("old", L ? L.o ?? null : null, lcls)}
      <div class="txt ${L ? lcls : "empty"}"><span class="pan">${lh ?? ""}</span></div>
    </div>
    <div class="side">
      ${gutHtml("new", R ? R.n ?? null : null, rcls)}
      <div class="txt ${R ? rcls : "empty"}"><span class="pan">${rh ?? ""}</span></div>
    </div>
  </div>`;
}

const diffVL = vlist($("#diffBody"), ROW, () => S.items.length, (i, top) => renderRowHtml(S.items[i], top));

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
    diffVL.setEmpty("Nothing to show.");
    return;
  }

  head.innerHTML = `
    <span class="fp" title="${esc(path)}">${esc(parts.join("/"))}${parts.length ? "/" : ""}<b>${esc(name)}</b></span>
    ${f ? `<span class="plus">+${f.additions}</span><span class="minus">−${f.deletions}</span>` : ""}
    ${f && f.oldPath ? `<span style="color:var(--muted)">← ${esc(f.oldPath)}</span>` : ""}
    <span class="grow"></span>
    <div class="nav"><button data-nav="prev" title="Previous change (p)">▲</button><button data-nav="next" title="Next change (n)">▼</button></div>`;

  const bad =
    (S.diff && (S.diff.binary || S.diff.tooBig)) || (S.fullMeta && (S.fullMeta.binary || S.fullMeta.tooBig));
  if (bad) {
    S.items = [];
    diffVL.setEmpty(S.diff && S.diff.binary ? "Binary file" : "File too large to display");
    return;
  }

  buildItems();
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
  const gut = e.target.closest(".gut[data-line]");
  if (gut) openPopover(gut, S.selFile, gut.dataset.side, +gut.dataset.line);
});

$("#diffHeader").addEventListener("click", (e) => {
  const b = e.target.closest("[data-nav]");
  if (b) jumpChange(b.dataset.nav === "next" ? 1 : -1);
});

function jumpChange(dir) {
  const box = $("#diffBody");
  const cur = Math.floor(box.scrollTop / ROW);
  const isChange = (it) => it.k === "row" && it.u.t !== "ctx" && it.u.t !== "gap";
  if (dir > 0) {
    // skip past the current contiguous change block first
    let i = cur;
    while (i < S.items.length && isChange(S.items[i])) i++;
    while (i < S.items.length && !isChange(S.items[i])) i++;
    if (i < S.items.length) diffVL.scrollToIndex(i, true);
  } else {
    let i = Math.max(0, cur - 1);
    while (i >= 0 && isChange(S.items[i])) i--;
    while (i >= 0 && !isChange(S.items[i])) i--;
    while (i > 0 && isChange(S.items[i - 1])) i--;
    if (i >= 0) diffVL.scrollToIndex(i, true);
  }
}

// ---------------------------------------------------------------------------
// tabs / view toggles
// ---------------------------------------------------------------------------
function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $("#commitDetail").hidden = tab !== "commit";
  $("#diffTools").style.visibility = tab === "commit" ? "hidden" : "visible";
  if (tab === "tree" && !S.treePaths) {
    api("tree", scopeParams(), { cached: true }).then(({ paths }) => {
      S.treePaths = paths;
      renderFileTree();
    });
  } else {
    renderFileTree();
  }
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
$("#chkFull").onchange = (e) => {
  S.full = e.target.checked;
  renderDiff();
};

// ---------------------------------------------------------------------------
// annotations
// ---------------------------------------------------------------------------
const DRAFT_KEY = () => "diffotator:" + (S.ov ? S.ov.root : "");
function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY(), JSON.stringify(S.ann));
  } catch {}
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY());
    if (raw) S.ann = JSON.parse(raw) || [];
  } catch {}
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
  $("#popover").hidden = true;
  S.popFor = null;
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
  afterAnnChange();
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
  afterAnnChange();
  closePopover();
}

function afterAnnChange() {
  saveDraft();
  const n = S.ann.length;
  $("#cmtCount").textContent = n;
  $("#cmtCount").classList.toggle("zero", n === 0);
  $("#cpCount").textContent = n;
  renderComments();
  renderFileTree();
  renderDiff();
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
  const target = S.items.findIndex(
    (x) => x.k === "row" && ((a.side === "new" && x.u.r && x.u.r.n === a.line) || (a.side === "old" && x.u.l && x.u.l.o === a.line))
  );
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
  const n = S.ann.length;
  $("#modalTitle").textContent = decision === "approved" ? "Approve" : "Send feedback";
  $("#modalSub").textContent =
    decision === "approved"
      ? n
        ? `Approving with ${n} comment${n === 1 ? "" : "s"} attached.`
        : "The agent will be told you approved and will proceed."
      : `${n} comment${n === 1 ? "" : "s"} will be sent to your agent session.`;
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
$("#btnSend").onclick = () => openModal("annotated");
$("#btnApprove").onclick = () => openModal("approved");
$("#modalCancel").onclick = () => ($("#modal").hidden = true);
$("#modalConfirm").onclick = () => submit(pendingDecision);
$("#btnClose").onclick = () => submit("dismissed");

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
  try {
    localStorage.removeItem(DRAFT_KEY());
  } catch {}
  $("#doneIcon").textContent = decision === "approved" ? "✓" : decision === "dismissed" ? "✕" : "→";
  $("#doneTitle").textContent =
    decision === "approved" ? "Changes approved" : decision === "dismissed" ? "Session closed" : "Feedback sent";
  $("#doneSub").textContent =
    decision === "dismissed" ? "No feedback was sent." : "Your agent has it. You can close this tab.";
  $("#done").hidden = false;
}

$("#btnHelp").onclick = () => ($("#helpSheet").hidden = false);
$("#helpClose").onclick = () => ($("#helpSheet").hidden = true);

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
// keyboard
// ---------------------------------------------------------------------------
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
    if (!$("#popover").hidden) return closePopover();
    if (!$("#modal").hidden) return ($("#modal").hidden = true);
    if (!$("#helpSheet").hidden) return ($("#helpSheet").hidden = true);
    return;
  }
  if (typing) return;
  const files = S.tab === "tree" ? S.treePaths || [] : S.files.map((f) => f.path);
  const i = files.indexOf(S.selFile);
  switch (e.key) {
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
    case "t":
      $("#btnComments").click();
      break;
    case "?":
      $("#helpSheet").hidden = false;
      break;
    case "/":
      e.preventDefault();
      $("#fileFilter").focus();
      break;
    case "c": {
      if (!S.focus) break;
      const g = [...document.querySelectorAll(".gut[data-line]")].find(
        (x) => +x.dataset.line === S.focus.line && x.dataset.side === S.focus.side
      );
      if (g) openPopover(g, S.selFile, S.focus.side, S.focus.line);
      break;
    }
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
  afterAnnChange();
  sidebar();
  await loadCommits(false); // the initial scope below owns what gets shown
  await setScope({ type: "worktree" }, "Local Changes");
  if (!S.files.length && S.ov.base) {
    await setScope({ type: "range", base: S.ov.base.ref, head: "HEAD" }, "Branch");
  }
})();
