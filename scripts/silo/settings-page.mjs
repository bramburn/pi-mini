// Live silo for the settings-page feature: proves the riskiest assumptions
// against the real local runtime at OLLAMA_BASE_URL (default
// http://localhost:11434, model granite4.2:8b already loaded).
//
//   node scripts/silo/settings-page.mjs
//
// Probes (1 /api/chat call total, budget ≤ 2):
//   1. DISCOVERY  — GET /api/tags returns ≥1 model including granite4.2:8b;
//                 run the spec'd isLocalModel classifier (model-list.yaml
//                 x-local-filter-rule) over the real payload and log the
//                 resulting local-model table; verify a fuzzy picker query
//                 ("grnt") surfaces the tiny model.
//   2. MODEL RESPONDS — one tiny /api/chat (think:false, num_ctx 4096,
//                 num_predict ≤ 128) on the picked tiny model with a trivial
//                 prompt; assert a non-empty reply.
//
// Evidence: evidence/silo/settings-page.log (via _lib.mjs helpers).
import { check, getTags, logEvidence, postChat, streamDone } from "./_lib.mjs";
import { filterModels, isLocalModel, mergeModelSources } from "../../tests/unit/lib/settings-page.mjs";

const NAME = "settings-page";
const TINY_MODEL = "granite4.2:8b";

logEvidence(NAME, { event: "silo_start", probes: ["discovery", "model-responds"], chat_calls_budget: 2 });

// ---------------------------------------------------------------------------
// Probe 1: DISCOVERY
// ---------------------------------------------------------------------------
logEvidence(NAME, { event: "probe_start", probe: "discovery" });
const tags = await getTags();
check(NAME, Array.isArray(tags.models), "GET /api/tags returned a models array");
check(NAME, tags.models.length >= 1, `GET /api/tags returned >= 1 model (got ${tags.models.length})`);

const names = tags.models.map((m) => m.name);
check(NAME, names.includes(TINY_MODEL), `tiny model ${TINY_MODEL} present in /api/tags`);

// Classify the real payload with the spec'd decision table and log the table.
const table = tags.models.map((m) => {
	const details = m.details ?? {};
	return {
		name: m.name,
		source: "ollama-tags",
		local: isLocalModel(m, "ollama-tags"),
		family: details.family ?? null,
		parameter_size: details.parameter_size ?? null,
		quantization_level: details.quantization_level ?? null,
		context_length: details.context_length ?? null,
	};
});
const localCount = table.filter((r) => r.local).length;
check(NAME, localCount === table.length, `all ${table.length} /api/tags entries classified local (got ${localCount})`);
logEvidence(NAME, { event: "local_model_table", models: table });

// Registry merge: with the ollama-mini catalogue entry, the tiny ref must be
// the current-first row and the tags copy must win the dedup.
const merged = mergeModelSources(tags.models, [
	{ provider: "ollama-mini", id: TINY_MODEL, name: "Granite 4.2 8B (pi-mini orchestrator)" },
]);
const tagsCopy = merged.find((e) => e.provider === "ollama" && e.modelId === TINY_MODEL);
check(NAME, !!tagsCopy && tagsCopy.source === "ollama-tags", "ollama-tags copy wins the (provider, modelId) dedup");
const miniCopy = merged.find((e) => e.provider === "ollama-mini");
check(NAME, !!miniCopy && miniCopy.source === "registry", "ollama-mini registry entry present alongside the tags copy");
logEvidence(NAME, {
	event: "merged_picker_list",
	entries: merged.map((e) => `${e.provider}/${e.modelId} [${e.source}]${e.current ? " ✓current" : ""}`),
});

// Picker search over the real list: "grnt" must surface the tiny model.
const hits = filterModels(merged, "grnt");
check(NAME, hits.length >= 1 && hits.some((e) => e.modelId === TINY_MODEL), `fuzzy query "grnt" surfaces ${TINY_MODEL}`);
logEvidence(NAME, { event: "fuzzy_search", query: "grnt", hits: hits.map((e) => `${e.provider}/${e.modelId}`) });

// ---------------------------------------------------------------------------
// Probe 2: MODEL RESPONDS (the only /api/chat call)
// ---------------------------------------------------------------------------
logEvidence(NAME, { event: "probe_start", probe: "model-responds", model: TINY_MODEL });
const chunks = await postChat({
	model: TINY_MODEL,
	messages: [{ role: "user", content: "Reply with exactly: ok" }],
	think: false,
	options: { num_ctx: 4096, num_predict: 128 },
});
const reply = chunks
	.map((c) => c.message?.content ?? "")
	.join("")
	.trim();
check(NAME, streamDone(chunks), "stream finished with a done chunk");
check(NAME, reply.length > 0, `tiny model returned a non-empty reply (${JSON.stringify(reply.slice(0, 80))})`);
logEvidence(NAME, {
	event: "chat_reply",
	model: TINY_MODEL,
	reply_chars: reply.length,
	done: streamDone(chunks),
	reply_preview: reply.slice(0, 120),
});

logEvidence(NAME, { event: "silo_pass", probes: ["discovery", "model-responds"] });
console.log(`[silo:${NAME}] PASS — ${tags.models.length} local models discovered; tiny model replied (${reply.length} chars)`);
