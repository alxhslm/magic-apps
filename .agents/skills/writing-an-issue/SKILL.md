---
name: writing-an-issue
description: Write or revise a GitHub issue. Use when filing a bug, a feature or a chore, when asked to open a ticket, or when editing an existing issue body.
---

# Writing an issue

An issue says what is wrong or what is missing. It is read twice: at triage, deciding
whether it is worth doing, and again months later by whoever picks it up to implement a solution.

## Before filing

Search first. The backlog runs past 130 issues, and if this one already exists, add what is
new to it rather than opening a second.

Then decide whether it warrants an issue at all. The axis is whether the change fits in the
pull request you are already writing:

- **Size.** A few lines, fix it now. Nobody wants an issue for a one-line guard.
- **Relatedness.** If a reviewer would have to ask why this is in the diff, it does not
  belong in the diff.

Only the combination forces a ticket: big enough to need explaining, and unrelated enough
that explaining it derails the review. Work too large for one issue becomes several issues.

## Title

Short, naming the problem rather than the solution, in the repo's commit style:
`fix(magimail): …`, `feat(magical): …`.

## Shape

A bug, a feature, a chore or a research issue starts from the matching form in
[`.github/ISSUE_TEMPLATE/`](../../../.github/ISSUE_TEMPLATE/). The form sets the structure
and asks its questions plainly; the rules below set how to write each answer. The generated
`###` headings are the form's doing, not a licence to write headings by hand.

An issue with no matching form is a short paragraph, then bullets if there is anything to
list. That is the whole format. Do not add headings of your own, unlike a PR description:
an issue this short does not need navigating, and a heading that argues a case turns it into
a report. Never hard-wrap; GitHub renders the breaks.

## The first sentence

This is the only part that changes with the type of issue.

**A bug: what breaks, and for whom.**

> Anyone building on their own Apple ID gets a dead widget and Focus Filter. Both extensions
> hardcode `4Y5C5NZNS5` as their App Group prefix and claim a group their signature cannot
> back.

Then give whatever evidence settles it. Where the bug has to be triggered rather than
observed, give the steps that reproduce it, and say what you saw against what you expected.
A number settles in a line what a paragraph cannot: "103 of 112 images end up with
`filter: none`".

**Symptom before suspected cause.** Say what the user sees before the cause you suspect. If
you have not proved the cause, say you have not. "The widget is dead" is the reader's
problem; "the App Group prefix is wrong" is your theory about it.

**A feature: what the user cannot do yet.** Explain the gap, then what it
should do, in bullets.

> Gmail changes its DOM without warning and the injected CSS breaks silently, so a user
> finds the regression before we do.
>
> - Runs daily on a schedule.
> - Loads Gmail with the injections and asserts the key selectors still resolve.
> - Opens an issue when they do not.

**A chore: something needs maintaining.** Supply the reason we need to change something: the duplication, the inconsistency, or the thing which is hard to maintain.

**Research issue: a question to answer.** A research issue tracks an investigation that
informs a decision. State the question, and the decision it unblocks.

## Pointers

A line saying where to look saves time for whoever picks up the issue. Refer to another part of the repo that solves a similar problem:

> The share extension shows the expected way: `share-extension/build.sh` stamps the resolved
> group into `Info.plist` and `ShareExtensionLogger.swift` reads it back at runtime.

If there is no precedent, refer to the relevant module, documentation or issue. Say nothing rather than manufacture one.

## Leave out

- **The investigation.** Which files you read, what you ruled out, what you have not
  verified. The conclusion is the issue; the search that found it is not.
- **Checkboxes.** Nobody goes back to tick them off, so a half-ticked list says nothing
  about what is left. Bullets instead.
- **Tables.** At this length a table is a list with borders.
- **Links as background.** Reference another issue only when it blocks this one, or this one
  blocks it.
- **Numbered plans.** Do not include step-by-step instructions in the issue. The person picking it up should determine the approach themselves.

## Be consistent

The [`writing`](../writing/SKILL.md) skill holds the prose rules.

**Under 150 words.** Longer only when there is genuinely a need for the extra detail. If it
will not fit, it is more than one issue.

**Use the names the code uses.** Use the exact identifiers and terminology found in the codebase:
for example `ensureRange` and `tray.rsvp` are clear, whereas "Cache coverage" and "in flight"
are not.

**Prefer simple words and shorter phrases.** "while the first fetch is still running" reads
better than "prior to the completion of the initial fetch".

**Give file paths** to help the reader locate the relevant code quickly.

## Labels and milestone

Always apply the relevant labels to the issue.

- **`app`** always: `magimail`, `magical`, `core`, or all three when the work spans the repo.
- **`type`** where one fits: `bug`, `enhancement`, `documentation`, `ci`, `infra`. Some issues
  carry none, so do not force it.
- **`area`** as many as genuinely apply: `swift`, `notifications`, `performance`, `security`.

A milestone says the work is committed to a named release. Set one when the issue falls inside a milestone's
scope and leave it empty otherwise.
