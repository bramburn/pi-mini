// Tolerant extraction of delegate requests from tiny-model text output.
// Small models frequently wrap tool calls in ```json fences, add conversational
// preambles, or truncate JSON mid-string; all of that is repaired here.

export interface DelegateRequest {
	task: string;
}

const FENCED_BLOCK_RE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;
const TASK_KEYS = ["task", "instruction", "prompt", "content", "description", "task_description"];
const NESTED_KEYS = ["arguments", "parameters", "args", "input"];

function parseTolerantJson(raw: string): Record<string, unknown> | undefined {
	let cleaned = raw.trim();
	const firstBrace = cleaned.indexOf("{");
	if (firstBrace === -1) return undefined;
	cleaned = cleaned.slice(firstBrace);

	let open = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < cleaned.length; i++) {
		const ch = cleaned[i];
		if (ch === "\\" && !escaped) {
			escaped = true;
			continue;
		}
		if (ch === '"' && !escaped) {
			inString = !inString;
		} else if (!inString) {
			if (ch === "{") open++;
			else if (ch === "}") open--;
		}
		escaped = false;
	}
	if (inString) cleaned += '"';
	while (open > 0) {
		cleaned += "}";
		open--;
	}

	try {
		const parsed: unknown = JSON.parse(cleaned);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return undefined;
	} catch {
		const match = cleaned.match(/"(?:task|instruction|prompt|content)"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
		if (match) return { task: match[1] };
		return undefined;
	}
}

function cleanTask(raw: string): string {
	return raw
		.replace(/^```[a-z]*\r?\n?/i, "")
		.replace(/\r?\n?```$/i, "")
		.replace(/\\"/g, '"')
		.trim();
}

function taskFromObject(obj: Record<string, unknown>, depth = 0): string | undefined {
	for (const key of TASK_KEYS) {
		const value = obj[key];
		if (typeof value === "string" && value.trim()) return cleanTask(value);
	}
	// ChatML-style tool call: { "name": "delegate", "arguments": { "task": ... } }
	if (depth < 2) {
		for (const key of NESTED_KEYS) {
			const value = obj[key];
			if (value && typeof value === "object" && !Array.isArray(value)) {
				const task = taskFromObject(value as Record<string, unknown>, depth + 1);
				if (task) return task;
			}
		}
	}
	return undefined;
}

export function extractDelegate(text: string): DelegateRequest | undefined {
	let match: RegExpExecArray | null;
	FENCED_BLOCK_RE.lastIndex = 0;
	while ((match = FENCED_BLOCK_RE.exec(text)) !== null) {
		const obj = parseTolerantJson(match[1] ?? "");
		if (!obj) continue;
		const task = taskFromObject(obj);
		if (task) return { task };
	}

	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		const obj = parseTolerantJson(trimmed);
		if (obj) {
			const task = taskFromObject(obj);
			if (task) return { task };
		}
	}

	// Unclosed fence (truncated output): take everything after the opener.
	const fenceOpen = /```(?:json)?[ \t]*\r?\n?/i.exec(text);
	if (fenceOpen) {
		const body = text.slice(fenceOpen.index + fenceOpen[0].length);
		const obj = parseTolerantJson(body);
		if (obj) {
			const task = taskFromObject(obj);
			if (task) return { task };
		}
	}
	return undefined;
}

/** Remove every fenced block that parsed as a delegate request, for display cleanup. */
export function stripDelegateBlocks(text: string): string {
	FENCED_BLOCK_RE.lastIndex = 0;
	return text
		.replace(FENCED_BLOCK_RE, (whole: string, body: string) => {
			const obj = parseTolerantJson(body);
			if (!obj) return whole;
			return taskFromObject(obj) ? "" : whole;
		})
		.trim();
}
