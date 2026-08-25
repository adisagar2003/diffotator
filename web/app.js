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
  localCount: null, // working-tree changes, kept across scopes for the sidebar badge
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
  pendingFocusFile: null,
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
  tl: null, // commit timeline: { base, head, commits, sel, mode } while the scope family is a range
  commitMeta: null, // banner metadata for the current commit scope; tags comments with their commit
  ignoreWs: false, // `git diff -w`: a reindent should not read as a rewrite
};

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------
const cache = new Map();
const apiUrl = (path, params) => `/api/${path}?${new URLSearchParams(params)}`;
async function api(path, params = {}, { cached = false } = {}) {
  const url = apiUrl(path, params);
  if (cached && cache.has(url)) return cache.get(url);
  const p = fetch(url).then(async (r) => {
    const body = await r.json();
    if (!r.ok) throw new Error((body && body.error) || `request failed (${r.status})`);
    return body;
  });
  if (cached) {
    cache.set(url, p);
    p.catch(() => cache.delete(url)); // a failure must not be replayed from cache
  }
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
    /** Which item sits at the viewport's middle — where a centered jump put the
        reader's eye. The change counter anchors here, not at the top edge. */
    midIndex: () => {
      if (heightOf && (!offsets || offsets.length !== state.count() + 1)) reindex();
      return Math.max(0, Math.min(state.count() - 1, indexAt(container.scrollTop + container.clientHeight / 2)));
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
  let h = "";
  for (const r of RM.sideRows({ row: S.scopeName, localCount: S.localCount, base: ov.base && ov.base.ref })) {
    h += `<div class="side-item${r.active ? " active" : ""}" data-act="${r.act}">
      <span class="ico">${r.ico}</span><span class="lbl">${esc(r.label)}</span>
      <span class="badge">${r.badge}</span></div>`;
  }

  // Every group is counted and capped through one helper, so no badge can go
  // missing or outrun the rows below it again.
  const group = (id, name, items, row, cap) => {
    const g = RM.sideGroup(items, cap);
    const open = S.fileOpen.has(id);
    h += `<div class="side-group${open ? "" : " closed"}" data-group="${id}">
       <span class="caret">▾</span>${name} <span class="badge">${g.badge}</span></div>
     <div class="side-sub${open ? "" : " hidden"}" data-sub="${id}">${g.shown.map(row).join("")}</div>`;
  };

  if (ov.worktrees.length > 1) {
    group(
      "wt",
      "Worktrees",
      ov.worktrees,
      (w) =>
        // A detached worktree has no branch; its HEAD sha is what git can resolve.
        `<div class="side-item" data-act="rev" data-rev="${esc(w.branch || w.head || "HEAD")}">
          <span class="ico">🗂</span><span class="lbl" title="${esc(w.path)}">${esc(w.name)}</span></div>`
    );
  }
  group(
    "br",
    "Branches",
    ov.branches,
    (b) =>
      `<div class="side-item" data-act="rev" data-rev="${esc(b.name)}">
        <span class="ico">⑂</span><span class="lbl">${esc(b.name)}</span>
        <span class="badge">${b.behind ? b.behind + "↓" : ""}${b.ahead ? b.ahead + "↑" : ""}</span></div>`,
    300
  );
  if (ov.tags.length) {
    group(
      "tg",
      "Tags",
      ov.tags,
      (t) =>
        `<div class="side-item" data-act="rev" data-rev="${esc(t.name)}">
          <span class="ico">🏷</span><span class="lbl">${esc(t.name)}</span></div>`,
      200
    );
  }
  if (ov.stashes.length) {
    group(
      "st",
      "Stashes",
      ov.stashes,
      (s) =>
        `<div class="side-item" data-act="commit" data-sha="${s.sha}">
          <span class="ico">📦</span><span class="lbl">${esc(s.subject)}</span></div>`
    );
  }
  if (ov.remoteBranches.length) {
    group(
      "rm",
      "Remotes",
      ov.remoteBranches,
      (b) =>
        `<div class="side-item" data-act="rev" data-rev="${esc(b.name)}">
          <span class="ico">☁</span><span class="lbl">${esc(b.name)}</span></div>`,
      300
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
  try {
    // A failed page fetch must not take down the commit pane — leave the list
    // as it was and let the next scroll tick try again.
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
  } catch {
  } finally {
    S.loadingMore = false;
  }
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
  let commits;
  try {
    // A failed side-panel fetch must not take down the page — leave whatever
    // commit list was already on screen.
    ({ commits } = await api("commits", {
      limit: COMMIT_PAGE,
      ...(S.commitRev ? { rev: S.commitRev } : {}),
    }));
  } catch {
    return;
  }
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

function selectCommit(sha) {
  S.selCommit = sha;
  commitVL.refresh();
  bannerDismissed = null; // an explicit commit click un-dismisses the banner
  setScope({ type: "commit", sha }, null, true);
}

/*
 * The commit's story sits in the left pane, right above the timeline it was
 * picked from — not in a tab, not on top of the diff. The old Commit tab was
 * a passive pane only `selectCommit` ever filled, which left it empty on
 * arrival and stale after any scope change — two ways of lying about what is
 * on screen. This card is derived from the scope: it exists exactly while the
 * scope is one commit, so neither failure state can be expressed.
 */
let bannerDismissed = null; // sha the reader closed; the next explicit commit click resets it
async function updateCommitBanner(scope) {
  const el = $("#commitInfo");
  // The card is a resizable container like any pane; its splitter goes with it.
  const show = (on) => {
    el.hidden = !on;
    $("#ciSplit").hidden = !on;
  };
  /* What the card describes: a commit scope names itself; an "up to here"
     range from the timeline reads as the story through its newest commit, so
     that commit's details are the useful header. A plain range names nothing. */
  const sha =
    scope.type === "commit" ? scope.sha
    : scope.type === "range" && S.tl && S.tl.sel ? S.tl.sel
    : null;
  if (!sha) S.commitMeta = null;
  if (!sha || bannerDismissed === sha) {
    show(false);
    return;
  }
  // A card describing the previous commit must not sit there looking current
  // while this one's metadata is fetched — hide it for the gap instead.
  if (el.dataset.sha !== sha) show(false);
  let meta;
  try {
    ({ meta } = await api("commit", { sha }, { cached: true }));
  } catch {
    show(false); // no metadata is a missing banner, not a broken one
    return;
  }
  // The target may have moved on while the fetch was in flight.
  const still =
    scope.type === "commit"
      ? S.scope.type === "commit" && S.scope.sha === sha
      : S.scope.type === "range" && !!S.tl && S.tl.sel === sha;
  if (!meta || !still) return;
  S.commitMeta = meta;
  el.dataset.sha = sha;
  el.innerHTML = `
    <div class="cb-head">
      <span class="cb-subject">${esc(meta.subject)}</span>
      <button class="x" data-cbclose title="Dismiss">✕</button>
    </div>
    <div class="cb-meta">
      <span>${esc(meta.author)}</span>
      <span>${new Date(meta.date).toLocaleString()}</span>
      <span class="mono">${esc(meta.short)}</span>
      ${meta.refs.map((r) => `<span class="reftag">${esc(r)}</span>`).join("")}
    </div>
    ${meta.body ? `<pre class="cb-body">${esc(meta.body)}</pre>` : ""}`;
  show(true);
  el.querySelector("[data-cbclose]").onclick = () => {
    bannerDismissed = sha;
    show(false);
  };
}

// ---------------------------------------------------------------------------
// commit timeline — the branch as a story, under the file list
// ---------------------------------------------------------------------------
/*
 * Shown only while reviewing a range: the commits inside base..head, oldest
 * first. Clicking one narrows the review — to everything up to that commit
 * ("Up to here") or to that commit alone ("This commit") — by switching scope
 * through the ordinary setScope. The panel is a scope switcher, not new diff
 * machinery; RM.timelineRows / RM.timelineScope hold its contract.
 */
let tlSeq = 0;
async function syncTimeline(scope) {
  if (scope.type !== "range") {
    S.tl = null;
    renderTimeline();
    return;
  }
  const head = scope.head || "HEAD";
  const req = ++tlSeq; // orders same-range refetches; timeline clicks never bump it
  S.tl = { base: scope.base, head, commits: null, sel: null, mode: (S.tl && S.tl.mode) || "upto", req };
  renderTimeline();
  let commits;
  try {
    // A failed side-panel fetch must not take down the review — the panel just
    // stays empty and the full-range row still describes what is on screen.
    // first-parent: the branch's own story — a merge is one row, not the
    // spilled contents of whatever it brought in. Uncached on purpose: the
    // branch can gain commits mid-session, like the top pane's list.
    ({ commits } = await api("commits", { rev: `${scope.base}..${head}`, limit: 500, firstParent: 1 }));
  } catch {
    return;
  }
  // At the cap we cannot know the list is complete, and the bottom row must
  // not be labelled "oldest" when a hundred older commits are in the diff.
  const truncated = commits.length >= 500;
  /* Guard on our own request token, not on scopeSeq: navigating *within* the
     timeline bumps the scope seq without re-anchoring, and a click racing this
     fetch must not throw the commits away — that left the panel empty for
     good. But two fetches for the *same* range must still be ordered, or the
     older response overwrites the newer list; the token settles both. */
  if (!S.tl || S.tl.req !== req) return;
  S.tl.commits = commits; // newest-first, the order every git tool trains the eye for
  S.tl.truncated = truncated;
  renderTimeline();
}

function renderTimeline() {
  const on = !!S.tl;
  const closed = !!Prefs.get("panel.timelineCollapsed");
  $("#timelinePane").hidden = !on;
  $("#timelinePane").classList.toggle("closed", closed);
  $("#tlSplit").hidden = !on || closed; // a collapsed header bar has nothing to resize
  $("#tlCaret").textContent = closed ? "▸" : "▾";
  if (!on) return;
  const rows = RM.timelineRows(S.tl.commits, S.tl.sel, S.tl.mode).map((r, i, arr) => {
    if (r.kind === "all")
      return `<div class="tl-row all${r.sel ? " sel" : ""}" data-tlall><span class="tl-sub">All branch changes</span></div>`;
    // Newest/oldest tags orient the list; dimming shows which commits the
    // current selection's diff actually contains.
    const tag =
      arr.length > 2 && i === 1 ? "newest"
      : arr.length > 2 && i === arr.length - 1 && !S.tl.truncated ? "oldest"
      : "";
    return `<div class="tl-row${r.sel ? " sel" : ""}${r.included ? "" : " dim"}" data-tlsha="${r.sha}">
         <span class="tl-sha">${esc(r.short)}</span><span class="tl-sub" title="${esc(r.subject)}">${esc(r.subject)}</span>${tag ? `<span class="tl-tag">${tag}</span>` : ""}</div>`;
  });
  $("#timeline").innerHTML = rows.join("");
  $("#tlCount").textContent = S.tl.commits ? String(S.tl.commits.length) + (S.tl.truncated ? "+" : "") : "";
  $("#segUpto").classList.toggle("active", S.tl.mode === "upto");
  $("#segOnly").classList.toggle("active", S.tl.mode === "only");
}

$("#timeline").addEventListener("click", (e) => {
  if (!S.tl) return;
  const row = e.target.closest("[data-tlsha]");
  const all = e.target.closest("[data-tlall]");
  if (!row && !all) return;
  bannerDismissed = null; // a timeline click is as explicit as a top-pane one
  // Re-clicking the selected commit steps back out to the full branch.
  const sha = row && S.tl.sel !== row.dataset.tlsha ? row.dataset.tlsha : null;
  S.tl.sel = sha;
  renderTimeline();
  setScope(RM.timelineScope(S.tl), null, true, true);
});

function tlMode(mode) {
  if (!S.tl || S.tl.mode === mode) return;
  S.tl.mode = mode;
  renderTimeline();
  if (S.tl.sel) setScope(RM.timelineScope(S.tl), null, true, true);
}
$("#segUpto").onclick = () => tlMode("upto");
$("#segOnly").onclick = () => tlMode("only");
$("#tlCaret").onclick = () => {
  Prefs.set("panel.timelineCollapsed", !Prefs.get("panel.timelineCollapsed"));
  renderTimeline();
};

function collapseCommits(collapsed) {
  $("#commitPane").classList.toggle("collapsed", collapsed);
  document.querySelector(".hsplit").style.display = collapsed ? "none" : "";
}

// ---------------------------------------------------------------------------
// scope + file list
// ---------------------------------------------------------------------------
let scopeSeq = 0;
async function setScope(scope, name, keepCommits, fromTimeline) {
  const seq = ++scopeSeq; // a slower earlier load must not clobber a newer one
  S.scope = scope;
  // `name` is the sidebar row this scope was reached from. A commit has no row
  // of its own, so it passes none and the row that got the reader here stays lit.
  if (name) S.scopeName = name;
  S.selFile = null;
  S.perFile = new Map();
  S.segments = [];
  S.pinnedSeg = null; // a new scope can repeat a path; the old pin means nothing
  S.focus = null; // …and the line cursor was pointing into the old stream
  S.pendingFocusFile = null; // …and any armed promotion was waiting on the old stream too
  S.treePaths = null;
  $("#scopeChip").textContent = Scope.label(scope);
  // Timeline first: the info card reads S.tl.sel, and a scope chosen anywhere
  // but the timeline must re-anchor (or clear) that selection before the card
  // decides what it describes — the old order flashed a stale commit's card.
  if (!fromTimeline) syncTimeline(scope);
  updateCommitBanner(scope); // not awaited: metadata fills in when it arrives
  if (!keepCommits) collapseCommits(scope.type !== "commit");
  sidebar();
  let files;
  try {
    ({ files } = await api("files", scopeParams(), { cached: true }));
  } catch {
    // The existing no-changes empty state is the fallback — better than a dead
    // scope switch that leaves the previous scope's files on screen.
    files = [];
  }
  if (seq !== scopeSeq) return;
  S.files = files;
  // The sidebar counts the working tree whatever scope is open, so remember it.
  if (Scope.isWorktree(scope)) S.localCount = files.length;
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
  const terms = RM.parseFilter(S.filter);
  const box = $("#fileTree");

  /* Counted once, not once per row: `commented` asks about every path, and a
     scan of S.ann per row is the shape that turns a filter keystroke into a
     visible stall on a big review. */
  const cmtCount = new Map();
  for (const a of S.ann) cmtCount.set(a.file, (cmtCount.get(a.file) || 0) + 1);
  const descOf = (p) => {
    const m = meta.get(p);
    return {
      path: p,
      status: m && m.status,
      binary: m && m.binary,
      viewed: isViewed(p),
      comments: cmtCount.get(p) || 0,
      // Only changed files can be in the stream; for the rest the word simply
      // never matches, which is the honest answer.
      selected: m ? isSelected(p) : undefined,
    };
  };

  const flat = terms.length || (S.listMode && !isTreeTab);
  if (flat) {
    const hits = (terms.length ? paths.filter((p) => RM.matchFile(terms, descOf(p))) : paths).slice(0, 800);
    box.innerHTML =
      hits.map((p) => fileRow(p, meta.get(p), 0, null)).join("") ||
      `<div class="empty-state">${terms.length ? "No match" : "No changes"}</div>`;
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

/** Move the sidebar's 'sel' highlight without rebuilding the pane. Scrolling
    the stream crosses a file boundary every few ticks; a full renderFileTree
    per crossing rebuilds up to 800 rows to change one class. */
function updateTreeSel(path) {
  const box = $("#fileTree");
  const cur = box.querySelector(".tnode.sel");
  if (cur && cur.dataset.file === path) return;
  if (cur) cur.classList.remove("sel");
  const next = box.querySelector(`.tnode[data-file="${CSS.escape(path)}"]`);
  if (next) {
    next.classList.add("sel");
    next.scrollIntoView({ block: "nearest" });
  }
}

// Viewed state is per scope: the same path in the worktree and in a commit are
// different things to have read.
const viewKey = (path) => scopeId() + "|" + path;
const isViewed = (path) => S.viewed.has(viewKey(path));

function setViewed(path, on) {
  const k = viewKey(path);
  on ? S.viewed.add(k) : S.viewed.delete(k);
  /* Viewed folds the file away, from every entry point (pill, sticky bar, v).
     One-way on purpose: un-viewing leaves the fold alone, and unfolding a
     file never clears its viewed mark — done is done until you say otherwise. */
  if (on) S.collapsed.add(k);
  changed();
  if (on) refocusOutOf(path);
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

/** Fold or unfold every selected file in one rebuild — per-file setCollapsed
    would rebuild the stream once per file. */
function collapseAll(on) {
  for (const f of S.files) {
    if (!isSelected(f.path)) continue;
    const k = viewKey(f.path);
    on ? S.collapsed.add(k) : S.collapsed.delete(k);
  }
  rebuildStream();
  if (on && S.focus) refocusOutOf(S.focus.file);
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

  // The diff toolbar's own copy: fuller words than the topbar pill, plus the
  // one bulk action. Selection-scoped, unlike the topbar — Mark all viewed and
  // the v-loop only walk selected files, so the meter and the button's disabled
  // state must count the same set or the button goes dead while looking live.
  const shown = S.files.filter((f) => isSelected(f.path));
  const sTotal = shown.length;
  const sSeen = shown.filter((f) => isViewed(f.path)).length;
  const ss = $("#streamSummary");
  ss.hidden = !sTotal || S.tab === "tree";
  ss.innerHTML = !sTotal
    ? ""
    : `<span>${sTotal} file${sTotal === 1 ? "" : "s"} changed</span>` +
      `<span class="a">+${shown.reduce((a, f) => a + (f.additions || 0), 0)}</span>` +
      `<span class="d">−${shown.reduce((a, f) => a + (f.deletions || 0), 0)}</span>` +
      `<span class="ss-div"></span>` +
      `<span>${sSeen} of ${sTotal} viewed</span>` +
      `<span class="ss-meter"><span style="width:${Math.round((sSeen / sTotal) * 100)}%"></span></span>` +
      `<button class="btn ghost" data-markall ${sSeen === sTotal ? "disabled" : ""}>Mark all viewed</button>`;
}
$("#streamSummary").addEventListener("click", (e) => {
  if (e.target.closest("[data-markall]")) markAllViewed();
});

/* The two per-file controls, shared by every stream header and the sticky
   header so they stay one visual language. Buttons, not checkboxes: their
   clicks must not bubble into the row's own set-active / collapse behavior,
   and a pill can carry the on-state styling a native box cannot. */
const pillsHtml = (viewed, full) => `<span class="pills">
    <button class="pill pfull${full ? " on" : ""}" data-pfull title="Show the whole file, not just the diff (f)">Full file</button>
    <button class="pill pviewed${viewed ? " on" : ""}" data-pviewed title="Mark reviewed and fold the file (v also jumps to the next unviewed)"><span class="ck">${viewed ? "✓" : ""}</span>Viewed</button>
  </span>`;

const isFull = (path) => !!(path && (S.perFile.get(path) || {}).full);

/** Every selected file in one sweep, then one persist + repaint — per-file
    setViewed would save the draft and rebuild once per file. Folds too, the
    way v does: the finish card requires viewed AND collapsed, and the one
    bulk action that says "done with everything" must be able to reach it. */
function markAllViewed() {
  for (const f of S.files) {
    if (!isSelected(f.path)) continue;
    S.viewed.add(viewKey(f.path));
    S.collapsed.add(viewKey(f.path));
  }
  if (S.focus) refocusOutOf(S.focus.file);
  changed();
}

/** Next file that has not been marked viewed, wrapping from the current one.
    Only selected files count: the v-loop walks the stream that is on screen. */
const nextUnviewed = () =>
  RM.nextUnviewed(
    S.files.map((f) => f.path).filter(isSelected),
    S.selFile,
    isViewed
  );

/* Inline SVG so the icons follow currentColor through hover and theme —
   an icon font or emoji would pin its own size and palette. */
const svgIcon = (paths) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const EYE_PATHS = `<path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="1.9"/>`;
const I_EYE = svgIcon(EYE_PATHS);
const I_EYE_OFF = svgIcon(EYE_PATHS + `<path d="m3 13.5 10-11"/>`);
const I_FOLD = svgIcon(`<path d="M4 2.5 8 6l4-3.5M4 13.5 8 10l4 3.5"/>`);
const I_UNFOLD = svgIcon(`<path d="M4 6l4-3.5L12 6M4 10l4 3.5L12 10"/>`);
// One chevron, rotated by CSS: `.caret.open svg` turns it downward, so the
// open/closed flip animates instead of swapping glyphs.
const I_CHEV = svgIcon(`<path d="M6 3.5 10.5 8 6 12.5"/>`);

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
  /* Only changed files can be in the stream, so only they get the show/hide
     eye — on every tab. The File Tree lists the whole repo; its unchanged
     files have no meta (`m`) and therefore nothing to select. An eye, not a
     checkbox: ✓ is already taken by "viewed", and the two must not blur. */
  const box = m
    ? `<span class="selbox${isSelected(path) ? " on" : ""}" data-sel="${esc(path)}" title="${isSelected(path) ? "Hide from the stream" : "Show in the stream"}">${isSelected(path) ? I_EYE : I_EYE_OFF}</span>`
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
  if (e.target.closest("[data-foldtoggle]")) return collapseAll(!allShownFolded()), true;
  return false;
}
document.querySelector(".filter-row").addEventListener("click", selAllClick);

/** One toggle, code-editor style: it folds everything until everything is
    folded, then it unfolds. The icon and tooltip say which way it will act. */
const allShownFolded = () => {
  const shown = S.files.filter((f) => isSelected(f.path));
  return shown.length > 0 && shown.every((f) => isCollapsed(f.path));
};
function updateFoldToggle() {
  const b = document.querySelector("[data-foldtoggle]");
  if (!b) return;
  const folded = allShownFolded();
  b.innerHTML = folded ? I_UNFOLD : I_FOLD;
  const label = folded ? "Unfold all files" : "Fold all files";
  b.title = label;
  b.setAttribute("aria-label", label);
}
updateFoldToggle(); // scripts load after the DOM; seed the icon before any stream exists

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
/** Fetch one file's diff and slot it into the stream. Shared by the stream
    filler and any jump that must wait for a specific file. Returns after the
    store+rebuild; a scope change mid-flight discards the arrival. */
async function loadFileDiff(path) {
  const sid = scopeId();
  /* `ws` is part of the request url, so the request cache keys on it too: a
     file already fetched one way is re-fetched the other way, and toggling
     back is free. */
  const params = { ...scopeParams(), file: path, ws: S.ignoreWs ? "1" : "0" };
  try {
    /* No `full: "1"` here. The diff already arrives with full context, so
       "Full file" only has to stop folding — asking for the whole file as
       well would render every line while the checkbox read unchecked, and
       would make the empty/mode-only notes unreachable. Only the File Tree
       tab, which has no diff, fetches whole files. */
    const r = await api("diff", params, { cached: true });
    if (scopeId() !== sid) return; // scope changed mid-flight
    const d = r.diff || {};
    S.perFile.set(path, {
      loaded: true,
      rows: d.rows || null,
      fullRows: null,
      expanded: new Map(),
      full: false,
      binary: d.binary,
      tooBig: d.tooBig,
      error: d.error,
      empty: d.empty,
      mode: d.mode,
    });
  } catch {
    if (scopeId() !== sid) return; // scope changed mid-flight
    // A rejected fetch would otherwise cache its own rejection forever —
    // every future read of this url replays the same failure. Evict it so
    // the next fetchStream (a fresh scope, a retry) gets a clean attempt.
    cache.delete(apiUrl("diff", params));
    S.perFile.set(path, {
      loaded: true,
      rows: null,
      fullRows: null,
      expanded: new Map(),
      full: false,
      error: "could not load diff",
    });
  }
  rebuildStream();
}

let streamSeq = 0;
/** Fetch every selected, not-yet-loaded file, a few at a time, in list order.
    Each arrival re-slots into the stream; the reader reads while it fills. */
async function fetchStream() {
  const seq = ++streamSeq;
  const queue = S.files.map((f) => f.path).filter((p) => isSelected(p) && !(S.perFile.get(p) || {}).loaded);
  const CONCURRENCY = 4;
  let next = 0;
  const worker = async () => {
    // Selection/scope churn stops a worker from pulling further queue entries;
    // an entry already in flight still stores its arrival — loadFileDiff's own
    // scope guard covers that, and storing into a file the reader deselected
    // mid-flight is harmless, since deselected files simply aren't rendered.
    while (next < queue.length && seq === streamSeq) {
      const path = queue[next++];
      await loadFileDiff(path);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/* Every file unchecked is a choice, not a failure — offer the way back. Shared
   by renderDiff and rebuildStream so the empty-stream hint stays one string. */
const nothingSelectedHint = () => `Nothing selected. <b data-selall>Select all</b> to fill the stream.`;

/** Rebuild items from current per-file state and repaint, keeping scroll.
    `refresh`, not `paint`: paint keeps a stale empty state on screen and only
    reindexes when the item count changes. `refresh` never touches scrollTop.
    A straggler fetch can land after the reader hit "none" — `refresh` alone
    would blank the pane with no way back, so an empty result gets the same
    hint `renderDiff` shows instead of a silent, dead-end empty stream. */
function rebuildStream() {
  buildItems();
  if (!S.items.length && S.files.length) diffVL.setEmpty(nothingSelectedHint());
  else diffVL.refresh();
  renderProgress();
  revalidatePin(); // heights moved: the pin may no longer describe anything
  updateStickyHeader(true); // a file arriving can move both the top file and the count
  promotePendingFocus();
  updateFoldToggle(); // fold changes and straggler loads land here without a render()
}

/** Sidebar click / j/k target: make sure it's in the stream, then go there. */
function scrollToFile(path) {
  S.pendingFocusFile = null; // navigating away cancels any pending anchor for the old target
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
  updateTreeSel(path);
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
  try {
    const { full } = await api("file", { ...scopeParams(), file: path }, { cached: true });
    if (S.selFile !== path) return;
    S.treeRows = full && full.rows ? full.rows : null;
    S.treeDiff = full;
  } catch (e) {
    if (S.selFile !== path) return;
    // renderTreeFile's existing meta.error branch renders "Could not read this file."
    S.treeDiff = { error: String((e && e.message) || e) };
    S.treeRows = null;
  }
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
      expanded: new Map(),
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
     wrong one. A gap bigger than a chunk expands only through its two
     directional buttons, twenty lines at a time; once the remainder fits in
     one chunk the marker falls back to the plain click-to-expand row. */
  fold(item, top) {
    const chunk = RM.GEOM.chunk;
    const attrs = `style="top:${top}px" data-fold="${item.id}" data-file="${esc(item.f)}" data-count="${item.count}"`;
    if (item.count <= chunk) {
      return `<div class="fold" ${attrs}>
        <span>⌄</span> ${item.count} unmodified line${item.count === 1 ? "" : "s"} — click to expand</div>`;
    }
    return `<div class="fold chunky" ${attrs}>
      <button class="fbtn" data-dir="down" title="Show the next ${chunk} lines, after the change above">⤓ ${chunk}</button>
      <span>${item.count} unmodified lines</span>
      <button class="fbtn" data-dir="up" title="Show the ${chunk} lines before the change below">⤒ ${chunk}</button></div>`;
  },

  /** The bar between two files: name, counts, position, and both per-file
      controls. The pill group sits in a fixed-width slot so the column stays
      steady down the stream no matter which rows are ticked; the Viewed pill
      reserves a checkmark slot so its label never shifts on toggle. */
  fileHeader(item, top) {
    const s = item.stats || {};
    const active = item.f === S.selFile;
    return `<div class="fsh${item.collapsed ? " closed" : ""}${item.viewed ? " seen" : ""}${active ? " cur" : ""}"
        style="top:${top}px" data-fhead="${esc(item.f)}" title="${esc(item.f)}">
      <span class="rail"></span>
      <span class="caret${item.collapsed ? "" : " open"}" data-caret title="${item.collapsed ? "Expand" : "Collapse"} this file">${I_CHEV}</span>
      <span class="fp">${esc(item.f)}</span>
      ${s.oldPath ? `<span class="old">← ${esc(s.oldPath)}</span>` : ""}
      <span class="grow"></span>
      <span class="pos">${item.idx + 1} of ${item.count}</span>
      <span class="plus">+${s.additions ?? 0}</span><span class="minus">−${s.deletions ?? 0}</span>
      ${pillsHtml(item.viewed, item.full)}
    </div>`;
  },

  /* A file whose diff is still in flight, and a file that has no diff to show
     (binary, too big, mode-only). Both are one fixed-height row, so the
     prefix-sum index is exact before the fetch lands and after it does. */
  loading(item, top) {
    return `<div class="fold loading" style="top:${top}px">Loading ${esc(item.f)}…</div>`;
  },

  note(item, top) {
    return `<div class="fold note" style="top:${top}px">${esc(item.text)}</div>`;
  },

  /** The review's finish line — appears when every selected file is viewed. */
  allviewed(item, top) {
    return `<div class="avc" style="top:${top}px">
      <div class="av-title">All ${item.n} file${item.n === 1 ? "" : "s"} viewed</div>
      ${item.comments ? `<div class="av-sub">${item.comments} comment${item.comments === 1 ? "" : "s"} drafted</div>` : ""}
      <div class="av-act">${
        item.comments
          ? `<button data-finish-send>Send feedback</button><span class="av-hint">⌘⏎</span>`
          : `<button data-finish-approve>Approve</button>`
      }</div>
    </div>`;
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
    const base = S.ov && S.ov.base && S.ov.base.ref; // a tab click can land here before boot's first overview fetch resolves
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
    diffVL.setEmpty(nothingSelectedHint());
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
  // The tree tab has no stream, but an early return below can skip buildItems()
  // — the one place that would otherwise clear this — leaving the Changes tab's
  // stale segments around for scrollToFile/currentSeg to trust.
  S.segments = [];
  const path = S.selFile || "";
  head.hidden = false; // the Changes tab may have left it hidden over a collapsed top file
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
  /* A collapsed file whose header row is itself at the top of the viewport
     needs no sticky copy — the bar exists to restate a header that scrolled
     off, and with nothing scrolled off it read as a duplicated first row
     (arrows and all) whenever the stream was mostly folded. */
  if (diffVL.topIndex() === seg.start && isCollapsed(seg.file)) {
    head.hidden = true;
    head.dataset.file = ""; // forces a fresh render when the bar returns
    return;
  }
  head.hidden = false;
  if (!force && head.dataset.file === seg.file) return; // cheap on every scroll tick
  head.dataset.file = seg.file;
  if (S.selFile !== seg.file) {
    S.selFile = seg.file;
    saveDraft(); // debounced: a fast scroll writes the crossing it ended on, once
    updateTreeSel(seg.file); // incremental: scroll crossings must not rebuild the pane
    /* The vlist's own scroll listener painted the header rows before this one
       ran, against the previous selFile — repaint or the blue rail trails the
       crossing by one window shift. */
    diffVL.paint(true);
  }
  const f = S.files.find((x) => x.path === seg.file) || {};
  const i = S.segments.indexOf(seg);
  const collapsed = isCollapsed(seg.file);
  const viewed = isViewed(seg.file);
  head.innerHTML = `
    <span class="caret${collapsed ? "" : " open"}" data-shfold title="${collapsed ? "Expand" : "Collapse"} this file">${I_CHEV}</span>
    <span class="fp" data-shjump title="${esc(seg.file)} — click to jump to the top of this file"><b>${esc(seg.file)}</b></span>
    <span class="plus">+${f.additions ?? 0}</span><span class="minus">−${f.deletions ?? 0}</span>
    <span class="grow"></span>
    <span class="pos">${i + 1} of ${S.segments.length}</span>
    ${pillsHtml(viewed, isFull(seg.file))}
    <div class="nav stepper" id="stepper" hidden>
      <button data-nav="prev" title="Previous change (p)">▲</button><span class="chg" id="chgPos"></span><button data-nav="next" title="Next change (n)">▼</button>
    </div>`;
  updateChangeCounter();
}

/* The arrows moved text without saying what they act on. The counter names it:
   which change block of the current file the viewport sits in. Separate from
   updateStickyHeader because that early-returns while the top file is
   unchanged, and this must track every scroll tick within the file. The block
   starts are cached per (items, file): this runs at scroll frequency, and an
   O(segment) walk per tick is exactly what the rest of the hot path avoids. */
let chgCache = null;
function updateChangeCounter() {
  const el = $("#chgPos");
  if (!el) return;
  const seg = currentSeg();
  if (!seg) {
    el.textContent = "";
    return;
  }
  if (!chgCache || chgCache.items !== S.items || chgCache.file !== seg.file) {
    chgCache = { items: S.items, file: seg.file, starts: RM.changeStarts(S.items, seg.start, seg.end) };
  }
  const total = chgCache.starts.length;
  /* Anchor priority: the exact block the last n/p landed on, else the
     viewport's middle (jumps center their target, so the top edge would still
     sit in the previous block). Either can fall outside the header's own
     segment — a short file fits several segments on one screen — and the
     counter must describe the file the header names, so clamp to its range. */
  let at = lastJumpIdx();
  if (at < seg.start || at >= seg.end) at = diffVL.midIndex();
  if (at < seg.start || at >= seg.end) at = Math.max(seg.start, Math.min(seg.end - 1, diffVL.topIndex()));
  let cur = 0;
  for (const s of chgCache.starts) {
    if (s > at) break;
    cur++;
  }
  el.textContent = !total ? "" : cur ? `change ${cur} of ${total}` : `${total} change${total === 1 ? "" : "s"}`;
  // No blocks, no stepper: an empty pill with two arrows explains nothing.
  const step = $("#stepper");
  if (step) step.hidden = !total;
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
    updateChangeCounter(); // the sticky header early-returns within a file; the counter may not
  },
  { passive: true }
);

$("#diffBody").addEventListener("click", (e) => {
  /* A file's header row: the pills own their file's state, the caret is the
     collapse toggle, and the row body sets the active file. (Collapse used to
     live on the whole row — every misclick folded the file being read.) */
  const fh = e.target.closest(".fsh[data-fhead]");
  if (fh) {
    const p = fh.dataset.fhead;
    if (e.target.closest("[data-pviewed]")) return setViewed(p, !isViewed(p)); // folds too; v additionally advances
    if (e.target.closest("[data-pfull]")) return setFull(p, !isFull(p));
    if (e.target.closest("[data-caret]")) return setCollapsed(p, !isCollapsed(p));
    return scrollToFile(p);
  }
  const fold = e.target.closest(".fold[data-fold]");
  if (fold) {
    // Fold state belongs to a file; the marker says which one it came from.
    const st = S.perFile.get(fold.dataset.file);
    if (!st) return;
    const id = fold.dataset.fold;
    const remaining = +fold.dataset.count || 0;
    const chunk = RM.GEOM.chunk;
    const cur = st.expanded.get(id) || { head: 0, tail: 0 };
    const dir = e.target.closest("[data-dir]");
    let grewAbove = 0;
    if (dir) {
      const n = Math.min(chunk, remaining);
      if (dir.dataset.dir === "down") {
        st.expanded.set(id, { head: cur.head + n, tail: cur.tail });
        grewAbove = n;
      } else {
        st.expanded.set(id, { head: cur.head, tail: cur.tail + n });
      }
    } else if (remaining <= chunk) {
      st.expanded.set(id, { head: cur.head + remaining, tail: cur.tail });
    } else {
      return; // a big gap opens only through its buttons — no accidental 80-line dumps
    }
    // Opening a fold grows the stream, which can invalidate a header pin — the
    // one rebuild path knows that; buildItems + refresh on their own did not.
    rebuildStream();
    // A head reveal inserts its rows ABOVE the marker; without compensation the
    // marker slides down a chunk's height and the second click misses it.
    if (grewAbove) $("#diffBody").scrollTop += grewAbove * RM.GEOM.row;
    return;
  }
  const del = e.target.closest("[data-del]");
  if (del) {
    deleteAnn(del.dataset.del);
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
  if (e.target.closest("[data-finish-send]")) return openModal("annotated");
  if (e.target.closest("[data-finish-approve]")) return openModal("approved");
  // `setEmpty` writes its HTML inside #diffBody, so the empty stream's own
  // "Select all" lands here rather than on the file pane's copy.
  selAllClick(e);
});

$("#diffHeader").addEventListener("click", (e) => {
  const b = e.target.closest("[data-nav]");
  if (b) return jumpChange(b.dataset.nav === "next" ? 1 : -1);
  // The three mini-header controls act on the file the bar names. The tree
  // tab's header sets dataset.file = "" and has none of these controls.
  /* Switching to the File Tree tab leaves the stream's header markup (and its
     dataset.file) in place until the tree renders its own — a pill or fold
     click in that window would rebuild the stream under the tree tab and
     blank it. The nav branch above stays live; the file-scoped ones do not. */
  const file = $("#diffHeader").dataset.file;
  if (!file || S.tab === "tree") return;
  if (e.target.closest("[data-shfold]")) return setCollapsed(file, !isCollapsed(file));
  if (e.target.closest("[data-pviewed]")) return setViewed(file, !isViewed(file)); // folds too; v additionally advances
  if (e.target.closest("[data-pfull]")) return setFull(file, !isFull(file));
  if (e.target.closest("[data-shjump]")) return scrollToFile(file);
});

/* The last n/p landing, valid only while the reader has not scrolled off it.
   Without it, repeated n re-finds the same block: a centered jump leaves the
   viewport's top edge in the context ABOVE the block just visited, and a
   top-anchored walk starts from there — the arrows moved text once and then
   went dead, with no way to tell why. Anchored by file+line, not item index:
   background diff arrivals rebuild the stream mid-review, and an index into a
   discarded array would go stale on every straggler. The scrollTop check is
   the "reader moved on" test; a rebuild that keeps scrollTop re-resolves. */
let lastJump = null;
function lastJumpIdx() {
  if (!lastJump || $("#diffBody").scrollTop !== lastJump.top) return -1;
  return RM.rowIndexFor(S.items, lastJump.side, lastJump.line, lastJump.file);
}

function jumpChange(dir) {
  S.pendingFocusFile = null; // navigating away cancels any pending anchor for the old target
  // Rows are no longer uniform (headers, cards, notes), so scrollTop/ROW is not
  // an item index any more — the list knows which item the viewport starts on.
  /* Start from where the reader thinks they are: the block the previous jump
     landed on, or a pinned file's own header — not the segment the clamped
     scroll left at the top of the viewport. */
  const ji = lastJumpIdx();
  const pinned = S.pinnedSeg ? currentSeg() : null;
  const from = ji >= 0 ? ji : pinned && pinned.file === S.pinnedSeg ? pinned.start : diffVL.topIndex();
  const i = RM.findChange(S.items, from, dir);
  if (i < 0) return;
  diffVL.scrollToIndex(i, true);
  const ln = RM.rowLine(S.items[i]);
  lastJump = ln ? { top: $("#diffBody").scrollTop, file: S.items[i].f, side: ln.side, line: ln.line } : null;
  pinAfterScroll(S.items[i] && S.items[i].f);
  updateChangeCounter(); // a clamped jump moves no pixels, so no scroll event fires
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
    S.pendingFocusFile = null; // navigating away cancels any pending anchor for the old target
    diffVL.scrollToIndex(hits[0], true);
    pinAfterScroll(S.items[hits[0]] && S.items[hits[0]].f);
  }
  diffVL.refresh();
}
function stepSearch(d) {
  const h = S.search.hits;
  if (!h.length) return;
  S.pendingFocusFile = null; // navigating away cancels any pending anchor for the old target
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
  /* No real cursor yet, but `v` armed a pending anchor on a file that's still
     fetching — the reader's attention is on that file (spec 1a), so step from
     its first available row instead of restarting at row 0 of the stream. */
  const anchorIndex = !S.focus && S.pendingFocusFile ? RM.firstRowFrom(S.items, S.segments, S.pendingFocusFile) : -1;
  S.pendingFocusFile = null; // moving the cursor by hand cancels any pending anchor
  const next = RM.focusStep(S.items, S.focus, dir, anchorIndex);
  if (!next) return;
  /* The row's own file, not `S.selFile`: stepping off the end of one file lands
     in the next one before the sticky header has caught up with the scroll. */
  S.focus = { file: S.items[next.index].f, side: next.side, line: next.line };
  diffVL.scrollToIndex(next.index, false);
  pinAfterScroll(S.focus.file); // the cursor's file owns the header, reachable or not
  diffVL.refresh();
}

/** Land the cursor on the first change of `path` — the row the viewport just
    scrolled to — so the next n/↓ continues from what the reader is looking at.
    A still-loading segment has no honest row yet; remember the intent and
    promotePendingFocus (called from rebuildStream) resolves it once. */
function anchorFocusIn(path) {
  const hit = RM.firstChangeRowIn(S.items, S.segments, path);
  if (hit) {
    S.focus = { file: path, side: hit.side, line: hit.line };
    S.pendingFocusFile = null;
    diffVL.refresh(); // repaint the focus ring
  } else {
    S.focus = null;
    S.pendingFocusFile = path;
  }
}

/** Resolve an armed `S.pendingFocusFile` exactly once, from `rebuildStream`.
    One-shot: the moment the pending file is loaded, the anchor is consumed
    (cleared) before anything else runs, whether or not it finds a row — a
    loaded-but-rowless file (binary/empty/mode-only note) will never grow one,
    so retrying on every future rebuild would just repeat the same miss. That
    matters because a miss must never touch `S.focus`: by the time the retry
    would have fired, the reader may have set it some other way (a gutter
    click via openPopover, a jump from the comments panel) — this path only
    ever sets `S.focus` on a genuine hit, never clears it.
    The same applies before the miss check: arming set `S.focus = null`, so a
    non-null cursor here means one of those paths claimed it since — the
    anchor lost the race and must not steal the cursor back. */
function promotePendingFocus() {
  const path = S.pendingFocusFile;
  if (!path) return;
  if (S.focus) {
    S.pendingFocusFile = null;
    return;
  }
  const st = S.perFile.get(path);
  if (!st || !st.loaded) return; // still fetching — leave the anchor armed
  S.pendingFocusFile = null; // consume now: loaded means this is the one shot
  const hit = RM.firstChangeRowIn(S.items, S.segments, path);
  if (!hit) return; // loaded but rowless — nothing to promote to, ever
  S.focus = { file: path, side: hit.side, line: hit.line };
  diffVL.refresh(); // repaint the focus ring
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
  $("#streamSummary").hidden = tab === "tree"; // renderProgress re-shows it with fresh numbers
  if (tab === "tree" && !S.treePaths) {
    loadTree();
    return; // loadTree renders the file list itself once paths arrive
  }
  renderFileTree();
  // Leaving the File Tree tab's one-file view behind in #diffBody until the next
  // click made the stream tab look stuck; repaint here so it always shows the
  // stream. The tree tab keeps rendering its own diff lazily, from a click.
  if (tab !== "tree") renderDiff();
}

/**
 * The whole repo at the current scope. Changing scope invalidates it, and the
 * guard lives here rather than at the two callers: `setTab` fires this without
 * awaiting it, so a scope change mid-flight would otherwise land one revision's
 * paths next to another revision's contents.
 */
async function loadTree() {
  const seq = scopeSeq;
  let paths;
  try {
    // A failed side-panel fetch must not take down the page — leave whatever
    // tree was already there and let the next tab click retry.
    ({ paths } = await api("tree", scopeParams(), { cached: true }));
  } catch {
    return;
  }
  if (seq !== scopeSeq) return;
  S.treePaths = paths;
  renderFileTree();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

/* Collapse is display:none rather than width 0 so the splitter goes with it
   and the file/diff panes reclaim the space. */
function toggleSidebar() {
  const off = $("#sidebar").classList.toggle("off");
  document.querySelector('.vsplit[data-target="sidebar"]').style.display = off ? "none" : "";
  Prefs.set("panel.sidebarOff", off);
  diffVL.paint(true);
  commitVL.paint(true);
}
$("#btnSidebar").onclick = toggleSidebar;

/* Whitespace is a property of the diff, not of how it is drawn, so this one
   throws away the loaded rows and refetches. Viewed marks, folds and comments
   are untouched — they are keyed by file and line, not by this. */
$("#segWs").onclick = () => setIgnoreWs(!S.ignoreWs);
function setIgnoreWs(on) {
  if (S.ignoreWs === on) return;
  S.ignoreWs = on;
  $("#segWs").classList.toggle("active", on);
  Prefs.set("diff.ignoreWs", on);
  for (const st of S.perFile.values()) st.loaded = false;
  S.perFile.clear();
  rebuildStream();
  fetchStream();
}

$("#segSplit").onclick = () => setView("split");
$("#segUnified").onclick = () => setView("unified");
function setView(v) {
  S.view = v;
  $("#segSplit").classList.toggle("active", v === "split");
  $("#segUnified").classList.toggle("active", v === "unified");
  renderDiff();
}
function toggleViewed(on) {
  if (!S.selFile) return;
  setViewed(S.selFile, on); // folds too — setViewed owns the viewed→collapse pairing
  if (!on) return;
  const nx = nextUnviewed();
  if (nx) {
    scrollToFile(nx);
    anchorFocusIn(nx); // cursor and viewport must agree after v
  } else if (S.items.length) {
    // Last v of the review: bring the finish card (last item) into view.
    diffVL.scrollToIndex(S.items.length - 1, true);
  }
}

/* "Full file" belongs to a file — the pill on its row and the sticky header's
   copy both come here. Nothing to unfold before the diff arrives, so a click
   on a still-loading file is a no-op rather than a lie. */
function setFull(path, on) {
  const st = path && S.perFile.get(path);
  if (!st || !st.loaded) return;
  st.full = on;
  rebuildStream();
}
function setFullOnCurrent(on) {
  if (S.tab === "tree") return; // the tree tab only ever shows whole files
  setFull(S.selFile, on);
}

// ---------------------------------------------------------------------------
// annotations
// ---------------------------------------------------------------------------
/* Drafts live on the server, not in localStorage: localStorage is keyed to the
   origin including the port, and every run binds a new random port, so drafts
   written by one session were invisible to the next. */
/*
 * UI preferences: the same disk-over-localStorage reasoning, but global — a
 * pane width is a fact about your screen, not the repository. One store, one
 * seam: anything the UI wants remembered goes through these two calls; the
 * server holds a flat JSON object and never interprets the keys.
 */
const Prefs = {
  data: {},
  pending: {}, // only what THIS session changed — the server merges key-level,
  // so a concurrent session's settings are never clobbered by our snapshot
  timer: null,
  async load() {
    let disk = {};
    try {
      disk = (await api("prefs")) || {};
    } catch {
      /* defaults are always an acceptable answer */
    }
    /* Merge under, never replace: the ☰ button and the splitters are live
       while this request is in flight, and a click in that window has already
       written into `data`. Replacing would invert memory against disk — the
       click's value POSTs, but memory holds the disk value, so the reader's
       next toggle no-ops on the equality guard and the wrong state sticks. */
    this.data = { ...disk, ...this.data };
  },
  get(key, dflt) {
    return key in this.data ? this.data[key] : dflt;
  },
  set(key, value) {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.pending[key] = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const patch = this.pending;
      this.pending = {};
      fetch("/api/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {}); // lost prefs must never take the review down
    }, 250);
  },
};

/* Panel geometry restores by splitter target id; the splitter's mouseup is the
   single writer, so a size that was never touched is never stored. */
const PANEL_DIMS = { sidebar: "width", leftPane: "width", commitPane: "height", timelinePane: "height", commitInfo: "height" };
function applyPanelPrefs() {
  for (const [id, dim] of Object.entries(PANEL_DIMS)) {
    const v = +Prefs.get("panel." + id);
    if (v) document.getElementById(id).style[dim] = v + "px";
  }
  if (Prefs.get("panel.sidebarOff") && !$("#sidebar").classList.contains("off")) toggleSidebar();
  /* Set before the first fetch, not through setIgnoreWs: there is nothing
     loaded yet to throw away, and the refetch would race the boot one. */
  S.ignoreWs = !!Prefs.get("diff.ignoreWs");
  $("#segWs").classList.toggle("active", S.ignoreWs);
}

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
        // Where the reading was, for the next session to come back to.
        where: { scope: scopeId(), name: S.scopeName, file: S.selFile },
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

/* Resume the scope and file the last session was reading.
 *
 * A hint, never a demand: the scope may not exist any more (a commit rebased
 * away, a branch deleted), and a scope that resolves to nothing is worse than
 * the default — the reader is dropped into an empty review of something they
 * cannot see. So it counts as resumed only if it actually has files, and the
 * caller falls back to the ordinary boot choice otherwise. */
async function resumeWhere() {
  const w = S.ov && S.ov.draft && S.ov.draft.where;
  if (!w || !w.scope) return false;
  let scope;
  try {
    scope = Scope.parse(w.scope);
  } catch {
    return false; // a draft written by an older build, or a hand-edited file
  }
  await setScope(scope, w.name || Scope.label(scope));
  if (!S.files.length) return false;
  // After the files land, not before: scrollToFile needs the segment to exist.
  if (w.file && S.files.some((f) => f.path === w.file)) scrollToFile(w.file);
  return true;
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
  /* The scope is snapshotted now, not read at save: the popover has no
     backdrop, so the reader can switch scope (a timeline click is a normal
     "which commit did this?" move) with a draft open — and the comment's line
     anchor belongs to the diff it was opened against, so its tag must too. */
  S.popFor = { file, side, line, id: existing ? existing.id : null, scope: S.scope, meta: S.commitMeta };
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
  deleteAnn(S.popFor.id);
  closePopover();
};

/* Deleting a comment throws away unsent work, and there is no dialog in the
   way — by design, because a confirm on every delete is worse than the
   accident it prevents. So the accident is made cheap instead: one deletion is
   held aside, and a toast says so until it is undone or replaced.

   Every delete goes through here. There were two call sites, each with its own
   copy of the filter, and an undo bolted onto one of them would have been an
   undo the reader could not predict. */
let undone = null;
let toastTimer = null;
function deleteAnn(id) {
  const i = S.ann.findIndex((a) => a.id === id);
  if (i < 0) return;
  undone = { a: S.ann[i], i };
  S.ann.splice(i, 1);
  changed();
  toast(`Comment on ${undone.a.file.split("/").pop()} deleted.`);
}

function undoDelete() {
  if (!undone) return;
  // Back where it was, not appended — the rule lives in RM so node test.js
  // can hold it.
  S.ann = RM.insertAt(S.ann, undone.a, undone.i);
  undone = null;
  hideToast();
  changed();
}

function toast(text) {
  $("#toastText").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  /* Ten seconds, then the offer expires with the toast — an Undo that is no
     longer on screen must not still be live under ⌘Z. */
  toastTimer = setTimeout(() => {
    undone = null;
    hideToast();
  }, 10000);
}
function hideToast() {
  clearTimeout(toastTimer);
  $("#toast").hidden = true;
}
$("#toastUndo").onclick = undoDelete;
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
  // Tagged at creation, never re-tagged — the rule lives in RM.annCommit so
  // node test.js can hold it. The scope comes from the popover's snapshot,
  // not the live S.scope: the scope may have moved while the draft was open.
  const i = S.ann.findIndex((a) => a.id === rec.id);
  const tag = RM.annCommit(i >= 0 ? S.ann[i] : null, p.scope, p.meta);
  if (tag) rec.commit = tag;
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
  renderDiff();
  updateFoldToggle(); // selection changes come through here, not rebuildStream
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
  // The file's diff may not have arrived yet — early after boot/scope switch,
  // or because scrollToFile just re-selected a file that was deselected. Wait
  // for it rather than racing rowIndexFor against a loading placeholder. Only
  // for a stream jump: on the tree tab loadFileDiff's rebuildStream() would
  // run buildItems against the stream and stomp renderTreeFile's own state
  // (e.g. its "Could not read this file" note) with the stream's empty hint.
  if (S.tab !== "tree" && !(S.perFile.get(a.file) || {}).loaded) await loadFileDiff(a.file);
  // Line numbers repeat across a stream, so the file has to be part of the match.
  const target = RM.rowIndexFor(S.items, a.side, a.line, a.file);
  if (target >= 0) {
    diffVL.scrollToIndex(target, true);
    // A comment at the stream's bottom cannot scroll to the top of the pane;
    // the pin is how every other jump keeps the sticky header honest here.
    pinAfterScroll(a.file);
  }
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
/* A review is often worth more than one place — the agent acts on it, and the
   same words belong in the PR a human will read. Rendered by the server, by
   the one renderer that produces what the agent gets, so the pasted version
   cannot drift into being a second opinion of the review. */
$("#modalCopy").onclick = async (e) => {
  const btn = e.currentTarget;
  const say = (msg) => {
    btn.textContent = msg;
    setTimeout(() => (btn.textContent = "Copy markdown"), 1600);
  };
  try {
    const r = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: pendingDecision,
        summary: $("#modalSummary").value,
        annotations: pendingDecision === "dismissed" ? [] : S.ann,
        scope: S.scope,
      }),
    });
    const { markdown } = await r.json();
    if (!markdown) return say("Nothing to copy");
    await navigator.clipboard.writeText(markdown);
    say("Copied ✓");
  } catch {
    // Nothing was sent and nothing was lost; the modal is still open and Send
    // still works. Saying so beats a silent no-op.
    say("Copy failed");
  }
};
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
  // Only openModal clears this, so a disabled Send modal opened earlier would
  // leave the discard button dead — and ⌘⏎ now honours it.
  $("#modalConfirm").disabled = false;
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
      let d = (horiz ? ev.clientX : ev.clientY) - start;
      // A splitter above its target (the timeline pane) grows it by dragging up.
      if (sp.classList.contains("invert")) d = -d;
      // The floor is per target: the info card's natural height sits below the
      // default, and a shared 120 would snap it open on the first pixel.
      const v = Math.max(+sp.dataset.min || 120, base + d);
      if (horiz) target.style.width = v + "px";
      else target.style.height = v + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      Prefs.set("panel." + sp.dataset.target, horiz ? target.offsetWidth : target.offsetHeight);
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
    // A peer of the Send button, not a way around it: the modal has already
    // decided whether this submit is allowed, and said so on screen.
    else if (!$("#modal").hidden) { if (!$("#modalConfirm").disabled) submit(pendingDecision); }
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
  /* After the `typing` guard, deliberately: inside a comment box ⌘Z is the
     browser's own undo, and taking that away to restore a different comment
     would be the more surprising of the two. */
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && undone) {
    e.preventDefault();
    undoDelete();
    return;
  }
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
      setFullOnCurrent(!isFull(S.selFile));
      break;
    case "w":
      setIgnoreWs(!S.ignoreWs);
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
    case "b":
      toggleSidebar();
      break;
  }
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(async function boot() {
  measureChar();
  const [ov] = await Promise.all([api("overview"), Prefs.load()]);
  S.ov = ov;
  applyPanelPrefs(); // before the first paint, so nothing visibly jumps
  document.title = `${S.ov.name} — diffotator`;
  $("#repoName").textContent = S.ov.title || S.ov.name;
  $("#branchChip").textContent = "⑂ " + S.ov.branch;
  loadDraft();
  render();
  await loadCommits(false); // the initial scope below owns what gets shown
  if (await resumeWhere()) return;
  await setScope({ type: "worktree" }, "Local Changes");
  if (!S.files.length && S.ov.base) {
    await setScope({ type: "range", base: S.ov.base.ref, head: "HEAD" }, "Branch");
  }
})();
