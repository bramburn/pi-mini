// Goal-loop module for pi-mini: event-sourced goal ledger, prompt block
// composer, loop decision table, audit runner, and the pi extension wiring.
//
// The pure logic (foldGoalEvents / buildGoalPromptBlock / decideLoopAction /
// allBlockCompletionComplete) is promoted verbatim from the canonical
// reference implementation in tests/unit/lib/goal-loop.mjs — same names, same
// semantics — so the 23 reference unit tests keep passing through the
// re-export shim in that file.
//
// Specs: specs/api/components/schemas/goal.yaml, audit-result.yaml,
// specs/async/channels/goal-ledger.yaml, specs/features/goal-loop/*.feature.

import * as fs from "node:fs";
import * as path from "node:path";
import { OLLAMA_BASE_URL } from "./settings.ts";
import type { PiMiniConfig } from "./settings.ts";

// ============================================================================
// Constants (same values as the reference implementation)
// ============================================================================

export const DEFAULT_PROMPT_BYTE_BUDGET = 4096;
export const DEFAULT_CONTEXT_PERCENT_THRESHOLD = 80;
export const DEFAULT_DELEGATE_BUDGET = 8;
export const MAX_WRAPFIX_CONVERSIONS_PER_TURN = 2;
export const COMPLETION_SIGNAL = "GOAL_STATUS: complete";
export const BLOCKED_SIGNAL = "GOAL_STATUS: blocked";

/** Anti-runaway guard: max consecutive no-signal nudges before the loop pauses. */
export const MAX_NUDGES = 3;

export const LOOP_ACTIONS = Object.freeze([
	"continue",
	"request_completion",
	"audit",
	"compact_and_continue",
	"stop_archived",
]);

// ============================================================================
// Types
// ============================================================================

export type TaskStatus = "pending" | "in_progress" | "complete";
export type GoalStatus = "active" | "completing" | "awaiting_audit" | "complete" | "archived";
export type LoopAction = (typeof LOOP_ACTIONS)[number];
export type AuditVerdict = "approved" | "disapproved";

export interface GoalTask {
	id: string;
	title: string;
	blockCompletion: boolean;
	verificationContract: string;
	evidence?: string;
	status: TaskStatus;
}

export interface GoalAudit {
	goalId: string;
	revision?: number;
	verdict: AuditVerdict;
	report: string;
	continuation?: string;
	auditor: "mini" | "worker";
	auditedAt: string | null;
}

export interface Goal {
	id: string;
	objective: string;
	revision: number;
	status: GoalStatus;
	taskList: GoalTask[];
	usage: { tokensUsed: number; activeSeconds: number };
	stopReason: string | null;
	createdAt: string | null;
	amendedAt: string | null;
	lastAudit: GoalAudit | null;
	archivePath?: string | null;
}

export interface ContextUsageLike {
	tokens?: number;
	contextWindow?: number;
	percent?: number;
}

export interface AuditResultEvent {
	type: "audit_result";
	goalId: string;
	revision: number;
	verdict: AuditVerdict;
	report: string;
	continuation?: string;
	auditor: "mini" | "worker";
	auditedAt: string;
}

/** runAudit outcome: a finished self-audit event, or a routing request. */
export type AuditOutcome = { kind: "audit"; event: AuditResultEvent } | { kind: "worker" };

// ============================================================================
// Pure logic — promoted verbatim from tests/unit/lib/goal-loop.mjs
// ============================================================================

const TERMINAL_TASK_STATUS = new Set(["pending", "in_progress", "complete"]);

/** Deep-copy a task list snapshot into fresh task objects. */
function normalizeTasks(tasks: Array<Record<string, unknown>> | undefined | null): GoalTask[] {
	return (tasks ?? []).map((t) => {
		const status = TERMINAL_TASK_STATUS.has(t.status as TaskStatus) ? (t.status as TaskStatus) : "pending";
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

export function allBlockCompletionComplete(goal: Goal): boolean {
	const blocking = goal.taskList.filter((t) => t.blockCompletion);
	return blocking.length > 0 && blocking.every((t) => t.status === "complete");
}

function findTask(goal: Goal, taskId: string): GoalTask | undefined {
	return goal.taskList.find((t) => t.id === taskId);
}

/**
 * Find a task by id, or auto-vivify it. Legacy ledger lines (task_started /
 * task_complete) reference tasks whose detail only ever lived in the
 * checkpoint accumulator, so a first reference materializes the task with
 * the blockCompletion default of the last legacy task_list_set line.
 */
function vivifyTask(goal: Goal, taskId: string, blockCompletion = true): GoalTask {
	const existing = findTask(goal, taskId);
	if (existing) return existing;
	const task: GoalTask = {
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
function recomputeGate(goal: Goal): void {
	if (goal.status === "active" || goal.status === "completing") {
		goal.status = allBlockCompletionComplete(goal) ? "completing" : "active";
	}
}

interface TaskListOp {
	op: string;
	taskId?: string;
	task?: Record<string, unknown>;
	evidence?: unknown;
}

function applyTaskListOps(goal: Goal, ops: TaskListOp[] | undefined | null): void {
	for (const op of ops ?? []) {
		switch (op.op) {
			case "add": {
				if (!op.task?.id) throw new Error("taskListOps add requires a task id");
				if (findTask(goal, String(op.task.id))) throw new Error(`taskListOps add: duplicate task id ${op.task.id}`);
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
				const task = findTask(goal, String(op.taskId));
				if (!task) throw new Error(`taskListOps update: unknown task id ${op.taskId}`);
				if (op.task?.title !== undefined) task.title = String(op.task.title);
				if (op.task?.blockCompletion !== undefined) task.blockCompletion = op.task.blockCompletion === true;
				if (op.task?.verificationContract !== undefined) task.verificationContract = String(op.task.verificationContract);
				break;
			}
			case "complete": {
				const task = findTask(goal, String(op.taskId));
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
 * @param events parsed ledger lines, in append order
 * @returns folded Goal, or null when no goal_created was seen
 */
export function foldGoalEvents(events: Array<Record<string, unknown>> | null | undefined): Goal | null {
	let goal: Goal | null = null;
	// Legacy task_list_set lines carry only {"taskCount":N,"blockCompletion":B}
	// — the per-task detail lived in the checkpoint accumulator. Tasks are
	// therefore materialized lazily from the first task_started/task_complete
	// reference, inheriting this blockCompletion default.
	let legacyBlockDefault = true;
	for (const ev of events ?? []) {
		if (!ev || typeof ev !== "object" || typeof ev.type !== "string") continue;
		switch (ev.type) {
			case "goal_created":
				goal = {
					id: String(ev.goalId),
					objective: String(ev.objective ?? ""),
					revision: typeof ev.revision === "number" ? ev.revision : 1,
					status: "active",
					taskList: [],
					usage: { tokensUsed: 0, activeSeconds: 0, ...((ev.usage as object | undefined) ?? {}) },
					stopReason: null,
					createdAt: (ev.at as string | undefined) ?? null,
					amendedAt: null,
					lastAudit: null,
				};
				break;
			case "task_list_set":
				requireGoal(goal, ev.type);
				if (Array.isArray(ev.tasks)) {
					goal.taskList = normalizeTasks(ev.tasks as Array<Record<string, unknown>>);
				} else if (typeof ev.taskCount === "number") {
					// Legacy shape: no per-task detail; tasks vivify later.
					legacyBlockDefault = ev.blockCompletion === true;
					goal.taskList = [];
				}
				recomputeGate(goal);
				break;
			case "task_started": {
				requireGoal(goal, ev.type);
				const task = vivifyTask(goal, String(ev.taskId), legacyBlockDefault);
				task.status = "in_progress";
				break;
			}
			case "task_complete": {
				requireGoal(goal, ev.type);
				if (!ev.evidence) {
					throw new Error(`task_complete for ${ev.taskId} rejected: evidence is mandatory`);
				}
				// Unknown task ids auto-vivify (legacy ledgers reference tasks
				// whose detail only lived in the checkpoint accumulator).
				const task = vivifyTask(goal, String(ev.taskId), legacyBlockDefault);
				task.status = "complete";
				task.evidence = String(ev.evidence);
				recomputeGate(goal);
				break;
			}
			case "goal_amended": {
				requireGoal(goal, ev.type);
				goal.revision = ev.revision as number;
				goal.amendedAt = (ev.at as string | undefined) ?? null;
				if (ev.objective !== undefined) goal.objective = String(ev.objective);
				applyTaskListOps(goal, ev.taskListOps as TaskListOp[] | undefined);
				// Steering consumes a pending completion request: the gate must
				// re-run against the new revision after further work.
				if (goal.status === "awaiting_audit") goal.status = "active";
				recomputeGate(goal);
				break;
			}
			case "completion_requested": {
				requireGoal(goal, ev.type);
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
				requireGoal(goal, ev.type);
				// Stale-revision audits (an amendment landed after the request)
				// are ignored; the gate re-runs against the current revision.
				// Events without an explicit revision (legacy ledgers) always
				// match the revision current at completion_requested time.
				if (ev.revision !== undefined && ev.revision !== goal.revision) break;
				if (goal.status !== "awaiting_audit") break;
				goal.lastAudit = {
					goalId: goal.id,
					revision: ev.revision as number | undefined,
					verdict: ev.verdict as AuditVerdict,
					report: String(ev.report ?? ""),
					...(ev.continuation ? { continuation: String(ev.continuation) } : {}),
					auditor: ev.auditor === "worker" ? "worker" : "mini",
					auditedAt: (ev.auditedAt as string | undefined) ?? (ev.at as string | undefined) ?? null,
				};
				goal.status = ev.verdict === "approved" ? "complete" : "active";
				break;
			}
			case "goal_archived":
				requireGoal(goal, ev.type);
				goal.status = "archived";
				goal.stopReason = (ev.stopReason as string | undefined) ?? "audit_approved";
				goal.archivePath = (ev.archivePath as string | undefined) ?? null;
				break;
			default:
				// Unknown / legacy event: ignored by design.
				break;
		}
	}
	return goal;
}

function requireGoal(goal: Goal | null, type: string): asserts goal is Goal {
	if (!goal) throw new Error(`${type} event before any goal_created`);
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
 */
export function buildGoalPromptBlock(
	goal: Goal,
	{ byteBudget = DEFAULT_PROMPT_BYTE_BUDGET }: { byteBudget?: number } = {},
): string {
	if (!goal) throw new Error("buildGoalPromptBlock requires a goal");
	const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

	// Rank tasks for retention under budget pressure: open blocking tasks
	// first, then in-progress, then open non-blocking; completed tasks are
	// summarized by count only.
	const open = goal.taskList
		.filter((t) => t.status !== "complete")
		.sort((a, b) => Number(b.blockCompletion) - Number(a.blockCompletion));

	const render = (keptTasks: GoalTask[]): string => {
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
 * Compose a base system prompt with the goal block. Exported so the
 * integrator can prepend its own mini-instructions block around this
 * composer however it likes.
 */
export function buildGoalSystemPrompt(base: string, goal: Goal): string {
	return `${base}\n\n${buildGoalPromptBlock(goal)}`;
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
 */
export function decideLoopAction(
	goal: Goal | null | undefined,
	contextUsage: ContextUsageLike = { percent: 0 },
	guardrails: { wrapfixUsed: number; delegateUsed: number } = { wrapfixUsed: 0, delegateUsed: 0 },
): LoopAction {
	if (!goal || goal.status === "archived") return "stop_archived";
	if (goal.status === "awaiting_audit") return "audit";
	const percent = typeof contextUsage?.percent === "number" ? contextUsage.percent : 0;
	if (percent >= DEFAULT_CONTEXT_PERCENT_THRESHOLD) return "compact_and_continue";
	if (allBlockCompletionComplete(goal)) return "request_completion";
	return "continue";
}

// ============================================================================
// GoalStore — the .pi/goals/goal_events.jsonl ledger
// ============================================================================

export const GOALS_DIR_ENV = "PI_MINI_GOALS_DIR";
export const GOAL_LEDGER_FILE = "goal_events.jsonl";

function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Event-sourced goal store. Each event is one JSON line appended to
 * <dir>/goal_events.jsonl; current state is a fold over those lines.
 */
export class GoalStore {
	readonly dir: string;

	constructor(dir?: string) {
		this.dir = dir ?? process.env[GOALS_DIR_ENV] ?? path.join(process.cwd(), ".pi", "goals");
	}

	private ledgerPath(): string {
		return path.join(this.dir, GOAL_LEDGER_FILE);
	}

	/** Read the ledger and fold it. Missing file folds to null. */
	load(): Goal | null {
		let raw: string;
		try {
			raw = fs.readFileSync(this.ledgerPath(), "utf8");
		} catch {
			return null;
		}
		const events: Array<Record<string, unknown>> = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line);
				if (parsed && typeof parsed === "object") events.push(parsed);
			} catch {
				// Malformed line: skip, the ledger stays readable.
			}
		}
		return foldGoalEvents(events);
	}

	/** Append one event as a single JSON line (mkdir -p first). */
	appendEvent(ev: Record<string, unknown>): Record<string, unknown> {
		fs.mkdirSync(this.dir, { recursive: true });
		const stamped = { at: nowIso(), ...ev };
		fs.appendFileSync(this.ledgerPath(), JSON.stringify(stamped) + "\n", "utf8");
		return stamped;
	}

	/** The folded active goal, or undefined when none is active. */
	current(): Goal | undefined {
		const goal = this.load();
		if (!goal || goal.status === "archived") return undefined;
		return goal;
	}
}

// ============================================================================
// Goal API — ledger event helpers
// ============================================================================

/** Short id in the existing `goal_xxxx-yyyy` / `muu69dvt-mtoxvg` style. */
export function newGoalId(): string {
	return `goal_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Start a goal: append goal_created (revision 1) and return the folded goal. */
export function startGoal(store: GoalStore, objective: string): Goal {
	store.appendEvent({ type: "goal_created", goalId: newGoalId(), objective: String(objective), revision: 1 });
	const goal = store.current();
	if (!goal) throw new Error("startGoal: goal_created did not produce an active goal");
	return goal;
}

/** Amend the active goal with steering text; bumps the revision. */
export function amendGoal(store: GoalStore, text: string): Goal | undefined {
	const goal = store.current();
	if (!goal) return undefined;
	store.appendEvent({ type: "goal_amended", goalId: goal.id, revision: goal.revision + 1, reason: String(text) });
	return store.current();
}

/** Cancel (archive) the active goal. */
export function cancelGoal(store: GoalStore): Goal | undefined {
	const goal = store.current();
	if (!goal) return undefined;
	store.appendEvent({ type: "goal_archived", goalId: goal.id, stopReason: "cancelled" });
	return store.load() ?? undefined;
}

// ============================================================================
// Completion signal parsing
// ============================================================================

export interface GoalStatusSignal {
	status: "complete" | "blocked" | undefined;
	reason?: string;
}

/**
 * Parse the completion signal the model must emit. Exact-line match:
 *   GOAL_STATUS: complete
 *   GOAL_STATUS: blocked — <reason>
 * Tolerant of leading/trailing whitespace, a trailing period, and a line
 * wrapped in a markdown code fence/backticks.
 */
export function parseGoalStatus(assistantText: string | null | undefined): GoalStatusSignal {
	if (!assistantText) return { status: undefined };
	for (const rawLine of assistantText.split(/\r?\n/)) {
		const line = rawLine.trim().replace(/^`+|`+$/g, "").trim();
		if (new RegExp(`^${COMPLETION_SIGNAL}\\s*[.。]?$`).test(line)) return { status: "complete" };
		const blocked = new RegExp(`^${BLOCKED_SIGNAL}\\s*[—–—-]\\s*(.*?)\\s*[.。]?$`).exec(line);
		if (blocked) return { status: "blocked", reason: blocked[1] };
		if (new RegExp(`^${BLOCKED_SIGNAL}\\s*[.。]?$`).test(line)) return { status: "blocked", reason: "" };
	}
	return { status: undefined };
}

// ============================================================================
// Audit runner
// ============================================================================

/** Build the auditor conversation: goal objective + task list with evidence. */
export function buildAuditMessages(goal: Goal): Array<{ role: string; content: string }> {
	const lines: string[] = [
		`Goal objective: ${goal.objective} (revision ${goal.revision})`,
		"",
		`The agent claims every blockCompletion task is verifiably complete (${goal.taskList.filter((t) => t.status === "complete").length} of ${goal.taskList.length} tasks complete) and emitted the completion signal \`${COMPLETION_SIGNAL}\`.`,
		"",
		"Task list with claimed evidence:",
	];
	for (const t of goal.taskList) {
		lines.push(`- [${t.status}] ${t.id} (blocking: ${t.blockCompletion ? "yes" : "no"}): ${t.title}`);
		lines.push(`  Verification contract: ${t.verificationContract}`);
		if (t.evidence) lines.push(`  Claimed evidence: ${t.evidence}`);
	}
	lines.push("", "Independently verify whether the claimed evidence is verifiable proof (test counts, command output) that covers every blockCompletion task's verification contract. Do not take the agent's word for it.");
	return [
		{
			role: "system",
			content:
				"You are a strict completion auditor for an autonomous coding agent. You receive a goal, its task list with claimed evidence, and completion claims. " +
				"Reply with the exact line `AUDIT_VERDICT: approved` when the evidence is verifiable and covers every blocking task's verification contract, or `AUDIT_VERDICT: disapproved` otherwise. " +
				"After the verdict line write an audit report of at most 5 sentences explaining what you checked and what failed. " +
				"When disapproved, end with a line starting `CONTINUATION: ` followed by concrete next steps for the agent. Reply with nothing else.",
		},
		{ role: "user", content: lines.join("\n") },
	];
}

/** Parse the auditor's reply into verdict / report / continuation. */
export function parseAuditResponse(content: string): { verdict: AuditVerdict; report: string; continuation?: string } {
	const verdictMatch = /^AUDIT_VERDICT:\s*(approved|disapproved)\s*$/m.exec(content);
	if (!verdictMatch) throw new Error("audit response missing `AUDIT_VERDICT: approved|disapproved` line");
	const verdict = verdictMatch[1] as AuditVerdict;
	const afterVerdict = content.slice(verdictMatch.index + verdictMatch[0].length).trim();
	const report = afterVerdict.replace(/^CONTINUATION:.*$/gim, "").trim() || afterVerdict;
	const continuationMatch = /^CONTINUATION:\s*(.+)$/m.exec(afterVerdict);
	const continuation = continuationMatch ? continuationMatch[1].trim() : verdict === "disapproved" ? report : undefined;
	return { verdict, report, ...(continuation ? { continuation } : {}) };
}

/**
 * Run the completion audit. All model I/O is injectable via fetchImpl.
 *
 * - cfg.goalAudit === "self": POST {OLLAMA_BASE_URL}/api/chat with the tiny
 *   model (native request shape: think:false, num_ctx 8192, num_predict 512,
 *   stream:false), parse `AUDIT_VERDICT:` + the report into an audit_result
 *   event. Disapproved outcomes carry continuation guidance from the report.
 * - cfg.goalAudit === "worker": no model call here — returns {kind:"worker"}
 *   so the caller routes the audit through delegate_to_worker.
 */
export async function runAudit(
	cfg: PiMiniConfig,
	goal: Goal,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AuditOutcome> {
	if (cfg.goalAudit === "worker") return { kind: "worker" };
	const baseUrl = OLLAMA_BASE_URL.replace(/\/+$/, "");
	const response = await fetchImpl(`${baseUrl}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: cfg.tiny.modelId,
			messages: buildAuditMessages(goal),
			stream: false,
			think: false,
			options: { num_ctx: 8192, num_predict: 512 },
		}),
	});
	if (!response.ok) {
		throw new Error(`audit request failed: HTTP ${response.status}`);
	}
	const data = (await response.json()) as { message?: { content?: string } };
	const content = String(data?.message?.content ?? "");
	const parsed = parseAuditResponse(content);
	return {
		kind: "audit",
		event: {
			type: "audit_result",
			goalId: goal.id,
			revision: goal.revision,
			verdict: parsed.verdict,
			report: parsed.report,
			...(parsed.continuation ? { continuation: parsed.continuation } : {}),
			auditor: "mini",
			auditedAt: nowIso(),
		},
	};
}

// ============================================================================
// pi extension wiring
// ============================================================================

/** Minimal structural types for the pi extension surface we use. */
export interface GoalLoopCtx {
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
	getContextUsage?: () => ContextUsageLike | undefined;
	compact?: (options?: unknown) => void;
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

export interface GoalLoopPi {
	on(event: "before_agent_start", handler: (event: { prompt: string; systemPrompt: string }, ctx: GoalLoopCtx) => unknown): void;
	on(event: "message_end", handler: (event: { message: unknown }, ctx: GoalLoopCtx) => unknown): void;
	on(event: "agent_settled", handler: (event: { type: string }, ctx: GoalLoopCtx) => unknown): void;
}

export interface GoalLoopOptions {
	/** Whether mini mode (and therefore the goal loop) is currently on. */
	isEnabled: () => boolean;
	getConfig: () => PiMiniConfig;
	store: GoalStore;
	/** Injectable transport for the self-audit model call. */
	fetchImpl?: typeof fetch;
	/** Route an audit through delegate_to_worker (required when goalAudit === "worker"). */
	delegateAudit?: (goal: Goal) => Promise<{ verdict: AuditVerdict; report: string }>;
}

function archivePathFor(goal: Goal): string {
	return `.pi/goals/archived/goal_${Date.now()}_${goal.id}.md`;
}

function assistantTextAndCalls(message: unknown): { text: string; hasToolCalls: boolean } {
	const content = (message as { content?: unknown } | null | undefined)?.content;
	if (typeof content === "string") return { text: content, hasToolCalls: false };
	if (Array.isArray(content)) {
		let text = "";
		let hasToolCalls = false;
		for (const part of content) {
			if (part && typeof part === "object") {
				const typed = part as { type?: string; text?: unknown };
				if (typed.type === "text") text += (text ? "\n" : "") + String(typed.text ?? "");
				else if (typed.type === "toolCall") hasToolCalls = true;
			}
		}
		return { text, hasToolCalls };
	}
	return { text: "", hasToolCalls: false };
}

/**
 * Register the goal loop on pi: before_agent_start injects the goal block,
 * message_end watches for the completion signal, agent_settled drives the
 * loop with at most one synthetic user message per settle.
 *
 * The driver is deliberately conservative: after MAX_NUDGES consecutive
 * assistant messages with neither tool calls nor a goal signal it pauses the
 * loop and notifies the user instead of nudging forever.
 */
export function installGoalLoop(pi: GoalLoopPi, ctx: GoalLoopCtx | undefined, opts: GoalLoopOptions): void {
	// Anti-runaway state: reset whenever the assistant shows life (tool calls
	// or a goal signal); incremented on quiet messages.
	let nudgeStreak = 0;
	let loopPaused = false;

	const notify = (c: GoalLoopCtx | undefined, message: string, type?: "info" | "warning" | "error"): void => {
		c?.ui?.notify(message, type);
	};

	/**
	 * The completion gate: append completion_requested, run the audit, then
	 * append audit_result (+ goal_archived when approved). Idempotent at the
	 * ledger level: completion_requested only folds when every blocking task
	 * carries evidence, and callers skip when already awaiting_audit.
	 */
	const runCompletionGate = async (goal: Goal, c: GoalLoopCtx): Promise<void> => {
		const cfg = opts.getConfig();
		opts.store.appendEvent({ type: "completion_requested", goalId: goal.id, revision: goal.revision });
		let auditEvent: AuditResultEvent;
		try {
			const outcome = await runAudit(cfg, goal, opts.fetchImpl);
			if (outcome.kind === "audit") {
				auditEvent = outcome.event;
			} else {
				if (!opts.delegateAudit) {
					notify(c, "pi-mini: goalAudit=worker but no delegateAudit hook registered; audit skipped", "error");
					return;
				}
				const delegated = await opts.delegateAudit(goal);
				auditEvent = {
					type: "audit_result",
					goalId: goal.id,
					revision: goal.revision,
					verdict: delegated.verdict,
					report: delegated.report,
					auditor: "worker",
					auditedAt: nowIso(),
				};
			}
		} catch (error) {
			notify(c, `pi-mini: audit failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		opts.store.appendEvent(auditEvent);
		if (auditEvent.verdict === "approved") {
			opts.store.appendEvent({ type: "goal_archived", goalId: goal.id, archivePath: archivePathFor(goal), stopReason: "audit_approved" });
			nudgeStreak = 0;
			loopPaused = false;
			notify(c, "pi-mini: goal complete — audit approved", "info");
		} else {
			notify(
				c,
				`pi-mini: audit disapproved — ${auditEvent.continuation ?? auditEvent.report}. Continuing toward the goal.`,
				"warning",
			);
		}
	};

	const sendNudge = (c: GoalLoopCtx, goal: Goal, continuationFirst: boolean): void => {
		const open = goal.taskList.filter((t) => t.status !== "complete");
		const list = open.length > 0 ? open.map((t) => `${t.id}${t.blockCompletion ? " (blocking)" : ""}`).join(", ") : "none";
		let text = `Continue working toward the goal: ${goal.objective}. Open tasks: ${list}.`;
		if (continuationFirst && goal.lastAudit?.verdict === "disapproved") {
			text += ` First act on the audit continuation guidance: ${goal.lastAudit.continuation ?? goal.lastAudit.report}`;
		}
		text += ` When every blocking task is verifiably complete, end your reply with the exact line \`${COMPLETION_SIGNAL}\`.`;
		c.sendUserMessage(text, { deliverAs: "steer" });
	};

	pi.on("before_agent_start", (event, hctx) => {
		if (!opts.isEnabled()) return undefined;
		const goal = opts.store.current();
		if (!goal) return undefined;
		void hctx;
		return { systemPrompt: buildGoalSystemPrompt(event.systemPrompt, goal) };
	});

	pi.on("message_end", (event, hctx) => {
		const c = hctx ?? ctx;
		if (!c) return undefined;
		const { text, hasToolCalls } = assistantTextAndCalls(event.message);
		const signal = parseGoalStatus(text);
		if (signal.status || hasToolCalls) {
			nudgeStreak = 0;
			loopPaused = false;
		} else {
			nudgeStreak += 1;
		}
		if (!opts.isEnabled()) return undefined;
		const goal = opts.store.current();
		if (!goal) return undefined;
		if (signal.status === "complete") {
			// Premature signals (blocking tasks without evidence) are ignored;
			// the fold would reject completion_requested anyway.
			if ((goal.status === "active" || goal.status === "completing") && allBlockCompletionComplete(goal)) {
				return runCompletionGate(goal, c);
			}
			return undefined;
		}
		if (signal.status === "blocked") {
			// Blocked keeps the goal active: surface the reason, no archive.
			notify(c, `pi-mini: goal blocked — ${signal.reason || "no reason given"}. Goal stays active; send a steering message to adjust.`, "warning");
		}
		return undefined;
	});

	pi.on("agent_settled", (_event, hctx) => {
		const c = hctx ?? ctx;
		if (!c) return;
		if (!opts.isEnabled()) return;
		const goal = opts.store.current();
		if (!goal) return;
		const action = decideLoopAction(goal, c.getContextUsage?.());
		switch (action) {
			case "stop_archived":
				return;
			case "audit":
				// Already requested (e.g. by message_end in the same cycle).
				if (goal.status === "awaiting_audit") return;
				return runCompletionGate(goal, c).catch((error) =>
					notify(c, `pi-mini: audit failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
				);
			case "request_completion": {
				// After a disapproval the evidence is unchanged: re-auditing the
				// same revision would ping-pong. Nudge the continuation guidance
				// instead; the model re-requests completion once it has redone
				// the work (fresh task events bump the fold).
				if (goal.lastAudit?.verdict === "disapproved") {
					sendNudge(c, goal, true);
					return;
				}
				if (goal.status === "awaiting_audit") return;
				return runCompletionGate(goal, c).catch((error) =>
					notify(c, `pi-mini: audit failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
				);
			}
			case "compact_and_continue":
				c.compact?.();
				sendNudge(c, goal, false);
				return;
			case "continue": {
				if (loopPaused) return;
				if (nudgeStreak >= MAX_NUDGES) {
					loopPaused = true;
					notify(
						c,
						`pi-mini: goal loop paused after ${MAX_NUDGES} nudges without tool calls or a goal signal. Send a steering message to resume.`,
						"warning",
					);
					return;
				}
				sendNudge(c, goal, false);
				return;
			}
		}
	});
}
