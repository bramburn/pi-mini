// Custom pi-ai streaming API over Ollama's native /api/chat endpoint.
//
// Why native and not the OpenAI-compat /v1 endpoint:
// - `think: false` is honored only on /api/chat (granite4.2 thinks before every
//   reply otherwise, ~10x latency on tool loops; the compat endpoint silently
//   ignores both top-level `think` and `chat_template_kwargs`).
// - Native responses carry `thinking` and tool calls with object-form
//   `function.arguments` (compat sends arguments as JSON strings).
// - `done_reason` is "stop" even when tool calls are present; call presence is
//   the signal for stopReason "toolUse".
//
// This module also owns the json-call/tool-call wrap-fix: when a model drops out
// of native tool-call mode and writes the call as (possibly truncated) JSON
// text, the repair pass converts it back into a real toolCall block before the
// `done` event, so pi's agent loop executes it and continues natively.

import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	ProviderStreams,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream, calculateCost } from "@earendil-works/pi-ai";
import { detectToolCall, repairArgs } from "./wrapfix.ts";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_STALL_TIMEOUT_MS = 90_000;

export interface OllamaNativeApiOptions {
	/** Ollama server root (no /v1 suffix). Default http://localhost:11434 */
	baseUrl?: string;
	/** Granite-style thinking toggle. Default false (thinking cripples tool loops). */
	think?: boolean;
	/** Abort and fall back when the model emits nothing for this long. Default 90s. */
	stallTimeoutMs?: number;
}

interface NativeToolCall {
	id?: string;
	function?: { name?: string; arguments?: unknown };
}

interface NativeChunk {
	message?: {
		role?: string;
		content?: string;
		thinking?: string;
		tool_calls?: NativeToolCall[];
	};
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	prompt_eval_cached_count?: number;
	eval_count?: number;
}

/** Map pi-ai conversation state to Ollama native /api/chat messages. */
function buildNativeMessages(context: Context): unknown[] {
	const messages: unknown[] = [];
	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}
	for (const message of context.messages) {
		messages.push(toNativeMessage(message));
	}
	return messages;
}

function toNativeMessage(message: Message): unknown {
	if (message.role === "user") {
		if (typeof message.content === "string") {
			return { role: "user", content: message.content };
		}
		const text = message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const images = message.content
			.filter((part) => part.type === "image")
			.map((part) => (part as { data: string }).data);
		return images.length > 0 ? { role: "user", content: text, images } : { role: "user", content: text };
	}
	if (message.role === "assistant") {
		const text = message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const toolCalls = message.content
			.filter((part): part is ToolCall => part.type === "toolCall")
			.map((call) => ({
				id: call.id,
				type: "function",
				function: { name: call.name, arguments: call.arguments },
			}));
		const out: Record<string, unknown> = { role: "assistant", content: text };
		if (toolCalls.length > 0) out.tool_calls = toolCalls;
		return out;
	}
	const toolResult = message as ToolResultMessage;
	const text = toolResult.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return {
		role: "tool",
		tool_name: toolResult.toolName,
		tool_call_id: toolResult.toolCallId,
		content: text,
	};
}

function buildNativeTools(tools: readonly Tool[] | undefined): unknown[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

/** Coerce native tool-call arguments (object form, or string form on some builds) to an object. */
function coerceArguments(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	if (typeof raw === "string" && raw.trim()) {
		return repairArgs(raw) ?? {};
	}
	return {};
}

export function ollamaNativeApi(opts?: OllamaNativeApiOptions): ProviderStreams {
	const baseUrl = (opts?.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
	const think = opts?.think ?? false;
	const stallTimeoutMs = opts?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

	const streamImpl = (
		model: Model<any>,
		context: Context,
		options?: StreamOptions,
	): AssistantMessageEventStream => {
		const stream = new AssistantMessageEventStream();

		(async () => {
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: Date.now(),
			};

			let textBlock: TextContent | null = null;
			let thinkingBlock: ThinkingContent | null = null;
			const toolCallBlocks: ToolCall[] = [];
			let sawDone = false;
			let doneReason = "";
			let stalled = false;

			const addText = (delta: string): void => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					output.content.push(textBlock);
					stream.push({
						type: "text_start",
						contentIndex: output.content.indexOf(textBlock),
						partial: output,
					});
				}
				textBlock.text += delta;
				stream.push({
					type: "text_delta",
					contentIndex: output.content.indexOf(textBlock),
					delta,
					partial: output,
				});
			};

			const addThinking = (delta: string): void => {
				if (!thinkingBlock) {
					thinkingBlock = { type: "thinking", thinking: "" };
					output.content.push(thinkingBlock);
					stream.push({
						type: "thinking_start",
						contentIndex: output.content.indexOf(thinkingBlock),
						partial: output,
					});
				}
				thinkingBlock.thinking += delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: output.content.indexOf(thinkingBlock),
					delta,
					partial: output,
				});
			};

			const addToolCall = (raw: NativeToolCall, index: number, argumentsOverride?: Record<string, unknown>): void => {
				const call: ToolCall = {
					type: "toolCall",
					id: raw.id ?? `ollama_call_${index}`,
					name: raw.function?.name ?? "",
					arguments: argumentsOverride ?? coerceArguments(raw.function?.arguments),
				};
				output.content.push(call);
				const contentIndex = output.content.indexOf(call);
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex,
					delta: JSON.stringify(call.arguments),
					partial: output,
				});
				toolCallBlocks.push(call);
				stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: output });
			};

			/**
			 * Wrap-fix + tool-error fallback, run before the done event.
			 * - Wrapped text call (no native calls): convert to a real toolCall so the
			 *   agent loop executes it and continues.
			 * - Stalled giant-arg generation: emit the detected call with empty
			 *   arguments so tool validation fails and the model retries in smaller
			 *   steps (or delegates) instead of writing silently truncated output.
			 */
			const repairPass = (stalled: boolean): void => {
				if (toolCallBlocks.length > 0) return;
				const knownTools = new Set((context.tools ?? []).map((tool) => tool.name));
				if (knownTools.size === 0) return;
				const text = textBlock?.text ?? "";
				const wrapped = detectToolCall(text, knownTools);
				if (!wrapped) return;
				const args = stalled ? {} : wrapped.arguments;
				addToolCall(
					{ id: `wrapfix_call_${toolCallBlocks.length + 1}`, function: { name: wrapped.name, arguments: args } },
					toolCallBlocks.length + 1,
					args,
				);
				if (textBlock) {
					const stripped = text.slice(0, wrapped.start) + text.slice(wrapped.end);
					textBlock.text = stripped.trim();
				}
				if (stalled) {
					addText(
						"\n[pi-mini] generation stalled mid tool call; arguments were dropped so the tool reports an error. " +
							"Retry with smaller steps or use delegate_to_worker.",
					);
				}
			};

			try {
				const body: Record<string, unknown> = {
					model: model.id,
					messages: buildNativeMessages(context),
					stream: true,
					think,
				};
				const nativeTools = buildNativeTools(context.tools);
				if (nativeTools) body.tools = nativeTools;
				const requestOptions: Record<string, unknown> = {};
				if (options?.maxTokens !== undefined) requestOptions.num_predict = options.maxTokens;
				if (options?.temperature !== undefined) requestOptions.temperature = options.temperature;
				if (Object.keys(requestOptions).length > 0) body.options = requestOptions;

				const controller = new AbortController();
				const onOuterAbort = () => controller.abort();
				options?.signal?.addEventListener("abort", onOuterAbort, { once: true });

				try {
					const response = await (options?.fetch ?? globalThis.fetch)(`${baseUrl}/api/chat`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
						signal: controller.signal,
					});
					if (!response.ok || !response.body) {
						const detail = (await response.text().catch(() => "")).slice(0, 300);
						throw new Error(`Ollama /api/chat ${response.status}: ${detail}`);
					}
					await options?.onResponse?.({ status: response.status, headers: {} }, model);
					stream.push({ type: "start", partial: output });

					// Read NDJSON lines with a stall watchdog: giant schema-constrained
					// arguments can dead-end silently on some Ollama builds.
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";

					const readWithWatchdog = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
						let timer: ReturnType<typeof setTimeout> | undefined;
						const timeout = new Promise<"stall">((resolve) => {
							timer = setTimeout(() => resolve("stall"), stallTimeoutMs);
						});
						// A pending read() rejects after controller.abort() — swallow it so the
						// losing side of the race can never become an unhandled rejection.
						const read = reader
							.read()
							.catch((): ReadableStreamReadResult<Uint8Array> => ({ done: true, value: undefined }));
						const raced = await Promise.race([read, timeout]);
						clearTimeout(timer);
						if (raced === "stall") {
							stalled = true;
							controller.abort();
							return { done: true, value: undefined };
						}
						return raced;
					};

					const processLine = (line: string): void => {
						if (!line.trim()) return;
						let chunk: NativeChunk;
						try {
							chunk = JSON.parse(line) as NativeChunk;
						} catch {
							return;
						}
						const message = chunk.message;
						if (message?.thinking) addThinking(message.thinking);
						if (message?.content) addText(message.content);
						if (message?.tool_calls) {
							message.tool_calls.forEach((raw, index) => addToolCall(raw, index));
						}
						if (chunk.done) {
							sawDone = true;
							doneReason = chunk.done_reason ?? "stop";
							output.usage.input = chunk.prompt_eval_count ?? 0;
							output.usage.output = chunk.eval_count ?? 0;
							output.usage.cacheRead = chunk.prompt_eval_cached_count ?? 0;
							output.usage.totalTokens = output.usage.input + output.usage.output;
						}
					};

					while (true) {
						const result = await readWithWatchdog();
						if (result.value) {
							buffer += decoder.decode(result.value, { stream: true });
							const lines = buffer.split("\n");
							buffer = lines.pop() ?? "";
							for (const line of lines) processLine(line);
						}
						if (result.done) break;
					}
					if (buffer.trim()) processLine(buffer);

					repairPass(stalled);
				} finally {
					options?.signal?.removeEventListener("abort", onOuterAbort);
				}

				output.usage.cost = calculateCost(model, output.usage);
				let stopReason: Extract<StopReason, "stop" | "length" | "toolUse">;
				if (toolCallBlocks.length > 0) {
					stopReason = "toolUse";
				} else if (stalled) {
					throw new Error(
						`generation stalled (no output for ${Math.round(stallTimeoutMs / 1000)}s) with no recoverable tool call`,
					);
				} else if (doneReason === "length") {
					stopReason = "length";
				} else {
					stopReason = "stop";
				}
				output.stopReason = stopReason;
				if (thinkingBlock) {
					stream.push({
						type: "thinking_end",
						contentIndex: output.content.indexOf(thinkingBlock),
						content: thinkingBlock.thinking,
						partial: output,
					});
				}
				if (textBlock) {
					stream.push({
						type: "text_end",
						contentIndex: output.content.indexOf(textBlock),
						content: textBlock.text,
						partial: output,
					});
				}
				if (!sawDone && toolCallBlocks.length === 0 && !textBlock && !thinkingBlock) {
					throw new Error("Ollama stream ended without producing any output");
				}
				stream.push({ type: "done", reason: stopReason, message: output });
			} catch (error) {
				const aborted = options?.signal?.aborted || (error instanceof Error && error.name === "AbortError");
				output.stopReason = aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
			}
			stream.end();
		})();

		return stream;
	};

	return {
		stream: streamImpl,
		streamSimple: streamImpl,
	} as ProviderStreams;
}
