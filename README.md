# pi-mini

pi extension: run a **tiny local LLM** (default `granite4.2:8b` on Ollama) as the
session model on **pi's native agentic tool loop**, with a `delegate_to_worker`
escape hatch that hands large work to a configured big model (full pi worker
subprocess). Toggling off restores the previous model and tools.

## How it works

- **`ollama-native.ts`** — custom pi-ai stream handler over Ollama's *native*
  `/api/chat` (the compat `/v1` endpoint silently ignores `think:false`, which
  cripples tool loops on granite-class models). Pins `num_ctx` to the model's
  context window, caps output via `num_predict`, and includes a stall watchdog
  (giant schema-constrained arguments can dead-end silently on some builds).
- **`wrapfix.ts`** — json-call/tool-call wrap-fix: when the model degrades to
  emitting a tool call as (possibly truncated) JSON text, it is repaired into a
  real `toolCall` (`wrapfix_call_N` ids) before the stream's `done` event, so
  the standard `tool_use → tool_result → continue` loop keeps running. Wrapped
  calls **buried in more than ~200 chars of prose are left as text** — that's
  documentation or dictation, not a degraded call.
- **`index.ts`** — `/mini on` keeps a curated tool set active
  (`read/edit/find/grep/bash` — `find` is pi's glob tool) plus
  `delegate_to_worker`. Per-user-turn budgets: 2 wrap-fix conversions
  (blocks + terminates repeats) and a configurable delegate budget (default 8).
- **Dictation carve-out** — the tiny system prompt tells the model to answer
  explicit "output/dictate/repeat this verbatim" requests as plain text.

## Commands

`/mini [on|off|tiny|large|status]`

## Config — `~/.pi/agent/pi-mini.json`

```json
{
  "tiny": { "provider": "ollama-mini", "modelId": "granite4.2:8b" },
  "large": { "provider": "minimax", "modelId": "MiniMax-M3" },
  "think": false,
  "toolsMode": "curated",
  "delegateBudget": 8
}
```

- `think` — granite-style thinking toggle for the tiny model (off = fast tool loops).
- `toolsMode` — `curated` | `all` | `read-only` (plus `delegate_to_worker` always).
- Legacy configs are migrated automatically; the `ollama-mini` provider is
  pi-mini's own and never touches your `ollama` catalogue in `models.json`.
- Non-`ollama-mini` tiny models work but run on their provider's stock API
  (no think:false / wrap-fix / watchdog — you get a warning).

## Development

```bash
npm test              # node --test; auto-links pi-ai via scripts/ensure-test-deps.mjs
node scripts/live-test.mjs   # live harness vs running Ollama (loop, wrap-fix, args repair, watchdog)
node scripts/smoke.mjs       # end-to-end /mini session in pi over RPC
```

Run transcripts and capture fixtures are committed under `evidence/`.
If pi-ai can't be found, `ensure-test-deps.mjs` junctions
`node_modules/@earendil-works` from the pi monorepo — set `PI_MONOREPO=<path>`
when your pi checkout lives elsewhere. (Runtime needs nothing: the extension
resolves pi's own packages inside the pi process.)

## Known trade-offs

- Wrap-fix only converts the *first* wrapped call per message, and only when
  the message is essentially just the call.
- A genuine "dictation" of a tool-call JSON is indistinguishable from a
  degraded call and will be executed (bounded by the 2/turn cap).
- Very long single-string tool arguments can stall at the model level; the
  watchdog turns that into a tool error instead of a hang. Prefer `edit` with
  small arguments or `delegate_to_worker` for big writes.
