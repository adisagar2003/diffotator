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
