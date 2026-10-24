---
name: writing-docs
description: Write or edit a document under docs/. Use before creating a new document, editing one in docs/magimail/, docs/magical/ or docs/shared/, or promoting a spec once a subsystem ships.
---

# Writing documentation

Write for the person who has to understand a subsystem and change it. The document exists so they
can get the subsystem in one sitting; everything else is secondary to that.

`AGENTS.md` says what to document, and [`writing`](../writing/SKILL.md) says how the prose reads.
This skill says what belongs in a document under `docs/`. Read both first.

No document can be copied wholesale. Follow this skill instead, and the docs will become the
examples once they are right.

## Draw the whole before the parts

Show the shape of a subsystem near the top, before any detail. Draw it in Mermaid, so the reader has
the whole before the parts;
[`process-model-and-ipc.md`](../../../docs/shared/process-model-and-ipc.md) leads with the process
topology, and every later section is about a part that diagram has already established.

## Living documents and specs

`docs/<app>/` describes what runs on `main` today. `specs/<app>/` describes what nobody has built
yet, and the choice the design settles on. [`specs/README.md`](../../../specs/README.md) indexes
them, and the app's `README.md` links to its own.

`docs/shared/` holds what both apps or `@magimail/core` share: design, native UI, the menu bar,
notifications, widgets, Focus filters, sessions, building, logging, licensing, performance.
A shared document may be a spec, which is what its `Status` line marks.

The test for which folder owns a sentence is whether it is true of one app or of both. **If a
sentence is true of both apps it belongs in `docs/shared/`; if it is true of one, it belongs in that
app.** A shared document states a mechanism or an invariant once, and an app document states only its
own specifics and links to the shared document for the concept. A shared document never describes one
app's choices, and nothing is stated twice.

The line is absolute in one direction: nothing unbuilt belongs in a living document. No status
banners, no "not yet verified" warnings, no test counts. A living document that hedges describes
your confidence rather than the code, and a reader cannot act on it.

The other direction is softer. A spec may note which parts of its subject already exist, so nobody
rebuilds them.

A living architecture page never links into `specs/`. If a sentence needs the pointer to make sense,
state the thing outright instead. An index, such as `docs/README.md`, an app `README.md` or the
workflow page, may point at the `specs/` folder; that is navigation, not a living page leaning on
unbuilt work.

## Describe main, not its history

Do not narrate a past defect, and do not cite an issue or pull request number. When a past defect
teaches a rule, state the rule and its reason, not the story.

Where a decision is major and its reason is not obvious from the code, state the reason in the
prose, with the constraint that settled it. Do not gather rejected alternatives into their own
section; the reader wants the decision, not the debate. Give a measurement only where a reader would
otherwise doubt the claim.

## Promotion

When a subsystem ships, its spec is rewritten into `docs/<app>/` and what remains unbuilt stays in
`specs/<app>/`.

Promotion is a rewrite against the code, never a `git mv`. Read the implementation and write what
it actually does. Specs drift, and promotion is where the drift shows; fix what you find in the
same change rather than carrying it over.

Remove the entry from `docs/<app>/README.md`, and update the tables in `docs/README.md` and
`docs/<app>/README.md`. A code comment that cites a doc names the file and the section, and is
repointed when the doc moves.

## One subject per document

Name each document for what it covers, and give it one idea. A file called `notifications.md` beside
another `notifications.md` tells the reader nothing, and a grab-bag tells them less. Merge a new
subject into the document that already owns it rather than starting another.

Split rather than grow. A short page is fine; a page that has outgrown its subject becomes two.

## Keep it readable

- Explain what will trip someone up: a surprising constant, a name that means something else, an
  order that looks arbitrary and is not.
- Give versions, counts, percentages and sizes, each with what it is relative to. No hype:
  "powerful", "seamless", "easy" and "simple" say nothing, and "just" hides the work a step takes.
- Address the reader as "you", make the code the subject of the sentence, and never write "we", "our"
  or "I".
- Use a table, a diagram or a code snippet where it explains the thing faster than prose does.

The rest of the prose style is [`writing`](../writing/SKILL.md)'s, and applies here unchanged.

## Mechanical conventions

Settled across the tree; follow them without deliberating.

- Sentence case in headings, and two levels of them: H2 for a section, H3 only where a section holds
  more than one idea, nothing deeper. Many sections at one level with two lines each is a smell.
- Name the headings, never number them. A reference to another part of the docs is a link to that
  named section, not a section number.
- Do not open a heading with "The" where it reads without it, and do not put a module or file name in
  a heading. Name the thing, not the file.
- Mermaid for diagrams: `sequenceDiagram` for a round trip, `flowchart` for topology.
- Links relative, with the filename in a code span.
- Tag every code fence with its language, using the spelling already common here: `ts`, `bash`,
  `json`, `swift`, `css`, `js`, `objc`, `xml`, `markdown`, `http`, or `plain text` for output and
  mockups.
- A callout marks a caveat, and only where a reader could be misled without one, such as a security
  or data-loss note. No decorative callouts, badges or tabs.

## Before finishing

Check that every relative link resolves, that no living document points into `specs/`, and that every
claim you wrote from memory rather than read out of the code has been checked against the code.
