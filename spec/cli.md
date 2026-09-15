# cli — writing spec

Spec and ticket JSON is **never edited by hand**. Only `spec/cli/index.ts` writes it, and validation runs before every write, so invalid input never reaches disk.

```bash
node spec/cli/index.ts validate    # validate current + all historical versions
node spec/cli/index.ts show        # print the current version
node spec/cli/index.ts bump        # next version, builds carried over
```

## build

```bash
node spec/cli/index.ts build:add --id auth-login --name "Login" \
  --verify "..." --verify "..." --note "initial"
node spec/cli/index.ts build:set --id auth-login --status building --note "why"
node spec/cli/index.ts build:rename --id auth-login --to auth-session --note "why"
node spec/cli/index.ts build:remove --id obsolete-thing
```

## ticket

```bash
node spec/cli/index.ts ticket:add --build auth-login --condition "..." \
  --title "..." --verify "..." --note "why"
node spec/cli/index.ts ticket:set --id tkt-0001 --status doing --note "why"
node spec/cli/index.ts ticket:remove --id tkt-0001
node spec/cli/index.ts ticket:list
node spec/cli/index.ts ticket:list --all
```

`ticket:list` shows open tickets; `--all` includes the archive.

## Shared options

`--type product|harness` (default `product`) and `--version <n>` (default: current) work on every command.

## `--verify` is repeated

```bash
--verify "有効な資格情報でセッションが発行される" --verify "無効な資格情報では 401 が返る"
```

Not comma-separated, because a condition may contain a comma. On a build, `--verify` replaces the whole list. On a ticket, it is a single string.

## `--note` is required on every change

```bash
node spec/cli/index.ts build:set --id auth-login --name "Session" --note "renamed to match the domain"
```

Changing anything means there was a reason. A `--note`-only update is allowed, for fixing a note that went stale.

`remove` and `bump` take none. One deletes what the note would describe, and the other is mechanical. Both print what they did, which is what `git log` keeps.

## Updating changes only what you pass

`build:set` and `ticket:set` change the flags you give and nothing else. Passing no change flag is an error. Adding is the exception: a new build starts as `planned` and a new ticket starts as `todo`, by definition.

## Versions

Commands always target the **current version**. `bump` takes no argument: the next version is current + 1.

`bump` **carries builds over**, because a breaking change is "some things change", not "everything disappears". `closed` builds are the exception: they are dropped, which is the only moment the build list shrinks. A closed build that something still references is kept instead, so the new version never starts with a dangling reference. `bump` prints what it dropped and what it kept.

`bump` also recomputes `progress` rather than carrying it, because the archive it counts changes with the version. See [ticket.md](ticket.md).

Pass `--version <n>` to touch history explicitly; the CLI warns when you do.

## Running it

`package.json` does not register the CLI. It has no dependencies and runs on `node` alone, so `node spec/cli/index.ts` is the only entry point.

**`v001` is the seed** and is written by hand once. Everything from `v002` on goes through the CLI.
