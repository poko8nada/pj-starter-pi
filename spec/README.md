# spec — the state of the project

This directory describes the **current state of the project**. Every task starts here, and every task updates it.

## Two layers

| Layer      | What it covers                            | Examples                                                   |
| ---------- | ----------------------------------------- | ---------------------------------------------------------- |
| `product/` | What is actually shipped                  | an app, a site, a library, linter/formatter config         |
| `harness/` | The outer machinery that runs the product | `.pi/`, `.github/workflows/`, `lefthook.yaml`, `AGENTS.md` |

They share the same structure. The line between them is whether the product still stands without it: **the harness can be removed and the product still works**.

## Files

```
spec/
  README.md          this document
  schema.ts          vocabulary, types, validation, I/O (the only read/write path)
  cli.ts             the command entry point
  schema.test.ts     tests for the validation logic
  product/v001.json  product definition
  harness/v001.json  harness definition
  tickets/           tickets (progress and record)
```

Versions use three-digit zero padding (`v001`). **The file name is the only source of truth for the version**, and the largest number is the current one. Padding keeps lexicographic order aligned with numeric order. Past versions are frozen history and are never updated.

## What to write

This is an excerpt of `harness/v001.json` as it actually exists.

```json
{
  "name": "project-starter-harness",
  "goal": [
    "プロダクトを成立させるための外側の仕組み（検証・整形・エージェント連携・CI）を提供すること",
    "フォークして新規プロジェクトの土台として使えること"
  ],
  "nongoal": ["プロダクト固有の振る舞いを提供すること"],
  "build": [
    {
      "id": "gate-quality",
      "name": "quality-gate 拡張",
      "verify": "edit/write の後、編集されたファイルに対して format / lint / typecheck が自動で走り、失敗が followUp としてエージェントに返る",
      "uses": ["script-typecheck-staged"],
      "status": { "state": "working", "text": "スターターとして稼働中" }
    }
  ]
}
```

`progress` appears only once tickets exist:

```json
{ "progress": { "done": 2, "total": 5 } }
```

### `build` is a thing to build

Not a "feature". Pages, authentication, APIs, and shared layouts all sit at the same level of abstraction, because they are all things you build and all things you can verify.

- It must be **verifiable as a unit**. If you cannot write `verify`, the granularity is wrong.
- **Omit what the code already tells you.** The stack is in `package.json`; skills are visible in the directory.
- But **do write dependencies**, because no single file reveals them.

### `id`

Format: lowercase, hyphen-separated, **at least two segments**. The first segment is the kind.

```
<kind>-<what it is>
```

This is the only part a machine can check. The vocabulary is **not enforced** — it is a guide, because a closed list cannot cover websites, SaaS, apps, backends, frameworks, and libraries at once, and forcing one would repeat the mistake made with the `trigger` enum.

What `id` must do is let a reader tell what gets built. **A constant segment carries no information**: `build-` appears on every id, so it distinguishes nothing. Prefer the kind.

| Kind        | What it looks like from outside  | Example                                |
| ----------- | -------------------------------- | -------------------------------------- |
| `page`      | Opening a URL shows it           | `page-home`, `page-settings`           |
| `api`       | An HTTP/RPC call returns         | `api-user-create`, `api-order-fetch`   |
| `cli`       | Running a command does something | `cli-validate`, `cli-spec`             |
| `lib`       | Importing it gives you something | `lib-parse`, `lib-hooks`               |
| `event`     | Something happening triggers it  | `event-order-placed`                   |
| `config`    | Changing config changes behavior | `config-lint-format`, `config-test`    |
| `component` | A reusable piece of UI           | `component-button`, `component-dialog` |
| `layout`    | A shell shared by screens        | `layout-header`, `layout-minimal`      |
| `schema`    | How data is stored               | `schema-user`, `schema-order`          |
| `migration` | Reshaping stored data            | `migration-add-user-role`              |
| `storage`   | Files, objects, caches           | `storage-avatar`                       |
| `auth`      | Proving who someone is           | `auth-login`, `auth-session-issue`     |
| `job`       | Runs on a schedule or queue      | `job-daily-report`                     |
| `notify`    | Tells the outside world          | `notify-email`, `notify-sound`         |
| `i18n`      | Switching language               | `i18n-ja`                              |
| `hook`      | Runs on a git operation          | `hook-lefthook`                        |
| `ci`        | Runs on push or PR               | `ci-pullfrog`, `ci-release`            |
| `gate`      | Judges quality and can block     | `gate-quality`                         |
| `ext`       | Loaded by a host as an extension | `ext-sound-notify`                     |
| `script`    | A standalone helper              | `script-typecheck-staged`              |
| `doc`       | Read to understand               | `doc-agents`, `doc-spec`               |
| `deploy`    | Puts it where it runs            | `deploy-cloudflare`                    |
| `infra`     | Defines what it runs on          | `infra-turso`                          |

Where the list is thin, extend it here. Adding a kind is a one-line change; being wrong is not fatal.

`id` can be changed with `build:rename`, which rewrites every `uses` reference for you. Do not replace by hand.

| Field      | Meaning                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verify`   | What counts as done. Free text. The thing that actually judges it is the ticket                                                                        |
| `uses`     | One-directional reference, written by the user to the used. **It does not enforce ordering** — it does not mean "cannot start until the other is done" |
| `progress` | Computed from tickets. `{ done, total }`. **Absent when there are no tickets**                                                                         |
| `status`   | Declared by hand. `{ state, text }`                                                                                                                    |

### `status` is declared, `progress` is computed

These are two independent axes, and they coexist.

|            | Written by | Answers                                    |
| ---------- | ---------- | ------------------------------------------ |
| `progress` | tickets    | How far along is the work in this project? |
| `status`   | a human    | What state is this thing actually in?      |

| `state`    | When                     |
| ---------- | ------------------------ |
| `planned`  | Plan only                |
| `building` | Under construction       |
| `working`  | Complete and running     |
| `retiring` | Still there, removing it |
| `closed`   | Gone                     |

These form a lifecycle:

```
planned ──→ building ──→ working ──→ retiring ──→ closed
  始点                                             終点
```

The ends mean "it is not there"; the three in between mean "it is there".

`retiring` exists because removing something deeply integrated is not one step: you migrate the callers, delete the calls, delete the code, drop the config. **That work needs somewhere to live**, and neither `working` nor `closed` can hold it.

`progress` is computed from tickets, and **a build with no tickets has no `progress` field at all** — never write `0/0`. The absent field means "this project is not tracking it yet".

`status` is **never derived from `progress`**. A starter's harness builds are running but have no tickets, so deriving would report them as `planned`. Validation checks only that `state` is in the vocabulary and `text` is non-empty; it does not cross-check the two axes, because agreeing on a lie is worse than a stale note.

**`text` is required.** It says why the build is in that state.

`text` can go stale when tickets move `progress` without anyone touching `status`. This is accepted, the same way a stale `verify` is accepted: both are free text.

### Rules

- **Never delete a build by hand.** `build:remove` handles it, and `bump` also drops `closed` builds. Deleting by hand would break `uses` references and tickets.
- All fields are required. Empty arrays are allowed; empty strings are not, because they are indistinguishable from a forgotten value.
- `progress` is the only field that may be absent, and absence carries meaning.

### What validation enforces, and what it does not

| Enforced                                      | Only guided                             |
| --------------------------------------------- | --------------------------------------- |
| `id` format: lowercase, hyphens, 2+ segments  | which kind to start with                |
| unique `id` within a file                     | whether the name reads well             |
| no unknown fields, no empty strings           | whether `verify` is actually verifiable |
| `uses` resolves to a real build, never itself | whether the dependency is real          |
| `state` in the vocabulary                     | whether the declared state is true      |
| `progress.total > 0` and `done <= total`      | —                                       |

`state` transitions are checked by the CLI rather than the schema, because the schema cannot see the previous state. The rule is one line:

> **A move that erases what happened is forbidden.**

Only `working`, `retiring`, and `closed` going back to `planned` are blocked: something that ran does not become a plan. Everything else is legitimate — skipping ahead (`planned → closed`), rebuilding (`working → building`), abandoning a removal (`retiring → working`), reopening (`closed → …`).

`planned → retiring` is odd on its face (retiring something that was never built) but is allowed: `state` is declared, so writing the right one next fixes it. Better than another rule.

## Writes go through the script

Never edit the JSON directly. Only the functions in `spec/schema.ts` read and write, and validation runs before every write, so invalid input never reaches disk. The CLI rejects any value outside the vocabulary.

```bash
node spec/cli.ts validate                  # validate current + all historical versions
node spec/cli.ts show                      # print the current version
node spec/cli.ts bump                      # next version, builds carried over
node spec/cli.ts build:add --id auth-login --name "Login" --verify "..." --text "not started"
node spec/cli.ts build:set --id auth-login --state building --text "why"
node spec/cli.ts build:rename --id auth-login --to auth-session
```

`--type product|harness` (default `product`) and `--version <n>` (default: current) are shared by every command.

`package.json` does not register the CLI. It has no dependencies and runs on `node` alone, so `node spec/cli.ts` is the only entry point. **`v001` is the seed** and is written by hand once; everything from `v002` on goes through the CLI.

Commands always target the **current version**. `bump` takes no argument: the next version is current + 1, and it **carries builds over** — a breaking change is "some things change", not "everything disappears". Pass `--version <n>` to touch history explicitly; the CLI warns when you do.

`build:set` changes only the flags you pass. Omitting a flag keeps the current value, and passing none at all is an error. Adding is the one exception: a new build starts as `planned` by definition.

## Tickets

`tickets/` holds **progress and record**, which is a different kind of thing from the definitions in `product/` and `harness/`. Definitions are inherited when the starter is forked; tickets are **not** — a new project starts with none, so no history from the starter carries over.

Not designed yet. The fork procedure will be settled once the ticket shape is decided.
