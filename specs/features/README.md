# specs/features — Gherkin features

One directory per feature domain: `goal-loop/`, `settings-page/`,
`mini-context/`. Each directory holds:

- `scope.md` — what is in and out of scope for the feature (written at scaffold time).
- `*.feature` — Gherkin features (written by the feature agents).

Step definitions live outside this tree, in
`tests/step_definitions/<feature>.steps.mjs`, and are wired up by the feature
agents. Until step files exist, the `.feature` files are checked only for
structural well-formedness by `tests/contract/spec-integrity.test.mjs`
(must start with `Feature:` and contain at least one `Scenario:`).
