# AGENTS.md

## Operational System

Development starter. It ships a harness, not a product. The harness is still under construction, so it is not ready for use yet.

## spec/

`spec/` describes the current state of the project. Every task starts there, and every task updates it.

- `product/` — what is shipped
- `harness/` — the machinery that runs the product

Each holds versioned JSON.

### Build

A **build** is a thing to build and verify as a unit. It is not a "feature": pages, authentication, APIs, and shared layouts all sit at the same level.

- `status` is declared by hand: `planned`, `building`, `working`, `retiring`, `closed`
- `progress` is computed from tickets
- The two axes are independent on purpose

### Writing

Spec JSON is never edited by hand. Only `spec/cli.ts` writes it, and validation runs before every write.

Read `spec/README.md` for the model, the vocabulary, and the commands.
