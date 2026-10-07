// Re-export shim: the settings-page reference logic now lives in the shipped
// module ../../mini-settings.ts (promoted with identical names/semantics), so
// the 31 existing unit tests in ../settings-page.test.mjs keep passing against
// the real implementation.
export * from "../../../mini-settings.ts";
