// Live-model silo harness for the goal-loop feature: probes the three
// riskiest assumptions against the tiny model (default granite4.2:8b):
//
//   1. GOAL ADHERENCE — with a short goal + open task list in the system
//      prompt and scripted tool results in the user turns, each reply
//      references/progresses the stated goal and the final reply emits the
//      specced completion signal `GOAL_STATUS: complete`.
//   2. STEERING AMENDMENT — a mid-run user message adds a requirement; the
//      next assistant reply acknowledges the amended objective.
//   3. COMPLETION SIGNAL — with every task pre-marked complete in the
//      prompt, the model emits `GOAL_STATUS: complete` unprompted.
//
// Budget: ≤4 /api/chat calls (think:false, num_ctx 8192, num_predict ≤512).
// Every raw exchange (trimmed) is logged to evidence/silo/goal-loop.log.
// Exit non-zero on any failed check so this can gate a goal-loop audit.
import * as fs from "node:fs";
import * as path from "node:path";
import { OLLAMA_BASE_URL, REPO_ROOT, getTags, postChat, streamDone, check, logEvidence } from "./_lib.mjs";

const NAME = "goal-loop";
const NUM_CTX = 8192;
const NUM_PREDICT = 512;
const COMPLETION_SIGNAL = "GOAL_STATUS: complete";
const TRIM = 1500;

/** Resolve the tiny model: the task pins granite4.2:8b (already loaded);
 * GOAL_LOOP_MODEL overrides for ad-hoc runs. */
function resolveModel() {
	return process.env.GOAL_LOOP_MODEL ?? "granite4.2:8b";
}

const trim = (s) => (s.length > TRIM ? `${s.slice(0, TRIM)}…[trimmed]` : s);

function logExchange(callLabel, messages, reply) {
	logEvidence(NAME, { event: "exchange", call: callLabel, messages: messages.map((m) => ({ role: m.role, content: trim(m.content) })), reply: trim(reply) });
}

function textOf(chunks) {
	return chunks.map((c) => c.message?.content ?? "").join("");
}

/** The goal prompt block, shaped like buildGoalPromptBlock in tests/unit/lib/goal-loop.mjs. */
function goalBlock(taskListLines) {
	return [
		"## Active Goal",
		"",
		"Objective: add /mini settings command (revision 1, status active)",
		"",
		`Open tasks (${taskListLines.length}, 0 complete):`,
		...taskListLines,
		"",
		"Work autonomously toward the objective. When every blocking task is verifiably complete, end your reply with the exact line `GOAL_STATUS: complete`. If you cannot proceed, emit `GOAL_STATUS: blocked — <reason>` instead.",
	].join("\n");
}

const MINI_GUIDELINES = `You are a capable coding agent running on a small local model working toward an Active Goal (below). User messages that look like tool output are real tool results — never fabricate results, and never redo work a tool result already confirms. Keep every reply under 3 short sentences and never narrate commands you are not running. When the latest tool result satisfies every blocking task's Verification contract, do not verify further and do not run more commands: summarize the evidence in one sentence, then put the exact line GOAL_STATUS: complete on the final line of your reply. If you cannot proceed, emit GOAL_STATUS: blocked — <reason> instead.`;

const TASK_LINES = [
	"- [in_progress] settings-command (blocking: yes): Add /mini settings subcommand dispatch in index.ts",
	"  Verification: settings.test.ts covers the dispatch; node --test green",
	"- [pending] docs (blocking: no): Update README with /mini settings usage",
	"  Verification: README shows the new subcommand",
];

async function main() {
	const model = resolveModel();
	const tags = await getTags();
	check(NAME, tags.models.some((m) => m.name === model), `model ${model} present on ${OLLAMA_BASE_URL}`);
	logEvidence(NAME, { event: "start", model, numCtx: NUM_CTX, numPredict: NUM_PREDICT, probes: ["goal-adherence", "steering-amendment", "completion-signal"] });

	const base = { model, think: false, options: { num_ctx: NUM_CTX, num_predict: NUM_PREDICT, temperature: 0 } };
	const system = { role: "system", content: `${MINI_GUIDELINES}\n\n${goalBlock(TASK_LINES)}` };

	// ------------------------------------------------------------------
	// Probe 1 — GOAL ADHERENCE (2 calls: two scripted tool-result turns,
	// then the completion signal on the final reply).
	// ------------------------------------------------------------------
	const thread = [system];

	const tool1 = { role: "user", content: "[tool result: read index.ts] The /mini command handler switches on subcommands: \"on\", \"off\", \"tiny\", \"large\", \"status\". The default branch replies \"Usage: /mini [on|off|tiny|large|status]\". There is no settings handler." };
	thread.push(tool1);
	const call1 = await postChat({ ...base, messages: thread });
	check(NAME, streamDone(call1), "call 1 stream completed");
	const reply1 = textOf(call1);
	logExchange("1-goal-adherence/turn1", thread, reply1);
	check(NAME, /settings/i.test(reply1), `turn 1 reply references the goal (task keyword "settings"): ${trim(reply1)}`);
	thread.push({ role: "assistant", content: reply1 });

	const tool2 = { role: "user", content: "Your proposed edit was applied to index.ts. [tool result: bash] node --test → 78 pass, 0 fail; settings.test.ts 9/9 (dispatch, usage reply, unknown subcommand) — the Verification contract for settings-command is met. [tool result: bash] grep -c settings README.md → 0; the docs task is non-blocking and does not gate completion." };
	thread.push(tool2);
	const call2 = await postChat({ ...base, messages: thread });
	check(NAME, streamDone(call2), "call 2 stream completed");
	const reply2 = textOf(call2);
	logExchange("1-goal-adherence/turn2", thread, reply2);
	check(NAME, /settings/i.test(reply2), `turn 2 reply references the goal (task keyword "settings"): ${trim(reply2)}`);
	check(NAME, reply2.includes(COMPLETION_SIGNAL), `final reply emits the completion signal "${COMPLETION_SIGNAL}": ${trim(reply2)}`);
	thread.push({ role: "assistant", content: reply2 });

	// ------------------------------------------------------------------
	// Probe 2 — STEERING AMENDMENT: mid-run user message adds a
	// requirement; the next reply must acknowledge the amended objective.
	// ------------------------------------------------------------------
	const steering = { role: "user", content: "Also update the README to document the new settings subcommand before you finish." };
	const thread2 = [...thread, steering];
	const call3 = await postChat({ ...base, messages: thread2 });
	check(NAME, streamDone(call3), "call 3 stream completed");
	const reply3 = textOf(call3);
	logExchange("2-steering-amendment", thread2, reply3);
	check(NAME, /README/i.test(reply3), `steering reply acknowledges the new requirement (keyword "README"): ${trim(reply3)}`);

	// ------------------------------------------------------------------
	// Probe 3 — COMPLETION SIGNAL unprompted: all tasks pre-marked
	// complete with evidence in the prompt; the model must emit the signal
	// on its own.
	// ------------------------------------------------------------------
	const doneBlock = [
		"## Active Goal",
		"",
		"Objective: add /mini settings command (revision 1, status completing)",
		"",
		"All 2 task(s) carry evidence. Request completion.",
		"- [complete] settings-command (blocking: yes): Add /mini settings subcommand dispatch in index.ts",
		"  Evidence: settings.test.ts 9/9 pass; node --test green",
		"- [complete] docs (blocking: no): Update README with /mini settings usage",
		"  Evidence: README shows the new subcommand",
		"",
		"Work autonomously toward the objective. When every blocking task is verifiably complete, end your reply with the exact line `GOAL_STATUS: complete`. If you cannot proceed, emit `GOAL_STATUS: blocked — <reason>` instead.",
	].join("\n");
	const thread3 = [
		{ role: "system", content: `${MINI_GUIDELINES}\n\n${doneBlock}` },
		{ role: "user", content: "The goal state below says every task already carries evidence. Do not run any tools or verification — confirm completion in one sentence." },
	];
	const call4 = await postChat({ ...base, messages: thread3 });
	check(NAME, streamDone(call4), "call 4 stream completed");
	const reply4 = textOf(call4);
	logExchange("3-completion-signal", thread3, reply4);
	check(NAME, reply4.includes(COMPLETION_SIGNAL), `reply emits the completion signal unprompted: ${trim(reply4)}`);

	logEvidence(NAME, { event: "all_probes_passed", calls: 4, model });
	console.log("goal-loop silo: all probes PASS (4 /api/chat calls, model " + model + ")");
}

main().catch((err) => {
	logEvidence(NAME, { event: "harness_failed", error: String(err?.message ?? err) });
	console.error(err);
	process.exit(1);
});
