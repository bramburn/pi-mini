import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { detectToolCall, repairArgs, stripToolCallSpans } from "./wrapfix.ts";

const TOOLS = new Set(["read_file", "write_file", "bash"]);

describe("detectToolCall", () => {
	test("fenced json call with object arguments", () => {
		const text =
			'Calling the tool:\n```json\n{"name": "read_file", "arguments": {"path": "config/settings.json"}}\n```';
		const call = detectToolCall(text, TOOLS);
		assert.ok(call);
		assert.equal(call.name, "read_file");
		assert.deepEqual(call.arguments, { path: "config/settings.json" });
		assert.equal(text.slice(call.start, call.end), text.slice(text.indexOf("```")));
	});

	test("whole-message json call", () => {
		const call = detectToolCall('{"name": "read_file", "arguments": {"path": "a.txt"}}', TOOLS);
		assert.ok(call);
		assert.equal(call.name, "read_file");
		assert.equal(call.arguments.path, "a.txt");
	});

	test("tool/args key variant (ChatML-style degradation)", () => {
		const call = detectToolCall(
			'```json\n{"tool": "write_file", "args": {"path": "a.txt", "content": "hi"}}\n```',
			TOOLS,
		);
		assert.ok(call);
		assert.equal(call.name, "write_file");
		assert.deepEqual(call.arguments, { path: "a.txt", content: "hi" });
	});

	test("OpenAI-style wrapper with string arguments", () => {
		const call = detectToolCall(
			'{"function": {"name": "read_file", "arguments": "{\\"path\\": \\"b.txt\\"}"}}',
			TOOLS,
		);
		assert.ok(call);
		assert.equal(call.name, "read_file");
		assert.equal(call.arguments.path, "b.txt");
	});

	test("tool_calls array wrapper", () => {
		const call = detectToolCall(
			'```json\n{"tool_calls": [{"function": {"name": "bash", "arguments": {"command": "ls"}}}]}\n```',
			TOOLS,
		);
		assert.ok(call);
		assert.equal(call.name, "bash");
		assert.equal(call.arguments.command, "ls");
	});

	test("truncated json in unclosed fence is repaired", () => {
		const text = '```json\n{"name": "write_file", "arguments": {"path": "a.txt", "content": "hello wo';
		const call = detectToolCall(text, TOOLS);
		assert.ok(call);
		assert.equal(call.name, "write_file");
		assert.equal(call.arguments.path, "a.txt");
		assert.equal(call.arguments.content, "hello wo");
	});

	test("bare trailing json call after prose is detected", () => {
		const text = 'Let me do it. {"name": "read_file", "arguments": {"path": "x.txt"}}\nAnything else?';
		const call = detectToolCall(text, TOOLS);
		assert.ok(call);
		assert.equal(call.name, "read_file");
		assert.equal(text.slice(call.start, call.end), '{"name": "read_file", "arguments": {"path": "x.txt"}}');
	});

	test("tool name is normalized case-insensitively to the canonical name", () => {
		const call = detectToolCall('{"name": "READ_FILE", "arguments": {"path": "a"}}', TOOLS);
		assert.ok(call);
		assert.equal(call.name, "read_file");
	});

	test("unknown tool name is not detected", () => {
		assert.equal(
			detectToolCall('```json\n{"name": "unknown_tool", "arguments": {"x": 1}}\n```', TOOLS),
			undefined,
		);
	});

	test("legacy delegate block without a tool name is not detected", () => {
		assert.equal(detectToolCall('```json\n{"task": "do the thing"}\n```', TOOLS), undefined);
	});

	test("plain prose is not detected", () => {
		assert.equal(detectToolCall("The refactor looks good because the module boundaries are clean.", TOOLS), undefined);
	});

	test("python code fence is not detected", () => {
		assert.equal(detectToolCall("Use this snippet:\n```python\nprint('hi')\n```", TOOLS), undefined);
	});
});

describe("repairArgs", () => {
	test("valid object passes through", () => {
		assert.deepEqual(repairArgs('{"path": "a"}'), { path: "a" });
	});

	test("truncated string and braces are closed", () => {
		assert.deepEqual(repairArgs('{"path": "a", "content": "x'), { path: "a", content: "x" });
	});

	test("nested objects survive repair", () => {
		assert.deepEqual(repairArgs('{"filters": {"colors": ["red"], "max_price": 100'), {
			filters: { colors: ["red"], max_price: 100 },
		});
	});

	test("trailing junk after a balanced object is cut", () => {
		assert.deepEqual(repairArgs('{"path": "a"} hope that helps!'), { path: "a" });
	});

	test("empty and non-json input return undefined", () => {
		assert.equal(repairArgs(""), undefined);
		assert.equal(repairArgs("not json at all"), undefined);
	});
});

describe("stripToolCallSpans", () => {
	test("removes wrapped calls and keeps prose", () => {
		const text =
			'I will read the file.\n```json\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```\nDone.';
		assert.equal(stripToolCallSpans(text, TOOLS), "I will read the file.\n\nDone.");
	});

	test("keeps documented examples buried in prose", () => {
		const text =
			'Example:\n```json\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```\n' +
			"explanation ".repeat(30);
		assert.equal(stripToolCallSpans(text, TOOLS), text);
	});

	test("leaves ordinary code fences alone", () => {
		const text = "Snippet:\n```python\nprint('hi')\n```";
		assert.equal(stripToolCallSpans(text, TOOLS), text);
	});
});
