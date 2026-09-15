# project-starter

As this project is intended to serve as a starter, there is no actual product.

The harness is currently under implementation, so it is not yet available for use.

## Starting a project from this starter

Three steps.

```bash
# 1. Clone, and cut the history
git clone <this-repo> my-project
cd my-project
rm -rf .git && git init

# 2. Rename the project
#    package.json の name を自分のプロジェクト名に変える

# 3. Install
pnpm install
```

`pnpm install` runs `scripts/init.mjs` through the `prepare` hook. It:

- clears the starter's own tickets
- drops `closed` builds from the harness
- rewrites every build's `note` to "inherited from the starter"
- empties `product`, taking its `name` from `package.json`
- writes `spec/initialized.json`, so this only ever happens once

If you run it before step 2, it stops and tells you to rename first.

## Keeping the harness up to date

The starter keeps changing. To bring those changes into a project, run this **from the starter**:

```bash
node scripts/apply.mjs /path/to/my-project          # dry-run, prints what would change
node scripts/apply.mjs /path/to/my-project --run    # apply
```

It copies the harness, and never touches `spec/product/`, `spec/tickets/`, or anything under `.git/`. `AGENTS.md` is updated, `README.md` is not.

The copy is wholesale and file-based. `spec/harness/v001.json` holds every build in one file, so a line-based merge would conflict even when two sides edited different builds; the script does not try. Review with `git diff` and undo with `git restore` if you disagree.

## Where things are

`spec/` describes the current state of the project, and is the source of truth.

- `spec/README.md` — the model, and the principles behind it
- `spec/build.md` — what a build is
- `spec/ticket.md` — what a ticket is
- `spec/cli.md` — how to write spec

Never edit spec JSON by hand. Only `spec/cli/index.ts` writes it, and validation runs before every write.
