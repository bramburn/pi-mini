import { describe, expect, test } from "bun:test";
import { extractDelegate, stripDelegateBlocks } from "./parser.ts";

describe("extractDelegate", () => {
	const delegateCases: Array<[string, string]> = [
		["clean fenced json", '```json\n{ "task": "create file foo.txt with content hello" }\n```'],
		["fenced without language + preamble", 'Sure, delegating that now:\n```\n{"task": "list files in src"}\n```\nDone.'],
		["wrong key name", '```json\n{ "instruction": "run git status" }\n```'],
		["truncated json, unclosed fence", '```json\n{"task": "read package.json and summarize the scripts section'],
		["whole-message json", '{"prompt": "summarize README.md"}'],
		["nested escaped quotes", '```json\n{ "task": "say \\"hi\\" to the user", broken'],
	];

	test.each(delegateCases)("%s", (_name, text) => {
		const request = extractDelegate(text);
		expect(request).toBeDefined();
		expect(request?.task.length).toBeGreaterThan(0);
	});

	test("clean fenced json extracts exact task", () => {
		expect(extractDelegate('```json\n{ "task": "create file foo.txt with content hello" }\n```')?.task).toBe(
			"create file foo.txt with content hello",
		);
	});

	test("plain chat is not a delegate request", () => {
		expect(extractDelegate("The refactor looks good because the module boundaries are clean.")).toBeUndefined();
	});

	test("unrelated fenced code is not a delegate request", () => {
		expect(extractDelegate("Use this snippet:\n```python\nprint('hi')\n```")).toBeUndefined();
	});

	// Real outputs captured from hf.co/mradermacher/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF:Q4_K_M
	// via Ollama (localhost:11434), 2026-09-30.
	test("ChatML-style tool call emitted when tools are present", () => {
		const text =
			'```json\n{"name": "delegate", "arguments": {"task": "Create a file named hello.txt containing exactly: hi there"}}\n```';
		expect(extractDelegate(text)?.task).toBe("Create a file named hello.txt containing exactly: hi there");
	});

	test("multiline pretty-printed delegate block", () => {
		const text =
			'```json\n{\n  "task": "Read the file package.json in the current directory, then create a summary file package-summary.md with the project name and dependency count."\n}\n```';
		expect(extractDelegate(text)?.task).toBe(
			"Read the file package.json in the current directory, then create a summary file package-summary.md with the project name and dependency count.",
		);
	});

	test("nested args key", () => {
		expect(extractDelegate('```json\n{"tool": "delegate", "args": {"task": "run git status"}}\n```')?.task).toBe(
			"run git status",
		);
	});
});

describe("stripDelegateBlocks", () => {
	test("removes the delegate fence and keeps prose", () => {
		const cleaned = stripDelegateBlocks('I will delegate this.\n```json\n{"task": "do the thing"}\n```');
		expect(cleaned).toBe("I will delegate this.");
	});

	test("leaves non-delegate code fences alone", () => {
		const text = "Snippet:\n```python\nprint('hi')\n```";
		expect(stripDelegateBlocks(text)).toBe(text);
	});
});
