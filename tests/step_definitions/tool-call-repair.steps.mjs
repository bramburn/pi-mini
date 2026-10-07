// Step definitions for specs/features/tool-call-repair/*.feature.
//
// SKELETON: every step is bound but throws "pending" so a Gherkin runner can
// enumerate coverage while the real bindings are implemented. (This file is
// intentionally NOT named *.test.* so node --test does not pick it up.)
//
// The pure decision logic these steps will exercise already lives in
// tests/unit/lib/tool-call-repair.mjs (classifyFailure, buildRepairContext,
// extractRepairedArgs, validateAgainstContract, initialRepairState/advance,
// canStartRepair).

// Fallback registry when no Gherkin runner has injected the Given/When/Then
// globals (keeps this file importable standalone).
const define = (fn) => fn;
const Given = globalThis.Given ?? define;
const When = globalThis.When ?? define;
const Then = globalThis.Then ?? define;

const PENDING = () => {
	throw new Error("PENDING: bind tool-call-repair step definitions (see tests/unit/lib/tool-call-repair.mjs)");
};

// --- Background / Given ------------------------------------------------------------

Given("the tool-call repair feature is enabled", PENDING);
Given("the classifier pattern table is the default table", PENDING);
Given("the edit tool contract requires path, oldText, newText all of type string", PENDING);
Given("the bash tool contract requires command of type string", PENDING);
Given("the repair policy is maxRepairAttemptsPerCall {int}, maxRepairCallsPerTurn {int}", PENDING);
Given("a failed call to tool {string} with raw args {string} and error text {string}", PENDING);
Given("a failed call to tool {string} with raw args {string} and error text {string}", PENDING);
Given("a failed call to tool {string} with contract requiring path, oldText, newText", PENDING);
Given("a failed call to tool {string} with contract field {string} of type string", PENDING);
Given("raw args {string}", PENDING);
Given("error text {string}", PENDING);
Given("a failed edit call with raw args {string}", PENDING);
Given("the failure classification is syntax-repairable {string}", PENDING);
Given("the model replied with {string}", PENDING);
Given("the log file is {string}", PENDING);
Given("any repair loop outcome", PENDING);
Given("the log already contains records from earlier turns", PENDING);
Given("mini mode is enabled", PENDING);
Given("the current turn has used {int} wrapfix conversions and {int} delegate calls", PENDING);
Given("the current turn has used {int} wrapfix conversions, {int} delegate calls, and {int} repair calls", PENDING);
Given("the current turn has used {int} repair calls", PENDING);
Given("a failed call is classified syntax-repairable", PENDING);
Given("a failed call is classified transient", PENDING);
Given("a failed call is classified semantic", PENDING);
Given("transient retries {int} and {int} have already run", PENDING);
Given("a repair attempt is in flight in an isolated repair context", PENDING);
Given("a failed bash call with raw args {string}", PENDING);
Given("the model emits a truncated edit call as text {string}", PENDING);
Given("the model emits a text-wrapped bash call {string}", PENDING);
Given("the model emits a fenced JSON example buried in more than {int} characters of prose", PENDING);
Given("a bash call with well-formed args {string} executes", PENDING);

// --- When ---------------------------------------------------------------------------

When("the failure is classified", PENDING);
When("the repair context is built for attempt {int}", PENDING);
When("the repair context is built", PENDING);
When("the repaired args are extracted", PENDING);
When("the repaired args are extracted and validated", PENDING);
When("a repair attempt runs", PENDING);
When("the repair loop decides whether to start attempt {int}", PENDING);
When("repair attempt {int} fails validation", PENDING);
When("repair attempt {int} fails extraction", PENDING);
When("the failure is re-classified as syntax-repairable", PENDING);
When("repair attempt {int} succeeds", PENDING);
When("the re-classification is semantic", PENDING);
When("the repair call itself fails", PENDING);
When("transient retry {int} is scheduled", PENDING);
When("the call fails again with a transient signal", PENDING);
When("the user sends a new message", PENDING);
When("the stream's done event fires", PENDING);
When("the executed call fails with {string}", PENDING);
When("the failure is returned to the main loop as-is", PENDING);
When("a new repair loop closes", PENDING);
When("the repair loop starts", PENDING);
When("the loop decision is made after the agent settles", PENDING);

// --- Then ---------------------------------------------------------------------------

Then("the classification class is {string}", PENDING);
Then("the matched pattern id is {string}", PENDING);
Then("no /api/chat call has been made", PENDING);
Then("no /api/chat call has ever been made for this failure", PENDING);
Then("the context contains the edit contract summary", PENDING);
Then("the context contains the failed raw args verbatim", PENDING);
Then("the context contains the failure classification", PENDING);
Then("the context system prompt says to repair ONLY the syntax and output STRICT JSON only", PENDING);
Then("the context is under the byte budget", PENDING);
Then("the context contains nothing from the session history", PENDING);
Then("the context instructs the model to preserve the call's intent verbatim", PENDING);
Then("the extraction result is {string}", PENDING);
Then("the extraction is accepted", PENDING);
Then("the validation fails with a missing required field", PENDING);
Then("the validation fails with an unknown field", PENDING);
Then("the repair attempt is recorded as failed, not accepted", PENDING);
Then("the repaired args are NOT re-executed", PENDING);
Then("the /api/chat call uses think false", PENDING);
Then("num_ctx is {int}", PENDING);
Then("num_predict is at most {int}", PENDING);
Then("the {int} second stall watchdog applies", PENDING);
Then("the decision is {string}", PENDING);
Then("the call is exhausted", PENDING);
Then("the call is exhausted with the original error surfaced", PENDING);
Then("the tool_result surfaced to the main loop contains the original error", PENDING);
Then("the tool_result also contains the last repair error", PENDING);
Then("no third attempt is made", PENDING);
Then("the call is rejected-non-syntax", PENDING);
Then("no further attempt is made", PENDING);
Then("the repair failure is NOT fed back into the repair loop", PENDING);
Then("the failure is surfaced to the main loop as-is", PENDING);
Then("the backoff is {int} ms", PENDING);
Then("the original error is surfaced to the main loop", PENDING);
Then("the repair counter resets for the next turn", PENDING);
Then("a failed call in the new turn can be repaired again", PENDING);
Then("wrapfix converts it into a real toolCall before the done event", PENDING);
Then("the call executes with repaired arguments", PENDING);
Then("no repair event is emitted", PENDING);
Then("the post-execution repair loop starts", PENDING);
Then("wrapfix leaves the text alone", PENDING);
Then("no toolCall is created", PENDING);
Then("the original error is returned to the main loop as-is", PENDING);
Then("no repair /api/chat call is made", PENDING);
Then("it retries with bounded backoff {int} then {int} ms", PENDING);
Then("the repair loop may still start because the repair counter is separate", PENDING);
Then("spending the wrapfix budget does not shrink the repair budget", PENDING);
Then("a repair_rejected \\(non-syntax\\) event is appended", PENDING);
Then("exactly one record is appended for the call", PENDING);
Then("the record contains {int} attempts", PENDING);
Then("the record finalStatus is {string}", PENDING);
Then("the record contains the originalError verbatim", PENDING);
Then("the record contains the finalError from the last repair attempt", PENDING);
Then("a record is appended with finalStatus {string}", PENDING);
Then("the record has zero attempts", PENDING);
Then("it contains ts, turn, toolName, classification, attempts, finalStatus, and originalError", PENDING);
Then("the new record is appended after the existing lines", PENDING);
Then("no existing line is modified or removed", PENDING);
Then("any repaired args whose values differ in meaning from the original fragments are caught by the contract validation, not by trust", PENDING);
Then("the failure is classified syntax-repairable", PENDING);
Then("the failure is classified semantic", PENDING);
Then("the failure is classified transient", PENDING);
Then("the classification is {string}", PENDING);
Then("the goal status stays {string}", PENDING);
