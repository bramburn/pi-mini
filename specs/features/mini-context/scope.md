# mini-context — scope

"Mini AGENTS.md" recognition and context-window management for mini mode.

## In scope

- Detect when the repo-root `AGENTS.md` (or `~/.pi/agent/AGENTS.md`, or a
  system MD) exceeds ~1000 tokens.
- When over budget, prompt the user to build a summarized `mini-agents.md`
  and use that in place of the full file.
- Manage the context window via pi's extension API (`ctx.getContextUsage()`
  exists and is the usage source of truth).

## Out of scope

- Loading subfolder `AGENTS.md` files into mini context — explicitly never
  done; specs may assert the negative but must not add it.
- Changes to how pi core loads AGENTS.md outside mini mode.
- The settings UI (settings-page) and goal-loop context strategies (goal-loop).
