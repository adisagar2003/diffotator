# Commit Timeline Panel — Design

**Goal:** Review a branch commit-by-commit without leaving the review: a
panel under the file list showing the commits inside the current review
range; clicking one narrows the diff to that point in the branch's story.

## Panel

- Lives in the left pane, under the file list, behind a resizable,
  collapsible horizontal split (same splitter mechanics as the existing
  panes).
- Appears only when the scope is a **range** (branch vs base) — the one
  scope that *has* an intra-review timeline. Worktree and single-commit
  scopes don't show it.
- Lists only the commits inside the range (`base..head`), fetched through
  the existing `/api/commits?rev=` endpoint. Oldest first — the branch
  reads as a story, top to bottom. Row: short sha + subject; the selected
  commit is highlighted.
- The existing top commit pane is untouched: it stays the "explore any
  commit" browser. This panel is the review-scoped timeline. They do
  different jobs.

## Interaction

- A header row, **“All branch changes”**, is the default state: the full
  range diff exactly as today.
- Clicking a commit narrows the review using the current view toggle:
  - **Up to here** (default): scope becomes `range:<base>...<sha>` —
    accumulated changes from base through that commit.
  - **This commit**: scope becomes `commit:<sha>` — that commit alone.
    The commit banner (already scope-derived) appears automatically.
- The toggle is a two-way segmented control in the panel header. Flipping
  it with a commit selected re-scopes immediately.
- Clicking “All branch changes” (or the already-selected commit again)
  returns to the full range.
- All of this is scope switching through the existing `setScope` — the
  panel is a scope *switcher*, not new diff machinery. File list, stream,
  viewed state, and keyboard flow all behave exactly as they do on any
  scope change.

## Comments and feedback

Tag at comment **creation**, not at send — send-time toggle state would
silently retag older comments.

- A comment saved while the scope is `commit:<sha>` records
  `commit: { sha, subject }` on the annotation. Comments in range or
  worktree scopes carry nothing new.
- Feedback markdown shows the tag on the comment header line:
  `re: commit c8418ca "fix(ui): …"` — so the agent can fix at the right
  layer (fixup that commit vs. patch on top).
- Line anchors stay in the diff the comment was written against. A
  per-commit comment is **not** remapped into the accumulated view: the
  same line may not exist there, and the sha tag is what keeps the comment
  meaningful.
- Drafts already persist annotations; the new field rides along untouched.

## Edge cases

- Merge commits in the range: listed; "This commit" uses the existing
  first-parent diff semantics of the commit scope.
- Long ranges: same limit the commits endpoint already applies; the panel
  is a virtual-list candidate only if that ever becomes real.
- Base moved / commit vanished mid-session (rebase while reviewing): the
  scope switch fails the same way any stale scope does today — empty file
  list, no special handling.

## Testing

- `node test.js`: timeline item derivation (range → rows, selection
  states), annotation tagging rule (commit scope tags, others don't),
  feedback renderer output with a tagged comment.
- Headless walkthrough: panel appears on range scope only; click commit →
  up-to-here scope; toggle → single-commit scope + banner; comment in each
  mode; submit payload carries the tag exactly once.
