# Walkthrough Mode — Design

**Goal:** When diffotator opens, the reviewer lands on a calm home page — a
two-line summary of the change, the domain words they need, and a map of
blocks — instead of a wall of files. They drill into blocks like pages on a
website, open a file's diff in the same spot, comment, press Back, and keep
going.

## Why

The person this is for is a junior engineer reviewing big, cross-domain MRs
(Tracktile !7417: 37 files across costing handlers, services, frontend, specs
and e2e). Today they first write themselves a domain doc, then ask Claude
for a file order, then skip the frontend and skim tests — and still face a
flat list they can't hold in their head. They need two things at once:
**where am I in this change** (areas, not files) and **what do these words
mean** (domain knowledge next to the code). Etchpad (etchpad.ai) was the
inspiration: changes shown inside the architecture, AI explanations pinned
to real code. Their earlier attempts at a richer screen felt overwhelming;
simplicity is the main requirement.

## Goals

- Walkthrough is the **default** view whenever diffotator opens.
- **Home** (one screen, top to bottom):
  1. Title (MR title or branch).
  2. Summary — at most two plain sentences on what the change does.
  3. Domain terms — one line, `Term = meaning · Term = meaning`, each term
     linking to the doc it came from.
  4. Blocks canvas, drawn with **React Flow**: the top-level areas as boxes,
     thin arrows between them where one area feeds another.
- **Drill down like a website.** Clicking a block replaces the canvas with
  that block's children (sub-blocks, or file blocks at the leaf level).
  Clicking a file block replaces the canvas area with that file's diff.
  **← Back** returns to the canvas level the reviewer came from. A breadcrumb
  (`Home › Backend › Services › costConfirmationService.ts`) shows where they
  are; each crumb is clickable. Browser Back/Forward does the same thing.
- **File view** is today's diff: foldable unchanged lines, highlight a line,
  add a comment (existing labels and blocking flag), plus:
  - **Changes / Full file** toggle — the existing per-file Full-file state
    (key `f`).
  - **Commits** button — opens the existing commit timeline (Up to here /
    This commit) in the same area; Back returns.
- The existing **file sidebar** stays (plain tree of changed files; clicking
  a file opens its file view).
- **Classic view stays.** Today's screens (branch/stash/worktree sidebar,
  commit graph, File Tree tab, the stacked multi-file stream with viewed
  marks and its counter) are kept unchanged behind a **Classic** button in
  the top bar. Walkthrough is what opens; Classic is one click away and
  remembered per session only. `j`/`k`/`v` keep their current meaning in
  Classic; in the walkthrough file view they act on that one file.
- Comments still leave through `Send feedback` → markdown on stdout
  (Approve and Close unchanged). What Claude does with them depends on whose
  change it is — see **Feedback on someone else's MR** below.
- **Opening an MR:** the user says "Use diffotator to open this MR <link>".
  The `/diffotator` command checks out the MR, writes the walkthrough file,
  and runs diffotator against the MR's target branch.

## Non-goals

- No progress counters, comment lists, status colours or test badges on the
  home page (tried in mockups; overwhelming).
- diffotator never calls an AI model. All AI writing happens in the Claude
  session, before diffotator starts, into a file.
- diffotator itself never posts to GitLab/GitHub (Claude posts drafted
  comments, only after the reviewer approves them).
- No map of the whole codebase — only the files this change touches.

## Anti-goals (failure even if it "works")

- The home page feels busy. If something new doesn't earn its place, cut it.
- A changed file is missing from the blocks. Every changed file must be
  reachable from the canvas, exactly once.
- Installing diffotator starts needing `npm install`.
- The summary or terms sound like AI filler. Plain words, short.

## The walkthrough file

Claude writes it; diffotator reads it with a new flag:
`diffotator --base <ref> --walkthrough <path.json>`.

```json
{
  "title": "Rule costs land at event",
  "summary": "Rule costs now land on items when the event happens. Confirm only locks the month.",
  "terms": [
    { "term": "Rule cost", "meaning": "cost spread by a rule, not typed by hand",
      "source": "apps/backend/src/services/costs/CONTEXT.md" }
  ],
  "blocks": [
    { "id": "backend", "label": "Backend", "children": [
      { "id": "handlers", "label": "Handlers", "files": ["apps/backend/src/services/costs/handlers/entityProduced.ts"] },
      { "id": "services", "label": "Services", "files": ["apps/backend/src/services/costs/costConfirmationService.ts"] }
    ],
      "edges": [{ "from": "handlers", "to": "services", "label": "books" }] },
    { "id": "frontend", "label": "Frontend", "files": ["apps/frontend/src/components/floor/cost-history-rows.ts"] }
  ],
  "edges": [{ "from": "backend", "to": "frontend", "label": "shows" }]
}
```

- A block has either `children` (sub-blocks) or `files`, not both.
- `edges` live on the level they connect: top-level `edges` join top-level
  blocks; a block's `edges` join its children. Edges are optional.
- An optional one-line `note` on a block shows under its label.
- Tests are grouped into the block whose code they test (Claude's job), not
  into a separate "tests" block.

**Validation (server side, on load):**
- Paths not in the changed-file set are dropped.
- A path listed twice keeps its first placement.
- Changed files listed nowhere go into a final top-level block **Other**.
- Malformed JSON or a missing file → fall back (below) and show one quiet
  line on the home page saying the walkthrough couldn't be read.

**No walkthrough file** (plain `diffotator` with no flag, or the hook): the
server builds blocks from the changed files' directories (compacted the same
way the file tree already compacts single-child folders), with no summary,
no terms and no edges. So walkthrough stays the default everywhere, AI or not.

## Writing the walkthrough (the `/diffotator` command)

`claude/diffotator.md` gains instructions for Claude, used when the user asks
to open an MR or when no walkthrough exists yet:

1. If given an MR/PR link: `glab mr checkout <iid>` or `gh pr checkout <n>`;
   the base is `origin/<target branch>`.
2. Read the diff (`git diff <base>...HEAD`) and the linked ticket if one is
   named in the MR.
3. Read the repo's own knowledge docs near the changed code — `CONTEXT.md`,
   `AGENTS.md`/`CLAUDE.md`, and a handbook if the repo has one. In Tracktile
   that is `apps/handbook/` and per-service `CONTEXT.md` files; this is what
   makes the terms Tracktile-specific without diffotator knowing about
   Tracktile.
4. Group the changed files into blocks by **area of behaviour**, nested
   where it helps; aim for 3–7 blocks per level. Order blocks the way a
   request flows (event/route → handler → service → UI). Put tests with the
   code they test.
5. Write the summary (≤2 sentences) and 2–5 terms, each with its source.
6. Save to the session scratch directory, then run
   `diffotator -C <worktree> --base <base> --walkthrough <file>` in the
   background, as the command already does.

**Checkout:** an MR is checked out into its own temporary git worktree
(e.g. `git worktree add <scratch>/mr-<iid> <fetched MR head>`), never in the
reviewer's current checkout, so their in-progress work is untouched and
leftover edits can't leak into the diff. The command removes the worktree
after diffotator exits. Reviewing your own working tree (no MR link) stays
as today, in place.

## Feedback on someone else's MR

When the review came from an MR link, Claude does **not** treat comments as
instructions to edit the code (the author owns that branch). It sorts by the
Conventional Comments label each comment already carries:

- `question:` → Claude answers it in chat, pointing at the code and the
  domain doc, to help the reviewer learn.
- everything else (`issue:`, `suggestion:`, `nitpick:`, `todo:`, …) → Claude
  drafts it as a GitLab (or GitHub) review comment on that file and line,
  shows the drafts to the reviewer, and posts only after they say so.

Reviewing your own working tree keeps today's behaviour (Claude acts on the
comments). The output markdown already carries labels, files and lines;
the only change is in `claude/diffotator.md`, which must tell the two cases
apart (MR link given or not).

## React Flow

- Only the blocks canvas uses React + React Flow (`@xyflow/react`). The rest
  of `web/` stays plain JavaScript.
- Ship them as **prebuilt files committed under `web/vendor/`** (one JS
  bundle + React Flow's CSS). No `npm install` for users, no network at
  runtime. How the bundle is produced (a one-off build script kept in the
  repo, e.g. esbuild) is the builder's choice; record the exact versions in
  the script.
- The canvas mounts into the area where the diff lives and unmounts (or is
  hidden) when a file view or Commits is showing.
- **Layout:** React Flow doesn't place nodes itself. Use a simple layered
  layout: blocks with no incoming edge in the left column, each edge target
  one column to the right of its source, ties stacked top to bottom in file
  order. No layout library. Mark it with a `ponytail:` comment — ceiling is
  cycles and dense graphs; upgrade path is dagre/elk.
- Pan/zoom allowed; nodes are not draggable (nothing to save).
- Match diffotator's existing theme (it reads its CSS variables).

## Which diff, and when it changes

- With `--walkthrough`, the app opens on the **branch range**
  (`base...HEAD`), skipping today's "working tree first" boot rule.
- `/api/walkthrough` takes the current scope. Validation runs against that
  scope's changed files: blocks left with no files are hidden, unlisted files
  go to **Other**.
- **Commits** in the walkthrough uses today's timeline and changes the
  scope for the whole review (Up to here / This commit), exactly as in
  Classic. Back returns to the canvas, now showing only that scope's files.
  The timeline exists only for branch ranges; a working-tree review just
  doesn't show the Commits button.

## Domain term links

A term's `source` opens that doc read-only in the same area as a file view
(full content via the existing `/api/file` route, no diff), with its own
place in the URL hash. Back returns. Sources outside the repo are shown as
plain text.

## Navigation state

- The current place (`home`, a block path, a file, or `commits`) lives in the
  URL hash, pushed with `history.pushState`, so the in-app ← Back, the
  breadcrumb, and the browser's Back all agree.
- Returning to a canvas level restores its pan/zoom.

## Changes to existing code (orientation for the builder)

- `bin/diffotator.js`: parse `--walkthrough <path>`; pass it to `createServer`.
- `src/server.js`: new `GET /api/walkthrough` — validated walkthrough, or the
  directory fallback.
- New `src/walkthrough.js`: validation + fallback grouping (pure functions,
  so `test.js` can check them).
- `web/index.html` / `web/app.js`: a walkthrough view in `#content` that is
  shown by default; file view reuses today's diff rendering for one file;
  Commits reuses today's commit pane. The current top bar (Comments, Approve,
  Send, Close) stays.
- `claude/diffotator.md`: the writing instructions above.
- `README.md`: the walkthrough flow, the new flag, and the badge changes from
  "dependencies: 0" to "0 install-time dependencies" (React is vendored).

## Checks (`node test.js`)

- Validation: unknown paths dropped; duplicates keep first; unlisted changed
  files land in **Other**; every changed file appears exactly once.
- Fallback: a set of paths groups into the expected compacted directories.
- Layout: a small edge set produces the expected columns; a cycle doesn't
  hang.

## Calls made by Claude, not the user

- Keep the plain file sidebar in the walkthrough (asked; no answer).
- `--walkthrough` forces the branch range; Commits narrows the whole review.
- MRs open in a temporary worktree, removed afterwards.
- Term sources open read-only inside diffotator.
- The directory fallback when no walkthrough file exists, so "default
  walkthrough" holds without AI.
- Tests are grouped with the code they test.
- Simple layered layout instead of a layout library.
- Walkthrough format is generic; Tracktile tailoring comes from the command
  reading the repo's docs, not from Tracktile-specific code in diffotator.
- Navigation in the URL hash so browser Back works.

## Revision 2 — after the !7417 dry run (2026-10-22)

The reviewer clicked through a mock built from real !7417 data and changed the
design. Where this section disagrees with the sections above, this section wins.

**Home header — two cards, collapsible (`m`, "Hide summary").**
- *What this MR does:* title, ticket, a 2–3 sentence summary, 4–6 labelled key
  changes, decisions, and one "Look hardest at" line naming the riskiest file
  and what to check there.
- *Know this first:* 3–5 short labelled paragraphs of domain background
  written for a junior reader, plus term chips that open their source doc.

**Walkthrough file, additions** (all optional; the validator tolerates absence):
`ticket`, `changes` (`[label, text]` pairs), `decisions` (strings), `lookHard`,
`domain` (`[label, text]` pairs), `mr` (`{iid, url}` — marks someone else's MR),
`links` (`{from, to, label}` file → file, e.g. an import or a call),
`big` on a block. A block's `files` entries may be a path or
`{path, tests: [paths]}`: tests nest inside the file they test and count as
placed. Every changed file — code or test — is still reachable exactly once.

**Canvas.**
- Nesting: at every level each box shows its own children inside it (a block
  shows its sub-blocks or files; a file shows its tests as chips). Clicking a
  child goes straight to it.
- Colour per top-level area (violet, cyan, pink, …); the biggest change gets a
  BIGGEST badge; tests are yellow chips (`TEST`, `E2E`, `HELP`).
- Connectors: animated, labelled arrows between blocks; faint dashed arrows for
  file `links`; inside a block, files in *other* blocks that a link reaches are
  shown as faded "ghost" boxes you can click through.
- **ELK** (`elkjs`) lays the canvas out and routes every line orthogonally
  around boxes. This replaces the hand-written layered layout above.
- Hovering or keyboard-focusing a box lights its own lines and fades the rest.

**Motion.** Going deeper zooms in, going back zooms out, the canvas glides to
fit, boxes lift on hover, unfolded lines and dialogs ease in.

**Colour.** Stronger add/delete backgrounds and gutters, brighter syntax
colours — in both views.

**Keyboard.** Classic keys keep their meaning. Walkthrough adds:
map — arrows move between boxes, `j`/`k` next/previous box, `⏎`/Space open,
`1`–`9` open box N, `⌫`/`Esc` back, `g` home, `0` fit, `+`/`−` zoom, `m`
summary; file — `j`/`k` next/previous file in walkthrough order (tests right
after their file), `⇧T` jump between a file and its tests; anywhere — `/` or
`⌘K` go-to-file, `h` commits, `⇧C` Classic. A hint bar shows the keys for the
current screen; `?` lists them all.

**Vendor bundle.** `web/vendor/canvas.js` holds React, React Flow and elkjs
(~1.9 MB, committed). Still no `npm install` for users.

**Release.** Ships as diffotator 2.0.0.
