# goal-loop — scope

Goal-driven continuous loop (Roo Code / Klein style) for pi-mini.

## In scope

- Short goal definition as the loop's single objective; the loop continues
  until the goal is done.
- Steering: user prompts amend the active goal mid-loop.
- Task decomposition surfaced through the existing `.pi/goals/` ledger
  vocabulary: `goal_created`, `task_list_set` (with `blockCompletion`),
  `task_started`, `task_complete` (with `evidence`), `completion_requested`,
  `audit_result` (verdict `approved`/`disapproved` + report), `goal_archived`.
- Audit step before completion is accepted.
- Context management so the loop survives long runs.
- The append-only `goal_events.jsonl` ledger, `.goal-ledger-checkpoint.json`
  accumulator, and `.pi/loops/bindings-<session>.json` remain the state
  mechanism — specs describe them, they are not replaced.

## Out of scope

- Changing the ledger file formats or inventing new event types.
- Ollama transport details (specced under the `ollama` paths/components).
- The `/mini` settings UI (settings-page feature).
