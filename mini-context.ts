// Mini-context module: budget detection, one-time summarize/decline prompting,
// summary persistence, and instruction-block assembly for mini mode.
//
// PROMOTED from tests/unit/lib/mini-context.mjs (the canonical reference
// implementation). The pure functions below — estimateTokens, classifyPath,
// decideFileVerdict, buildMiniInstructions, isSummaryFresh, freshnessOf — keep
// the exact names and semantics of that reference; tests/unit/lib/mini-context.mjs
// is now a re-export shim so the 21 existing unit tests keep passing unchanged.
//
// Spec decisions embodied here (specs/api/components/schemas/context-budget.yaml,
// specs/features/mini-context/*.feature):
//   * Estimator: ceil(chars / 4 * SAFETY_FACTOR), SAFETY_FACTOR = 1.2. The
//     1000-token threshold is always evaluated against this estimate.
//   * Eligible scope: only the global file (~/.pi/agent/AGENTS.md) and
//     repo-root/cwd-level candidates are measured by mini. Files pi loads from
//     ABOVE the repo root via its upward walk are pi's responsibility
//     (classifyPath returns "ancestor-out-of-scope"); subfolder files are
//     "rejected-subfolder" and never enter mini context.
//   * Over-threshold files prompt the user exactly once per
//     (path, mtimeMs, hash). Decline = omit (never load full). A changed mtime
//     or hash marks the stored decision stale and re-prompts.
//   * Summaries live under .pi/mini/. The global file's summary keeps the
//     spec'd convention .pi/mini/agents.md; every other (repo-root) file gets
//     its own .pi/mini/agents-<slug>.md so two summarized files never clobber
//     each other (slug = lowercased basename, non-alphanumerics folded to "-").

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OLLAMA_BASE_URL } from "./settings.ts";

// ---------------------------------------------------------------------------
// Policy constants (spec: ContextBudgetPolicy)
// ---------------------------------------------------------------------------

export const ESTIMATOR_METHOD = "chars/4";
export const SAFETY_FACTOR = 1.2;
export const INSTRUCTION_TOKEN_THRESHOLD = 1000;
export const EFFECTIVE_CONTEXT_WINDOW = 32768; // vs 131072 model max: see schema rationale
export const COMPACTION_THRESHOLD_PERCENT = 80;
export const TINY_MAX_TOKENS = 8192;

/** Byte budget for the wrapped <mini_context> block injected into the mini system prompt. */
export const MINI_CONTEXT_BLOCK_BUDGET = 4096;

/** Repo-root candidate names, in pi resource-loader priority order. */
export const CANDIDATE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

// ---------------------------------------------------------------------------
// 1. Token estimation (promoted, exact semantics)
// ---------------------------------------------------------------------------

export interface TokenEstimate {
	chars: number;
	estimatedTokens: number;
	method: string;
	safetyFactor: number;
}

/** 1. Offline token estimate per spec: ceil(chars/4 * safetyFactor). */
export function estimateTokens(text: string, { safetyFactor = SAFETY_FACTOR } = {}): TokenEstimate {
	const chars = text.length;
	return {
		chars,
		estimatedTokens: Math.ceil((chars / 4) * safetyFactor),
		method: ESTIMATOR_METHOD,
		safetyFactor,
	};
}

// ---------------------------------------------------------------------------
// 2. Path classification (promoted, exact semantics)
// ---------------------------------------------------------------------------

export type PathScope = "global" | "repo-root" | "rejected-subfolder" | "ancestor-out-of-scope";

/**
 * Classify a candidate instruction path.
 * "ancestor-out-of-scope" is a fourth, documented value for files above cwd:
 * pi's resource loader already walks upward from cwd collecting them, so they
 * are pi's responsibility and mini does not measure or inject them.
 */
export function classifyPath(inputPath: string, { cwd, home }: { cwd: string; home: string }): PathScope {
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
	const p = norm(inputPath);
	const root = norm(cwd);
	const globalPath = `${norm(home)}/.pi/agent/AGENTS.md`;
	if (p === globalPath) return "global";
	if (!p.startsWith(`${root}/`)) return "ancestor-out-of-scope"; // parents of cwd: pi's responsibility
	const rel = p.slice(root.length + 1);
	return rel.includes("/") ? "rejected-subfolder" : "repo-root";
}

// ---------------------------------------------------------------------------
// 3. Verdict decision table (promoted, exact semantics)
// ---------------------------------------------------------------------------

export type FileVerdict = "inline" | "summarize-prompted" | "summarized" | "declined-truncated" | "omitted";
export type Freshness = "fresh" | "stale" | "none";
export type UserChoice = "summarize" | "decline";

export function decideFileVerdict(
	estTokens: number,
	{ userChoice, freshness = "none", threshold = INSTRUCTION_TOKEN_THRESHOLD }: {
		userChoice?: UserChoice;
		freshness?: Freshness;
		threshold?: number;
	} = {},
): FileVerdict {
	if (estTokens <= threshold) return "inline";
	if (freshness === "stale") return "summarize-prompted"; // stale never silently reused
	if (userChoice === "summarize") return "summarized";
	if (userChoice === "decline") return "declined-truncated";
	return "summarize-prompted"; // over threshold, not yet answered
}

// ---------------------------------------------------------------------------
// 4. Instruction-block assembly (promoted, exact semantics)
// ---------------------------------------------------------------------------

export interface InstructionReportEntry {
	path: string;
	verdict: string;
	content?: string;
	summaryPath?: string;
}

export interface MiniInstructionsResult {
	instructionBlock: string;
	estimatedTokens: number;
	effectiveContextWindow: number;
	outputReserveTokens: number;
	conversationHeadroomTokens: number;
	fitsEffectiveWindow: boolean;
}

/**
 * Assemble the exact instruction block injected into the mini system prompt.
 * Only "inline" (full content) and "summarized" (summary content) reports
 * produce blocks; "declined-truncated", "omitted", and out-of-scope entries
 * contribute nothing. Mirrors pi's <project_instructions path="..."> rendering.
 */
export function buildMiniInstructions(
	reports: InstructionReportEntry[],
	summaries: Record<string, string> = {},
	policy: { effectiveContextWindow?: number; tinyMaxTokens?: number } = {},
): MiniInstructionsResult {
	const effectiveWindow = policy.effectiveContextWindow ?? EFFECTIVE_CONTEXT_WINDOW;
	const maxTokens = policy.tinyMaxTokens ?? TINY_MAX_TOKENS;
	const parts: string[] = [];
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

/** buildMiniInstructions renamed for block assembly: same promoted logic. */
export function buildMiniInstructionsBlock(
	reports: InstructionReportEntry[],
	summariesByPath: Record<string, string> = {},
	policy: { effectiveContextWindow?: number; tinyMaxTokens?: number } = {},
): MiniInstructionsResult {
	return buildMiniInstructions(reports, summariesByPath, policy);
}

// ---------------------------------------------------------------------------
// 5. Summary freshness (promoted, exact semantics)
// ---------------------------------------------------------------------------

export interface SummaryRecord {
	sourcePath: string;
	sourceMtimeMs: number;
	sourceHash: string;
	summaryPath?: string;
	createdAt: string;
	createdBy?: "mini" | "worker";
	choice?: "summarized" | "declined";
}

/** Summary freshness: mtime AND hash must both match the stored record. */
export function isSummaryFresh(record: SummaryRecord | undefined, { mtimeMs, hash }: { mtimeMs: number; hash: string }): boolean {
	if (!record) return false;
	return record.sourceMtimeMs === mtimeMs && record.sourceHash === hash;
}

/** Convenience: freshness label used by decideFileVerdict. */
export function freshnessOf(record: SummaryRecord | undefined, { mtimeMs, hash }: { mtimeMs: number; hash: string }): Freshness {
	if (!record) return "none";
	return isSummaryFresh(record, { mtimeMs, hash }) ? "fresh" : "stale";
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface InstructionFile {
	path: string;
	scope: "global" | "repo-root";
	content: string;
}

/**
 * Discover the eligible instruction files mini measures: the global
 * ~/.pi/agent/AGENTS.md plus the FIRST existing cwd-root candidate in pi's
 * priority order (AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md,
 * CLAUDE.MD — override wins, at most one repo-root file). Missing files are
 * simply absent. Subfolder files never enter mini context and ancestors are
 * pi's responsibility, so neither is discovered here.
 */
export function discoverInstructionFiles(cwd: string, homeDir: string = os.homedir()): InstructionFile[] {
	const files: InstructionFile[] = [];
	const globalPath = path.join(homeDir, ".pi", "agent", "AGENTS.md");
	try {
		const content = fs.readFileSync(globalPath, "utf8");
		files.push({ path: globalPath, scope: "global", content });
	} catch {
		// missing global file: absent
	}
	for (const name of CANDIDATE_NAMES) {
		const candidate = path.join(cwd, name);
		try {
			const content = fs.readFileSync(candidate, "utf8");
			files.push({ path: candidate, scope: "repo-root", content });
			break; // override-first ordering: first existing candidate wins
		} catch {
			// missing candidate: try the next name
		}
	}
	return files;
}

// ---------------------------------------------------------------------------
// Budget evaluation
// ---------------------------------------------------------------------------

export interface ContextBudgetPolicy {
	threshold?: number;
}

export interface FileBudgetReport {
	path: string;
	scope: "global" | "repo-root" | "rejected-subfolder";
	estimatedTokens: TokenEstimate;
	threshold: number;
	verdict: FileVerdict;
	summaryPath?: string;
	content?: string;
}

/** Anything evaluateFiles can measure: discovered files, or defensive entries. */
export interface EvaluatableFile {
	path: string;
	scope: string;
	content: string;
}

/**
 * Per-file budget report: measure each discovered file with the offline
 * estimator and run the verdict decision table. Subfolder-scoped entries
 * (defensive) are reported as "omitted".
 */
export function evaluateFiles(files: EvaluatableFile[], policy: ContextBudgetPolicy = {}): FileBudgetReport[] {
	const threshold = policy.threshold ?? INSTRUCTION_TOKEN_THRESHOLD;
	return files.map((file) => {
		const est = estimateTokens(file.content);
		const verdict: FileVerdict =
			file.scope === "rejected-subfolder" ? "omitted" : decideFileVerdict(est.estimatedTokens, { threshold });
		return {
			path: file.path,
			scope: file.scope as FileBudgetReport["scope"],
			estimatedTokens: est,
			threshold,
			verdict,
			content: file.content,
		};
	});
}

// ---------------------------------------------------------------------------
// Decision persistence (.pi/mini/context-decisions.json)
// ---------------------------------------------------------------------------

/** Directory holding mini's summaries and decision store. PI_MINI_DIR overrides for tests. */
export function miniDir(cwd: string): string {
	return process.env.PI_MINI_DIR ?? path.join(cwd, ".pi", "mini");
}

export function decisionsPath(cwd: string): string {
	return path.join(miniDir(cwd), "context-decisions.json");
}

/** Decision key: exactly one prompt per (path, mtimeMs, content hash). */
export function decisionKey(filePath: string, mtimeMs: number, hash: string): string {
	return `${filePath}@${mtimeMs}@${hash}`;
}

export function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Persisted decision map: decisionKey -> summary/decline record. */
export type DecisionMap = Record<string, SummaryRecord>;

export function loadDecisions(cwd: string): DecisionMap {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(decisionsPath(cwd), "utf8"));
		if (parsed && typeof parsed === "object") return parsed as DecisionMap;
	} catch {
		// missing or malformed store: start empty
	}
	return {};
}

export function saveDecisions(decisions: DecisionMap, cwd: string): void {
	const file = decisionsPath(cwd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(decisions, null, 2));
}

// ---------------------------------------------------------------------------
// Summary naming
// ---------------------------------------------------------------------------

/**
 * Summary file naming decision: the global ~/.pi/agent/AGENTS.md keeps the
 * spec'd convention .pi/mini/agents.md; every other file gets its own
 * .pi/mini/agents-<slug>.md (slug from the lowercased basename) so two
 * summarized files can coexist without clobbering each other.
 */
export function summaryPathFor(file: { path: string; scope: string }, cwd: string): string {
	if (file.scope === "global") return path.join(miniDir(cwd), "agents.md");
	const base = path.basename(file.path).replace(/\.(md|MD)$/i, "");
	const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "file";
	return path.join(miniDir(cwd), `agents-${slug}.md`);
}

// ---------------------------------------------------------------------------
// Summarization via the tiny model (Ollama native /api/chat)
// ---------------------------------------------------------------------------

/**
 * Bounded extraction prompt (spec: summarization.feature). Plain text, no
 * backticks: operational facts only, always/never directives kept verbatim.
 */
export const SUMMARY_EXTRACTION_PROMPT = [
	"You are condensing a repository instruction file into a compact operational summary.",
	"Preserve, verbatim, every operational fact: build/test/lint commands, project conventions,",
	"forbidden actions, and verification steps. Keep every sentence that contains the words",
	"always or never exactly as written. Drop background, rationale, and prose that does not",
	"change what the agent must do. Output plain text only: no markdown, no code fences, no",
	"backticks, no commentary. The summary must be short enough to read in a few seconds.",
].join(" ");

export interface MiniContextModelConfig {
	tiny: { provider: string; modelId: string };
}

async function summarizeFile(
	file: InstructionFile,
	cfg: MiniContextModelConfig,
	cwd: string,
	fetchImpl: typeof fetch,
): Promise<{ summaryPath: string; summary: string }> {
	const res = await fetchImpl(`${OLLAMA_BASE_URL}/api/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: cfg.tiny.modelId,
			think: false,
			num_ctx: TINY_MAX_TOKENS,
			stream: false,
			messages: [
				{ role: "system", content: SUMMARY_EXTRACTION_PROMPT },
				{ role: "user", content: file.content },
			],
		}),
	});
	if (!res.ok) throw new Error(`ollama /api/chat returned ${res.status}`);
	const body = (await res.json()) as { message?: { content?: string } };
	const summary = body?.message?.content?.trim() ?? "";
	if (!summary) throw new Error("ollama returned an empty summary");
	const summaryPath = summaryPathFor(file, cwd);
	fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
	fs.writeFileSync(summaryPath, `${summary}\n`, "utf8");
	return { summaryPath, summary };
}

// ---------------------------------------------------------------------------
// Host-facing structural types (structural, so real pi objects satisfy them)
// ---------------------------------------------------------------------------

export interface MiniContextUI {
	confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface MiniContextCtx {
	ui: MiniContextUI;
}

// ---------------------------------------------------------------------------
// ensureMiniContext: discover -> evaluate -> prompt once -> summarize/decline
// ---------------------------------------------------------------------------

export interface EnsureMiniContextOptions {
	cwd: string;
	/** Defaults to os.homedir(); injectable for tests. */
	homeDir?: string;
	cfg: MiniContextModelConfig;
	fetchImpl?: typeof fetch;
	isEnabled: () => boolean;
	/** Test/integrator hook; defaults to ctx.ui.confirm. Resolves true = summarize. */
	prompt?: (file: InstructionFile, estTokens: number) => Promise<boolean>;
}

export interface EnsureMiniContextResult {
	reports: FileBudgetReport[];
	/** Paths the user was actually prompted for this run. */
	prompted: string[];
	/** Summary text by source path for files summarized this run. */
	summaries: Record<string, string>;
}

async function defaultPrompt(ctx: MiniContextCtx, file: InstructionFile, estTokens: number, threshold: number): Promise<boolean> {
	return ctx.ui.confirm(
		"Mini context budget",
		`${file.path} is ~${estTokens} tokens (over the ${threshold} mini budget). Build a mini summary now?`,
	);
}

/**
 * Evaluate the mini context budget and settle any pending summarize prompts.
 * Runs ONLY when opts.isEnabled() (kill switch: --no-context-files / mini off
 * injects nothing). Fail-safe: a fetch failure notifies and records a decline,
 * it never throws into the session.
 */
export async function ensureMiniContext(ctx: MiniContextCtx, opts: EnsureMiniContextOptions): Promise<EnsureMiniContextResult> {
	const empty: EnsureMiniContextResult = { reports: [], prompted: [], summaries: {} };
	if (!opts.isEnabled()) return empty;

	const { cwd, cfg } = opts;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const files = discoverInstructionFiles(cwd, opts.homeDir ?? os.homedir());
	const reports = evaluateFiles(files);
	const decisions = loadDecisions(cwd);
	const prompted: string[] = [];
	const summaries: Record<string, string> = {};
	let dirty = false;

	for (const report of reports) {
		if (report.verdict !== "summarize-prompted") continue;
		const file = files.find((f) => f.path === report.path);
		if (!file) continue;
		const stat = fs.statSync(file.path);
		const hash = hashContent(file.content);
		const key = decisionKey(file.path, stat.mtimeMs, hash);
		const record = decisions[key];
		// Keyed by (path, mtimeMs, hash): an existing entry is fresh by
		// construction; a changed source produces a new key and re-prompts.
		if (record) {
			report.verdict = record.choice === "summarized" ? "summarized" : "declined-truncated";
			if (record.choice === "summarized" && record.summaryPath) report.summaryPath = record.summaryPath;
			continue;
		}
		const ask = opts.prompt ?? ((f: InstructionFile, est: number) => defaultPrompt(ctx, f, est, report.threshold));
		const accept = await ask(file, report.estimatedTokens.estimatedTokens);
		prompted.push(file.path);
		if (!accept) {
			decisions[key] = {
				sourcePath: file.path,
				sourceMtimeMs: stat.mtimeMs,
				sourceHash: hash,
				createdAt: new Date().toISOString(),
				choice: "declined",
			};
			report.verdict = "declined-truncated";
			dirty = true;
			continue;
		}
		try {
			const { summaryPath, summary } = await summarizeFile(file, cfg, cwd, fetchImpl);
			// Quality gate (summarization.feature): a summary over the instruction
			// threshold is not usable; fail safe by declining instead of injecting.
			if (estimateTokens(summary).estimatedTokens > report.threshold) {
				ctx.ui.notify(`mini summary of ${file.path} exceeded the ${report.threshold}-token budget; file omitted`, "warning");
				decisions[key] = {
					sourcePath: file.path,
					sourceMtimeMs: stat.mtimeMs,
					sourceHash: hash,
					createdAt: new Date().toISOString(),
					choice: "declined",
				};
				report.verdict = "declined-truncated";
			} else {
				decisions[key] = {
					sourcePath: file.path,
					sourceMtimeMs: stat.mtimeMs,
					sourceHash: hash,
					summaryPath,
					createdAt: new Date().toISOString(),
					createdBy: "mini",
					choice: "summarized",
				};
				report.verdict = "summarized";
				report.summaryPath = summaryPath;
				summaries[file.path] = summary;
			}
		} catch (err) {
			// Fail safe: warn + decline, never block mini startup.
			ctx.ui.notify(`mini summary failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`, "warning");
			decisions[key] = {
				sourcePath: file.path,
				sourceMtimeMs: stat.mtimeMs,
				sourceHash: hash,
				createdAt: new Date().toISOString(),
				choice: "declined",
			};
			report.verdict = "declined-truncated";
		}
		dirty = true;
	}

	if (dirty) saveDecisions(decisions, cwd);
	return { reports, prompted, summaries };
}

// ---------------------------------------------------------------------------
// resolveInstructions: the exact block injected into the mini system prompt
// ---------------------------------------------------------------------------

export interface ResolveInstructionsOptions {
	cwd: string;
	/** Defaults to os.homedir(); injectable for tests. */
	homeDir?: string;
}

export interface ResolveInstructionsResult {
	block: string;
	reports: FileBudgetReport[];
}

function wrapMiniContextBlock(instructionBlock: string): string {
	if (!instructionBlock) return "";
	return `<mini_context>\n${instructionBlock}</mini_context>\n`;
}

/**
 * Resolve the mini-instruction block: full content for inline files, summary
 * content for summarized files, nothing for declined/omitted files. The final
 * block must fit MINI_CONTEXT_BLOCK_BUDGET bytes; if it does not, inlined
 * files are dropped largest-first (down to summaries only) — never truncated
 * mid-file.
 */
export function resolveInstructions(opts: ResolveInstructionsOptions): ResolveInstructionsResult {
	const { cwd } = opts;
	const files = discoverInstructionFiles(cwd, opts.homeDir ?? os.homedir());
	const reports = evaluateFiles(files);
	const decisions = loadDecisions(cwd);
	const summaries: Record<string, string> = {};

	for (const report of reports) {
		if (report.verdict !== "summarize-prompted") continue;
		const file = files.find((f) => f.path === report.path);
		if (!file) continue;
		const stat = fs.statSync(file.path);
		const hash = hashContent(file.content);
		const record = decisions[decisionKey(file.path, stat.mtimeMs, hash)];
		if (record?.choice === "summarized" && record.summaryPath) {
			try {
				const summary = fs.readFileSync(record.summaryPath, "utf8").trim();
				if (summary) {
					report.verdict = "summarized";
					report.summaryPath = record.summaryPath;
					summaries[report.path] = summary;
				}
			} catch {
				// Summary file gone: leave as summarize-prompted (injects nothing).
			}
		} else if (record?.choice === "declined") {
			report.verdict = "declined-truncated";
		}
	}

	// Assemble, then enforce the byte budget by dropping the largest inlined
	// files first. Summaries (already bounded) are never dropped.
	let inlinePaths = new Set(reports.filter((r) => r.verdict === "inline").map((r) => r.path));
	const assemble = () =>
		buildMiniInstructions(
			reports.filter((r) => r.verdict !== "inline" || inlinePaths.has(r.path)),
			summaries,
		).instructionBlock;

	let instructionBlock = assemble();
	while (instructionBlock.length > 0 && wrapMiniContextBlock(instructionBlock).length > MINI_CONTEXT_BLOCK_BUDGET && inlinePaths.size > 0) {
		const largest = [...inlinePaths].reduce((a, b) => {
			const contentA = reports.find((r) => r.path === a)?.content ?? "";
			const contentB = reports.find((r) => r.path === b)?.content ?? "";
			return contentA.length >= contentB.length ? a : b;
		});
		inlinePaths = new Set([...inlinePaths].filter((p) => p !== largest));
		instructionBlock = assemble();
	}

	return { block: wrapMiniContextBlock(instructionBlock), reports };
}

// ---------------------------------------------------------------------------
// installMiniContext: session_start wiring + refresh for /reload-equivalents
// ---------------------------------------------------------------------------

export interface InstallMiniContextOptions {
	getConfig: () => MiniContextModelConfig;
	isEnabled: () => boolean;
	cwd?: string;
	fetchImpl?: typeof fetch;
}

export interface MiniContextPI {
	on(event: "session_start", handler: () => void | Promise<void>): void;
}

interface InstallState {
	opts: InstallMiniContextOptions;
	cwd: string;
}

const installs = new WeakMap<object, InstallState>();

/**
 * Register mini-context on session start: when enabled, discover/evaluate and
 * settle pending prompts (fire-and-forget; failures surface as a notify).
 * Returns a disposer that unregisters the handler.
 */
export function installMiniContext(pi: MiniContextPI, ctx: MiniContextCtx, opts: InstallMiniContextOptions): () => void {
	const cwd = opts.cwd ?? process.cwd();
	const state: InstallState = { opts, cwd };
	installs.set(ctx, state);
	const run = () => {
		if (!opts.isEnabled()) return;
		ensureMiniContext(ctx, {
			cwd,
			cfg: opts.getConfig(),
			fetchImpl: opts.fetchImpl,
			isEnabled: opts.isEnabled,
		}).catch((err) => {
			ctx.ui.notify(`mini context setup failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		});
	};
	pi.on("session_start", run);
	return () => installs.delete(ctx);
}

/**
 * Re-run mini-context evaluation for an installed ctx (integrator calls this on
 * /reload or on enable). No-op when installMiniContext was never called for ctx.
 */
export async function refresh(ctx: MiniContextCtx): Promise<EnsureMiniContextResult | undefined> {
	const state = installs.get(ctx);
	if (!state) return undefined;
	if (!state.opts.isEnabled()) return { reports: [], prompted: [], summaries: {} };
	return ensureMiniContext(ctx, {
		cwd: state.cwd,
		cfg: state.opts.getConfig(),
		fetchImpl: state.opts.fetchImpl,
		isEnabled: state.opts.isEnabled,
	});
}
