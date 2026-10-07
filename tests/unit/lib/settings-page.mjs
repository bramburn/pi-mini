// Pure reference functions for the settings-page feature (tests only — not
// part of the shipped extension). Grounded in:
//   - specs/api/components/schemas/model-list.yaml  (x-local-filter-rule)
//   - specs/api/components/schemas/pi-mini-config.yaml (vNext, validation fallback)
//   - pi's /model ModelSelectorComponent (packages/coding-agent/.../model-selector.ts)
//   - settings.ts loadConfig (field-by-field fallback + legacy migration)
//
// DEVIATION NOTE (picker filtering): the real implementation uses fuzzyFilter
// from @earendil-works/pi-tui, but that package is not resolvable in plain
// node on this machine (the node_modules junction only covers pi-ai), so
// fuzzySubsequenceFilter below reimplements pi-tui's documented algorithm:
// case-insensitive subsequence match per whitespace/slash-separated token,
// all tokens must match, scored by consecutive-match reward (-5n), word-
// boundary reward (-10), gap penalty (+2/char), position penalty (+0.1*i),
// exact-match bonus (-100); sorted best-first. Swap in the real fuzzyFilter
// when implementing against the extension runtime.

/** Provider ids served by a LOCAL runtime (llama.cpp / Ollama-class). */
export const LOCAL_RUNTIME_PROVIDERS = new Set(["ollama", "ollama-mini", "llama-cpp"]);

export const DEFAULT_TINY_REF = { provider: "ollama-mini", modelId: "granite4.2:8b" };

/** The retired default tiny model, migrated on load (settings.ts LEGACY_TINY). */
export const LEGACY_TINY_REF = {
	provider: "ollama",
	modelId: "hf.co/mradermacher/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF:Q4_K_M",
};

export const DEFAULT_CONFIG_VNEXT = {
	tiny: { ...DEFAULT_TINY_REF },
	think: false,
	toolsMode: "curated",
	delegateBudget: 8,
	enabled: false,
};

// ---------------------------------------------------------------------------
// (1) Local-runtime classification (spec: model-list.yaml x-local-filter-rule)
// ---------------------------------------------------------------------------

/**
 * Decision table: is this entry a LOCAL model the settings-page picker may show?
 *   - source "ollama-tags"                                  -> LOCAL (Ollama serves it)
 *   - provider "ollama" | "ollama-mini" | "llama-cpp"       -> LOCAL
 *   - anything else (minimax/openai/anthropic-class)        -> REMOTE
 * @param {{provider?: string, name?: string}} entry ModelRef or /api/tags entry
 * @param {"ollama-tags"|"registry"} [source] where the entry came from
 * @returns {boolean}
 */
export function isLocalModel(entry, source) {
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
 * @param {Array<{name: string, model?: string}>} ollamaTags /api/tags models[]
 * @param {Array<{provider: string, id?: string, modelId?: string, name?: string}>} registryEntries
 * @param {{provider: string, modelId: string}} [currentRef] config tiny ref
 * @returns {Array<{provider: string, modelId: string, name: string, source: "ollama-tags"|"registry", current: boolean, pulled: boolean}>}
 */
export function mergeModelSources(ollamaTags, registryEntries, currentRef) {
	const byKey = new Map();
	const key = (provider, modelId) => `${provider}/${modelId}`;
	const isCurrent = (provider, modelId) =>
		!!currentRef && currentRef.provider === provider && currentRef.modelId === modelId;

	for (const tag of ollamaTags ?? []) {
		if (!tag || typeof tag.name !== "string" || !tag.name) continue;
		const entry = {
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
		if (!isLocalModel(reg, "registry")) continue; // remote providers excluded
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

// ---------------------------------------------------------------------------
// (3) Picker fuzzy filtering (pi-tui fuzzyFilter reimplementation — see note)
// ---------------------------------------------------------------------------

function fuzzyMatchScore(queryLower, textLower) {
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
export function fuzzySubsequenceFilter(items, query, getText) {
	if (!query.trim()) return [...items];
	const tokens = query.trim().split(/[\s/]+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return [...items];
	const results = [];
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
export function filterModels(list, query) {
	return fuzzySubsequenceFilter(list, query, (e) => `${e.provider}/${e.modelId}`);
}

// ---------------------------------------------------------------------------
// (4) Config vNext parsing (settings.ts loadConfig semantics + `enabled`)
// ---------------------------------------------------------------------------

function isModelRef(value) {
	return (
		!!value &&
		typeof value === "object" &&
		typeof value.provider === "string" &&
		typeof value.modelId === "string"
	);
}

function cloneDefaults() {
	return {
		tiny: { ...DEFAULT_CONFIG_VNEXT.tiny },
		think: DEFAULT_CONFIG_VNEXT.think,
		toolsMode: DEFAULT_CONFIG_VNEXT.toolsMode,
		delegateBudget: DEFAULT_CONFIG_VNEXT.delegateBudget,
		enabled: DEFAULT_CONFIG_VNEXT.enabled,
	};
}

/**
 * Parse a raw PiMiniConfig vNext object with field-by-field validation
 * fallback and legacy migration, mirroring settings.ts loadConfig plus the
 * new `enabled` field (default false; non-boolean falls back to false).
 * `large` is preserved when valid, dropped when not.
 * @param {unknown} parsed parsed JSON (already validated as parseable)
 */
export function parseConfigVNext(parsed) {
	const cfg = cloneDefaults();
	if (parsed && typeof parsed === "object") {
		const record = parsed;
		if (isModelRef(record.tiny)) cfg.tiny = { provider: record.tiny.provider, modelId: record.tiny.modelId };
		if (record.large !== undefined) {
			if (isModelRef(record.large)) cfg.large = { provider: record.large.provider, modelId: record.large.modelId };
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
export function parseConfigVNextJson(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return cloneDefaults();
	}
	return parseConfigVNext(parsed);
}

/** Stable serialization for round-trip comparison (saveConfig writes pretty JSON). */
export function serializeConfig(cfg) {
	return `${JSON.stringify(cfg, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// (5) Picker window math (pi /model ModelSelectorComponent updateList)
// ---------------------------------------------------------------------------

export const PICKER_MAX_VISIBLE = 10;

/**
 * Visible window of the filtered list: at most maxVisible rows, sliding so
 * the selection stays centered; clamped to the list edges.
 * Matches pi's: start = max(0, min(selected - floor(max/2), count - max)).
 * @returns {{start: number, end: number}} half-open [start, end)
 */
export function visibleWindow(count, selectedIndex, maxVisible = PICKER_MAX_VISIBLE) {
	if (count <= 0) return { start: 0, end: 0 };
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), count - maxVisible));
	const end = Math.min(start + maxVisible, count);
	return { start, end };
}

/** Wrap-around selection move, mirroring pi's up/down keybindings. */
export function moveSelection(selectedIndex, delta, count) {
	if (count <= 0) return 0;
	return (((selectedIndex + delta) % count) + count) % count;
}
