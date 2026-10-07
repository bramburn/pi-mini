// Unit tests for mini-settings.ts: fetchLocalModels, buildPickerEntries, and
// the headless showSettingsMenu flow (fake ctx.ui.select scripting).
// Pure logic only — no live Ollama, no pi runtime, no TTY. The TUI overlay
// component is constructed only inside the ctx.mode === "tui" path via
// ctx.ui.custom, which cannot be exercised headless (pi-tui is not resolvable
// under plain node); its behavior is covered indirectly through the pure
// window/filter functions (visibleWindow/moveSelection/filterModels, tested in
// tests/unit/settings-page.test.mjs) and the headless path below.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildPickerEntries, fetchLocalModels, showSettingsMenu } from "./mini-settings.ts";
import { OLLAMA_BASE_URL, TINY_MODEL_ID, TINY_PROVIDER, defaultConfig } from "./settings.ts";
import type { ModelRef, PiMiniConfig } from "./settings.ts";

// ---------------------------------------------------------------------------
// fetchLocalModels — fake fetch
// ---------------------------------------------------------------------------

function fakeFetchJson(payload: unknown, ok = true, status = 200): typeof fetch {
	return (async () =>
		({
			ok,
			status,
			json: async () => payload,
		}) as Response) as unknown as typeof fetch;
}

describe("fetchLocalModels", () => {
	test("maps /api/tags rows to PickerModelEntry with ollama refs (granite row shape)", async () => {
		const fetchImpl = fakeFetchJson({
			models: [
				{ name: "granite4.2:8b", model: "granite4.2:8b" },
				{ name: "llama3.2:3b", model: "llama3.2:3b" },
			],
		});
		const res = await fetchLocalModels("http://localhost:11434", fetchImpl);
		assert.equal(res.warning, undefined);
		assert.deepEqual(res.models, [
			{
				label: "ollama/granite4.2:8b",
				ref: { provider: "ollama", modelId: "granite4.2:8b" },
				source: "ollama-tags",
				current: false,
			},
			{
				label: "ollama/llama3.2:3b",
				ref: { provider: "ollama", modelId: "llama3.2:3b" },
				source: "ollama-tags",
				current: false,
			},
		]);
	});

	test("requests <baseUrl>/api/tags exactly (trailing slash stripped)", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return { ok: true, status: 200, json: async () => ({ models: [] }) } as Response;
		}) as unknown as typeof fetch;
		await fetchLocalModels("http://localhost:11434/", fetchImpl);
		assert.deepEqual(calls, ["http://localhost:11434/api/tags"]);
	});

	test("skips malformed tag rows", async () => {
		const fetchImpl = fakeFetchJson({ models: [{ name: "ok:1b" }, {}, { name: 42 }, null, { model: "x" }] });
		const res = await fetchLocalModels("http://localhost:11434", fetchImpl);
		assert.deepEqual(
			res.models.map((m) => m.ref.modelId),
			["ok:1b"],
		);
	});

	test("missing models array yields an empty list without warning", async () => {
		const res = await fetchLocalModels("http://localhost:11434", fakeFetchJson({}));
		assert.deepEqual(res.models, []);
		assert.equal(res.warning, undefined);
	});

	test("DNS failure returns empty models + warning, never throws", async () => {
		const fetchImpl = (async () => {
			throw new Error("getaddrinfo ENOTFOUND ollama");
		}) as unknown as typeof fetch;
		const res = await fetchLocalModels("http://ollama.invalid:11434", fetchImpl);
		assert.deepEqual(res.models, []);
		assert.equal(
			res.warning,
			"Ollama unreachable at http://ollama.invalid:11434 — showing registry models only",
		);
	});

	test("non-2xx response is treated as unreachable", async () => {
		const res = await fetchLocalModels("http://localhost:11434", fakeFetchJson({}, false, 503));
		assert.deepEqual(res.models, []);
		assert.match(res.warning ?? "", /Ollama unreachable at http:\/\/localhost:11434/);
	});

	test("unreachable default base URL produces the spec'd warning text", async () => {
		const fetchImpl = (async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
		}) as unknown as typeof fetch;
		const res = await fetchLocalModels(OLLAMA_BASE_URL, fetchImpl);
		assert.deepEqual(res.models, []);
		assert.equal(
			res.warning,
			`Ollama unreachable at ${OLLAMA_BASE_URL} — showing registry models only`,
		);
	});
});

// ---------------------------------------------------------------------------
// buildPickerEntries — merge, dedupe, current-first, current flag, local-only
// ---------------------------------------------------------------------------

function tagEntries(names: string[]) {
	return names.map((name) => ({
		label: `ollama/${name}`,
		ref: { provider: "ollama", modelId: name },
		source: "ollama-tags" as const,
		current: false,
	}));
}

const TAG_ENTRIES = tagEntries(["granite4.2:8b", "llama3.2:3b"]);

describe("buildPickerEntries", () => {
	const REGISTRY = [
		{ provider: "ollama-mini", id: "granite4.2:8b", name: "Granite 4.2 8B (pi-mini orchestrator)" },
		{ provider: "llama-cpp", id: "local-drafts:7b" },
		{ provider: "minimax", id: "MiniMax-M3" },
	];

	test("merges tags with local-only registry entries; remote provider excluded", () => {
		const entries = buildPickerEntries(TAG_ENTRIES, REGISTRY);
		// No current ref: provider alphabetical across both sources (llama-cpp < ollama < ollama-mini).
		assert.deepEqual(
			entries.map((e) => [e.provider, e.modelId, e.source, e.pulled]),
			[
				["llama-cpp", "local-drafts:7b", "registry", false],
				["ollama", "granite4.2:8b", "ollama-tags", true],
				["ollama", "llama3.2:3b", "ollama-tags", true],
				["ollama-mini", "granite4.2:8b", "registry", false],
			],
		);
		assert.ok(entries.every((e) => e.provider !== "minimax"));
	});

	test("dedupes by (provider, modelId) with the ollama-tags copy winning", () => {
		const entries = buildPickerEntries(TAG_ENTRIES, [{ provider: "ollama", id: "granite4.2:8b" }]);
		const granite = entries.filter((e) => e.modelId === "granite4.2:8b");
		assert.equal(granite.length, 1);
		assert.equal(granite[0].source, "ollama-tags");
		assert.equal(granite[0].pulled, true);
	});

	test("current ref sorts first and flags exactly the formatRef match", () => {
		const current: ModelRef = { provider: "ollama", modelId: "llama3.2:3b" };
		const entries = buildPickerEntries(TAG_ENTRIES, REGISTRY, current);
		assert.equal(entries[0].modelId, "llama3.2:3b");
		assert.equal(entries[0].current, true);
		assert.ok(entries.slice(1).every((e) => !e.current));
	});

	test("empty tags fall back to registry local entries, marked not pulled", () => {
		const entries = buildPickerEntries([], REGISTRY);
		assert.deepEqual(
			entries.map((e) => [e.provider, e.modelId, e.source, e.pulled]),
			[
				["llama-cpp", "local-drafts:7b", "registry", false],
				["ollama-mini", "granite4.2:8b", "registry", false],
			],
		);
	});

	test("registry current entry sorts first even with no tags", () => {
		const entries = buildPickerEntries([], REGISTRY, { provider: "ollama-mini", modelId: "granite4.2:8b" });
		assert.equal(entries[0].provider, "ollama-mini");
		assert.equal(entries[0].current, true);
		assert.equal(entries[0].pulled, false);
	});
});

// ---------------------------------------------------------------------------
// showSettingsMenu — headless fake ctx.ui.select scripting
// ---------------------------------------------------------------------------

interface SelectCall {
	title: string;
	options: string[];
}

interface FakeUi {
	select: (title: string, options: string[]) => Promise<string | undefined>;
	notify: (message: string, type?: string) => void;
	calls: SelectCall[];
	notifications: Array<{ message: string; type?: string }>;
}

function makeFakeUi(script: ReadonlyArray<string | undefined>): FakeUi {
	const calls: SelectCall[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	let i = 0;
	return {
		calls,
		notifications,
		async select(title: string, options: string[]): Promise<string | undefined> {
			calls.push({ title, options });
			if (i >= script.length) return undefined;
			const next = script[i++];
			if (next !== undefined && !options.includes(next)) {
				throw new Error(`scripted choice ${JSON.stringify(next)} not in options ${JSON.stringify(options)}`);
			}
			return next;
		},
		notify(message: string, type?: string) {
			notifications.push({ message, type });
		},
	};
}

const REGISTRY = [
	{ provider: "ollama-mini", id: "granite4.2:8b", name: "Granite 4.2 8B" },
	{ provider: "ollama", id: "granite4.2:8b", name: "Granite 4.2 8B" },
	{ provider: "ollama", id: "llama3.2:3b", name: "Llama 3.2 3B" },
	{ provider: "minimax", id: "MiniMax-M3", name: "MiniMax M3" },
];

function makeFakeCtx(ui: FakeUi, extraUi: Record<string, unknown> = {}) {
	return {
		mode: "headless",
		hasUI: false,
		ui: { select: ui.select, notify: ui.notify, ...extraUi },
		modelRegistry: {
			getAvailable: () => REGISTRY,
			find: (provider: string, modelId: string) =>
				REGISTRY.find((m) => m.provider === provider && m.id === modelId),
		},
	};
}

interface FlowState {
	cfg: PiMiniConfig;
	enabled: boolean;
	setEnabledCalls: boolean[];
	applyTinyCalls: ModelRef[];
	applyLargeCalls: ModelRef[];
}

function makeDeps(state: FlowState) {
	return {
		getConfig: () => state.cfg,
		isEnabled: () => state.enabled,
		setEnabled: async (on: boolean) => {
			state.setEnabledCalls.push(on);
			state.enabled = on;
		},
		applyTinyModel: async (ref: ModelRef) => {
			state.applyTinyCalls.push(ref);
			state.cfg = { ...state.cfg, tiny: { ...ref } };
		},
		applyLargeModel: async (ref: ModelRef) => {
			state.applyLargeCalls.push(ref);
			state.cfg = { ...state.cfg, large: { ...ref } };
		},
	};
}

function freshState(cfg: PiMiniConfig = defaultConfig()): FlowState {
	return { cfg, enabled: false, setEnabledCalls: [], applyTinyCalls: [], applyLargeCalls: [] };
}

/** Stub the global fetch used by fetchLocalModels' default fetchImpl. */
function stubGlobalFetch(payload: { models: Array<{ name: string }> } | "fail"): void {
	globalThis.fetch = (async () => {
		if (payload === "fail") throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
		return { ok: true, status: 200, json: async () => payload } as Response;
	}) as typeof fetch;
}

const TINY_LABEL = `Tiny model: ${TINY_PROVIDER}/${TINY_MODEL_ID} ▸`;

describe("showSettingsMenu (headless)", () => {
	test("menu options reflect enable state and current tiny model", async () => {
		const ui = makeFakeUi([undefined]);
		await showSettingsMenu(makeFakeCtx(ui) as never, makeDeps(freshState()));
		assert.equal(ui.calls.length, 1);
		assert.equal(ui.calls[0].title, "pi-mini settings");
		assert.deepEqual(ui.calls[0].options, [
			"Enable pi-mini",
			TINY_LABEL,
			"Large model: (not set) ▸",
			"Done",
		]);

		const ui2 = makeFakeUi([undefined]);
		const state2 = freshState({ ...defaultConfig(), tiny: { provider: "ollama", modelId: "llama3.2:3b" } });
		state2.enabled = true;
		await showSettingsMenu(makeFakeCtx(ui2) as never, makeDeps(state2));
		assert.equal(ui2.calls[0].options[0], "Disable pi-mini");
		assert.equal(ui2.calls[0].options[1], "Tiny model: ollama/llama3.2:3b ▸");
	});

	test("full flow: toggle enable → pick tiny model → Done exits", async () => {
		stubGlobalFetch({ models: [{ name: "granite4.2:8b" }, { name: "llama3.2:3b" }] });
		const ui = makeFakeUi(["Enable pi-mini", TINY_LABEL, "ollama/llama3.2:3b", "Done"]);
		const state = freshState();
		await showSettingsMenu(makeFakeCtx(ui) as never, makeDeps(state));

		assert.deepEqual(state.setEnabledCalls, [true]);
		assert.equal(state.enabled, true);
		assert.deepEqual(state.applyTinyCalls, [{ provider: "ollama", modelId: "llama3.2:3b" }]);
		assert.deepEqual(state.cfg.tiny, { provider: "ollama", modelId: "llama3.2:3b" });
		// Selects: menu → menu(after enable) → picker → menu(after pick) → "Done" exits.
		assert.equal(ui.calls.length, 4);
		// Menu re-shown after each action; the post-enable menu flips the toggle
		// label, and the post-pick menu shows the new tiny ref.
		assert.equal(ui.calls[1].options[0], "Disable pi-mini");
		assert.equal(ui.calls[1].options[1], TINY_LABEL);
		assert.equal(ui.calls[3].options[1], "Tiny model: ollama/llama3.2:3b ▸");
		// Picker select offered local-only labels: current first, then provider sort,
		// remote minimax excluded, filter pseudo-row last.
		assert.deepEqual(ui.calls[2].options, [
			"ollama-mini/granite4.2:8b",
			"ollama/granite4.2:8b",
			"ollama/llama3.2:3b",
			"🔍 Filter models…",
		]);
		// Notifications: enable confirm, model-change confirm, native-pipeline warning.
		assert.ok(ui.notifications.some((n) => n.message === "pi-mini enabled" && n.type === "info"));
		assert.ok(
			ui.notifications.some((n) => n.message === "Tiny model set to ollama/llama3.2:3b" && n.type === "info"),
		);
		assert.ok(
			ui.notifications.some(
				(n) => n.type === "warning" && /think:false, wrap-fix, and the stall watchdog/.test(n.message),
			),
		);
	});

	test("large-model entry reuses the picker over the full registry (remote included)", async () => {
		stubGlobalFetch({ models: [] });
		const ui = makeFakeUi(["Large model: (not set) ▸", "minimax/MiniMax-M3", "Done"]);
		const state = freshState();
		await showSettingsMenu(makeFakeCtx(ui) as never, makeDeps(state));
		assert.deepEqual(state.applyLargeCalls, [{ provider: "minimax", modelId: "MiniMax-M3" }]);
		assert.deepEqual(state.cfg.large, { provider: "minimax", modelId: "MiniMax-M3" });
		assert.deepEqual(state.applyTinyCalls, []);
		// Picker offered the remote label — no local-only filtering for the large slot.
		assert.ok(ui.calls[1].options.includes("minimax/MiniMax-M3"));
		assert.ok(ui.calls[1].options.includes("ollama-mini/granite4.2:8b"));
	});

	test("cancel at the main menu exits without side effects", async () => {
		const ui = makeFakeUi([undefined]);
		const state = freshState();
		await showSettingsMenu(makeFakeCtx(ui) as never, makeDeps(state));
		assert.deepEqual(state.setEnabledCalls, []);
		assert.deepEqual(state.applyTinyCalls, []);
		assert.deepEqual(state.applyLargeCalls, []);
		assert.equal(ui.calls.length, 1);
	});

	test("picker cancel (undefined) leaves config untouched and re-shows the menu", async () => {
		stubGlobalFetch({ models: [{ name: "granite4.2:8b" }, { name: "llama3.2:3b" }] });
		const ui = makeFakeUi([TINY_LABEL, undefined, "Done"]);
		const state = freshState();
		await showSettingsMenu(makeFakeCtx(ui) as never, makeDeps(state));
		assert.deepEqual(state.applyTinyCalls, []);
		assert.deepEqual(state.cfg.tiny, { provider: TINY_PROVIDER, modelId: TINY_MODEL_ID });
		assert.equal(ui.calls.length, 3); // menu → picker → menu
	});

	test("picking the current tiny model is a no-op (applyTinyModel not called)", async () => {
		stubGlobalFetch({ models: [{ name: "granite4.2:8b" }, { name: "llama3.2:3b" }] });
		const ui = makeFakeUi([TINY_LABEL, `${TINY_PROVIDER}/${TINY_MODEL_ID}`, "Done"]);
		const state = freshState();
		await showSettingsMenu(makeFakeCtx(ui) as never, makeDeps(state));
		assert.deepEqual(state.applyTinyCalls, []);
		assert.ok(
			ui.notifications.every((n) => n.message !== `Tiny model set to ${TINY_PROVIDER}/${TINY_MODEL_ID}`),
		);
	});

	test("unreachable Ollama warns and falls back to registry local entries only", async () => {
		stubGlobalFetch("fail");
		const ui = makeFakeUi([TINY_LABEL, `${TINY_PROVIDER}/${TINY_MODEL_ID}`, "Done"]);
		const state = freshState();
		await showSettingsMenu(makeFakeCtx(ui) as never, makeDeps(state));
		assert.ok(
			ui.notifications.some(
				(n) => n.type === "warning" && n.message.includes(`Ollama unreachable at ${OLLAMA_BASE_URL}`),
			),
		);
		// Registry-only fallback: all local-runtime registry entries, no minimax,
		// current entry first.
		assert.deepEqual(ui.calls[1].options, [
			`${TINY_PROVIDER}/${TINY_MODEL_ID}`,
			"ollama/granite4.2:8b",
			"ollama/llama3.2:3b",
			"🔍 Filter models…",
		]);
		assert.deepEqual(state.applyTinyCalls, []); // current-model no-op
	});

	test("narrowing loop: filter option + input narrows, then pick a label", async () => {
		stubGlobalFetch({ models: [{ name: "granite4.2:8b" }, { name: "granite3.3:2b" }, { name: "llama3.2:3b" }] });
		const ui = makeFakeUi([TINY_LABEL, "🔍 Filter models…", "ollama/granite4.2:8b", "Done"]);
		const state = freshState();
		const ctx = makeFakeCtx(ui, { input: async () => "grnt" });
		await showSettingsMenu(ctx as never, makeDeps(state));
		assert.deepEqual(state.applyTinyCalls, [{ provider: "ollama", modelId: "granite4.2:8b" }]);
		// menu → picker(query "") → picker(query "grnt") → menu → done
		assert.ok(ui.calls.length >= 4);
		assert.equal(ui.calls[1].options.at(-1), "🔍 Filter models…");
		assert.equal(ui.calls[2].options.at(-1), '🔍 Filter models: "grnt"…');
		assert.ok(ui.calls[2].options.includes("ollama/granite4.2:8b"));
		assert.ok(!ui.calls[2].options.includes("ollama/llama3.2:3b"));
	});
});
