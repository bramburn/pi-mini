// Reference implementation of the goal-loop pure logic specced in
// specs/features/goal-loop/*.feature and specs/async/channels/goal-ledger.yaml.
//
// Three pure functions, mirrored by tests/unit/goal-loop.test.mjs:
//   1. foldGoalEvents(events)  — ledger reducer: goal_events.jsonl lines → Goal
//   2. buildGoalPromptBlock(goal, {byteBudget}) — mini system-prompt extension
//   3. decideLoopAction(goal, contextUsage, guardrails) — next loop action
//
// This file is colocated test reference code, not shipped runtime code; the
// future implementation in index.ts must behave identically.

export const DEFAULT_PROMPT_BYTE_BUDGET = 4096;
export const DEFAULT_CONTEXT_PERCENT_THRESHOLD = 80;
export const DEFAULT_DELEGATE_BUDGET = 8;
export const MAX_WRAPFIX_CONVERSIONS_PER_TURN = 2;
export const COMPLETION_SIGNAL = "GOAL_STATUS: complete";
export const BLOCKED_SIGNAL = "GOAL_STATUS: blocked";

export const LOOP_ACTIONS = Object.freeze([
	"continue",
	"request_completion",
	"audit",
	"compact_and_continue",
	"stop_archived",
]);

const TERMINAL_TASK_STATUS = new Set(["pending", "in_progress", "complete"]);

/** Deep-copy a task list snapshot into fresh task objects. */
function normalizeTasks(tasks) {
	return (tasks ?? []).map((t) => {
		const status = TERMINAL_TASK_STATUS.has(t.status) ? t.status : "pending";
		return {
			id: String(t.id),
			title: String(t.title ?? t.id),
			blockCompletion: t.blockCompletion === true,
			verificationContract: String(t.verificationContract ?? ""),
			...(t.evidence ? { evidence: String(t.evidence) } : {}),
			status,
		};
	});
}

export function allBlockCompletionComplete(goal) {
	const blocking = goal.taskList.filter((t) => t.blockCompletion);
	return blocking.length > 0 && blocking.every((t) => t.status === "complete");
}

function findTask(goal, taskId) {
	return goal.taskList.find((t) => t.id === taskId);
}

/**
 * Find a task by id, or auto-vivify it. Legacy ledger lines (task_started /
 * task_complete) reference tasks whose detail only ever lived in the
 * checkpoint accumulator, so a first reference materializes the task with
 * the blockCompletion default of the last legacy task_list_set line.
 */
function vivifyTask(goal, taskId, blockCompletion = true) {
	const existing = findTask(goal, taskId);
	if (existing) return existing;
	const task = {
		id: String(taskId),
		title: String(taskId),
		blockCompletion,
		verificationContract: "",
		status: "pending",
	};
	goal.taskList.push(task);
	return task;
}

/** Recompute the active↔completing boundary after task/goal changes. */
function recomputeGate(goal) {
	if (goal.status === "active" || goal.status === "completing") {
		goal.status = allBlockCompletionComplete(goal) ? "completing" : "active";
	}
}

function applyTaskListOps(goal, ops) {
	for (const op of ops ?? []) {
		switch (op.op) {
			case "add": {
				if (!op.task?.id) throw new Error("taskListOps add requires a task id");
				if (findTask(goal, op.task.id)) throw new Error(`taskListOps add: duplicate task id ${op.task.id}`);
				goal.taskList.push(...normalizeTasks([op.task]));
				break;
			}
			case "remove": {
				const idx = goal.taskList.findIndex((t) => t.id === op.taskId);
				if (idx < 0) throw new Error(`taskListOps remove: unknown task id ${op.taskId}`);
				goal.taskList.splice(idx, 1);
				break;
			}
			case "update": {
				const task = findTask(goal, op.taskId);
				if (!task) throw new Error(`taskListOps update: unknown task id ${op.taskId}`);
				if (op.task?.title !== undefined) task.title = String(op.task.title);
				if (op.task?.blockCompletion !== undefined) task.blockCompletion = op.task.blockCompletion === true;
				if (op.task?.verificationContract !== undefined) task.verificationContract = String(op.task.verificationContract);
				break;
			}
			case "complete": {
				const task = findTask(goal, op.taskId);
				if (!task) throw new Error(`taskListOps complete: unknown task id ${op.taskId}`);
				if (!op.evidence) throw new Error(`taskListOps complete: task ${op.taskId} requires evidence`);
				task.status = "complete";
				task.evidence = String(op.evidence);
				break;
			}
			default:
				throw new Error(`taskListOps: unknown op ${op.op}`);
		}
	}
}

/**
 * Fold goal_events.jsonl lines (already JSON.parsed) into the current Goal.
 * Unknown/legacy event types (goal_paused, goal_resumed, goal_completed,
 * audit_started, …) are ignored so old ledgers stay readable.
 *
 * @param {Array<object>} events parsed ledger lines, in append order
 * @returns {object|null} folded Goal, or null when no goal_created was seen
 */
export function foldGoalEvents(events) {
	let goal = null;
	// Legacy task_list_set lines carry only {"taskCount":N,"blockCompletion":B}
	// — the per-task detail lived in the checkpoint accumulator. Tasks are
	// therefore materialized lazily from the first task_started/task_complete
	// reference, inheriting this blockCompletion default.
	let legacyBlockDefault = true;
	for (const ev of events) {
		if (!ev || typeof ev !== "object" || typeof ev.type !== "string") continue;
		switch (ev.type) {
			case "goal_created":
				goal = {
					id: String(ev.goalId),
					objective: String(ev.objective ?? ""),
					revision: typeof ev.revision === "number" ? ev.revision : 1,
					status: "active",
					taskList: [],
					usage: { tokensUsed: 0, activeSeconds: 0, ...(ev.usage ?? {}) },
					stopReason: null,
					createdAt: ev.at ?? null,
					amendedAt: null,
					lastAudit: null,
				};
				break;
			case "task_list_set":
				requireGoal(goal, ev);
				if (Array.isArray(ev.tasks)) {
					goal.taskList = normalizeTasks(ev.tasks);
				} else if (typeof ev.taskCount === "number") {
					// Legacy shape: no per-task detail; tasks vivify later.
					legacyBlockDefault = ev.blockCompletion === true;
					goal.taskList = [];
				}
				recomputeGate(goal);
				break;
			case "task_started": {
				requireGoal(goal, ev);
				const task = vivifyTask(goal, ev.taskId, legacyBlockDefault);
				task.status = "in_progress";
				break;
			}
			case "task_complete": {
				requireGoal(goal, ev);
				if (!ev.evidence) {
					throw new Error(`task_complete for ${ev.taskId} rejected: evidence is mandatory`);
				}
				// Unknown task ids auto-vivify (legacy ledgers reference tasks
				// whose detail only lived in the checkpoint accumulator).
				const task = vivifyTask(goal, ev.taskId, legacyBlockDefault);
				task.status = "complete";
				task.evidence = String(ev.evidence);
				recomputeGate(goal);
				break;
			}
			case "goal_amended": {
				requireGoal(goal, ev);
				goal.revision = ev.revision;
				goal.amendedAt = ev.at ?? null;
				if (ev.objective !== undefined) goal.objective = String(ev.objective);
				applyTaskListOps(goal, ev.taskListOps);
				// Steering consumes a pending completion request: the gate must
				// re-run against the new revision after further work.
				if (goal.status === "awaiting_audit") goal.status = "active";
				recomputeGate(goal);
				break;
			}
			case "completion_requested": {
				requireGoal(goal, ev);
				if (!allBlockCompletionComplete(goal)) {
					const missing = goal.taskList
						.filter((t) => t.blockCompletion && t.status !== "complete")
						.map((t) => t.id)
						.join(", ");
					throw new Error(`completion_requested rejected: blockCompletion task(s) lack evidence: ${missing}`);
				}
				goal.status = "awaiting_audit";
				break;
			}
			case "audit_result": {
				requireGoal(goal, ev);
				// Stale-revision audits (an amendment landed after the request)
				// are ignored; the gate re-runs against the current revision.
				// Events without an explicit revision (legacy ledgers) always
				// match the revision current at completion_requested time.
				if (ev.revision !== undefined && ev.revision !== goal.revision) break;
				if (goal.status !== "awaiting_audit") break;
				goal.lastAudit = {
					goalId: goal.id,
					revision: ev.revision,
					verdict: ev.verdict,
					report: String(ev.report ?? ""),
					...(ev.continuation ? { continuation: String(ev.continuation) } : {}),
					auditor: ev.auditor === "worker" ? "worker" : "mini",
					auditedAt: ev.auditedAt ?? ev.at ?? null,
				};
				goal.status = ev.verdict === "approved" ? "complete" : "active";
				break;
			}
			case "goal_archived":
				requireGoal(goal, ev);
				goal.status = "archived";
				goal.stopReason = ev.stopReason ?? "audit_approved";
				goal.archivePath = ev.archivePath ?? null;
				break;
			default:
				// Unknown / legacy event: ignored by design.
				break;
		}
	}
	return goal;
}

function requireGoal(goal, ev) {
	if (!goal) throw new Error(`${ev.type} event before any goal_created`);
}

/**
 * Build the mini system-prompt extension block for the active goal. Injected
 * through the before_agent_start seam on every loop cycle.
 *
 * Guaranteed contents: the objective (with revision), every open task with
 * its verificationContract, the last disapproved audit's continuation
 * guidance when present, and the completion signal contract. The block never
 * exceeds `byteBudget` bytes (UTF-8); tasks are dropped from the tail (open
 * blocking tasks first, non-blocking last) until it fits, because the fold
 * is replayable from the ledger.
 *
 * @param {object} goal folded Goal state
 * @param {object} [opts]
 * @param {number} [opts.byteBudget] default DEFAULT_PROMPT_BYTE_BUDGET
 * @returns {string} prompt block
 */
export function buildGoalPromptBlock(goal, { byteBudget = DEFAULT_PROMPT_BYTE_BUDGET } = {}) {
	if (!goal) throw new Error("buildGoalPromptBlock requires a goal");
	const byteLen = (s) => Buffer.byteLength(s, "utf8");

	// Rank tasks for retention under budget pressure: open blocking tasks
	// first, then in-progress, then open non-blocking; completed tasks are
	// summarized by count only.
	const open = goal.taskList
		.filter((t) => t.status !== "complete")
		.sort((a, b) => Number(b.blockCompletion) - Number(a.blockCompletion));

	const render = (keptTasks) => {
		const lines = [
			"## Active Goal",
			"",
			`Objective: ${goal.objective} (revision ${goal.revision}, status ${goal.status})`,
			"",
		];
		const doneCount = goal.taskList.length - open.length;
		if (open.length === 0) {
			lines.push(`All ${doneCount} task(s) carry evidence. Request completion.`);
		} else {
			lines.push(`Open tasks (${keptTasks.length} of ${open.length}, ${doneCount} complete):`);
			for (const t of keptTasks) {
				lines.push(`- [${t.status}] ${t.id} (blocking: ${t.blockCompletion ? "yes" : "no"}): ${t.title}`);
				lines.push(`  Verification: ${t.verificationContract}`);
			}
			if (keptTasks.length < open.length) {
				lines.push(`- … ${open.length - keptTasks.length} further task(s) omitted for prompt budget; fold the ledger for the full list.`);
			}
		}
		if (goal.lastAudit?.verdict === "disapproved") {
			lines.push("");
			lines.push("Last audit disapproved. Continuation guidance (act on this before anything else):");
			lines.push(goal.lastAudit.continuation ?? goal.lastAudit.report);
		}
		lines.push("");
		lines.push(
			`Work autonomously toward the objective. When every blocking task is verifiably complete, end your reply with the exact line \`${COMPLETION_SIGNAL}\`. If you cannot proceed, emit \`${BLOCKED_SIGNAL} — <reason>\` instead.`,
		);
		return lines.join("\n");
	};

	// Drop from the tail until under budget; the signal line always survives
	// because it lives in the fixed header/footer, not in dropped task lines.
	for (let keep = open.length; keep >= 0; keep--) {
		const block = render(open.slice(0, keep));
		if (byteLen(block) <= byteBudget) return block;
	}
	throw new Error("goal prompt block cannot fit within byte budget");
}

/**
 * Decide the loop's next action. Guardrail counters describe the turn that
 * just settled; they never change the decision — an exhausted turn ends
 * cleanly and the next loop turn resets the budgets, so goal state cannot be
 * corrupted by throttling.
 *
 * Priority: stop_archived > audit (awaiting_audit) > compact_and_continue
 * (context percent at/over threshold) > request_completion (all blockCompletion
 * tasks complete) > continue.
 *
 * @param {object|null} goal folded Goal state
 * @param {object} [contextUsage] ctx.getContextUsage() — {tokens, contextWindow, percent}
 * @param {object} [guardrails] {wrapfixUsed, delegateUsed} — informational
 * @returns {"continue"|"request_completion"|"audit"|"compact_and_continue"|"stop_archived"}
 */
export function decideLoopAction(goal, contextUsage = { percent: 0 }, guardrails = { wrapfixUsed: 0, delegateUsed: 0 }) {
	if (!goal || goal.status === "archived") return "stop_archived";
	if (goal.status === "awaiting_audit") return "audit";
	const percent = typeof contextUsage?.percent === "number" ? contextUsage.percent : 0;
	if (percent >= DEFAULT_CONTEXT_PERCENT_THRESHOLD) return "compact_and_continue";
	if (allBlockCompletionComplete(goal)) return "request_completion";
	return "continue";
}
