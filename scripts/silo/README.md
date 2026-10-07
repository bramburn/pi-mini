# Live-model silo harnesses

One script per feature (`<feature>.mjs`), run **explicitly** — never via
`npm test` — against a live Ollama at `OLLAMA_BASE_URL` (default
`http://localhost:11434`) with the tiny model from
`~/.pi/agent/pi-mini.json` (default `granite4.2:8b`) present.

```bash
node scripts/silo/<feature>.mjs     # writes evidence/silo/<feature>.log
```

Each harness must:

- use `_lib.mjs` (`postChat`, `getTags`, `check`, `logEvidence`) — do not
  re-implement the Ollama client;
- pin `num_ctx`, cap `num_predict`, and send `think:false` (per
  `specs/api/paths/ollama/chat.yaml`);
- log every assertion and its outcome to the evidence log via `check()` /
  `logEvidence()`;
- exit non-zero on failure so it can gate a goal-loop audit.

Silo runs are the live counterpart of `tests/unit/` (pure logic,
auto-discovered by `node --test`) — if a behavior can be tested without a
model, it belongs in `tests/unit/`, not here.
