# Stacked Diff Stream — UX Improvements (Design Spec)

**Date:** 2026-08-04
**Status:** Approved (brainstorm 2026-08-04)
**Depends on:** the stacked diff stream feature (`feat/stacked-diff-stream`, spec `2026-08-04-stacked-diff-stream-design.md`)

## Delivery model

- The base feature is contributed upstream: PR `adisagar2003/diffotator` ← `ajeetgill:feat/stacked-diff-stream`.
- Each improvement below is filed as its own GitHub issue on `adisagar2003/diffotator`, marked as depending on that PR.
- Implementation happens later, one branch + PR per issue, only when the owner says go. **This spec authorizes no code changes by itself.**

## Issue 1 — `v` review loop: cursor sync + finish moment

### 1a. Cursor–viewport sync after `v`

Today: `v` marks the current file viewed, collapses it, and scrolls to the next
unviewed file — but the keyboard cursor is re-anchored by `refocusOutOf(path)`
(app.js), whose anchor can differ from `nextUnviewed`'s scroll target. The next
`n`/`ArrowDown` can jump somewhere the user isn't looking.

Required behavior: after `v` advances, `S.focus` lands on the **first visible
change row of the file the viewport scrolled to** (the next unviewed file). If
that file has no change rows loaded yet (still fetching), focus its
`fileHeader` item and promote to the first change row when the segment loads.
Cursor and viewport must never disagree after `v`.

### 1b. "All viewed" finish state

Today: `v` on the last unviewed file ends the loop silently.

Required behavior: when every **selected** file is viewed, render a finish
state in the diff pane, **after the last collapsed header** (the collapsed
headers stay visible and clickable above it):

- Headline: `All N files viewed`.
- Comment count line: `M comments drafted` (omit when M = 0).
- Nudge: if M > 0 → a **Send feedback** button + hint `⌘⏎`; if M = 0 → an
  **Approve** button. Buttons trigger the same paths as the header buttons.
- Dismissal: un-collapsing any file, un-marking any file as viewed, or
  changing the selection removes the finish state. No modal, no auto-send.

## Issue 2 — Sticky header becomes a mini file-header

Today: `#diffHeader` only names the file at the top of the viewport
(`dataset.file`).

Required behavior: the sticky bar becomes a working clone of the in-stream
`.fsh` header for the current file:

- Clicking the **path** scrolls to the top of that file (same as the sidebar
  jump — `scrollToFile`).
- A **collapse caret** toggles the file's collapse, same as clicking its
  in-stream header. Collapsing the current file behaves as it does today
  (stream reflows; sticky header updates to the new current file).
- A **viewed checkbox** toggles viewed state for the current file (same state
  the `v` key writes; no auto-collapse from the checkbox).
- Height stays **32px** and the visual language matches `.fsh` (it should read
  as "the current file's header, docked"). The existing pin mechanism
  (`pinHolds`/`revalidatePin`) keeps naming the correct file when the pane is
  bottomed out.

## Issue 3 — Sidebar as review checklist + live minimap

Three changes to the file list sidebar (List tab):

1. **Visible viewed checkmarks.** Viewed files get an explicit green ✓
   indicator (replacing the current subtle `.seen` dimming as the primary
   signal). The sidebar doubles as the review checklist.
2. **Collapse all / expand all.** Two controls next to the existing
   `all · none` selection buttons that fold/unfold every selected file in the
   stream at once. Persisted the same way per-file collapse already is
   (`collapsed` in drafts, scoped by `viewKey`).
3. **Current-file highlight.** The file the viewport is currently inside is
   highlighted in the sidebar and kept scrolled into view as the user scrolls
   the stream — a live minimap.

**Prerequisite folded into this issue:** `updateStickyHeader` currently calls
`renderFileTree()` (full innerHTML rebuild) on every file-boundary crossing.
The highlight makes this worse (updates on every crossing). Replace the
rebuild with incremental class updates on the existing nodes (`.seen`,
current-file class) — rebuild only when the file set itself changes.

## Issue 4 — Selection checkboxes in the Tree tab

Today: `.selbox` checkboxes exist only in the List tab (`S.tab !== "tree"`
guard).

Required behavior: the Tree tab gets the same per-file selection checkboxes,
writing the same `S.desel` state. Directory rows need no tri-state checkbox in
v1 — file rows only. `all · none` buttons already apply globally and stay
where they are.

## Issue 5 — Small polish (catch-all)

- **Loading rows look inert.** Loading placeholder items currently inherit
  `.fold`'s `cursor: pointer` and hover styling. They must not look clickable.
- **Jump-to-comment vs pin.** Clicking a comment in `#cpList` issues a second
  `scrollToIndex` that can clear a just-set pin, leaving the sticky header
  naming the wrong file near the stream bottom. Jump-to-comment must leave the
  sticky header accurate.

## Constraints (bind every issue)

- `web/review-model.js` stays Node-loadable (no DOM); pure logic goes there,
  tested via `node test.js`.
- GEOM values in review-model.js must match `web/style.css` px-for-px
  (row 20px, fileHeader 32px under `* { box-sizing: border-box }`). Any header
  change that alters height updates **both**.
- Zero dependencies, no build step.
- All persisted UI state stays scoped by `viewKey(path)` (= scopeId + path).

## Out of scope

- Auto-opening the send modal on finish (nudge only).
- Tri-state directory checkboxes in the Tree tab.
- Any redesign of the comments panel, search, or keyboard map.
