# pi-mini index.ts wiring — integration evidence (2026-10-07)

Wired the four new modules (repair.ts, goal-loop.ts, mini-settings.ts, mini-context.ts)
into `index.ts`. No commit; only `index.ts`, `README.md` modified, plus new files
`mini-command.ts` (pure parser extracted for testability) and `index.test.ts`.

## Verification numbers

| Gate | Result |
| --- | --- |
| `node --test index.test.ts` (new parser test) | 7/7 pass |
| `npm test` full suite — 4 runs | run 1: 274/274 · run 2: 274/274 but `scripts/live-test.mjs` timed out under load · run 3: 274/274 · run 4: 274/274 (runs 3+4 consecutive green) |
| `live-test.mjs` solo | PASS (80.4s, all scenarios) — pre-existing full-suite load flake only |
| spectral lint (`specs/api/openapi.yaml`, `specs/async/asyncapi.yaml`) | exit 0 (0 errors; 16 warnings + 1 info, all pre-existing, specs untouched) |
| `node scripts/smoke.mjs` (RPC end-to-end) | NOT RUNNABLE in this shell: `pi.cmd` not on PATH (`stderr: 'pi.cmd' is not recognized…`). Worked previously (see `evidence/smoke-run.log`); RPC environment unavailable now |
| `node scripts/silo/settings-page.mjs` | PASS — "12 local models discovered; tiny model replied" |
| `node scripts/silo/goal-loop.mjs` | PASS — "all probes PASS (4 /api/chat calls, model granite4.2:8b)" |
| `tsc --noEmit -p tsconfig.json` (monorepo tsc, no install) | index.ts: no new errors (only pre-existing `registerTinyProvider` auth-resolve error, byte-identical to HEAD). Pre-existing errors remain in goal-loop.ts:746 / mini-settings.ts:173 / ollama-native.ts (untouched files) |

Silo log tails (this run):

```
[2026-10-07T14:54:49.966Z] {"event":"silo_pass","probes":["discovery","model-responds"]}
[2026-10-07T14:56:06.685Z] {"event":"all_probes_passed","calls":4,"model":"granite4.2:8b"}
```

## What changed in index.ts

- Imports + module state: `sharedGoalStore = new GoalStore()` (module init),
  `miniCtxBlockCache` (string | null), `miniContextInstalledCtx`,
  `PROMPT_COMPOSE_BUDGET = 6000`, `state.promptTrimNotified`.
- `installRepair(pi, …, { isEnabled, getConfig: loadConfig })`.
- `installGoalLoop(pi, …, { isEnabled, getConfig, store: sharedGoalStore, delegateAudit })`
  registered BEFORE index's own `before_agent_start` (pi chains systemPrompt
  results across handlers — see adaptations).
- `pi.on("session_start")`: installs `installMiniContext` on the live session ctx
  (first session only), invalidates the context-block cache, and auto-enables
  with notify "pi-mini: auto-enabled from settings" when `cfg.enabled` (wrapped,
  never crashes init).
- `before_agent_start` composition: MINI_SYSTEM_PROMPT + goal block (skip when the
  chained goal-loop handler already injected it — "## Active Goal" marker guard)
  + cached `<mini_context>` block; >6000B drops context block first, then goal
  block, one notify per enable session.
- `/mini` command: new subcommands `settings` and `goal` (+ `goal amend`,
  `goal cancel`); parser extracted as pure exported `parseMiniCommand` (re-exported
  from index.ts, implemented in new `mini-command.ts`).
- `enable()` fires `refreshMiniContext` (covers /mini on, settings enable, auto-start).
- `reportStatus` adds goal / repair / mini-context lines.

## Adaptations vs the module contracts

1. **Extension factory receives no ctx.** pi's `ExtensionFactory = (pi) => void | Promise<void>`.
   - `installRepair` ctx is documented unused → passed as an erased stub.
   - `installGoalLoop` ctx is only a fallback for handler ctx (pi always supplies it) → undefined.
   - `installMiniContext` needs a WeakMap-stable ctx → installed lazily on first
     `session_start`, whose ctx is retained for all later `refresh()` calls.
   - Auto-start therefore runs at first `session_start` (not synchronously in the factory).
2. **`sendUserMessage` lives on `ExtensionAPI`, not on the command ctx** → goal
   kickoff/amend steering uses `pi.sendUserMessage(…, { deliverAs: "steer" })`.
3. **before_agent_start results are chained across extensions.** goal-loop.ts's own
   handler appends the goal block to whatever prompt it receives. index registers
   its handler after installGoalLoop so the final chained result is index's full
   composition; a marker guard (`## Active Goal`) additionally prevents a double
   block if chain order ever inverts. goal-loop.ts was not modified.
4. **Command ctx vs session ctx for mini-context refresh**: `refresh()` is keyed by
   the install-time ctx; when called with a different ctx (settings menu), the
   wrapper falls back to `ensureMiniContext` directly on the passed ctx.
5. **Parser test**: `index.ts` cannot be imported under plain-node strip-only mode
   because `picker.ts` uses TS parameter properties (pre-existing). The pure parser
   therefore lives in the new `mini-command.ts`; `index.ts` re-exports it.
