// Re-export shim: the canonical mini-context logic was promoted to the
// extension root (../../mini-context.ts). These re-exports keep the existing
// unit tests (tests/unit/mini-context.test.mjs), the silo harness, and the
// step-definition skeleton importing this path working unchanged.
export * from "../../../mini-context.ts";
