# Developer guidelines

How to set the project up, build it, test it and ship it.

| Document                                     | Covers                                                |
| :------------------------------------------- | :---------------------------------------------------- |
| [`setup.md`](setup.md)                       | The tools to install and how to get a first run.      |
| [`scripts.md`](scripts.md)                   | The `pnpm` commands and what each does.               |
| [`coding-standards.md`](coding-standards.md) | Where code belongs, and the rules it follows.         |
| [`testing.md`](testing.md)                   | Unit tests, type checks and pre-commit hooks.         |
| [`packaging.md`](packaging.md)               | Building a full `.app` bundle for local use.          |
| [`debugging.md`](debugging.md)               | Attaching to a running app and querying Gmail's page. |
| [`ci.md`](ci.md)                             | The CI workflows and merge checks.                    |
| [`documentation.md`](documentation.md)       | How the docs are written and where they are read.     |
| [`workflow.md`](workflow.md)                 | Issues, branches, pull requests and milestones.       |

The architecture these guidelines build against is in [`../shared/`](../shared/README.md),
[`../magimail/`](../magimail/README.md) and [`../magical/`](../magical/README.md).
