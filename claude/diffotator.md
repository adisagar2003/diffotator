---
description: Review a change in diffotator — your working tree, a branch, or someone's MR/PR — as a walkthrough
argument-hint: "[MR/PR link] [--base <ref>] [-C <dir>]"
allowed-tools: Bash(diffotator:*)
---

Open a review in diffotator. It opens on a **walkthrough**: what the change
does, the domain background a reviewer needs, and a map of the change grouped
into blocks. Your job is to write that walkthrough, open the review, and act on
what comes back.

## 1. What to review

- **An MR/PR link in `$ARGUMENTS`** (someone else's change): never check it out
  in the user's current checkout. Fetch its head into a temporary worktree in
  your scratch directory:
  - GitLab: `git fetch origin merge-requests/<iid>/head` then
    `git worktree add --detach <scratch>/mr-<iid> FETCH_HEAD`; the base is
    `origin/<target branch>` from `glab mr view <iid> -F json`.
  - GitHub: `git fetch origin pull/<n>/head` then the same `worktree add`; the
    base is `origin/<baseRefName>` from `gh pr view <n> --json baseRefName`.
- **No link:** the current repo. Pass the user's `--base` / `-C` through.

## 2. Read before you write

Read `git diff <base>...HEAD` (or the working-tree diff), the ticket the change
names, and the repo's own knowledge near the changed code: `CONTEXT.md`,
`AGENTS.md` / `CLAUDE.md`, ADRs, and a handbook if the repo has one (in
Tracktile: `apps/handbook/` and each service's `CONTEXT.md`). The domain section
must come from these, not from guessing.

## 3. Write the walkthrough JSON

Save it in your scratch directory. Every field is optional; diffotator repairs
what it can and puts any changed file you leave out in an "Other" block.

```json
{
  "title": "!7417 · Rule costs land on items when the event happens",
  "ticket": "TRA-2486",
  "mr": { "iid": 7417, "url": "https://gitlab.com/…/merge_requests/7417" },
  "summary": "Two or three plain sentences: what changes for the user, and why.",
  "changes": [["When it lands", "One sentence."], ["Locks", "One sentence."]],
  "decisions": ["A choice the author made that a reviewer should know about."],
  "lookHard": "file.ts (+837 −331): the two or three things most likely to be wrong.",
  "domain": [["Cost rule", "What it is, in words a new teammate understands."]],
  "terms": [{ "term": "COGS on", "meaning": "short gloss", "source": "path/to/CONTEXT.md" }],
  "blocks": [
    { "id": "backend", "label": "Backend · costs", "note": "Where the cost moves", "children": [
      { "id": "recompute", "label": "Recompute & adjust", "note": "One line", "files": [
        { "path": "src/costPeriodRuleService.ts", "tests": ["src/__tests__/catalog.integration.test.ts"] },
        "src/handlers/saveAdjustment.ts"
      ] },
      { "id": "landing", "label": "Landing the cost", "big": true, "files": ["src/costConfirmationService.ts"] }
    ], "edges": [{ "from": "recompute", "to": "landing", "label": "calls syncRuleAllocations" }] }
  ],
  "edges": [{ "from": "specs", "to": "backend", "label": "checks" }],
  "links": [{ "from": "src/handlers/saveAdjustment.ts", "to": "src/costConfirmationService.ts", "label": "syncRuleAllocations" }],
  "confidence": {
    "level": "medium",
    "summary": "One sentence: how sure you are this is safe to merge, and the main reason.",
    "reasons": [{ "ok": true, "text": "Both paths have integration tests" }, { "ok": false, "text": "The migration has no way back" }]
  },
  "risk": [{ "path": "src/pricing/round.ts", "level": "high", "why": "every invoice total goes through it" }]
}
```

- Group files by **area of behaviour**, nested where it helps; 3–7 blocks per
  level, ordered the way a request flows (route/event → handler → service → UI),
  specs and e2e first if they define the behaviour.
- Put each test inside the file it tests (`tests`), not in a "tests" block.
- `edges` join sibling blocks and say how (a short verb phrase). `links` join
  files — an import or a call worth tracing. Only add links you checked.
- Mark the riskiest block `"big": true`. Plain words everywhere; no filler.
- `confidence` is your honest read of whether this is safe to merge, shown as
  a chip at the top: `high` (small or well tested, nothing worrying), `medium`
  (works, but something is untested or risky), `low` (likely broken, or too
  risky without changes). Give 2–5 `reasons`: `"ok": true` for what makes you
  sure, `"ok": false` for each worry. Never round up.
- `risk` tells the reviewer which files to read carefully. diffotator already
  ranks every file from its path (CI, auth, billing, migrations, installers),
  its size and whether a test changed with it, and shows the top of that list
  as *Review first*. Add an entry only where you know better: a small change
  with a wide reach, or a scary-looking file that is safe. `high` = read every
  line, `medium` = worth a look, `low` = skim; `why` is one short phrase. A CI,
  auth, billing, migration or installer path stays high whatever you say.

## 4. Open it

Run in the background (it blocks until the reviewer asks something or
submits, which can exceed the Bash timeout):

`diffotator -C <dir> --base <base> --walkthrough <file>`

Tell the user the URL it prints on stderr, then wait for stdout.

## 5. Act on what comes back

- `# Question from the reviewer` → they asked you something from the page; the
  review is still open. Read the code it points at and answer in a few plain
  sentences (markdown is fine), in the background again:
  `diffotator answer -C <dir> --id <n> - <<'EOF'` … `EOF`
  It shows them your answer, then waits for their next message — handle what it
  prints the same way. Don't edit code because of a question; just answer.
- stderr says it is *handing over a review that was sent earlier* → act on that
  feedback first, then run step 4 again for the new review.
- `The user approved.` → done.
- `Review session closed without feedback.` (or empty) → ask what they want.
- A `# Code review feedback` document:
  - **The user's own change (no link):** address every comment. Blocking ones
    first; for each, make the change or say why not.
  - **Someone else's MR/PR:** never edit their branch.
    - `question:` comments → answer each in chat, pointing at the code and the
      domain docs.
    - Every other label → draft a review comment for that file and line. Show
      the drafts. Only when the user says to, create them as GitLab **draft
      notes** (`glab api -X POST projects/:id/merge_requests/<iid>/draft_notes`
      with a `position` built from the MR's `diff_refs`) or a **pending** GitHub
      review (`gh api repos/:owner/:repo/pulls/<n>/reviews` without `event`),
      then tell the user to submit the review themselves.

## 6. Clean up

After diffotator exits, `git worktree remove <scratch>/mr-<iid>` if you made one.
