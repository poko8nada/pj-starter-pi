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

```json
{
  "name": "...",
  "goal": ["what we want to achieve"],
  "nongoal": ["what we will not do"],
  "build": [
    {
      "id": "build-auth-login",
      "name": "Login",
      "verify": "Valid credentials issue a session; invalid ones fail",
      "uses": [],
      "progress": { "done": 2, "total": 5 },
      "status": { "state": "building", "text": "Session handling landed; guards pending" }
    }
  ]
}
```

### `build` is a thing to build

Not a "feature". Pages, authentication, APIs, and shared layouts all sit at the same level of abstraction, because they are all things you build and all things you can verify.

- It must be **verifiable as a unit**. If you cannot write `verify`, the granularity is wrong.
- **Omit what the code already tells you.** The stack is in `package.json`; skills are visible in the directory.
- But **do write dependencies**, because no single file reveals them.

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

| `state`    | When                 |
| ---------- | -------------------- |
| `planned`  | Plan only            |
| `building` | Under construction   |
| `working`  | Complete and running |
| `closed`   | Tracking has ended   |

`progress` is computed from tickets, and **a build with no tickets has no `progress` field at all** — never write `0/0`. The absent field means "this project is not tracking it yet".

`status` is **never derived from `progress`**. A starter's harness builds are running but have no tickets, so deriving would report them as `planned`. Validation checks only that `state` is in the vocabulary and `text` is non-empty; it does not cross-check the two axes, because agreeing on a lie is worse than a stale note.

**`text` is required.** It says why the build is in that state, and it is also where a `closed` build records its reason — there is no separate `closed` field.

`text` can go stale when tickets move `progress` without anyone touching `status`. This is accepted, the same way a stale `verify` is accepted: both are free text.

### Rules

- **Never delete a build.** Close it instead (`state: "closed"`). Deletion would break `uses` references and tickets.
- All fields are required. Empty arrays are allowed; empty strings are not, because they are indistinguishable from a forgotten value.
- `progress` is the only field that may be absent, and absence carries meaning.

## Writes go through the script

Never edit the JSON directly. Only the functions in `spec/schema.ts` read and write, and validation runs before every write, so invalid input never reaches disk. The CLI rejects any value outside the vocabulary.

```bash
node spec/cli.ts validate                  # validate current + all historical versions
node spec/cli.ts show                      # print the current version
node spec/cli.ts bump --to 2               # start the next version (builds are not carried over)
node spec/cli.ts build:add --id build-x --name X --verify "Y" --text "not started"
node spec/cli.ts build:state --id build-x --state building --text "why"
```

`--type product|harness` (default `product`) and `--version <n>` (default: current) are shared by every command.

`package.json` does not register the CLI. It has no dependencies and runs on `node` alone, so `node spec/cli.ts` is the only entry point. **`v001` is the seed** and is written by hand once; everything from `v002` on goes through the CLI.

## Tickets

`tickets/` holds **progress and record**, which is a different kind of thing from the definitions in `product/` and `harness/`. Definitions are inherited when the starter is forked; tickets are **not** — a new project starts with none, so no history from the starter carries over.

Not designed yet. The fork procedure will be settled once the ticket shape is decided.
