// Unit tests for the tool-call syntax-failure repair loop reference logic
// (tests/unit/lib/tool-call-repair.mjs). Mirrors the acceptance tables in
// specs/features/tool-call-repair/*.feature row-by-row; no live model needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CLASSIFIER_PATTERNS,
	MAX_REPAIR_ATTEMPTS_PER_CALL,
	MAX_REPAIR_CALLS_PER_TURN,
	BACKOFF_MS_TRANSIENT,
	REPAIR_CONTEXT_BYTE_BUDGET,
	FIXER_SYSTEM_PROMPT,
	classifyFailure,
	buildRepairContext,
	extractRepairedArgs,
	validateAgainstContract,
	initialRepairState,
	canStartRepair,
	advance,
} from "./lib/tool-call-repair.mjs";

// Contracts grounded in pi-mini's real tools (edit, bash).
const EDIT_CONTRACT = { name: "edit", required: ["path", "oldText", "newText"], fields: { path: "string", oldText: "string", newText: "string" } };
const BASH_CONTRACT = { name: "bash", required: ["command"], fields: { command: "string", timeout: "integer" } };

// --- 1. classifyFailure: every classification.feature outline row -------------

// [toolName, rawArgs, errorText, contract?, expectedClass, expectedPatternId]
const CLASSIFICATION_ROWS = [
	["edit", '{"path": "src/index.ts", "oldText": "const x', "Unexpected end of JSON input", null, "syntax-repairable", "args:unbalanced-json"],
	["edit", '{"path": "a.txt", "oldText": "x", "newText', "Unterminated string in JSON", null, "syntax-repairable", "args:unbalanced-json"],
	["bash", '{"timeout": 5}', "must have required property 'command'", BASH_CONTRACT, "syntax-repairable", "contract:missing-required"],
	["bash", '{"timeout": 5}', "must have required property 'command'", null, "syntax-repairable", "syntax:missing-required"],
	["bash", '{"command": "ls", "workdir": "/tmp"}', "must NOT have additional properties 'workdir'", BASH_CONTRACT, "syntax-repairable", "contract:unknown-field"],
	["bash", '{"command": "ls", "workdir": "/tmp"}', "must NOT have additional properties 'workdir'", null, "syntax-repairable", "syntax:additional-prop"],
	["bash", '{"command": "ls", "timeout": "fast"}', "must be of type integer", BASH_CONTRACT, "syntax-repairable", "contract:type-mismatch"],
	["bash", '{"command": "ls", "timeout": "fast"}', "must be of type integer", null, "syntax-repairable", "syntax:type-mismatch"],
	["read", '{"path": 42}', "must be of type string", null, "syntax-repairable", "syntax:type-mismatch"],
	["bash", '{"command": ["npm", "test"]}', "must be of type string", BASH_CONTRACT, "syntax-repairable", "contract:type-mismatch"],
	["edit", '{"path": "a.txt"}', "missing required property 'oldText'", null, "syntax-repairable", "syntax:missing-required"],
	["bash", '{"command": "cat missing.txt"}', "ENOENT: no such file or directory, open 'missing.txt'", null, "semantic", "semantic:file-not-found"],
	["bash", '{"command": "sl"}', "bash: sl: command not found", null, "semantic", "semantic:command-not-found"],
	["bash", '{"command": "false"}', "Command failed with exit code 1", null, "semantic", "semantic:exit-code"],
	["bash", '{"command": "npm test"}', "connect ETIMEDOUT 127.0.0.1:11434", null, "transient", "transient:errno"],
	["bash", '{"command": "npm test"}', "request timed out after 90000 ms", null, "transient", "transient:timeout"],
	["bash", '{"command": "npm test"}', "fetch failed: connect ECONNREFUSED 127.0.0.1:11434", null, "transient", "transient:errno"],
	["bash", '{"command": "npm test"}', "429 Too Many Requests", null, "transient", "transient:rate-limit"],
	["edit", '{"path": "a.txt", "oldText": "x", "newText": "y"}', "unknown failure with well-formed args", null, "semantic", "semantic:default"],
];

test("classifyFailure: regex taxonomy outline rows", () => {
	for (const [toolName, rawArgs, errorText, contract, expectedClass, expectedPattern] of CLASSIFICATION_ROWS) {
		const result = classifyFailure(toolName, rawArgs, errorText, contract ?? undefined);
		assert.equal(result.class, expectedClass, `${toolName} / ${errorText} -> class`);
		assert.equal(result.matchedPattern, expectedPattern, `${toolName} / ${errorText} -> pattern`);
		assert.ok(result.evidence && result.evidence.length > 0, `${toolName} / ${errorText} -> evidence present`);
	}
});

test("classifyFailure: structural contract check fires when error text is silent", () => {
	const result = classifyFailure("edit", '{"path": "a.txt", "newText": "y"}', "tool execution failed", EDIT_CONTRACT);
	assert.equal(result.class, "syntax-repairable");
	assert.equal(result.matchedPattern, "contract:missing-required");
});

test("classifyFailure: transient wins even over unbalanced rawArgs (fixed precedence)", () => {
	const result = classifyFailure("bash", '{"command": "ls', "connect ETIMEDOUT 127.0.0.1:11434");
	assert.equal(result.class, "transient");
	assert.equal(result.matchedPattern, "transient:errno");
});

test("classifyFailure: string where contract wants array/object shape is repairable", () => {
	// bash.command is a string; the model emitted an array -> structure violation.
	const result = classifyFailure("bash", '{"command": ["npm", "install"]}', "must be of type string", BASH_CONTRACT);
	assert.equal(result.class, "syntax-repairable");
	assert.equal(result.matchedPattern, "contract:type-mismatch");
});

test("classifier pattern table: ids are unique and match the spec vocabulary", () => {
	const ids = CLASSIFIER_PATTERNS.map((p) => p.id);
	assert.equal(new Set(ids).size, ids.length, "pattern ids must be unique");
	for (const p of CLASSIFIER_PATTERNS) {
		assert.match(p.id, /^(transient|syntax|semantic):[a-z-]+$/);
		assert.ok(p.pattern instanceof RegExp);
		assert.ok(["errorText", "rawArgs"].includes(p.source));
	}
});

// --- 2. buildRepairContext ------------------------------------------------------

test("buildRepairContext: contains contract + rawArgs + classification, nothing else", () => {
	const classification = classifyFailure("edit", '{"path": "a.txt", "oldText": "x', "Unexpected end of JSON input");
	const ctx = buildRepairContext("edit", EDIT_CONTRACT, '{"path": "a.txt", "oldText": "x', classification);
	assert.ok(ctx.user.includes(JSON.stringify(EDIT_CONTRACT)), "context contains the contract summary");
	assert.ok(ctx.user.includes('{"path": "a.txt", "oldText": "x'), "context contains rawArgs verbatim");
	assert.ok(ctx.user.includes(JSON.stringify(classification)), "context contains the classification");
	assert.equal(ctx.system, FIXER_SYSTEM_PROMPT);
	assert.match(ctx.system, /STRICT JSON only/);
	assert.match(ctx.system, /intent VERBATIM/i);
	assert.ok(ctx.bytes <= REPAIR_CONTEXT_BYTE_BUDGET, `context ${ctx.bytes} bytes <= ${REPAIR_CONTEXT_BYTE_BUDGET}`);
});

test("buildRepairContext: contains no unrelated session history", () => {
	const history = "PREVIOUS TURN: the user asked about delegate_to_worker and the model called bash npm test";
	const ctx = buildRepairContext("edit", EDIT_CONTRACT, '{"path": "a", "oldText": "x', {
		class: "syntax-repairable",
		matchedPattern: "args:unbalanced-json",
	});
	assert.ok(!ctx.system.includes(history.slice(0, 30)));
	assert.ok(!ctx.user.includes(history.slice(0, 30)));
	assert.ok(!ctx.user.includes("delegate_to_worker"));
	// The only tool mentioned is the one being repaired.
	assert.ok(!ctx.user.includes("TOOL: bash"));
});

test("buildRepairContext: throws when rawArgs would blow the byte budget", () => {
	const huge = '{"path": "' + "x".repeat(REPAIR_CONTEXT_BYTE_BUDGET) + '"';
	assert.throws(
		() => buildRepairContext("edit", EDIT_CONTRACT, huge, { class: "syntax-repairable", matchedPattern: "args:unbalanced-json" }),
		/over the \d+-byte budget/,
	);
});

// --- 3. extractRepairedArgs (strict-JSON-only) ------------------------------------

// [reply, expectedOk]
const EXTRACTION_ROWS = [
	['{"path":"a.txt","oldText":"x","newText":"y"}', true],
	['```json\n{"path":"a.txt","oldText":"x","newText":"y"}\n```', true],
	["Here is the fix: {\"path\":\"a.txt\"} done!", false],
	['{"path":"a.txt","oldText":"x","newText":"y"} Let me explain why.', false],
	["The problem was the missing quote. Fixed version below.", false],
	['```json\n{"path":"a.txt","oldText":"x"}\n``` The newText stays the same.', false],
	["not json at all", false],
	['{"path":"a.txt","oldText":"x","newText":"y"}', true],
	['["not","an","object"]', false], // fence-free array: no-json-object (does not start with {)
	['', false],
	['   ', false],
];

test("extractRepairedArgs: strict-JSON-only outline rows", () => {
	for (const [reply, expectedOk] of EXTRACTION_ROWS) {
		const result = extractRepairedArgs(reply);
		assert.equal(result.ok, expectedOk, `reply ${JSON.stringify(reply.slice(0, 50))} -> ok=${expectedOk}`);
	}
});

test("extractRepairedArgs: tolerates truncation via brace balancing but stays strict about prose", () => {
	// Truncated fixer output is closed tolerantly (same spirit as parser.ts)…
	const truncated = extractRepairedArgs('{"path":"a.txt","oldText":"x');
	assert.equal(truncated.ok, true);
	assert.equal(truncated.args.path, "a.txt");
	// …but a valid object followed by prose rejects.
	const withProse = extractRepairedArgs('{"path":"a.txt"} hope this helps');
	assert.equal(withProse.ok, false);
});

test("extractRepairedArgs: accepts a repaired edit call end-to-end", () => {
	const result = extractRepairedArgs('{"path":"src/index.ts","oldText":"const x = 1","newText":"const x = 2"}');
	assert.equal(result.ok, true);
	const v = validateAgainstContract(result.args, EDIT_CONTRACT);
	assert.equal(v.ok, true);
});

// --- 4. validateAgainstContract ----------------------------------------------------

test("validateAgainstContract: required / unknown / type checks", () => {
	assert.deepEqual(validateAgainstContract({ path: "a", oldText: "x", newText: "y" }, EDIT_CONTRACT), { ok: true, errors: [] });
	assert.equal(validateAgainstContract({ path: "a", newText: "y" }, EDIT_CONTRACT).ok, false);
	assert.ok(validateAgainstContract({ path: "a", newText: "y" }, EDIT_CONTRACT).errors.includes("missing-required:oldText"));
	assert.ok(validateAgainstContract({ path: "a", oldText: "x", newText: "y", extra: 1 }, EDIT_CONTRACT).errors.includes("unknown-field:extra"));
	assert.ok(validateAgainstContract({ path: 42, oldText: "x", newText: "y" }, EDIT_CONTRACT).errors.includes("type-mismatch:path:expected-string"));
	// string where array expected / array where string expected
	assert.ok(validateAgainstContract({ command: ["npm", "test"] }, BASH_CONTRACT).errors.includes("type-mismatch:command:expected-string"));
	assert.ok(validateAgainstContract("nope", BASH_CONTRACT).errors.includes("args-not-object"));
	// integer is a number but a string is not an integer
	assert.equal(validateAgainstContract({ command: "ls", timeout: 30 }, BASH_CONTRACT).ok, true);
	assert.ok(validateAgainstContract({ command: "ls", timeout: "30" }, BASH_CONTRACT).errors.includes("type-mismatch:timeout:expected-integer"));
});

// --- 5. Guardrail state machine ------------------------------------------------------

test("canStartRepair: the guardrails-retries.feature counter matrix", () => {
	// [wrapfixUsed, delegateUsed, repairUsed, attempt, expectedDecision]
	const MATRIX = [
		[0, 0, 0, 1, true],
		[0, 0, 0, 2, true],
		[0, 0, 0, 3, false], // over maxRepairAttemptsPerCall
		[2, 8, 0, 1, true], // wrapfix + delegate budgets spent: repair unaffected
		[0, 0, 1, 1, true],
		[0, 0, 2, 1, false], // per-turn repair cap reached
		[2, 8, 2, 1, false],
		[0, 8, 1, 2, true],
		[2, 0, 1, 2, true],
	];
	for (const [wrapfixUsed, delegateUsed, repairUsed, attempt, expected] of MATRIX) {
		const state = initialRepairState();
		state.wrapfixThisTurn = wrapfixUsed;
		state.delegateThisTurn = delegateUsed;
		state.repairCallsThisTurn = repairUsed;
		assert.equal(
			canStartRepair(state, attempt),
			expected,
			`wrapfix=${wrapfixUsed} delegate=${delegateUsed} repairUsed=${repairUsed} attempt=${attempt}`,
		);
	}
});

test("advance: full repair lifecycle accepted on attempt 2", () => {
	let s = initialRepairState();
	s = advance(s, { type: "tool_failed", classification: { class: "syntax-repairable" } });
	assert.equal(s.phase, "repairing");
	assert.equal(s.attemptsThisCall, 1);
	assert.equal(s.repairCallsThisTurn, 1);
	s = advance(s, { type: "repair_attempt_finished", accepted: false, reclassification: { class: "syntax-repairable" } });
	assert.equal(s.phase, "repairing");
	assert.equal(s.attemptsThisCall, 2);
	s = advance(s, { type: "repair_attempt_finished", accepted: true });
	assert.equal(s.phase, "accepted");
});

test("advance: exhaustion after 2 failed attempts surfaces original + last error", () => {
	let s = initialRepairState();
	s = advance(s, { type: "tool_failed", classification: { class: "syntax-repairable" } });
	s = advance(s, { type: "repair_attempt_finished", accepted: false });
	s = advance(s, { type: "repair_attempt_finished", accepted: false });
	assert.equal(s.phase, "exhausted");
	assert.equal(s.reason, "max-attempts");
	assert.equal(s.attemptsThisCall, MAX_REPAIR_ATTEMPTS_PER_CALL);
	// No third attempt: further finishes are ignored.
	s = advance(s, { type: "repair_attempt_finished", accepted: false });
	assert.equal(s.phase, "exhausted");
});

test("advance: mid-repair reclassification as semantic stops the loop", () => {
	let s = initialRepairState();
	s = advance(s, { type: "tool_failed", classification: { class: "syntax-repairable" } });
	s = advance(s, { type: "repair_attempt_finished", accepted: false, reclassification: { class: "semantic" } });
	assert.equal(s.phase, "rejected");
	assert.equal(s.reason, "reclassified-semantic");
	assert.equal(s.repairCallsThisTurn, 1);
});

test("advance: per-turn cap refuses further repair calls in the same turn", () => {
	let s = initialRepairState();
	s = advance(s, { type: "tool_failed", classification: { class: "syntax-repairable" } });
	s = advance(s, { type: "repair_attempt_finished", accepted: false });
	s = advance(s, { type: "repair_attempt_finished", accepted: false });
	assert.equal(s.phase, "exhausted");
	assert.equal(s.reason, "max-attempts");
	assert.equal(s.repairCallsThisTurn, 2); // both attempts consumed the per-turn budget
	const t = advance(s, { type: "tool_failed", callId: "call-2", classification: { class: "syntax-repairable" } });
	assert.equal(t.phase, "exhausted");
	assert.equal(t.reason, "per-turn-cap");
	assert.equal(t.attemptsThisCall, 0); // the new call never got to spend an attempt
	// After the user speaks, the turn budget returns.
	const u = advance(t, { type: "turn_reset" });
	const v = advance(u, { type: "tool_failed", classification: { class: "syntax-repairable" } });
	assert.equal(v.phase, "repairing");
	assert.equal(v.repairCallsThisTurn, 1);
});

test("advance: semantic and transient failures never reach the model", () => {
	let s = initialRepairState();
	s = advance(s, { type: "tool_failed", classification: { class: "semantic" } });
	assert.equal(s.phase, "rejected");
	assert.equal(s.reason, "non-syntax");
	assert.equal(s.repairCallsThisTurn, 0);

	let t = initialRepairState();
	t = advance(t, { type: "tool_failed", classification: { class: "transient" } });
	assert.equal(t.phase, "transient-waiting");
	assert.equal(t.backoffMs, BACKOFF_MS_TRANSIENT[0]);
	assert.equal(t.repairCallsThisTurn, 0);
	t = advance(t, { type: "transient_retry_finished", recovered: false });
	assert.equal(t.phase, "transient-waiting");
	assert.equal(t.backoffMs, BACKOFF_MS_TRANSIENT[1]);
	t = advance(t, { type: "transient_retry_finished", recovered: false });
	assert.equal(t.phase, "exhausted");
	assert.equal(t.reason, "transient-backoff-exhausted");
	assert.equal(t.repairCallsThisTurn, 0); // zero LLM involvement throughout

	let r = initialRepairState();
	r = advance(r, { type: "tool_failed", classification: { class: "transient" } });
	r = advance(r, { type: "transient_retry_finished", recovered: true });
	assert.equal(r.phase, "accepted");
});

test("advance: repair calls never recurse", () => {
	let s = initialRepairState();
	s = advance(s, { type: "tool_failed", classification: { class: "syntax-repairable" } });
	s = advance(s, { type: "enter_repair_context" });
	s = advance(s, { type: "tool_failed", classification: { class: "syntax-repairable" } });
	assert.equal(s.phase, "rejected");
	assert.equal(s.reason, "no-recursion");
	assert.equal(s.repairCallsThisTurn, 1); // the in-flight attempt is the only one
});

test("advance: wrapfix and delegate counters are tracked but never gate repair", () => {
	let s = initialRepairState();
	s = advance(s, { type: "wrapfix_converted" });
	s = advance(s, { type: "wrapfix_converted" });
	s = advance(s, { type: "delegate_called" });
	assert.equal(s.wrapfixThisTurn, 2);
	assert.equal(s.delegateThisTurn, 1);
	s = advance(s, { type: "tool_failed", classification: { class: "syntax-repairable" } });
	assert.equal(s.phase, "repairing"); // full wrapfix budget spent, repair still starts
});

test("advance: counters reset on user input", () => {
	let s = initialRepairState();
	s = advance(s, { type: "tool_failed", classification: { class: "syntax-repairable" } });
	s = advance(s, { type: "repair_attempt_finished", accepted: false });
	s = advance(s, { type: "turn_reset" });
	assert.deepEqual(s, initialRepairState());
	const t = advance(s, { type: "tool_failed", classification: { class: "syntax-repairable" } });
	assert.equal(t.phase, "repairing");
	assert.equal(t.repairCallsThisTurn, 1);
});

test("policy constants match the spec'd RetryPolicy", () => {
	assert.equal(MAX_REPAIR_ATTEMPTS_PER_CALL, 2);
	assert.equal(MAX_REPAIR_CALLS_PER_TURN, 2);
	assert.deepEqual(BACKOFF_MS_TRANSIENT, [500, 2000]);
});
