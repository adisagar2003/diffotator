# diffotator

Fork's diff viewer, Plannotator's agent loop.

Browse commits, files and diffs like [Fork](https://git-fork.com), annotate any line,
hit **Send feedback** — the comments land in your Claude Code session as markdown the
agent acts on. Same contract as [Plannotator](https://plannotator.ai), without the lag.

## Install

```sh
ln -sf "$PWD/bin/diffotator.js" ~/.local/bin/diffotator
cp claude/diffotator.md ~/.claude/commands/diffotator.md
```

No dependencies. Node 18+, git.

## Use

```sh
diffotator                       # review the working tree
diffotator --base origin/main    # review the branch against a base
diffotator -C ../other-repo
```

From Claude Code: `/diffotator`. The CLI blocks until you submit; whatever it prints
on stdout becomes the agent's next input.

| You do | Agent gets |
|---|---|
| **Send feedback** | `# Code review feedback` — grouped by file, blocking comments called out |
| **Approve** | `The user approved.` |
| **Close** / `Ctrl-C` | `Review session closed without feedback.` |

## What's in the window

Left sidebar: Local Changes, branch-vs-base (auto-detected), All Commits, worktrees,
branches, tags, stashes, remotes. Top: commit graph with lanes, refs, author, sha, date.
Bottom: **Changes** (changed files + diff), **Commit** (metadata + message), **File Tree**
(every file in the repo at that revision).

Split or unified, word-level intra-line diff, collapsed context you can expand,
`Full file` to review a change in its surroundings, and the File Tree tab so you can
comment on code the diff never touched.

Click any line number to comment. Labels follow
[Conventional Comments](https://conventionalcomments.org) — `suggestion`, `nit`,
`question`, `issue`, `praise`, `thought`, `note`, `todo`, `chore` — plus a blocking
flag and an optional suggested-code block. Drafts survive a reload (localStorage).

### Keys

`j`/`k` file · `n`/`p` change · `c` comment · `s` split/unified · `f` full file ·
`t` comments panel · `/` filter · `⌘⏎` save/send · `Esc` close

## Why it's fast

The lag in a browser diff viewer comes from shipping the whole review as one document.
This does the opposite:

- git data is fetched per file, on demand — nothing is inlined into the page
- commit list and diff rows are windowed; only what's on screen is in the DOM
  (a 61k-line minified JSON diff opens instantly)
- fixed row heights, so windowing needs no measurement pass
- syntax highlighting runs on visible rows only, from a ~100-line regex tokenizer
  instead of a grammar bundle
- one `git diff -U1000000` per file, so expanding collapsed context is free

## Not built

Staging, committing, push/pull, rebase, blame, merge conflicts, image diffs — use Fork
for those. No GitHub/GitLab PR fetching either: `glab mr checkout` / `gh pr checkout`
then `diffotator --base origin/main`.

`node test.js` runs the checks.
