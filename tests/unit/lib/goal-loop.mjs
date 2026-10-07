// Re-export shim: the canonical goal-loop implementation now lives in the
// shipped runtime module ../../goal-loop.ts (promoted verbatim from this
// file's former reference implementation). All export names and semantics are
// unchanged so tests/unit/goal-loop.test.mjs keeps passing.
export * from "../../../goal-loop.ts";
