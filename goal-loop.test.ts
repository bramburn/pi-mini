// Unit tests for the goal-loop module (goal-loop.ts): GoalStore ledger I/O,
// goal API helpers, completion-signal parsing, the audit runner with a fake
// fetch, and installGoalLoop wiring with a fake pi.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	MAX_NUDGES,
	COMPLETION_SIGNAL,
	GoalStore,
	startGoal,
	amendGoal,
	cancelGoal,
	parseGoalStatus,
	runAudit,
	buildAuditMessages,
	foldGoalEvents,
	installGoalLoop,
} from "./goal-loop.ts";
import type { GoalLoopCtx, GoalLoopPi } from "./goal-loop.ts";
import type { PiMiniConfig } from "./settings.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpGoalsDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-mini-goals-"));
}

function ledgerLines(dir: string): Array<Record<string, unknown>> {
	const raw = fs.readFileSync(path.join(dir, "goal_events.jsonl"), "utf8");
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

function testConfig(overrides: Partial<PiMiniConfig> = {}): PiMiniConfig {
	return {
		tiny: { provider: "ollama-mini", modelId: "test-tiny" },
		think: false,
		toolsMode: "curated",
		delegateBudget: 8,
		enabled: true,
		goalAudit: "self",
		repairMaxAttemptsPerCall: 2,
		repairMaxPerTurn: 2,
		...overrides,
	} as PiMiniConfig;
}

/** Fake fetch that records requests and returns a canned auditor reply. */
function fakeFetch(reply: string) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const impl = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return {
			ok: true,
			status: 200,
			json: async () => ({ message: { role: "assistant", content: reply } }),
		} as Response;
	}) as typeof fetch;
	return { calls, impl };
}

function textMessage(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function toolCallMessage(text: string, name = "bash") {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: "c1", name, arguments: {} },
		],
	};
}

/** Fake pi with handler registry; emit() awaits returned promises. */
function fakePi() {
	const handlers = new Map<string, Array<(event: unknown, ctx: GoalLoopCtx) => unknown>>();
	return {
		on(event: string, handler: (event: unknown, ctx: GoalLoopCtx) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		async emit(event: string, evt: unknown, ctx: GoalLoopCtx) {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(evt, ctx));
			return results;
		},
		count(event: string) {
			return handlers.get(event)?.length ?? 0;
		},
	};
}

function fakeCtx() {
	const sent: string[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx: GoalLoopCtx & {
		sent: string[];
		notifications: Array<{ message: string; type?: string }>;
		percent: number | undefined;
		compactions: number;
	} = {
		sent,
		notifications,
		percent: 0,
		compactions: 0,
		sendUserMessage(content: string) {
			sent.push(content);
		},
		getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent: ctx.percent ?? 0 }),
		compact: () => {
			ctx.compactions += 1;
		},
		ui: {
			notify(message: string, type?: "info" | "warning" | "error") {
				notifications.push({ message, type });
			},
		},
	};
	return ctx;
}

/** A store pre-loaded with an active goal with one blocking + one open task. */
function storeWithActiveGoal(dir: string): GoalStore {
	const store = new GoalStore(dir);
	const goal = startGoal(store, "add /mini settings command");
	store.appendEvent({
		type: "task_list_set",
		goalId: goal.id,
		taskCount: 2,
		tasks: [
			{
				id: "settings-command",
				title: "Add /mini settings subcommand dispatch in index.ts",
				blockCompletion: true,
				verificationContract: "settings.test.ts covers the dispatch; node --test green",
				status: "pending",
			},
			{
				id: "docs",
				title: "Update README with /mini settings usage",
				blockCompletion: false,
				verificationContract: "README shows the new subcommand",
				status: "pending",
			},
		],
	});
	return store;
}

/** Complete the blocking task so the goal is in "completing" state. */
function completeBlockingTask(store: GoalStore) {
	const goal = store.current();
	assert.ok(goal);
	store.appendEvent({ type: "task_complete", goalId: goal.id, taskId: "settings-command", evidence: "settings.test.ts 9/9 pass" });
}

// ---------------------------------------------------------------------------
// GoalStore + goal API
// ---------------------------------------------------------------------------

test("store: startGoal appends goal_created with revision 1 and returns an active goal", () => {
	const dir = tmpGoalsDir();
	const store = new GoalStore(dir);
	const goal = startGoal(store, "add /mini settings command");
	assert.equal(goal.status, "active");
	assert.equal(goal.revision, 1);
	assert.equal(goal.objective, "add /mini settings command");
	assert.match(goal.id, /^goal_[a-z0-9]+-[a-z0-9]+$/);
	const lines = ledgerLines(dir);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].type, "goal_created");
	assert.equal(lines[0].objective, "add /mini settings command");
	assert.equal(lines[0].revision, 1);
	assert.ok(typeof lines[0].at === "string");
});

test("store: amendGoal appends goal_amended with reason and bumps the revision", () => {
	const dir = tmpGoalsDir();
	const store = new GoalStore(dir);
	startGoal(store, "do the thing");
	const amended = amendGoal(store, "also expose the delegate budget");
	assert.ok(amended);
	assert.equal(amended.revision, 2);
	assert.equal(amended.amendedAt !== null, true);
	const lines = ledgerLines(dir);
	assert.equal(lines[1].type, "goal_amended");
	assert.equal(lines[1].reason, "also expose the delegate budget");
	assert.equal(lines[1].revision, 2);
});

test("store: fold resumes state across a reload from the same dir", () => {
	const dir = tmpGoalsDir();
	const store = new GoalStore(dir);
	startGoal(store, "do the thing");
	amendGoal(store, "steering");
	amendGoal(store, "more steering");
	// Fresh instance over the same directory: fold replays the ledger.
	const reloaded = new GoalStore(dir);
	const goal = reloaded.current();
	assert.ok(goal);
	assert.equal(goal.revision, 3);
	assert.equal(goal.objective, "do the thing");
});

test("store: load ignores malformed ledger lines", () => {
	const dir = tmpGoalsDir();
	const store = new GoalStore(dir);
	startGoal(store, "survive bad lines");
	fs.appendFileSync(path.join(dir, "goal_events.jsonl"), "not json {{{\n");
	const goal = store.load();
	assert.ok(goal);
	assert.equal(goal.status, "active");
});

test("store: cancelGoal appends goal_archived with status cancelled; current() becomes undefined", () => {
	const dir = tmpGoalsDir();
	const store = new GoalStore(dir);
	startGoal(store, "abandonable goal");
	const cancelled = cancelGoal(store);
	assert.ok(cancelled);
	assert.equal(cancelled.status, "archived");
	assert.equal(cancelled.stopReason, "cancelled");
	const lines = ledgerLines(dir);
	assert.equal(lines.at(-1).type, "goal_archived");
	assert.equal(lines.at(-1).stopReason, "cancelled");
	assert.equal(store.current(), undefined);
});

test("store: current() is undefined on an empty ledger and amend/cancel no-op", () => {
	const dir = tmpGoalsDir();
	const store = new GoalStore(dir);
	assert.equal(store.current(), undefined);
	assert.equal(amendGoal(store, "nothing"), undefined);
	assert.equal(cancelGoal(store), undefined);
	assert.equal(fs.existsSync(path.join(dir, "goal_events.jsonl")), false);
});

// ---------------------------------------------------------------------------
// parseGoalStatus
// ---------------------------------------------------------------------------

const SIGNAL_CASES: Array<[string, string | undefined, string | undefined]> = [
	["GOAL_STATUS: complete", "complete", undefined],
	["  GOAL_STATUS: complete   ", "complete", undefined],
	["GOAL_STATUS: complete.", "complete", undefined],
	["done!\nGOAL_STATUS: complete\n", "complete", undefined],
	["```\nGOAL_STATUS: complete\n```", "complete", undefined],
	["`GOAL_STATUS: complete`", "complete", undefined],
	["GOAL_STATUS: blocked — no model available", "blocked", "no model available"],
	["GOAL_STATUS: blocked — waiting on user input.  ", "blocked", "waiting on user input"],
	["GOAL_STATUS: blocked - tests failing", "blocked", "tests failing"],
	["x\nGOAL_STATUS: blocked — out of budget\ny", "blocked", "out of budget"],
	["GOAL_STATUS: blocked —", "blocked", ""],
	["GOAL_STATUS: complete now please", undefined, undefined],
	["goal_status: complete", undefined, undefined],
	["no signal here", undefined, undefined],
	["GOAL_STATUS: complet", undefined, undefined],
];

for (const [input, expected, reason] of SIGNAL_CASES) {
	test(`parseGoalStatus: ${JSON.stringify(input)} → ${expected ?? "undefined"}`, () => {
		const parsed = parseGoalStatus(input);
		assert.equal(parsed.status, expected);
		if (reason !== undefined) assert.equal(parsed.reason, reason);
	});
}

test("parseGoalStatus: null/undefined input yields no signal", () => {
	assert.deepEqual(parseGoalStatus(undefined), { status: undefined });
	assert.deepEqual(parseGoalStatus(null), { status: undefined });
	assert.deepEqual(parseGoalStatus(""), { status: undefined });
});

// ---------------------------------------------------------------------------
// runAudit
// ---------------------------------------------------------------------------

test("runAudit (self): posts the native chat shape and parses an approved verdict", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	completeBlockingTask(store);
	const goal = store.current();
	assert.ok(goal);
	const { calls, impl } = fakeFetch("AUDIT_VERDICT: approved\nAll evidence verified independently. Report ends here.");
	const outcome = await runAudit(testConfig(), goal, impl);
	assert.equal(outcome.kind, "audit");
	if (outcome.kind !== "audit") return;
	assert.equal(outcome.event.verdict, "approved");
	assert.equal(outcome.event.goalId, goal.id);
	assert.equal(outcome.event.revision, goal.revision);
	assert.equal(outcome.event.auditor, "mini");
	assert.match(outcome.event.report, /All evidence verified/);
	assert.equal(outcome.event.continuation, undefined);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "http://localhost:11434/api/chat");
	const body = JSON.parse(String(calls[0].init.body));
	assert.equal(body.model, "test-tiny");
	assert.equal(body.stream, false);
	assert.equal(body.think, false);
	assert.equal(body.options.num_ctx, 8192);
	assert.equal(body.options.num_predict, 512);
	assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["system", "user"]);
	assert.match(body.messages[1].content, /add \/mini settings command/);
	assert.match(body.messages[1].content, /settings\.test\.ts 9\/9 pass/);
});

test("runAudit (self): disapproved verdict keeps the report and extracts continuation guidance", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	completeBlockingTask(store);
	const goal = store.current();
	assert.ok(goal);
	const reply =
		"AUDIT_VERDICT: disapproved\nThe claimed evidence is not reproducible: settings.test.ts fails on main.\nCONTINUATION: fix the dispatch regression and re-run node --test";
	const { impl } = fakeFetch(reply);
	const outcome = await runAudit(testConfig(), goal, impl);
	assert.equal(outcome.kind, "audit");
	if (outcome.kind !== "audit") return;
	assert.equal(outcome.event.verdict, "disapproved");
	assert.match(outcome.event.report, /not reproducible/);
	assert.equal(outcome.event.continuation, "fix the dispatch regression and re-run node --test");
});

test("runAudit (self): disapproved without a CONTINUATION line falls back to the report", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	completeBlockingTask(store);
	const goal = store.current();
	assert.ok(goal);
	const { impl } = fakeFetch("AUDIT_VERDICT: disapproved\nEvidence missing for the blocking task.");
	const outcome = await runAudit(testConfig(), goal, impl);
	assert.equal(outcome.kind, "audit");
	if (outcome.kind !== "audit") return;
	assert.equal(outcome.event.continuation, "Evidence missing for the blocking task.");
});

test("runAudit (worker): never calls the model and routes via {kind:\"worker\"}", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	const goal = store.current();
	assert.ok(goal);
	const { calls, impl } = fakeFetch("AUDIT_VERDICT: approved");
	const outcome = await runAudit(testConfig({ goalAudit: "worker" }), goal, impl);
	assert.deepEqual(outcome, { kind: "worker" });
	assert.equal(calls.length, 0);
});

test("runAudit (self): throws when the reply has no verdict line", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	const goal = store.current();
	assert.ok(goal);
	const { impl } = fakeFetch("I could not decide.");
	await assert.rejects(() => runAudit(testConfig(), goal, impl), /AUDIT_VERDICT/);
});

test("buildAuditMessages: prompt carries objective, contracts, and evidence", () => {
	const goal = foldGoalEvents([
		{ type: "goal_created", goalId: "g-1", objective: "ship it", revision: 1, at: "t0" },
		{ type: "task_list_set", goalId: "g-1", taskCount: 1, tasks: [{ id: "t1", title: "Task one", blockCompletion: true, verificationContract: "tests green", status: "pending" }], at: "t1" },
		{ type: "task_complete", goalId: "g-1", taskId: "t1", evidence: "9/9 pass", at: "t2" },
	]);
	assert.ok(goal);
	const messages = buildAuditMessages(goal);
	assert.equal(messages.length, 2);
	assert.match(messages[0].content, /AUDIT_VERDICT: approved/);
	assert.match(messages[0].content, /at most 5 sentences/);
	const user = messages[1].content;
	assert.match(user, /ship it/);
	assert.match(user, /tests green/);
	assert.match(user, /9\/9 pass/);
	assert.match(user, new RegExp(COMPLETION_SIGNAL.replace(":", ":")));
});

// ---------------------------------------------------------------------------
// installGoalLoop
// ---------------------------------------------------------------------------

test("install: before_agent_start composes base prompt + goal block when enabled and goal active", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	const pi = fakePi();
	const ctx = fakeCtx();
	installGoalLoop(pi as unknown as GoalLoopPi, ctx, { isEnabled: () => true, getConfig: () => testConfig(), store });
	const [result] = (await pi.emit("before_agent_start", { prompt: "hi", systemPrompt: "BASE PROMPT" }, ctx)) as Array<
		{ systemPrompt: string } | undefined
	>;
	assert.ok(result);
	assert.ok(result.systemPrompt.startsWith("BASE PROMPT\n\n"));
	assert.match(result.systemPrompt, /## Active Goal/);
	assert.match(result.systemPrompt, /add \/mini settings command/);
	assert.match(result.systemPrompt, new RegExp(COMPLETION_SIGNAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("install: before_agent_start is a no-op when disabled or no goal", async () => {
	const dir = tmpGoalsDir();
	const store = new GoalStore(dir);
	const pi = fakePi();
	const ctx = fakeCtx();
	installGoalLoop(pi as unknown as GoalLoopPi, ctx, { isEnabled: () => false, getConfig: () => testConfig(), store });
	const [off] = (await pi.emit("before_agent_start", { prompt: "hi", systemPrompt: "BASE" }, ctx)) as unknown[];
	assert.equal(off, undefined);
	// Enabled but no goal:
	const pi2 = fakePi();
	installGoalLoop(pi2 as unknown as GoalLoopPi, ctx, { isEnabled: () => true, getConfig: () => testConfig(), store });
	const [none] = (await pi2.emit("before_agent_start", { prompt: "hi", systemPrompt: "BASE" }, ctx)) as unknown[];
	assert.equal(none, undefined);
});

test("install: message_end complete → completion_requested + audit_result + goal_archived (approved)", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	completeBlockingTask(store);
	const pi = fakePi();
	const ctx = fakeCtx();
	const { impl } = fakeFetch("AUDIT_VERDICT: approved\nVerified independently.");
	installGoalLoop(pi as unknown as GoalLoopPi, ctx, {
		isEnabled: () => true,
		getConfig: () => testConfig(),
		store,
		fetchImpl: impl,
	});
	await pi.emit("message_end", { message: textMessage("All done.\nGOAL_STATUS: complete") }, ctx);
	const types = ledgerLines(dir).map((l) => l.type);
	assert.deepEqual(types.slice(-3), ["completion_requested", "audit_result", "goal_archived"]);
	const audit = ledgerLines(dir).at(-2);
	assert.equal(audit.verdict, "approved");
	assert.equal(store.current(), undefined);
	assert.ok(ctx.notifications.some((n) => /goal complete/.test(n.message)));
});

test("install: message_end complete → disapproved keeps the goal active with continuation", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	completeBlockingTask(store);
	const pi = fakePi();
	const ctx = fakeCtx();
	const { impl } = fakeFetch(
		"AUDIT_VERDICT: disapproved\nEvidence not reproducible.\nCONTINUATION: fix the dispatch regression",
	);
	installGoalLoop(pi as unknown as GoalLoopPi, ctx, {
		isEnabled: () => true,
		getConfig: () => testConfig(),
		store,
		fetchImpl: impl,
	});
	await pi.emit("message_end", { message: textMessage("GOAL_STATUS: complete") }, ctx);
	const types = ledgerLines(dir).map((l) => l.type);
	assert.deepEqual(types.slice(-2), ["completion_requested", "audit_result"]);
	assert.equal(types.includes("goal_archived"), false);
	const goal = store.current();
	assert.ok(goal);
	assert.equal(goal.status, "active");
	assert.equal(goal.lastAudit?.verdict, "disapproved");
	assert.equal(goal.lastAudit?.continuation, "fix the dispatch regression");
	assert.ok(ctx.notifications.some((n) => /disapproved/.test(n.message)));
});

test("install: message_end blocked notifies the reason and keeps the goal active", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	const pi = fakePi();
	const ctx = fakeCtx();
	const { calls, impl } = fakeFetch("AUDIT_VERDICT: approved");
	installGoalLoop(pi as unknown as GoalLoopPi, ctx, {
		isEnabled: () => true,
		getConfig: () => testConfig(),
		store,
		fetchImpl: impl,
	});
	await pi.emit("message_end", { message: textMessage("GOAL_STATUS: blocked — model not reachable") }, ctx);
	assert.equal(store.current()?.status, "active");
	assert.ok(ctx.notifications.some((n) => /blocked/.test(n.message) && /model not reachable/.test(n.message)));
	assert.equal(calls.length, 0, "no audit on blocked");
	assert.equal(ledgerLines(dir).length, 2, "no new ledger events on blocked");
});

test("install: message_end complete is ignored while a blocking task lacks evidence", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir); // blocking task still pending
	const pi = fakePi();
	const ctx = fakeCtx();
	const { calls, impl } = fakeFetch("AUDIT_VERDICT: approved");
	installGoalLoop(pi as unknown as GoalLoopPi, ctx, {
		isEnabled: () => true,
		getConfig: () => testConfig(),
		store,
		fetchImpl: impl,
	});
	await pi.emit("message_end", { message: textMessage("GOAL_STATUS: complete") }, ctx);
	assert.equal(ledgerLines(dir).length, 2);
	assert.equal(calls.length, 0);
});

test("install: agent_settled continue sends exactly one nudge naming the open tasks", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	const pi = fakePi();
	const ctx = fakeCtx();
	installGoalLoop(pi as unknown as GoalLoopPi, ctx, { isEnabled: () => true, getConfig: () => testConfig(), store });
	// The settled assistant message showed life (a tool call) → no nudge counted.
	await pi.emit("message_end", { message: toolCallMessage("working on it") }, ctx);
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	assert.equal(ctx.sent.length, 1);
	assert.match(ctx.sent[0], /Continue working toward the goal/);
	assert.match(ctx.sent[0], /settings-command \(blocking\)/);
	assert.match(ctx.sent[0], /docs/);
	assert.ok(ctx.sent[0].includes("GOAL_STATUS: complete"));
});

test("install: agent_settled compact_and_continue compacts then nudges", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	const pi = fakePi();
	const ctx = fakeCtx();
	ctx.percent = 85;
	installGoalLoop(pi as unknown as GoalLoopPi, ctx, { isEnabled: () => true, getConfig: () => testConfig(), store });
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	assert.equal(ctx.compactions, 1);
	assert.equal(ctx.sent.length, 1);
});

test("install: agent_settled request_completion runs the audit gate (approved → archived)", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	completeBlockingTask(store); // all blocking complete → decision is request_completion
	const pi = fakePi();
	const ctx = fakeCtx();
	const { impl } = fakeFetch("AUDIT_VERDICT: approved\nVerified.");
	installGoalLoop(pi as unknown as GoalLoopPi, ctx, {
		isEnabled: () => true,
		getConfig: () => testConfig(),
		store,
		fetchImpl: impl,
	});
	await pi.emit("message_end", { message: toolCallMessage("finishing up") }, ctx);
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	// Give the fire-and-forget gate a tick? No — emit awaited handler promises.
	const types = ledgerLines(dir).map((l) => l.type);
	assert.deepEqual(types.slice(-3), ["completion_requested", "audit_result", "goal_archived"]);
	assert.equal(store.current(), undefined);
	assert.equal(ctx.sent.length, 0, "no nudge when the gate runs");
});

test("install: anti-runaway pauses after MAX_NUDGES quiet settles without signals or tool calls", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	const pi = fakePi();
	const ctx = fakeCtx();
	installGoalLoop(pi as unknown as GoalLoopPi, ctx, { isEnabled: () => true, getConfig: () => testConfig(), store });
	for (let i = 0; i < MAX_NUDGES; i++) {
		// Quiet assistant message: no tool calls, no goal signal.
		await pi.emit("message_end", { message: textMessage(`thinking out loud ${i}`) }, ctx);
	}
	// Each settle would nudge, but the streak hits the cap first.
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	assert.equal(ctx.sent.length, 0, "loop pauses instead of nudging");
	assert.ok(ctx.notifications.some((n) => /paused/.test(n.message)), "user is notified of the pause");
	// Further settles stay paused (no message spam).
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	assert.equal(ctx.sent.length, 0);
	// A steering/tool-call message resets the streak and resumes the loop.
	await pi.emit("message_end", { message: toolCallMessage("resuming") }, ctx);
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	assert.equal(ctx.sent.length, 1, "loop resumes after a signal of life");
});

test("install: goalAudit worker routes through delegateAudit without a fetch", async () => {
	const dir = tmpGoalsDir();
	const store = storeWithActiveGoal(dir);
	completeBlockingTask(store);
	const pi = fakePi();
	const ctx = fakeCtx();
	let delegatedWith: unknown;
	const { calls, impl } = fakeFetch("AUDIT_VERDICT: approved");
	installGoalLoop(pi as unknown as GoalLoopPi, ctx, {
		isEnabled: () => true,
		getConfig: () => testConfig({ goalAudit: "worker" }),
		store,
		fetchImpl: impl,
		delegateAudit: async (goal) => {
			delegatedWith = goal.id;
			return { verdict: "approved", report: "worker audit verified the evidence" };
		},
	});
	await pi.emit("message_end", { message: textMessage("GOAL_STATUS: complete") }, ctx);
	assert.equal(calls.length, 0, "self-audit fetch never happens in worker mode");
	const goal = store.current();
	assert.ok(delegatedWith);
	assert.equal(store.load()?.status, "archived");
	assert.ok(ctx.notifications.some((n) => /goal complete/.test(n.message)));
	void goal;
});
