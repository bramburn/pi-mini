// Shared helpers for live-model silo harnesses (scripts/silo/<feature>.mjs).
//
// Dependency-free (global fetch, node 18+). Talks to Ollama at
// OLLAMA_BASE_URL (default http://localhost:11434) and appends timestamped
// evidence lines to evidence/silo/<name>.log.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Append a timestamped evidence line to evidence/silo/<name>.log (mkdir -p).
 * @param {string} name silo/feature name
 * @param {object|string} entry evidence payload (objects are JSON-encoded)
 */
export function logEvidence(name, entry) {
	const dir = path.join(REPO_ROOT, "evidence", "silo");
	fs.mkdirSync(dir, { recursive: true });
	const line = typeof entry === "string" ? entry : JSON.stringify(entry);
	fs.appendFileSync(path.join(dir, `${name}.log`), `[${new Date().toISOString()}] ${line}\n`);
}

/** Assert helper that also records the failure in the evidence log before throwing. */
export function check(name, cond, msg) {
	if (!cond) {
		logEvidence(name, { event: "assert_failed", msg });
		throw new Error(`[silo:${name}] ${msg}`);
	}
	logEvidence(name, { event: "assert_ok", msg });
}

/**
 * GET /api/tags — list local models.
 * @returns {Promise<{models: Array<{name: string}>}>}
 */
export async function getTags() {
	const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
	if (!res.ok) throw new Error(`GET /api/tags -> ${res.status}`);
	return res.json();
}

/**
 * POST /api/chat with NDJSON streaming. Parses each line as JSON and yields
 * parsed chunks until the stream ends. Applies a stall watchdog: if no bytes
 * arrive for `stallMs`, the request is aborted and an error is thrown.
 *
 * @param {object} body request body (model, messages, think:false, tools,
 *   pinned num_ctx, num_predict cap — callers set these per spec)
 * @param {object} [opts]
 * @param {number} [opts.stallMs=90_000] stall watchdog timeout
 * @param {AbortSignal} [opts.signal] external abort signal
 * @param {(chunk: object) => void} [opts.onChunk] per-chunk callback
 * @returns {Promise<object[]>} all parsed NDJSON chunks
 */
export async function postChat(body, { stallMs = 90_000, signal, onChunk } = {}) {
	const ctrl = new AbortController();
	const onExternal = () => ctrl.abort();
	if (signal) {
		if (signal.aborted) ctrl.abort();
		else signal.addEventListener("abort", onExternal, { once: true });
	}
	const stallTimer = setInterval(() => ctrl.abort(), stallMs * 10); // failsafe only
	let stall = setTimeout(() => ctrl.abort(), stallMs);
	const chunks = [];
	try {
		const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ stream: true, ...body }),
			signal: ctrl.signal,
		});
		if (!res.ok || !res.body) throw new Error(`POST /api/chat -> ${res.status}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			clearTimeout(stall);
			stall = setTimeout(() => ctrl.abort(), stallMs);
			buf += decoder.decode(value, { stream: true });
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				const chunk = JSON.parse(line);
				chunks.push(chunk);
				if (onChunk) onChunk(chunk);
			}
		}
		return chunks;
	} finally {
		clearTimeout(stall);
		clearInterval(stallTimer);
		if (signal) signal.removeEventListener("abort", onExternal);
	}
}

/** Convenience: did the stream finish with a done chunk? */
export function streamDone(chunks) {
	return chunks.some((c) => c.done === true);
}
