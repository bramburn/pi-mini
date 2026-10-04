// Live harness for pi-mini against a running Ollama with granite4.2:8b.
//
// Strict by design: repair scenarios assert the repair paths actually FIRED
// (wrap-fix via the `wrapfix_call_` id marker set by ollama-native.ts; args
// repair via live-captured output truncated at the wire boundary and replayed
// through the production pipeline). No native-route escape branches.
//
//   A. multi-step tool loop continuation + clean termination (live)
//   B. forced wrap-fix: dictated wrapped JSON text must convert + execute (live)
//   C. args repair on live-captured output, truncated at the wire boundary
//   D. giant-args watchdog: the red-black-tree stall case must terminate (live)
//
// Requests run strictly sequentially (single-slot Ollama server).
// Run logs are persisted to evidence/ by the caller (tee).
// Usage: node scripts/live-test.mjs   (exit 0 = all PASS)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ollamaNativeApi } from "../ollama-native.ts";
import { repairArgs } from "../wrapfix.ts";
import { OLLAMA_BASE_URL, TINY_MODEL_ID } from "../settings.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(repoRoot, "evidence", "fixtures");
fs.mkdirSync(fixturesDir, { recursive: true });

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

async function callModel(messages, tools, opts = {}) {
	const stream = api.streamSimple(
		model,
		{ systemPrompt: opts.systemPrompt ?? SYSTEM, messages: structuredClone(messages), tools },
		{ maxTokens: opts.maxTokens ?? 8192, fetch: opts.fetch },
	);
	const events = [];
	for await (const event of stream) events.push(event);
	const final = await stream.result();
	return { final, events };
}

/** Truncation-repair semantics: every recovered key/value must be a prefix of the original. */
function isPrefixObject(original, repaired) {
	if (!repaired || typeof repaired !== "object") return false;
	for (const [key, value] of Object.entries(repaired)) {
		if (!(key in original)) return false;
		if (typeof value === "string") {
			if (typeof original[key] !== "string" || !original[key].startsWith(value)) return false;
		} else if (JSON.stringify(value) !== JSON.stringify(original[key])) return false;
	}
	return true;
}

const SYSTEM =
	"You are a file assistant. Use tools to complete tasks. Keep tool calls minimal and precise. Finish with a one-line summary.";

console.log("=== A. multi-step loop continuation + termination (live) ===");
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
			check(`step ${step} call ${call.name} has parseable args`, typeof call.arguments === "object" && call.arguments !== null);
			const result = fakeExecute(call);
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

console.log("=== B. forced wrap-fix: dictated wrapped JSON converts + executes (live) ===");
{
	// Dictation framing forces literal wrapped text even with tools registered
	// (validated 2026-10-04: V1/V2/V4 probe variants all fire repairFired=true).
	const messages = [
		{
			role: "user",
			content:
				'Output exactly these two lines and nothing else:\n```json\n{"name": "read_file", "arguments": {"path": "notes.txt"}}\n```',
			timestamp: 1,
		},
	];
	const { final, events } = await callModel(messages, TOOLS, {
		systemPrompt: "You are a transcription assistant. You never call tools; you only repeat text as instructed.",
		maxTokens: 400,
	});
	// Raw streamed text, before the repair pass strips the converted span from
	// the final message.
	const rawText = events
		.filter((event) => event.type === "text_delta")
		.map((event) => event.delta)
		.join("");
	const call = final.content.find((block) => block.type === "toolCall");
	const sawWrappedText = rawText.includes('"name"') || rawText.includes('\\"name\\"');
	const repairFired = !!call && String(call.id).startsWith("wrapfix_call_");
	check("model emitted the wrapped JSON as literal text", sawWrappedText);
	check("wrap-fix fired (wrapfix_call_ marker) with stopReason toolUse", repairFired && final.stopReason === "toolUse", `id=${call?.id} stop=${final.stopReason}`);
	check("converted call targets read_file/notes.txt", repairFired && call.name === "read_file" && call.arguments?.path === "notes.txt", JSON.stringify(call?.arguments));
	if (repairFired) {
		const result = fakeExecute(call);
		check("converted call executes against the tool", result.isError === false);
	}
}

console.log("=== C. args repair on live-captured output, truncated at the wire boundary ===");
{
	// C1: capture a real live call's argument payload.
	const messages = [
		{ role: "user", content: "Create story.txt with a 3-sentence story about a robot.", timestamp: 1 },
	];
	const { final } = await callModel(messages, TOOLS);
	const call = final.content.find((block) => block.type === "toolCall");
	check("live model produced a write_file call to capture", !!call && call.name === "write_file");
	if (call) {
		const original = call.arguments;
		const argsString = JSON.stringify(original);
		const cut = Math.max(8, Math.floor(argsString.length * 0.6));
		const truncated = argsString.slice(0, cut);
		fs.writeFileSync(
			path.join(fixturesDir, "live-captured-args.json"),
			`${JSON.stringify({ capturedAt: new Date().toISOString(), model: TINY_MODEL_ID, argsString, truncatedAt: cut }, null, 2)}\n`,
			"utf8",
		);

		// C2: direct production repair export on the truncated live payload.
		const repaired = repairArgs(truncated);
		check(
			"repairArgs recovers a prefix-faithful object from truncated live args",
			isPrefixObject(original, repaired),
			`cut=${cut}/${argsString.length}`,
		);

		// C3: full pipeline replay — the truncated payload arrives as a
		// string-arguments tool call (compat wire shape), repaired inside
		// ollama-native.ts before the done event.
		const chunk = JSON.stringify({
			message: {
				role: "assistant",
				content: "",
				tool_calls: [{ id: "wire_1", function: { name: "write_file", arguments: truncated } }],
			},
			done: false,
		});
		const doneChunk = JSON.stringify({
			message: { role: "assistant", content: "" },
			done: true,
			done_reason: "stop",
			prompt_eval_count: 10,
			eval_count: 5,
		});
		const { final: replayed } = await callModel([{ role: "user", content: "x", timestamp: 1 }], TOOLS, {
			fetch: async () => ({
				ok: true,
				status: 200,
				text: async () => "",
				body: new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();
						controller.enqueue(encoder.encode(`${chunk}\n`));
						controller.enqueue(encoder.encode(`${doneChunk}\n`));
						controller.close();
					},
				}),
			}),
		});
		const replayCall = replayed.content.find((block) => block.type === "toolCall");
		check(
			"pipeline replay: truncated string args repaired to a valid object before done",
			!!replayCall && isPrefixObject(original, replayCall.arguments) && Object.keys(replayCall.arguments).length > 0,
			JSON.stringify(replayCall?.arguments ?? null).slice(0, 80),
		);
	}
}

console.log("=== D. giant-args watchdog (red-black tree stall case, live) ===");
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
