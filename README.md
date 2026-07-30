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

## The review loop

`v` marks the current file viewed and jumps to the next unviewed one. The header
tracks `12/56 viewed +2,341 −187`, viewed files dim with a ✓, and the diff header
tells you where you are (`6 of 56`). That is the whole loop for a fifty-file agent
run: `v v v`, stop when something looks wrong, `c` to comment, keep going.

Comments render inline under the line they are about, with their label, blocking
flag and edit/delete — so re-reading a file shows what you already said. Closing
with unsent comments asks first.

## What's in the window

Left sidebar: Local Changes, branch-vs-base (auto-detected), All Commits, worktrees,
branches, tags, stashes, remotes. Top: commit graph with lanes, refs, author, sha, date.
Bottom: **Changes** (changed files + diff), **Commit** (metadata + message), **File Tree**
(every file in the repo at that revision).

The changed-files pane is a flat **List** by default (reviewing is working a list)
and a **Tree** for the 12k-path repo browser; single-child directory chains fold to
one row either way. Split or unified, word-level intra-line diff, collapsed context
you can expand, `Full file` to review a change in its surroundings, and the File Tree
tab so you can comment on code the diff never touched.

Click any line number to comment. Labels follow
[Conventional Comments](https://conventionalcomments.org) — `suggestion`, `nit`,
`question`, `issue`, `praise`, `thought`, `note`, `todo`, `chore` — plus a blocking
flag and an optional suggested-code block. Drafts survive a reload (localStorage).

### Keys

`j`/`k` file · `n`/`p` change · `↑`/`↓` line cursor · `c` comment · `v` viewed +
next · `s` split/unified · `f` full file · `t` comments · `/` filter files ·
`⌘F` find in file · `⌘⏎` save/send · `Esc` close

Windowing means only the visible rows exist in the DOM, so the browser's own Find
cannot see the file — `⌘F` opens ours instead.

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
- rows are uniform 20px except inline comment cards, whose height is *derived*
  rather than measured, so a prefix-sum index stays exact and nothing jumps

## Not built

Staging, committing, push/pull, rebase, blame, merge conflicts, image diffs — use Fork
for those. No GitHub/GitLab PR fetching either: `glab mr checkout` / `gh pr checkout`
then `diffotator --base origin/main`.

## Git shapes that bite

Most diff viewers are written against a straight line of ordinary commits. These
were all real bugs here, and each one has a test:

| Shape | What went wrong |
|---|---|
| Root commit | `sha^!` has no parent to exclude — the diff came out reversed |
| Merge commit | `sha^!` excludes *every* parent, so it showed zero files |
| Rename | `numstat` compresses the path to `{old => new}` — every rename read +0/−0 |
| CRLF file | a stray `\r` rendered at the end of every line |
| Any file ending in a newline | a phantom empty last line |
| Binary | rendered as a blank pane instead of saying "binary" |
| Untracked | missing from the File Tree — exactly the files an agent just wrote |

Commits now resolve to an explicit two-dot pair against the first parent (or the
empty tree at the root), which is also what makes a merge show what it merged in.

`node test.js` runs the checks.
