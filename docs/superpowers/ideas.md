# Idea backlog (raw dumps, not commitments)

Parking lot for ideas worth revisiting. Nothing here is specced or promised;
feasibility notes are first impressions only.

## 1. One review session for many agents' worktrees (2026-08-04)

Use the same localhost session to review work done by multiple agents on
different worktrees, and send feedback back to *each* of those sessions.

First impressions on feasibility:
- The backend is closer than it looks: `git.js#overview` already lists
  worktrees, and every route takes `root` — today fixed at server start,
  but it could become a per-request parameter (a worktree switcher in the
  header, like the scope switcher).
- The hard part is the feedback path: today one review session = one
  blocking CLI invocation = one agent's stdout. Multiple agents means the
  Stop hook of each agent starts (or attaches to) a shared server and waits
  for *its* verdict — a routing/session layer that doesn't exist yet.
  Related to the "hand-off & repeat" lifecycle stage.

## 2. Arbitrary branch-vs-branch diff from the sidebar (2026-08-04)

In the left panel, pick any two branches and open their diff — e.g.
`br-feature` vs `br-main`, or `br-ft1` vs `br-ft2`. Work isn't always
branched off main; sometimes it stacks on another feature branch.

First impressions on feasibility:
- The backend already supports this fully: the `range` scope is
  `range:<base>...<head>` with both sides free (`src/scope.js`), and every
  API route accepts it. This is purely a UI gap — the sidebar only ever
  offers one canned range (branch vs detected base).
- Smallest useful shape: a "compare…" affordance on branch rows (pick base,
  pick head — or right-click/two-click selection). Good candidate for the
  UX phase shortlist, low risk.

## 3. Agents ping their branch — review inbox in the UI (2026-08-04)

When an agent finishes work on a branch, it could "ping" diffotator so the
UI notifies the reviewer which branch to check. Proper UX unclear — parked.

First impressions on feasibility:
- Mechanically simple: a `POST /api/ping {branch, note}` endpoint plus a
  badge/toast in the UI (the client could poll, or the server could push).
  An agent pings with one `curl`; a Stop-hook variant could ping instead of
  opening a browser.
- The real design question is shared with idea 1: it turns diffotator from
  "one blocking session per review" into a long-lived review hub with an
  inbox. Ideas 1 and 3 probably want to be designed together (multi-source
  review queue: worktrees, branches, pings).

## 4. Submodule support (2026-08-04)

Review changes inside git submodules, not just the pointer bump.

First impressions on feasibility:
- Today a dirty/bumped submodule shows up as a one-line "Subproject commit
  <sha>" diff — technically true, useless for review.
- Each submodule is a full repo, so the existing machinery works *inside*
  it unchanged; the gap is discovery and navigation: list submodules
  (`git submodule status` / `.gitmodules`), treat a changed one as an
  expandable entry that opens its own file list/diffs under its own root.
- Shares the "per-request root" plumbing with idea 1 (multi-worktree):
  both need routes to accept a root other than the one fixed at startup.
  Worth designing that plumbing once for both.
