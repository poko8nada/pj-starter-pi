# AGENTS.md

## Operational System

Development starter. It ships a harness, not a product. The harness is still under construction, so it is not ready for use yet.

## spec/

`spec/` describes the current state of the project. Every task starts there, and every task updates it.

- `product/` — what is shipped
- `harness/` — the machinery that runs the product

Each holds versioned JSON. `tickets/` holds the work.

### Build

A **build** is a thing to build and verify as a unit. It is not a "feature": pages, authentication, APIs, and shared layouts all sit at the same level.

- `verify` lists the conditions that make it done. A ticket names one of them
- `status` is declared by hand: `planned`, `building`, `working`, `retiring`, `closed`
- `progress` is computed from tickets
- The two axes are independent on purpose

### Ticket

A **ticket** is work, where a build is a property the product has. It targets a build and one of its conditions. Tickets are not inherited when the starter is forked; the definitions are.

### Writing

Spec and ticket JSON is never edited by hand. Only `spec/cli/index.ts` writes it, and validation runs before every write.

Every change needs a `--note` giving the reason. `remove` and `bump` are the exceptions: one deletes what the note would describe, the other is mechanical.

Read `spec/README.md` for the model, the vocabulary, and the commands.
