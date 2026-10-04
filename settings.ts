import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface PiMiniConfig {
	tiny: ModelRef;
	large?: ModelRef;
}

export const TINY_PROVIDER = "ollama";
export const TINY_MODEL_ID = "hf.co/mradermacher/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF:Q4_K_M";

export const OLLAMA_BASE_URL = "http://localhost:11434/v1";

function configPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "pi-mini.json");
}

export function defaultConfig(): PiMiniConfig {
	return { tiny: { provider: TINY_PROVIDER, modelId: TINY_MODEL_ID } };
}

export function loadConfig(): PiMiniConfig {
	const cfg = defaultConfig();
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));
		if (parsed && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			if (isModelRef(record.tiny)) cfg.tiny = record.tiny;
			if (isModelRef(record.large)) cfg.large = record.large;
		}
	} catch {
		// missing or malformed config: keep defaults
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
