// Unit tests for the mini-context reference functions (tests/unit/lib/mini-context.mjs).
// Pure logic only — live-model verification lives in scripts/silo/mini-context.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	estimateTokens,
	classifyPath,
	decideFileVerdict,
	buildMiniInstructions,
	isSummaryFresh,
	freshnessOf,
	SAFETY_FACTOR,
	INSTRUCTION_TOKEN_THRESHOLD,
	EFFECTIVE_CONTEXT_WINDOW,
	COMPACTION_THRESHOLD_PERCENT,
	TINY_MAX_TOKENS,
} from "./lib/mini-context.mjs";

const CTX = { cwd: "C:/dev/pi-mini", home: "C:/Users/bramburn" };

// --- 1. estimateTokens ---------------------------------------------------------

test("estimateTokens returns chars, estimatedTokens, method, safetyFactor", () => {
	const est = estimateTokens("abcd");
	assert.equal(est.chars, 4);
	assert.equal(est.method, "chars/4");
	assert.equal(est.safetyFactor, SAFETY_FACTOR);
});

test("estimateTokens is ceil(chars/4 * 1.2)", () => {
	// 10 chars -> 10/4*1.2 = 3 -> ceil 3
	assert.equal(estimateTokens("0123456789").estimatedTokens, 3);
	// 3400 chars -> 1020 -> just over the 1000 threshold
	assert.equal(estimateTokens("x".repeat(3400)).estimatedTokens, 1020);
	// 3333 chars -> 999.9 -> ceil 1000 -> exactly at threshold
	assert.equal(estimateTokens("x".repeat(3333)).estimatedTokens, 1000);
	// empty text -> 0
	assert.equal(estimateTokens("").estimatedTokens, 0);
});

test("threshold boundary: <=1000 inlines, >1000 prompts", () => {
	assert.ok(estimateTokens("x".repeat(3333)).estimatedTokens <= INSTRUCTION_TOKEN_THRESHOLD);
	assert.ok(estimateTokens("x".repeat(3334)).estimatedTokens > INSTRUCTION_TOKEN_THRESHOLD);
});

// --- 2. classifyPath ------------------------------------------------------------

test("classifyPath: global file", () => {
	assert.equal(classifyPath("C:/Users/bramburn/.pi/agent/AGENTS.md", CTX), "global");
});

test("classifyPath: repo-root candidates", () => {
	assert.equal(classifyPath("C:/dev/pi-mini/AGENTS.md", CTX), "repo-root");
	assert.equal(classifyPath("C:/dev/pi-mini/AGENTS.override.md", CTX), "repo-root");
	assert.equal(classifyPath("C:/dev/pi-mini/CLAUDE.md", CTX), "repo-root");
});

test("classifyPath: subfolders rejected", () => {
	assert.equal(classifyPath("C:/dev/pi-mini/src/AGENTS.md", CTX), "rejected-subfolder");
	assert.equal(classifyPath("C:/dev/pi-mini/docs/CLAUDE.md", CTX), "rejected-subfolder");
	assert.equal(classifyPath("C:/dev/pi-mini/.pi/mini/AGENTS.md", CTX), "rejected-subfolder");
});

test("classifyPath: ancestors above cwd are pi's responsibility", () => {
	assert.equal(classifyPath("C:/dev/AGENTS.md", CTX), "ancestor-out-of-scope");
	assert.equal(classifyPath("C:/AGENTS.md", CTX), "ancestor-out-of-scope");
});

test("classifyPath: windows backslash normalization", () => {
	assert.equal(classifyPath("C:\\dev\\pi-mini\\AGENTS.md", CTX), "repo-root");
	assert.equal(classifyPath("C:\\Users\\bramburn\\.pi\\agent\\AGENTS.md", CTX), "global");
	assert.equal(classifyPath("C:\\dev\\pi-mini\\pkg\\AGENTS.md", CTX), "rejected-subfolder");
});

// --- 3. decideFileVerdict --------------------------------------------------------

test("decideFileVerdict: at/under threshold always inlines", () => {
	assert.equal(decideFileVerdict(1000), "inline");
	assert.equal(decideFileVerdict(999), "inline");
	assert.equal(decideFileVerdict(1000, { userChoice: "decline" }), "inline");
});

test("decideFileVerdict: over threshold without choice prompts", () => {
	assert.equal(decideFileVerdict(1400), "summarize-prompted");
	assert.equal(decideFileVerdict(1400, { userChoice: undefined }), "summarize-prompted");
});

test("decideFileVerdict: accept -> summarized, decline -> declined-truncated", () => {
	assert.equal(decideFileVerdict(1400, { userChoice: "summarize", freshness: "fresh" }), "summarized");
	assert.equal(decideFileVerdict(1400, { userChoice: "decline", freshness: "none" }), "declined-truncated");
});

test("decideFileVerdict: stale summary re-prompts regardless of prior choice", () => {
	assert.equal(decideFileVerdict(1400, { userChoice: "summarize", freshness: "stale" }), "summarize-prompted");
	assert.equal(decideFileVerdict(1400, { userChoice: "decline", freshness: "stale" }), "summarize-prompted");
});

// --- 4. buildMiniInstructions ------------------------------------------------------

test("buildMiniInstructions: inline content produces pi-style project_instructions blocks", () => {
	const { instructionBlock, fitsEffectiveWindow } = buildMiniInstructions([
		{ path: "/repo/AGENTS.md", verdict: "inline", content: "Run tests." },
	]);
	assert.equal(
		instructionBlock,
		'<project_instructions path="/repo/AGENTS.md">\nRun tests.\n</project_instructions>\n',
	);
	assert.ok(fitsEffectiveWindow);
});

test("buildMiniInstructions: summarized verdict uses summary text, not source", () => {
	const { instructionBlock } = buildMiniInstructions(
		[{ path: "/repo/AGENTS.md", verdict: "summarized", summaryPath: ".pi/mini/agents.md" }],
		{ "/repo/AGENTS.md": "Summary only." },
	);
	assert.match(instructionBlock, /summarized-from="\.pi\/mini\/agents\.md"/);
	assert.ok(instructionBlock.includes("Summary only."));
	assert.ok(!instructionBlock.includes("FULL SOURCE CONTENT"));
});

test("buildMiniInstructions: declined / omitted / prompted contribute nothing", () => {
	const { instructionBlock } = buildMiniInstructions([
		{ path: "/repo/A.md", verdict: "declined-truncated", content: "FULL A" },
		{ path: "/repo/sub/B.md", verdict: "omitted", content: "FULL B" },
		{ path: "/repo/C.md", verdict: "summarize-prompted", content: "FULL C" },
	]);
	assert.equal(instructionBlock, "");
});

test("buildMiniInstructions: size accounting fits effective window with headroom", () => {
	const bigInline = { path: "/repo/AGENTS.md", verdict: "inline", content: "x".repeat(3333) }; // ~1000 est tokens
	const { estimatedTokens, conversationHeadroomTokens, fitsEffectiveWindow } = buildMiniInstructions([bigInline]);
	assert.equal(estimatedTokens, estimateTokens(`<project_instructions path="/repo/AGENTS.md">\n${bigInline.content}\n</project_instructions>\n`).estimatedTokens);
	assert.equal(conversationHeadroomTokens, EFFECTIVE_CONTEXT_WINDOW - estimatedTokens - TINY_MAX_TOKENS);
	assert.ok(fitsEffectiveWindow);
	assert.ok(conversationHeadroomTokens > 0);
});

test("buildMiniInstructions: overflowing block fails the fit check", () => {
	const huge = { path: "/repo/AGENTS.md", verdict: "inline", content: "x".repeat(300_000) };
	const { fitsEffectiveWindow } = buildMiniInstructions([huge], {}, { effectiveContextWindow: EFFECTIVE_CONTEXT_WINDOW });
	assert.equal(fitsEffectiveWindow, false);
});

test("policy constants match the spec", () => {
	assert.equal(INSTRUCTION_TOKEN_THRESHOLD, 1000);
	assert.equal(EFFECTIVE_CONTEXT_WINDOW, 32768);
	assert.equal(COMPACTION_THRESHOLD_PERCENT, 80);
	assert.equal(TINY_MAX_TOKENS, 8192);
	// Projected usage: the 8192-token output reserve counts as occupied, so the
	// compaction line fires while a full-size generation still fits:
	// compact when (tokens + 8192)/32768 >= 80%  <=>  tokens <= 18022, and
	// 18022 + 8192 = 26214 <= 32768 always holds.
	const projectedCompactAt = (EFFECTIVE_CONTEXT_WINDOW * COMPACTION_THRESHOLD_PERCENT) / 100;
	const actualTokensAtTrigger = projectedCompactAt - TINY_MAX_TOKENS;
	assert.ok(actualTokensAtTrigger > 0);
	assert.ok(actualTokensAtTrigger + TINY_MAX_TOKENS <= EFFECTIVE_CONTEXT_WINDOW);
	// Below the line a full generation fits trivially.
	assert.ok(actualTokensAtTrigger - 1 + TINY_MAX_TOKENS < EFFECTIVE_CONTEXT_WINDOW);
});

// --- 5. isSummaryFresh / freshnessOf ----------------------------------------------

const RECORD = { sourcePath: "/repo/AGENTS.md", sourceMtimeMs: 1000, sourceHash: "abc123" };

test("isSummaryFresh: mtime and hash must both match", () => {
	assert.ok(isSummaryFresh(RECORD, { mtimeMs: 1000, hash: "abc123" }));
	assert.equal(isSummaryFresh(RECORD, { mtimeMs: 2000, hash: "abc123" }), false);
	assert.equal(isSummaryFresh(RECORD, { mtimeMs: 1000, hash: "def456" }), false);
	assert.equal(isSummaryFresh(RECORD, { mtimeMs: 2000, hash: "def456" }), false);
	assert.equal(isSummaryFresh(undefined, { mtimeMs: 1000, hash: "abc123" }), false);
});

test("freshnessOf maps to the labels used by the decision table", () => {
	assert.equal(freshnessOf(RECORD, { mtimeMs: 1000, hash: "abc123" }), "fresh");
	assert.equal(freshnessOf(RECORD, { mtimeMs: 2000, hash: "abc123" }), "stale");
	assert.equal(freshnessOf(undefined, { mtimeMs: 1000, hash: "abc123" }), "none");
});

// --- end-to-end: the freshness scenario outline from freshness.feature ------------

test("freshness.feature scenario outline verdicts", () => {
	const cases = [
		[1000, "abc123", "summarized"],
		[2000, "abc123", "summarize-prompted"],
		[1000, "def456", "summarize-prompted"],
		[2000, "def456", "summarize-prompted"],
	];
	for (const [mtimeMs, hash, expected] of cases) {
		const freshness = freshnessOf(RECORD, { mtimeMs, hash });
		assert.equal(
			decideFileVerdict(1400, { userChoice: "summarize", freshness }),
			expected,
			`mtime=${mtimeMs} hash=${hash} -> ${expected}`,
		);
	}
});
