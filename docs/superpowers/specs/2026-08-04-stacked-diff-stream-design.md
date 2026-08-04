# Stacked diff stream ("Files changed" view)

**Date:** 2026-08-04
**Status:** Approved

## Problem

Reviewing a branch today means clicking through files one at a time. GitHub's
"Files changed" tab — every file's diff stacked in one continuous scroll — is
the view the user actually reviews in, and reaching it requires opening a real
PR/MR. diffotator already has the *data* (the branch-vs-base scope); this
feature gives it the *presentation*, locally, with no PR.

## Decision summary

- The diff pane in the **Changes** tab becomes one continuous stream of all
  selected files' diffs. This **replaces** the one-file-at-a-time view in every
  scope (worktree, commit, range). The File Tree tab is unchanged.
- **Multi-select** controls what is in the stream: a checkbox per row in the
  changed-files list, **all / none** buttons in the pane header. Default:
  all files selected. Deselecting all shows an empty-state hint.
- Each file's segment starts with a **file header row** (collapse arrow, path,
  +adds −dels, viewed ✓). A collapsed file contributes only its header.
- The pane's pinned header bar shows the file the viewport is currently
  inside (sticky header, GitHub-style).
- `v` marks the current file viewed, **auto-collapses** it, and jumps to the
  next unviewed file — the `v v v` loop survives at 50 files.
- Implementation approach: **one glued virtual list** — all files' rows are
  concatenated into the existing windowed list with derived heights and
  prefix-sum index. No nested windowing, no render-everything fallback.

## UX detail

### File list (left pane)

- Checkbox per file row, in both List and Tree modes. All checked on scope
  load. Toggling immediately adds/removes that file's segment from the stream.
- "all / none" affordances in the changed-files pane header.
- Clicking a file's name (not its checkbox) scrolls the stream to that file's
  header. If the file is deselected, clicking its name selects it first, then
  scrolls to it — the click means "show me this file", never a dead end.
- Viewed ✓ and +/− counts stay on the row as today.

### The stream (right pane)

- Segment order = file list order.
- File header row: `▸/▾  path  [✓ viewed]  +adds −dels`. Clicking the arrow
  (or header) toggles collapse. Collapse folds the segment to the header row.
- Sticky header: the existing diff header bar becomes scroll-aware — it shows
  the path/stats of the file owning the current scroll position, resolved via
  the prefix-sum index (`indexAt(scrollTop)` → owning segment).
- Empty stream (nothing selected): empty state with a hint and an "all" link.

### Keys

| Key | Meaning in the stream |
|---|---|
| `j` / `k` | next / previous file header (scrolls the stream) |
| `n` / `p` | next / previous change across the whole stream |
| `v` | mark current file viewed + auto-collapse + jump to next unviewed |
| `c` | comment on the focused line (unchanged) |
| `s` | split/unified for the whole stream |
| `f` | expand/collapse the *current file only* to its full contents, inline |
| `⌘F` | find across the whole stream (was: current file) |
| `/`, `t`, `⌘⏎`, `Esc` | unchanged |

### Comments

Unchanged in behavior: click a line number anywhere in the stream, card
renders inline under the line, edit/delete in place, Send feedback identical.
The feedback markdown format does not change.

## Internals

### Review model (`web/review-model.js`)

New pure step, tested from `test.js`:

```
buildStream({
  files,            // ordered changed-file list (path, adds, dels, …)
  selected,         // Set<path>
  collapsed,        // Set<path>
  perFile,          // Map<path, {rows, fullRows, expanded, full, loaded}>
  annotations, view, viewedSet,
}) -> { items, effView, singleGutter, maxLineLen }
```

- Runs the existing per-file `buildItems` logic per selected file and
  concatenates, inserting `{k: "fileHeader", file, stats, collapsed, viewed}`
  before each segment.
- Collapsed file → header item only. Unloaded file → header item + one
  fixed-height `{k: "loading"}` item, so the prefix-sum index stays exact
  before the diff arrives.
- Every produced item carries its `file` path — rendering, comment keys and
  language detection key off the item, not a global "current file".

### App state (`web/app.js`)

- `S.diff`, fold/expand state (`S.expanded`, `S.full`) become per-path maps.
- New: `S.selected: Set<path>`, `S.collapsed: Set<path>`.
- `S.selFile` remains as "current file" = the segment owning the viewport
  (drives the sticky header and `v`/`f`).

### Rendering

- One new entry in the `ROW_HTML` table per new item kind: `fileHeader`,
  `loading`. Heights derived as today (header and loading rows are
  fixed-height), so `vlist`'s prefix-sum machinery is untouched.
- Horizontal pan: content width = max line length across expanded, loaded
  segments (one shared pan bar, as today).

### Fetching

- Per-file, on demand, as today — but on scope load a small concurrency
  queue (≈4 in flight) walks the selected files in list order. Each arrival
  fills the file's `perFile` entry, rebuilds items, reindexes (a Float64Array
  fill — cheap), repaints. Nothing blocks on the whole branch.
- Deselecting a file cancels/ignores its pending fetch; reselecting re-uses
  the server-side cache.

### Persistence

- `selected` and `collapsed` persist per scope in the existing drafts store
  (`~/.local/share/diffotator`), alongside comments and viewed state, and are
  cleared on submit with the rest.

## Companion fix

`--base` is parsed by the CLI but never forwarded (`bin/diffotator.js` builds
`serveReview(root, {open, port, title})` without it), so the flag the README
advertises is silently ignored and auto-detection does all the work. Wire
`opts.base` through `serveReview` → `createServer` → overview/base detection,
with auto-detect as the fallback when the flag is absent or invalid.

## Testing (`test.js`, existing style)

- Stream concatenation: two files → header + rows + header + rows; item
  heights sum correctly.
- Collapse → header-only segment; expand restores.
- Selection filtering: deselected file absent; none selected → empty items.
- Unloaded file → header + loading item of fixed height.
- `nextUnviewed` across the stream order.
- Regression: one file selected ≡ today's single-file items (same items out).
- `--base` fix: flag reaches base detection; invalid ref falls back to
  auto-detect.

## Not in scope

Commit graph, sidebar scopes, File Tree tab, submit/feedback format, server
endpoints, GitHub/GitLab PR fetching, staging/committing.
