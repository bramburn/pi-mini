// Step definitions binding specs/features/goal-loop/*.feature to the future
// runtime implementation in index.ts.
//
// STATUS: skeleton — every step throws "PENDING". This file intentionally
// does NOT match *.test.* so `node --test` never discovers it; wire it into a
// Gherkin runner (or the future harness) once the implementation lands.
// The pure-logic half of the spec is already executable today via
// tests/unit/goal-loop.test.mjs against tests/unit/lib/goal-loop.mjs.
import assert from "node:assert/strict";

const pending = (step) => () => {
	throw new Error(`PENDING(goal-loop): implement step: "${step}" — see specs/features/goal-loop/ and tests/unit/lib/goal-loop.mjs for the reference logic`);
};

// ---------------------------------------------------------------------------
// Tiny Given/When/Then registry (dependency-free; swap for a real Gherkin
// runner later — the regexes below are the binding contract).
// ---------------------------------------------------------------------------

export const steps = [];
export const Given = (pattern, fn) => steps.push({ kind: "Given", pattern, fn });
export const When = (pattern, fn) => steps.push({ kind: "When", pattern, fn });
export const Then = (pattern, fn) => steps.push({ kind: "Then", pattern, fn });

export async function runStep(kind, text, world) {
	const hit = steps.find((s) => s.kind === kind && (s.pattern instanceof RegExp ? s.pattern.test(text) : s.pattern === text));
	assert.ok(hit, `no ${kind} step bound for: ${text}`);
	return hit.fn(world, text);
}

// ---------------------------------------------------------------------------
// Background / world setup
// ---------------------------------------------------------------------------

Given("mini mode is enabled with tiny model {string}", pending("mini mode is enabled with tiny model \"granite4.2:8b\""));
Given("mini mode is enabled", pending("mini mode is enabled"));
Given("mini mode is enabled with delegate budget {int}", pending("mini mode is enabled with delegate budget 8"));
Given("no goal is active for the session", pending("no goal is active for the session"));
Given("the context policy is the default policy", pending("the context policy is the default policy"));
Given("the compaction threshold is {int} percent of the effective context window", pending("the compaction threshold is 80 percent of the effective context window"));

// ---------------------------------------------------------------------------
// goal-definition.feature
// ---------------------------------------------------------------------------

When("the user runs {string}", pending("the user runs \"/mini goal add /mini settings command\""));
Then("a {string} event is appended to {string} with objective {string}", pending("goal_created appended to .pi/goals/goal_events.jsonl"));
Then("the goal status is {string} and the revision is {int}", pending("goal status active, revision 1"));
Then("the goal has a {string} event with taskCount {int}", pending("task_list_set with taskCount 2"));
Then("a loopId is bound to the session in {string}", pending("loopId bound in .pi/loops/bindings-<session>.json"));
Then("no ledger event is appended", pending("no ledger event is appended"));
Then("the reply is {string}", pending("usage reply"));

Given("a goal is active with objective {string}", pending("goal active with objective"));
Given("a goal is active with objective {string} at revision {int}", pending("goal active at revision"));
Given("the task list has {int} of {int} blockCompletion tasks complete", pending("partial task completion"));
Given("context usage is {int} percent", pending("context usage percent"));
Given("ctx.getContextUsage() reports percent {float}", pending("ctx.getContextUsage() reports percent"));
Given("the goal status is {string}", pending("goal status"));
When("the agent settles {int} times without new user input", pending("agent settled cycles"));
When("the loop decision is made", pending("loop decision"));
Then("each cycle re-injects the goal prompt block via {string}", pending("before_agent_start re-injection"));
Then("the loop decision is {string}", pending("loop decision value"));

Given("task {string} is in_progress with verification contract {string}", pending("task in_progress"));
When("the goal prompt block is built", pending("build goal prompt block"));
Then("the block contains {string}", pending("block contains objective"));
Then("the block contains the open task {string} and its verification contract", pending("block contains open task"));
Then("the block is under the {int} byte prompt budget", pending("byte budget"));

// ---------------------------------------------------------------------------
// steering-amendment.feature
// ---------------------------------------------------------------------------

When("the user sends {string} mid-run", pending("steering message mid-run"));
Then("a {string} event is appended with revision {int}", pending("goal_amended appended with revision"));
Then("the {string} event reason is {string}", pending("amendment reason"));
Then("a task {string} with blockCompletion true is added to the task list", pending("task added"));
Then("the next loop turn's prompt block contains {string}", pending("prompt reflects amendment"));
Then("the goal revision is {int}", pending("goal revision"));
Then("the folded goal objective mentions {string}", pending("folded objective"));
Then("the previous revision's objective is preserved in the ledger only", pending("ledger preservation"));
Given("all blockCompletion tasks are complete", pending("all blocking complete"));
When("the user amends the goal with a taskListOps add of a blockCompletion task {string}", pending("amend with taskListOps add"));
Then("the goal status is {string}", pending("status after amendment"));
Given("the goal status is {string} at revision {int}", pending("status at revision"));
When("the user amends the goal", pending("user amends goal"));
When("an {string} event for revision {int} arrives with verdict {string}", pending("stale audit arrives"));
Then("the audit verdict is not applied", pending("stale audit ignored"));
Then("the goal status is {string} for revision {int}, ready to re-request completion", pending("recomputed gate"));

// ---------------------------------------------------------------------------
// completion-gate.feature
// ---------------------------------------------------------------------------

Given("the task list is:", pending("doc-string task list"));
When("the folder folds the ledger", pending("fold ledger"));
Then("the pending non-blocking task {string} does not block the gate", pending("non-blocking does not gate"));
When("the loop emits {string} for revision {int}", pending("emit completion_requested"));
When("an {string} event arrives with verdict {string}, auditor {string}, and report {string}", pending("audit_result arrives"));
When("an {string} event arrives with verdict {string}, auditor {string}, report {string}, and continuation {string}", pending("disapproved audit_result arrives"));
Then("a {string} event is appended with archivePath {string}", pending("goal_archived appended"));
Then("the loopId is unbound from {string}", pending("loopId unbound"));
Then("the loop stops with stopReason {string}", pending("stopReason"));
Then("the loop keeps working without new user input", pending("loop continues"));
When("the loop emits {string}", pending("emit completion_requested"));
Then("the event is rejected with conflict {string}", pending("rejection conflict"));
Then("the goal status stays {string}", pending("status unchanged"));
Given("the config goalAudit is {string}", pending("config goalAudit"));
When("the audit runs", pending("audit runs"));
Then("the auditor is {string} and it runs via {string}", pending("auditor and mechanism"));
Given("the goal status is {string} after a disapproved audit", pending("after disapproval"));
When("the loop finishes the continuation guidance and all blockCompletion tasks carry evidence again", pending("finish continuation"));
Then("the loop emits {string} for revision {int} again", pending("re-request completion"));
Then("the goal status is {string} again", pending("awaiting_audit again"));

// ---------------------------------------------------------------------------
// guardrails-composition.feature
// ---------------------------------------------------------------------------

Given("a goal is active with an incomplete blockCompletion task {string}", pending("active goal, incomplete task"));
Given("the current turn has used {int} wrapfix conversions and {int} delegate calls", pending("guardrail usage"));
When("the loop decision is made after the agent settles", pending("decision after settle"));
Then("the goal status stays {string}", pending("goal status stable"));
Then("the task {string} stays {string}", pending("task unchanged"));
When("the model emits a third text-wrapped tool call", pending("third wrapped call"));
Then("the call is blocked and the turn terminates with reason {string}", pending("wrapfix blocked"));
Then("no ledger event is written for the blocked call", pending("no ledger write"));
When("the model calls delegate_to_worker a ninth time", pending("ninth delegate"));
Then("the call is blocked with reason {string}", pending("delegate blocked"));
When("the user sends a steering message mid-run", pending("steering resets budgets"));
Then("the wrapfix and delegate counters reset for the next turn", pending("counters reset"));

// ---------------------------------------------------------------------------
// context-budget.feature
// ---------------------------------------------------------------------------

Given("the blockCompletion tasks are {string}", pending("tasks complete or incomplete"));
Given("the goal is active with objective {string}", pending("goal active"));
When("the loop compacts", pending("loop compacts"));
Then("outstanding work is delegated or summarized via delegate_to_worker", pending("delegated compaction"));
Then("the goal objective {string} and revision are preserved in the ledger", pending("goal preserved"));
Then("the next loop turn re-injects the goal prompt block via {string}", pending("re-injection after compaction"));
Given("the goal usage is tokensUsed {int} and activeSeconds {int}", pending("usage baseline"));
When("one more loop turn consumes {int} tokens and {int} active seconds", pending("usage delta"));
Then("the goal usage is tokensUsed {int} and activeSeconds {int}", pending("usage accumulated"));
