# Walkthrough Mode Implementation Plan (revision 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** diffotator opens on a walkthrough — MR summary, domain background and an ELK-laid-out React Flow map of nested blocks, files and tests — that drills down like web pages into a file's diff, keyboard-first, with today's UI behind a Classic button. Ships as 2.0.0.

**Architecture:** `src/walkthrough.js` (pure, loadable in Node and the browser like `scope.js`) validates the walkthrough JSON, builds the folder fallback, parses hash routes, indexes files and builds the graph for any level. The server exposes it at `/api/walkthrough`. `web/vendor/canvas.js` (React + `@xyflow/react` + `elkjs`, prebuilt) lays out and draws one level and owns map keyboard focus. `web/walk.js` owns the walkthrough screens and drives existing `app.js` functions for the file view and commits.

**Tech Stack:** Node ≥18, plain browser JS, vendored React 18.3.1 / `@xyflow/react` 12.3.5 / `elkjs` 0.9.3 built with esbuild 0.24.0, `node test.js`.

**Spec:** `docs/superpowers/specs/2026-10-22-walkthrough-mode-design.md` (read *Revision 2* last; it wins).

## Global Constraints

- No `dependencies` in `package.json`; users never run `npm install`. Vendor files are committed. No network at runtime.
- Every changed file (code or test) is reachable from the canvas exactly once; leftovers go to a top-level block `{id:"other", label:"Other"}`.
- Walkthrough text is untrusted: DOM goes through `esc()`, React renders text only.
- Classic view behaves as today (colour tokens excepted). Feedback output format unchanged.
- `node test.js` passes after every task.

## Review Focus

1. Paths with spaces, `#`, `%`, unicode round-trip through routes — `routes round-trip awkward paths` (Task 1).
2. Sloppy JSON (duplicate ids, both `children` and `files`, unknown paths, tests listed twice, links to unknown files) still loads with every file reachable — `validate repairs sloppy input` (Task 1).
3. A scope with no files shows "No changes in this scope." — `validate on empty paths` (Task 1) + browser check (Task 5).
4. The walkthrough narrowing the stream to one file must not overwrite the reviewer's saved show/hide choices — `S.only` override, browser check (Task 5).
5. A walkthrough file that fails to parse falls back to folders and says why — server test (Task 2).

---

### Task 1: `src/walkthrough.js` — validate, fallback, routes, index, graph

**Files:** Create `src/walkthrough.js`; modify `test.js`, `.gitignore` (`.superpowers/`).

**Interfaces (UMD: `module.exports` / `window.Walkthrough`):**
- `validate(raw, paths, error = null) → Walkthrough` where `Walkthrough = {title, ticket, summary, changes:{label,text}[], decisions:string[], lookHard, domain:{label,text}[], terms:{term,meaning,source}[], blocks:Block[], edges:Edge[], links:Link[], mr:{iid,url}|null, fallback:boolean, error:string|null}`
- `Block = {id, label, note, big, children:Block[]|null, files:FileEntry[]|null, edges:Edge[], count}`; `FileEntry = {path, tests:string[]}`; `Edge = {from,to,label}`; `Link = {from:path,to:path,label}`
- `fallback(paths) → Block[]` (compacted folders; `dir:<path>`, `files:<dir>`, `root-files`)
- `parseRoute(hash) → Route`, `formatRoute(Route) → string`; `Route = home | {kind:"block",path:string[]} | {kind:"file",file} | {kind:"commits"} | {kind:"doc",file}`
- `findBlock(blocks, ids) → Block|null`
- `index(blocks) → Map<path, {ids:string[], owner:string|null, tests:string[], tone:number}>` (tone = top-level block index)
- `fileOrder(blocks) → string[]` (code file, then its tests, block by block)
- `buildGraph(wt, route, stats: Map<path,{add,del}>) → {nodes: GNode[], edges: GEdge[]} | null`; `GNode = {id, kind:"group"|"block"|"file"|"ghost", parent:string|null, label, sub, note, big, tone, add, del, tests:{path,tag,add}[], nav:Route, n?:number}`; `GEdge = {id, from, to, label, kind:"block"|"link"}`

- [ ] Tests first: validation (unknown dropped, duplicates keep first, tests nest and count, Other, links filtered, sloppy input, empty paths, null → fallback with error), routes round-trip, `index`/`fileOrder`, `buildGraph` (home groups contain children; leaf shows files + ghosts; numbering 1–9 on top-level nodes; edges only between visible nodes).
- [ ] Implement; `node test.js` exits 0; commit.

### Task 2: `--walkthrough` flag and `/api/walkthrough`

**Files:** `bin/diffotator.js`, `src/server.js`, `test.js`.

- `--walkthrough <path>` → `createServer({…, walkthrough})`; `GET /api/overview` gains `walkthrough: boolean`; `GET /api/walkthrough?scope=` reads + parses the file per request and returns `validate(raw, changedPaths, error)`; `/walkthrough.js` served from `src/`.
- [ ] Server test: flag → validated title/blocks; broken JSON → fallback with `error` starting "Couldn't read the walkthrough file"; no flag → fallback, `error: null`. Implement; commit.

### Task 3: Vendored canvas (`web/vendor/canvas.js`, `canvas.css`)

**Files:** `vendor-src/canvas.js`, `scripts/build-vendor.sh`, generated `web/vendor/*`, `test.js` (bundle exists, exposes `WalkCanvas`).

- `WalkCanvas.mount(el, {nodes, edges, palette, viewport, focus, onOpen(GNode), onOpenTest(path), onViewport(vp), onFocus(id)}) → Promise<Controller>`; `Controller = {move(dir), step(d), activate(), openNumber(n), fit(), zoom(d), focusId(), unmount()}`.
- ELK `layered`, direction RIGHT, `hierarchyHandling: INCLUDE_CHILDREN`, orthogonal routing; edge points offset by their `container`; rounded-corner paths; block edges animated + labelled; link edges faint dashed; hover/focus lights a node's (and its descendants') lines and dims the rest.
- [ ] `bash scripts/build-vendor.sh && node test.js`; commit.

### Task 4: Walkthrough screens (`web/walk.js`) + app hooks

**Files:** `web/walk.js`, `web/index.html`, `web/style.css`, `web/app.js`.

- `window.Walk = {init(), onScope(), isOn(), key(e) → boolean, escape() → boolean}`.
- Modes `body.mode-walk|mode-classic` (sessionStorage), `#btnClassic` / `⇧C`.
- Routes in the hash; home header cards (fallback says it is grouping by folder); canvas per level; crumbs; Back; enter/leave animations; file route narrows the stream with `S.only` (an override inside `isSelected`, never touching `S.desel`); file info (area chip, tests / "test for"); commits route reparents `#timelinePane`; doc route renders `/api/file` rows; go-to-file palette; hint bar; help sheet gains a Walkthrough section.
- `app.js`: `isSelected` honours `S.only`; `scrollToFile` guard; boot (walkthrough flag → branch range, skip resume; then `Walk.init()`); `setScope` → `Walk.onScope()`; file-tree click → walkthrough file route; keydown → `Walk.key(e)` after the typing guard, Escape → `Walk.escape()` when nothing else closes.
- Colour tokens brightened.
- [ ] `node test.js`; browser check of every Review Focus item; commit.

### Task 5: `/diffotator` command, README, 2.0.0

**Files:** `claude/diffotator.md`, `README.md`, `package.json`.

- Command: MR link → temporary worktree, read diff + ticket + repo docs, write the walkthrough JSON (schema incl. revision 2 fields), run with `--walkthrough`, sort feedback on someone else's MR (questions answered, the rest drafted as GitLab draft notes / pending GitHub review, posted only on a yes), remove the worktree.
- README: walkthrough section, keys, flag, vendored deps, rebuild script.
- [ ] Copy the command to `~/.claude/commands/`; `node test.js`; commit; merge to `main`; tag `v2.0.0`; GitHub release.
