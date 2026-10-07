// index-level wiring test: the exported pure /mini command parser.
// (The four feature modules have their own suites; this one only covers the
// command surface refactored out of the registerCommand handler.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMiniCommand } from "./mini-command.ts";

test("empty input toggles mini mode", () => {
	assert.deepEqual(parseMiniCommand(""), { sub: "", goal: null });
	assert.deepEqual(parseMiniCommand("   "), { sub: "", goal: null });
});

test("plain subcommands parse case-insensitively", () => {
	for (const s of ["on", "off", "tiny", "large", "status", "settings"]) {
		assert.deepEqual(parseMiniCommand(s), { sub: s, goal: null });
		assert.deepEqual(parseMiniCommand(s.toUpperCase()), { sub: s, goal: null });
	}
});

test("bare goal reports status", () => {
	assert.deepEqual(parseMiniCommand("goal"), { sub: "", goal: { op: "status", text: "" } });
	assert.deepEqual(parseMiniCommand("  GOAL  "), { sub: "", goal: { op: "status", text: "" } });
});

test("goal start preserves objective case and spacing", () => {
	assert.deepEqual(parseMiniCommand("goal Fix the Bug in Parser.ts"), {
		sub: "",
		goal: { op: "start", text: "Fix the Bug in Parser.ts" },
	});
});

test("goal cancel", () => {
	assert.deepEqual(parseMiniCommand("goal cancel"), { sub: "", goal: { op: "cancel", text: "" } });
	assert.deepEqual(parseMiniCommand("goal CANCEL"), { sub: "", goal: { op: "cancel", text: "" } });
});

test("goal amend extracts steering text, case preserved", () => {
	assert.deepEqual(parseMiniCommand("goal amend Focus on Unit Tests"), {
		sub: "",
		goal: { op: "amend", text: "Focus on Unit Tests" },
	});
	assert.deepEqual(parseMiniCommand("goal amend"), { sub: "", goal: { op: "amend", text: "" } });
});

test("unknown input returns null (caller shows usage)", () => {
	assert.equal(parseMiniCommand("foo"), null);
	assert.equal(parseMiniCommand("goals"), null);
	assert.equal(parseMiniCommand("goalish"), null);
	assert.equal(parseMiniCommand("settingsx"), null);
});
