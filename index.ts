import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createProvider, Type, type Model } from "@earendil-works/pi-ai";
import { runWorker } from "./delegate.ts";
import { stripDelegateBlocks } from "./parser.ts";
import { pickModelRef } from "./picker.ts";
import { ollamaNativeApi } from "./ollama-native.ts";
import {
	DELEGATE_TOOL,
	formatRef,
	loadConfig,
	OLLAMA_BASE_URL,
	saveConfig,
	TINY_CONTEXT_WINDOW,
	TINY_MAX_TOKENS,
	TINY_MODEL_ID,
	TINY_PROVIDER,
	toolsForMode,
} from "./settings.ts";
import { stripToolCallSpans } from "./wrapfix.ts";

/**
 * pi-mini: run a tiny local LLM as the session model with pi's native agentic
 * tool loop (read/edit/find/grep/bash) plus a delegate_to_worker escape hatch
 * that hands large work to a configured large model (full pi worker subprocess).
 *
 * The tiny model speaks Ollama's native /api/chat through ollama-native.ts,
 * which enforces think:false and repairs text-wrapped/truncated tool calls back
 * into real toolCall blocks (the json-call/tool-call wrap-fix), so the standard
 * tool_use -> tool_result -> continue loop works even when the model degrades.
 * Toggling off restores the previous model and tools.
 */

const MINI_SYSTEM_PROMPT = `You are a capable coding agent running on a small local model. You complete tasks with your tools (read, edit, find, grep, bash) and, when needed, by delegating to a powerful worker.

Guidelines:
- Use your native tool-call function for every tool call; one call per step, minimal and precise.
- EXCEPTION: when the user explicitly asks you to output, dictate, or repeat text or JSON verbatim (a dictation, transcription, or formatting request), comply in plain text and do not call tools.
- Prefer direct tool calls for small, well-specified steps.
- For large, multi-file, or long-running work, call ${DELEGATE_TOOL} with complete, self-contained instructions; its report returns as a tool result you can relay.
- Never fabricate tool results; wait for the real ones.
- When the work is done, reply with a brief summary of what changed.`;

interface ModeState {
	enabled: boolean;
	previousModel: Model<any> | undefined;
	previousTools: string[] | undefined;
	internalModelChange: boolean;
	delegations: number;
	wrapfixCalls: number;
}

// Wrap-fix conversions per user turn. Dictated/repeated JSON text converts and
// executes once or twice, then further repeats are blocked so a model that
// re-emits its dictation after every tool result cannot loop executions forever.
const MAX_WRAPFIX_CONVERSIONS_PER_TURN = 2;

const state: ModeState = {
	enabled: false,
	previousModel: undefined,
	previousTools: undefined,
	internalModelChange: false,
	delegations: 0,
	wrapfixCalls: 0,
};

export default function (pi: ExtensionAPI) {
	// ---------------------------------------------------------------------
	// Provider + delegate tool registration (also refreshed on /mini on so
	// think toggles in config take effect).
	// ---------------------------------------------------------------------
	registerTinyProvider(pi, loadConfig());

	pi.registerTool({
		name: DELEGATE_TOOL,
		label: "Delegate to worker",
		description:
			"Delegate a large or complex task to a powerful worker model with full tool access. " +
			"The worker sees this entire conversation; its final report is returned as the tool result. " +
			"Use for multi-file, long-running, or hard tasks; prefer your own tools for small steps.",
		parameters: Type.Object({
			task: Type.String({ description: "Complete, self-contained instructions for the worker" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cfg = loadConfig();
			if (!cfg.large) {
				return {
					content: [{ type: "text", text: "[worker failed] no large model configured, run /mini large" }],
					details: { ok: false },
					isError: true,
				};
			}
			const result = await runWorker({
				large: cfg.large,
				task: params.task,
				entries: ctx.sessionManager.getEntries(),
				cwd: ctx.cwd,
				signal,
			});
			return {
				content: [
					{ type: "text", text: result.ok ? `[worker result]\n${result.text}` : `[worker failed]\n${result.text}` },
				],
				details: { ok: result.ok },
				isError: !result.ok,
			};
		},
	});

	// ---------------------------------------------------------------------
	// Per-turn system prompt replacement while mini mode is active.
	// ---------------------------------------------------------------------
	pi.on("before_agent_start", (_event, ctx) => {
		if (!state.enabled) return undefined;
		if (!isTinyModel(ctx)) return undefined; // user overrode the model; leave the prompt alone
		return { systemPrompt: MINI_SYSTEM_PROMPT };
	});

	// ---------------------------------------------------------------------
	// Budgets: wrap-fix conversions (executions of converted text calls) and
	// delegate_to_worker calls are both capped per user turn; past the cap the
	// call is blocked with a self-correcting reason.
	// ---------------------------------------------------------------------
	pi.on("tool_call", (event, ctx) => {
		if (!state.enabled) return undefined;
		if (String(event.toolCallId).startsWith("wrapfix_call_")) {
			state.wrapfixCalls += 1;
			if (state.wrapfixCalls > MAX_WRAPFIX_CONVERSIONS_PER_TURN) {
				return {
					block: true,
					terminate: true,
					reason:
						"This call was converted from text you emitted again after the same call already executed. " +
						"Stop repeating the JSON block and finish your turn with a normal reply.",
				};
			}
			return undefined;
		}
		if (event.toolName !== DELEGATE_TOOL) return undefined;
		const cfg = loadConfig();
		state.delegations += 1;
		updateStatus(ctx);
		if (state.delegations > cfg.delegateBudget) {
			return {
				block: true,
				reason:
					`The ${DELEGATE_TOOL} budget for this turn (${cfg.delegateBudget}) is reached. ` +
					"Finish with your own tools and give the user a brief status summary.",
			};
		}
		updateStatus(ctx, `worker running (delegation #${state.delegations})…`);
		return undefined;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!state.enabled) return;
		updateStatus(ctx);
	});

	// ---------------------------------------------------------------------
	// Display cleanup only: strip stray delegate blocks and any text-wrapped
	// tool calls that the stream-level wrap-fix did not convert. Tool-call
	// semantics live in ollama-native.ts now.
	// ---------------------------------------------------------------------
	pi.on("message_end", (event, ctx) => {
		if (!state.enabled) return undefined;
		if (event.message.role !== "assistant") return undefined;
		const activeTools = new Set(pi.getActiveTools());
		let changed = false;
		const content = event.message.content.map((part) => {
			if (part.type !== "text") return part;
			const cleaned = stripToolCallSpans(stripDelegateBlocks(part.text), activeTools);
			if (cleaned !== part.text) {
				changed = true;
				return { ...part, text: cleaned };
			}
			return part;
		});
		return changed ? { message: { ...event.message, content } } : undefined;
	});

	// ---------------------------------------------------------------------
	// Reset the per-turn delegate budget on real user input.
	// ---------------------------------------------------------------------
	pi.on("input", (event, _ctx) => {
		if (state.enabled && (event.source === "interactive" || event.source === "rpc")) {
			state.delegations = 0;
			state.wrapfixCalls = 0;
		}
		return undefined;
	});

	// ---------------------------------------------------------------------
	// If the user switches models manually while mini mode is on, leave
	// mini mode (keep their model choice, restore the full tool set).
	// ---------------------------------------------------------------------
	pi.on("model_select", (event, ctx) => {
		if (!state.enabled || state.internalModelChange) return;
		const tiny = loadConfig().tiny;
		if (event.model.provider === tiny.provider && event.model.id === tiny.modelId) return;
		disable(pi, ctx, { restoreModel: false, notify: false });
		ctx.ui.notify("pi-mini: model changed manually, mini mode off", "info");
	});

	// ---------------------------------------------------------------------
	// /mini command
	// ---------------------------------------------------------------------
	pi.registerCommand("mini", {
		description: "Mini mode: tiny local LLM on the native tool loop, delegating large work to a worker",
		getArgumentCompletions: (prefix) => {
			const candidates = ["on", "off", "tiny", "large", "status"];
			return candidates
				.filter((c) => c.startsWith(prefix.trim().toLowerCase()))
				.map((c) => ({ value: c, label: c, description: completionDescription(c) }));
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			switch (sub) {
				case "":
					if (state.enabled) await disable(pi, ctx, { restoreModel: true, notify: true });
					else await enable(pi, ctx);
					break;
				case "on":
					await enable(pi, ctx);
					break;
				case "off":
					await disable(pi, ctx, { restoreModel: true, notify: true });
					break;
				case "tiny":
				case "large":
					await configureModel(pi, ctx, sub);
					break;
				case "status":
					reportStatus(ctx);
					break;
				default:
					ctx.ui.notify("Usage: /mini [on|off|tiny|large|status]", "info");
			}
		},
	});
}

function completionDescription(candidate: string): string {
	switch (candidate) {
		case "on":
			return "Enable mini mode (tiny model on the native tool loop)";
		case "off":
			return "Disable mini mode, restore previous model and tools";
		case "tiny":
			return "Pick the tiny model";
		case "large":
			return "Pick the large worker model";
		case "status":
			return "Show current pi-mini state";
		default:
			return "";
	}
}

/**
 * Register (or refresh) the native Ollama provider that backs the tiny model.
 * Distinct provider id so the user's own "ollama" catalogue is never replaced.
 */
function registerTinyProvider(pi: ExtensionAPI, cfg: ReturnType<typeof loadConfig>): void {
	const provider = createProvider({
		id: TINY_PROVIDER,
		name: "Ollama (pi-mini)",
		baseUrl: OLLAMA_BASE_URL,
		auth: {
			apiKey: {
				name: "Ollama local server",
				resolve: () => ({ auth: { apiKey: "ollama" }, source: "local Ollama server" }),
			},
		},
		models: [
			{
				id: TINY_MODEL_ID,
				name: "Granite 4.2 8B (pi-mini orchestrator)",
				api: "ollama-native",
				provider: TINY_PROVIDER,
				baseUrl: OLLAMA_BASE_URL,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: TINY_CONTEXT_WINDOW,
				maxTokens: TINY_MAX_TOKENS,
			},
		],
		api: ollamaNativeApi({ baseUrl: OLLAMA_BASE_URL, think: cfg.think }),
	});
	try {
		pi.unregisterProvider(TINY_PROVIDER);
	} catch {
		// first registration: nothing to remove
	}
	pi.registerProvider(provider);
}

function isTinyModel(ctx: ExtensionContext): boolean {
	const tiny = loadConfig().tiny;
	return !!ctx.model && ctx.model.provider === tiny.provider && ctx.model.id === tiny.modelId;
}

function updateStatus(ctx: ExtensionContext, override?: string): void {
	if (!state.enabled) {
		ctx.ui.setStatus("pi-mini", undefined);
		return;
	}
	const cfg = loadConfig();
	const think = cfg.think ? ", think" : "";
	const base = `MINI ${shortId(cfg.tiny.modelId)} → ${cfg.large ? shortId(cfg.large.modelId) : "?"} (${cfg.toolsMode}${think})`;
	ctx.ui.setStatus("pi-mini", override ?? base);
}

function shortId(modelId: string): string {
	return modelId.length > 24 ? `${modelId.slice(0, 24)}…` : modelId;
}

async function enable(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (state.enabled) {
		ctx.ui.notify("pi-mini: already enabled", "info");
		return;
	}
	const cfg = loadConfig();
	if (!cfg.large) {
		if (!ctx.model) {
			ctx.ui.notify("pi-mini: no large model configured and no current model; run /mini large first", "error");
			return;
		}
		cfg.large = { provider: ctx.model.provider, modelId: ctx.model.id };
		saveConfig(cfg);
		ctx.ui.notify(`pi-mini: large worker defaults to current model (${formatRef(cfg.large)})`, "info");
	}

	// Refresh the provider so a changed think flag takes effect, then resolve
	// the configured tiny model (custom refs resolve through the registry).
	registerTinyProvider(pi, cfg);
	let tinyModel = ctx.modelRegistry.find(cfg.tiny.provider, cfg.tiny.modelId);
	if (!tinyModel && cfg.tiny.provider === TINY_PROVIDER && cfg.tiny.modelId === TINY_MODEL_ID) {
		ctx.ui.notify("pi-mini: default tiny model not found in the registry", "error");
		return;
	}
	if (!tinyModel) {
		ctx.ui.notify(`pi-mini: tiny model ${formatRef(cfg.tiny)} not found in the model registry, run /mini tiny`, "error");
		return;
	}
	const largeModel = ctx.modelRegistry.find(cfg.large.provider, cfg.large.modelId);
	if (!largeModel) {
		ctx.ui.notify(`pi-mini: large model ${formatRef(cfg.large)} not found, run /mini large`, "error");
		return;
	}

	state.previousModel = ctx.model;
	state.previousTools = pi.getActiveTools();
	state.internalModelChange = true;
	let ok = false;
	try {
		ok = await pi.setModel(tinyModel);
	} finally {
		state.internalModelChange = false;
	}
	if (!ok) {
		ctx.ui.notify("pi-mini: could not switch to the tiny model (auth/config issue)", "error");
		return;
	}

	// Never an empty tool set: the tiny model drives pi's native tool loop.
	const allNames = pi.getAllTools().map((tool) => tool.name);
	const wanted = toolsForMode(cfg.toolsMode, allNames);
	pi.setActiveTools([...new Set([...wanted, DELEGATE_TOOL])]);

	state.enabled = true;
	state.delegations = 0;
	state.wrapfixCalls = 0;
	updateStatus(ctx);
	ctx.ui.notify(
		`pi-mini: ON — tiny ${formatRef(cfg.tiny)} on the native tool loop ` +
			`(${[...new Set([...wanted, DELEGATE_TOOL])].join(", ")}), worker ${formatRef(cfg.large)}, think ${cfg.think ? "on" : "off"}`,
		"info",
	);
}

async function disable(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: { restoreModel: boolean; notify: boolean },
): Promise<void> {
	if (!state.enabled) {
		if (opts.notify) ctx.ui.notify("pi-mini: already disabled", "info");
		return;
	}
	state.enabled = false;
	state.delegations = 0;
	state.wrapfixCalls = 0;
	if (state.previousTools) pi.setActiveTools(state.previousTools);
	if (opts.restoreModel && state.previousModel) {
		state.internalModelChange = true;
		try {
			await pi.setModel(state.previousModel);
		} finally {
			state.internalModelChange = false;
		}
	}
	state.previousModel = undefined;
	state.previousTools = undefined;
	ctx.ui.setStatus("pi-mini", undefined);
	if (opts.notify) ctx.ui.notify("pi-mini: OFF, previous model and tools restored", "info");
}

async function configureModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	which: "tiny" | "large",
): Promise<void> {
	const cfg = loadConfig();
	const current = which === "tiny" ? cfg.tiny : cfg.large;
	const chosen = await pickModelRef(ctx, `Select ${which} model${current ? ` (current: ${formatRef(current)})` : ""}`);
	if (!chosen) return;
	if (which === "tiny") cfg.tiny = chosen;
	else cfg.large = chosen;
	saveConfig(cfg);

	if (which === "tiny" && state.enabled) {
		let model = ctx.modelRegistry.find(chosen.provider, chosen.modelId);
		if (!model && chosen.provider === TINY_PROVIDER) {
			registerTinyProvider(pi, cfg);
			model = ctx.modelRegistry.find(chosen.provider, chosen.modelId);
		}
		if (model) {
			state.internalModelChange = true;
			try {
				await pi.setModel(model);
			} finally {
				state.internalModelChange = false;
			}
		}
	}
	updateStatus(ctx);
	ctx.ui.notify(`pi-mini: ${which} model set to ${formatRef(chosen)}`, "info");
}

function reportStatus(ctx: ExtensionCommandContext): void {
	const cfg = loadConfig();
	const lines = [
		`mini mode: ${state.enabled ? "ON" : "OFF"}`,
		`tiny: ${formatRef(cfg.tiny)}`,
		`large: ${cfg.large ? formatRef(cfg.large): "(unset, defaults to current model on /mini on)"}`,
		`think: ${cfg.think ? "on" : "off"}`,
		`tools: ${cfg.toolsMode}`,
		`delegate budget: ${cfg.delegateBudget}/turn`,
	];
	if (state.enabled) lines.push(`delegations this turn: ${state.delegations}`);
	ctx.ui.notify(lines.join("\n"), "info");
}
