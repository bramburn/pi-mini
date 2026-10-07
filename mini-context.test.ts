// Unit tests for the mini-context module (mini-context.ts): discovery, budget
// evaluation, one-time summarize/decline prompting with decision persistence,
// summary generation via Ollama native /api/chat, instruction-block
// resolution with byte-budget enforcement, and session_start wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CANDIDATE_NAMES,
	MINI_CONTEXT_BLOCK_BUDGET,
	INSTRUCTION_TOKEN_THRESHOLD,
	discoverInstructionFiles,
	evaluateFiles,
	decisionKey,
	hashContent,
	loadDecisions,
	summaryPathFor,
	miniDir,
	ensureMiniContext,
	resolveInstructions,
	installMiniContext,
	refresh,
} from "./mini-context.ts";
import type { MiniContextCtx } from "./mini-context.ts";

const CFG = { tiny: { provider: "ollama-mini", modelId: "granite4.2:8b" } };
/** 3400 chars -> ceil(3400/4 * 1.2) = 1020 estimated tokens: over the 1000 threshold. */
const BIG = "x".repeat(3400);
const SUMMARY_TEXT = "Compact summary. Always run npm test before commit. Never edit delegate.ts.";

function makeTmp(t: { after: (fn: () => void) => void }): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mini-ctx-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function write(dir: string, rel: string, content: string): string {
	const p = path.join(dir, ...rel.split("/"));
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content, "utf8");
	return p;
}

interface FetchCall {
	url: string;
	body: Record<string, unknown>;
}

function fakeFetch(content: string | Error = SUMMARY_TEXT) {
	const calls: FetchCall[] = [];
	const impl = async (url: string, init: { body: string }) => {
		calls.push({ url, body: JSON.parse(init.body) });
		if (content instanceof Error) throw content;
		return { ok: true, status: 200, json: async () => ({ message: { content } }) } as Response;
	};
	return { calls, impl: impl as unknown as typeof fetch };
}

function fakeCtx(answer = true) {
	const confirms: { title: string; message: string }[] = [];
	const notifies: { message: string; type?: string }[] = [];
	const ctx: MiniContextCtx = {
		ui: {
			confirm: async (title: string, message: string) => {
				confirms.push({ title, message });
				return answer;
			},
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifies.push({ message, type });
			},
		},
	};
	return { ctx, confirms, notifies };
}

/** Pre-seed a decision record keyed on the file's current (mtimeMs, hash). */
function seedDecision(cwd: string, filePath: string, choice: "summarized" | "declined", summaryPath?: string) {
	const content = fs.readFileSync(filePath, "utf8");
	const { mtimeMs } = fs.statSync(filePath);
	const decisions = loadDecisions(cwd);
	decisions[decisionKey(filePath, mtimeMs, hashContent(content))] = {
		sourcePath: filePath,
		sourceMtimeMs: mtimeMs,
		sourceHash: hashContent(content),
		summaryPath,
		createdAt: new Date().toISOString(),
		createdBy: "mini",
		choice,
	};
	fs.mkdirSync(miniDir(cwd), { recursive: true });
	fs.writeFileSync(path.join(miniDir(cwd), "context-decisions.json"), JSON.stringify(decisions, null, 2));
}

// --- discovery ----------------------------------------------------------------

test("CANDIDATE_NAMES matches pi's resource-loader order", () => {
	assert.deepEqual([...CANDIDATE_NAMES], ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
});

test("discover finds the global file and the cwd-root candidate; missing files are absent", (t) => {
	const home = makeTmp(t);
	const cwd = makeTmp(t);
	write(home, ".pi/agent/AGENTS.md", "global instructions");
	write(cwd, "AGENTS.md", "repo instructions");
	const files = discoverInstructionFiles(cwd, home);
	assert.equal(files.length, 2);
	assert.deepEqual(files.map((f) => f.scope), ["global", "repo-root"]);
	assert.equal(files[0].path, path.join(home, ".pi", "agent", "AGENTS.md"));
	assert.equal(files[0].content, "global instructions");
	assert.equal(files[1].path, path.join(cwd, "AGENTS.md"));
});

test("discover respects override-first ordering: only the first existing candidate wins", (t) => {
	const home = makeTmp(t);
	const cwd = makeTmp(t);
	write(cwd, "AGENTS.override.md", "override content");
	write(cwd, "AGENTS.md", "plain agents");
	write(cwd, "CLAUDE.md", "claude");
	const files = discoverInstructionFiles(cwd, home);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, path.join(cwd, "AGENTS.override.md"));
	assert.equal(files[0].content, "override content");
});

test("discover ignores subfolder files and ancestor files", (t) => {
	const home = makeTmp(t);
	const cwd = makeTmp(t);
	const parent = path.dirname(cwd);
	write(cwd, "AGENTS.md", "root");
	write(cwd, "src/AGENTS.md", "subfolder — must not be discovered");
	write(cwd, ".pi/mini/AGENTS.md", "mini dir — must not be discovered");
	write(parent, "AGENTS.md", "ancestor — pi's responsibility");
	const files = discoverInstructionFiles(cwd, home);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, path.join(cwd, "AGENTS.md"));
});

// --- evaluation -----------------------------------------------------------------

test("evaluateFiles decision table: small -> inline, over threshold -> summarize-prompted", (t) => {
	const cwd = makeTmp(t);
	const small = { path: path.join(cwd, "AGENTS.md"), scope: "repo-root", content: "Run tests." };
	const reports = evaluateFiles([small, { path: path.join(cwd, "CLAUDE.md"), scope: "repo-root", content: BIG }]);
	assert.equal(reports[0].verdict, "inline");
	assert.equal(reports[0].estimatedTokens.estimatedTokens, 3);
	assert.equal(reports[0].threshold, INSTRUCTION_TOKEN_THRESHOLD);
	assert.equal(reports[1].verdict, "summarize-prompted");
	assert.equal(reports[1].estimatedTokens.estimatedTokens, 1020);
});

test("evaluateFiles maps defensive subfolder entries to omitted", (t) => {
	const cwd = makeTmp(t);
	const reports = evaluateFiles([{ path: path.join(cwd, "src", "AGENTS.md"), scope: "rejected-subfolder", content: BIG }]);
	assert.equal(reports[0].verdict, "omitted");
	assert.equal(reports[0].scope, "rejected-subfolder");
});

// --- summary naming --------------------------------------------------------------

test("summary naming: global file keeps agents.md; repo-root files get agents-<slug>.md", (t) => {
	const cwd = makeTmp(t);
	assert.equal(
		summaryPathFor({ path: "/home/u/.pi/agent/AGENTS.md", scope: "global" }, cwd),
		path.join(cwd, ".pi", "mini", "agents.md"),
	);
	assert.equal(
		summaryPathFor({ path: path.join(cwd, "AGENTS.override.md"), scope: "repo-root" }, cwd),
		path.join(cwd, ".pi", "mini", "agents-agents-override.md"),
	);
	assert.equal(
		summaryPathFor({ path: path.join(cwd, "CLAUDE.md"), scope: "repo-root" }, cwd),
		path.join(cwd, ".pi", "mini", "agents-claude.md"),
	);
});

// --- ensureMiniContext ------------------------------------------------------------

test("accept -> summary written, decision recorded, second call does NOT re-prompt", async (t) => {
	const cwd = makeTmp(t);
	const agentsPath = write(cwd, "AGENTS.md", BIG);
	const { ctx, confirms } = fakeCtx(true);
	const { calls, impl } = fakeFetch();
	const promptCalls: string[] = [];

	const first = await ensureMiniContext(ctx, {
		cwd,
		cfg: CFG,
		fetchImpl: impl,
		isEnabled: () => true,
		prompt: async (file) => {
			promptCalls.push(file.path);
			return true;
		},
	});
	assert.equal(first.prompted.length, 1);
	assert.equal(first.reports[0].verdict, "summarized");
	assert.equal(promptCalls.length, 1);

	// Native /api/chat shape per ollama-native.ts.
	assert.equal(calls.length, 1);
	assert.ok(calls[0].url.endsWith("/api/chat"));
	assert.equal(calls[0].body.model, "granite4.2:8b");
	assert.equal(calls[0].body.think, false);
	assert.equal(calls[0].body.num_ctx, 8192);
	assert.equal(calls[0].body.stream, false);

	// Summary persisted per-file, decision recorded.
	const summaryPath = path.join(cwd, ".pi", "mini", "agents-agents.md");
	assert.ok(fs.existsSync(summaryPath));
	assert.ok(fs.readFileSync(summaryPath, "utf8").includes("Always run npm test"));
	const decisions = loadDecisions(cwd);
	const key = decisionKey(agentsPath, fs.statSync(agentsPath).mtimeMs, hashContent(BIG));
	assert.equal(decisions[key].choice, "summarized");
	assert.equal(decisions[key].summaryPath, summaryPath);
	assert.equal(decisions[key].createdBy, "mini");

	// Second run: fresh decision -> no prompt, no new fetch.
	const second = await ensureMiniContext(ctx, {
		cwd,
		cfg: CFG,
		fetchImpl: impl,
		isEnabled: () => true,
		prompt: async (file) => {
			promptCalls.push(file.path);
			return true;
		},
	});
	assert.equal(second.prompted.length, 0);
	assert.equal(promptCalls.length, 1);
	assert.equal(calls.length, 1);
	assert.equal(second.reports[0].verdict, "summarized");
	assert.equal(confirms.length, 0); // custom prompt used, default confirm untouched
});

test("default prompt asks via ctx.ui.confirm with the budget message", async (t) => {
	const cwd = makeTmp(t);
	write(cwd, "AGENTS.md", BIG);
	const { ctx, confirms } = fakeCtx(false);
	const { impl } = fakeFetch();
	await ensureMiniContext(ctx, { cwd, cfg: CFG, fetchImpl: impl, isEnabled: () => true });
	assert.equal(confirms.length, 1);
	assert.match(confirms[0].message, /AGENTS\.md is ~1020 tokens \(over the 1000 mini budget\)\. Build a mini summary now\?/);
});

test("decline -> declined recorded, no fetch, verdict declined-truncated", async (t) => {
	const cwd = makeTmp(t);
	const agentsPath = write(cwd, "AGENTS.md", BIG);
	const { ctx } = fakeCtx(false);
	const { calls, impl } = fakeFetch();
	const result = await ensureMiniContext(ctx, {
		cwd,
		cfg: CFG,
		fetchImpl: impl,
		isEnabled: () => true,
		prompt: async () => false,
	});
	assert.equal(calls.length, 0);
	assert.equal(result.reports[0].verdict, "declined-truncated");
	const decisions = loadDecisions(cwd);
	assert.equal(decisions[decisionKey(agentsPath, fs.statSync(agentsPath).mtimeMs, hashContent(BIG))].choice, "declined");
	assert.ok(!fs.existsSync(path.join(cwd, ".pi", "mini", "agents-agents.md")));
});

test("source touched (mtime/hash change) -> re-prompts", async (t) => {
	const cwd = makeTmp(t);
	const agentsPath = write(cwd, "AGENTS.md", BIG);
	const { ctx } = fakeCtx(true);
	const { calls, impl } = fakeFetch();
	const opts = { cwd, cfg: CFG, fetchImpl: impl, isEnabled: () => true, prompt: async () => true };
	await ensureMiniContext(ctx, opts);
	assert.equal(calls.length, 1);
	// Touch the source: same size, different bytes and mtime.
	fs.writeFileSync(agentsPath, "y".repeat(3400), "utf8");
	const future = new Date(Date.now() + 5000);
	fs.utimesSync(agentsPath, future, future);
	const second = await ensureMiniContext(ctx, opts);
	assert.equal(second.prompted.length, 1);
	assert.equal(calls.length, 2);
});

test("fetch failure -> notify warning + declined record, never throws", async (t) => {
	const cwd = makeTmp(t);
	const agentsPath = write(cwd, "AGENTS.md", BIG);
	const { ctx, notifies } = fakeCtx(true);
	const { impl } = fakeFetch(new Error("ollama refused"));
	const result = await ensureMiniContext(ctx, {
		cwd,
		cfg: CFG,
		fetchImpl: impl,
		isEnabled: () => true,
		prompt: async () => true,
	});
	assert.equal(result.reports[0].verdict, "declined-truncated");
	assert.equal(notifies.length, 1);
	assert.equal(notifies[0].type, "warning");
	const decisions = loadDecisions(cwd);
	assert.equal(decisions[decisionKey(agentsPath, fs.statSync(agentsPath).mtimeMs, hashContent(BIG))].choice, "declined");
});

test("over-budget summary fails the quality gate -> warning + declined, not injected", async (t) => {
	const cwd = makeTmp(t);
	const agentsPath = write(cwd, "AGENTS.md", BIG);
	const { ctx, notifies } = fakeCtx(true);
	const { impl } = fakeFetch("s".repeat(4000)); // ~1200 est tokens > threshold
	const result = await ensureMiniContext(ctx, {
		cwd,
		cfg: CFG,
		fetchImpl: impl,
		isEnabled: () => true,
		prompt: async () => true,
	});
	assert.equal(result.reports[0].verdict, "declined-truncated");
	assert.equal(notifies[0].type, "warning");
	const decisions = loadDecisions(cwd);
	assert.equal(decisions[decisionKey(agentsPath, fs.statSync(agentsPath).mtimeMs, hashContent(BIG))].choice, "declined");
});

test("isEnabled() false -> no discovery, no prompting, no decisions file", async (t) => {
	const cwd = makeTmp(t);
	write(cwd, "AGENTS.md", BIG);
	const { ctx } = fakeCtx(true);
	const { calls, impl } = fakeFetch();
	const result = await ensureMiniContext(ctx, { cwd, cfg: CFG, fetchImpl: impl, isEnabled: () => false });
	assert.deepEqual(result, { reports: [], prompted: [], summaries: {} });
	assert.equal(calls.length, 0);
	assert.ok(!fs.existsSync(path.join(cwd, ".pi", "mini", "context-decisions.json")));
});

// --- resolveInstructions ----------------------------------------------------------

test("resolveInstructions composes inline + summary content, excludes declined", (t) => {
	const home = makeTmp(t);
	const cwd = makeTmp(t);
	const globalPath = write(home, ".pi/agent/AGENTS.md", "Small global instructions."); // inline
	const agentsPath = write(cwd, "AGENTS.md", BIG);
	const summaryPath = write(cwd, ".pi/mini/agents-agents.md", "Compact summary. Never force push.");
	seedDecision(cwd, agentsPath, "summarized", summaryPath);

	const { block, reports } = resolveInstructions({ cwd, homeDir: home });
	assert.match(block, /^<mini_context>\n/);
	assert.ok(block.endsWith("</mini_context>\n"));
	assert.ok(block.includes("Compact summary. Never force push.")); // summary in place of source
	assert.ok(block.includes("Small global instructions.")); // inline file kept whole
	assert.ok(block.includes(`summarized-from="${summaryPath}"`));
	assert.ok(!block.includes(BIG.slice(0, 50))); // full source never inlined
	const byPath = new Map(reports.map((r) => [r.path, r]));
	assert.equal(byPath.get(agentsPath)?.verdict, "summarized");
	assert.equal(byPath.get(globalPath)?.verdict, "inline");
});

test("resolveInstructions injects nothing for declined files", (t) => {
	const cwd = makeTmp(t);
	const agentsPath = write(cwd, "AGENTS.md", BIG);
	seedDecision(cwd, agentsPath, "declined");
	const { block } = resolveInstructions({ cwd });
	assert.equal(block, "");
});

test("resolveInstructions enforces the byte budget by dropping the largest inline file", (t) => {
	const home = makeTmp(t);
	const cwd = makeTmp(t);
	const gPath = write(home, ".pi/agent/AGENTS.md", "g".repeat(3333)); // 1000 est tokens -> inline, larger
	write(cwd, "AGENTS.md", "a".repeat(3300)); // 990 est tokens -> inline
	const { block } = resolveInstructions({ cwd, homeDir: home });
	assert.ok(block.length <= MINI_CONTEXT_BLOCK_BUDGET, `block ${block.length} bytes > ${MINI_CONTEXT_BLOCK_BUDGET}`);
	assert.ok(block.includes("a".repeat(3300))); // smaller file survives whole
	assert.ok(!block.includes("g".repeat(3333))); // largest dropped, not truncated
	assert.ok(block.includes(`path="${path.join(cwd, "AGENTS.md")}"`));
	assert.ok(!block.includes(`path="${gPath}"`));
});

// --- installMiniContext / refresh ---------------------------------------------------

test("installMiniContext wires session_start: enabled -> ensure runs; disabled -> no-op", async (t) => {
	const cwd = makeTmp(t);
	write(cwd, "AGENTS.md", "Stay small."); // under threshold: no prompt needed
	let handler: (() => void) | undefined;
	const pi = {
		on: (event: string, h: () => void) => {
			assert.equal(event, "session_start");
			handler = h;
		},
	};
	const { ctx } = fakeCtx(true);

	let enabled = false;
	installMiniContext(pi as never, ctx, { getConfig: () => CFG, isEnabled: () => enabled, cwd });
	assert.ok(handler);
	handler!(); // disabled: fire-and-forget returns early
	await new Promise((r) => setTimeout(r, 50));
	assert.ok(!fs.existsSync(path.join(cwd, ".pi", "mini", "context-decisions.json")));

	enabled = true;
	handler!();
	await new Promise((r) => setTimeout(r, 50));
	// Inline-only run records no decisions, but the discovery ran without error;
	// a summarized flow proves ensure executed end-to-end via refresh below.
	const refreshed = await refresh(ctx);
	assert.ok(refreshed);
	assert.equal(refreshed.prompted.length, 0); // small file: inline, never prompts
});

test("refresh re-runs ensureMiniContext for the installed ctx; unknown ctx -> undefined", async (t) => {
	const cwd = makeTmp(t);
	write(cwd, "AGENTS.md", BIG);
	const { ctx } = fakeCtx(true);
	const { calls, impl } = fakeFetch();
	const pi = { on: () => {} };
	installMiniContext(pi as never, ctx, {
		getConfig: () => CFG,
		isEnabled: () => true,
		cwd,
		fetchImpl: impl,
	});
	const result = await refresh(ctx);
	assert.equal(result?.prompted.length, 1);
	assert.equal(calls.length, 1); // accepted -> summarized via the tiny model
	assert.equal(result?.reports[0].verdict, "summarized");
	// Fresh decision now: another refresh does not re-prompt.
	const again = await refresh(ctx);
	assert.equal(again?.prompted.length, 0);
	assert.equal(calls.length, 1);
	// Uninstalled ctx: no-op.
	const orphan = fakeCtx(true).ctx;
	assert.equal(await refresh(orphan), undefined);
});
