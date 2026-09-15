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
  README.md            this document
  lib/                 the model, one file per concern
    document.ts        what any document needs: guards, I/O, issues
    spec.ts            the spec document: Build, Spec, validation, versions
    ticket.ts          the ticket document: Ticket, validation, storage
    store.ts           what spans both: snapshot, progress, cross-document checks
  cli/                 the entry point, one file per role
    index.ts           dispatch
    args.ts            flag parsing and vocabulary checks
    shared.ts          loading, validation, display
    version.ts         validate / show / bump
    build.ts           build commands
    ticket.ts          ticket commands
  product/v001.json    product definition
  harness/v001.json    harness definition
  tickets/             current.json and archive/vN.json
```

Tests sit next to what they test (`spec/lib/spec.test.ts`). The split follows two axes: `lib/` is by concept, `cli/` is by role. A new file should belong to one or the other without inventing a third.

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
      "verify": [
        "edit/write の後、編集されたファイルに対して format / lint / typecheck が自動で走る",
        "チェックが失敗すると、その内容が followUp としてエージェントに返る"
      ],
      "uses": ["script-typecheck-staged"],
      "status": "working",
      "note": "スターターとして稼働中"
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

- It must be **verifiable as a unit**, and `verify` must list the conditions that make it done. If you cannot write one, the granularity is wrong.
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
| `verify`   | **The conditions that make it done.** See below                                                                                                        |
| `uses`     | One-directional reference, written by the user to the used. **It does not enforce ordering** — it does not mean "cannot start until the other is done" |
| `progress` | Computed from tickets. `{ done, total }`. **Absent when there are no tickets**                                                                         |
| `status`   | Declared by hand. One of `planned`, `building`, `working`, `retiring`, `closed`                                                                        |
| `note`     | Why it was last changed. Required on every change                                                                                                      |

### `verify` is a list of conditions

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

### `status` is declared, `progress` is computed

These are two independent axes, and they coexist.

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

`status` is **never derived from `progress`**. A starter's harness builds are running but have no tickets, so deriving would report them as `planned`. Validation checks only that `status` is in the vocabulary; it does not cross-check the two axes, because agreeing on a lie is worse than a stale note.

### `note` is the reason for the last change

Every change needs one. Changing a `name`, a `verify`, `uses`, or `status` means there was a reason, and `note` is where it goes. Updating `note` on its own is allowed, for fixing a note that went stale.

`note` is not a description of the state — that is what `status` is for. It answers "why did this change", so a build that has been renamed reads `status: "working"` with `note: "renamed because it now covers two pages"`.

`remove` and `bump` do not take a note. One deletes the thing the note would describe, and the other is mechanical. Both print what they did, which is what `git log` keeps.

### Whitespace

Leading and trailing whitespace is trimmed on every string, **on input only**. A value that is nothing but whitespace is rejected, since it is indistinguishable from a forgotten value.

Trimming happens in one place, `readString` in `schema.ts`, so it applies no matter which path wrote the value. Reading never trims: the file is the source of truth, and re-normalizing on read would make the in-memory shape disagree with what is on disk.

Whitespace _inside_ a value is left alone. Two spaces in the middle may be what the writer meant.

### Rules

- **Removing a build is `build:remove`, not a hand edit.** It refuses while anything still references the build by `uses`. Deleting by hand would leave those references dangling.
- **Never delete a build to end it.** That is what `closed` means. `build:remove` is for a build that should never have existed (wrong granularity, created twice).
- All fields are required. Empty arrays are allowed; empty strings are not, because they are indistinguishable from a forgotten value. Whitespace-only strings are not either.
- `progress` is the only field that may be absent, and absence carries meaning.

### What validation enforces, and what it does not

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

`status` transitions are checked by the CLI rather than the schema, because the schema cannot see the previous state. The rule is one line:

> **A move that erases what happened is forbidden.**

Only `working`, `retiring`, and `closed` going back to `planned` are blocked: something that ran does not become a plan. Everything else is legitimate — skipping ahead (`planned → closed`), rebuilding (`working → building`), abandoning a removal (`retiring → working`), reopening (`closed → …`).

`planned → retiring` is odd on its face (retiring something that was never built) but is allowed: `status` is declared, so writing the right one next fixes it. Better than another rule.

## Writes go through the script

Never edit the JSON directly. Only the functions in `spec/schema.ts` read and write, and validation runs before every write, so invalid input never reaches disk. The CLI rejects any value outside the vocabulary.

```bash
node spec/cli/index.ts validate                  # validate current + all historical versions
node spec/cli/index.ts show                      # print the current version
node spec/cli/index.ts bump                      # next version, builds carried over
node spec/cli/index.ts build:add --id auth-login --name "Login" --verify "..." --verify "..." --note "initial"
node spec/cli/index.ts build:set --id auth-login --status building --note "why"
node spec/cli/index.ts build:rename --id auth-login --to auth-session --note "why"
node spec/cli/index.ts build:remove --id obsolete-thing
node spec/cli/index.ts ticket:add --build auth-login --condition "..." --title "..." --verify "..." --note "why"
node spec/cli/index.ts ticket:set --id tkt-0001 --status doing --note "why"
node spec/cli/index.ts ticket:list
node spec/cli/index.ts ticket:list --all
```

`--type product|harness` (default `product`) and `--version <n>` (default: current) are shared by every command.

`package.json` does not register the CLI. It has no dependencies and runs on `node` alone, so `node spec/cli/index.ts` is the only entry point. **`v001` is the seed** and is written by hand once; everything from `v002` on goes through the CLI.

### Versions

Commands always target the **current version**. `bump` takes no argument: the next version is current + 1.

`bump` **carries builds over**, because a breaking change is "some things change", not "everything disappears". `closed` builds are the exception: they are dropped, which is the only moment the build list shrinks. A closed build that something still references by `uses` is kept instead, so the new version never starts with a dangling reference. `bump` prints what it dropped and what it kept.

Pass `--version <n>` to touch history explicitly; the CLI warns when you do.

### Updating

`build:set` changes only the flags you pass. Omitting a flag keeps the current value, and passing none at all is an error. Adding is the one exception: a new build starts as `planned` by definition.

## Tickets

A ticket is **work**, where a build is a thing the product has.

|            | build                         | ticket                           |
| ---------- | ----------------------------- | -------------------------------- |
| What it is | A property the product has    | The work of getting there        |
| Lifetime   | Permanent. Managed by version | Ends when done. Outside versions |
| Judged by  | The people using the product  | Whoever is building it           |

Definitions are inherited when the starter is forked; tickets are **not**. A new project starts with none, so no history from the starter carries over.

### The shape

```json
{
  "id": "tkt-0001",
  "specType": "product",
  "targets": [{ "build": "auth-login", "condition": "無効な資格情報では 401 が返る" }],
  "title": "失敗系の分岐を実装",
  "verify": "空欄・形式不正・不一致の3パターンで 401 とエラー表示が出る",
  "status": "todo",
  "note": "先に認証を通す必要がある",
  "resolvedIn": 1
}
```

| Field        | Meaning                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| `targets`    | Which build's which condition this moves forward. See below                |
| `title`      | What the work is                                                           |
| `verify`     | What done means, narrower than the condition it advances                   |
| `status`     | `todo`, `doing`, or `done`                                                 |
| `note`       | Same as a build's `note`: why it last changed                              |
| `resolvedIn` | Written by the machine. The version that was current when it became `done` |

### `targets`

`condition` names one entry of that build's `verify`, or `null` for work that touches a build without moving a condition forward (a refactor, chores). `build` and `condition` are written as pairs so that a condition cannot drift from its build.

A build can span one, many, or no tickets. One ticket may also target several builds at once — a shared component that advances a condition in three pages. `builds` is not a field because it is `targets.map(t => t.build)`.

**At most one condition per build, per ticket.** Wanting two means either splitting the ticket or splitting the build. This is what makes the work split at all: one build described as a paragraph has no seams, so every build would end up with exactly one ticket.

### Where tickets live

```
spec/tickets/
  current.json        open tickets: todo and doing
  archive/v001.json   tickets that reached done while v001 was current
```

One file each, not one per ticket. The live file holds **only open work**, so it cannot grow without bound.

Reading `progress` needs exactly two files, `current` and `archive/vN`, no matter how many versions exist. A ticket that reaches `done` moves to the archive immediately, and `resolvedIn` records which version that was — which also makes it the index for finding the ticket again when it is reopened.

Past versions' archives are **not read**. Renaming a build reaches the current archive but not an older one, and that is deliberate: the thing being checked is whether the current version agrees with the tickets. An old archive saying `page-home` where the current says `page-top` records that it was called `page-home` at the time.

### `progress`

The counts come from the tickets that point at a build:

```
progress = tickets targeting this build, in current + archive/vN
total    = how many
done     = how many have status done
```

A build with no tickets has **no `progress` field at all**. Absent means "this project is not tracking it yet". Never write `0/0`.

`progress` is stored, and `validate` checks it against the tickets for the current version. That check is what keeps the cached number honest, which is why storing it is safe at all.

`bump` recomputes rather than carries it over. The archive being read changes with the version, so a value that was correct for v001 would be a lie in v002. Where there are no tickets, the computation yields nothing and the field disappears.

Past versions' `progress` is a snapshot of that moment and is never checked against today's tickets.
