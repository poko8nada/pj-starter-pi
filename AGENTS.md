# AGENTS.md

## Operational System

Development starter. It ships a harness, not a product. The harness is still under construction, so it is not ready for use yet.

## spec/

`spec/` describes the current state of the project. Every task starts there, and every task updates it.

Never edit spec or ticket JSON by hand. Only `spec/cli/index.ts` writes it, and validation runs before every write.

Read `spec/README.md` before touching spec.
