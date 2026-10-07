// Pure reference functions for the mini-context feature
// (specs/features/mini-context/*.feature). These mirror the spec'd behavior so
// the riskiest logic — token estimation, path classification, the verdict
// decision table, instruction-block assembly, and summary freshness — is
// testable without a live model.
//
// SPEC DECISIONS EMBODIED HERE (see also specs/api/components/schemas/context-budget.yaml):
//   * Estimator: no offline tokenizer exists, so estimatedTokens =
//     ceil(chars / 4 * SAFETY_FACTOR) with SAFETY_FACTOR = 1.2. The 1000-token
//     threshold is always evaluated against this estimate (over-counts on
//     purpose so borderline files are summarized rather than inlined).
//   * Eligible scope: only the global file (~/.pi/agent/AGENTS.md) and the
//     repo-root/cwd-level candidates are measured by mini. Files pi loads from
//     ABOVE the repo root via its upward walk are pi's responsibility and are
//     reported as "ancestor-out-of-scope" — mini neither measures them nor
//     includes them in its instruction block. Subfolder files are
//     "rejected-subfolder" and never enter mini context.

export const ESTIMATOR_METHOD = "chars/4";
export const SAFETY_FACTOR = 1.2;
export const INSTRUCTION_TOKEN_THRESHOLD = 1000;
export const EFFECTIVE_CONTEXT_WINDOW = 32768; // vs 131072 model max: see schema rationale
export const COMPACTION_THRESHOLD_PERCENT = 80;
export const TINY_MAX_TOKENS = 8192;

/** 1. Offline token estimate per spec: ceil(chars/4 * safetyFactor). */
export function estimateTokens(text, { safetyFactor = SAFETY_FACTOR } = {}) {
	const chars = text.length;
	return {
		chars,
		estimatedTokens: Math.ceil((chars / 4) * safetyFactor),
		method: ESTIMATOR_METHOD,
		safetyFactor,
	};
}

/**
 * 2. Classify a candidate instruction path.
 * Returns "global" | "repo-root" | "rejected-subfolder" | "ancestor-out-of-scope".
 *
 * "ancestor-out-of-scope" is a fourth, documented value for files above cwd:
 * pi's resource loader already walks upward from cwd collecting them, so they
 * are pi's responsibility and mini does not measure or inject them. (The
 * FileBudgetReport.scope enum carries only the three spec'd values because
 * out-of-scope ancestors never reach a budget report.)
 */
export function classifyPath(inputPath, { cwd, home }) {
	const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
	const p = norm(inputPath);
	const root = norm(cwd);
	const globalPath = `${norm(home)}/.pi/agent/AGENTS.md`;
	if (p === globalPath) return "global";
	if (!p.startsWith(`${root}/`)) return "ancestor-out-of-scope"; // parents of cwd: pi's responsibility
	const rel = p.slice(root.length + 1);
	return rel.includes("/") ? "rejected-subfolder" : "repo-root";
}

/**
 * 3. Verdict decision table.
 * @param {number} estTokens estimated tokens of the file
 * @param {object} opts
 * @param {string} [opts.userChoice] undefined | "summarize" | "decline"
 * @param {"fresh"|"stale"|"none"} [opts.freshness] "none" = no summary record exists
 * @param {number} [opts.threshold]
 */
export function decideFileVerdict(estTokens, { userChoice, freshness = "none", threshold = INSTRUCTION_TOKEN_THRESHOLD } = {}) {
	if (estTokens <= threshold) return "inline";
	if (freshness === "stale") return "summarize-prompted"; // stale never silently reused
	if (userChoice === "summarize") return "summarized";
	if (userChoice === "decline") return "declined-truncated";
	return "summarize-prompted"; // over threshold, not yet answered
}

/**
 * 4. Assemble the exact instruction block injected into MINI_SYSTEM_PROMPT.
 * Only "inline" (full content) and "summarized" (summary content) reports
 * produce blocks; "declined-truncated", "omitted", and out-of-scope entries
 * contribute nothing. Mirrors pi's <project_instructions path="..."> rendering.
 *
 * @param {Array<{path: string, verdict: string, content?: string, summaryPath?: string}>} reports
 * @param {Object<string, string>} [summaries] map of report.path -> summary text
 * @param {object} [policy]
 */
export function buildMiniInstructions(reports, summaries = {}, policy = {}) {
	const effectiveWindow = policy.effectiveContextWindow ?? EFFECTIVE_CONTEXT_WINDOW;
	const maxTokens = policy.tinyMaxTokens ?? TINY_MAX_TOKENS;
	const parts = [];
	for (const r of reports) {
		if (r.verdict === "inline" && typeof r.content === "string") {
			parts.push(`<project_instructions path="${r.path}">\n${r.content}\n</project_instructions>`);
		} else if (r.verdict === "summarized") {
			const summary = summaries[r.path];
			if (typeof summary === "string" && summary.length > 0) {
				const source = r.summaryPath ?? ".pi/mini/agents.md";
				parts.push(`<project_instructions path="${r.path}" summarized-from="${source}">\n${summary}\n</project_instructions>`);
			}
		}
		// declined-truncated / omitted / summarize-prompted -> nothing injected
	}
	const instructionBlock = parts.length ? `${parts.join("\n\n")}\n` : "";
	const est = estimateTokens(instructionBlock);
	// Size accounting: instruction block + output reserve (TINY_MAX_TOKENS)
	// must fit the effective window; the remainder is conversation headroom.
	const conversationHeadroomTokens = effectiveWindow - est.estimatedTokens - maxTokens;
	return {
		instructionBlock,
		estimatedTokens: est.estimatedTokens,
		effectiveContextWindow: effectiveWindow,
		outputReserveTokens: maxTokens,
		conversationHeadroomTokens,
		fitsEffectiveWindow: conversationHeadroomTokens >= 0,
	};
}

/** 5. Summary freshness: mtime AND hash must both match the stored record. */
export function isSummaryFresh(record, { mtimeMs, hash }) {
	if (!record) return false;
	return record.sourceMtimeMs === mtimeMs && record.sourceHash === hash;
}

/** Convenience: freshness label used by decideFileVerdict. */
export function freshnessOf(record, { mtimeMs, hash }) {
	if (!record) return "none";
	return isSummaryFresh(record, { mtimeMs, hash }) ? "fresh" : "stale";
}
