# ADR-001: Adopt a spec-driven development (SDD) layout for pi-mini

- Status: accepted
- Date: 2026-10-07
- Context: pi-mini (TypeScript ESM pi extension) running granite4.2:8b via
  Ollama on pi's native agentic tool loop.

## Decision

Adopt an SDD layout under `specs/` with an executable validation harness:

- Modular OpenAPI 3.1 under `specs/api/` (root `openapi.yaml` + `paths/` +
  `components/schemas/` placeholders, one file per surface).
- AsyncAPI 3.0 under `specs/async/` (NDJSON chat stream + goal ledger channels).
- Gherkin features under `specs/features/<feature>/` with step definitions in
  `tests/step_definitions/<feature>.steps.mjs`.
- Spectral linting (`spectral.yaml`, extends `spectral:oas` +
  `spectral:asyncapi` plus house rules: operationId required, schema
  description required, `x-feature` tag required).
- Structural contract tests in `tests/contract/` (auto-discovered by
  `node --test`).
- Live-model silo harnesses in `scripts/silo/<feature>.mjs`, run explicitly,
  writing evidence to `evidence/silo/<feature>.log`.

## Consequences

Every spec edit is machine-checked by `npm test`; style is checked by Spectral;
live-model behavior is checked only on demand via the silo harnesses, keeping
`npm test` hermetic.

## Rationale and clarifications

1. **No `proto/` or `typespec/` directories.** The owner's SDD template
   includes them, but pi-mini exposes no gRPC surfaces and no TypeSpec
   definitions — it is a pi extension talking to Ollama's HTTP API. Adding
   empty proto/typespec dirs would be dead weight, so they were deliberately
   omitted.

2. **Reuse of the `.pi/goals/` ledger vocabulary.** A prior external
   goal-loop harness established an append-only `goal_events.jsonl` ledger
   with event types `goal_created`, `task_list_set` (with `blockCompletion`),
   `task_started`, `task_complete` (with `evidence`), `completion_requested`,
   `audit_result` (verdict `approved`/`disapproved` + report), and
   `goal_archived`, plus the `.goal-ledger-checkpoint.json` accumulator and
   `.pi/loops/bindings-<session>.json`. Specs reuse this vocabulary verbatim;
   no new event names may be invented.

3. **`/model`, not `/models`.** The owner's transcript said "/models", but
   pi's actual command is `/model` (singular). The settings-page model picker
   must mirror `/model`'s ModelSelectorComponent behavior: fuzzyFilter
   search, a ~10-row sliding window, ✓ on the current model, and an
   `(n/total)` indicator.

4. **"earlhammer" is unverifiable.** The owner's transcript mentioned
   "earlhammer", which cannot be verified. Ollama is the verifiable running
   runtime and is the specified default (`http://localhost:11434`);
   llama.cpp is named as the alternative local runtime. Specs target Ollama's
   native API (`POST /api/chat` NDJSON stream, `GET /api/tags`).
