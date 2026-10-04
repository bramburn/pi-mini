// Live harness for pi-mini against a running Ollama with granite4.2:8b.
//
// Ports the lab scenarios through the real ollama-native.ts pipeline:
//   A. multi-step tool loop continuation + clean termination
//   B. wrap-prone output still materializes a real tool call (native or wrap-fix)
//   C. args repair on the captured giant-args truncation shape (deterministic)
//   D. giant-args watchdog: the red-black-tree stall case must terminate
//
// Requests run strictly sequentially (single-slot Ollama server).
// Usage: node scripts/live-test.mjs   (exit 0 = all PASS)

import { ollamaNativeApi } from "../ollama-native.ts";
import { repairArgs } from "../wrapfix.ts";
import { OLLAMA_BASE_URL, TINY_MODEL_ID } from "../settings.ts";

const model = {
	id: TINY_MODEL_ID,
	name: "Granite 4.2 8B (pi-mini orchestrator)",
	api: "ollama-native",
	provider: "ollama-mini",
	baseUrl: OLLAMA_BASE_URL,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131072,
	maxTokens: 8192,
};

const api = ollamaNativeApi({ baseUrl: OLLAMA_BASE_URL, think: false, stallTimeoutMs: 45_000 });

const TOOLS = [
	{
		name: "read_file",
		description: "Read a text file from disk",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "File path" } },
			required: ["path"],
		},
	},
	{
		name: "write_file",
		description: "Write text to a file",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path" },
				content: { type: "string", description: "Full file content" },
			},
			required: ["path", "content"],
		},
	},
];

let failures = 0;

function check(label, ok, detail = "") {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

function fakeExecute(call) {
	if (call.name === "read_file") return { text: "the cat sat on the mat\nthe mat was green", isError: false };
	if (call.name === "write_file") {
		const bytes = typeof call.arguments.content === "string" ? call.arguments.content.length : 0;
		return { text: `wrote ${bytes} bytes to ${call.arguments.path ?? "?"}`, isError: false };
	}
	return { text: `unknown tool ${call.name}`, isError: true };
}

async function callModel(messages, tools) {
	const stream = api.streamSimple(
		model,
		{ systemPrompt: SYSTEM, messages: structuredClone(messages), tools },
		{ maxTokens: 8192 },
	);
	const events = [];
	for await (const event of stream) events.push(event);
	const final = await stream.result();
	return { final, events };
}

const SYSTEM =
	"You are a file assistant. Use tools to complete tasks. Keep tool calls minimal and precise. Finish with a one-line summary.";

console.log("=== A. multi-step loop continuation + termination ===");
{
	const messages = [
		{
			role: "user",
			content:
				"Read notes.txt, count the words in it, then write the count to out.txt. Finish with a one-line summary.",
			timestamp: 1,
		},
	];
	let totalCalls = 0;
	let terminated = false;
	let finalText = "";
	for (let step = 1; step <= 5; step++) {
		const { final } = await callModel(messages, TOOLS);
		if (final.stopReason === "error" || final.stopReason === "aborted") {
			check(`step ${step} stream`, false, final.errorMessage);
			break;
		}
		messages.push(final);
		const calls = final.content.filter((block) => block.type === "toolCall");
		if (calls.length === 0) {
			terminated = true;
			finalText = final.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			break;
		}
		totalCalls += calls.length;
		for (const call of calls) {
			const result = fakeExecute(call);
			check(
				`step ${step} call ${call.name} has parseable args`,
				typeof call.arguments === "object" && call.arguments !== null,
				JSON.stringify(call.arguments).slice(0, 80),
			);
			messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: result.text }],
				isError: result.isError,
				timestamp: Date.now(),
			});
		}
	}
	check("loop made at least 2 tool calls across steps", totalCalls >= 2, `${totalCalls} calls`);
	check("loop terminated with final text, no trailing call", terminated, finalText.slice(0, 80));
}

console.log("=== B. wrap-prone output materializes a real tool call ===");
{
	const messages = [
		{
			role: "assistant",
			content: [
				{
					type: "text",
					text: '```json\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```',
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 1,
		},
		{ role: "user", content: "Now read notes.txt the same way as your previous message.", timestamp: 2 },
	];
	const { final } = await callModel(messages, TOOLS);
	const rawText = final.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	const call = final.content.find((block) => block.type === "toolCall");
	check("a toolCall block was produced (native or wrap-fix)", !!call);
	if (call) {
		check("call targets read_file", call.name === "read_file", call.name);
		check("call args point at notes.txt", call.arguments?.path === "notes.txt", JSON.stringify(call.arguments));
	}
	const route = rawText.includes('"name"') ? "wrap-fix converted text call" : "native tool call";
	console.log(`  info: route = ${route}`);
}

console.log("=== C. args repair on captured truncation shape (deterministic) ===");
{
	const truncated = '{"path": "example.py", "content": "def fib(n):';
	const repaired = repairArgs(truncated);
	check(
		"truncated giant-args string repairs to a valid object",
		repaired?.path === "example.py" && repaired?.content === "def fib(n):",
		JSON.stringify(repaired),
	);
}

console.log("=== D. giant-args watchdog (red-black tree stall case) ===");
{
	const messages = [
		{
			role: "user",
			content:
				"Create example.py: a fully documented Python implementation of a red-black tree with insert, delete, search, and in-order traversal. Include docstrings for every method.",
			timestamp: 1,
		},
	];
	const started = Date.now();
	const { final } = await callModel(messages, TOOLS);
	const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
	const call = final.content.find((block) => block.type === "toolCall");
	const rawText = final.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	if (call && Object.keys(call.arguments ?? {}).length === 0 && rawText.includes("generation stalled")) {
		check("watchdog fired with tool-error fallback (empty args + note)", true, `terminated in ${elapsed}`);
	} else if (call && typeof call.arguments?.content === "string") {
		check("model completed the giant call before the watchdog", true, `${call.arguments.content.length} chars in ${elapsed}`);
	} else if (final.stopReason === "error") {
		check("watchdog aborted the stall (no recoverable call)", true, `${final.errorMessage} in ${elapsed}`);
	} else {
		check("giant-args scenario terminates with a defined outcome", false, `stopReason=${final.stopReason} in ${elapsed}`);
	}
}

console.log(failures === 0 ? "\nALL SCENARIOS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
