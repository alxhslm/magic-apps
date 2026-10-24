---
name: writing-a-pr
description: Write or revise a pull request description, or a report summarising a branch. Use when opening a PR, editing a PR body, or when asked to describe, summarise or write up what a branch changes.
---

# Writing a PR description

A PR description is read by someone deciding whether to approve the branch.

## The title

A short summary of the change, in the repo's commit style (`feat(magical): …`,
`docs(magical): …`, `fix(magimail): …`).

**Never put `Closes #n` in the title.** Issue links belong in the body; in the title they
push the summary out of view in every list the PR appears in.

## Shape

Open with one sentence saying what the branch does, then `Closes #n` on its own line.
Several are fine: `Closes #120, #121, #123`. The template at
[`.github/pull_request_template.md`](../../../.github/pull_request_template.md) carries this
shape, so fill it in rather than inventing one.

After that, three `##` sections:

- **What this PR does?**: what the branch gives someone that they did not have.
- **Why do we need it?**: anything a reviewer would otherwise query. A measurement that
  changed the plan, an approach ruled out and why.
- **How do you know it works?**: the evidence a reviewer cannot get from CI. Manual steps, a
  screenshot, a result that settles it.

`###` sub-headings inside those sections are fine; do not add further `##` sections. Three
sections of substance beat ten of scaffolding.

**Bullet the parallel parts and bold the first few words of each**, so the reader can scan
for the one they care about.

**Never hard-wrap.** GitHub and Notion render hard wraps as visible line breaks, which
chops paragraphs into fragments. Use natural line lengths. This is the opposite of the
rule for repo markdown files, which wrap at their configured limit.

## Say it plainly and concisely, but do not leave gaps

The [`writing`](../writing/SKILL.md) skill holds the prose rules, and they apply here too.

Write for a colleague who knows the codebase but was not involved in the PR. Use
clear words over verbose ones, and short constructions over long ones.

Explain anything that could otherwise be read the wrong way: a decision that looks arbitrary,
a number that looks made up, an approach that appears to contradict a convention.

Read it back and cut a third. The test is "does this help the reader
understand the PR?" Anything that fails this test is noise, however accurate.

## Summarise the final state

**Update the description as the branch changes.** A draft raised early is useful,
but for the final review **the description must reflect the final state of the branch.**
The reviewer does not need to know about earlier iterations of the PR.

Correct mid-flight changes **in place**. No "correction" sections, no changelog of
your own mistakes, and no superseded text left in.

The exception is when the error itself matters to the reader: a trap the next person will
fall into, or a result someone has already acted on. Then it is a finding, and it belongs in
the description.

Before requesting review, read the description against the log since the last push, and rewrite it
to describe the final state of the work.

## Leave out

- **Test counts, typecheck status, lint status.** CI reports these. Evidence a reviewer
  cannot get from CI goes in `How do you know it works?`, not in a second copy of what CI
  already ran.
- **"Not verified" sections and status caveats.** If something genuinely cannot be trusted,
  say it in one sentence where it is relevant. Do not build a section around it.
- **Tables restating what the prose already said.** A table earns its place when one small
  schema repeats across rows and the reader will scan for one of them, not when it is a list
  with borders. Make the last column the reason or the consequence.
- **A file-by-file walkthrough.** The diff is right there.
