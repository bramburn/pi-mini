# tool-call-repair — scope

## Owner intent (voice-transcribed)

> Ensure we cover guardrails, retries and regex processing of tool call
> failures properly. Where there are tool call failures we need to just take
> the call, provide a separate context call to give to the LLM to fix just
> the tool call syntax. We just need to process the syntax tool failures
> properly.

## In scope

- **POST-execution repair loop.** A tool call that RAN and FAILED is
  extracted into an isolated repair context: a separate, small `/api/chat`
  call that asks the tiny model to fix ONLY the call's syntax/structure
  (fixer system prompt: "repair ONLY the syntax/structure; preserve the
  call's intent verbatim; output STRICT JSON only"). The context contains
  exactly: the fixer prompt, the tool's argument-contract summary
  (`ToolContract`: name, required[], fields{type}), the failed `rawArgs`
  verbatim, and the failure classification. Nothing else — no session
  history, no other tools, no conversation.
- **Regex failure taxonomy.** Every failed call is classified from
  `(toolName, rawArgs, errorText)` into `syntax-repairable` |
  `semantic` | `transient` by a documented table of regex patterns over
  `errorText` plus structural checks over `rawArgs` (brace/quote balance,
  contract shape). Every pattern is listed in
  `specs/api/components/schemas/tool-repair.yaml`
  (`FailureClassification.matchedPattern`) and asserted row-by-row in
  `tests/unit/tool-call-repair.test.mjs`.
- **Strict-JSON-only repair extraction.** The repair reply is parsed with
  the tolerant *spirit* of `parser.ts` (brace balancing, fenced or bare
  object) but strictly: prose around the JSON is rejected, no key-sniffing
  fallbacks. Repaired args MUST validate against the `ToolContract`
  (required / unknown-field / primitive-type, string-where-array/object)
  before acceptance.
- **Guardrails and retries.** Max 2 repair attempts per failed call, each
  failure re-classified; max 2 repair calls per user turn on a counter that
  is SEPARATE from wrapfix conversions (2/turn) and delegate_to_worker
  (8/turn) — they compose, never conflate. On exhaustion the ORIGINAL error
  plus the last repair error are surfaced to the main loop as the
  `tool_result` (no silent drop). Repair calls never recurse. The 90s stall
  watchdog applies to repair calls. Repair calls are small: num_ctx 4096,
  num_predict ≤ 300, think:false.
- **Transient shim.** Timeout / connection / rate-limit signals retry with
  bounded backoff (`backoffMsForTransient: [500, 2000]` — the list length IS
  the retry cap) and NEVER invoke the LLM.
- **Evidence logging.** Every repair attempt appends one JSONL record to
  `.pi/mini/tool-repairs.jsonl` per existing `.pi` conventions.
- **Boundary with wrapfix.** `wrapfix.ts` runs PRE-execution at stream
  level: degraded/truncated JSON tool-call text is repaired into a real
  toolCall before the `done` event (residual prose >200 chars is left
  alone). This loop is the POST-execution fallback for what slips through
  wrapfix or fails validation at execution. Both are bounded per turn, on
  independent counters.

## Out of scope

- **Semantic retries.** A `semantic` failure (file not found, command not
  found, non-zero exit with well-formed args) is valid syntax with wrong
  meaning; it is NEVER sent to repair and is returned to the main loop
  as-is. Per the owner: "we just need to process the syntax tool failures
  properly."
- **Retrying bash exit codes / command semantics** — no LLM re-planning of
  failed commands; transient handling is the thin bounded-backoff shim
  above and nothing more.
- **Anything PRE-execution** — that is wrapfix.ts's stream-level repair
  (`detectToolCall`, `repairArgs`, `stripToolCallSpans`), which this feature
  never modifies or re-implements.
- **Unbounded/unconfigured behavior** — no repair without the documented
  caps, no recursive repair, no silent drops.

## Reference logic

`tests/unit/lib/tool-call-repair.mjs` — `classifyFailure`,
`buildRepairContext`, `extractRepairedArgs`, `validateAgainstContract`,
`initialRepairState`/`advance` (state machine), plus the retry-policy
constants. Silo harness: `scripts/silo/tool-call-repair.mjs`.
