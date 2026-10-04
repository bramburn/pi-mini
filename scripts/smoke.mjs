// End-to-end smoke run for pi-mini inside a real pi session (RPC mode).
//
// Flow: /mini on -> native tool loop (read) -> forced wrap-fix case (dictated
// wrapped JSON must convert via wrap-fix and execute; STRICT, no native-route
// escape) -> delegate_to_worker round trip -> /mini off.
// Run logs are persisted to evidence/ by the caller (tee).
// Usage: node scripts/smoke.mjs   (exit 0 = all PASS)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piCmd = process.platform === "win32" ? "pi.cmd" : "pi";

let failures = 0;
function check(label, ok, detail = "") {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

const proc = spawn(piCmd, ["--mode", "rpc", "--no-session", "--no-extensions", "-a", "-e", "./index.ts"], {
	cwd: repoRoot,
	shell: process.platform === "win32",
	stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
proc.stderr.on("data", (data) => {
	stderr += data.toString();
});

const events = [];
const responseWaiters = new Map();
const settleWaiters = [];
let buffer = "";

proc.stdout.on("data", (data) => {
	buffer += data.toString();
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line.replace(/\r$/, ""));
		} catch {
			continue;
		}
		events.push(event);
		if (event.type === "response" && event.id !== undefined) {
			const waiter = responseWaiters.get(event.id);
			if (waiter) {
				responseWaiters.delete(event.id);
				waiter(event);
			}
		}
		if (event.type === "agent_settled") {
			while (settleWaiters.length > 0) settleWaiters.shift()(event);
		}
	}
});

function send(command) {
	proc.stdin.write(`${JSON.stringify(command)}\n`);
}

function response(id, timeoutMs = 30_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for response ${id}`)), timeoutMs);
		responseWaiters.set(id, (event) => {
			clearTimeout(timer);
			resolve(event);
		});
	});
}

function settled(timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for agent_settled (${timeoutMs}ms)`)), timeoutMs);
		settleWaiters.push((event) => {
			clearTimeout(timer);
			resolve(event);
		});
	});
}

async function promptAndWait(id, message, timeoutMs) {
	const from = events.length;
	send({ id, type: "prompt", message });
	const res = await response(id);
	check(`prompt ${id} accepted`, res.success === true, res.error ?? "");
	if (res.success !== true) throw new Error(`prompt ${id} rejected`);
	await settled(timeoutMs);
	return events.slice(from);
}

function toolStarts(slice) {
	return slice.filter((e) => e.type === "tool_execution_start");
}

try {
	// 1. enable mini mode (extension command runs immediately)
	console.log("=== 1. /mini on ===");
	send({ id: "mini-on", type: "prompt", message: "/mini on" });
	const on = await response("mini-on", 60_000);
	check("/mini on executed", on.success === true, on.error ?? "");

	// 2. native tool loop: read tool call -> result -> final text
	console.log("=== 2. native tool-call continuation (read) ===");
	const slice2 = await promptAndWait(
		"task-read",
		"Use the read tool to read package.json. Then reply with one short line stating how many npm scripts are defined.",
		300_000,
	);
	const reads2 = toolStarts(slice2).filter((e) => e.toolName === "read");
	check("read tool executed via native loop", reads2.length >= 1, `tool starts: ${toolStarts(slice2).map((e) => e.toolName).join(",") || "none"}`);
	const text2 = slice2.filter((e) => e.type === "message_end" && e.message?.role === "assistant").length;
	check("assistant produced final text", text2 >= 1);

	// 3. forced wrap-fix case (STRICT): dictated wrapped JSON text must be
	// converted by wrap-fix (wrapfix_call_ marker in the assistant message)
	// and executed. No native-route escape: this fails if the model merely
	// called natively or produced no call at all.
	console.log("=== 3. forced wrap-fix case (strict) ===");
	const slice3 = await promptAndWait(
		"task-wrap",
		'Dictation exercise. Repeat the fenced block below exactly ONCE, then on the next line write DONE. Never repeat the block twice.\n```json\n{"name": "read", "arguments": {"path": "package.json"}}\n```',
		300_000,
	);
	// RPC wire shape for message_update: { type, usage, assistantMessageEvent } —
	// no message field (json.md).
	const wrapText = slice3
		.filter((e) => e.type === "message_update")
		.map((e) => JSON.stringify(e.assistantMessageEvent ?? ""))
		.join("");
	const sawWrappedText = wrapText.includes('"name"') || wrapText.includes('\\"name\\"');
	const wrapMarker = slice3
		.filter((e) => e.type === "message_end" && e.message?.role === "assistant")
		.some((e) =>
			(e.message.content ?? []).some((b) => b.type === "toolCall" && String(b.id).startsWith("wrapfix_call_")),
		);
	const wrapExecuted = toolStarts(slice3).filter((e) => e.toolName === "read").length >= 1;
	check("model emitted the wrapped JSON as literal text", sawWrappedText);
	check("wrap-fix FIRED (wrapfix_call_ marker in assistant message)", wrapMarker);
	check("converted call executed the read tool", wrapExecuted);

	// 4. delegate_to_worker round trip
	console.log("=== 4. delegate_to_worker round trip ===");
	const slice4 = await promptAndWait(
		"task-delegate",
		'Now call the tool named "delegate_to_worker" with task: Reply with exactly this sentence: hello from the worker. Then relay its result to me.',
		600_000,
	);
	const delegates = toolStarts(slice4).filter((e) => e.toolName === "delegate_to_worker");
	check("delegate_to_worker executed", delegates.length >= 1, `tool starts: ${toolStarts(slice4).map((e) => e.toolName).join(",") || "none"}`);
	const delegateEnd = slice4.find((e) => e.type === "tool_execution_end" && e.toolName === "delegate_to_worker");
	check(
		"worker returned a successful report",
		!!delegateEnd && delegateEnd.isError === false,
		JSON.stringify(delegateEnd?.result ?? "").slice(0, 120),
	);

	// 5. disable
	console.log("=== 5. /mini off ===");
	send({ id: "mini-off", type: "prompt", message: "/mini off" });
	const off = await response("mini-off", 60_000);
	check("/mini off executed", off.success === true, off.error ?? "");
} catch (error) {
	check(`smoke run completed without error (${error.message})`, false);
	console.log("  --- diagnostic trace (last events) ---");
	for (const e of events.slice(-20)) {
		const brief =
			e.type === "tool_execution_start"
				? `${e.type} ${e.toolName} toolCallId=${e.toolCallId}`
				: e.type === "message_end" && e.message?.role === "assistant"
					? `message_end assistant: ${JSON.stringify((e.message.content ?? []).map((b) => (b.type === "toolCall" ? { toolCall: b.id, name: b.name } : b.text?.slice(0, 60))))}`
					: e.type;
		console.log(`    ${brief}`);
	}
	if (stderr.trim()) console.log("  stderr tail:", stderr.slice(-500));
}

proc.kill();
console.log(failures === 0 ? "\nSMOKE PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
