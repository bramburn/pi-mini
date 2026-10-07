// Unit tests for the settings-page reference logic in ./lib/settings-page.mjs.
// Pure logic only — no live model, no pi runtime (auto-discovered by node --test).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CONFIG_VNEXT,
	DEFAULT_TINY_REF,
	filterModels,
	isLocalModel,
	mergeModelSources,
	moveSelection,
	parseConfigVNext,
	parseConfigVNextJson,
	serializeConfig,
	visibleWindow,
	PICKER_MAX_VISIBLE,
} from "./lib/settings-page.mjs";

// ---------------------------------------------------------------------------
// (1) isLocalModel — the spec'd decision table
// ---------------------------------------------------------------------------

describe("isLocalModel", () => {
	test("/api/tags entries are local regardless of shape", () => {
		assert.equal(isLocalModel({ name: "granite4.2:8b" }, "ollama-tags"), true);
		assert.equal(isLocalModel({ name: "anything-at-all" }, "ollama-tags"), true);
	});

	test("ollama-mini provider is local", () => {
		assert.equal(isLocalModel({ provider: "ollama-mini", modelId: "granite4.2:8b" }, "registry"), true);
	});

	test("ollama provider is local", () => {
		assert.equal(isLocalModel({ provider: "ollama", modelId: "llama3.2:3b" }, "registry"), true);
	});

	test("llama-cpp provider is local", () => {
		assert.equal(isLocalModel({ provider: "llama-cpp", modelId: "drafts:7b" }, "registry"), true);
	});

	test("minimax/openai/anthropic-class providers are remote", () => {
		for (const provider of ["minimax", "openai", "anthropic"]) {
			assert.equal(isLocalModel({ provider, modelId: "M3" }, "registry"), false, provider);
		}
	});

	test("garbage entries are remote", () => {
		assert.equal(isLocalModel(null, "registry"), false);
		assert.equal(isLocalModel({}, "registry"), false);
		assert.equal(isLocalModel({ provider: 42 }, "registry"), false);
	});
});

// ---------------------------------------------------------------------------
// (2) mergeModelSources
// ---------------------------------------------------------------------------

const TAGS = [
	{ name: "granite4.2:8b", model: "granite4.2:8b" },
	{ name: "llama3.2:3b", model: "llama3.2:3b" },
];

describe("mergeModelSources", () => {
	test("tags become ollama/ entries sourced ollama-tags, pulled", () => {
		const merged = mergeModelSources(TAGS, []);
		assert.deepEqual(
			merged.map((e) => [e.provider, e.modelId, e.source, e.pulled]),
			[
				["ollama", "granite4.2:8b", "ollama-tags", true],
				["ollama", "llama3.2:3b", "ollama-tags", true],
			],
		);
	});

	test("remote registry entries are excluded, local ones kept as registry-sourced", () => {
		const registry = [
			{ provider: "ollama-mini", id: "granite4.2:8b", name: "Granite 4.2 8B (pi-mini orchestrator)" },
			{ provider: "llama-cpp", id: "drafts:7b" },
			{ provider: "minimax", id: "MiniMax-M3" },
		];
		const merged = mergeModelSources([], registry);
		assert.deepEqual(
			merged.map((e) => [e.provider, e.modelId, e.source, e.pulled]),
			[
				["llama-cpp", "drafts:7b", "registry", false],
				["ollama-mini", "granite4.2:8b", "registry", false],
			],
		);
	});

	test("dedup by (provider, modelId) with the ollama-tags copy winning", () => {
		const registry = [{ provider: "ollama", id: "granite4.2:8b" }];
		const merged = mergeModelSources(TAGS.slice(0, 1), registry);
		const granite = merged.filter((e) => e.modelId === "granite4.2:8b");
		assert.equal(granite.length, 1);
		assert.equal(granite[0].source, "ollama-tags");
		assert.equal(granite[0].pulled, true);
	});

	test("current ref sorts first and is flagged", () => {
		const merged = mergeModelSources(TAGS, [], { provider: "ollama", modelId: "llama3.2:3b" });
		assert.equal(merged[0].modelId, "llama3.2:3b");
		assert.equal(merged[0].current, true);
		assert.equal(merged[1].current, false);
	});

	test("sort is current-first then provider alphabetical", () => {
		const registry = [
			{ provider: "llama-cpp", id: "a:1b" },
			{ provider: "ollama-mini", id: "b:2b" },
		];
		const merged = mergeModelSources([], registry);
		assert.deepEqual(
			merged.map((e) => e.provider),
			["llama-cpp", "ollama-mini"],
		);
	});
});

// ---------------------------------------------------------------------------
// (3) filterModels — fuzzy subsequence (pi-tui fuzzyFilter reimplementation)
// ---------------------------------------------------------------------------

describe("filterModels", () => {
	const list = mergeModelSources(
		[
			{ name: "granite4.2:8b" },
			{ name: "granite3.3:2b" },
			{ name: "llama3.2:3b" },
		],
		[{ provider: "ollama-mini", id: "granite4.2:8b" }],
	);

	test("empty query returns the full list", () => {
		assert.deepEqual(filterModels(list, ""), list);
		assert.deepEqual(filterModels(list, "   "), list);
	});

	test("fuzzy subsequence matches out-of-order characters", () => {
		const hits = filterModels(list, "grnt");
		assert.deepEqual(
			hits.map((e) => e.modelId).sort(),
			["granite3.3:2b", "granite4.2:8b", "granite4.2:8b"],
		);
		assert.ok(hits.every((e) => /granite/i.test(e.modelId)));
		// granite3.3 vs granite4.2 score identically for "grnt"; stable order keeps input order.
	});

	test("multiple tokens all must match", () => {
		const hits = filterModels(list, "ollama granite");
		// "ollama" also subsequence-matches "ollama-mini/granite4.2:8b" (pi-tui does the same).
		assert.deepEqual(
			hits.map((e) => `${e.provider}/${e.modelId}`),
			[
				"ollama/granite3.3:2b",
				"ollama/granite4.2:8b",
				"ollama-mini/granite4.2:8b",
			],
		);
	});

	test("no match yields an empty list", () => {
		assert.deepEqual(filterModels(list, "zzqq"), []);
	});

	test("query can span provider/model via slash tokenization", () => {
		const hits = filterModels(list, "ollama/grnt");
		assert.ok(hits.length >= 2);
		assert.ok(hits.every((e) => e.provider.startsWith("ollama") && /granite/i.test(e.modelId)));
	});
});

// ---------------------------------------------------------------------------
// (4) Config vNext parsing — defaults, fallbacks, round-trip, migration
// ---------------------------------------------------------------------------

describe("parseConfigVNext", () => {
	test("non-object input yields all defaults including enabled=false", () => {
		for (const junk of [null, 42, "x", [1, 2]]) {
			assert.deepEqual(parseConfigVNext(junk), DEFAULT_CONFIG_VNEXT);
		}
	});

	test("malformed JSON string yields all defaults", () => {
		assert.deepEqual(parseConfigVNextJson("{not json"), DEFAULT_CONFIG_VNEXT);
	});

	test("valid fields parse; invalid fields fall back independently", () => {
		const cfg = parseConfigVNext({
			tiny: { provider: "ollama", modelId: "llama3.2:3b" },
			think: true,
			toolsMode: "read-only",
			delegateBudget: 3.9,
			enabled: true,
		});
		assert.deepEqual(cfg.tiny, { provider: "ollama", modelId: "llama3.2:3b" });
		assert.equal(cfg.think, true);
		assert.equal(cfg.toolsMode, "read-only");
		assert.equal(cfg.delegateBudget, 3); // floored
		assert.equal(cfg.enabled, true);

		const fallback = parseConfigVNext({
			toolsMode: "everything",
			delegateBudget: -2,
			think: "yes",
			enabled: "yes",
			tiny: { modelId: "missing-provider" },
			large: { provider: 42, modelId: "x" },
		});
		assert.equal(fallback.toolsMode, "curated");
		assert.equal(fallback.delegateBudget, DEFAULT_CONFIG_VNEXT.delegateBudget);
		assert.equal(fallback.think, false);
		assert.equal(fallback.enabled, false);
		assert.deepEqual(fallback.tiny, DEFAULT_TINY_REF);
		assert.equal(fallback.large, undefined);
	});

	test("legacy tiny ref migrates to the granite default, other fields preserved", () => {
		const cfg = parseConfigVNext({
			tiny: {
				provider: "ollama",
				modelId: "hf.co/mradermacher/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF:Q4_K_M",
			},
			large: { provider: "minimax", modelId: "MiniMax-M3" },
		});
		assert.deepEqual(cfg.tiny, DEFAULT_TINY_REF);
		assert.deepEqual(cfg.large, { provider: "minimax", modelId: "MiniMax-M3" });
	});

	test("config predating the enabled field loads with enabled=false", () => {
		const cfg = parseConfigVNextJson(
			JSON.stringify({ tiny: { provider: "ollama", modelId: "llama3.2:3b" }, toolsMode: "all" }),
		);
		assert.equal(cfg.enabled, false);
		assert.equal(cfg.toolsMode, "all");
	});

	test("serialize + reparse round-trips", () => {
		const cfg = parseConfigVNext({
			enabled: true,
			tiny: { provider: "ollama", modelId: "llama3.2:3b" },
			think: true,
			toolsMode: "all",
			delegateBudget: 3,
		});
		const reloaded = parseConfigVNextJson(serializeConfig(cfg));
		assert.deepEqual(reloaded, cfg);
	});
});

// ---------------------------------------------------------------------------
// (5) Picker window math
// ---------------------------------------------------------------------------

describe("visibleWindow", () => {
	test("short lists show everything", () => {
		assert.deepEqual(visibleWindow(5, 0), { start: 0, end: 5 });
		assert.deepEqual(visibleWindow(10, 9), { start: 0, end: 10 });
	});

	test("window slides to keep the selection centered, clamped at the tail", () => {
		// pi's formula: start = max(0, min(selected - 5, count - 10)).
		assert.deepEqual(visibleWindow(15, 12), { start: 5, end: 15 }); // tail clamp wins over centering
		assert.deepEqual(visibleWindow(15, 7), { start: 2, end: 12 });
	});

	test("window clamps at both edges", () => {
		assert.deepEqual(visibleWindow(15, 0), { start: 0, end: PICKER_MAX_VISIBLE });
		assert.deepEqual(visibleWindow(15, 14), { start: 5, end: 15 });
	});

	test("never wider than maxVisible", () => {
		for (let n = 1; n <= 30; n++) {
			for (let i = 0; i < n; i++) {
				const { start, end } = visibleWindow(n, i);
				assert.ok(end - start <= PICKER_MAX_VISIBLE, `n=${n} i=${i}`);
				assert.ok(i >= start && i < end, `selection ${i} outside window [${start},${end}) for n=${n}`);
			}
		}
	});

	test("empty list yields an empty window", () => {
		assert.deepEqual(visibleWindow(0, 0), { start: 0, end: 0 });
	});
});

describe("moveSelection", () => {
	test("moves by delta within bounds", () => {
		assert.equal(moveSelection(7, 1, 15), 8);
		assert.equal(moveSelection(7, -1, 15), 6);
	});

	test("wraps around at both edges (pi /model parity)", () => {
		assert.equal(moveSelection(0, -1, 15), 14);
		assert.equal(moveSelection(14, 1, 15), 0);
	});

	test("single-entry list is stable", () => {
		assert.equal(moveSelection(0, 1, 1), 0);
		assert.equal(moveSelection(0, -1, 1), 0);
	});

	test("empty list is a no-op", () => {
		assert.equal(moveSelection(3, 1, 0), 0);
	});
});
