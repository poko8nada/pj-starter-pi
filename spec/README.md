# spec — the state of the project

This directory describes the **current state of the project**. Every task starts here, and every task updates it.

- [build.md](build.md) — a thing to build: `id`, `verify`, `status`, `note`
- [ticket.md](ticket.md) — work: `targets`, storage, `progress`
- [cli.md](cli.md) — the commands, and the rules they enforce

## Two layers

| Layer      | What it covers                            | Examples                                           |
| ---------- | ----------------------------------------- | -------------------------------------------------- |
| `product/` | What is actually shipped                  | an app, a site, a library, linter/formatter config |
| `harness/` | The outer machinery that runs the product | `.pi/`, `.github/workflows/`, `lefthook.yaml`      |

They share the same structure. The line between them is whether the product still stands without it: **the harness can be removed and the product still works**.

## Files

```
spec/
  README.md            this document
  build.md             the build model
  ticket.md            the ticket model
  cli.md               the commands
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

## Versions

Versions use three-digit zero padding (`v001`). **The file name is the only source of truth for the version**, and the largest number is the current one. Padding keeps lexicographic order aligned with numeric order. Past versions are frozen history and are never updated.

`v001` is the seed and is written by hand once. Everything from `v002` on goes through the CLI.

## Principles

These apply everywhere, and explain most of the decisions in the other documents.

- **Omit what the code already tells you.** The stack is in `package.json`; skills are visible in the directory. Dependency is the exception: no single file reveals it, so `uses` is written down.
- **Required fields are written; optional fields are not.** Anything optional gets skipped. Where leaving something out carries meaning (`progress`), the field is absent rather than zero.
- **Empty arrays are fine; empty strings are not.** `[]` is an answer. An empty string is indistinguishable from a value someone forgot to fill in.
- **Only the script writes.** Validation runs before every write, so a rule that cannot be checked by a machine is a rule that will not hold.
- **Do not add a field for something the machine cannot check.** A rule that can only be guided belongs in these documents, and adding it to the schema would only make it look enforced.

## Whitespace

Leading and trailing whitespace is trimmed on every string, **on input only**. A value that is nothing but whitespace is rejected, since it is indistinguishable from a forgotten value.

Trimming happens in one place, `readString` in `lib/document.ts`, so it applies no matter which path wrote the value. Reading never trims: the file is the source of truth, and re-normalizing on read would make the in-memory shape disagree with what is on disk.

Whitespace _inside_ a value is left alone. Two spaces in the middle may be what the writer meant.
