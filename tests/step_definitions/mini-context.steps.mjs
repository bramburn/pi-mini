// Step definitions for specs/features/mini-context/*.feature.
//
// SKELETON: every step is bound but throws "pending" so a Gherkin runner can
// enumerate coverage while the real bindings are implemented. (This file is
// intentionally NOT named *.test.* so node --test does not pick it up.)
//
// The pure decision logic these steps will exercise already lives in
// tests/unit/lib/mini-context.mjs (estimateTokens, classifyPath,
// decideFileVerdict, buildMiniInstructions, isSummaryFresh).

// Fallback registry when no Gherkin runner has injected the Given/When/Then
// globals (keeps this file importable standalone).
const define = (fn) => fn;
const Given = globalThis.Given ?? define;
const When = globalThis.When ?? define;
const Then = globalThis.Then ?? define;

const PENDING = () => {
	throw new Error("PENDING: bind mini-context step definitions (see tests/unit/lib/mini-context.mjs)");
};

// --- Background / Given ------------------------------------------------------------

Given("the mini context budget policy is the default policy", PENDING);
Given("the instruction token threshold is {int}", PENDING);
Given("mini mode is enabled in the repository", PENDING);
Given("mini mode is enabled", PENDING);
Given("the effective context window is {int}", PENDING);
Given("the model is pinned with num_ctx {int}", PENDING);
Given("an eligible instruction file exists at {string} with {int} characters", PENDING);
Given("the repo root has an AGENTS.md estimated at {int} tokens", PENDING);
Given("the repo root has an AGENTS.md estimated over {int} tokens", PENDING);
Given("the system MD is estimated at {int} tokens", PENDING);
Given("an AGENTS.md exists at {string}", PENDING);
Given("mini mode is enabled with an effective instruction block already resolved", PENDING);
Given("pi's resource loader walks upward from the cwd collecting ancestor files", PENDING);
Given("an AGENTS.md exists in a parent directory above the repo root", PENDING);
Given("the user was prompted and chose {string}", PENDING);
Given("pi was started with {string}", PENDING);
Given("a summarized AGENTS.md exists with a stored SummaryRecord", PENDING);
Given("the source file's mtime is {int} and its content hash is {string}", PENDING);
Given("the stored record has mtime {int} and hash {string}", PENDING);
Given("the stored summary exists and the source mtime has changed", PENDING);
Given("the stored summary is fresh", PENDING);
Given("the instruction block consumes {int} tokens", PENDING);
Given("the conversation headroom consumed is {int} tokens", PENDING);
Given("the loop compaction decision is {string}", PENDING);
Given("the source file is estimated at {int} tokens or more", PENDING);
Given("a summary has been generated", PENDING);
Given("the source file contains the canary fact {string}", PENDING);

// --- When ---------------------------------------------------------------------------

When("the context budget is evaluated at session start", PENDING);
When("the context budget is evaluated", PENDING);
When("the context budget is evaluated again with the same source mtime and hash", PENDING);
When("the context budget is evaluated after a reload", PENDING);
When("a new AGENTS.md is created in a subfolder {string}", PENDING);
When("the summary is generated for the over-budget file", PENDING);
When("the summary is generated", PENDING);
When("the quality gate runs", PENDING);
When("the context budget is resolved", PENDING);
When("the next turn would exceed the effective window", PENDING);
When("the size accounting is computed", PENDING);

// --- Then ---------------------------------------------------------------------------

Then("the file at {string} is reported with scope {string}", PENDING);
Then("the file's estimated tokens equal ceil\\({string} / {int} \\* {float}\\)", PENDING);
Then("the file verdict is {string}", PENDING);
Then("the user is prompted for {string} with options {string} and {string}", PENDING);
Then("the prompt is recorded against the tuple \\(path, sourceMtimeMs, sourceHash\\)", PENDING);
Then("the user is not prompted again for {string}", PENDING);
Then("the user is not prompted", PENDING);
Then("the full file content is included in the mini instruction block", PENDING);
Then("the system MD verdict is {string}", PENDING);
Then("the user is prompted for the system MD", PENDING);
Then("the file at {string} has scope {string}", PENDING);
Then("the mini instruction block contains nothing from {string}", PENDING);
Then("the effective instruction block is byte-identical to before", PENDING);
Then("no subfolder content appears in the mini system prompt", PENDING);
Then("mini does not measure or modify that ancestor file", PENDING);
Then("the ancestor file remains pi's responsibility", PENDING);
Then("mini's instruction block only reflects the global file and repo-root candidates", PENDING);
Then("the tiny model receives the bounded extraction prompt and the source text", PENDING);
Then("the summary is written to {string}", PENDING);
Then("a SummaryRecord is stored with sourcePath, sourceMtimeMs, sourceHash, summaryPath, createdAt, and createdBy {string}", PENDING);
Then("the generation is delegated via delegate_to_worker", PENDING);
Then("the SummaryRecord createdBy is {string}", PENDING);
Then("the summary at {string} retains {string} case-insensitively", PENDING);
Then("the summary's estimated tokens are at most {int}", PENDING);
Then("the keyword retention checks pass for commands, conventions, forbidden actions, and verification steps", PENDING);
Then("only then is the summary used in place of the source in the mini instruction block", PENDING);
Then("the full source file is NOT injected into mini context", PENDING);
Then("the mini instruction block contains no content from that file", PENDING);
Then("no instruction file is injected regardless of verdict", PENDING);
Then("the summary freshness is {string}", PENDING);
Then("the old summary is NOT used in the mini instruction block", PENDING);
Then("the user is prompted again exactly once for that source", PENDING);
Then("the mini instruction block contains the summary from {string}", PENDING);
Then("the mini effective context window is {int}", PENDING);
Then("every usage percentage is evaluated against {int} not {int}", PENDING);
Then("the loop compaction decision is {string}", PENDING);
Then("outstanding work is delegated or summarized via delegate_to_worker", PENDING);
Then("the current goal is preserved in the loop state", PENDING);
Then("instruction block + conversation headroom + {int} TINY_MAX_TOKENS must fit within {int}", PENDING);
Then("the resolved instruction block must fit even after compaction", PENDING);
