# build — a thing to build

A **build** is a thing the product has. Not a "feature": pages, authentication, APIs, and shared layouts all sit at the same level, because they are all things you build and all things you can verify.

- It must be **verifiable as a unit**, and `verify` must list the conditions that make it done. If you cannot write one, the granularity is wrong.
- **Omit what the code already tells you.** The stack is in `package.json`; skills are visible in the directory.
- But **do write dependencies**, because no single file reveals them.

```json
{
  "id": "gate-quality",
  "name": "quality-gate 拡張",
  "verify": [
    "edit/write の後、編集されたファイルに対して format / lint / typecheck が自動で走る",
    "チェックが失敗すると、その内容が followUp としてエージェントに返る"
  ],
  "uses": ["script-typecheck-staged"],
  "status": "working",
  "note": "スターターとして稼働中"
}
```

| Field      | Meaning                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`       | The name of the thing. See below                                                                                                                       |
| `name`     | Human-readable label                                                                                                                                   |
| `verify`   | **The conditions that make it done.** See below                                                                                                        |
| `uses`     | One-directional reference, written by the user to the used. **It does not enforce ordering** — it does not mean "cannot start until the other is done" |
| `progress` | Computed from tickets. `{ done, total }`. **Absent when there are no tickets**                                                                         |
| `status`   | Declared by hand. One of `planned`, `building`, `working`, `retiring`, `closed`                                                                        |
| `note`     | Why it was last changed. Required on every change                                                                                                      |

## `id`

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

## `verify` is a list of conditions

Each entry is **one observable result**. Not a paragraph describing the build.

```json
"verify": [
  "有効な資格情報でセッションが発行される",
  "無効な資格情報では 401 が返る"
]
```

This is where splitting power comes from. A single paragraph has no seams, so a ticket can only mirror it one-to-one and you end up with exactly one ticket per build. Conditions are seams: a ticket names the one condition it moves forward.

Conditions are also what `verify`-ability checks against: if you cannot write one as an observable result, that build has the wrong granularity.

Rules: at least one condition, no empty strings, and **no duplicates within the same build** (a ticket refers to a condition by its text, so a duplicate makes the referent ambiguous). The same wording may appear in different builds — those are different conditions.

`--verify` is repeated to pass several. It is not comma-separated, because a condition may contain a comma.

## `status` and `progress` are independent

They coexist, and neither is derived from the other.

|            | Written by | Answers                                    |
| ---------- | ---------- | ------------------------------------------ |
| `progress` | tickets    | How far along is the work in this project? |
| `status`   | a human    | What state is this thing actually in?      |

| `status`   | When                     |
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

`status` is **never derived from `progress`**. A starter's harness builds are running but have no tickets, so deriving would report them as `planned`. Validation checks only that `status` is in the vocabulary; it does not cross-check the two axes, because agreeing on a lie is worse than a stale note. See [ticket.md](ticket.md) for how `progress` is computed.

## `note` is the reason for the last change

Every change needs one. Changing a `name`, a `verify`, `uses`, or `status` means there was a reason, and `note` is where it goes. Updating `note` on its own is allowed, for fixing a note that went stale.

`note` is not a description of the state — that is what `status` is for. It answers "why did this change", so a build that has been renamed reads `status: "working"` with `note: "renamed because it now covers two pages"`.

`remove` and `bump` do not take a note. One deletes the thing the note would describe, and the other is mechanical. Both print what they did, which is what `git log` keeps.

## `status` transitions

Checked by the CLI rather than the schema, because the schema cannot see the previous state. The rule is one line:

> **A move that erases what happened is forbidden.**

Only `working`, `retiring`, and `closed` going back to `planned` are blocked: something that ran does not become a plan. Everything else is legitimate — skipping ahead (`planned → closed`), rebuilding (`working → building`), abandoning a removal (`retiring → working`), reopening (`closed → …`).

`planned → retiring` is odd on its face (retiring something that was never built) but is allowed: `status` is declared, so writing the right one next fixes it. Better than another rule.

## Rules

- **Removing a build is `build:remove`, not a hand edit.** It refuses while anything still references the build, by `uses` or by a ticket. Deleting by hand would leave those references dangling.
- **Never delete a build to end it.** That is what `closed` means. `build:remove` is for a build that should never have existed (wrong granularity, created twice).
- All fields are required. Empty arrays are allowed; empty strings are not.

## What validation enforces

| Enforced                                          | Only guided                              |
| ------------------------------------------------- | ---------------------------------------- |
| `id` format: lowercase, hyphens, 2+ segments      | which kind to start with                 |
| unique `id` within a file                         | whether the name reads well              |
| `verify`: 1+ conditions, no duplicates in a build | whether a condition is really observable |
| `note` present and non-empty                      | whether the note explains anything       |
| no unknown fields, no empty strings               | —                                        |
| `uses` resolves to a real build, never itself     | whether the dependency is real           |
| `status` in the vocabulary                        | whether the declared status is true      |
| `progress.total > 0` and `done <= total`          | —                                        |
