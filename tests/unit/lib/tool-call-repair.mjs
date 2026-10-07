// Re-export shim: the canonical reference logic for the tool-call
// syntax-failure repair loop now lives in repair.ts (promoted module);
// this file only forwards so the existing unit tests keep passing.
export * from "../../../repair.ts";
