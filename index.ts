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
	type ModelRef,
} from "./settings.ts";
import { stripToolCallSpans } from "./wrapfix.ts";
import { installRepair } from "./repair.ts";
import {
	amendGoal,
	buildAuditMessages,
	buildGoalPromptBlock,
	cancelGoal,
	GoalStore,
	installGoalLoop,
	parseAuditResponse,
	startGoal,
	type AuditVerdict,
	type Goal,
	type GoalLoopPi,
} from "./goal-loop.ts";
import { showSettingsMenu, type SettingsMenuDeps } from "./mini-settings.ts";
import {
	ensureMiniContext,
	installMiniContext,
	refresh as refreshMiniContextModule,
	resolveInstructions,
} from "./mini-context.ts";
import { parseMiniCommand, type MiniGoalOp, type ParsedMiniCommand } from "./mini-command.ts";

export { parseMiniCommand, type MiniGoalOp, type ParsedMiniCommand } from "./mini-command.ts";

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
	/** One-shot notify when the composed system prompt had to drop blocks. */
	promptTrimNotified: boolean;
}

// Wrap-fix conversions per user turn. Dictated/repeated JSON text converts and
// executes once or twice, then further repeats are blocked so a model that
// re-emits its dictation after every tool result cannot loop executions forever.
const MAX_WRAPFIX_CONVERSIONS_PER_TURN = 2;

// Composed-prompt ceiling: base mini prompt + goal block (≤4096B) +
// mini-context block (≤4096B) must stay under this; blocks drop on overflow.
const PROMPT_COMPOSE_BUDGET = 6000;

const state: ModeState = {
	enabled: false,
	previousModel: undefined,
	previousTools: undefined,
	internalModelChange: false,
	delegations: 0,
	wrapfixCalls: 0,
	promptTrimNotified: false,
};

const USAGE =
	"Usage: /mini [on|off|tiny|large|status|settings|goal <objective>|goal amend <text>|goal cancel]";

/**
 * Shared goal ledger for /mini goal and the goal loop. Default location is
 * <cwd>/.pi/goals/goal_events.jsonl (goal-loop.ts GoalStore).
 */
const sharedGoalStore = new GoalStore();

// ---------------------------------------------------------------------------
// Mini-context prompt block cache. Recomputed on enable and on session_start
// (via refreshMiniContext below), never per turn; resolveInstructions failures
// resolve to an empty block so a broken context file can never break a turn.
// ---------------------------------------------------------------------------
let miniCtxBlockCache: string | null = null;
/** The exact ctx object installMiniContext was called with (WeakMap-keyed). */
let miniContextInstalledCtx: ExtensionContext | null = null;

function safeResolveMiniContext(cwd: string): string {
	try {
		return resolveInstructions({ cwd }).block;
	} catch {
		return "";
	}
}

function currentMiniContextBlock(cwd: string): string {
	if (miniCtxBlockCache === null) miniCtxBlockCache = safeResolveMiniContext(cwd);
	return miniCtxBlockCache;
}

/**
 * Re-check instruction files after enable / session start: run the module's
 * ensure pass (settle any summarize prompts) on the installed session ctx —
 * or directly on the given ctx when mini-context was not installed for it —
 * then refresh the cached prompt block.
 */
async function refreshMiniContext(ctx: ExtensionContext): Promise<void> {
	try {
		if (miniContextInstalledCtx) {
			await refreshMiniContextModule(miniContextInstalledCtx);
		} else {
			await ensureMiniContext(ctx, {
				cwd: ctx.cwd,
				cfg: loadConfig(),
				isEnabled: () => state.enabled,
			});
		}
	} catch (error) {
		ctx.ui.notify(
			`pi-mini: mini-context refresh failed: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
	miniCtxBlockCache = safeResolveMiniContext(ctx.cwd);
}

/**
 * goalAudit "worker" audit: hand the completion claims to the configured large
 * model through the same runWorker path the delegate_to_worker tool uses
 * (empty transcript — buildAuditMessages embeds everything the auditor needs),
 * then parse the AUDIT_VERDICT contract out of the worker's report.
 */
async function delegateAudit(goal: Goal): Promise<{ verdict: AuditVerdict; report: string }> {
	const cfg = loadConfig();
	if (!cfg.large) throw new Error("no large model configured, run /mini large");
	const [auditorSystem, auditorUser] = buildAuditMessages(goal);
	const result = await runWorker({
		large: cfg.large,
		task:
			`${auditorSystem}\n\n${auditorUser}\n\n` +
			"Reply with the exact line `AUDIT_VERDICT: approved` or `AUDIT_VERDICT: disapproved`, " +
			"followed by a short audit report (at most 5 sentences). When disapproved, end with a line " +
			"starting `CONTINUATION: ` followed by concrete next steps for the agent.",
		entries: [],
		cwd: process.cwd(),
	});
	if (!result.ok) throw new Error(`worker audit failed: ${result.text}`);
	const parsed = parseAuditResponse(result.text);
	return { verdict: parsed.verdict, report: parsed.report };
}

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
	// New module wiring. The extension factory only receives `pi`, so the
	// context-dependent installs (mini-context) capture the live session ctx
	// on session_start; repair's ctx param is documented as unused.
	// ---------------------------------------------------------------------
	installRepair(pi, undefined as unknown as ExtensionContext, {
		isEnabled: () => state.enabled,
		getConfig: loadConfig,
	});

	// Registered BEFORE index's own before_agent_start handler: pi chains
	// systemPrompt results across handlers, so this composes the goal block
	// underneath the composed mini prompt below (index's handler replaces the
	// chain wholesale and re-adds the goal block itself, deduplicated via the
	// "## Active Goal" marker guard). GoalLoopPi is the module's narrower
	// structural view of the same pi object.
	installGoalLoop(pi as unknown as GoalLoopPi, undefined, {
		isEnabled: () => state.enabled,
		getConfig: loadConfig,
		store: sharedGoalStore,
		delegateAudit,
	});

	// ---------------------------------------------------------------------
	// Session start: install mini-context on the live session ctx (first
	// session only; its ctx is WeakMap-keyed by refresh()), invalidate the
	// cached context block, and auto-enter mini mode when the persisted
	// config says so. Never throws into extension init.
	// ---------------------------------------------------------------------
	pi.on("session_start", (_event, sctx) => {
		miniCtxBlockCache = null;
		if (!miniContextInstalledCtx) {
			miniContextInstalledCtx = sctx;
			installMiniContext(pi, sctx, { getConfig: loadConfig, isEnabled: () => state.enabled });
		}
		if (loadConfig().enabled && !state.enabled) {
			void (async () => {
				try {
					await enable(pi, sctx as unknown as ExtensionCommandContext);
					if (state.enabled) sctx.ui.notify("pi-mini: auto-enabled from settings", "info");
				} catch (error) {
					sctx.ui.notify(
						`pi-mini: auto-enable failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
			})();
		}
	});

	// ---------------------------------------------------------------------
	// Per-turn system prompt replacement while mini mode is active:
	// MINI_SYSTEM_PROMPT + goal block (when a goal is active) + cached
	// <mini_context> block, with a size guard that drops the context block
	// first, then the goal block, notifying once per enable session.
	// ---------------------------------------------------------------------
	pi.on("before_agent_start", (event, ctx) => {
		if (!state.enabled) return undefined;
		if (!isTinyModel(ctx)) return undefined; // user overrode the model; leave the prompt alone

		let goalBlock = "";
		const goal = sharedGoalStore.current();
		// installGoalLoop's own chained handler may have composed the same block
		// already; never duplicate it.
		if (goal && !event.systemPrompt.includes("## Active Goal")) {
			try {
				goalBlock = buildGoalPromptBlock(goal);
			} catch {
				goalBlock = ""; // block could not fit its own budget: prompt stands without it
			}
		}
		const ctxBlock = currentMiniContextBlock(ctx.cwd);

		const compose = (g: string, c: string): string => [MINI_SYSTEM_PROMPT, g, c].filter(Boolean).join("\n\n");
		let prompt = compose(goalBlock, ctxBlock);
		let dropped: string | null = null;
		if (Buffer.byteLength(prompt, "utf8") > PROMPT_COMPOSE_BUDGET && ctxBlock) {
			prompt = compose(goalBlock, "");
			dropped = "mini-context";
		}
		if (Buffer.byteLength(prompt, "utf8") > PROMPT_COMPOSE_BUDGET && goalBlock) {
			prompt = MINI_SYSTEM_PROMPT;
			dropped = dropped ? `${dropped} + goal` : "goal";
		}
		if (dropped && !state.promptTrimNotified) {
			state.promptTrimNotified = true;
			ctx.ui.notify(
				`pi-mini: composed system prompt exceeds ${PROMPT_COMPOSE_BUDGET} bytes; ` +
					`dropped the ${dropped} block(s) for this session`,
				"warning",
			);
		}
		return { systemPrompt: prompt };
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
			const candidates = ["on", "off", "tiny", "large", "status", "settings", "goal", "goal amend", "goal cancel"];
			return candidates
				.filter((c) => c.startsWith(prefix.trim().toLowerCase()))
				.map((c) => ({ value: c, label: c, description: completionDescription(c) }));
		},
		handler: async (args, ctx) => {
			const parsed = parseMiniCommand(args);
			if (!parsed) {
				ctx.ui.notify(USAGE, "info");
				return;
			}
			if (parsed.goal) {
				await handleGoalCommand(pi, ctx, parsed.goal);
				return;
			}
			switch (parsed.sub) {
				case "":
					if (state.enabled) await disableAndReportGoal(pi, ctx, { restoreModel: true, notify: true });
					else await enable(pi, ctx);
					break;
				case "on":
					await enable(pi, ctx);
					break;
				case "off":
					await disableAndReportGoal(pi, ctx, { restoreModel: true, notify: true });
					break;
				case "tiny":
				case "large":
					await configureModel(pi, ctx, parsed.sub);
					break;
				case "status":
					reportStatus(ctx);
					break;
				case "settings":
					await showSettingsMenu(ctx, settingsMenuDeps(pi, ctx));
					break;
			}
		},
	});
}

/**
 * /mini goal handler: start/amend gate on mini mode (the loop's prompt seam
 * only exists while enabled); status/cancel work regardless. Kickoff steering
 * goes through pi.sendUserMessage as a steer message.
 */
async function handleGoalCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	goalCmd: { op: MiniGoalOp; text: string },
): Promise<void> {
	switch (goalCmd.op) {
		case "status": {
			const goal = sharedGoalStore.current();
			ctx.ui.notify(
				goal
					? `pi-mini: goal — ${goal.objective} (revision ${goal.revision}, ${goal.status})`
					: "pi-mini: no active goal",
				"info",
			);
			return;
		}
		case "cancel": {
			const goal = cancelGoal(sharedGoalStore);
			ctx.ui.notify(goal ? "pi-mini: goal cancelled" : "pi-mini: no active goal to cancel", "info");
			return;
		}
		case "amend": {
			if (!goalCmd.text) {
				ctx.ui.notify("Usage: /mini goal amend <text>", "info");
				return;
			}
			if (!state.enabled) {
				ctx.ui.notify("pi-mini: goal requires mini mode — run /mini on first", "warning");
				return;
			}
			const goal = amendGoal(sharedGoalStore, goalCmd.text);
			if (!goal) {
				ctx.ui.notify("pi-mini: no active goal to amend", "info");
				return;
			}
			pi.sendUserMessage(
				`The active goal was amended (now revision ${goal.revision}): ${goalCmd.text}\n` +
					"Re-check your open tasks against this amendment, then continue working toward the goal.",
				{ deliverAs: "steer" },
			);
			ctx.ui.notify(`pi-mini: goal amended (revision ${goal.revision})`, "info");
			return;
		}
		case "start": {
			if (!state.enabled) {
				ctx.ui.notify("pi-mini: goal requires mini mode — run /mini on first", "warning");
				return;
			}
			const goal = startGoal(sharedGoalStore, goalCmd.text);
			pi.sendUserMessage(
				`A goal is now active: ${goal.objective}\n` +
					"Work toward it autonomously using your tools. Track your tasks as you go. " +
					"When every blocking task is verifiably complete, end your reply with the exact line " +
					"`GOAL_STATUS: complete`. If you cannot proceed, emit `GOAL_STATUS: blocked — <reason>` instead.",
				{ deliverAs: "steer" },
			);
			ctx.ui.notify(`pi-mini: goal started (revision ${goal.revision})`, "info");
			return;
		}
	}
}

/**
 * /mini off (and the toggle-off path): keep the goal loop independent of mini
 * mode — it stays in the ledger — but tell the user how to stop it.
 */
async function disableAndReportGoal(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	opts: { restoreModel: boolean; notify: boolean },
): Promise<void> {
	await disable(pi, ctx, opts);
	const goal = sharedGoalStore.current();
	if (goal) ctx.ui.notify("pi-mini: goal still active; /mini goal cancel to stop", "info");
}

/**
 * Dependencies the settings menu needs from the session: the enable toggle
 * persists cfg.enabled and applies the transition; applyTinyModel persists
 * the ref and live-switches through the same guarded setModel path
 * configureModel uses (provider re-registration for ollama-mini refs);
 * applyLargeModel only persists (no live switch, matching configureModel).
 */
function settingsMenuDeps(pi: ExtensionAPI, ctx: ExtensionCommandContext): SettingsMenuDeps {
	return {
		getConfig: loadConfig,
		isEnabled: () => state.enabled,
		setEnabled: async (on) => {
			saveConfig({ ...loadConfig(), enabled: on });
			if (on) await enable(pi, ctx);
			else await disable(pi, ctx, { restoreModel: true, notify: true });
		},
		applyTinyModel: async (ref: ModelRef) => {
			const cfg = loadConfig();
			cfg.tiny = ref;
			saveConfig(cfg);
			if (state.enabled) {
				let model = ctx.modelRegistry.find(ref.provider, ref.modelId);
				if (!model && ref.provider === TINY_PROVIDER) {
					registerTinyProvider(pi, cfg);
					model = ctx.modelRegistry.find(ref.provider, ref.modelId);
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
		},
		applyLargeModel: async (ref: ModelRef) => {
			saveConfig({ ...loadConfig(), large: ref });
		},
	};
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
			return "Show current pi-mini state (incl. goal, repair, context)";
		case "settings":
			return "Open the settings menu (enable toggle + model pickers)";
		case "goal":
			return "Start an autonomous goal loop (usage: /mini goal <objective>)";
		case "goal amend":
			return "Amend the active goal with steering text (bumps revision)";
		case "goal cancel":
			return "Cancel the active goal loop";
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

	// Warn when the tiny model skips the native pipeline (no think:false,
	// wrap-fix, or watchdog outside the ollama-mini provider).
	if (cfg.tiny.provider !== TINY_PROVIDER) {
		ctx.ui.notify(
			"pi-mini: note — think:false, wrap-fix, and the stall watchdog only apply to ollama-mini models; " +
				`${formatRef(cfg.tiny)} runs on its provider's stock API`,
			"warning",
		);
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
	state.promptTrimNotified = false;
	updateStatus(ctx);
	// Settle any pending mini-context summarize prompts and refresh the cached
	// prompt block (covers /mini on, /mini settings enable, and auto-start).
	void refreshMiniContext(ctx).catch(() => {});
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

	if (which === "tiny" && chosen.provider !== TINY_PROVIDER) {
		ctx.ui.notify(
			"pi-mini: note — think:false, wrap-fix, and the stall watchdog only apply to ollama-mini models; " +
				`${formatRef(chosen)} runs on its provider's stock API`,
			"warning",
		);
	}

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
	const goal = sharedGoalStore.current();
	const objective = goal ? goal.objective : null;
	lines.push(
		`goal: ${goal ? `${objective && objective.length > 60 ? `${objective.slice(0, 60)}…` : objective} (rev ${goal.revision}, ${goal.status})` : "none"}`,
	);
	lines.push(
		`repair: tool-result repair on (≤${cfg.repairMaxAttemptsPerCall}/call, ≤${cfg.repairMaxPerTurn}/turn)`,
	);
	lines.push(
		`mini-context: ${
			miniCtxBlockCache === null
				? "not evaluated yet this session"
				: miniCtxBlockCache
					? `${Buffer.byteLength(miniCtxBlockCache, "utf8")}B in system prompt`
					: "nothing to inject"
		}`,
	);
	if (state.enabled) lines.push(`delegations this turn: ${state.delegations}`);
	ctx.ui.notify(lines.join("\n"), "info");
}
