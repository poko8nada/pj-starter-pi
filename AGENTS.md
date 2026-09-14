# AGENTS.md

## Operational System

Development starter. It ships a harness, not a product. The harness is still under construction, so it is not ready for use yet.

## spec/

`spec/` describes the current state of the project. Every task starts there, and every task updates it.

Never edit spec JSON by hand. Write through the CLI; validation runs before every write.

```bash
node spec/cli.ts validate
node spec/cli.ts show
node spec/cli.ts build:add --id build-x --name X --verify "..." --text "..."
node spec/cli.ts build:state --id build-x --state working --text "..."
node spec/cli.ts bump --to 2
```

Read `spec/README.md` before writing spec. It covers the vocabulary, the required fields, and the rules that validation enforces.
