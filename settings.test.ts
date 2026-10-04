import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CURATED_TOOLS,
	DEFAULT_DELEGATE_BUDGET,
	loadConfig,
	saveConfig,
	toolsForMode,
} from "./settings.ts";

const tmpFiles: string[] = [];

function useConfig(json: string | undefined): void {
	const file = path.join(os.tmpdir(), `pi-mini-test-${process.pid}-${tmpFiles.length}.json`);
	tmpFiles.push(file);
	process.env.PI_MINI_CONFIG = file;
	if (json !== undefined) fs.writeFileSync(file, json, "utf8");
}

afterEach(() => {
	delete process.env.PI_MINI_CONFIG;
});

describe("loadConfig", () => {
	test("missing config file yields granite defaults", () => {
		useConfig(undefined);
		const cfg = loadConfig();
		assert.equal(cfg.tiny.provider, "ollama-mini");
		assert.equal(cfg.tiny.modelId, "granite4.2:8b");
		assert.equal(cfg.think, false);
		assert.equal(cfg.toolsMode, "curated");
		assert.equal(cfg.delegateBudget, DEFAULT_DELEGATE_BUDGET);
	});

	test("retired default tiny model is migrated to granite, large preserved", () => {
		// The exact shape of a real ~/.pi/agent/pi-mini.json from a 2026-09 install.
		useConfig(
			JSON.stringify({
				tiny: {
					provider: "ollama",
					modelId: "hf.co/mradermacher/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF:Q4_K_M",
				},
				large: { provider: "minimax", modelId: "MiniMax-M3" },
			}),
		);
		const cfg = loadConfig();
		assert.deepEqual(cfg.tiny, { provider: "ollama-mini", modelId: "granite4.2:8b" });
		assert.deepEqual(cfg.large, { provider: "minimax", modelId: "MiniMax-M3" });
	});

	test("custom tiny model is left unchanged", () => {
		useConfig(
			JSON.stringify({
				tiny: { provider: "ollama", modelId: "hf.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:Q4_K_M" },
			}),
		);
		const cfg = loadConfig();
		assert.equal(cfg.tiny.modelId, "hf.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:Q4_K_M");
	});

	test("new fields parse and invalid values fall back", () => {
		useConfig(
			JSON.stringify({
				tiny: { provider: "ollama-mini", modelId: "granite4.2:8b" },
				think: true,
				toolsMode: "read-only",
				delegateBudget: 3.9,
			}),
		);
		const cfg = loadConfig();
		assert.equal(cfg.think, true);
		assert.equal(cfg.toolsMode, "read-only");
		assert.equal(cfg.delegateBudget, 3);

		useConfig(
			JSON.stringify({
				toolsMode: "everything",
				delegateBudget: -2,
				think: "yes",
			}),
		);
		const fallback = loadConfig();
		assert.equal(fallback.toolsMode, "curated");
		assert.equal(fallback.delegateBudget, DEFAULT_DELEGATE_BUDGET);
		assert.equal(fallback.think, false);
	});

	test("malformed json keeps defaults", () => {
		useConfig("{not json");
		const cfg = loadConfig();
		assert.equal(cfg.tiny.modelId, "granite4.2:8b");
	});

	test("saveConfig round-trips", () => {
		useConfig(undefined);
		const cfg = loadConfig();
		cfg.think = true;
		cfg.large = { provider: "minimax", modelId: "MiniMax-M3" };
		saveConfig(cfg);
		const reloaded = loadConfig();
		assert.deepEqual(reloaded, cfg);
	});
});

describe("toolsForMode", () => {
	const all = ["read", "write", "edit", "find", "grep", "bash", "ls", "delegate_to_worker"];

	test("curated keeps the coding set and drops write/ls", () => {
		assert.deepEqual(toolsForMode("curated", all), ["read", "edit", "find", "grep", "bash"]);
		assert.deepEqual(CURATED_TOOLS, ["read", "edit", "find", "grep", "bash"]);
	});

	test("read-only keeps read/find/grep", () => {
		assert.deepEqual(toolsForMode("read-only", all), ["read", "find", "grep"]);
	});

	test("all keeps everything", () => {
		assert.deepEqual(toolsForMode("all", all), all);
	});
});
