Feature: Mini AGENTS.md budget detection
  Mini mode must measure every eligible instruction file — the global
  ~/.pi/agent/AGENTS.md, repo-root candidates (AGENTS.override.md, AGENTS.md,
  AGENTS.MD, CLAUDE.md, CLAUDE.MD), and the system MD — with the offline
  token estimator (ceil(chars/4) * 1.2). Files estimated at or under 1000
  tokens are inlined exactly as today. Files estimated over 1000 tokens
  trigger a one-time user prompt per (path, mtime, hash).

  Background:
    Given the mini context budget policy is the default policy
    And the instruction token threshold is 1000

Scenario Outline: Eligible files are measured on mini enable
    Given mini mode is enabled in the repository
    And an eligible instruction file exists at "<path>" with <chars> characters
    When the context budget is evaluated at session start
    Then the file at "<path>" is reported with scope "<scope>"
    And the file's estimated tokens equal ceil("<chars>" / 4 * 1.2)
    And the file verdict is "<verdict>"

    Examples:
      | path                      | chars | scope    | verdict            |
      | ~/.pi/agent/AGENTS.md     | 2800  | global   | inline             |
      | <repo>/AGENTS.md          | 3200  | repo-root| inline             |
      | <repo>/AGENTS.md          | 3400  | repo-root| summarize-prompted |
      | <repo>/CLAUDE.md          | 4000  | repo-root| summarize-prompted |
      | <repo>/AGENTS.override.md | 2000  | repo-root| inline             |

Scenario: A repo-root AGENTS.md over 1000 estimated tokens prompts the user once
    Given mini mode is enabled
    And the repo root has an AGENTS.md estimated at 1400 tokens
    When the context budget is evaluated
    Then the user is prompted for "AGENTS.md" with options "summarize now" and "decline"
    And the prompt is recorded against the tuple (path, sourceMtimeMs, sourceHash)
    When the context budget is evaluated again with the same source mtime and hash
    Then the user is not prompted again for "AGENTS.md"

Scenario: Small instruction files are inlined unchanged
    Given mini mode is enabled
    And the repo root has an AGENTS.md estimated at 900 tokens
    When the context budget is evaluated
    Then the file verdict is "inline"
    And the full file content is included in the mini instruction block
    And the user is not prompted

Scenario: The system MD is measured like any other eligible file
    Given mini mode is enabled
    And the system MD is estimated at 1200 tokens
    When the context budget is evaluated
    Then the system MD verdict is "summarize-prompted"
    And the user is prompted for the system MD
