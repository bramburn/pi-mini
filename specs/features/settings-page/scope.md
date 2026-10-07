# settings-page — scope

The `/mini settings` submenu.

## In scope

- Enable/disable toggle for mini mode.
- Searchable, browsable **local**-model picker, mirroring pi's `/model`
  ModelSelectorComponent behavior:
  - fuzzyFilter search over local models (from `GET /api/tags` on Ollama),
  - a ~10-row sliding window over the filtered list,
  - ✓ marker on the current model,
  - an `(n/total)` position indicator.
- Related settings knobs (think toggle, toolsMode, delegateBudget — the
  PiMiniConfig surface).

## Out of scope

- Remote/cloud model providers (picker is local models only).
- Renaming pi's command: pi's actual command is `/model` (singular); this
  feature adds a `/mini settings` submenu and must not claim to change `/model`.
- Goal-loop behavior (goal-loop feature) and AGENTS.md handling (mini-context).

## Note

The owner's transcript referred to a "`/models`" command; pi's actual
command is `/model` (singular). Specs here mirror `/model`'s
ModelSelectorComponent interaction model.
