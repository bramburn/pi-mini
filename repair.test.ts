// Unit tests for repair.ts — the tool-call syntax-failure repair loop wired
// onto pi's tool_result event. All model interaction goes through an
// injectable fake fetch: no live Ollama is required.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildReissueNotice,
	checkTurnBudget,
	currentTurn,
	fixerModelId,
	installRepair,
	logRepair,
	repairLogPath,
	repairToolResult,
	resetTurnCounters,
	runFixer,
	TOOL_CONTRACTS,
	type RepairLogRecord,
	type ToolResultLike,
} from "./repair.ts";
import { defaultConfig, TINY_PROVIDER, type PiMiniConfig } from "./settings.ts";

function makeCfg(overrides: Partial<PiMiniConfig> = {}): PiMiniConfig {
	return { ...defaultConfig(), ...overrides };
}

/** Fake fetch returning a canned Ollama /api/chat non-streaming reply. */
function fakeFetch(replyText: string, calls: { url: string; init: RequestInit }[], status = 200) {
	return (async (url: unknown, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify({ message: { role: "assistant", content: replyText }, done: true }), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

function failedEditEvent(input: Record<string, unknown>, errorText: string): ToolResultLike {
	return {
		toolName: "edit",
		toolCallId: "call-1",
		input,
		content: [{ type: "text", text: errorText }],
		isError: true,
	};
}

const SYNTAX_ERROR = "must have required property 'oldText'";
const REPAIED_EDIT_ARGS = '{"path":"a.txt","oldText":"x","newText":"y"}';

let tmpLog: string;
let savedLogEnv: string | undefined;

beforeEach(() => {
	resetTurnCounters();
	tmpLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-mini-repair-")), "repairs.jsonl");
	savedLogEnv = process.env.PI_MINI_REPAIR_LOG;
	process.env.PI_MINI_REPAIR_LOG = tmpLog;
});

afterEach(() => {
	if (savedLogEnv === undefined) delete process.env.PI_MINI_REPAIR_LOG;
	else process.env.PI_MINI_REPAIR_LOG = savedLogEnv;
});

function readLog(): RepairLogRecord[] {
	return fs
		.readFileSync(tmpLog, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as RepairLogRecord);
}

describe("repairToolResult: pass-through (zero LLM)", () => {
	test("semantic failure passes through untouched with zero fetch calls", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const event = {
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "cat missing.txt" },
			content: [{ type: "text", text: "ENOENT: no such file or directory, open 'missing.txt'" }],
			isError: true,
		};
		const result = await repairToolResult(event, { cfg: makeCfg(), fetchImpl: fakeFetch(REPAIED_EDIT_ARGS, calls) });
		assert.equal(result, undefined);
		assert.equal(calls.length, 0);
	});

	test("transient failure passes through untouched with zero fetch calls", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const event = {
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "npm test" },
			content: [{ type: "text", text: "connect ETIMEDOUT 127.0.0.1:11434" }],
			isError: true,
		};
		const result = await repairToolResult(event, { cfg: makeCfg(), fetchImpl: fakeFetch(REPAIED_EDIT_ARGS, calls) });
		assert.equal(result, undefined);
		assert.equal(calls.length, 0);
	});

	test("non-error events pass through untouched", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const event = { ...failedEditEvent({ path: "a.txt" }, SYNTAX_ERROR), isError: false };
		const result = await repairToolResult(event, { cfg: makeCfg(), fetchImpl: fakeFetch(REPAIED_EDIT_ARGS, calls) });
		assert.equal(result, undefined);
		assert.equal(calls.length, 0);
	});
});

describe("repairToolResult: successful repair", () => {
	test("syntax failure repaired on attempt 1 returns the REISSUE notice override", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const cfg = makeCfg();
		const event = failedEditEvent({ path: "a.txt" }, SYNTAX_ERROR);
		const result = await repairToolResult(event, { cfg, fetchImpl: fakeFetch(REPAIED_EDIT_ARGS, calls) });
		assert.ok(result, "expected a content override");
		assert.equal(result.isError, true, "isError stays true so the model must act on the notice");
		assert.equal(calls.length, 1, "exactly one fixer call");
		assert.match(calls[0].url, /\/api\/chat$/);
		const body = JSON.parse(String(calls[0].init.body));
		assert.equal(body.model, "granite4.2:8b");
		assert.equal(body.think, false, "think:false top-level (native api shape)");
		assert.equal(body.stream, false);
		assert.equal(body.options.num_ctx, 4096);
		assert.equal(body.options.num_predict, 300);
		assert.deepEqual(
			body.messages.map((m: { role: string }) => m.role),
			["system", "user"],
		);
		const text = result.content[0].text;
		assert.ok(text.includes("TOOL_CALL_SYNTAX_REPAIRED"));
		assert.ok(text.includes("re-issue this call verbatim with these corrected arguments:"));
		assert.ok(text.includes(REPAIED_EDIT_ARGS), "corrected JSON embedded verbatim");
		assert.ok(text.includes("do not modify the arguments."));
		assert.ok(text.length < 300, `notice is compact (${text.length} chars)`);
		// Evidence log: one record, repaired, one attempt.
		const log = readLog();
		assert.equal(log.length, 1);
		assert.equal(log[0].finalStatus, "repaired");
		assert.equal(log[0].attempts.length, 1);
		assert.equal(log[0].toolName, "edit");
		assert.equal(log[0].originalError, SYNTAX_ERROR);
		assert.equal(log[0].attempts[0].response.extraction.ok, true);
		assert.equal(log[0].attempts[0].response.validation.ok, true);
	});
});

describe("repairToolResult: exhaustion", () => {
	test("exhausts after cfg.repairMaxAttemptsPerCall with original + last repair error", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const cfg = makeCfg({ repairMaxAttemptsPerCall: 2 });
		const event = failedEditEvent({ path: "a.txt" }, SYNTAX_ERROR);
		const result = await repairToolResult(event, { cfg, fetchImpl: fakeFetch("not json at all", calls) });
		assert.ok(result);
		assert.equal(result.isError, true);
		assert.equal(calls.length, 2, "both attempts consumed");
		const text = result.content[0].text;
		assert.ok(text.includes("TOOL_CALL_REPAIR_EXHAUSTED"));
		assert.ok(text.includes(SYNTAX_ERROR), "original error present");
		assert.ok(text.includes("extraction failed"), "last repair error present");
		const log = readLog();
		assert.equal(log.length, 1);
		assert.equal(log[0].finalStatus, "exhausted");
		assert.equal(log[0].attempts.length, 2);
		assert.ok(log[0].finalError && log[0].finalError.length > 0);
	});

	test("replies failing contract validation also exhaust", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const cfg = makeCfg({ repairMaxAttemptsPerCall: 2 });
		// Valid JSON but unknown field -> validateAgainstContract rejects.
		const bad = '{"path":"a.txt","oldText":"x","newText":"y","extra":1}';
		const result = await repairToolResult(failedEditEvent({ path: "a.txt" }, SYNTAX_ERROR), {
			cfg,
			fetchImpl: fakeFetch(bad, calls),
		});
		assert.ok(result);
		assert.ok(result.content[0].text.includes("TOOL_CALL_REPAIR_EXHAUSTED"));
		assert.ok(result.content[0].text.includes("validation failed: unknown-field:extra"));
		assert.equal(calls.length, 2);
	});
});

describe("per-turn budget", () => {
	test("blocks a 3rd repair when cfg.repairMaxPerTurn=2 and passes through untouched", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const cfg = makeCfg({ repairMaxPerTurn: 2 });
		const fetchImpl = fakeFetch(REPAIED_EDIT_ARGS, calls);
		const event = () => failedEditEvent({ path: "a.txt" }, SYNTAX_ERROR);
		const first = await repairToolResult(event(), { cfg, fetchImpl });
		const second = await repairToolResult(event(), { cfg, fetchImpl });
		assert.ok(first && first.content[0].text.includes("TOOL_CALL_SYNTAX_REPAIRED"));
		assert.ok(second && second.content[0].text.includes("TOOL_CALL_SYNTAX_REPAIRED"));
		assert.equal(calls.length, 2);
		assert.equal(checkTurnBudget(cfg), false, "turn budget spent");
		// Third failure in the same turn: not started, passes through untouched.
		const third = await repairToolResult(event(), { cfg, fetchImpl });
		assert.equal(third, undefined);
		assert.equal(calls.length, 2, "no third fixer call");
		// After the user speaks the budget returns.
		resetTurnCounters();
		assert.equal(checkTurnBudget(cfg), true);
		const fourth = await repairToolResult(event(), { cfg, fetchImpl });
		assert.ok(fourth && fourth.content[0].text.includes("TOOL_CALL_SYNTAX_REPAIRED"));
		assert.equal(calls.length, 3);
	});
});

describe("evidence log", () => {
	test("logRepair appends JSONL to the PI_MINI_REPAIR_LOG path", () => {
		assert.equal(repairLogPath(), tmpLog);
		logRepair({
			ts: "2026-10-07T11:15:00.000Z",
			turn: currentTurn(),
			toolName: "bash",
			classification: { class: "semantic", matchedPattern: "semantic:exit-code", evidence: "exit code 1" },
			attempts: [],
			finalStatus: "rejected-non-syntax",
			originalError: "Command failed with exit code 1",
		});
		logRepair({
			ts: "2026-10-07T11:16:00.000Z",
			turn: currentTurn(),
			toolName: "edit",
			classification: { class: "syntax-repairable", matchedPattern: "contract:missing-required", evidence: "oldText" },
			attempts: [],
			finalStatus: "exhausted",
			originalError: SYNTAX_ERROR,
			finalError: "extraction failed: empty-reply",
		});
		const log = readLog();
		assert.equal(log.length, 2);
		assert.equal(log[0].finalStatus, "rejected-non-syntax");
		assert.equal(log[1].finalStatus, "exhausted");
		assert.equal(log[1].finalError, "extraction failed: empty-reply");
	});
});

describe("runFixer request shape", () => {
	test("strips the TINY_PROVIDER prefix; leaves other providers' ids alone", () => {
		assert.equal(fixerModelId(makeCfg()), "granite4.2:8b");
		assert.equal(
			fixerModelId(makeCfg({ tiny: { provider: TINY_PROVIDER, modelId: "ollama-mini/granite4.2:8b" } })),
			"granite4.2:8b",
		);
		assert.equal(fixerModelId(makeCfg({ tiny: { provider: "ollama", modelId: "qwen3:4b" } })), "qwen3:4b");
	});

	test("surfaces HTTP errors as thrown errors (attempt records fixer-request-failed)", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const cfg = makeCfg();
		const event = failedEditEvent({ path: "a.txt" }, SYNTAX_ERROR);
		const result = await repairToolResult(event, {
			cfg,
			fetchImpl: fakeFetch("", calls, 500),
		});
		assert.ok(result);
		assert.equal(calls.length, 1, "transport failure does not retry immediately");
		assert.ok(result.content[0].text.includes("TOOL_CALL_REPAIR_EXHAUSTED"));
		const log = readLog();
		assert.equal(log[0].attempts[0].response.extraction.error, "fixer-request-failed");
	});
});

describe("installRepair wiring", () => {
	function fakePi() {
		const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
		return {
			handlers,
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			async dispatch(event: { type: string } & Record<string, unknown>) {
				const list = handlers.get(event.type) ?? [];
				const results = [];
				for (const handler of list) results.push(await handler(event, {}));
				return results;
			},
		};
	}

	test("tool_result handler returns the override; input handler resets counters", async () => {
		const pi = fakePi();
		const calls: { url: string; init: RequestInit }[] = [];
		let enabled = true;
		const cfg = makeCfg({ repairMaxPerTurn: 1 });
		installRepair(pi as never, {} as never, {
			isEnabled: () => enabled,
			getConfig: () => cfg,
			fetchImpl: fakeFetch(REPAIED_EDIT_ARGS, calls),
		});
		assert.equal(pi.handlers.get("tool_result")?.length, 1);
		assert.equal(pi.handlers.get("input")?.length, 1);

		const event = failedEditEvent({ path: "a.txt" }, SYNTAX_ERROR);
		const [override] = await pi.dispatch({ type: "tool_result", ...event });
		assert.ok(override && override.content[0].text.includes("TOOL_CALL_SYNTAX_REPAIRED"));
		assert.equal(override.isError, true);
		assert.equal(calls.length, 1, "exactly one fixer call through the wiring");
		assert.equal(checkTurnBudget(cfg), false, "the single per-turn repair was spent");

		// Disabled mid-turn: further failed results pass through untouched.
		enabled = false;
		const [passThrough] = await pi.dispatch({ type: "tool_result", ...event });
		assert.equal(passThrough, undefined);
		assert.equal(calls.length, 1);

		// Interactive input resets the budget; extension-sourced input does not.
		const before = currentTurn();
		await pi.dispatch({ type: "input", source: "extension", text: "background steer" });
		assert.equal(checkTurnBudget(cfg), false, "extension input does not reset");
		assert.equal(currentTurn(), before);
		await pi.dispatch({ type: "input", source: "rpc", text: "continue" });
		assert.equal(checkTurnBudget(cfg), true, "rpc input resets the per-turn budget");
		assert.equal(currentTurn(), before + 1);
	});
});
