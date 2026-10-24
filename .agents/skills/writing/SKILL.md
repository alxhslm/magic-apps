---
name: writing
description: Write in the house style. Use before writing a commit message, pull request, issue, document or code comment, and when cutting prose that reads as filler or as machine-written.
---

# House style

`AGENTS.md` says what to write down. This says how it reads. It applies to code comments, commit
messages, pull requests, issues, documentation and review replies.

The artefact skills carry their own shapes; read the relevant one as well.
[`writing-docs`](../writing-docs/SKILL.md), [`writing-a-pr`](../writing-a-pr/SKILL.md),
[`writing-an-issue`](../writing-an-issue/SKILL.md).

## Sentences

- **Answer first.** The first sentence is the answer, or the decision the reader has to make. The
  same holds at paragraph level: the point, then the evidence.
- **Say ideas as sentences, not as nouns.** An abstract noun phrase packs an idea up and leaves the
  reader to unpack it. Unpack it yourself.
- **One idea per sentence.** Two clauses is usually one too many, and a semicolon holding two ideas
  together is usually two sentences.
- **Do not build a sentence around a long noun phrase.** If the reader has to hold twenty words
  before finding out they were the subject, turn it round and lead with the verb.
- **Say it positively.** "The choice is not delicate" makes the reader work it out; "pick anything in
  that band" does not.
- **Every number is a number of something.** Say what the quantity is and what it is relative to.
  "40 % faster" and "memory at 1.6" say nothing until you name the baseline and the unit.
- **No judgement smuggled in as an adverb.** "Sweeping the parameter properly" hides a claim that the
  earlier sweep was wrong. State that separately if you mean it.

| Do not write                     | Write                                                    |
| :------------------------------- | :------------------------------------------------------- |
| the operational surface is small | there is not much to maintain                            |
| this buys you resilience         | it keeps working when the connection drops               |
| X is load-bearing here           | the poller depends on X; remove it and nothing refreshes |
| the move here is X               | do X                                                     |
| this pays for itself             | you get the time back within a week                      |
| a step change in throughput      | roughly twice as fast                                    |
| the choice is not delicate       | pick anything in that band                               |

## Words

- British English. Semicolons, not em dashes.
- **Never call the project a "suite".** Say "this project", "the project" or "the apps".
- **No AI-writing idioms.** "Load-bearing", "the move", "surface area", "first-class", "up the value
  chain", "buys you", "for free", "at the end of the day", "worth its weight". Say the literal thing
  instead.
- **Ordinary words.** "Use", not "utilise" or "leverage". "Start", not "kick off". "Enough", not
  "sufficient". "About", not "circa" or "on the order of", unless you mean an order of magnitude.
- Plain declarative prose. State the thing rather than hedging around it, and do not pad. No jargon
  where an ordinary word works, and no long construction where a short one does.

## Titles

- Do not open a heading or a title with "The" where it reads without it: "Popover", not "The
  popover". Keep the article only where the phrase needs it.
- Do not put a module or file name in a title. Name the thing, not the file: "Alert scheduler", not
  "Alert scheduler (`alert-scheduler.ts`)".

## What goes in

- Tell the final story. Correct a mid-flight change in place; never append a record of your own
  mistakes.
- Cut anything that does not change what the reader does. A detail can be perfectly true and still
  dilute the point it sits next to, or send someone off after the wrong thing.
- Explain what is genuinely ambiguous or surprising. Cutting detail is not licence to leave someone
  guessing; the test is whether they can act on it, not how short it is.
- Present tense, active, with the code as the subject. Past tense for an approach that was rejected,
  with the measurement that settled it. Never the promotional register.

## Comments

A comment says why the code is as it is, never what changed about it.
`// the Atom feed returns a stale count for ~2s after a mark-as-read` earns its place.
`// changed to poll twice because of the stale count bug` does not; it is the same fact written as
history, and it belongs in the commit message. The same goes for `// this used to use the wrong
index` and `// fixed: was off by one`.

A comment that points at a document names the file and the section, and is repointed when the doc
moves. A bare `// see docs/... § 3.5` cannot be checked and goes stale the moment the doc is
renumbered.
