# Configuration Foundation + VCS Port — Design

> **Status: deferred draft.** Written 2026-08-04, parked deliberately: the UX
> phase runs first, and what we learn there (which knobs people actually
> reach for) is expected to revise this spec before implementation. Do not
> plan or implement from it without a fresh review pass.

**Goal:** Give diffotator a single, documented configuration story with a
small set of useful knobs, and formalize the boundary that makes the git
layer swappable — without adding dependencies or changing the tool's
local-first character.

## Motivation

- Config is scattered: 5 CLI flags parsed in `bin/diffotator.js`, 4 env vars
  read across three files (`hook.js`, `drafts.js`, `bin/`), no config file,
  no precedence story.
- The comment label vocabulary (`suggestion`, `nit`, `question`, `issue`,
  `praise`, `thought`, `note`, `todo`, `chore`) is hardcoded **twice**
  (`web/app.js:20`, `src/feedback.js:6`) and reflects one team's convention.
  Other codebases use different vocabularies (`blocker`, `must-fix`, …);
  labels are a per-repo convention and should be configurable per repo.
- The base-ref detection candidate list (`origin/prerelease`, `origin/main`,
  `origin/master`, `origin/develop`, `main`, `master`) is hardcoded in
  `detectBase` (`src/git.js`); trunk names are also a per-repo fact.
- `src/git.js` is already the only module that knows a VCS exists, and
  `src/scope.js` already injects a 3-function git port. Formalizing the
  full VCS boundary is cheap now and preserves the option of a jj / hg /
  sapling adapter later. Decision from brainstorming: **local VCS port, not
  forge (GitHub/GitLab API) integration** — diffotator has no forge code
  and stays local-first.

## Section 1 — Config foundation

### Files and precedence

Two optional JSON files, merged by a new `src/config.js`:

1. Per-repo: `.diffotator.json` at the repo root (committable — a team
   shares its review vocabulary and trunk names).
2. Global: `$XDG_CONFIG_HOME/diffotator/config.json`, defaulting to
   `~/.config/diffotator/config.json`.

Precedence, highest first:

    CLI flags > env vars > repo .diffotator.json > global config.json > defaults

Loaded once at startup, synchronously. Failure philosophy matches
`drafts.js`: a malformed or unreadable config file **warns on stderr and is
ignored**; unknown keys warn and are dropped; wrong-typed values warn and
fall back to the default. A broken config must never prevent a review.

### Knobs (v1)

| Key | Type | Default | Replaces / today |
|---|---|---|---|
| `port` | number | `0` (random free port) | `-p` only |
| `base` | string | auto-detect | `-b` only |
| `title` | string | repo basename | `--title` only |
| `open` | boolean | `true` | `--no-open` only |
| `hook.enabled` | boolean | `true` | `DIFFOTATOR_HOOK` env |
| `hook.minFiles` | number ≥ 1 | `3` | `DIFFOTATOR_HOOK_MIN_FILES` env |
| `labels` | string[] (non-empty, non-empty items) | the current 9 | hardcoded twice |
| `baseCandidates` | string[] | current hardcoded list | hardcoded in `detectBase` |

Existing env vars keep working and slot into the precedence chain.
`DIFFOTATOR_DATA_DIR` stays env-only (data location should not depend on
data that lives in a configurable location).

### Labels plumbing

Single source of truth: config. Server reads it; `/api/overview` gains a
`labels` field the browser popover renders; `src/feedback.js` receives the
list at render time. Both hardcoded `LABELS` constants are deleted. The
first label in the list is the popover default. Validation failure falls
back to the built-in list.

### `diffotator config` subcommand

Prints the effective merged config **and the layer each value came from**
(cli / env / repo / global / default), e.g.:

    port          7800        repo (.diffotator.json)
    labels        nit, block… global (~/.config/diffotator/config.json)
    hook.minFiles 3           default

One command answers "why is it doing that". Cut if it feels like YAGNI at
plan time.

## Section 2 — VCS port

### The port

`src/git.js`'s exported surface, documented as an adapter contract. The
functions the rest of the system consumes:

    repoRoot, overview, log, commitMeta, changedFiles,
    fileDiff, fileContent, tree, detectBase

Layout: `src/vcs/index.js` (adapter selection — git is the only entry for
now) and `src/vcs/git.js` (the current `src/git.js`, moved). `server.js`,
`hook.js`, and `bin/diffotator.js` consume the adapter object, never
`require` the git module directly.

### Known leaks to close

- `hook.js#fingerprint` builds the working-tree identity from raw
  `G.probe(root, ["status", "--porcelain"])` + `["diff", "HEAD"]` — git
  arguments outside the port. Becomes a port method (e.g.
  `treeFingerprint(root)`).
- `detectBase`'s candidate list comes from config (`baseCandidates`), not a
  literal.
- `scope.js` stays as-is: it is already table-driven with an injected
  3-function git port (`emptyTree`, `headExists`, `parents`). Its
  `diffArgs` vocabulary is defined in git terms; a future non-git adapter
  translates scope objects into its own arguments. Documented as part of
  the port contract, not abstracted further now (YAGNI).

### Explicit non-goals

- No second adapter (jj/hg/sapling) until someone wants one.
- No forge (GitHub/GitLab API) integration — separate product decision.

## Section 3 — Docs and testing

- README gains a **Configuration** section: file format, all knobs with
  defaults, precedence chain, examples (team vocabulary via repo file).
- `--help` mentions the config files and the `config` subcommand.
- `test.js` additions: precedence merge order; bad-JSON tolerance (warn +
  ignore); labels validation and fallback; `detectBase` honoring
  `baseCandidates`; port surface conformance (adapter exports exactly the
  documented functions).

## Deferred (revisit after the UX phase)

- Diff behavior knobs (ignore-whitespace, context lines) — need UI
  surfaces first.
- Persisted UI preferences (pane widths, …) — belongs with the frontend
  architecture spec.
- Frontend module split of `web/app.js` (2230 lines) and the Commit-tab
  redesign — separate spec ("C"), UX phase feeds it.
