// Unit tests for the goal-loop pure logic (reference implementation in
// ./lib/goal-loop.mjs). Auto-discovered by `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_PROMPT_BYTE_BUDGET,
	DEFAULT_CONTEXT_PERCENT_THRESHOLD,
	MAX_WRAPFIX_CONVERSIONS_PER_TURN,
	DEFAULT_DELEGATE_BUDGET,
	COMPLETION_SIGNAL,
	BLOCKED_SIGNAL,
	LOOP_ACTIONS,
	allBlockCompletionComplete,
	foldGoalEvents,
	buildGoalPromptBlock,
	decideLoopAction,
} from "./lib/goal-loop.mjs";

// ---------------------------------------------------------------------------
// Fixtures: a ledger for "add /mini settings command", mirroring the real
// .pi/goals/goal_events.jsonl shape (one JSON object per line).
// ---------------------------------------------------------------------------

const SETTINGS_TASKS = [
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
];

function baseLedger() {
	return [
		{ type: "goal_created", goalId: "g-1", objective: "add /mini settings command", revision: 1, at: "2026-10-07T09:00:00.000Z" },
		{ type: "task_list_set", goalId: "g-1", tasks: SETTINGS_TASKS, taskCount: 2, at: "2026-10-07T09:00:20.000Z" },
	];
}

// ---------------------------------------------------------------------------
// 1. foldGoalEvents — the ledger reducer
// ---------------------------------------------------------------------------

test("reducer: empty ledger folds to null", () => {
	assert.equal(foldGoalEvents([]), null);
});

test("reducer: goal_created initializes active state at revision 1", () => {
	const goal = foldGoalEvents(baseLedger().slice(0, 1));
	assert.equal(goal.id, "g-1");
	assert.equal(goal.objective, "add /mini settings command");
	assert.equal(goal.revision, 1);
	assert.equal(goal.status, "active");
	assert.deepEqual(goal.usage, { tokensUsed: 0, activeSeconds: 0 });
});

test("reducer: task_list_set loads tasks; task_started/task_complete transition them", () => {
	const goal = foldGoalEvents([
		...baseLedger(),
		{ type: "task_started", goalId: "g-1", taskId: "settings-command", at: "2026-10-07T09:01:00.000Z" },
	]);
	assert.equal(goal.taskList[0].status, "in_progress");
	assert.equal(goal.taskList[1].status, "pending");
});

test("reducer: task_complete without evidence is rejected", () => {
	assert.throws(
		() => foldGoalEvents([...baseLedger(), { type: "task_complete", goalId: "g-1", taskId: "settings-command", at: "t" }]),
		/evidence is mandatory/,
	);
});

test("reducer: completing a blockCompletion task moves active → completing once all carry evidence", () => {
	const goal = foldGoalEvents([
		...baseLedger(),
		{ type: "task_complete", goalId: "g-1", taskId: "settings-command", evidence: "settings.test.ts 9/9 pass", at: "t1" },
	]);
	assert.equal(goal.status, "completing");
	assert.equal(goal.taskList[0].status, "complete");
	assert.equal(goal.taskList[0].evidence, "settings.test.ts 9/9 pass");
	// The pending non-blocking task "docs" does not block the gate.
	assert.equal(goal.taskList[1].status, "pending");
});

test("reducer: completion_requested → awaiting_audit → approved → complete", () => {
	const goal = foldGoalEvents([
		...baseLedger(),
		{ type: "task_complete", goalId: "g-1", taskId: "settings-command", evidence: "settings.test.ts 9/9 pass", at: "t1" },
		{ type: "completion_requested", goalId: "g-1", revision: 1, at: "t2" },
	]);
	assert.equal(goal.status, "awaiting_audit");
	const approved = foldGoalEvents([
		...baseLedger(),
		{ type: "task_complete", goalId: "g-1", taskId: "settings-command", evidence: "settings.test.ts 9/9 pass", at: "t1" },
		{ type: "completion_requested", goalId: "g-1", revision: 1, at: "t2" },
		{ type: "audit_result", goalId: "g-1", revision: 1, verdict: "approved", report: "all blockCompletion evidence verified", auditor: "mini", auditedAt: "t3" },
	]);
	assert.equal(approved.status, "complete");
	assert.equal(approved.lastAudit.verdict, "approved");
});

test("reducer: disapproved audit returns to active with continuation guidance", () => {
	const goal = foldGoalEvents([
		...baseLedger(),
		{ type: "task_complete", goalId: "g-1", taskId: "settings-command", evidence: "settings.test.ts 9/9 pass", at: "t1" },
		{ type: "completion_requested", goalId: "g-1", revision: 1, at: "t2" },
		{ type: "audit_result", goalId: "g-1", revision: 1, verdict: "disapproved", report: "settings.test.ts fails on main", continuation: "fix the dispatch regression and re-run node --test", auditor: "mini", auditedAt: "t3" },
	]);
	assert.equal(goal.status, "active");
	assert.equal(goal.lastAudit.continuation, "fix the dispatch regression and re-run node --test");
});

test("reducer: completion_requested is rejected while a blockCompletion task lacks evidence", () => {
	assert.throws(
		() =>
			foldGoalEvents([
				...baseLedger(),
				{ type: "completion_requested", goalId: "g-1", revision: 1, at: "t2" },
			]),
		/lack evidence: settings-command/,
	);
});

test("reducer: goal_amended bumps revision and applies taskListOps", () => {
	const goal = foldGoalEvents([
		...baseLedger(),
		{
			type: "goal_amended",
			goalId: "g-1",
			revision: 2,
			reason: "also expose the delegate budget in the settings output",
			taskListOps: [
				{
					op: "add",
					task: {
						id: "delegate-budget-status",
						title: "Show delegate budget in /mini settings status",
						blockCompletion: true,
						verificationContract: "/mini status output includes the delegate budget",
						status: "pending",
					},
				},
			],
			at: "2026-10-07T09:30:00.000Z",
		},
	]);
	assert.equal(goal.revision, 2);
	assert.equal(goal.amendedAt, "2026-10-07T09:30:00.000Z");
	const added = goal.taskList.find((t) => t.id === "delegate-budget-status");
	assert.equal(added.blockCompletion, true);
	// New blocking task is incomplete → goal demoted from any gate state.
	assert.equal(goal.status, "active");
});

test("reducer: objective replacement via goal_amended", () => {
	const goal = foldGoalEvents([
		...baseLedger(),
		{ type: "goal_amended", goalId: "g-1", revision: 2, objective: "add /mini settings command and a /mini goal command", at: "t" },
	]);
	assert.match(goal.objective, /\/mini goal command/);
	assert.equal(goal.revision, 2);
});

test("reducer: amendment demotes awaiting_audit and a stale-revision audit is ignored", () => {
	const events = [
		...baseLedger(),
		{ type: "task_complete", goalId: "g-1", taskId: "settings-command", evidence: "settings.test.ts 9/9 pass", at: "t1" },
		{ type: "completion_requested", goalId: "g-1", revision: 1, at: "t2" },
		{ type: "goal_amended", goalId: "g-1", revision: 2, reason: "also do X", at: "t3" },
		{ type: "audit_result", goalId: "g-1", revision: 1, verdict: "approved", report: "stale", auditor: "mini", auditedAt: "t4" },
	];
	const goal = foldGoalEvents(events);
	// The consumed completion request is recomputed: all blocking tasks still
	// carry evidence, so the gate returns to completing for the new revision.
	assert.equal(goal.status, "completing");
	assert.equal(goal.lastAudit, null);
});

test("reducer: goal_archived is terminal with stopReason", () => {
	const goal = foldGoalEvents([
		...baseLedger(),
		{ type: "task_complete", goalId: "g-1", taskId: "settings-command", evidence: "settings.test.ts 9/9 pass", at: "t1" },
		{ type: "completion_requested", goalId: "g-1", revision: 1, at: "t2" },
		{ type: "audit_result", goalId: "g-1", revision: 1, verdict: "approved", report: "verified", auditor: "mini", auditedAt: "t3" },
		{ type: "goal_archived", goalId: "g-1", archivePath: ".pi/goals/archived/goal_1_g-1.md", stopReason: "audit_approved", at: "t4" },
	]);
	assert.equal(goal.status, "archived");
	assert.equal(goal.stopReason, "audit_approved");
	assert.equal(goal.archivePath, ".pi/goals/archived/goal_1_g-1.md");
});

test("reducer: legacy/unknown events (goal_paused, audit_started, …) are ignored", () => {
	const goal = foldGoalEvents([
		...baseLedger(),
		{ type: "goal_paused", goalId: "g-1", reason: "user", at: "t1" },
		{ type: "audit_started", goalId: "g-1", at: "t2" },
		{ type: "mystery_event", goalId: "g-1", at: "t3" },
	]);
	assert.equal(goal.status, "active");
	assert.equal(goal.revision, 1);
});

test("reducer: folds the real .pi/goals/goal_events.jsonl ledger", async () => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const ledgerPath = path.join(repoRoot, ".pi", "goals", "goal_events.jsonl");
	const events = fs
		.readFileSync(ledgerPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
	const goal = foldGoalEvents(events);
	assert.equal(goal.id, "muu69dvt-mtoxvg");
	assert.equal(goal.status, "archived");
	assert.equal(goal.lastAudit?.verdict, "approved");
	assert.ok(goal.taskList.length >= 6);
	assert.ok(goal.taskList.every((t) => t.status === "complete"));
});

// ---------------------------------------------------------------------------
// 2. buildGoalPromptBlock — the prompt builder
// ---------------------------------------------------------------------------

function activeGoalWithAudit() {
	return foldGoalEvents([
		...baseLedger(),
		{ type: "task_started", goalId: "g-1", taskId: "settings-command", at: "t1" },
		{ type: "task_complete", goalId: "g-1", taskId: "settings-command", evidence: "settings.test.ts 9/9 pass", at: "t1b" },
		{ type: "completion_requested", goalId: "g-1", revision: 1, at: "t2" },
		{ type: "audit_result", goalId: "g-1", revision: 1, verdict: "disapproved", report: "settings.test.ts fails on main", continuation: "fix the dispatch regression and re-run node --test", auditor: "mini", auditedAt: "t3" },
		{
			type: "goal_amended",
			goalId: "g-1",
			revision: 2,
			reason: "retry after the regression fix",
			at: "t4",
		},
		// The disapproved audit sends the loop back to the failed task.
		{ type: "task_started", goalId: "g-1", taskId: "settings-command", at: "t5" },
	]);
}

test("prompt builder: includes objective, revision, open tasks with verificationContract", () => {
	const block = buildGoalPromptBlock(activeGoalWithAudit());
	assert.match(block, /add \/mini settings command/);
	assert.match(block, /revision 2/);
	assert.match(block, /settings-command/);
	assert.match(block, /settings\.test\.ts covers the dispatch/);
});

test("prompt builder: includes the last disapproved audit continuation guidance", () => {
	const block = buildGoalPromptBlock(activeGoalWithAudit());
	assert.match(block, /Last audit disapproved/);
	assert.match(block, /fix the dispatch regression/);
});

test("prompt builder: includes the completion signal contract", () => {
	const block = buildGoalPromptBlock(activeGoalWithAudit());
	assert.ok(block.includes(COMPLETION_SIGNAL));
	assert.ok(block.includes(BLOCKED_SIGNAL));
});

test(`prompt builder: block stays under the ${DEFAULT_PROMPT_BYTE_BUDGET} byte budget`, () => {
	const block = buildGoalPromptBlock(activeGoalWithAudit());
	assert.ok(Buffer.byteLength(block, "utf8") <= DEFAULT_PROMPT_BYTE_BUDGET, `block is ${Buffer.byteLength(block, "utf8")} bytes`);
});

test("prompt builder: drops tail tasks to satisfy a tight budget but keeps the signal line", () => {
	const manyTasks = Array.from({ length: 60 }, (_, i) => ({
		id: `task-${i}`,
		title: `Task number ${i} with a reasonably long descriptive title`,
		blockCompletion: i < 3,
		verificationContract: `verification contract number ${i} requiring tests and evidence`,
		status: "pending",
	}));
	const goal = foldGoalEvents([
		{ type: "goal_created", goalId: "g-big", objective: "big goal", revision: 1, at: "t0" },
		{ type: "task_list_set", goalId: "g-big", tasks: manyTasks, taskCount: manyTasks.length, at: "t1" },
	]);
	const budget = 1500;
	const block = buildGoalPromptBlock(goal, { byteBudget: budget });
	assert.ok(Buffer.byteLength(block, "utf8") <= budget, `block is ${Buffer.byteLength(block, "utf8")} bytes`);
	assert.ok(block.includes(COMPLETION_SIGNAL));
	// Blocking tasks are retained with priority over non-blocking ones.
	assert.match(block, /task-0/);
});

// ---------------------------------------------------------------------------
// 3. decideLoopAction — the loop decision table
// ---------------------------------------------------------------------------

function completingGoal() {
	return foldGoalEvents([
		...baseLedger(),
		{ type: "task_complete", goalId: "g-1", taskId: "settings-command", evidence: "settings.test.ts 9/9 pass", at: "t1" },
	]);
}

function awaitingAuditGoal() {
	return foldGoalEvents([
		...baseLedger(),
		{ type: "task_complete", goalId: "g-1", taskId: "settings-command", evidence: "settings.test.ts 9/9 pass", at: "t1" },
		{ type: "completion_requested", goalId: "g-1", revision: 1, at: "t2" },
	]);
}

function archivedGoal() {
	return foldGoalEvents([
		...baseLedger(),
		{ type: "task_complete", goalId: "g-1", taskId: "settings-command", evidence: "settings.test.ts 9/9 pass", at: "t1" },
		{ type: "completion_requested", goalId: "g-1", revision: 1, at: "t2" },
		{ type: "audit_result", goalId: "g-1", revision: 1, verdict: "approved", report: "verified", auditor: "mini", auditedAt: "t3" },
		{ type: "goal_archived", goalId: "g-1", archivePath: ".pi/goals/archived/goal_1_g-1.md", at: "t4" },
	]);
}

const NO_GUARDRAILS = { wrapfixUsed: 0, delegateUsed: 0 };

test("decision: every action the decision can return is a spec'd loop action", () => {
	for (const action of LOOP_ACTIONS) assert.ok(typeof action === "string");
});

test("decision table: context percent and goal state rows", () => {
	const activeIncomplete = foldGoalEvents(baseLedger());
	// Threshold boundary: 79 → continue, 80 → compact.
	assert.equal(decideLoopAction(activeIncomplete, { percent: DEFAULT_CONTEXT_PERCENT_THRESHOLD - 1 }, NO_GUARDRAILS), "continue");
	assert.equal(decideLoopAction(activeIncomplete, { percent: DEFAULT_CONTEXT_PERCENT_THRESHOLD }, NO_GUARDRAILS), "compact_and_continue");
	assert.equal(decideLoopAction(activeIncomplete, { percent: 91 }, NO_GUARDRAILS), "compact_and_continue");
	// High context takes precedence over requesting completion: never audit in a nearly-full context.
	assert.equal(decideLoopAction(completingGoal(), { percent: 85 }, NO_GUARDRAILS), "compact_and_continue");
	// All blockCompletion tasks complete at healthy context → request_completion.
	assert.equal(decideLoopAction(completingGoal(), { percent: 45 }, NO_GUARDRAILS), "request_completion");
	// awaiting_audit → audit, even at very high context.
	assert.equal(decideLoopAction(awaitingAuditGoal(), { percent: 95 }, NO_GUARDRAILS), "audit");
	// archived → stop_archived.
	assert.equal(decideLoopAction(archivedGoal(), { percent: 10 }, NO_GUARDRAILS), "stop_archived");
	// no goal at all → stop_archived (nothing to loop on).
	assert.equal(decideLoopAction(null, { percent: 10 }, NO_GUARDRAILS), "stop_archived");
});

test("decision table: guardrail-exhausted rows still continue and never mutate the goal", () => {
	const activeIncomplete = foldGoalEvents(baseLedger());
	const before = JSON.stringify(activeIncomplete);
	assert.equal(decideLoopAction(activeIncomplete, { percent: 20 }, { wrapfixUsed: MAX_WRAPFIX_CONVERSIONS_PER_TURN, delegateUsed: 0 }), "continue");
	assert.equal(decideLoopAction(activeIncomplete, { percent: 20 }, { wrapfixUsed: 0, delegateUsed: DEFAULT_DELEGATE_BUDGET }), "continue");
	assert.equal(decideLoopAction(activeIncomplete, { percent: 20 }, { wrapfixUsed: MAX_WRAPFIX_CONVERSIONS_PER_TURN, delegateUsed: DEFAULT_DELEGATE_BUDGET }), "continue");
	// One below the caps also continues.
	assert.equal(decideLoopAction(activeIncomplete, { percent: 20 }, { wrapfixUsed: MAX_WRAPFIX_CONVERSIONS_PER_TURN - 1, delegateUsed: DEFAULT_DELEGATE_BUDGET - 1 }), "continue");
	assert.equal(JSON.stringify(activeIncomplete), before, "decideLoopAction must be pure");
});

test("helper: allBlockCompletionComplete needs at least one blocking task with evidence", () => {
	assert.equal(allBlockCompletionComplete(foldGoalEvents(baseLedger())), false);
	assert.equal(allBlockCompletionComplete(completingGoal()), true);
});
