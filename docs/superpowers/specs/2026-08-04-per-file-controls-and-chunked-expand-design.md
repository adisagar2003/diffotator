# Per-file Controls, Chunked Gap Expansion, Jump Affordance — Design

**Goal:** Three stream-UX fixes: (1) Viewed / Full-file become per-file
controls on each file's header row in the diff stream, replacing the
global toolbar checkboxes; (2) the "N unmodified lines — click to expand"
fold reveals lines in ~20-line chunks instead of all at once; (3) the
prev/next-change arrows say what they do.

## 1. Per-file Viewed / Full-file pills on the file header row

The global Viewed and Full-file checkboxes leave the toolbar; both are
per-file state (they already are internally — `S.viewed`, `S.perFile`),
so both controls live on each file's stream header row, right-aligned.
The `✓ viewed` chip beside the filename goes away — the control carries
the state. Split/Unified stays global in the toolbar.

### Row anatomy

Left to right: a thin full-height **status rail** at the row's left edge
(accent blue when the row is the active file, green when viewed,
otherwise nothing); the disclosure caret; the filename in semibold UI
sans; then — pushed right — the file counter ("3 of 11"), additions and
deletions in fixed-width monospace columns so numbers align down the
stream; last, the **pill group** in a fixed-width slot so the pill
column stays steady no matter which rows are ticked. Order: Full file,
then Viewed at the far right. The Viewed pill reserves a fixed slot for
its checkmark so the label never shifts on toggle.

### Pill states

- **Viewed on:** solid green fill, near-black text, heavier weight — a
  terminal "done" state.
- **Full file on:** blue-tinted background with a blue outline — an
  outline rather than a fill because it's a display mode, not
  completion; it must not compete with Viewed.
- **Both off:** transparent, faint neutral border, muted text at ~40%
  opacity, animating to full strength when the row is hovered or is the
  active row.

### Row treatment

Viewed rows recede as a whole: darker background, muted filename,
desaturated +/− numbers — review progress scannable from the list edge
without reading any pill. The active row is slightly lifted; rows are
separated by a hairline.

### Toolbar

Left: files-changed summary with total additions/deletions, a divider,
the viewed count, a slim green progress meter, and a ghost **Mark all
viewed** button (sets every *selected* file viewed; it does not touch
deselected files). Right: the Split | Unified segmented control — the
only global view control that remains. The existing progress readout in
the topbar is redundant with the new meter; the toolbar meter is the
one that stays in the diff toolbar, the topbar keeps its overall pill.

### Sticky header

The pinned copy of the active file's header (`#diffHeader`) renders the
same pill group, so both controls stay reachable while deep inside a
long file. Its current `☐/☑` viewed box and any full-file affordance are
replaced by the pills — one visual language, two places.

### Behaviour

- Clicking a row's body sets the active file. The **caret** is the
  collapse toggle. (Change from today, where a click anywhere on the
  header collapses the file — that made every misclick fold the file
  you were reading.)
- Clicking either pill toggles only that file's state and stops
  propagation — it neither collapses the file nor changes the active
  file.
- Keyboard is unchanged: `v` marks the active file viewed and jumps to
  the next unviewed; `f` toggles full file on the active file. They now
  simply update the pills instead of the toolbar checkboxes.
- Viewed auto-fold on `v` stays; clicking the Viewed pill does not fold
  (same split as today's header box).

## 2. Chunked gap expansion

Today a fold row ("N unmodified lines — click to expand") expands the
whole gap — 83+ lines in one click. New behaviour, `CHUNK = 20`:

- **count ≤ CHUNK:** one click expands the whole gap (unchanged).
- **count > CHUNK:** the fold row offers two directional affordances,
  GitHub-style: expand **down** reveals the next CHUNK lines at the top
  of the gap (adjacent to the change above), expand **up** reveals
  CHUNK lines at the bottom (adjacent to the change below — the "few
  lines above that" case). The row's count ticks down; when the two
  reveals meet, the fold row disappears.
- The "Full file" pill remains the see-everything path; `full: true`
  bypasses folding entirely, exactly as now.

### Model change (`review-model.js`)

`expanded: Set<foldId>` becomes `expanded: Map<foldId, {head, tail}>` —
lines revealed from the gap's start (`head`) and end (`tail`). A fully
expanded fold (`head + tail ≥ count`) emits all rows and no fold item;
a partial one emits `head` rows, the fold item with the remaining
count, then `tail` rows. Fold ids stay `"f" + start` (index of the
gap's first unit), so identity is stable across partial reveals.
`buildFileItems` is the only consumer; the ≤ CHUNK case writes
`{head: count, tail: 0}` — one representation, no boolean special case.

## 3. Change-jump affordance

The ▲▼ arrows stay — they are the only mouse path to prev/next change —
but become legible:

- A counter beside them: **"change 3 of 12"** for the active file,
  derived from the same change-block walk `n`/`p` already use
  (`review-model.js` `isChangeRow` / next-block logic), updated as the
  cursor moves.
- Tooltips: "Next change (n)" / "Previous change (p)".
- They live where they live today, in the sticky diff header's right
  side, after the pill group.

## Testing

- `node test.js`: chunk model — partial head/tail reveal ordering, fold
  disappearing when reveals meet, ≤ CHUNK single-click, fold-id
  stability across reveals; stream builder emitting pill/rail state;
  mark-all-viewed touching only selected files; change-block counter
  derivation.
- Headless walkthrough: pill click toggles only its file and does not
  collapse or change active file; caret still collapses; toolbar meter
  updates as files are marked; a >20-line gap takes multiple clicks and
  the count ticks down; `v` and `f` still work from the keyboard.

## Non-goals

- The left pane's file list / tree keeps its current rendering — this
  design is about the stream header rows and the toolbar.
- No persistence changes: viewed and full-file stay per-scope in the
  draft exactly as today; fold reveal state stays session-only.
