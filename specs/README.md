# pi-mini specs — index and conventions

Spec-driven development (SDD) layout for the pi-mini extension. Feature agents
fill in the placeholder files; the contract tests below guarantee the whole
tree stays structurally valid while they do.

## Layout map

```
specs/
  README.md                     ← this file
  api/
    openapi.yaml                ← OpenAPI 3.1 root (server: http://localhost:11434)
    paths/<feature>/*.yaml      ← one file per path placeholder (description: TODO(<feature>))
    components/schemas/*.yaml   ← one file per schema placeholder
  async/
    asyncapi.yaml               ← AsyncAPI 3.0 root
    channels/*.yaml             ← ollama-ndjson, goal-ledger
  features/
    README.md
    <feature>/scope.md          ← in/out of scope (feature agents write *.feature here)
docs/architecture/
  ADR-001-spec-driven-design.md ← why this layout exists
tests/
  contract/                     ← structural spec tests (auto-discovered by node --test)
  step_definitions/<feature>.steps.mjs  ← Gherkin step skeletons
  unit/**/*.test.mjs            ← pure-logic unit tests (auto-discovered)
scripts/silo/
  <feature>.mjs                 ← live-model silo harnesses (NOT auto-discovered)
  _lib.mjs                      ← shared Ollama client / assert / evidence helpers
evidence/silo/<feature>.log     ← silo harness evidence logs
spectral.yaml                   ← Spectral lint config (extends spectral:oas + spectral:asyncapi)
```

Feature domains: `goal-loop`, `settings-page`, `mini-context` (plus the
pre-existing `ollama` and `config` surfaces under `specs/api/paths/`).

## Feature index (2026-10-07 round)

All three features are specced, silo-tested against `granite4.2:8b`
(think:false), and have pending step-definition skeletons awaiting
implementation.

### goal-loop — goal-driven continuous loop
- Spec: `api/paths/goal-loop/goal-state.yaml`, `api/components/schemas/goal.yaml`
  (incl. `GoalAmendment`), `api/components/schemas/audit-result.yaml`,
  `async/channels/goal-ledger.yaml` (8 events: the 7 legacy +
  `goal_amended`), `features/goal-loop/*.feature` (5 files)
- Reference logic: `tests/unit/lib/goal-loop.mjs` (ledger reducer, prompt
  builder, loop-decision); 23 unit tests in `tests/unit/goal-loop.test.mjs`
- Silo: `scripts/silo/goal-loop.mjs` → `evidence/silo/goal-loop.log`
  (goal adherence, steering amendment, completion signal — all PASS, 4 chat calls)
- Key decisions: completion signal is the literal line `GOAL_STATUS: complete`
  (or `GOAL_STATUS: blocked — <reason>`); lifecycle `active → completing →
  awaiting_audit → complete → archived`, disapproved audit returns to `active`
  with the report as continuation guidance; audit default `goalAudit: "self"`
  with `"worker"` escape hatch; compaction at 80% effective context outranks
  completion requests; guardrail counters never change the loop decision.

### settings-page — /mini settings, enable/disable, local model picker
- Spec: `api/paths/settings-page/model-picker.yaml`,
  `api/paths/config/settings.yaml`, `api/components/schemas/pi-mini-config.yaml`
  (vNext incl. `enabled: boolean = false`), `api/components/schemas/model-list.yaml`
  (LocalRuntimeTag + source discriminator), `async/channels/ollama-ndjson.yaml`
  (existing stream vocabulary), `features/settings-page/*.feature` (6 files)
- Reference logic: `tests/unit/lib/settings-page.mjs` (local-model
  classifier, source merge, fuzzy filter, config vNext parse/serialize,
  picker window math); 31 unit tests in `tests/unit/settings-page.test.mjs`
- Silo: `scripts/silo/settings-page.mjs` → `evidence/silo/settings-page.log`
  (12 local models discovered incl. granite4.2:8b; fuzzy query `grnt` ranks
  both granite entries; model responds — PASS, 1 chat call)
- Key decisions: local = `/api/tags` entries + providers `ollama` /
  `ollama-mini` / `llama-cpp`, remote providers excluded; settings Enable
  persists `enabled=true`, activates mini now, and new sessions auto-enter
  mini when `enabled=true` (`/mini on|off` stays session-only); picker parity
  with pi's `/model`: `maxVisible=10`, centered window, wrap-around
  navigation, `(n/total)`, `✓` current — supersedes `picker.ts`'s 12-row
  clamp for the settings page.

### mini-context — mini AGENTS.md recognition + context budget
- Spec: `api/paths/mini-context/context-budget.yaml`,
  `api/components/schemas/context-budget.yaml` (TokenEstimate, FileBudgetReport,
  ContextBudgetPolicy, SummaryRecord), `features/mini-context/*.feature`
  (5 files: detection, subfolder-policy, summarization, freshness, context-window)
- Reference logic: `tests/unit/lib/mini-context.mjs` (estimator, path
  classifier, verdict decision table, instruction-block builder, freshness);
  21 unit tests in `tests/unit/mini-context.test.mjs`
- Silo: `scripts/silo/mini-context.mjs` → `evidence/silo/mini-context.log`
  (1257-est-token source → 544-est-token summary, 5/5 canary facts retained —
  PASS, 1 chat call)
- Key decisions: estimator `ceil(chars/4 × 1.2)`; threshold 1000 estimated
  tokens; eligible scope = global `~/.pi/agent/AGENTS.md` + cwd-root candidates
  only (ancestor files pi loaded are pi's responsibility; subfolder AGENTS.md
  never enters mini context); summaries persist to `.pi/mini/agents.md` with
  mtime+hash freshness; decline = omit (never load full); effective window
  32768 with projected-usage compaction (80% incl. the 8192 output reserve);
  stale summaries re-prompt, never silently reused.

## Naming rules

- OpenAPI paths/specs: kebab-case YAML, one path per file, grouped under
  `specs/api/paths/<feature>/`.
- Schemas: kebab-case, one schema per file under `specs/api/components/schemas/`;
  registered in the root `components.schemas` block.
- AsyncAPI channels: kebab-case under `specs/async/channels/`.
- Gherkin: `specs/features/<feature>/*.feature`; matching steps in
  `tests/step_definitions/<feature>.steps.mjs`.
- Every spec root document must carry an `x-feature` tag naming its feature.
- Reuse the existing `.pi/goals/` ledger vocabulary verbatim
  (`goal_created`, `task_list_set`, `task_started`, `task_complete`,
  `completion_requested`, `audit_result`, `goal_archived`) — do not invent
  new event names.

## How specs map to tests

| Spec kind | Enforced by |
|---|---|
| All `*.yaml` parse and all `$ref`s resolve | `tests/contract/spec-integrity.test.mjs` |
| OpenAPI/AsyncAPI structural rules + house style | `npx spectral lint` / `tests/contract/spectral-lint.test.mjs` |
| Gherkin well-formedness (`Feature:`, ≥1 `Scenario:`) | `tests/contract/spec-integrity.test.mjs` |
| Pure logic (no live model) | `tests/unit/**/*.test.mjs` — auto-discovered by `node --test` |
| Live-model behavior vs the tiny model | `scripts/silo/<feature>.mjs` — run explicitly, writes `evidence/silo/<feature>.log` |

Silo harnesses are deliberately **not** part of `npm test`: they require
Ollama running at `http://localhost:11434` with `granite4.2:8b` present. Run
them explicitly when changing loop behavior.

## Commands

```bash
npm test                                              # unit + contract tests (node --test)
node -e "require('@stoplight/spectral-cli/dist/index.js')" lint specs/api/openapi.yaml specs/async/asyncapi.yaml   # spec lint
node scripts/silo/<feature>.mjs                       # live-model silo for a feature
```

(Plain `npx spectral lint …` is broken with spectral-cli 6.17 on Node 24 —
its bundled yargs mis-slices `process.argv`. The `node -e require(...)`
invocation above runs the same CLI entry point and is what
`tests/contract/spectral-lint.test.mjs` spawns.)

Per-feature validation convention for feature agents:

1. `node scripts/silo/<feature>.mjs` (requires Ollama; writes evidence log)
2. `npm test` (must stay green — contract tests re-check your YAML)
3. spectral lint on both roots (must exit 0; TODO placeholders in new content
   are expected but every operation you add needs an `operationId` and every
   schema a `description`) — use the `node -e "require(...)" lint …` command
   above, not `npx spectral lint` (broken on this Node, see note)

If `@stoplight/spectral-cli` is not installed (`npx spectral` fails), install
it once with `npm i -D @stoplight/spectral-cli`; the contract suite skips the
spectral test when the CLI is absent.
