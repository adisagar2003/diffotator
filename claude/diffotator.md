---
description: Open the current diff (or a base ref) in diffotator for review
argument-hint: "[--base <ref>] [-C <dir>]"
allowed-tools: Bash(diffotator:*)
---

Run `diffotator $ARGUMENTS` in the background (it blocks until the review session
is submitted, which can exceed the Bash timeout). Tell the user the URL it prints
on stderr, then wait for the result and act on what comes back on stdout:

- `The user approved.` → review passed, proceed.
- `Review session closed without feedback.` (or empty) → dismissed, ask what they want.
- A `# Code review feedback` markdown document → address every comment in it.
  Blocking comments must be resolved before you continue. For each comment,
  either make the change or say why you are not making it.
