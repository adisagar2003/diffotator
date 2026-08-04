# Stacked Diff Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-file-at-a-time diff pane with a single continuous, windowed stream of all selected files' diffs (GitHub "Files changed", locally), with per-file selection checkboxes, collapsible sticky file headers, and the `v` viewed loop intact — plus wire up the dead `--base` CLI flag.

**Architecture:** All selected files' diff rows are concatenated into the one existing windowed virtual list (`vlist` in `web/app.js`), separated by new fixed-height `fileHeader` items. The concatenation is built by a new pure function `buildStream` in `web/review-model.js` (tested from `test.js`). Per-file state (`rows`, fold-expansions, full-file) moves from singletons on `S` into a `Map` keyed by path. Diffs are still fetched per file on demand, a few at a time; unloaded files occupy a header + fixed-height loading row so the prefix-sum height index stays exact. The File Tree tab keeps today's single-file behavior.

**Tech Stack:** Vanilla JS (no dependencies, `"use strict"` IIFE modules loadable from Node and browser), Node ≥ 18, `node test.js` with `assert`.

**Spec:** `docs/superpowers/specs/2026-08-04-stacked-diff-stream-design.md`

## Global Constraints

- Zero npm dependencies, Node ≥ 18. Nothing added to `package.json`.
- Perf contract (from `web/app.js` header): git data fetched per file on demand, never inlined; long lists windowed; row heights **derived, never measured**; highlighting on visible rows only.
- `web/review-model.js` and `web/keys.js` must stay loadable from both Node and browser (IIFE + `module.exports`/`window.*`) with **no DOM, no globals, no fetch**.
- Code style: match existing — 100-col-ish, double quotes, comments explain *why* (constraints), not *what*.
- Work on branch `feat/stacked-diff-stream` (created from `main` in Task 1).
- After every task: `node test.js` must pass fully.
- GEOM heights in `review-model.js` must match `web/style.css` pixel-for-pixel; new `fileHeader` height is **32px** in both places.

---

### Task 1: Branch + `--base` flag actually reaches base detection

The README advertises `diffotator --base origin/main`, but `parseArgs` collects `o.base` and `main()` never passes it on (`bin/diffotator.js:152` calls `serveReview(root, { open, port, title })`). Fix by threading it to `overview()`, where a forced ref becomes the first candidate in `detectBase` — reusing its existing validation (ref exists, merge-base differs from HEAD) gives the "fall back to auto-detect when invalid" behavior for free.

**Files:**
- Modify: `src/git.js:61` (`detectBase`), `src/git.js:84` (`overview`)
- Modify: `src/server.js:76` (overview route), `src/server.js:143` (`createServer`)
- Modify: `bin/diffotator.js:72` (`serveReview`), `bin/diffotator.js:152` (call site)
- Test: `test.js` (git fixture section — it already builds throwaway repos with `execFileSync`)

**Interfaces:**
- Produces: `G.overview(root, { base } = {})`; `G.detectBase(root, head, forced)`; `createServer({ root, title, base })`; `serveReview(root, { open, port, title, base })`.

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git checkout -b feat/stacked-diff-stream
```

- [ ] **Step 2: Write the failing test**

In `test.js`, find the git-fixture section (search for `execFileSync`; a helper builds a temp repo — follow its local conventions exactly). Add, inside that section, after the existing fixture repo has ≥1 commit on a branch:

```js
// --base must actually pin the base: the flag used to be parsed and dropped.
{
  const run = (args) => execFileSync("git", ["-C", tmp, ...args], { encoding: "utf8" });
  run(["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(tmp, "feat.txt"), "feature work\n");
  run(["add", "."]);
  run(["commit", "-qm", "feature commit"]);
  run(["branch", "-q", "sidebranch", "main"]); // a second valid base candidate

  const forced = await G.overview(tmp, { base: "sidebranch" });
  assert.strictEqual(forced.base && forced.base.ref, "sidebranch", "--base pins the base");

  const bogus = await G.overview(tmp, { base: "no-such-ref" });
  assert.ok(bogus.base && bogus.base.ref !== "no-such-ref", "invalid --base falls back to auto-detect");
}
```

Adapt `tmp`/branch names to what the fixture actually uses (its default branch may be `main` or `master` — check `run(["rev-parse", "--abbrev-ref", "HEAD"])` output in the existing fixture code). If the fixture section is synchronous, wrap in the same async pattern the neighboring git tests use.

- [ ] **Step 3: Run it, verify it fails**

Run: `node test.js`
Expected: FAIL — `overview` ignores the second argument, so `forced.base.ref` is the auto-detected ref, not `"sidebranch"`.

- [ ] **Step 4: Implement**

`src/git.js` — `detectBase` takes the forced ref as first candidate:

```js
async function detectBase(root, head, forced) {
  const candidates = [];
  if (forced) candidates.push(forced); // --base: first in line, same validation as the rest
  const upstream = (
    await probe(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
  ).trim();
  if (upstream) candidates.push(upstream);
  // ... rest unchanged
```

`overview` signature and the `detectBase` call:

```js
async function overview(root, { base } = {}) {
  // ...
    detectBase(root, branch, base),
```

`src/server.js`: `createServer({ root, title, base })`, and the route:

```js
"GET /api/overview": async ({ root, title, base }) => ({
  ...(await G.overview(root, { base })),
  title,
  draft: D.loadDraft(root),
}),
```

Pass `base` through the route context where `root, title` are passed (in the `http.createServer` handler's `route({...})` call).

`bin/diffotator.js`: `serveReview(root, { open = true, port = 0, title, base } = {})` →
`createServer({ root, title, base })`, and the call in `main()`:

```js
const { output } = await serveReview(root, {
  open: opts.open,
  port: opts.port || 0,
  title: opts.title,
  base: opts.base,
});
```

Also export `detectBase` if not already exported (check `module.exports` at the bottom of git.js; only export what the test needs — `overview` may be enough).

- [ ] **Step 5: Run tests, verify pass**

Run: `node test.js`
Expected: PASS (all existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/git.js src/server.js bin/diffotator.js test.js
git commit -m "fix(cli): --base now reaches base detection instead of being parsed and dropped"
```

---

### Task 2: Review model — `buildStream`

The pure heart of the feature. `buildStream` concatenates per-file `buildItems` output with `fileHeader` separators; collapsed files contribute the header only; unloaded files a header + fixed-height `loading` row; files git can't render (binary/too big/error/empty) a header + `note` row. Every item carries its file path and its segment's effective view, so the renderer never needs a global "current file".

**Files:**
- Modify: `web/review-model.js` (GEOM, `itemHeight`, `buildItems`, new `buildStream`, new `rowIndexFor` file filter)
- Test: `test.js` (review-model section, after the existing `buildItems` tests)

**Interfaces:**
- Consumes: existing `buildItems(input)` (unchanged signature).
- Produces:
  - `GEOM.fileHeader = 32`
  - `itemHeight(item, charsPerLine)` → 32 for `fileHeader`, `GEOM.row` for `loading`/`note`, unchanged otherwise.
  - Items now all carry `f` (path). Row items also carry `v` ("split"|"unified") and `sg` (singleGutter bool) stamped by `buildStream`.
  - `buildStream({files, selected, collapsed, perFile, annotations, view, viewedSet}) -> {items, segments, maxLineLen}`
    - `files`: ordered array `{path, additions, deletions, status, oldPath?}`
    - `selected`: `Set<path>` (raw paths, membership = in the stream)
    - `collapsed`: `Set<path>`
    - `perFile`: `Map<path, {loaded, rows, fullRows, expanded, full, binary, tooBig, error, empty, mode}>` (`expanded` is a `Set`, may be missing for unloaded files)
    - `viewedSet`: `Set<path>` (raw paths already resolved by the caller)
    - `segments`: array in stream order: `{file, start, end}` — `start` = index of the file's `fileHeader` item, `end` = exclusive.
  - `rowIndexFor(items, side, line, file)` — 4th arg optional; when given, only rows with `it.f === file` match (needed because line numbers repeat across files in a stream).

- [ ] **Step 1: Write the failing tests**

In `test.js`, inside/after the review-model block (reuse its `ctx`/row helpers style):

```js
// --- buildStream: many files, one windowed list ----------------------------
{
  const ctx = (i) => ({ t: "ctx", o: i, n: i, s: "line" + i });
  const mkRows = (n, changeAt) => {
    const rows = [];
    for (let i = 1; i <= n; i++) {
      if (i === changeAt) {
        rows.push({ t: "del", o: i, s: "old" + i });
        rows.push({ t: "add", n: i, s: "new" + i });
      } else rows.push(ctx(i));
    }
    return rows;
  };
  const files = [
    { path: "a.js", additions: 1, deletions: 1, status: "modified" },
    { path: "b.js", additions: 1, deletions: 1, status: "modified" },
    { path: "c.js", additions: 0, deletions: 0, status: "modified" },
  ];
  const perFile = new Map([
    ["a.js", { loaded: true, rows: mkRows(10, 5), expanded: new Set(), full: false }],
    ["b.js", { loaded: true, rows: mkRows(10, 5), expanded: new Set(), full: false }],
    // c.js not loaded yet
  ]);
  const base = {
    files,
    selected: new Set(["a.js", "b.js", "c.js"]),
    collapsed: new Set(),
    perFile,
    annotations: [],
    view: "unified",
    viewedSet: new Set(),
  };

  const out = RM.buildStream(base);
  assert.strictEqual(out.items[0].k, "fileHeader", "stream opens with a header");
  assert.strictEqual(out.items[0].f, "a.js");
  assert.strictEqual(out.segments.length, 3, "one segment per selected file");
  const segB = out.segments[1];
  assert.strictEqual(out.items[segB.start].k, "fileHeader");
  assert.strictEqual(out.items[segB.start].f, "b.js", "segments in file-list order");
  assert.ok(out.items.every((it) => it.f), "every stream item knows its file");
  const segC = out.segments[2];
  assert.strictEqual(out.items[segC.start + 1].k, "loading", "unloaded file holds a placeholder row");
  assert.strictEqual(RM.itemHeight(out.items[0]), RM.GEOM.fileHeader, "header height is fixed");
  assert.strictEqual(RM.itemHeight(out.items[segC.start + 1]), RM.GEOM.row, "loading row is row-height");

  // collapse: segment folds to its header
  const col = RM.buildStream({ ...base, collapsed: new Set(["a.js"]) });
  assert.strictEqual(col.segments[0].end - col.segments[0].start, 1, "collapsed file is header-only");
  assert.strictEqual(col.items[1].k, "fileHeader", "next header follows immediately");
  assert.strictEqual(col.items[1].f, "b.js");

  // selection: deselected file is absent entirely
  const sel = RM.buildStream({ ...base, selected: new Set(["b.js"]) });
  assert.strictEqual(sel.segments.length, 1);
  assert.ok(sel.items.every((it) => it.f === "b.js"), "deselected files leave no trace");

  // none selected: empty stream
  assert.strictEqual(RM.buildStream({ ...base, selected: new Set() }).items.length, 0);

  // binary/error file: header + note, no rows
  const pf2 = new Map(perFile);
  pf2.set("c.js", { loaded: true, binary: true });
  const bin = RM.buildStream({ ...base, perFile: pf2 });
  const segC2 = bin.segments[2];
  assert.strictEqual(bin.items[segC2.start + 1].k, "note", "binary renders as a note row");

  // regression: one selected, loaded file ≡ buildItems output plus its header
  const single = RM.buildStream({ ...base, selected: new Set(["a.js"]) });
  const legacy = RM.buildItems({
    rows: perFile.get("a.js").rows,
    annotations: [],
    file: "a.js",
    expanded: new Set(),
    full: false,
    view: "unified",
  });
  assert.strictEqual(single.items.length, legacy.items.length + 1, "stream = header + same items");
  assert.deepStrictEqual(
    single.items.slice(1).map((it) => it.k),
    legacy.items.map((it) => it.k),
    "same item kinds in the same order"
  );
  assert.strictEqual(single.maxLineLen, legacy.maxLineLen, "pan width carries over");

  // rowIndexFor with the file filter: same line number exists in both files
  const two = RM.buildStream({ ...base, selected: new Set(["a.js", "b.js"]) });
  const inB = RM.rowIndexFor(two.items, "new", 5, "b.js");
  assert.ok(inB > two.segments[1].start, "file-filtered lookup lands in b.js, not a.js");

  // the v-loop walks only the selected stream
  const sel2 = ["a.js", "c.js"]; // b.js deselected
  assert.strictEqual(RM.nextUnviewed(sel2, "a.js", (p) => p === "a.js"), "c.js", "next unviewed skips deselected files");
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node test.js`
Expected: FAIL — `RM.buildStream is not a function`.

- [ ] **Step 3: Implement in `web/review-model.js`**

1. GEOM: add `fileHeader: 32` after `row: 20`.
2. `itemHeight`:

```js
function itemHeight(item, charsPerLine) {
  if (item && item.k === "fileHeader") return GEOM.fileHeader;
  if (!item || item.k !== "comment") return GEOM.row; // rows, folds, loading, note
  return GEOM.cardHead + GEOM.cardPad + commentLines(item.a, charsPerLine) * GEOM.cardLine;
}
```

3. In `buildItems`, stamp the file on every item it pushes (three sites): `items.push({ k: "row", u, i, f: file })`, `items.push({ k: "comment", a, f: file })`, `items.push({ k: "fold", id, count: i - start, from: start, to: i, f: file })`.
4. New `buildStream`, placed after `buildItems`:

```js
/**
 * The whole review as one flat list: every selected file's items back to
 * back, each behind a fileHeader row. Heights stay derived — header, loading
 * and note rows are fixed — so the windowed list's prefix-sum index is exact
 * before, during and after the per-file diffs arrive.
 */
function buildStream({ files, selected, collapsed, perFile, annotations = [], view = "split", viewedSet = new Set() }) {
  const items = [];
  const segments = [];
  let maxLineLen = 0;
  let idx = 0;
  const shown = files.filter((f) => selected.has(f.path));
  for (const f of shown) {
    const start = items.length;
    const st = (perFile && perFile.get(f.path)) || {};
    items.push({
      k: "fileHeader",
      f: f.path,
      stats: f,
      collapsed: collapsed.has(f.path),
      viewed: viewedSet.has(f.path),
      idx: idx++,
      count: shown.length,
    });
    if (!collapsed.has(f.path)) {
      if (!st.loaded) {
        items.push({ k: "loading", f: f.path });
      } else if (st.error || st.binary || st.tooBig || (st.empty && !(st.fullRows && st.fullRows.length))) {
        const text = st.error
          ? "Could not read this file."
          : st.binary
          ? "Binary file — nothing to diff."
          : st.tooBig
          ? "Diff too large to render — review it in your editor."
          : st.mode
          ? `Mode changed ${st.mode.old} → ${st.mode.new} — no content changed.`
          : "Empty file.";
        items.push({ k: "note", f: f.path, text });
      } else {
        const one = buildItems({
          rows: st.rows,
          fullRows: st.fullRows,
          annotations,
          file: f.path,
          expanded: st.expanded || new Set(),
          full: !!st.full,
          view,
        });
        // Rows carry their segment's view so a pure-add file stays unified
        // while its neighbor renders split — exactly the per-file rule today.
        for (const it of one.items) {
          if (it.k === "row") {
            it.v = one.effView;
            it.sg = one.singleGutter;
          }
          items.push(it);
        }
        if (one.maxLineLen > maxLineLen) maxLineLen = one.maxLineLen;
      }
    }
    segments.push({ file: f.path, start, end: items.length });
  }
  return { items, segments, maxLineLen };
}
```

5. `rowIndexFor` grows the optional file filter:

```js
const rowIndexFor = (items, side, line, file) =>
  items.findIndex(
    (it) =>
      it.k === "row" &&
      (file == null || it.f === file) &&
      ((side === "new" && it.u.r && it.u.r.n === line) || (side === "old" && it.u.l && it.u.l.o === line))
  );
```

6. Export: `exp.buildStream = buildStream;` next to `exp.buildItems`.

- [ ] **Step 4: Run tests, verify pass**

Run: `node test.js`
Expected: PASS. Existing `buildItems` tests must still pass untouched (the `f` stamp adds a field, changes nothing they assert).

- [ ] **Step 5: Commit**

```bash
git add web/review-model.js test.js
git commit -m "feat(model): buildStream — every selected file's items behind fileHeader rows"
```

---

### Task 3: Drafts persist selection + collapse

Deselected/collapsed sets survive a restart like viewed does. Stored as *deselected* (not selected) so the default — everything selected — is the empty set and new files appearing in a re-run are selected automatically.

**Files:**
- Modify: `src/drafts.js:47-57` (`loadDraft`, `saveDraft`)
- Test: `test.js` (drafts get a small round-trip block; set `process.env.DIFFOTATOR_DATA_DIR` to a temp dir first — `dataDir()` honors it)

**Interfaces:**
- Produces: `loadDraft(root)` → `{ann, viewed, desel, collapsed}` (arrays); `saveDraft(root, {ann, viewed, desel, collapsed})`. All arrays default `[]`; a draft with none of the four is cleared, as today.

- [ ] **Step 1: Write the failing test**

```js
// --- drafts: selection and collapse survive a restart -----------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffo-drafts-"));
  process.env.DIFFOTATOR_DATA_DIR = dir;
  const D = require("./src/drafts");
  const root = "/fake/repo";
  D.saveDraft(root, { ann: [], viewed: ["s|a.js"], desel: ["s|b.js"], collapsed: ["s|a.js"] });
  const back = D.loadDraft(root);
  assert.deepStrictEqual(back.desel, ["s|b.js"], "deselection persisted");
  assert.deepStrictEqual(back.collapsed, ["s|a.js"], "collapse persisted");
  D.saveDraft(root, {}); // nothing left → draft file removed
  assert.strictEqual(D.loadDraft(root), null, "empty draft is cleared");
  delete process.env.DIFFOTATOR_DATA_DIR;
}
```

Place it before any other test that touches drafts; if `require("./src/drafts")` is already cached at top of file, reuse that binding instead of re-requiring.

- [ ] **Step 2: Run, verify fail** — `node test.js`; expected: `back.desel` is `undefined`.

- [ ] **Step 3: Implement in `src/drafts.js`**

```js
/** @returns {{ann: object[], viewed: string[], desel: string[], collapsed: string[]}|null} */
function loadDraft(root) {
  const d = readJson(fileFor(root, "drafts"));
  if (!d || d.root !== root) return null;
  return { ann: d.ann || [], viewed: d.viewed || [], desel: d.desel || [], collapsed: d.collapsed || [] };
}

function saveDraft(root, { ann = [], viewed = [], desel = [], collapsed = [] } = {}) {
  if (!ann.length && !viewed.length && !desel.length && !collapsed.length) return clearDraft(root);
  return writeJson(fileFor(root, "drafts"), { root, ann, viewed, desel, collapsed, at: Date.now() });
}
```

(`POST /api/draft` already passes the body straight through — no server change.)

- [ ] **Step 4: Run tests, verify pass** — `node test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/drafts.js test.js
git commit -m "feat(drafts): persist per-scope deselection and collapse alongside viewed"
```

---

### Task 4: App state + stream fetching (`web/app.js`)

Swap the single-file state for per-path state and fetch the whole selected stream a few files at a time. This task changes state and data flow only — rendering the new item kinds is Task 5; the app is expected to be visually broken *between* Tasks 4 and 5, which land as one push (do not verify in the browser until Task 5).

**Files:**
- Modify: `web/app.js` — the `S` literal (`:25`), draft load/save (`:1119-1134`), `setScope` (`:459`), `selectFile`/`loadDiff` area (`:673-713`), `buildItems` wrapper (`:719`), viewed helpers (`:570-607`)

**Interfaces:**
- Consumes: `RM.buildStream` (Task 2), drafts fields (Task 3).
- Produces (used by Tasks 5–6):
  - `S.perFile: Map<path, {loaded, rows, fullRows, expanded:Set, full:bool, binary, tooBig, error, empty, mode}>`
  - `S.desel: Set<string>` and `S.collapsed: Set<string>` — **scoped keys** via existing `viewKey(path)` pattern: `scopeId() + "|" + path`
  - `isSelected(path)`, `setSelected(path, on)`, `selectAll(on)` — raw-path API over the scoped sets
  - `isCollapsed(path)`, `setCollapsed(path, on)`
  - `S.segments` — from `buildStream`
  - `S.streamSeq` guard + `fetchStream()` — fetch queue, 4 in flight
  - `buildItems()` (the app-level wrapper) now builds the stream for the changes tab and keeps the old single-file path for the tree tab
  - `scrollToFile(path)` — selects (if deselected) and scrolls to the segment header

- [ ] **Step 1: State + helpers**

In the `S` literal: remove `diff: null`, `fullRows: null`, `full: false`, `expanded: new Set()`; add:

```js
perFile: new Map(),
desel: new Set(),      // scoped keys; empty = everything selected (the default)
collapsed: new Set(),  // scoped keys
segments: [],
treeDiff: null,        // File Tree tab keeps the old one-file view
treeRows: null,
```

Add next to `viewKey`/`isViewed` (reusing `viewKey`):

```js
const isSelected = (path) => !S.desel.has(viewKey(path));
function setSelected(path, on) {
  const k = viewKey(path);
  on ? S.desel.delete(k) : S.desel.add(k);
  changed(); // render() → renderDiff() → buildItems() rebuilds the stream; no separate rebuild
  if (on) fetchStream(); // a newly selected file may not be loaded yet
}
function selectAll(on) {
  for (const f of S.files) {
    const k = viewKey(f.path);
    on ? S.desel.delete(k) : S.desel.add(k);
  }
  changed();
  if (on) fetchStream();
}
const isCollapsed = (path) => S.collapsed.has(viewKey(path));
function setCollapsed(path, on) {
  const k = viewKey(path);
  on ? S.collapsed.add(k) : S.collapsed.delete(k);
  buildItems();
  diffVL.refresh();
  saveDraft();
}
```

- [ ] **Step 2: Drafts round-trip**

`loadDraft()` gains: `S.desel = new Set(d.desel || []); S.collapsed = new Set(d.collapsed || []);`
`saveDraft()` body adds: `desel: [...S.desel], collapsed: [...S.collapsed]` to the POSTed JSON.

- [ ] **Step 3: Fetch queue**

Replace the single-file fetch path (the non-tree half of `selectFile`, `app.js:699-713`) with:

```js
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

/** Rebuild items from current per-file state and repaint, keeping scroll. */
function rebuildStream() {
  buildItems();
  diffVL.paint(true);
  renderProgress();
}
```

- [ ] **Step 4: The app-level `buildItems` wrapper becomes tab-aware**

```js
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
```

Note `sizePan`: segments can mix split and unified, so the globals it read (`S.effView`, `S.singleGutter`) are gone. Make it:

```js
const gut = 96; // conservative: widest gutter any segment can have
const visible = (body.clientWidth || 800) / (S.view === "split" ? 2 : 1) - gut;
```

(`S.view` is the *requested* view — close enough for a scrollbar bound, and erring toward "more scrollable".)

- [ ] **Step 5: `setScope` and `selectFile` rework**

In `setScope`: replace `S.diff = null; S.fullRows = null;` with `S.perFile = new Map(); S.segments = [];`. After `S.files = files; render();` add `fetchStream();` (not awaited — arrivals repaint). Replace the trailing `if (first) selectFile(first.path)` with `S.selFile = files.length ? files[0].path : null;` (the stream shows everything; nothing to "open").

`selectFile(path)` becomes two functions:

```js
/** Sidebar click / j/k target: make sure it's in the stream, then go there. */
function scrollToFile(path) {
  if (S.tab === "tree") return selectTreeFile(path);
  if (!isSelected(path)) return setSelected(path, true), scrollToFile(path);
  const seg = S.segments.find((s) => s.file === path);
  if (!seg) return;
  S.selFile = path;
  diffVL.scrollToIndex(seg.start, false);
  renderFileTree();
  syncViewedToggle();
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
```

Update the two `selectFile` call sites that remain valid: `#fileTree` click handler → `scrollToFile`; comments-panel click (`app.js:1276`) → `scrollToFile(a.file)` then use `RM.rowIndexFor(S.items, a.side, a.line, a.file)`.
Remove the old `selectFile`/`loadDiff` bodies, the `loadTimer` spinner block, and the "warm the next file" block — the queue replaces prefetch.

- [ ] **Step 6: Sanity + commit (no browser check yet — Task 5 renders it)**

Run: `node test.js` (must still pass — nothing in it loads app.js).
Run: `node -e "new Function(require('fs').readFileSync('web/app.js','utf8'))"` — syntax check only.

```bash
git add web/app.js
git commit -m "feat(app): per-file stream state and a 4-wide fetch queue behind the stacked view"
```

---

### Task 5: Rendering — header/loading/note rows, sticky header, clicks, checkboxes

**Files:**
- Modify: `web/app.js` — `ROW_HTML` (`:787`), `renderDiff` (`:878`), `#diffBody` click (`:950`), `fileRow` (`:609`), `#fileTree` click (`:638`), `vlist` (`:140` return object)
- Modify: `web/index.html` — file-pane header (near `#segList`, `:66`): add `all · none`
- Modify: `web/style.css` — `.fsh` (file stream header) at exactly 32px, `.selbox`, `.note` styles

**Interfaces:**
- Consumes: items with `k: "fileHeader" | "loading" | "note"`, `f`, `v`, `sg` (Tasks 2/4); `setSelected`/`selectAll`/`setCollapsed`/`scrollToFile` (Task 4).
- Produces: `diffVL.topIndex()`; `updateStickyHeader()`; DOM contracts: `.fsh[data-fhead=path]`, `.selbox[data-sel=path]`, `[data-selall]/[data-selnone]` buttons.

- [ ] **Step 1: `vlist` learns its top index**

In the object `vlist` returns, add:

```js
topIndex: () => {
  if (heightOf && (!offsets || offsets.length !== state.count() + 1)) reindex();
  return Math.max(0, Math.min(state.count() - 1, indexAt(container.scrollTop)));
},
```

- [ ] **Step 2: New `ROW_HTML` entries + row renderer de-globalized**

```js
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

loading(item, top) {
  return `<div class="fold" style="top:${top}px">Loading ${esc(item.f)}…</div>`;
},

note(item, top) {
  return `<div class="fold note" style="top:${top}px">${esc(item.text)}</div>`;
},
```

In `ROW_HTML.row`, replace every read of `S.effView` with `item.v || "unified"`, `S.singleGutter` with `item.sg`, `S.selFile` (two uses: `extOf(S.selFile)` and focus/file compare) with `item.f`. The gutter HTML must gain the file: `data-file="${esc(item.f)}"` beside `data-side`/`data-line`.

- [ ] **Step 3: `renderDiff` becomes stream-shaped; the pane header becomes the sticky header**

`renderDiff` keeps: `S.annIdx = annIndex()`, the `buildItems()` call, the empty-scope message (no files at all), the search re-run, `diffVL.refresh()`. Changes-tab `problem` handling goes away (notes are in-stream now); the **tree tab keeps it**: when `S.tab === "tree"`, render the old-style single-file header (path, mode, no position counter) and the old `problem` empty-states, reading meta from `S.treeDiff` (the renamed `S.fullMeta`) and rows from `S.treeRows`. For the changes tab, the header is delegated to:

```js
/** The pane header mirrors the file the viewport is inside — GitHub's sticky bar. */
function updateStickyHeader() {
  if (S.tab === "tree") return; // tree tab: renderDiff still owns the header (below)
  const seg = segmentAt(diffVL.topIndex());
  const head = $("#diffHeader");
  if (!seg) { head.innerHTML = ""; return; }
  if (head.dataset.file === seg.file) return; // cheap on every scroll tick
  head.dataset.file = seg.file;
  if (S.selFile !== seg.file) {
    S.selFile = seg.file;
    renderFileTree();       // move the 'sel' highlight
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
const segmentAt = (idx) => {
  let seg = null;
  for (const s of S.segments) { if (s.start <= idx) seg = s; else break; }
  return seg;
};
```

Wire it: `$("#diffBody").addEventListener("scroll", updateStickyHeader, { passive: true });` and call it at the end of `renderDiff`.

- [ ] **Step 4: Clicks in the stream**

In the `#diffBody` click handler:
- Fold: `S.expanded.add(...)` becomes `const st = S.perFile.get(fold.closest("[data-file]")?.dataset.file ?? S.selFile)` — simpler: stamp `data-file="${esc(item.f)}"` on the fold div in `ROW_HTML.fold` and use `S.perFile.get(fold.dataset.file).expanded.add(fold.dataset.fold)` then `rebuildStream()`.
- New first branch: `const fh = e.target.closest(".fsh[data-fhead]"); if (fh) { const p = fh.dataset.fhead; setCollapsed(p, !isCollapsed(p)); return; }`
- Gutter branch: `openPopover(gut, gut.dataset.file, gut.dataset.side, +gut.dataset.line)` (file from the gutter, not `S.selFile`).

- [ ] **Step 5: Checkboxes + all/none**

`fileRow` (`app.js:609`): prepend, only when `S.tab !== "tree"` and `m` exists,
`<span class="selbox${isSelected(path) ? " on" : ""}" data-sel="${esc(path)}">${isSelected(path) ? "☑" : "☐"}</span>` before the status span.

`#fileTree` click handler: before the file branch, `const sb = e.target.closest(".selbox[data-sel]"); if (sb) { setSelected(sb.dataset.sel, !isSelected(sb.dataset.sel)); return; }` — and the file branch calls `scrollToFile`.

`web/index.html`: next to the List/Tree segmented control add
`<span class="selall"><button data-selall>all</button>·<button data-selnone>none</button></span>`
with a delegated handler in app.js: `[data-selall] → selectAll(true)`, `[data-selnone] → selectAll(false)`.

Empty stream state (in `renderDiff`, when `S.files.length && !S.items.length`):
`diffVL.setEmpty('Nothing selected. <b data-selall>Select all</b> to fill the stream.')` — `setEmpty` HTML is inside `#diffBody`, so add the same `[data-selall]` delegation there.

- [ ] **Step 6: CSS**

`web/style.css`: `.fsh { position: absolute; left: 0; right: 0; height: 32px; ... }` — sticky-looking bar: background `var(--panel)` (match `.diff-header`'s background), bottom border, bold path, small caret; `.fsh.seen .fp { opacity: .6 }`. `.selbox { cursor: pointer; opacity: .8 }`. `.fold.note { font-style: italic }`. **Height must be exactly 32px** to match `GEOM.fileHeader`.

- [ ] **Step 7: Verify in the browser**

```bash
node bin/diffotator.js --no-open -p 7788 &   # from the repo root, on this feature branch
sleep 1 && curl -s http://localhost:7788/api/overview | head -c 400
```

Then open http://localhost:7788 (or drive it with the `run` skill): expect the worktree scope to show all changed files stacked, headers between them, checkboxes in the list. Kill the server after.

- [ ] **Step 8: Commit**

```bash
git add web/app.js web/index.html web/style.css
git commit -m "feat(ui): the changes pane is one windowed stream — headers, checkboxes, sticky bar"
```

---

### Task 6: Keys + navigation in the stream

**Files:**
- Modify: `web/app.js` — keydown switch (`:1517-1552`), `toggleViewed` (`:1099`), `#chkFull` (`:1107`), `jumpChange` (`:979`), `moveFocus` (`:1033`), `commentOnFocus` (`:1042`)

**Interfaces:**
- Consumes: `S.segments`, `scrollToFile`, `setCollapsed`, `S.perFile`, `diffVL.topIndex()` (Tasks 4–5).

- [ ] **Step 1: Rework the handlers**

`j`/`k` (changes tab): current segment = `segmentAt(diffVL.topIndex())`; jump to `S.segments[i ± 1]` via `diffVL.scrollToIndex(seg.start, false)`. Tree tab: keep today's `files[i ± 1]` walk with `selectTreeFile`.

`jumpChange`: `const cur = diffVL.topIndex();` instead of `Math.floor(scrollTop / ROW)` (that arithmetic was already approximate; `topIndex` is exact).

`toggleViewed(on)`:

```js
function toggleViewed(on) {
  if (!S.selFile) return;
  setViewed(S.selFile, on);
  if (!on) return;
  setCollapsed(S.selFile, true); // GitHub's move: viewed folds away
  const nx = RM.nextUnviewed(S.files.map((f) => f.path).filter(isSelected), S.selFile, isViewed);
  if (nx) scrollToFile(nx);
}
```

`#chkFull` / `f` key: toggle `S.perFile.get(S.selFile).full` (guard `loaded`), then `rebuildStream()`; sync the checkbox from the sticky-header file on `updateStickyHeader` (`$("#chkFull").checked = !!(S.perFile.get(seg.file) || {}).full`).

`moveFocus`: `S.focus = { file: S.items[next.index].f, side: next.side, line: next.line };`

`commentOnFocus`'s `find()` must match the file too: `x.dataset.file === S.focus.file && +x.dataset.line === S.focus.line && x.dataset.side === S.focus.side`, and its `rowIndexFor` call gains the file arg: `RM.rowIndexFor(S.items, S.focus.side, S.focus.line, S.focus.file)`.

`lineText(file, side, line)` (`app.js:1136`) still reads the removed globals; it becomes:

```js
function lineText(file, side, line) {
  const st = S.perFile.get(file);
  const src = (st && (st.rows || st.fullRows)) || (S.tab === "tree" ? S.treeRows : null) || [];
  // ...loop unchanged
}
```

- [ ] **Step 2: Verify in the browser** — same launch as Task 5 Step 7; walk `v v v` through the worktree files: each press collapses the current file and lands on the next unviewed header; `n`/`p` cross file boundaries; `c` on a line in the *second* file attaches the comment to the right path (check the comments panel).

- [ ] **Step 3: `node test.js`** — expected: PASS (keyboard policy in keys.js is untouched; `SHORTCUTS` unchanged).

- [ ] **Step 4: Commit**

```bash
git add web/app.js
git commit -m "feat(keys): v collapses + advances, j/k walk headers, focus knows its file"
```

---

### Task 7: Integration pass, README, final verification

**Files:**
- Modify: `README.md` — "The review loop" + "What's in the window" sections
- Verify: whole app against a real branch

- [ ] **Step 1: Full test suite** — `node test.js`; expected: PASS, zero skips.

- [ ] **Step 2: End-to-end against a real PR-shaped branch**

```bash
git checkout fix/sidebar-state -- 2>/dev/null || true   # branch exists locally from earlier testing
node bin/diffotator.js --no-open -p 7789 --base origin/main &
sleep 1
curl -s "http://localhost:7789/api/overview" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['base'])"
```

Expected: `{'ref': 'origin/main', ...}`. Then in the browser (or `run` skill): the branch scope shows 3 files stacked; deselect one → stream drops to 2; reload the page → deselection survived (drafts); Send feedback with comments on two different files → markdown groups by the right paths. Kill the server; `git checkout feat/stacked-diff-stream` if the checkout above moved HEAD (it should not — `-- 2>/dev/null` is a no-op guard; if you actually switched branches, switch back).

- [ ] **Step 3: README**

In "The review loop": describe the stream (all selected files stacked, checkboxes, collapse-on-viewed). In "What's in the window": the Changes tab sentence becomes "changed files + one continuous diff stream". In "Use": note `--base` now genuinely pins the base. Keep the tone and line width of the surrounding text.

- [ ] **Step 4: Commit + push + PR**

```bash
git add README.md
git commit -m "docs: the changes pane is a stream now; --base is real"
git push -u origin feat/stacked-diff-stream
gh pr create --repo ajeetgill/diffotator-pr-view --base main \
  --title "feat: stacked diff stream — GitHub's Files changed, locally" \
  --body "<summary of the feature, spec link, any deviations>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

List any spec deviations prominently in the PR body.
