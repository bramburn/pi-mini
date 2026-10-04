import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import type { ModelRef } from "./settings.ts";

const TRANSCRIPT_CAP_CHARS = 180_000;
const WORKER_OUTPUT_CAP = 20_000;
const TASK_CAP = 8_000;
const STDERR_CAP = 4_000;

interface MessageEntry {
	type: "message";
	message: Message;
}

export interface WorkerResult {
	ok: boolean;
	text: string;
}

function isMessageEntry(entry: unknown): entry is MessageEntry {
	return (
		!!entry &&
		typeof entry === "object" &&
		(entry as { type?: unknown }).type === "message" &&
		typeof (entry as MessageEntry).message === "object"
	);
}

function isTextContent(part: unknown): part is TextContent {
	return !!part && typeof part === "object" && (part as TextContent).type === "text";
}

function textOf(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.filter(isTextContent).map((p) => p.text).join("\n").trim();
}

/** Render session entries as a plain-text transcript for the worker's context. */
export function buildTranscript(entries: readonly unknown[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		if (!isMessageEntry(entry)) continue;
		const message = entry.message;
		if (typeof (message as { role?: unknown }).role !== "string") continue; // custom entries
		if (message.role === "user") {
			const text = textOf(message);
			if (text) lines.push(`User: ${text}`);
		} else if (message.role === "assistant") {
			const text = textOf(message);
			if (text) lines.push(`Assistant: ${text}`);
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part.type === "toolCall") {
						const args = JSON.stringify(part.arguments);
						lines.push(`Assistant tool call: ${part.name}(${args.slice(0, 500)})`);
					}
				}
			}
		} else if (message.role === "toolResult") {
			const text = textOf(message);
			lines.push(`Tool result (${message.toolName}): ${text.slice(0, 2_000)}`);
		}
	}

	let transcript = lines.join("\n\n");
	if (transcript.length > TRANSCRIPT_CAP_CHARS) {
		transcript = `[... earlier history truncated ...]\n\n${transcript.slice(-TRANSCRIPT_CAP_CHARS)}`;
	}
	return transcript;
}

/**
 * Spawn a full pi worker (large model, all tools, fresh session) with the
 * session transcript injected via --append-system-prompt so the conversation
 * stays under the Windows command-line length limit.
 */
export async function runWorker(opts: {
	large: ModelRef;
	task: string;
	entries: readonly unknown[];
	cwd: string;
	signal?: AbortSignal;
}): Promise<WorkerResult> {
	const task = opts.task.slice(0, TASK_CAP).trim();
	if (!task) return { ok: false, text: "Empty delegate task" };

	const contextFile = path.join(os.tmpdir(), `pi-mini-context-${process.pid}-${Date.now()}.md`);
	fs.writeFileSync(
		contextFile,
		`The following is the conversation so far between the user and an orchestrator agent. ` +
			`Treat it as your session context; the user's latest request arrives as your task prompt.\n\n${buildTranscript(opts.entries)}\n`,
		"utf8",
	);

	try {
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			`${opts.large.provider}/${opts.large.modelId}`,
			"--append-system-prompt",
			contextFile,
			`Delegated task from the orchestrator:\n${task}\n\n` +
				`Complete this task using your tools with the conversation above as context. ` +
				`Do not ask questions; make reasonable assumptions and state them in your final report. ` +
				`Reply with a concise report of what you did and the outcome.`,
		];
		const invocation = getPiInvocation(args);
		return await new Promise<WorkerResult>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let stderr = "";
			const messages: Message[] = [];

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				const record = event as { type?: string; message?: unknown };
				if (record.type === "message_end" && record.message) {
					messages.push(record.message as Message);
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data: Buffer) => {
				stderr = (stderr + data.toString()).slice(-STDERR_CAP);
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				const text = finalAssistantText(messages).slice(0, WORKER_OUTPUT_CAP);
				if (code === 0 && text) {
					resolve({ ok: true, text });
				} else {
					resolve({
						ok: false,
						text: text || stderr.trim() || `worker exited with code ${code ?? "unknown"}`,
					});
				}
			});
			proc.on("error", (err) => {
				resolve({ ok: false, text: `failed to start worker: ${err.message}` });
			});

			if (opts.signal) {
				const killProc = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5_000);
				};
				if (opts.signal.aborted) killProc();
				else opts.signal.addEventListener("abort", killProc, { once: true });
			}
		});
	} finally {
		try {
			fs.unlinkSync(contextFile);
		} catch {
			// temp file cleanup is best effort
		}
	}
}

function finalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			const text = textOf(message);
			if (text) return text;
		}
	}
	return "";
}

/** Re-resolve the running pi binary the same way the built-in subagent tool does. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}
