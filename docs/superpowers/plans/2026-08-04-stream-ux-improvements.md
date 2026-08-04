# Stream UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the five upstream UX issues (adisagar2003/diffotator #20–#24) against the stacked diff stream: sidebar checklist/minimap, working sticky mini-header, `v`-loop cursor sync + finish state, Tree-tab checkboxes, and two polish fixes.

**Architecture:** All pure logic lands in `web/review-model.js` (Node-loadable IIFE, tested by `node test.js`); all DOM work lands in `web/app.js` + `web/style.css` + `web/index.html`. One branch (`ux/stream-improvements`, off `feat/stacked-diff-stream`), one commit group per issue so the work can later be split into per-issue upstream PRs by cherry-pick.

**Tech Stack:** Vanilla JS, zero dependencies, no build step. Tests: `node test.js`.

**Spec:** `docs/superpowers/specs/2026-08-04-stream-ux-improvements-design.md`

## Global Constraints

- `web/review-model.js` stays Node-loadable (no DOM references); pure logic goes there, tested via `node test.js`.
- GEOM values in review-model.js must match `web/style.css` px-for-px (row 20px, fileHeader 32px, under `* { box-sizing: border-box }` so borders count inside the height). Any new in-stream item kind needs a GEOM entry AND a CSS height that agree exactly.
- The sticky bar `#diffHeader` (`.diff-header`) is OUTSIDE the virtual list — its height is NOT a GEOM value and may change freely.
- Zero dependencies, no build step.
- All persisted UI state stays scoped by `viewKey(path)` (= `scopeId() + "|" + path`).
- `node test.js` must pass at the end of every task.
- Commit messages reference the upstream issue number (e.g. `(#22)`); do NOT write `fixes #NN` (auto-close phrasing is decided at PR time).

## Reference: current code landmarks (web/app.js @ branch point)

- `renderFileTree()` app.js:551 — full innerHTML rebuild of `#fileTree`.
- `fileRow(path, m, depth, label)` app.js:688 — one sidebar row; `.selbox` checkbox is gated by `S.tab !== "tree" && m` (app.js:711-714); viewed ✓ lives in `<span class="caret">${seen ? "✓" : ""}</span>` (app.js:716).
- `selAllClick(e)` app.js:748 — shared delegate for `[data-selall]`/`[data-selnone]`; wired to `.filter-row` (app.js:753) and as the fall-through of the `#diffBody` click handler (app.js:1363).
- `setCollapsed(path, on)` app.js:623 — one file: mutate `S.collapsed`, `rebuildStream()`, `refocusOutOf`, `saveDraft()`.
- `rebuildStream()` app.js:836 — buildItems + refresh/empty-hint + renderProgress + revalidatePin + updateStickyHeader(true).
- `scrollToFile(path)` app.js:846 — jump; calls `renderFileTree()` at app.js:865 just to move the `.sel` highlight.
- `updateStickyHeader(force)` app.js:1283 — writes `#diffHeader` innerHTML; on file change calls `renderFileTree()` (app.js:1298) just to move `.sel`.
- `#diffHeader` click handler app.js:1366 — only `[data-nav]` today.
- `#diffBody` click handler app.js:1324 — `.fsh` collapse, folds, comment edit/del, gutters, then `selAllClick` fall-through.
- `toggleViewed(on)` app.js:1519 — the `v` path: setViewed → setCollapsed(true) → `nextUnviewed()` → `scrollToFile(nx)`.
- `moveFocus(dir)` app.js:1437, `refocusOutOf(path)` app.js:642.
- `#cpList` click app.js:1714 — jump-to-comment; second `scrollToIndex` at app.js:1725 with no `pinAfterScroll`.
- `ROW_HTML` table app.js:1036 — `comment`/`fold`/`fileHeader`/`loading`/`note`/`row` renderers; `loading` renders `class="fold"` (app.js:1081).
- review-model.js: `GEOM` :22, `itemHeight` :60, `buildStream` :216, `isChangeRow` :277, `rowLine` :282, exports block :424.
- style.css: `.tnode.seen .caret` :46, `.selall` :184, `.diff-header` :189 (height 29px), `.fold` :261, `.fsh` :270, `.fold.note` :287.
- index.html: `all · none` buttons line 69 inside `.filter-row`.

---

### Task 1: Sidebar checklist + incremental highlight (issue #22)

**Files:**
- Modify: `web/app.js` (add `updateTreeSel`, `collapseAll`; edit `updateStickyHeader`, `scrollToFile`, `selAllClick`)
- Modify: `web/index.html:69` (fold/unfold buttons)
- Modify: `web/style.css` (bolder viewed ✓; nothing else)

**Interfaces:**
- Consumes: `S.selFile`, `S.collapsed`, `viewKey`, `isSelected`, `rebuildStream`, `refocusOutOf`, `saveDraft`, `renderFileTree`.
- Produces: `updateTreeSel(path)` — moves the sidebar `.sel` highlight incrementally and scrolls it into view; `collapseAll(on)` — folds/unfolds every selected file in one rebuild. Task 2+ rely on `updateTreeSel` existing.

- [ ] **Step 1: Add `updateTreeSel` and use it in the two scroll-path callers**

Insert after `renderFileTree()` (below app.js:589):

```js
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
```

In `updateStickyHeader` (app.js:1296-1300) replace the `renderFileTree()` call:

```js
  if (S.selFile !== seg.file) {
    S.selFile = seg.file;
    updateTreeSel(seg.file); // incremental: scroll crossings must not rebuild the pane
    syncViewedToggle();
  }
```

In `scrollToFile` (app.js:865) replace `renderFileTree();` with `updateTreeSel(path);`.

`render()`/`renderFileTree()` still do full rebuilds on state changes (selection, viewed, comments) — only the scroll path goes incremental.

- [ ] **Step 2: Add `collapseAll` and the fold/unfold buttons**

Insert after `setCollapsed` (below app.js:631):

```js
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
```

In `selAllClick` (app.js:748) add two branches before `return false`:

```js
  if (e.target.closest("[data-foldall]")) return collapseAll(true), true;
  if (e.target.closest("[data-unfoldall]")) return collapseAll(false), true;
```

In `web/index.html` line 69, after the existing selall span, add:

```html
            <span class="selall" title="Fold or unfold every file in the stream"><button data-foldall>fold</button>·<button data-unfoldall>unfold</button></span>
```

- [ ] **Step 3: Make the viewed ✓ read as a checkmark, not a dim row**

In `web/style.css` replace line 46:

```css
.tnode.seen .caret{color:var(--ok);opacity:1;font-size:11px;font-weight:700}
```

(Was `font-size:10px`, no weight. The `.tnode.seen .nm` dimming on line 45 stays — the ✓ becomes the primary signal, the dim stays secondary.)

- [ ] **Step 4: Run tests**

Run: `node test.js`
Expected: PASS (no model changes in this task; the suite guards against accidental breakage).

- [ ] **Step 5: Commit**

```bash
git add web/app.js web/index.html web/style.css
git commit -m "feat(sidebar): review checklist — bold viewed ✓, fold/unfold all, live highlight without rebuilds (#22)"
```

---

### Task 2: Sticky header becomes a working mini file-header (issue #21)

**Files:**
- Modify: `web/app.js` (`updateStickyHeader` markup, `#diffHeader` click handler)
- Modify: `web/style.css` (`.diff-header` 29px → 32px; caret/checkbox styles)

**Interfaces:**
- Consumes: `updateTreeSel` (Task 1), `isCollapsed`, `setCollapsed`, `isViewed`, `setViewed`, `scrollToFile`, `jumpChange`.
- Produces: sticky bar controls `[data-shfold]`, `[data-shviewed]`, `[data-shjump]`. No later task depends on them.

- [ ] **Step 1: Rewrite the sticky header markup**

In `updateStickyHeader` (app.js:1303-1308) replace the `head.innerHTML = ...` statement with:

```js
  const collapsed = isCollapsed(seg.file);
  const viewed = isViewed(seg.file);
  head.innerHTML = `
    <span class="caret" data-shfold title="${collapsed ? "Expand" : "Collapse"} this file">${collapsed ? "▸" : "▾"}</span>
    <span class="shbox${viewed ? " on" : ""}" data-shviewed title="Mark viewed — does not fold the file">${viewed ? "☑" : "☐"}</span>
    <span class="fp" data-shjump title="${esc(seg.file)} — click to jump to the top of this file"><b>${esc(seg.file)}</b></span>
    <span class="plus">+${f.additions ?? 0}</span><span class="minus">−${f.deletions ?? 0}</span>
    <span class="grow"></span>
    <span class="pos">${i + 1} of ${S.segments.length}</span>
    <div class="nav"><button data-nav="prev" title="Previous change (p)">▲</button><button data-nav="next" title="Next change (n)">▼</button></div>`;
```

(The `f`, `i`, `seg`, `head` bindings already exist in the function. The tree tab is untouched: `updateStickyHeader` returns early there and `renderTreeFile` writes its own header with `dataset.file = ""`.)

- [ ] **Step 2: Extend the `#diffHeader` click handler**

Replace the handler at app.js:1366-1369 with:

```js
$("#diffHeader").addEventListener("click", (e) => {
  const b = e.target.closest("[data-nav]");
  if (b) return jumpChange(b.dataset.nav === "next" ? 1 : -1);
  // The three mini-header controls act on the file the bar names. The tree
  // tab's header sets dataset.file = "" and has none of these controls.
  const file = $("#diffHeader").dataset.file;
  if (!file) return;
  if (e.target.closest("[data-shfold]")) return setCollapsed(file, !isCollapsed(file));
  if (e.target.closest("[data-shviewed]")) return setViewed(file, !isViewed(file)); // viewed only — v's auto-fold stays on v
  if (e.target.closest("[data-shjump]")) return scrollToFile(file);
});
```

(`setViewed` → `changed()` → `render()` → `renderDiff()` → `updateStickyHeader(true)` repaints the checkbox glyph; `setCollapsed` → `rebuildStream()` does the same for the caret.)

- [ ] **Step 3: CSS — 32px bar + control styles**

In `web/style.css`, in the `.diff-header` block (line 189), change `height:29px` to `height:32px`. Then add, after `.diff-header .nav button` (line 204):

```css
.diff-header .caret{width:11px;flex:0 0 auto;color:var(--muted);font-size:9px;cursor:pointer}
.diff-header .caret:hover{color:var(--text)}
.diff-header .shbox{cursor:pointer;flex:0 0 auto;font-size:11px;opacity:.8}
.diff-header .shbox:hover{opacity:1}
.diff-header .shbox.on{color:var(--accent)}
.diff-header .fp{cursor:pointer}
.diff-header .fp:hover b{text-decoration:underline}
```

(The bar is outside the virtual list — no GEOM change. Verify: `grep -n "fileHeader" web/review-model.js` still says 32 and `.fsh` in style.css still says 32px.)

- [ ] **Step 4: Run tests**

Run: `node test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/app.js web/style.css
git commit -m "feat(header): sticky bar is a working mini file-header — jump, fold, viewed (#21)"
```

---

### Task 3: `v` loop — cursor sync + "all viewed" finish state (issue #20)

**Files:**
- Modify: `web/review-model.js` (GEOM entry, `itemHeight`, `buildStream` finish item, `firstChangeRowIn`, exports)
- Modify: `web/app.js` (S field, `anchorFocusIn`, `toggleViewed`, `rebuildStream`, `moveFocus`, `ROW_HTML.allviewed`, `#diffBody` click branches)
- Modify: `web/style.css` (`.avc` card, exactly GEOM height)
- Test: `test.js`

**Interfaces:**
- Consumes: `RM.buildStream` item/segment shapes, `isChangeRow`/`rowLine` (model-internal), `openModal(decision)` app-side.
- Produces: model item kind `{k:"allviewed", n:<selectedCount>, comments:<annotationCount>}` appended as the LAST item when every selected file is **viewed AND collapsed** (the state the `v` loop leaves behind — derived, never stored); `RM.firstChangeRowIn(items, segments, file)` → `{index, side, line}` or `null`; `RM.GEOM.allViewed = 96`; app-side `S.pendingFocusFile` and `anchorFocusIn(path)`.

- [ ] **Step 1: Write the failing model tests**

In `test.js` (it uses Node's `assert` module — `assert.ok(cond, msg)`), locate the existing `buildStream` test block (search for `buildStream`) and add this block after it:

```js
// --- allviewed finish item + firstChangeRowIn ------------------------------
{
  const files = [
    { path: "a.js", additions: 1, deletions: 0 },
    { path: "b.js", additions: 1, deletions: 0 },
  ];
  const rows = [
    { t: "ctx", o: 1, n: 1, s: "one" },
    { t: "add", n: 2, s: "two" },
  ];
  const pf = new Map([
    ["a.js", { loaded: true, rows, expanded: new Set(), full: false }],
    ["b.js", { loaded: true, rows, expanded: new Set(), full: false }],
  ]);
  const sel = new Set(["a.js", "b.js"]);

  const done = RM.buildStream({
    files, selected: sel, collapsed: new Set(sel), perFile: pf,
    annotations: [{ file: "a.js", side: "new", line: 2, body: "x" }],
    viewedSet: new Set(sel),
  });
  const last = done.items[done.items.length - 1];
  assert.ok(last.k === "allviewed", "all viewed + all folded → finish item appended last");
  assert.ok(last.n === 2 && last.comments === 1, "finish item carries file and comment counts");
  assert.ok(done.segments.length === 2, "finish item is not a segment");

  const reading = RM.buildStream({ files, selected: sel, collapsed: new Set(), perFile: pf, viewedSet: new Set(sel) });
  assert.ok(!reading.items.some((it) => it.k === "allviewed"), "a file unfolded → still reading, no finish item");

  const part = RM.buildStream({ files, selected: sel, collapsed: new Set(["a.js"]), perFile: pf, viewedSet: new Set(["a.js"]) });
  assert.ok(!part.items.some((it) => it.k === "allviewed"), "one unviewed file → no finish item");

  const none = RM.buildStream({ files, selected: new Set(), collapsed: new Set(), perFile: pf, viewedSet: new Set() });
  assert.ok(!none.items.some((it) => it.k === "allviewed"), "empty selection → no finish item");

  assert.ok(RM.itemHeight({ k: "allviewed" }, 80) === RM.GEOM.allViewed, "allviewed row uses its GEOM height");

  const hit = RM.firstChangeRowIn(reading.items, reading.segments, "b.js");
  assert.ok(hit && hit.side === "new" && hit.line === 2, "firstChangeRowIn skips ctx, finds the add");
  assert.ok(reading.items[hit.index].f === "b.js", "firstChangeRowIn stays inside the file");

  const pf2 = new Map([["a.js", { loaded: true, rows, expanded: new Set(), full: false }]]);
  const loading = RM.buildStream({ files, selected: sel, collapsed: new Set(), perFile: pf2 });
  assert.ok(RM.firstChangeRowIn(loading.items, loading.segments, "b.js") === null, "unloaded file → null");
  assert.ok(RM.firstChangeRowIn(reading.items, reading.segments, "zzz.js") === null, "unknown file → null");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test.js`
Expected: FAIL — `firstChangeRowIn` is not a function / `allviewed` assertions fail.

- [ ] **Step 3: Implement the model half**

In `web/review-model.js`:

(a) In `GEOM` (line 22), add `allViewed: 96,` (matches `.avc` height in style.css exactly — border-box).

(b) In `itemHeight` (line 60), add before the comment-kind line:

```js
    if (item && item.k === "allviewed") return GEOM.allViewed;
```

(c) In `buildStream` (line 216), before the `return` statement, append the finish item:

```js
    // The review's finish line: every selected file viewed AND folded — the
    // state the v loop leaves behind. Derived, never stored: an item, not
    // app-side chrome, so it scrolls, windowing prices it, and any rebuild
    // that breaks the condition (un-view, un-fold, re-select) removes it.
    if (shown.length && shown.every((f) => viewedSet.has(f.path) && collapsed.has(f.path))) {
      items.push({ k: "allviewed", n: shown.length, comments: annotations.length });
    }
```

(d) After `nextUnviewed` (line 366-374), add:

```js
  /** First changed row inside `file`'s segment, as {index, side, line}, or
      null (file collapsed/loading/absent). Where the cursor should land when
      a jump brings the reader to this file. */
  function firstChangeRowIn(items, segments, file) {
    const seg = segments.find((s) => s.file === file);
    if (!seg) return null;
    for (let i = seg.start; i < seg.end; i++) {
      if (isChangeRow(items[i])) {
        const l = rowLine(items[i]);
        if (l) return { index: i, side: l.side, line: l.line };
      }
    }
    return null;
  }
```

(e) In the exports block (line 424+), add `exp.firstChangeRowIn = firstChangeRowIn;`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test.js`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Implement the app half**

In `web/app.js`:

(a) Find the `S` state object literal (search `const S = {` near the top) and add the field `pendingFocusFile: null,` with the other focus-related fields.

(b) After `moveFocus` (app.js:1446), add:

```js
/** Land the cursor on the first change of `path` — the row the viewport just
    scrolled to — so the next n/↓ continues from what the reader is looking at.
    A still-loading segment has no honest row yet; remember the intent and
    rebuildStream promotes it when the rows arrive. */
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
```

(c) In `moveFocus` (app.js:1437), first line of the function body, add `S.pendingFocusFile = null;` — the reader moving the cursor by hand cancels any pending anchor.

(d) In `rebuildStream` (app.js:836), after `updateStickyHeader(true);`, add:

```js
  if (S.pendingFocusFile) {
    const st = S.perFile.get(S.pendingFocusFile);
    if (st && st.loaded) anchorFocusIn(S.pendingFocusFile);
  }
```

(e) Replace `toggleViewed` (app.js:1519-1526) with:

```js
function toggleViewed(on) {
  if (!S.selFile) return;
  setViewed(S.selFile, on);
  if (!on) return;
  setCollapsed(S.selFile, true); // GitHub's move: what you have read folds away
  const nx = nextUnviewed();
  if (nx) {
    scrollToFile(nx);
    anchorFocusIn(nx); // cursor and viewport must agree after v
  } else if (S.items.length) {
    // Last v of the review: bring the finish card (last item) into view.
    diffVL.scrollToIndex(S.items.length - 1, true);
  }
}
```

(f) In `ROW_HTML` (app.js:1036), add a renderer after `note`:

```js
  /** The review's finish line — appears when every selected file is viewed. */
  allviewed(item, top) {
    return `<div class="avc" style="top:${top}px">
      <div class="av-title">All ${item.n} file${item.n === 1 ? "" : "s"} viewed 🎉</div>
      <div class="av-sub">${item.comments ? `${item.comments} comment${item.comments === 1 ? "" : "s"} drafted` : "No comments drafted"}</div>
      <div class="av-act">${
        item.comments
          ? `<button data-finish-send>Send feedback</button><span class="av-hint">⌘⏎</span>`
          : `<button data-finish-approve>Approve</button>`
      }</div>
    </div>`;
  },
```

(g) In the `#diffBody` click handler (app.js:1324), before the final `selAllClick(e);` fall-through, add:

```js
  if (e.target.closest("[data-finish-send]")) return openModal("annotated");
  if (e.target.closest("[data-finish-approve]")) return openModal("approved");
```

(h) In `web/style.css`, after `.fold.note:hover` (line 288), add — the 96px height MUST equal `RM.GEOM.allViewed`:

```css
/* The finish card. Height is exactly RM.GEOM.allViewed (96) — border-box, so
   the borders live inside it — or the prefix-sum index drifts. */
.avc{
  position:absolute;left:0;right:0;height:96px;box-sizing:border-box;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
  background:var(--panel);border-top:1px solid var(--border);font-family:var(--ui)
}
.avc .av-title{font-size:14px;font-weight:600;color:var(--text)}
.avc .av-sub{font-size:12px;color:var(--muted)}
.avc .av-act{display:flex;align-items:center;gap:8px;margin-top:2px}
.avc .av-act button{
  padding:3px 12px;border-radius:5px;border:1px solid var(--border);
  background:var(--elev);color:var(--text);cursor:pointer;font-size:12px
}
.avc .av-act button:hover{background:var(--elev2)}
.avc .av-hint{font-size:11px;color:var(--muted)}
```

- [ ] **Step 6: Run tests**

Run: `node test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/review-model.js web/app.js web/style.css test.js
git commit -m "feat(v-loop): cursor lands where the viewport lands; finish card nudges send/approve (#20)"
```

---

### Task 4: Selection checkboxes in the Tree tab (issue #23)

**Files:**
- Modify: `web/app.js:709-714` (the `box` expression in `fileRow`)

**Interfaces:**
- Consumes: `isSelected`, `setSelected` (unchanged), the `#fileTree` click delegate (already answers `.selbox` before `.tnode[data-file]`, app.js:738-742 — works on every tab).
- Produces: nothing new — same `.selbox[data-sel]` contract on both tabs.

- [ ] **Step 1: Drop the tab gate**

In `fileRow` (app.js:709-714), replace the `box` declaration and its comment with:

```js
  /* Only changed files can be in the stream, so only they get a checkbox — on
     every tab. The File Tree lists the whole repo; its unchanged files have no
     meta (`m`) and therefore nothing to select. */
  const box = m
    ? `<span class="selbox${isSelected(path) ? " on" : ""}" data-sel="${esc(path)}">${isSelected(path) ? "☑" : "☐"}</span>`
    : "";
```

- [ ] **Step 2: Run tests**

Run: `node test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/app.js
git commit -m "feat(tree): selection checkboxes on changed files in the Tree tab too (#23)"
```

---

### Task 5: Polish — inert loading rows, jump-to-comment keeps the pin (issue #24)

**Files:**
- Modify: `web/app.js` (`ROW_HTML.loading` class, `#cpList` click handler)
- Modify: `web/style.css` (`.fold.loading` rules)

**Interfaces:**
- Consumes: `pinAfterScroll(file)` (existing), `.fold.note` styling pattern.
- Produces: nothing new.

- [ ] **Step 1: Loading rows stop looking clickable**

In `ROW_HTML.loading` (app.js:1080-1082) change the class:

```js
  loading(item, top) {
    return `<div class="fold loading" style="top:${top}px">Loading ${esc(item.f)}…</div>`;
  },
```

In `web/style.css`, after the `.fold.note:hover` rule (line 288), add:

```css
/* In flight, not clickable — same shape as a fold, none of the affordance. */
.fold.loading{cursor:default}
.fold.loading:hover{background:#1f2226;color:var(--muted)}
```

- [ ] **Step 2: Jump-to-comment tells the pin**

In the `#cpList` click handler (app.js:1724-1725), after the `scrollToIndex`:

```js
  const target = RM.rowIndexFor(S.items, a.side, a.line, a.file);
  if (target >= 0) {
    diffVL.scrollToIndex(target, true);
    // A comment at the stream's bottom cannot scroll to the top of the pane;
    // the pin is how every other jump keeps the sticky header honest here.
    pinAfterScroll(a.file);
  }
```

- [ ] **Step 3: Run tests**

Run: `node test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/app.js web/style.css
git commit -m "fix(stream): inert loading rows; jump-to-comment keeps the sticky header honest (#24)"
```

---

### Task 6: README + integration verification

**Files:**
- Modify: `README.md` (the review-loop section)

**Interfaces:**
- Consumes: everything above.
- Produces: docs; a green suite for the finishing skill.

- [ ] **Step 1: Document the new affordances**

In `README.md`, find the section describing the review loop / stream (search for "viewed" or "stream"). Add or amend — matching the file's existing voice and formatting — coverage of exactly these four points, one sentence each:

1. The sticky bar above the diff is the current file's header: click the path to jump to its top, the caret to fold it, the checkbox to mark it viewed.
2. `fold · unfold` beside `all · none` collapses or expands every file in the stream.
3. When every selected file is viewed, a finish card appears with Send feedback (`⌘⏎`) or Approve.
4. Checked-file boxes appear in both List and Tree tabs.

- [ ] **Step 2: Full suite**

Run: `node test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README covers sticky mini-header, fold/unfold all, finish card, tree checkboxes"
```

(The controller runs the headless-browser walkthrough after the final review — not part of this task.)
