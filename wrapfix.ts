// Repair layer for text-wrapped / truncated tool calls emitted by small models.
// When a model drops out of native tool-call mode it typically writes the call
// as a fenced (or bare) JSON object like {"name": "...", "arguments": {...}},
// sometimes truncated mid-string or wrapped ChatML-style. Everything here is
// built on the tolerant-JSON core shared with parser.ts (balanceJsonBraces).

import { balanceJsonBraces, parseTolerantJson } from "./parser.ts";

export interface WrappedToolCall {
	/** Canonical tool name, normalized against the known-tool set. */
	name: string;
	/** Repaired arguments object ({} when the call carried none). */
	arguments: Record<string, unknown>;
	/** Span of the wrapped call in the source text, for display cleanup. */
	start: number;
	end: number;
}

const FENCED_BLOCK_RE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;
const FENCE_OPEN_RE = /```(?:json)?[ \t]*\r?\n?/gi;
const BARE_CALL_RE = /\{\s*"(?:name|tool|tool_name|function)"\s*:/i;
const NAME_KEYS = ["name", "tool", "tool_name"];
const ARGS_KEYS = ["arguments", "args", "parameters", "input"];
const WRAPPER_KEYS = ["function", ...ARGS_KEYS];
const MAX_DETECT_ATTEMPTS = 5;

/**
 * Tolerant repair of a tool-call arguments string: trims to the first balanced
 * JSON object (closing truncated strings/braces and cutting trailing junk).
 * Returns undefined when nothing object-shaped can be recovered.
 */
export function repairArgs(raw: string): Record<string, unknown> | undefined {
	const cleaned = balanceJsonBraces(raw);
	if (!cleaned) return undefined;
	try {
		const parsed: unknown = JSON.parse(cleaned);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Match a model-emitted tool name against the known tools (exact, then case-insensitive). */
function canonicalTool(name: string, knownTools: ReadonlySet<string>): string | undefined {
	if (knownTools.has(name)) return name;
	const lower = name.toLowerCase();
	for (const tool of knownTools) {
		if (tool.toLowerCase() === lower) return tool;
	}
	return undefined;
}

interface ParsedCall {
	name: string;
	args: Record<string, unknown>;
}

/** Extract a call from one parsed JSON object, following ChatML/OpenAI-style wrappers. */
function callFromObject(
	obj: Record<string, unknown> | undefined,
	knownTools: ReadonlySet<string>,
	depth = 0,
): ParsedCall | undefined {
	if (!obj) return undefined;

	for (const key of NAME_KEYS) {
		const value = obj[key];
		if (typeof value !== "string") continue;
		const name = canonicalTool(value, knownTools);
		if (!name) return undefined; // named an unknown tool: not a call we can repair
		let args: Record<string, unknown> = {};
		for (const argsKey of ARGS_KEYS) {
			const raw = obj[argsKey];
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				args = raw as Record<string, unknown>;
				break;
			}
			if (typeof raw === "string") {
				const repaired = repairArgs(raw);
				if (repaired) {
					args = repaired;
					break;
				}
			}
		}
		return { name, args };
	}

	if (depth < 2) {
		for (const key of WRAPPER_KEYS) {
			const nested = obj[key];
			if (nested && typeof nested === "object" && !Array.isArray(nested)) {
				const call = callFromObject(nested as Record<string, unknown>, knownTools, depth + 1);
				if (call) return call;
			}
		}
		const calls = obj["tool_calls"];
		if (Array.isArray(calls) && calls.length > 0 && calls[0] && typeof calls[0] === "object") {
			return callFromObject(calls[0] as Record<string, unknown>, knownTools, depth + 1);
		}
	}
	return undefined;
}

function toWrapped(call: ParsedCall, start: number, end: number): WrappedToolCall {
	return { name: call.name, arguments: call.args, start, end };
}

/**
 * Detect a text-wrapped tool call in model output. Returns the first call whose
 * name matches a known tool, with the source span it occupies.
 *
 * Scan order mirrors how small models degrade: closed fenced block, whole-message
 * JSON, unclosed (truncated) fence, bare trailing JSON after prose.
 */
export function detectToolCall(text: string, knownTools: ReadonlySet<string>): WrappedToolCall | undefined {
	FENCED_BLOCK_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = FENCED_BLOCK_RE.exec(text)) !== null) {
		const call = callFromObject(parseTolerantJson(match[1] ?? ""), knownTools);
		if (call) {
			return toWrapped(call, match.index, match.index + match[0].length);
		}
	}

	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		const call = callFromObject(parseTolerantJson(trimmed), knownTools);
		if (call) return toWrapped(call, 0, text.length);
	}

	FENCE_OPEN_RE.lastIndex = 0;
	while ((match = FENCE_OPEN_RE.exec(text)) !== null) {
		const body = text.slice(match.index + match[0].length);
		const call = callFromObject(parseTolerantJson(body), knownTools);
		if (call) return toWrapped(call, match.index, text.length);
	}

	const bare = BARE_CALL_RE.exec(text);
	if (bare) {
		const body = text.slice(bare.index);
		const cleaned = balanceJsonBraces(body);
		const call = callFromObject(parseTolerantJson(body), knownTools);
		if (call) {
			const end = cleaned ? Math.min(bare.index + cleaned.length, text.length) : text.length;
			return toWrapped(call, bare.index, end);
		}
	}
	return undefined;
}

/** Remove every detected wrapped tool call from text, keeping surrounding prose. */
export function stripToolCallSpans(text: string, knownTools: ReadonlySet<string>): string {
	let result = text;
	for (let i = 0; i < MAX_DETECT_ATTEMPTS; i++) {
		const call = detectToolCall(result, knownTools);
		if (!call) break;
		result = (result.slice(0, call.start) + result.slice(call.end)).trim();
	}
	return result;
}
