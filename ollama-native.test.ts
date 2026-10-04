import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessageEvent, Context, Message, Model } from "@earendil-works/pi-ai";
import { ollamaNativeApi } from "./ollama-native.ts";

const model = {
	id: "granite4.2:8b",
	name: "Granite 4.2 8B",
	api: "ollama-native",
	provider: "ollama-mini",
	baseUrl: "http://localhost:11434",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131072,
	maxTokens: 8192,
} as unknown as Model<any>;

const TOOLS = [
	{
		name: "read_file",
		description: "Read a text file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
	{
		name: "write_file",
		description: "Write text to a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
	},
];

function makeContext(messages: Message[], tools: unknown[] | undefined = TOOLS): Context {
	return {
		systemPrompt: "You are a file assistant.",
		messages,
		tools: tools as Context["tools"],
	};
}

const textChunk = (content: string) =>
	JSON.stringify({ message: { role: "assistant", content }, done: false });
const callChunk = (id: string, name: string, args: unknown) =>
	JSON.stringify({
		message: { role: "assistant", content: "", tool_calls: [{ id, function: { name, arguments: args } }] },
		done: false,
	});
const doneChunk = (done_reason = "stop") =>
	JSON.stringify({
		message: { role: "assistant", content: "" },
		done: true,
		done_reason,
		prompt_eval_count: 100,
		prompt_eval_cached_count: 80,
		eval_count: 50,
	});

function fakeFetch(chunks: string[], stallAfter = false) {
	const state: { request: { url: string; body: Record<string, unknown> } | null } = { request: null };
	const fetchImpl = (async (url: unknown, init: { body: string }) => {
		state.request = { url: String(url), body: JSON.parse(init.body) };
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(`${chunk}\n`));
				if (!stallAfter) controller.close();
				// else leave the stream open to trigger the stall watchdog
			},
		});
		return { ok: true, status: 200, text: async () => "", body };
	}) as typeof globalThis.fetch;
	return { fetchImpl, state };
}

async function run(
	context: Context,
	chunks: string[],
	opts: { stallAfter?: boolean; stallTimeoutMs?: number } = {},
) {
	const { fetchImpl, state } = fakeFetch(chunks, opts.stallAfter ?? false);
	const stream = ollamaNativeApi({ stallTimeoutMs: opts.stallTimeoutMs ?? 200 }).streamSimple(model, context, {
		fetch: fetchImpl,
	} as never);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const final = await stream.result();
	return { events, final, request: state.request };
}

describe("ollamaNativeApi", () => {
	test("native tool call becomes a pi-ai toolCall block with stopReason toolUse", async () => {
		const context = makeContext([{ role: "user", content: "Read config/settings.json", timestamp: 1 }] as Message[]);
		const { events, final, request } = await run(context, [
			textChunk(""),
			callChunk("call_1", "read_file", { path: "config/settings.json" }),
			doneChunk("stop"),
		]);
		assert.equal(final.stopReason, "toolUse");
		const call = final.content.find((block) => block.type === "toolCall");
		assert.ok(call && call.type === "toolCall");
		assert.equal(call.name, "read_file");
		assert.equal(call.arguments.path, "config/settings.json");
		assert.ok(events.some((event) => event.type === "toolcall_end"));
		assert.ok(events.some((event) => event.type === "done"));
		// request mapping: think:false, native tools, system first
		assert.equal(request?.url, "http://localhost:11434/api/chat");
		assert.equal(request?.body.think, false);
		const tools = request?.body.tools as Array<{ function: { name: string } }>;
		assert.equal(tools[0].function.name, "read_file");
		const messages = request?.body.messages as Array<{ role: string }>;
		assert.deepEqual(
			messages.map((m) => m.role),
			["system", "user"],
		);
	});

	test("assistant tool calls and tool results are replayed in native shape", async () => {
		const context = makeContext([
			{ role: "user", content: "Read a.txt", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } },
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read_file",
				content: [{ type: "text", text: "hello world" }],
				isError: false,
				timestamp: 3,
			},
		] as Message[]);
		const { request } = await run(context, [doneChunk()]);
		const messages = request?.body.messages as Array<Record<string, unknown>>;
		assert.deepEqual(
			messages.map((m) => m.role),
			["system", "user", "assistant", "tool"],
		);
		const replayed = messages[2].tool_calls as Array<{ function: { name: string; arguments: unknown } }>;
		assert.equal(replayed[0].function.name, "read_file");
		assert.deepEqual(replayed[0].function.arguments, { path: "a.txt" });
		const toolMessage = messages[3];
		assert.equal(toolMessage.tool_name, "read_file");
		assert.equal(toolMessage.tool_call_id, "call_1");
		assert.equal(toolMessage.content, "hello world");
	});

	test("wrapped text tool call is converted to a real toolCall (wrap-fix)", async () => {
		const context = makeContext([{ role: "user", content: "Read config/settings.json", timestamp: 1 }] as Message[]);
		const { final } = await run(context, [
			textChunk('I will read it.\n```json\n{"name": "read_file", "arguments": {"path": "config/settings.json"}}\n```'),
			doneChunk("stop"),
		]);
		assert.equal(final.stopReason, "toolUse");
		const call = final.content.find((block) => block.type === "toolCall");
		assert.ok(call && call.type === "toolCall");
		assert.equal(call.name, "read_file");
		assert.equal(call.arguments.path, "config/settings.json");
		const text = final.content.find((block) => block.type === "text");
		assert.ok(text && text.type === "text");
		assert.ok(!text.text.includes('"name"'));
		assert.ok(text.text.includes("I will read it."));
	});

	test("wrapped call is left alone when no tools are registered", async () => {
		const context = makeContext(
			[{ role: "user", content: "Read config/settings.json", timestamp: 1 }] as Message[],
			[],
		);
		const { final } = await run(context, [
			textChunk('```json\n{"name": "read_file", "arguments": {"path": "config/settings.json"}}\n```'),
			doneChunk("stop"),
		]);
		assert.equal(final.stopReason, "stop");
		assert.equal(final.content.filter((block) => block.type === "toolCall").length, 0);
	});

	test("stalled giant-arg call falls back to empty arguments (tool-error fallback)", async () => {
		const context = makeContext([{ role: "user", content: "Write example.py", timestamp: 1 }] as Message[]);
		const { final } = await run(
			context,
			[
				textChunk(
					'Let me write the code.\n{"name": "write_file", "arguments": {"path": "example.py", "content": "def fib(n):',
				),
			],
			{ stallAfter: true, stallTimeoutMs: 60 },
		);
		assert.equal(final.stopReason, "toolUse");
		const call = final.content.find((block) => block.type === "toolCall");
		assert.ok(call && call.type === "toolCall");
		assert.equal(call.name, "write_file");
		assert.deepEqual(call.arguments, {});
		const text = final.content.find((block) => block.type === "text");
		assert.ok(text && text.type === "text");
		assert.ok(text.text.includes("generation stalled"));
	});

	test("stall without a recoverable call terminates as an error", async () => {
		const context = makeContext([{ role: "user", content: "Write example.py", timestamp: 1 }] as Message[]);
		const { events, final } = await run(context, [textChunk("Let me think about it.")], {
			stallAfter: true,
			stallTimeoutMs: 60,
		});
		assert.equal(final.stopReason, "error");
		assert.ok(final.errorMessage?.includes("stalled"));
		const errorEvent = events.find((event) => event.type === "error");
		assert.ok(errorEvent && errorEvent.type === "error");
		assert.equal(errorEvent.reason, "error");
	});

	test("plain text completion maps to stop, finish-length maps to length", async () => {
		const context = makeContext([{ role: "user", content: "Hi", timestamp: 1 }] as Message[]);
		const stopped = await run(context, [textChunk("Hello there."), doneChunk("stop")]);
		assert.equal(stopped.final.stopReason, "stop");
		const text = stopped.final.content.find((block) => block.type === "text");
		assert.ok(text && text.type === "text");
		assert.equal(text.text, "Hello there.");
		const length = await run(context, [textChunk("partial"), doneChunk("length")]);
		assert.equal(length.final.stopReason, "length");
		assert.equal(stopped.final.usage.input, 100);
		assert.equal(stopped.final.usage.output, 50);
		assert.equal(stopped.final.usage.cacheRead, 80);
	});
});
