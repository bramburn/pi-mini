// Silo harness: tool-call syntax-failure repair against the live tiny model.
//
// Proves the riskiest assumptions of specs/features/tool-call-repair/*.feature:
//   (1) granite4.2:8b can repair a TRUNCATED edit call (cut mid-string,
//       unbalanced JSON) when given ONLY the contract + rawArgs + classification;
//   (2) it can fix a TYPE VIOLATION (bash command emitted as an array where the
//       contract wants a string);
//   (3) STRICT-JSON-only extraction either isolates JSON from a prose-invited
//       reply or rejects it — recorded honestly either way;
//   (4) a SEMANTIC failure (file not found) is rejected non-syntax with ZERO
//       model involvement.
//
// Run explicitly (never via npm test):
//   node scripts/silo/tool-call-repair.mjs
// Evidence -> evidence/silo/tool-call-repair.log
//
// Budget: at most 4 POST /api/chat calls total (cap 4); think:false,
// num_ctx 4096, num_predict <=300, 90s stall watchdog (see _lib.mjs).

import { OLLAMA_BASE_URL, getTags, postChat, streamDone, check, logEvidence } from "./_lib.mjs";
import {
	classifyFailure,
	buildRepairContext,
	extractRepairedArgs,
	validateAgainstContract,
	REPAIR_NUM_CTX,
	REPAIR_NUM_PREDICT_MAX,
	REPAIR_STALL_TIMEOUT_MS,
	MAX_REPAIR_CALLS_PER_TURN,
} from "../../tests/unit/lib/tool-call-repair.mjs";

const SILO = "tool-call-repair";
const MODEL = "granite4.2:8b";

// Contracts grounded in pi-mini's real tools (specs: ToolContract).
const EDIT_CONTRACT = { name: "edit", required: ["path", "oldText", "newText"], fields: { path: "string", oldText: "string", newText: "string" } };
const BASH_CONTRACT = { name: "bash", required: ["command"], fields: { command: "string", timeout: "integer" } };

let chatCalls = 0;

async function repairChat(context) {
	chatCalls += 1;
	check(SILO, chatCalls <= MAX_REPAIR_CALLS_PER_TURN + 2, `chat call budget: ${chatCalls} used (harness cap 4)`);
	const chunks = await postChat(
		{
			model: MODEL,
			messages: [
				{ role: "system", content: context.system },
				{ role: "user", content: context.user },
			],
			think: false,
			options: { num_ctx: REPAIR_NUM_CTX, num_predict: REPAIR_NUM_PREDICT_MAX, temperature: 0 },
		},
		{ stallMs: REPAIR_STALL_TIMEOUT_MS, onChunk: () => {} },
	);
	check(SILO, streamDone(chunks), "repair stream finished with a done chunk");
	return chunks
		.filter((c) => c.message?.role === "assistant" && typeof c.message?.content === "string")
		.map((c) => c.message.content)
		.join("")
		.trim();
}

/** Full repair attempt: classify -> context -> chat -> extract -> validate. */
async function runRepairProbe(probe, toolName, contract, rawArgs, errorText) {
	const classification = classifyFailure(toolName, rawArgs, errorText, contract);
	logEvidence(SILO, { event: `${probe}_classified`, classification });
	const context = buildRepairContext(toolName, contract, rawArgs, classification);
	logEvidence(SILO, { event: `${probe}_context`, bytes: context.bytes, user: context.user });

	const reply = await repairChat(context);
	logEvidence(SILO, { event: `${probe}_reply`, reply });

	const extraction = extractRepairedArgs(reply);
	const validation = extraction.ok ? validateAgainstContract(extraction.args, contract) : { ok: false, errors: ["extraction-failed"] };
	logEvidence(SILO, { event: `${probe}_verdict`, extraction: extraction.ok ? "ok" : extraction.error, validation });
	return { classification, context, reply, extraction, validation };
}

async function main() {
	logEvidence(SILO, {
		event: "silo_start",
		model: MODEL,
		ollama: OLLAMA_BASE_URL,
		num_ctx: REPAIR_NUM_CTX,
		num_predict: REPAIR_NUM_PREDICT_MAX,
		think: false,
		stallMs: REPAIR_STALL_TIMEOUT_MS,
	});

	const tags = await getTags();
	check(SILO, tags.models.some((m) => m.name === MODEL), `model ${MODEL} is present in /api/tags`);
	logEvidence(SILO, { event: "model_present", model: MODEL });

	// --- Probe 1: TRUNCATED JSON ------------------------------------------------
	// A real truncated edit call: cut mid-string, unbalanced braces.
	const truncatedRaw = '{"path": "src/index.ts", "oldText": "const x = 1';
	const p1 = await runRepairProbe("probe1_truncated", "edit", EDIT_CONTRACT, truncatedRaw, "Unexpected end of JSON input");
	check(SILO, p1.classification.class === "syntax-repairable", "probe1 classified syntax-repairable");
	check(SILO, p1.classification.matchedPattern === "args:unbalanced-json", "probe1 matched args:unbalanced-json");
	check(
		SILO,
		p1.extraction.ok && p1.validation.ok,
		`probe1 repair accepted: extraction=${p1.extraction.ok ? "ok" : p1.extraction.error} validation=${JSON.stringify(p1.validation.errors)}`,
	);
	check(SILO, p1.extraction.args.path === "src/index.ts", "probe1 repaired args preserved the path");
	check(SILO, typeof p1.extraction.args.oldText === "string" && p1.extraction.args.oldText.includes("const x"), "probe1 repaired args preserved the intent of oldText");
	console.log("probe 1 (truncated edit JSON): PASS — model repaired the truncated call");

	// --- Probe 2: TYPE VIOLATION ------------------------------------------------
	// bash command emitted as an array where the contract wants a string.
	const arrayRaw = '{"command": ["npm", "test"], "timeout": 30}';
	const p2 = await runRepairProbe("probe2_type", "bash", BASH_CONTRACT, arrayRaw, "must be of type string");
	check(SILO, p2.classification.class === "syntax-repairable", "probe2 classified syntax-repairable");
	check(SILO, p2.classification.matchedPattern === "contract:type-mismatch", "probe2 matched contract:type-mismatch");
	check(
		SILO,
		p2.extraction.ok && p2.validation.ok,
		`probe2 repair accepted: extraction=${p2.extraction.ok ? "ok" : p2.extraction.error} validation=${JSON.stringify(p2.validation.errors)}`,
	);
	check(SILO, typeof p2.extraction.args.command === "string" && /npm/.test(p2.extraction.args.command), "probe2 command is now a string preserving 'npm'");
	console.log("probe 2 (string-vs-array type violation): PASS — model coerced the array to a string");

	// --- Probe 3: STRICTNESS NEGATIVE -------------------------------------------
	// The prompt INVITES prose. The strict extractor must either isolate the
	// JSON object anyway or reject the reply — both are honest outcomes.
	const strictRaw = '{"path": "a.txt", "oldText": "hello';
	const strictClassification = classifyFailure("edit", strictRaw, "Unexpected end of JSON input", EDIT_CONTRACT);
	const strictContext = buildRepairContext("edit", EDIT_CONTRACT, strictRaw, strictClassification);
	// Deliberately append an invitation to explain — the strict-JSON-only rule
	// is in the system prompt; we probe whether the model obeys it under pressure.
	strictContext.user += "\n\nAfter the JSON, you may briefly explain what you fixed.";
	strictContext.bytes = Buffer.byteLength(strictContext.system + strictContext.user, "utf8");
	logEvidence(SILO, { event: "probe3_strictness_context", user: strictContext.user });
	const strictReply = await repairChat(strictContext);
	logEvidence(SILO, { event: "probe3_strictness_reply", reply: strictReply });
	const strictExtraction = extractRepairedArgs(strictReply);
	const strictValidation = strictExtraction.ok ? validateAgainstContract(strictExtraction.args, EDIT_CONTRACT) : { ok: false, errors: [] };
	const strictOutcome = strictExtraction.ok && strictValidation.ok ? "isolated-json" : "rejected";
	logEvidence(SILO, {
		event: "probe3_strictness_verdict",
		outcome: strictOutcome,
		extraction: strictExtraction.ok ? "ok" : strictExtraction.error,
		validation: strictValidation.errors,
	});
	console.log(`probe 3 (strictness negative): PASS — reply ${strictOutcome === "isolated-json" ? "obeyed strict-JSON-only" : "contained prose and was rejected"} (${strictExtraction.ok ? "extracted" : strictExtraction.error})`);

	// --- Probe 4: SEMANTIC NEGATIVE (zero LLM involvement) -----------------------
	const callsBefore = chatCalls;
	const semanticClassification = classifyFailure("bash", '{"command": "cat missing.txt"}', "ENOENT: no such file or directory, open 'missing.txt'");
	check(SILO, semanticClassification.class === "semantic", "probe4 classified semantic");
	check(SILO, semanticClassification.matchedPattern === "semantic:file-not-found", "probe4 matched semantic:file-not-found");
	check(SILO, chatCalls === callsBefore, "probe4 made zero /api/chat calls (semantic never reaches the model)");
	logEvidence(SILO, { event: "probe4_semantic_rejected", classification: semanticClassification, llmCalls: 0 });
	console.log("probe 4 (semantic negative): PASS — file-not-found rejected non-syntax without any chat call");

	// --- budget + summary ---------------------------------------------------------
	check(SILO, chatCalls <= 4, `used ${chatCalls} /api/chat calls (cap 4)`);
	logEvidence(SILO, { event: "silo_ok", chatCalls, probes: 4 });
	console.log(`silo tool-call-repair OK: 4/4 probes pass, ${chatCalls}/4 chat calls`);
}

main().catch((err) => {
	logEvidence(SILO, { event: "silo_failed", error: String(err?.stack ?? err) });
	console.error(err);
	process.exit(1);
});
