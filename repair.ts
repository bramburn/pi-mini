// Tool-call syntax-failure repair loop for pi-mini (specs/api/paths/tool-repair/
// repair.yaml, specs/api/components/schemas/tool-repair.yaml,
// specs/features/tool-call-repair/*.feature). This is the POST-execution
// complement to the stream-level wrap-fix in wrapfix.ts: a tool call that RAN
// and FAILED on syntax is extracted into an isolated repair context, the reply
// is extracted with strict-JSON-only parsing, validated against the tool's
// argument contract, and re-issued — bounded, never infinite.
//
// ============================================================================
// pi-API-BOUND ADAPTATION (prominent, deliberate divergence from the spec text)
// ============================================================================
// The spec describes "re-execute repaired call". pi's extension API has NO way
// for an extension to execute a built-in tool: `pi.on("tool_result")` fires
// AFTER the tool has already run and its only lever is the ToolResultEventResult
// partial override ({ content?, details?, isError?, usage? }). Therefore, on a
// successful repair this module REWRITES the tool_result content to a compact
// REISSUE notice (isError stays true) that embeds the corrected JSON verbatim
// and instructs the model to re-issue the identical call; the model does so on
// its next turn and the re-issued call executes cleanly through pi's normal
// tool loop. Semantic/transient failures pass through untouched (zero LLM).
// ============================================================================
//
// SPEC DECISIONS EMBODIED HERE:
//   * classifyFailure implements the documented regex taxonomy over
//     errorText plus structural checks over rawArgs, with fixed precedence:
//     transient transport signals -> rawArgs structure -> syntax error-text
//     patterns -> semantic error-text patterns -> default semantic.
//   * buildRepairContext assembles the isolated fixer context: fixer system
//     prompt + ToolContract summary + verbatim rawArgs + classification,
//     nothing else, under REPAIR_CONTEXT_BYTE_BUDGET bytes.
//   * extractRepairedArgs is STRICT: the whole reply must be exactly one
//     JSON object (optionally inside one ```json fence); brace balancing
//     tolerates truncation, but surrounding prose or trailing junk rejects.
//     No key-sniffing fallback (unlike parser.ts's parseTolerantJson).
//   * validateAgainstContract enforces required / unknown-field /
//     primitive-type (incl. string-where-array/object) against a ToolContract.
//   * initialRepairState / canStartRepair / advance are the guardrail state
//     machine: per-call attempts, per-turn repair calls (INDEPENDENT of
//     wrapfix 2/turn and delegate 8/turn), transient bounded backoff with zero
//     LLM involvement, no recursion from inside a repair context. The
//     orchestrator below enforces the same budgets with direct counters
//     (module-level, so concurrent tool_result events cannot corrupt a shared
//     per-call machine); the pure machine stays exported for tests and audit.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OLLAMA_BASE_URL, TINY_PROVIDER, type PiMiniConfig } from "./settings.ts";

// --- Retry policy (RetryPolicy in the spec) ---------------------------------

export const MAX_REPAIR_ATTEMPTS_PER_CALL = 2;
export const MAX_REPAIR_CALLS_PER_TURN = 2;
export const BACKOFF_MS_TRANSIENT = [500, 2000];
export const REPAIR_CONTEXT_BYTE_BUDGET = 2048;
export const REPAIR_NUM_CTX = 4096;
export const REPAIR_NUM_PREDICT_MAX = 300;
export const REPAIR_STALL_TIMEOUT_MS = 90_000;

export const FIXER_SYSTEM_PROMPT =
	"You repair tool-call syntax ONLY. You are given a tool's argument contract, a failed tool call's raw " +
	"arguments, and why they failed. Rewrite the arguments so they are syntactically valid JSON and satisfy " +
	"the contract's required fields and types. Preserve the call's intent VERBATIM — never change, add, or " +
	"drop values beyond what is needed to fix the syntax/structure. Output STRICT JSON only: one JSON object, " +
	"no prose, no markdown fences, no explanation.";

// --- Tool contracts (canonical, distilled from the spec + reference tests) ---

export interface ToolContract {
	name: string;
	required: string[];
	fields: Record<string, string>;
}

/**
 * Argument contracts for pi's curated tools (settings.ts CURATED_TOOLS).
 * Distilled from pi's TypeBox schemas in packages/coding-agent/src/core/tools
 * (grep.ts, find.ts, bash.ts, read.ts) and the canonical edit contract in
 * specs/api/components/schemas/tool-repair.yaml ({path, oldText, newText}).
 * Tools without a contract are still repairable via the error-text taxonomy,
 * just without structural contract checks.
 */
export const TOOL_CONTRACTS: Record<string, ToolContract> = {
	read: { name: "read", required: ["path"], fields: { path: "string", offset: "number", limit: "number" } },
	edit: {
		name: "edit",
		required: ["path", "oldText", "newText"],
		fields: { path: "string", oldText: "string", newText: "string" },
	},
	grep: {
		name: "grep",
		required: ["pattern"],
		fields: {
			pattern: "string",
			path: "string",
			glob: "string",
			ignoreCase: "boolean",
			literal: "boolean",
			context: "number",
			limit: "number",
		},
	},
	find: { name: "find", required: ["pattern"], fields: { pattern: "string", path: "string", limit: "number" } },
	bash: { name: "bash", required: ["command"], fields: { command: "string", timeout: "integer" } },
};

// --- 1. Failure classification (regex taxonomy) ------------------------------

export interface ClassifierPattern {
	id: string;
	source: "errorText" | "rawArgs";
	pattern: RegExp;
	class: "transient" | "syntax-repairable" | "semantic";
}

/**
 * Documented pattern table. Every id is specced in
 * specs/api/components/schemas/tool-repair.yaml (FailureClassification.matchedPattern)
 * and exercised row-by-row in tests/unit/tool-call-repair.test.mjs and
 * specs/features/tool-call-repair/classification.feature.
 *
 * Order WITHIN each group is the check order; groups are checked in the
 * classifier precedence documented in the module header.
 */
export const CLASSIFIER_PATTERNS: ClassifierPattern[] = [
	// Transient (transport) — checked first: a cheap retry outranks an LLM call.
	{ id: "transient:errno", source: "errorText", pattern: /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH|EAI_AGAIN)\b/i, class: "transient" },
	{ id: "transient:timeout", source: "errorText", pattern: /\b(?:timed?\s?out|timeout)\b/i, class: "transient" },
	{ id: "transient:connection", source: "errorText", pattern: /\bconnection\s+(?:reset|refused|failed)\b|\bconnect\s+failed\b/i, class: "transient" },
	{ id: "transient:rate-limit", source: "errorText", pattern: /\b429\b|\brate[ -]?limit(?:ed)?\b|\btoo many requests\b/i, class: "transient" },
	// Syntax (error-text) — JSON unparseable / contract-shape violations.
	{ id: "syntax:unexpected-token", source: "errorText", pattern: /unexpected\s+(?:end\s+of\s+(?:json\s+)?input|token)/i, class: "syntax-repairable" },
	{ id: "syntax:unterminated-string", source: "errorText", pattern: /unterminated\s+(?:string|literal)/i, class: "syntax-repairable" },
	{ id: "syntax:invalid-json", source: "errorText", pattern: /invalid\s+json|json\s+parse\s+(?:error|failed)|failed\s+to\s+parse\s+json/i, class: "syntax-repairable" },
	{ id: "syntax:missing-required", source: "errorText", pattern: /missing\s+required\s+propert|must\s+have\s+required\s+propert/i, class: "syntax-repairable" },
	{ id: "syntax:additional-prop", source: "errorText", pattern: /must\s+not\s+have\s+additional\s+propert|additional\s+propert|unknown\s+propert|unrecognized\s+propert/i, class: "syntax-repairable" },
	{ id: "syntax:type-mismatch", source: "errorText", pattern: /must\s+be\s+(?:of\s+type\s+|an?\s+)?(?:string|number|integer|boolean|array|object)\b|expected\s+.{0,20}\b(?:array|object)\b/i, class: "syntax-repairable" },
	// Semantic (valid syntax, wrong meaning) — NEVER repaired.
	{ id: "semantic:file-not-found", source: "errorText", pattern: /\bENOENT\b|no\s+such\s+file|file\s+not\s+found/i, class: "semantic" },
	{ id: "semantic:command-not-found", source: "errorText", pattern: /command\s+not\s+found|is\s+not\s+recognized\s+as\s+an?\s+internal/i, class: "semantic" },
	{ id: "semantic:exit-code", source: "errorText", pattern: /(?:exit(?:ed)?(?:\s+with)?\s+(?:non-?zero\s+)?(?:exit\s+)?code\s+[1-9]\d*|non-?zero\s+exit)/i, class: "semantic" },
];

export interface FailureClassification {
	class: "syntax-repairable" | "semantic" | "transient";
	matchedPattern: string;
	evidence: string;
}

/** Strict JSON.parse that only accepts a plain object. */
function parseObject(text: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// fall through
	}
	return undefined;
}

/** True when rawArgs is object-shaped text but not strictly parseable JSON. */
function isUnbalancedJson(rawArgs: string): boolean {
	const text = String(rawArgs ?? "").trim();
	if (!text.startsWith("{")) return false;
	return parseObject(text) === undefined;
}

/**
 * Structural contract checks over parsed rawArgs.
 * Returns a matched pattern id or undefined.
 */
function contractViolation(
	args: Record<string, unknown>,
	contract: ToolContract | undefined,
): { id: string; evidence: string } | undefined {
	if (!contract) return undefined;
	const required = contract.required ?? [];
	const fields = contract.fields ?? {};
	for (const field of required) {
		if (args[field] === undefined) return { id: "contract:missing-required", evidence: field };
	}
	for (const key of Object.keys(args)) {
		if (!(key in fields)) return { id: "contract:unknown-field", evidence: key };
	}
	for (const [key, value] of Object.entries(args)) {
		if (!matchesType(value, fields[key])) {
			return { id: "contract:type-mismatch", evidence: `${key} should be ${fields[key]}` };
		}
	}
	return undefined;
}

/**
 * Classify a failed tool call: (toolName, rawArgs, errorText) -> FailureClassification.
 * @param contract optional ToolContract {name, required[], fields{type}}
 */
export function classifyFailure(
	toolName: string,
	rawArgs: string,
	errorText: string,
	contract?: ToolContract,
): FailureClassification {
	const error = String(errorText ?? "");
	const raw = String(rawArgs ?? "");

	// (1) transient transport signals win over everything.
	for (const p of CLASSIFIER_PATTERNS.filter((p) => p.class === "transient")) {
		const m = p.pattern.exec(error);
		if (m) return { class: "transient", matchedPattern: p.id, evidence: m[0] };
	}

	// (2) structural checks over rawArgs.
	if (isUnbalancedJson(raw)) {
		return { class: "syntax-repairable", matchedPattern: "args:unbalanced-json", evidence: raw.slice(0, 80) };
	}
	const parsed = raw.trim().startsWith("{") ? parseObject(raw) : undefined;
	if (parsed) {
		const violation = contractViolation(parsed, contract);
		if (violation) {
			return { class: "syntax-repairable", matchedPattern: violation.id, evidence: violation.evidence };
		}
	}

	// (3) syntax error-text patterns, then (4) semantic error-text patterns.
	for (const group of ["syntax-repairable", "semantic"] as const) {
		for (const p of CLASSIFIER_PATTERNS.filter((p) => p.class === group)) {
			const m = p.pattern.exec(error);
			if (m) return { class: p.class, matchedPattern: p.id, evidence: m[0] };
		}
	}

	// (5) default: valid-looking args, no syntax signal — wrong meaning.
	return { class: "semantic", matchedPattern: "semantic:default", evidence: error.slice(0, 80) };
}

// --- 2. Isolated repair context ----------------------------------------------

export interface RepairContext {
	system: string;
	user: string;
	bytes: number;
}

function byteLength(text: string): number {
	return typeof Buffer !== "undefined" ? Buffer.byteLength(text, "utf8") : text.length;
}

/**
 * Build the isolated repair context: fixer system prompt + tool contract
 * summary + verbatim rawArgs + failure classification — NOTHING else (no
 * session history, no other tools). Throws when the context would exceed
 * REPAIR_CONTEXT_BYTE_BUDGET.
 */
export function buildRepairContext(
	toolName: string,
	contract: ToolContract | undefined,
	rawArgs: string,
	classification: FailureClassification,
): RepairContext {
	const user = [
		`TOOL: ${toolName}`,
		`TOOL CONTRACT (JSON): ${JSON.stringify(contract)}`,
		`FAILURE CLASSIFICATION (JSON): ${JSON.stringify(classification)}`,
		"FAILED ARGUMENTS (verbatim):",
		"--- BEGIN FAILED ARGUMENTS ---",
		String(rawArgs),
		"--- END FAILED ARGUMENTS ---",
		"",
		"Rewrite the failed arguments as ONE strict JSON object satisfying the contract.",
		"Preserve the call's intent verbatim; fix ONLY syntax/structure.",
		"Output STRICT JSON only: no prose, no markdown fences, no explanation.",
	].join("\n");
	const context: RepairContext = { system: FIXER_SYSTEM_PROMPT, user, bytes: 0 };
	context.bytes = byteLength(context.system) + byteLength(context.user);
	if (context.bytes > REPAIR_CONTEXT_BYTE_BUDGET) {
		throw new Error(
			`repair context is ${context.bytes} bytes, over the ${REPAIR_CONTEXT_BYTE_BUDGET}-byte budget ` +
				"(failed rawArgs too large for isolated repair; surface the original error instead)",
		);
	}
	return context;
}

// --- 3. Strict-JSON-only extraction -------------------------------------------

export interface ExtractionResult {
	ok: boolean;
	args?: Record<string, unknown>;
	error?: string;
}

/**
 * Extract repaired args from the fixer reply, STRICT mode: the whole reply
 * must be exactly one JSON object, optionally inside one ```json fence.
 * Brace balancing tolerates truncation (same spirit as parser.ts); prose
 * around the object, trailing junk, or non-object JSON reject. Returns
 * {ok:true, args} or {ok:false, error}.
 */
export function extractRepairedArgs(replyText: string): ExtractionResult {
	const text = String(replyText ?? "").trim();
	if (!text) return { ok: false, error: "empty-reply" };

	let body = text;
	if (text.startsWith("```")) {
		const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)```[ \t]*$/.exec(text);
		if (!fence) return { ok: false, error: "prose-around-fence" };
		body = fence[1].trim();
	}
	if (!body.startsWith("{")) return { ok: false, error: "no-json-object" };

	// Scan for the first balanced object; tolerate unclosed strings/braces by
	// closing them (truncated fixer output), but reject anything after the
	// balanced close other than whitespace.
	let open = 0;
	let inString = false;
	let escaped = false;
	let closeAt = -1;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "\\" && !escaped) {
			escaped = true;
			continue;
		}
		if (ch === '"' && !escaped) {
			inString = !inString;
		} else if (!inString) {
			if (ch === "{") open++;
			else if (ch === "}") {
				open--;
				if (open === 0 && closeAt === -1) closeAt = i + 1;
			}
		}
		escaped = false;
	}
	let candidate = closeAt !== -1 ? body.slice(0, closeAt) : body;
	if (closeAt !== -1 && body.slice(closeAt).trim() !== "") {
		return { ok: false, error: "trailing-content" };
	}
	if (inString) candidate += '"';
	while (open > 0) {
		candidate += "}";
		open--;
	}
	const args = parseObject(candidate);
	if (!args) return { ok: false, error: "invalid-json" };
	return { ok: true, args };
}

// --- 4. Contract validation -----------------------------------------------------

function matchesType(value: unknown, type: string | undefined): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return true; // unknown declared types are not enforced here
	}
}

export interface ValidationResult {
	ok: boolean;
	errors: string[];
}

/**
 * Validate repaired args against a ToolContract: required present, no
 * unknown fields, primitive types match (incl. string-where-array/object).
 * Returns {ok, errors[]}.
 */
export function validateAgainstContract(args: unknown, contract: ToolContract | undefined): ValidationResult {
	const errors: string[] = [];
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return { ok: false, errors: ["args-not-object"] };
	}
	const record = args as Record<string, unknown>;
	const required = contract?.required ?? [];
	const fields = contract?.fields ?? {};
	for (const field of required) {
		if (record[field] === undefined) errors.push(`missing-required:${field}`);
	}
	for (const key of Object.keys(record)) {
		if (!(key in fields)) errors.push(`unknown-field:${key}`);
	}
	for (const [key, value] of Object.entries(record)) {
		if (key in fields && !matchesType(value, fields[key])) {
			errors.push(`type-mismatch:${key}:expected-${fields[key]}`);
		}
	}
	return { ok: errors.length === 0, errors };
}

// --- 5. Guardrail state machine ---------------------------------------------------

export interface RepairState {
	phase: "idle" | "repairing" | "transient-waiting" | "accepted" | "exhausted" | "rejected";
	callId: string | null;
	attemptsThisCall: number;
	repairCallsThisTurn: number;
	wrapfixThisTurn: number;
	delegateThisTurn: number;
	inRepairContext: boolean;
	backoffMs: number | null;
	reason: string | null;
}

/**
 * State: per-call attempts, per-turn repair calls, wrapfix/delegate counters
 * (tracked for audit composition, never gating repair), inRepairContext
 * (repair calls never recurse), backoffMs for the transient shim.
 */
export function initialRepairState(): RepairState {
	return {
		phase: "idle", // idle | repairing | transient-waiting | accepted | exhausted | rejected
		callId: null,
		attemptsThisCall: 0,
		repairCallsThisTurn: 0,
		wrapfixThisTurn: 0,
		delegateThisTurn: 0,
		inRepairContext: false,
		backoffMs: null,
		reason: null,
	};
}

/**
 * Policy check mirroring the guardrails-retries.feature counter matrix:
 * may a repair attempt be started? Wrapfix (2/turn) and delegate (8/turn)
 * usage is deliberately NOT an input — the counters compose, never conflate.
 */
export function canStartRepair(state: RepairState, attempt: number): boolean {
	if (attempt < 1 || attempt > MAX_REPAIR_ATTEMPTS_PER_CALL) return false;
	return state.repairCallsThisTurn < MAX_REPAIR_CALLS_PER_TURN;
}

/**
 * advance(state, event) — pure transition over the repair state machine.
 * Events:
 *   {type:"tool_failed", classification, callId?}   (a new callId resets attemptsThisCall)
 *   {type:"repair_attempt_finished", accepted, reclassification?, errorText?}
 *   {type:"transient_retry_finished", recovered}
 *   {type:"enter_repair_context"} / {type:"exit_repair_context"}
 *   {type:"wrapfix_converted"} / {type:"delegate_called"}
 *   {type:"turn_reset"}
 */
export function advance(state: RepairState, event: Record<string, unknown>): RepairState {
	const s: RepairState = { ...state };
	switch (event.type) {
		case "turn_reset":
			return initialRepairState();
		case "wrapfix_converted":
			s.wrapfixThisTurn += 1;
			return s;
		case "delegate_called":
			s.delegateThisTurn += 1;
			return s;
		case "enter_repair_context":
			s.inRepairContext = true;
			return s;
		case "exit_repair_context":
			s.inRepairContext = false;
			return s;
		case "tool_failed": {
			if (s.inRepairContext) {
				s.phase = "rejected";
				s.reason = "no-recursion"; // a repair call's own failure is never re-repaired
				return s;
			}
			// A NEW failed call starts a fresh per-call attempt budget; the
			// per-turn repair-call counter deliberately carries over.
			const callId = event.callId as string | undefined;
			if (callId !== undefined && callId !== s.callId) {
				s.callId = callId;
				s.attemptsThisCall = 0;
			}
			const cls = (event.classification as FailureClassification | undefined)?.class;
			if (cls === "transient") {
				if (s.attemptsThisCall >= BACKOFF_MS_TRANSIENT.length) {
					s.phase = "exhausted";
					s.reason = "transient-backoff-exhausted";
					return s;
				}
				s.phase = "transient-waiting";
				s.backoffMs = BACKOFF_MS_TRANSIENT[s.attemptsThisCall];
				s.attemptsThisCall += 1;
				return s;
			}
			if (cls === "semantic") {
				s.phase = "rejected";
				s.reason = "non-syntax";
				return s;
			}
			// syntax-repairable
			if (!canStartRepair(s, s.attemptsThisCall + 1)) {
				s.phase = "exhausted";
				s.reason = s.attemptsThisCall + 1 > MAX_REPAIR_ATTEMPTS_PER_CALL ? "max-attempts" : "per-turn-cap";
				return s;
			}
			s.phase = "repairing";
			s.attemptsThisCall += 1;
			s.repairCallsThisTurn += 1;
			return s;
		}
		case "repair_attempt_finished": {
			if (s.phase !== "repairing") return s;
			if (event.accepted) {
				s.phase = "accepted";
				return s;
			}
			const reclass = (event.reclassification as FailureClassification | undefined)?.class;
			if (reclass === "semantic") {
				s.phase = "rejected";
				s.reason = "reclassified-semantic";
				return s;
			}
			if (reclass === "transient") {
				if (s.attemptsThisCall >= BACKOFF_MS_TRANSIENT.length) {
					s.phase = "exhausted";
					s.reason = "transient-backoff-exhausted";
					return s;
				}
				s.phase = "transient-waiting";
				s.backoffMs = BACKOFF_MS_TRANSIENT[s.attemptsThisCall];
				s.attemptsThisCall += 1;
				return s;
			}
			if (!canStartRepair(s, s.attemptsThisCall + 1)) {
				s.phase = "exhausted";
				s.reason = s.attemptsThisCall + 1 > MAX_REPAIR_ATTEMPTS_PER_CALL ? "max-attempts" : "per-turn-cap";
				return s;
			}
			s.attemptsThisCall += 1;
			s.repairCallsThisTurn += 1;
			return s; // stays "repairing"
		}
		case "transient_retry_finished": {
			if (event.recovered) {
				s.phase = "accepted";
				return s;
			}
			if (s.attemptsThisCall >= BACKOFF_MS_TRANSIENT.length) {
				s.phase = "exhausted";
				s.reason = "transient-backoff-exhausted";
				return s;
			}
			s.phase = "transient-waiting";
			s.backoffMs = BACKOFF_MS_TRANSIENT[s.attemptsThisCall];
			s.attemptsThisCall += 1;
			return s;
		}
		default:
			return s;
	}
}

// --- 6. Fixer client (one small isolated Ollama /api/chat call) ----------------

/**
 * Map the configured tiny model ref to the bare model id Ollama's /api/chat
 * expects. TINY_PROVIDER ("ollama-mini") is pi-mini's internal provider name
 * and must never reach Ollama; some persisted configs also store the
 * formatRef ("provider/modelId") form, so that prefix is stripped too.
 */
export function fixerModelId(cfg: PiMiniConfig): string {
	const ref = cfg.tiny;
	let id = ref.modelId;
	if (id.startsWith(`${ref.provider}/`)) id = id.slice(ref.provider.length + 1);
	if (ref.provider === TINY_PROVIDER) id = id.replace(new RegExp(`^${TINY_PROVIDER}/`), "");
	return id;
}

export interface FixerRequest {
	system: string;
	user: string;
}

export interface FixerReply {
	replyText: string;
	durationMs: number;
}

interface OllamaChatResponse {
	message?: { role?: string; content?: string };
	done?: boolean;
}

/**
 * One isolated repair call against the tiny model. Mirrors ollama-native.ts's
 * native /api/chat request shape: top-level `think: false` (honored only on
 * the native endpoint), num_ctx/num_predict pinned small under `options`,
 * stream:false, and a 90s AbortController stall watchdog. Injectable fetch
 * for tests.
 */
export async function runFixer(
	cfg: PiMiniConfig,
	request: FixerRequest,
	opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number },
): Promise<FixerReply> {
	const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
	const timeoutMs = opts?.timeoutMs ?? REPAIR_STALL_TIMEOUT_MS;
	const now = opts?.now ?? Date.now;
	const baseUrl = OLLAMA_BASE_URL.replace(/\/+$/, "");
	const body: Record<string, unknown> = {
		model: fixerModelId(cfg),
		messages: [
			{ role: "system", content: request.system },
			{ role: "user", content: request.user },
		],
		stream: false,
		think: false,
		options: { num_ctx: REPAIR_NUM_CTX, num_predict: REPAIR_NUM_PREDICT_MAX },
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const started = now();
	try {
		const response = await fetchImpl(`${baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).slice(0, 300);
			throw new Error(`Ollama /api/chat ${response.status}: ${detail}`);
		}
		const data = (await response.json()) as OllamaChatResponse;
		const replyText = typeof data?.message?.content === "string" ? data.message.content : "";
		return { replyText, durationMs: now() - started };
	} finally {
		clearTimeout(timer);
	}
}

// --- 7. Orchestrator ------------------------------------------------------------

/** Minimal structural view of pi's ToolResultEvent (see @earendil-works/pi-coding-agent). */
export interface ToolResultLike {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	content: { type: string; text?: string }[];
	isError: boolean;
}

/** The pi ToolResultEventResult override shape this module returns. */
export interface RepairOverride {
	content: { type: "text"; text: string }[];
	isError: boolean;
}

export interface RepairToolResultDeps {
	cfg: PiMiniConfig;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export interface RepairAttemptRecord {
	attempt: number;
	maxAttempts: number;
	request: { system: string; user: string };
	response: { replyText: string; extraction: ExtractionResult; validation: ValidationResult };
	durationMs: number;
}

export type RepairFinalStatus = "repaired" | "exhausted" | "rejected-non-syntax";

export interface RepairLogRecord {
	ts: string;
	turn: number;
	toolName: string;
	classification: FailureClassification;
	attempts: RepairAttemptRecord[];
	finalStatus: RepairFinalStatus;
	originalError: string;
	finalError?: string;
}

// --- Per-turn budget (module-level, reset externally) ----------------------------

interface TurnCounters {
	turn: number;
	repairCallsThisTurn: number;
}

const turnCounters: TurnCounters = { turn: 1, repairCallsThisTurn: 0 };

/**
 * Reset the per-turn repair budget. Called by installRepair's "input" handler
 * on interactive/rpc user input (each user input starts a new turn, so the
 * 1-based turn number advances) and available externally for tests.
 */
export function resetTurnCounters(): void {
	turnCounters.turn += 1;
	turnCounters.repairCallsThisTurn = 0;
}

/** True while another repair /api/chat call may be started this turn. */
export function checkTurnBudget(cfg: PiMiniConfig): boolean {
	return turnCounters.repairCallsThisTurn < (cfg.repairMaxPerTurn ?? MAX_REPAIR_CALLS_PER_TURN);
}

/** Current 1-based user-turn number (for log records). */
export function currentTurn(): number {
	return turnCounters.turn;
}

// --- Evidence log (.pi/mini/tool-repairs.jsonl) -----------------------------------

/** Append-only JSONL log path; overridable via env for tests. */
export function repairLogPath(): string {
	return process.env.PI_MINI_REPAIR_LOG ?? path.join(os.homedir(), ".pi", "mini", "tool-repairs.jsonl");
}

/** Append one RepairLogRecord (JSONL, best effort — never throws into the loop). */
export function logRepair(record: RepairLogRecord): void {
	try {
		fs.mkdirSync(path.dirname(repairLogPath()), { recursive: true });
		fs.appendFileSync(repairLogPath(), `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// best effort evidence logging; never break the tool loop
	}
}

// --- REISSUE notice ------------------------------------------------------------

const REISSUE_MARKER = "TOOL_CALL_SYNTAX_REPAIRED";
const EXHAUSTED_MARKER = "TOOL_CALL_REPAIR_EXHAUSTED";

/**
 * Compact REISSUE notice (<300 chars of scaffolding) replacing the tool_result
 * content on a successful repair. pi extensions cannot execute built-in tools,
 * so the model re-issues the corrected call on its next turn (see module
 * header). The JSON is emitted compact and must be re-issued verbatim.
 */
export function buildReissueNotice(toolName: string, args: Record<string, unknown>): string {
	return [
		REISSUE_MARKER,
		`tool: ${toolName}`,
		"re-issue this call verbatim with these corrected arguments:",
		"```json",
		JSON.stringify(args),
		"```",
		"do not modify the arguments.",
	].join("\n");
}

/** Exhaustion notice: original error plus the last repair error (no silent drop). */
export function buildExhaustedNotice(originalError: string, lastRepairError: string): string {
	return [
		EXHAUSTED_MARKER,
		`original error: ${originalError}`,
		`last repair error: ${lastRepairError}`,
	].join("\n");
}

function eventErrorText(event: ToolResultLike): string {
	return event.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

/**
 * Async pure-ish orchestrator over one failed tool_result event.
 *
 * - classification is semantic/transient (or the event is not an error) ->
 *   returns undefined: pass through untouched, ZERO LLM involvement.
 * - the per-turn budget is spent -> returns undefined: the pending repair is
 *   not started and the failure surfaces as-is (spec RetryPolicy).
 * - syntax-repairable -> up to cfg.repairMaxAttemptsPerCall isolated fixer
 *   calls; on acceptance returns the REISSUE-notice override (isError stays
 *   true); on exhaustion returns the original error + last repair error.
 * - every closed loop is appended to the JSONL evidence log.
 */
export async function repairToolResult(
	event: ToolResultLike,
	deps: RepairToolResultDeps,
): Promise<RepairOverride | undefined> {
	if (!event.isError) return undefined;
	const cfg = deps.cfg;
	const now = deps.now ?? Date.now;
	const rawArgs = JSON.stringify(event.input ?? {});
	const errorText = eventErrorText(event);
	const contract = TOOL_CONTRACTS[event.toolName];
	const classification = classifyFailure(event.toolName, rawArgs, errorText, contract);

	if (classification.class !== "syntax-repairable") {
		// Semantic (wrong meaning) and transient (transport) failures never
		// reach the fixer; the original tool_result stands untouched.
		logRepair({
			ts: new Date(now()).toISOString(),
			turn: currentTurn(),
			toolName: event.toolName,
			classification,
			attempts: [],
			finalStatus: "rejected-non-syntax",
			originalError: errorText,
		});
		return undefined;
	}

	if (!checkTurnBudget(cfg)) {
		// Per-turn repair cap reached: not started, failure surfaces as-is.
		return undefined;
	}

	const maxAttempts = cfg.repairMaxAttemptsPerCall ?? MAX_REPAIR_ATTEMPTS_PER_CALL;
	const attempts: RepairAttemptRecord[] = [];
	let context: RepairContext;
	try {
		context = buildRepairContext(event.toolName, contract, rawArgs, classification);
	} catch (error) {
		// rawArgs too large for the isolated context: surface original + reason.
		const reason = error instanceof Error ? error.message : String(error);
		logRepair({
			ts: new Date(now()).toISOString(),
			turn: currentTurn(),
			toolName: event.toolName,
			classification,
			attempts: [],
			finalStatus: "exhausted",
			originalError: errorText,
			finalError: reason,
		});
		return { content: [{ type: "text", text: buildExhaustedNotice(errorText, reason) }], isError: true };
	}

	let lastRepairError = "no repair attempt";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		turnCounters.repairCallsThisTurn += 1;
		let replyText = "";
		let durationMs = 0;
		try {
			const reply = await runFixer(cfg, context, { fetchImpl: deps.fetchImpl, now });
			replyText = reply.replyText;
			durationMs = reply.durationMs;
		} catch (error) {
			lastRepairError = error instanceof Error ? error.message : String(error);
			attempts.push({
				attempt,
				maxAttempts,
				request: { system: context.system, user: context.user },
				response: { replyText: "", extraction: { ok: false, error: "fixer-request-failed" }, validation: { ok: false, errors: [] } },
				durationMs: 0,
			});
			break; // transport failure: retrying the fixer immediately is not useful
		}
		const extraction = extractRepairedArgs(replyText);
		const validation = extraction.ok && extraction.args ? validateAgainstContract(extraction.args, contract) : { ok: false, errors: [] };
		attempts.push({ attempt, maxAttempts, request: { system: context.system, user: context.user }, response: { replyText, extraction, validation }, durationMs });
		if (extraction.ok && extraction.args && validation.ok) {
			logRepair({
				ts: new Date(now()).toISOString(),
				turn: currentTurn(),
				toolName: event.toolName,
				classification,
				attempts,
				finalStatus: "repaired",
				originalError: errorText,
			});
			// PI-API BOUND: no extension can execute a built-in tool, so the
			// repaired call comes back as a REISSUE notice the model re-issues.
			return { content: [{ type: "text", text: buildReissueNotice(event.toolName, extraction.args) }], isError: true };
		}
		lastRepairError = extraction.ok ? `validation failed: ${validation.errors.join(", ")}` : `extraction failed: ${extraction.error}`;
	}

	logRepair({
		ts: new Date(now()).toISOString(),
		turn: currentTurn(),
		toolName: event.toolName,
		classification,
		attempts,
		finalStatus: "exhausted",
		originalError: errorText,
		finalError: lastRepairError,
	});
	return { content: [{ type: "text", text: buildExhaustedNotice(errorText, lastRepairError) }], isError: true };
}

// --- 8. pi extension wiring ------------------------------------------------------

export interface InstallRepairOpts {
	/** Gate: only act while mini mode (or equivalent) is enabled. */
	isEnabled: () => boolean;
	/** Fresh config snapshot per event (repair budgets come from cfg). */
	getConfig: () => PiMiniConfig;
	/** Injectable fetch (tests); defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Register the repair loop on pi's extension API:
 *   pi.on("tool_result") — for failed tool results, run the bounded repair
 *     loop and, when it produces an override, return the ToolResultEventResult
 *     partial ({ content, isError }) so pi rewrites the tool result the model
 *     sees. Non-syntax failures return undefined (event passes through).
 *   pi.on("input") — reset the per-turn repair budget on interactive/rpc user
 *     input (extension-sourced input does not start a new user turn).
 *
 * `ctx` is accepted for symmetry with pi's extension factory style; the loop
 * needs nothing from it (fetch is global, config comes via getConfig()).
 */
export function installRepair(pi: ExtensionAPI, _ctx: ExtensionContext, opts: InstallRepairOpts): void {
	pi.on("tool_result", async (event) => {
		if (!opts.isEnabled()) return undefined;
		if (!event.isError) return undefined;
		return repairToolResult(event, { cfg: opts.getConfig(), fetchImpl: opts.fetchImpl });
	});
	pi.on("input", (event) => {
		if (event.source === "interactive" || event.source === "rpc") {
			resetTurnCounters();
		}
		return undefined;
	});
}
