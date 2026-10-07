// Pure reference functions for the tool-call syntax-failure repair loop
// (specs/features/tool-call-repair/*.feature). This is the POST-execution
// complement to the stream-level wrap-fix in wrapfix.ts: a tool call that
// RAN and FAILED on syntax is extracted into an isolated repair context,
// the reply is extracted with strict-JSON-only parsing, validated against
// the tool's argument contract, and re-executed — bounded, never infinite.
//
// SPEC DECISIONS EMBODIED HERE (see also
// specs/api/components/schemas/tool-repair.yaml):
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
//   * advance() is the guardrail state machine: per-call attempts (2),
//     per-turn repair calls (2, INDEPENDENT of wrapfix 2/turn and delegate
//     8/turn), transient bounded backoff with zero LLM involvement, no
//     recursion from inside a repair context.

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

// --- 1. Failure classification (regex taxonomy) ------------------------------

/**
 * Documented pattern table. Every id is specced in
 * specs/api/components/schemas/tool-repair.yaml (FailureClassification.matchedPattern)
 * and exercised row-by-row in tests/unit/tool-call-repair.test.mjs and
 * specs/features/tool-call-repair/classification.feature.
 *
 * Order WITHIN each group is the check order; groups are checked in the
 * classifier precedence documented above.
 */
export const CLASSIFIER_PATTERNS = [
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

/** Strict JSON.parse that only accepts a plain object. */
function parseObject(text) {
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch {
		// fall through
	}
	return undefined;
}

/** True when rawArgs is object-shaped text but not strictly parseable JSON. */
function isUnbalancedJson(rawArgs) {
	const text = String(rawArgs ?? "").trim();
	if (!text.startsWith("{")) return false;
	return parseObject(text) === undefined;
}

/**
 * Structural contract checks over parsed rawArgs.
 * Returns a matched pattern id or undefined.
 */
function contractViolation(args, contract) {
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
 * @param {string} toolName
 * @param {string} rawArgs raw arguments verbatim (may be truncated/unbalanced)
 * @param {string} errorText execution error verbatim
 * @param {object} [contract] optional ToolContract {name, required[], fields{type}}
 */
export function classifyFailure(toolName, rawArgs, errorText, contract) {
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
	for (const group of ["syntax-repairable", "semantic"]) {
		for (const p of CLASSIFIER_PATTERNS.filter((p) => p.class === group)) {
			const m = p.pattern.exec(error);
			if (m) return { class: p.class, matchedPattern: p.id, evidence: m[0] };
		}
	}

	// (5) default: valid-looking args, no syntax signal — wrong meaning.
	return { class: "semantic", matchedPattern: "semantic:default", evidence: error.slice(0, 80) };
}

// --- 2. Isolated repair context ----------------------------------------------

/**
 * Build the isolated repair context: fixer system prompt + tool contract
 * summary + verbatim rawArgs + failure classification — NOTHING else (no
 * session history, no other tools). Throws when the context would exceed
 * REPAIR_CONTEXT_BYTE_BUDGET.
 */
export function buildRepairContext(toolName, contract, rawArgs, classification) {
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
	const context = { system: FIXER_SYSTEM_PROMPT, user };
	context.bytes = byteLength(context.system) + byteLength(context.user);
	if (context.bytes > REPAIR_CONTEXT_BYTE_BUDGET) {
		throw new Error(
			`repair context is ${context.bytes} bytes, over the ${REPAIR_CONTEXT_BYTE_BUDGET}-byte budget ` +
				"(failed rawArgs too large for isolated repair; surface the original error instead)",
		);
	}
	return context;
}

function byteLength(text) {
	return typeof Buffer !== "undefined" ? Buffer.byteLength(text, "utf8") : text.length;
}

// --- 3. Strict-JSON-only extraction -------------------------------------------

/**
 * Extract repaired args from the fixer reply, STRICT mode: the whole reply
 * must be exactly one JSON object, optionally inside one ```json fence.
 * Brace balancing tolerates truncation (same spirit as parser.ts); prose
 * around the object, trailing junk, or non-object JSON reject. Returns
 * {ok:true, args} or {ok:false, error}.
 */
export function extractRepairedArgs(replyText) {
	let text = String(replyText ?? "").trim();
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

function matchesType(value, type) {
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

/**
 * Validate repaired args against a ToolContract: required present, no
 * unknown fields, primitive types match (incl. string-where-array/object).
 * Returns {ok, errors[]}.
 */
export function validateAgainstContract(args, contract) {
	const errors = [];
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return { ok: false, errors: ["args-not-object"] };
	}
	const required = contract?.required ?? [];
	const fields = contract?.fields ?? {};
	for (const field of required) {
		if (args[field] === undefined) errors.push(`missing-required:${field}`);
	}
	for (const key of Object.keys(args)) {
		if (!(key in fields)) errors.push(`unknown-field:${key}`);
	}
	for (const [key, value] of Object.entries(args)) {
		if (key in fields && !matchesType(value, fields[key])) {
			errors.push(`type-mismatch:${key}:expected-${fields[key]}`);
		}
	}
	return { ok: errors.length === 0, errors };
}

// --- 5. Guardrail state machine ---------------------------------------------------

/**
 * State: per-call attempts, per-turn repair calls, wrapfix/delegate counters
 * (tracked for audit composition, never gating repair), inRepairContext
 * (repair calls never recurse), backoffMs for the transient shim.
 */
export function initialRepairState() {
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
export function canStartRepair(state, attempt) {
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
export function advance(state, event) {
	const s = { ...state };
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
			if (event.callId !== undefined && event.callId !== s.callId) {
				s.callId = event.callId;
				s.attemptsThisCall = 0;
			}
			const cls = event.classification?.class;
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
			const reclass = event.reclassification?.class;
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
