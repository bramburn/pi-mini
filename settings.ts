import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ModelRef {
	provider: string;
	modelId: string;
}

export type ToolsMode = "curated" | "all" | "read-only";

export interface PiMiniConfig {
	tiny: ModelRef;
	large?: ModelRef;
	/** Granite-style thinking toggle for the tiny model. Off by default: thinking
	 * cripples interactive tool loops on local models (~10x latency). */
	think: boolean;
	/** Which tools the tiny model gets in mini mode (delegate_to_worker is always added). */
	toolsMode: ToolsMode;
	/** Max delegate_to_worker calls per user turn. */
	delegateBudget: number;
}

// Native Ollama provider owned by pi-mini. Kept distinct from the user's own
// "ollama" provider so registration never clobbers that catalogue, and because
// only this provider enforces think:false + the wrap-fix stream.
export const TINY_PROVIDER = "ollama-mini";
export const TINY_MODEL_ID = "granite4.2:8b";
export const OLLAMA_BASE_URL = "http://localhost:11434";
export const TINY_CONTEXT_WINDOW = 131_072;
export const TINY_MAX_TOKENS = 8_192;

export const DELEGATE_TOOL = "delegate_to_worker";
export const DEFAULT_DELEGATE_BUDGET = 8;

/** pi built-in tool names for the curated sets (glob-style search is pi's "find"). */
export const CURATED_TOOLS = ["read", "edit", "find", "grep", "bash"];
export const READ_ONLY_TOOLS = ["read", "find", "grep"];

// The retired default tiny model (Qwen2.5-Coder via the compat "ollama" provider).
// Configs still pointing at it are migrated to the native granite default.
const LEGACY_TINY: ModelRef = {
	provider: "ollama",
	modelId: "hf.co/mradermacher/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF:Q4_K_M",
};

export function configPath(): string {
	return process.env.PI_MINI_CONFIG ?? path.join(os.homedir(), ".pi", "agent", "pi-mini.json");
}

export function defaultConfig(): PiMiniConfig {
	return {
		tiny: { provider: TINY_PROVIDER, modelId: TINY_MODEL_ID },
		think: false,
		toolsMode: "curated",
		delegateBudget: DEFAULT_DELEGATE_BUDGET,
	};
}

/** Resolve the active tool names for the configured mode from all registered tools. */
export function toolsForMode(mode: ToolsMode, allTools: readonly string[]): string[] {
	switch (mode) {
		case "all":
			return [...allTools];
		case "read-only":
			return allTools.filter((name) => READ_ONLY_TOOLS.includes(name));
		default:
			return allTools.filter((name) => CURATED_TOOLS.includes(name));
	}
}

export function loadConfig(): PiMiniConfig {
	const cfg = defaultConfig();
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));
		if (parsed && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			if (isModelRef(record.tiny)) cfg.tiny = record.tiny;
			if (isModelRef(record.large)) cfg.large = record.large;
			if (typeof record.think === "boolean") cfg.think = record.think;
			if (record.toolsMode === "curated" || record.toolsMode === "all" || record.toolsMode === "read-only") {
				cfg.toolsMode = record.toolsMode;
			}
			if (typeof record.delegateBudget === "number" && record.delegateBudget >= 1) {
				cfg.delegateBudget = Math.floor(record.delegateBudget);
			}
		}
	} catch {
		// missing or malformed config: keep defaults
	}
	// Migrate the retired default tiny model to the native granite default; its
	// old provider/model pairing no longer exists on typical Ollama installs.
	if (cfg.tiny.provider === LEGACY_TINY.provider && cfg.tiny.modelId === LEGACY_TINY.modelId) {
		cfg.tiny = defaultConfig().tiny;
	}
	return cfg;
}

export function saveConfig(cfg: PiMiniConfig): void {
	try {
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	} catch {
		// best effort persistence
	}
}

export function formatRef(ref: ModelRef): string {
	return `${ref.provider}/${ref.modelId}`;
}

function isModelRef(value: unknown): value is ModelRef {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as ModelRef).provider === "string" &&
		typeof (value as ModelRef).modelId === "string"
	);
}
