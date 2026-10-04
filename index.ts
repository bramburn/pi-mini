import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { runWorker } from "./delegate.ts";
import { extractDelegate, stripDelegateBlocks } from "./parser.ts";
import { pickModelRef } from "./picker.ts";
import {
	formatRef,
	loadConfig,
	OLLAMA_BASE_URL,
	saveConfig,
	TINY_MODEL_ID,
	TINY_PROVIDER,
} from "./settings.ts";

/**
 * pi-mini: run a tiny local LLM as the session model with zero tools and a
 * minimal system prompt. It answers directly or delegates work by emitting a
 * ```json {"task": "..."} block, which this extension executes via a pi
 * subprocess running the configured large model with the full session
 * transcript as context. Toggling off restores the previous model and tools.
 */

const MAX_DELEGATIONS_PER_TURN = 8;

const MINI_SYSTEM_PROMPT = `You are an orchestrator agent running on a small local language model. You have no tools. You cannot read files, edit files, or run commands yourself.

For each user request decide:
1. If it needs no actions (questions, discussion, explanations), answer directly and briefly.
2. If it requires any action (reading files, writing or editing code, running commands, searching, or anything you cannot answer from this conversation alone), delegate it by replying with exactly one fenced code block and no other text:
\`\`\`json
{ "task": "complete, self-contained instructions for the worker" }
\`\`\`
The worker is a powerful agent with full tool access and this entire conversation as context. The worker result is delivered back to you as a user message; relay or summarize it for the user. Never invent worker results.`;

interface ModeState {
	enabled: boolean;
	previousModel: Model<any> | undefined;
	previousTools: string[] | undefined;
	internalModelChange: boolean;
	pendingTask: string | undefined;
	delegations: number;
}

const state: ModeState = {
	enabled: false,
	previousModel: undefined,
	previousTools: undefined,
	internalModelChange: false,
	pendingTask: undefined,
	delegations: 0,
};

export default function (pi: ExtensionAPI) {
	// ---------------------------------------------------------------------
	// Per-turn system prompt replacement while mini mode is active.
	// ---------------------------------------------------------------------
	pi.on("before_agent_start", (_event, ctx) => {
		if (!state.enabled) return undefined;
		if (!isTinyModel(ctx)) return undefined; // user overrode the model; leave the prompt alone
		return { systemPrompt: MINI_SYSTEM_PROMPT };
	});

	// ---------------------------------------------------------------------
	// Capture delegate blocks from assistant text, and hide the raw block
	// from the transcript (message_end can replace the finalized message).
	// ---------------------------------------------------------------------
	pi.on("message_end", (event, ctx) => {
		if (!state.enabled) return undefined;
		if (event.message.role !== "assistant") return undefined;
		const text = event.message.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text)
			.join("\n");
		const request = extractDelegate(text);
		if (!request) return undefined;

		state.pendingTask = request.task;
		const cleaned = stripDelegateBlocks(text);
		const nonText = event.message.content.filter((p) => p.type !== "text");
		const content = cleaned
			? [{ type: "text" as const, text: cleaned }, ...nonText]
			: nonText.length > 0
				? nonText
				: [{ type: "text" as const, text: "(delegated to the worker model)" }];
		return { message: { ...event.message, content } };
	});

	// ---------------------------------------------------------------------
	// After the orchestrator settles, run the delegation if one was parsed.
	// ---------------------------------------------------------------------
	pi.on("agent_settled", async (_event, ctx) => {
		if (!state.enabled) return;
		const task = state.pendingTask;
		state.pendingTask = undefined;
		if (!task) return;

		if (state.delegations >= MAX_DELEGATIONS_PER_TURN) {
			ctx.ui.notify(`pi-mini: delegation limit (${MAX_DELEGATIONS_PER_TURN}) reached`, "warning");
			pi.sendUserMessage(
				"[pi-mini] The delegation limit for this turn was reached. Stop delegating and give the user " +
					"a brief status summary of what has been done so far.",
			);
			return;
		}

		const cfg = loadConfig();
		if (!cfg.large) {
			ctx.ui.notify("pi-mini: no large model configured, run /mini large", "error");
			return;
		}

		state.delegations += 1;
		updateStatus(ctx, `worker running (delegation #${state.delegations})…`);
		try {
			const result = await runWorker({
				large: cfg.large,
				task,
				entries: ctx.sessionManager.getEntries(),
				cwd: ctx.cwd,
				signal: ctx.signal,
			});
			updateStatus(ctx);
			pi.sendUserMessage(
				result.ok
					? `[worker result]\n${result.text}`
					: `[worker failed]\n${result.text}\nTell the user the worker failed and summarize what you know.`,
			);
		} catch (err) {
			updateStatus(ctx);
			ctx.ui.notify(`pi-mini: worker error: ${String(err)}`, "error");
		}
	});

	// ---------------------------------------------------------------------
	// Reset the per-turn delegation counter on real user input.
	// ---------------------------------------------------------------------
	pi.on("input", (event, _ctx) => {
		if (state.enabled && (event.source === "interactive" || event.source === "rpc")) {
			state.delegations = 0;
		}
		return undefined;
	});

	// Drop any half-captured delegate block when a new turn begins (e.g. the
	// previous turn was aborted before agent_settled could consume it).
	pi.on("turn_start", (_event, _ctx) => {
		state.pendingTask = undefined;
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
		description: "Mini orchestrator mode: tiny local LLM delegates tool work to a large model",
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
			return "Enable mini mode (tiny orchestrator model)";
		case "off":
			return "Disable mini mode, restore previous model and tools";
		case "tiny":
			return "Pick the tiny orchestrator model";
		case "large":
			return "Pick the large worker model";
		case "status":
			return "Show current pi-mini state";
		default:
			return "";
	}
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
	const base = `MINI ${shortId(cfg.tiny.modelId)} → ${cfg.large ? shortId(cfg.large.modelId) : "?"}`;
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

	const tinyModel = resolveTinyModel(pi, ctx);
	if (!tinyModel) return;
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

	pi.setActiveTools([]);
	state.enabled = true;
	state.delegations = 0;
	state.pendingTask = undefined;
	updateStatus(ctx);
	ctx.ui.notify(
		`pi-mini: ON — orchestrator ${formatRef(cfg.tiny)}, worker ${formatRef(cfg.large)}, zero tools, ` +
			`delegation via json block`,
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
	state.pendingTask = undefined;
	state.delegations = 0;
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
		const model = ctx.modelRegistry.find(chosen.provider, chosen.modelId);
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
		`large: ${cfg.large ? formatRef(cfg.large) : "(unset, defaults to current model on /mini on)"}`,
	];
	if (state.enabled) lines.push(`delegations this turn: ${state.delegations}`);
	ctx.ui.notify(lines.join("\n"), "info");
}

function resolveTinyModel(pi: ExtensionAPI, ctx: ExtensionContext): Model<any> | undefined {
	const cfg = loadConfig();
	const existing = ctx.modelRegistry.find(cfg.tiny.provider, cfg.tiny.modelId);
	if (existing) return existing;

	if (cfg.tiny.provider !== TINY_PROVIDER || cfg.tiny.modelId !== TINY_MODEL_ID) {
		ctx.ui.notify(`pi-mini: tiny model ${formatRef(cfg.tiny)} not found in the model registry`, "error");
		return undefined;
	}

	// The default tiny model is not configured yet. Only auto-register when no
	// ollama provider exists at all, because registering models replaces the
	// provider's catalogue.
	const hasOllamaProvider = ctx.modelRegistry.getAll().some((m) => m.provider === TINY_PROVIDER);
	if (hasOllamaProvider) {
		ctx.ui.notify(
			`pi-mini: add this to ~/.pi/agent/models.json providers.ollama.models:\n` +
				`{ "id": "${TINY_MODEL_ID}" }`,
			"error",
		);
		return undefined;
	}
	pi.registerProvider(TINY_PROVIDER, {
		name: "Ollama (pi-mini)",
		baseUrl: OLLAMA_BASE_URL,
		apiKey: "ollama",
		api: "openai-completions",
		models: [
			{
				id: TINY_MODEL_ID,
				name: "Qwen2.5-Coder-7B abliterated Q4_K_M (pi-mini orchestrator)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32768,
				maxTokens: 8192,
			},
		],
	});
	const registered = ctx.modelRegistry.find(TINY_PROVIDER, TINY_MODEL_ID);
	if (!registered) {
		ctx.ui.notify("pi-mini: failed to register the ollama tiny model", "error");
		return undefined;
	}
	return registered;
}
