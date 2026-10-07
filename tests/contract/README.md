# Contract tests

Structural guarantees for the `specs/` tree, enforced by `npm test`
(`node --test` auto-discovers this directory). These tests need no live
model and no network — they are pure file-structure checks.

## What is guaranteed

1. **Every `*.yaml` under `specs/` parses as YAML** (parsed with the `yaml`
   package).
2. **Every relative `$ref`** of the form `path/file.yaml` or
   `path/file.yaml#/pointer` points to an existing file; local `#/pointer`
   refs resolve within their own document. This keeps the modular OpenAPI /
   AsyncAPI trees honest as feature agents add real content.
3. **`specs/api/openapi.yaml` is a valid OpenAPI 3.1 root** — `openapi: 3.1.x`,
   `info` (title + version), non-empty `paths`.
4. **`specs/async/asyncapi.yaml` is a valid AsyncAPI 3.x root** — `asyncapi: 3.x`,
   non-empty `channels`.
5. **Every `specs/features/**/*.feature` is well-formed Gherkin** — first
   content line starts with `Feature:` and the file contains at least one
   `Scenario:`. Zero feature files is allowed while features are being
   written.
6. **`spectral.yaml` parses** and extends at least `spectral:oas`.

`spectral-lint.test.mjs` additionally runs
`npx spectral lint specs/api/openapi.yaml specs/async/asyncapi.yaml` when
`@stoplight/spectral-cli` is installed, asserting house style (operationId
required, schema description required, `x-feature` tag required). It skips
silently when the CLI is absent.

## What is NOT guaranteed

- Semantic correctness of spec content (TODO placeholders pass).
- Live-model behavior — that is the job of the silo harnesses in
  `scripts/silo/` (see `specs/README.md`).
