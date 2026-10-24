# Documentation

Technical documentation for `magimail`, `magical` and `@magimail/core`. Each app folder and
`shared/` carries its own README.

## What's in this folder

| Document                                                  | Covers                                                    |
| :-------------------------------------------------------- | :-------------------------------------------------------- |
| [`magimail/`](magimail/README.md)                         | How the Gmail client works, subsystem by subsystem.       |
| [`magical/`](magical/README.md)                           | How the calendar client works today.                      |
| [`shared/`](shared/README.md)                             | Concerns belonging to both apps or to `@magimail/core`.   |
| [`developer-guidelines/`](developer-guidelines/README.md) | How to set the project up, build it, test it and ship it. |

## What belongs in the docs

Not everything belongs in the docs. These docs explain to a developer how the system works and how
to contribute.

| Kind                                    | Answers                       | Rule                                                               |
| :-------------------------------------- | :---------------------------- | :----------------------------------------------------------------- |
| `GitHub Issues`                         | _What does it do / roadmap?_  | Records every planned, active, and completed feature               |
| `docs/magimail/`, `magical/overview.md` | _How does the code work?_     | Strictly what is true of `main` today. Verifiable against the tree |
| `specs/<app>/`                          | _How unbuilt work is planned_ | Implementation blueprints for unbuilt features (graduate as built) |

1. **Before changing code**: read the relevant architecture document in `docs/magimail/` or
   `docs/magical/`. Never assume Electron does all the work. Check
   [`shared/process-model-and-ipc.md`](shared/process-model-and-ipc.md) and
   [`magimail/process-model-and-ipc.md`](magimail/process-model-and-ipc.md) to see whether the Swift helper, C++
   N-API addon, or an App Extension owns the behaviour.
2. **Keep these files up to date.** Before opening a PR, check what your change invalidated and fix
   it in the same PR, not as a follow-up:
   - _Changed how the code works?_ → update the matching document in `docs/magimail/` or
     `docs/magical/`.
   - _Changed how a subsystem is built, or ruled an approach out?_ → update the relevant spec or
     shared document, stating a major decision and the constraint that settled it.
   - _Removing code counts_: deleting a feature, setting, or IPC channel leaves prose that sends the
     next reader looking for something that is no longer there.
