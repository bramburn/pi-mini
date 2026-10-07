// Silo harness: mini-context summarization against the live tiny model.
//
// Proves the riskiest assumption of specs/features/mini-context/summarization.feature:
// granite4.2:8b can compress a ~1200-1500-token AGENTS.md into a <=1000-est.-token
// summary that retains the operational canary facts (commands, conventions,
// forbidden actions, verification steps).
//
// Run explicitly (never via npm test):
//   node scripts/silo/mini-context.mjs
// Evidence -> evidence/silo/mini-context.log
//
// Budget: at most 2 POST /api/chat calls (spec allows <=3); think:false,
// pinned num_ctx 8192, num_predict cap (see specs/api/paths/ollama/chat.yaml).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OLLAMA_BASE_URL, getTags, postChat, streamDone, check, logEvidence } from "./_lib.mjs";
import { estimateTokens } from "../../tests/unit/lib/mini-context.mjs";

const SILO = "mini-context";

// --- config ----------------------------------------------------------------

function resolveModelId() {
	const cfgPath = process.env.PI_MINI_CONFIG ?? path.join(os.homedir(), ".pi", "agent", "pi-mini.json");
	try {
		const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
		if (cfg?.tiny?.modelId) return cfg.tiny.modelId;
	} catch {
		// fall through to default
	}
	return "granite4.2:8b";
}

const MODEL = resolveModelId();
const NUM_CTX = 8192;
const NUM_PREDICT = 4096; // hard generation cap; a <=1000-est.-token summary needs far less
const SUMMARY_CHAR_CAP = 3300; // 3300/4*1.2 = 990 est tokens — under the 1000 threshold

// --- synthetic over-budget AGENTS.md ----------------------------------------

// 5 canary facts the spec'd quality bar requires the summary to retain
// (case-insensitive substring match).
const CANARIES = [
	"always run npm test before commit",
	"never edit delegate.ts",
	"tests live in tests/unit",
	"use pnpm not npm",
	"verify with npm run lint",
];

const INSTRUCTION_LINES = [
	"# AGENTS.md — pi-mini repository instructions (normative for every agent session in this repo)",
	"",
	"## Build and test",
	"- Run `pnpm build` before submitting any change, and fix every TypeScript error it surfaces before moving on to the next task, because the CI gate treats build warnings as failures.",
	"- " + CANARIES[0] + ", and treat a red test run as a hard stop: no feature work continues until the suite is green again.",
	"- " + CANARIES[3] + "; the lockfile is pnpm-lock.yaml and package-lock.json must never appear in a pull request, because mixed package managers broke the monorepo junctions in the past.",
	"- " + CANARIES[4] + " after every edit to parser.ts or wrapfix.ts, since those two files are the most regression-prone surfaces in the extension.",
	"",
	"## Code conventions",
	"- TypeScript strict mode everywhere; no `any` without a comment explaining why, and no `as unknown as` casts outside of test files where the underlying library lacks type definitions.",
	"- Prefer small pure functions in `tests/unit/lib/` for logic that does not need a model, so the riskiest decisions (budgets, verdicts, estimates) are unit-testable without a live Ollama.",
	"- Every tool call the tiny model emits must pass through the wrap-fix guard before execution, and any residual unparsed text longer than 200 characters must be logged and dropped, never executed speculatively.",
	"- Keep the injected system prompt under 1000 estimated tokens; when an instruction file exceeds that, summarize it into .pi/mini/agents.md instead of truncating it silently.",
	"",
	"## Repository layout",
	"- Extension entry point: index.ts (registers tools, the before_agent_start hook, and the per-turn delegate caps); Ollama transport: ollama-native.ts (NDJSON stream, 90-second stall watchdog, pinned num_ctx).",
	"- Wrap-fix: wrapfix.ts (json/tool-call repair with the 200-char residual guard); delegation: delegate.ts routes large work to the worker model and " + CANARIES[1] + " — changes go through delegate-proposals.md first.",
	"",
	"## Testing",
	"- " + CANARIES[2] + ", auto-discovered by node --test; contract tests in tests/contract/ validate the specs/ tree (YAML parse, $ref resolution, Gherkin well-formedness, spectral lint).",
	"- Live probes in scripts/silo/*.mjs run only on demand and are never part of npm test, because they need a running Ollama; each probe pins num_ctx, caps num_predict, and sends think:false.",
	"",
	"## Workflow and loop state",
	"- Spec-first: behavior changes land in specs/ before code, and the Gherkin scenarios in specs/features/ are the acceptance criteria for every feature slice delivered by a feature agent.",
	"- The goal loop writes events to .pi/goals and the ledger must never be hand-edited; mini mode state (summaries, budgets) belongs under .pi/mini/ alongside it.",
	"- If the model loops on a failing tool call twice, call delegate_to_worker immediately instead of retrying a third time, and record the failure reason in the goal ledger for the audit pass.",
	"- Commit messages follow conventional commits (feat:, fix:, spec:); do not commit generated evidence logs, and reload with /reload after changing specs so the resource loader re-runs.",
	"",
	"## Notes for agents",
	"- Large AGENTS.md files must be summarized into .pi/mini/agents.md before use in mini mode, subfolder AGENTS.md files are never loaded into mini context, and only the repo root file plus the global ~/.pi/agent/AGENTS.md are eligible for measurement.",
	"- Keep responses in mini mode terse; the effective context window is 32768 tokens against the 131072-token model maximum, with compaction at 80 percent via delegate/summarize so the goal never falls out of the window.",
	"",
	"## Release checklist",
	"- Before tagging a release, run the full npm test suite plus the spectral lint over specs/api/openapi.yaml and specs/async/asyncapi.yaml, confirm the evidence/ directory has fresh silo logs for every changed feature, and bump the version in package.json in the same commit as the changelog entry.",
	"- Versioning follows semver for the extension API surface: adding a tool is minor, removing or renaming one is major, and spec-only additions are patch-level; document every change in README.md under the Changelog heading with the date in ISO format.",
	"",
];

const sourceText = INSTRUCTION_LINES.join("\n");

// --- spec'd bounded extraction prompt ---------------------------------------

function extractionPrompt(source) {
	return [
		"Summarize the repository instruction file below for a small coding model.",
		`Hard limits: at most ${SUMMARY_CHAR_CAP} characters; at most 40 lines.`,
		"You MUST preserve, verbatim or near-verbatim, every:",
		"- command (build/test/lint commands)",
		"- convention (code style, layout rules)",
		"- forbidden action (things never to do)",
		"- verification step (what to run after changes)",
		"Rules for preserving facts:",
		"- Keep imperative sentences intact, including modal words like 'always' and 'never' — never soften or drop them.",
		"- Write plain text: do NOT wrap words in backticks, quotes, or brackets; keep punctuation simple.",
		"- If a line says 'never do X', the summary must contain both 'never' and 'X'.",
		"Drop prose, rationale, and history. Output ONLY the summary, no preamble.",
		"",
		"=== BEGIN INSTRUCTION FILE ===",
		source,
		"=== END INSTRUCTION FILE ===",
	].join("\n");
}

// --- helpers ----------------------------------------------------------------

function assistantText(chunks) {
	return chunks
		.filter((c) => c.message?.role === "assistant" && typeof c.message?.content === "string")
		.map((c) => c.message.content)
		.join("");
}

async function summarizeOnce(prompt) {
	const chunks = await postChat(
		{
			model: MODEL,
			messages: [
				{ role: "system", content: "You compress repository instruction files for small models. Follow the length limits exactly." },
				{ role: "user", content: prompt },
			],
			think: false,
			options: { num_ctx: NUM_CTX, num_predict: NUM_PREDICT, temperature: 0 },
		},
		{ onChunk: () => {} },
	);
	check(SILO, streamDone(chunks), "stream finished with a done chunk");
	return assistantText(chunks).trim();
}

// --- main -------------------------------------------------------------------

async function main() {
	logEvidence(SILO, { event: "silo_start", model: MODEL, ollama: OLLAMA_BASE_URL, num_ctx: NUM_CTX, num_predict: NUM_PREDICT });

	const tags = await getTags();
	check(SILO, tags.models.some((m) => m.name === MODEL), `model ${MODEL} is present in /api/tags`);
	logEvidence(SILO, { event: "model_present", model: MODEL });

	// (1) synthetic source: assert it lands in the 1200-1500 est-token band
	const srcEst = estimateTokens(sourceText);
	check(
		SILO,
		srcEst.estimatedTokens >= 1200 && srcEst.estimatedTokens <= 1500,
		`synthetic AGENTS.md estimated at ${srcEst.estimatedTokens} tokens (target 1200-1500, chars ${srcEst.chars})`,
	);
	logEvidence(SILO, { event: "source_measured", ...srcEst, canaries: CANARIES.length });

	logEvidence(SILO, { event: "extraction_prompt", prompt: extractionPrompt(sourceText) });

	// (2) run the spec'd extraction prompt; one bounded retry if over budget
	let summary = await summarizeOnce(extractionPrompt(sourceText));
	let calls = 1;
	let sumEst = estimateTokens(summary);
	if (sumEst.estimatedTokens > 1000) {
		logEvidence(SILO, { event: "retry_over_budget", attempt1: sumEst });
		summary = await summarizeOnce(
			[
				`Your previous summary was ${sumEst.chars} characters — too long.`,
				`Rewrite it under ${SUMMARY_CHAR_CAP} characters. Keep every command, convention, forbidden action, and verification step. Output only the summary.`,
				"",
				"=== BEGIN INSTRUCTION FILE ===",
				sourceText,
				"=== END INSTRUCTION FILE ===",
			].join("\n"),
		);
		calls += 1;
		sumEst = estimateTokens(summary);
	}
	logEvidence(SILO, { event: "api_chat_calls_used", calls, cap: 3 });
	check(SILO, calls <= 3, `used ${calls} /api/chat calls (cap 3)`);
	logEvidence(SILO, { event: "summary_generated", ...sumEst, summary });

	// (3a) quality bar: summary estimated <= 1000 tokens
	check(
		SILO,
		sumEst.estimatedTokens <= 1000,
		`summary estimated at ${sumEst.estimatedTokens} tokens <= 1000 (chars ${sumEst.chars})`,
	);

	// (3b) canary retention, recorded per fact even on failure.
	// Two signals, both logged honestly:
	//   verbatim — normalized substring (backticks/punctuation-insensitive);
	//   keyword  — every content word (>=4 chars) of the fact appears somewhere.
	// A fact counts as retained if either signal passes; verbatim-only matches
	// are reported separately so quality-bar drift is visible in the evidence.
	const normalize = (s) =>
		s
			.toLowerCase()
			.replace(/`/g, "")
			.replace(/[^a-z0-9./]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	const normSummary = normalize(summary);
	const contentWords = (fact) => normalize(fact).split(" ").filter((w) => w.replace(/[^a-z0-9]/g, "").length >= 4);
	const retention = CANARIES.map((fact) => {
		const verbatim = normSummary.includes(normalize(fact));
		const keywords = contentWords(fact);
		const keywordHit = keywords.length > 0 && keywords.every((w) => normSummary.includes(w));
		return { fact, verbatim, keyword: keywordHit, retained: verbatim || keywordHit };
	});
	logEvidence(SILO, { event: "canary_retention", retention });
	const retainedCount = retention.filter((r) => r.retained).length;
	console.log("\ncanary retention:");
	for (const r of retention) console.log(`  [${r.retained ? "PASS" : "FAIL"}]${r.retained && !r.verbatim ? " (keyword-only)" : ""} ${r.fact}`);
	console.log(`  ${retainedCount}/${CANARIES.length} retained; summary est. ${sumEst.estimatedTokens} tokens (${sumEst.chars} chars)\n`);
	// Honest reporting: failure is logged and reported, and fails the harness (gates audits).
	check(SILO, retainedCount === CANARIES.length, `all ${CANARIES.length} canaries retained (got ${retainedCount})`);

	logEvidence(SILO, { event: "silo_ok", retainedCount, totalCanaries: CANARIES.length, summaryEstTokens: sumEst.estimatedTokens });
	console.log(`silo mini-context OK: ${retainedCount}/${CANARIES.length} canaries retained, summary <= 1000 est. tokens, ${calls}/3 chat calls`);
}

main().catch((err) => {
	logEvidence(SILO, { event: "silo_failed", error: String(err?.stack ?? err) });
	console.error(err);
	process.exit(1);
});
