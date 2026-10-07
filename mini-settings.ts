// Settings-page module for the pi-mini extension: the /mini settings
// two-step menu (Enable/Disable toggle + tiny/large model pickers) and the
// data source behind the local-model picker.
//
// Logic is promoted from tests/unit/lib/settings-page.mjs (the spec reference
// implementation) with identical names and semantics; that file is now a
// re-export shim over this module so the 31 existing unit tests keep passing.
//
// Grounded in:
//   - specs/api/paths/settings-page/model-picker.yaml
//   - specs/api/paths/config/settings.yaml
//   - specs/api/components/schemas/pi-mini-config.yaml (vNext, validation fallback)
//   - specs/api/components/schemas/model-list.yaml (x-local-filter-rule)
//   - pi's /model ModelSelectorComponent (10-row window, wrap-around, fuzzy search)
//
// PI-TUI NOTE: @earendil-works/pi-tui is not resolvable under plain node (the
// node_modules junction only covers pi-ai), so this module keeps a faithful
// reimplementation of pi-tui's fuzzyFilter (fuzzySubsequenceFilter) for all
// pure logic. The real pi-tui is imported lazily, only inside the TUI picker
// construction path, so plain-node tests never touch it.

import {
	OLLAMA_BASE_URL,
	TINY_MODEL_ID,
	TINY_PROVIDER,
	formatRef,
	loadConfig,
	saveConfig,
	type ModelRef,
	type PiMiniConfig,
} from "./settings.ts";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Theme type of the ui.custom() factory, derived since coding-agent does not export it. */
type PickerTheme = Parameters<Parameters<ExtensionUIContext["custom"]>[0]>[1];

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** ModelRef or /api/tags entry shape accepted by isLocalModel. */
interface LocalModelProbe {
	provider?: string;
	name?: string;
}

/** Registry entry shape accepted by mergeModelSources / buildPickerEntries. */
export interface RegistryModelEntry {
	provider: string;
	id?: string;
	modelId?: string;
	name?: string;
}

/** Merged picker row: ollama-tags + local registry entries, deduped, sorted. */
export interface PickerEntry {
	provider: string;
	modelId: string;
	name: string;
	source: "ollama-tags" | "registry";
	current: boolean;
	pulled: boolean;
}

/** /api/tags entry as returned by fetchLocalModels. */
export interface PickerModelEntry {
	label: string;
	ref: ModelRef;
	source: "ollama-tags";
	current: boolean;
}

/** Result of fetchLocalModels: the tags payload, or a fallback warning. */
export interface LocalModelsResult {
	models: PickerModelEntry[];
	warning?: string;
}

// ---------------------------------------------------------------------------
// (1) Local-runtime classification (spec: model-list.yaml x-local-filter-rule)
// ---------------------------------------------------------------------------

/** Provider ids served by a LOCAL runtime (llama.cpp / Ollama-class). */
export const LOCAL_RUNTIME_PROVIDERS: ReadonlySet<string> = new Set([
	"ollama",
	"ollama-mini",
	"llama-cpp",
]);

export const DEFAULT_TINY_REF: ModelRef = { provider: TINY_PROVIDER, modelId: TINY_MODEL_ID };

/** The retired default tiny model, migrated on load (settings.ts LEGACY_TINY). */
export const LEGACY_TINY_REF: ModelRef = {
	provider: "ollama",
	modelId: "hf.co/mradermacher/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF:Q4_K_M",
};

/** Config vNext shape handled by the settings page (the loadConfig surface plus `enabled`). */
export interface PiMiniConfigVNext {
	tiny: ModelRef;
	large?: ModelRef;
	think: boolean;
	toolsMode: "curated" | "all" | "read-only";
	delegateBudget: number;
	enabled: boolean;
}

export const DEFAULT_CONFIG_VNEXT: PiMiniConfigVNext = {
	tiny: { ...DEFAULT_TINY_REF },
	think: false,
	toolsMode: "curated",
	delegateBudget: 8,
	enabled: false,
};

/**
 * Decision table: is this entry a LOCAL model the settings-page picker may show?
 *   - source "ollama-tags"                                -> LOCAL (Ollama serves it)
 *   - provider "ollama" | "ollama-mini" | "llama-cpp"     -> LOCAL
 *   - anything else (minimax/openai/anthropic-class)      -> REMOTE
 */
export function isLocalModel(entry: LocalModelProbe | null | undefined, source?: string): boolean {
	if (source === "ollama-tags") return true;
	if (!entry || typeof entry !== "object") return false;
	const provider = entry.provider;
	if (typeof provider !== "string") return false;
	return LOCAL_RUNTIME_PROVIDERS.has(provider);
}

// ---------------------------------------------------------------------------
// (2) Merge /api/tags with registry entries
// ---------------------------------------------------------------------------

/**
 * Merge the live /api/tags payload with registry entries into a deduped,
 * current-first sorted picker list with a source discriminator.
 * When localOnly is true, remote registry providers are excluded
 * (spec x-local-filter-rule); false includes the full registry (large-model slot).
 */
function mergeSources(
	ollamaTags: ReadonlyArray<{ name?: unknown }> | null | undefined,
	registryEntries: ReadonlyArray<RegistryModelEntry | null | undefined> | null | undefined,
	currentRef: ModelRef | null | undefined,
	localOnly: boolean,
): PickerEntry[] {
	const byKey = new Map<string, PickerEntry>();
	const key = (provider: string, modelId: string) => `${provider}/${modelId}`;
	const isCurrent = (provider: string, modelId: string) =>
		!!currentRef && currentRef.provider === provider && currentRef.modelId === modelId;

	for (const tag of ollamaTags ?? []) {
		if (!tag || typeof tag.name !== "string" || !tag.name) continue;
		const entry: PickerEntry = {
			provider: "ollama",
			modelId: tag.name,
			name: tag.name,
			source: "ollama-tags",
			current: isCurrent("ollama", tag.name),
			pulled: true,
		};
		byKey.set(key(entry.provider, entry.modelId), entry);
	}
	for (const reg of registryEntries ?? []) {
		const provider = reg?.provider;
		const modelId = reg?.modelId ?? reg?.id;
		if (typeof provider !== "string" || typeof modelId !== "string") continue;
		if (localOnly && !isLocalModel(reg, "registry")) continue; // remote providers excluded
		const k = key(provider, modelId);
		if (byKey.has(k)) continue; // ollama-tags copy wins
		byKey.set(k, {
			provider,
			modelId,
			name: typeof reg.name === "string" && reg.name ? reg.name : modelId,
			source: "registry",
			current: isCurrent(provider, modelId),
			pulled: false,
		});
	}
	return [...byKey.values()].sort((a, b) => {
		if (a.current !== b.current) return a.current ? -1 : 1;
		const byProvider = a.provider.localeCompare(b.provider);
		if (byProvider !== 0) return byProvider;
		return a.modelId.localeCompare(b.modelId);
	});
}

/**
 * Merge /api/tags with LOCAL-ONLY registry entries (the tiny-model picker data
 * source per specs/api/paths/settings-page/model-picker.yaml).
 */
export function mergeModelSources(
	ollamaTags: ReadonlyArray<{ name?: unknown }> | null | undefined,
	registryEntries: ReadonlyArray<RegistryModelEntry | null | undefined> | null | undefined,
	currentRef?: ModelRef,
): PickerEntry[] {
	return mergeSources(ollamaTags, registryEntries, currentRef ?? null, true);
}

// ---------------------------------------------------------------------------
// (3) Picker fuzzy filtering (pi-tui fuzzyFilter faithful reimplementation)
// ---------------------------------------------------------------------------

function fuzzyMatchScore(queryLower: string, textLower: string): number | null {
	if (queryLower === textLower) return -100;
	if (queryLower.length > textLower.length) return null;
	let queryIndex = 0;
	let score = 0;
	let lastMatchIndex = -1;
	let consecutive = 0;
	for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
		if (textLower[i] !== queryLower[queryIndex]) continue;
		const isBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]);
		if (lastMatchIndex === i - 1) {
			consecutive++;
			score -= consecutive * 5;
		} else {
			consecutive = 0;
			if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
		}
		if (isBoundary) score -= 10;
		score += i * 0.1;
		lastMatchIndex = i;
		queryIndex++;
	}
	return queryIndex === queryLower.length ? score : null;
}

/**
 * pi-tui fuzzyFilter equivalent: whitespace/slash-tokenized subsequence match,
 * all tokens must match, best score first. Empty query returns items unchanged.
 */
export function fuzzySubsequenceFilter<T>(
	items: ReadonlyArray<T>,
	query: string,
	getText: (item: T) => string,
): T[] {
	if (!query.trim()) return [...items];
	const tokens = query.trim().split(/[\s/]+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return [...items];
	const results: Array<{ item: T; total: number }> = [];
	for (const item of items) {
		const text = getText(item).toLowerCase();
		let total = 0;
		let allMatch = true;
		for (const token of tokens) {
			const score = fuzzyMatchScore(token.toLowerCase(), text);
			if (score === null) {
				allMatch = false;
				break;
			}
			total += score;
		}
		if (allMatch) results.push({ item, total });
	}
	results.sort((a, b) => a.total - b.total);
	return results.map((r) => r.item);
}

/**
 * Filter picker entries by the search-box query, scored over "provider/modelId".
 */
export function filterModels(list: ReadonlyArray<PickerEntry>, query: string): PickerEntry[] {
	return fuzzySubsequenceFilter(list, query, (e) => `${e.provider}/${e.modelId}`);
}

// ---------------------------------------------------------------------------
// (4) Config vNext parsing (settings.ts loadConfig semantics + `enabled`)
// ---------------------------------------------------------------------------

function isModelRefValue(value: unknown): value is ModelRef {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as ModelRef).provider === "string" &&
		typeof (value as ModelRef).modelId === "string"
	);
}

function cloneDefaults(): PiMiniConfigVNext {
	return {
		tiny: { ...(DEFAULT_CONFIG_VNEXT.tiny as ModelRef) },
		think: DEFAULT_CONFIG_VNEXT.think,
		toolsMode: DEFAULT_CONFIG_VNEXT.toolsMode,
		delegateBudget: DEFAULT_CONFIG_VNEXT.delegateBudget,
		enabled: DEFAULT_CONFIG_VNEXT.enabled,
	};
}

/**
 * Parse a raw PiMiniConfig vNext object with field-by-field validation
 * fallback and legacy migration, mirroring settings.ts loadConfig plus the
 * `enabled` field (default false; non-boolean falls back to false).
 * `large` is preserved when valid, dropped when not.
 *
 * settings.ts loadConfig/saveConfig remain the canonical disk persistence;
 * loadSettingsPageConfig()/persistSettingsPageConfig() below thin-wrap them
 * for the settings page.
 */
export function parseConfigVNext(parsed: unknown): PiMiniConfigVNext {
	const cfg = cloneDefaults();
	if (parsed && typeof parsed === "object") {
		const record = parsed as Record<string, unknown>;
		if (isModelRefValue(record.tiny)) cfg.tiny = { provider: record.tiny.provider, modelId: record.tiny.modelId };
		if (record.large !== undefined) {
			if (isModelRefValue(record.large))
				cfg.large = { provider: record.large.provider, modelId: record.large.modelId };
		}
		if (typeof record.think === "boolean") cfg.think = record.think;
		if (record.toolsMode === "curated" || record.toolsMode === "all" || record.toolsMode === "read-only") {
			cfg.toolsMode = record.toolsMode;
		}
		if (typeof record.delegateBudget === "number" && record.delegateBudget >= 1) {
			cfg.delegateBudget = Math.floor(record.delegateBudget);
		}
		if (typeof record.enabled === "boolean") cfg.enabled = record.enabled;
	}
	if (cfg.tiny.provider === LEGACY_TINY_REF.provider && cfg.tiny.modelId === LEGACY_TINY_REF.modelId) {
		cfg.tiny = { ...DEFAULT_TINY_REF };
	}
	return cfg;
}

/** Load + parse from a JSON string; malformed JSON keeps all defaults. */
export function parseConfigVNextJson(raw: string): PiMiniConfigVNext {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return cloneDefaults();
	}
	return parseConfigVNext(parsed);
}

/** Stable serialization for round-trip comparison (saveConfig writes pretty JSON). */
export function serializeConfig(cfg: PiMiniConfigVNext): string {
	return `${JSON.stringify(cfg, null, 2)}\n`;
}

/** Thin wrap over settings.ts loadConfig: disk config as the settings-page vNext view. */
export function loadSettingsPageConfig(): PiMiniConfigVNext {
	return parseConfigVNext(loadConfig());
}

/** Thin wrap over settings.ts saveConfig: persist the settings-page vNext view. */
export function persistSettingsPageConfig(cfg: PiMiniConfigVNext): void {
	saveConfig({ ...loadConfig(), ...cfg, tiny: { ...cfg.tiny } });
}

// ---------------------------------------------------------------------------
// (5) Picker window math (pi /model ModelSelectorComponent updateList parity)
// ---------------------------------------------------------------------------

export const PICKER_MAX_VISIBLE = 10;

/**
 * Visible window of the filtered list: at most maxVisible rows, sliding so
 * the selection stays centered; clamped to the list edges.
 * Matches pi's: start = max(0, min(selected - floor(max/2), count - max)).
 */
export function visibleWindow(
	count: number,
	selectedIndex: number,
	maxVisible: number = PICKER_MAX_VISIBLE,
): { start: number; end: number } {
	if (count <= 0) return { start: 0, end: 0 };
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), count - maxVisible));
	const end = Math.min(start + maxVisible, count);
	return { start, end };
}

/** Wrap-around selection move, mirroring pi's up/down keybindings. */
export function moveSelection(selectedIndex: number, delta: number, count: number): number {
	if (count <= 0) return 0;
	return (((selectedIndex + delta) % count) + count) % count;
}

// ---------------------------------------------------------------------------
// (6) Data source: GET /api/tags + registry merge
// ---------------------------------------------------------------------------

/**
 * Fetch the local Ollama runtime's /api/tags. On ANY failure (unreachable
 * host, DNS error, timeout, non-2xx) this does NOT throw: it returns an empty
 * model list plus a warning so the picker can fall back to registry-only
 * entries (spec: model-picker.yaml x-ollama-unreachable behavior).
 */
export async function fetchLocalModels(
	baseUrl: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs: number = 5000,
): Promise<LocalModelsResult> {
	const url = `${baseUrl.replace(/\/+$/, "")}/api/tags`;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		(timer as unknown as { unref?: () => void }).unref?.();
		let res: Response;
		try {
			res = await fetchImpl(url, { signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}
		if (!res.ok) throw new Error(`GET /api/tags failed: HTTP ${res.status}`);
		const data = (await res.json()) as { models?: unknown };
		const models: PickerModelEntry[] = [];
		for (const m of Array.isArray(data?.models) ? data.models : []) {
			const tag = m as { name?: unknown };
			if (!tag || typeof tag.name !== "string" || !tag.name) continue;
			models.push({
				label: `ollama/${tag.name}`,
				ref: { provider: "ollama", modelId: tag.name },
				source: "ollama-tags",
				current: false,
			});
		}
		return { models };
	} catch {
		return { models: [], warning: `Ollama unreachable at ${baseUrl} — showing registry models only` };
	}
}

/**
 * Build the tiny-model picker list: fetchLocalModels output merged with
 * local-only registry entries, deduped (ollama-tags copy wins), current-model
 * first, then provider alphabetical. The `current` flag matches
 * formatRef(currentRef).
 */
export function buildPickerEntries(
	localTags: ReadonlyArray<PickerModelEntry> | null | undefined,
	registryEntries: ReadonlyArray<RegistryModelEntry | null | undefined> | null | undefined,
	currentRef?: ModelRef,
): PickerEntry[] {
	const tags = (localTags ?? []).map((t) => ({ name: t?.ref?.modelId }));
	return mergeModelSources(tags, registryEntries, currentRef);
}

// ---------------------------------------------------------------------------
// (7) Settings menu flow (two steps: main menu, then model picker)
// ---------------------------------------------------------------------------

/** Dependencies the integrator (index.ts) supplies to the settings menu. */
export interface SettingsMenuDeps {
	/** Current persisted config (integrator: loadConfig from ./settings.ts). */
	getConfig: () => PiMiniConfig;
	/** Current session enablement state (mini mode active?). */
	isEnabled: () => boolean;
	/** Persist the enabled flag and apply the session transition. */
	setEnabled: (on: boolean) => Promise<void> | void;
	/** Persist cfg.tiny and live-switch the session model. */
	applyTinyModel: (ref: ModelRef) => Promise<void> | void;
	/** Persist cfg.large (optional third menu entry; no-op notify when absent). */
	applyLargeModel?: (ref: ModelRef) => Promise<void> | void;
	/** Ollama base URL override; defaults to settings.ts OLLAMA_BASE_URL. */
	baseUrl?: string;
}

const MENU_TITLE = "pi-mini settings";

function mainMenuOptions(cfg: PiMiniConfig, enabled: boolean): string[] {
	return [
		enabled ? "Disable pi-mini" : "Enable pi-mini",
		`Tiny model: ${formatRef(cfg.tiny)} ▸`,
		`Large model: ${cfg.large ? formatRef(cfg.large) : "(not set)"} ▸`,
		"Done",
	];
}

function sameRef(a: ModelRef, b: ModelRef | undefined): boolean {
	return !!b && a.provider === b.provider && a.modelId === b.modelId;
}

/**
 * Step 2: the /model-parity model picker. Local-only entries for the tiny
 * slot, full registry for the large slot. TUI path uses the ctx.ui.custom
 * overlay; headless falls back to a ctx.ui.select narrowing loop. Returns the
 * picked ref, or undefined when cancelled (Esc / select cancel) — callers
 * must treat undefined as "no change".
 */
async function pickModelRef(
	ctx: ExtensionContext,
	deps: SettingsMenuDeps,
	title: string,
	currentRef: ModelRef | undefined,
	localOnly: boolean,
): Promise<ModelRef | undefined> {
	const baseUrl = deps.baseUrl ?? OLLAMA_BASE_URL;
	let localTags: PickerModelEntry[] = [];
	if (localOnly) {
		const fetched = await fetchLocalModels(baseUrl);
		if (fetched.warning) ctx.ui.notify(fetched.warning, "warning");
		localTags = fetched.models;
	}
	const registry = ctx.modelRegistry
		.getAvailable()
		.map((m) => ({ provider: String(m.provider), id: String(m.id), name: String(m.name) }));
	const entries = localOnly
		? buildPickerEntries(localTags, registry, currentRef)
		: mergeSources([], registry, currentRef ?? null, false);
	if (entries.length === 0) {
		ctx.ui.notify("No models available in the registry", "warning");
		return undefined;
	}
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		return pickModelRefHeadless(ctx, title, entries);
	}
	return pickModelRefTui(ctx, title, entries);
}

/** Non-TUI fallback: ctx.ui.select over filtered labels with a narrowing loop. */
async function pickModelRefHeadless(
	ctx: ExtensionContext,
	title: string,
	entries: PickerEntry[],
): Promise<ModelRef | undefined> {
	let query = "";
	for (;;) {
		const filtered = filterModels(entries, query);
		if (filtered.length === 0) {
			ctx.ui.notify("No matching models", "warning");
			return undefined;
		}
		const labels = filtered.map((e) => formatRef(e));
		const filterLabel = `🔍 Filter models${query ? `: "${query}"` : ""}…`;
		const chosen = await ctx.ui.select(title, [...labels, filterLabel]);
		if (chosen === undefined) return undefined;
		if (chosen === filterLabel) {
			if (typeof ctx.ui.input === "function") {
				const next = await ctx.ui.input("Filter models", query);
				if (typeof next === "string") query = next;
			} else {
				ctx.ui.notify("Filtering needs an input prompt; pick a model or cancel", "warning");
			}
			continue;
		}
		const idx = labels.indexOf(chosen);
		if (idx === -1) return undefined; // unrecognized choice: treat as cancel
		return { provider: filtered[idx].provider, modelId: filtered[idx].modelId };
	}
}

/**
 * TUI path: the /model-parity overlay picker, modeled exactly on picker.ts's
 * ModelPicker but with buildPickerEntries data, the 10-row centered
 * visibleWindow, wrap-around moveSelection, a ✓ on the current model, a
 * (n/total) position footer, and Esc cancelling with no change.
 * pi-tui is imported lazily so plain-node tests never resolve it.
 */
async function pickModelRefTui(
	ctx: ExtensionContext,
	title: string,
	entries: PickerEntry[],
): Promise<ModelRef | undefined> {
	const tui = await import("@earendil-works/pi-tui");
	const { Container, Input, Spacer, Text, getKeybindings } = tui;

	class SettingsModelPicker extends Container {
		private readonly input = new Input();
		private readonly listBox = new Container();
		private readonly footerBox = new Container();
		private readonly theme: PickerTheme;
		private readonly pickerTitle: string;
		private readonly items: PickerEntry[];
		private readonly done: (result: ModelRef | undefined) => void;
		private filtered: PickerEntry[];
		private selected = 0;

		constructor(
			theme: PickerTheme,
			title: string,
			items: PickerEntry[],
			done: (result: ModelRef | undefined) => void,
		) {
			super();
			this.theme = theme;
			this.pickerTitle = title;
			this.items = items;
			this.done = done;
			this.filtered = items;
			this.addChild(new Spacer(1));
			this.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.pickerTitle)), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(this.input);
			this.addChild(new Spacer(1));
			this.addChild(this.listBox);
			this.addChild(new Spacer(1));
			this.addChild(this.footerBox);
			this.addChild(new Text(this.theme.fg("text", "type to filter  ↑↓ navigate  enter select  esc cancel"), 1, 0));
			this.addChild(new Spacer(1));

			this.input.onSubmit = () => this.confirm();
			this.input.onEscape = () => this.done(undefined);
			this.refreshList();
		}

		handleInput(data: string): void {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.up")) {
				this.move(-1);
			} else if (kb.matches(data, "tui.select.down")) {
				this.move(1);
			} else if (kb.matches(data, "tui.select.confirm")) {
				this.confirm();
			} else if (kb.matches(data, "tui.select.cancel")) {
				this.done(undefined);
			} else {
				this.input.handleInput(data);
				this.refilter();
			}
		}

		private move(delta: number): void {
			if (this.filtered.length === 0) return;
			this.selected = moveSelection(this.selected, delta, this.filtered.length);
			this.refreshList();
		}

		private confirm(): void {
			const chosen = this.filtered[this.selected];
			if (chosen) this.done({ provider: chosen.provider, modelId: chosen.modelId });
		}

		private refilter(): void {
			this.filtered = filterModels(this.items, this.input.getValue());
			this.selected = 0;
			this.refreshList();
		}

		private refreshList(): void {
			this.listBox.clear();
			this.footerBox.clear();
			const { start, end } = visibleWindow(this.filtered.length, this.selected);
			const visible = this.filtered.slice(start, end);
			if (visible.length === 0) {
				this.listBox.addChild(new Text(this.theme.fg("text", "  (no matches)"), 1, 0));
				return;
			}
			for (let i = 0; i < visible.length; i++) {
				const index = start + i;
				const entry = visible[i];
				const marker = index === this.selected ? this.theme.fg("accent", "→ ") : "  ";
				const check = entry.current ? this.theme.fg("accent", "✓ ") : "";
				const line = marker + check + this.theme.fg(index === this.selected ? "accent" : "text", formatRef(entry));
				this.listBox.addChild(new Text(line, 1, 0));
			}
			const current = this.filtered[this.selected];
			const footer = `(${this.selected + 1}/${this.filtered.length})  Model Name: ${formatRef(current)}`;
			this.footerBox.addChild(new Text(this.theme.fg("text", footer), 1, 0));
		}
	}

	return ctx.ui.custom<ModelRef | undefined>(
		(_tui, theme, _keybindings, done) => new SettingsModelPicker(theme, title, entries, done),
		{ overlay: true },
	);
}

/**
 * Step 1 + 2 of /mini settings: the two-step settings menu.
 *
 * Step 1 renders the main menu (Enable/Disable toggle with dynamic label, the
 * tiny-model row, the large-model row, Done). Choosing the toggle persists via
 * deps.setEnabled; choosing a model row opens the step-2 picker, and a
 * confirmed non-current pick is applied via deps.applyTinyModel /
 * deps.applyLargeModel before the menu re-shows. "Done" or cancelling the
 * select exits. Picking the current model is a no-op.
 */
export async function showSettingsMenu(ctx: ExtensionContext, deps: SettingsMenuDeps): Promise<void> {
	for (;;) {
		const cfg = deps.getConfig();
		const enabled = deps.isEnabled();
		const options = mainMenuOptions(cfg, enabled);
		const choice = await ctx.ui.select(MENU_TITLE, options);
		if (choice === undefined || choice === "Done") return;

		if (choice === options[0]) {
			const next = !enabled;
			await deps.setEnabled(next);
			ctx.ui.notify(`pi-mini ${next ? "enabled" : "disabled"}`, "info");
			continue;
		}
		if (choice === options[1]) {
			const ref = await pickModelRef(ctx, deps, "Select tiny model (local)", cfg.tiny, true);
			if (ref && !sameRef(ref, cfg.tiny)) {
				await deps.applyTinyModel(ref);
				ctx.ui.notify(`Tiny model set to ${formatRef(ref)}`, "info");
				if (ref.provider !== TINY_PROVIDER) {
					ctx.ui.notify(
						"think:false, wrap-fix, and the stall watchdog only apply to ollama-mini models",
						"warning",
					);
				}
			}
			continue;
		}
		if (choice === options[2]) {
			const ref = await pickModelRef(ctx, deps, "Select large model", cfg.large, false);
			if (ref && !sameRef(ref, cfg.large)) {
				if (deps.applyLargeModel) {
					await deps.applyLargeModel(ref);
					ctx.ui.notify(`Large model set to ${formatRef(ref)}`, "info");
				} else {
					ctx.ui.notify("Large model selection is not configurable here", "warning");
				}
			}
			continue;
		}
		// Unrecognized choice: exit defensively.
		return;
	}
}
