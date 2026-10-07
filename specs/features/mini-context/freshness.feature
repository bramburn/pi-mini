Feature: Summary freshness on reload
  A stale summary is never silently used. On /reload (which re-runs pi's
  resource loader) mini re-evaluates every summarized source against the
  stored SummaryRecord; a changed mtime or content hash re-prompts the user.

  Background:
    Given the mini context budget policy is the default policy
    And a summarized AGENTS.md exists with a stored SummaryRecord

Scenario Outline: Source changes re-prompt instead of silently reusing
    Given the source file's mtime is <mtime> and its content hash is "<hash>"
    And the stored record has mtime 1000 and hash "abc123"
    When the context budget is evaluated after a reload
    Then the summary freshness is "<freshness>"
    And the file verdict is "<verdict>"

    Examples:
      | mtime | hash    | freshness | verdict            |
      | 1000  | abc123  | fresh     | summarized         |
      | 2000  | abc123  | stale     | summarize-prompted |
      | 1000  | def456  | stale     | summarize-prompted |
      | 2000  | def456  | stale     | summarize-prompted |

Scenario: Stale summary is never injected silently
    Given the stored summary exists and the source mtime has changed
    When the context budget is evaluated after a reload
    Then the old summary is NOT used in the mini instruction block
    And the user is prompted again exactly once for that source

Scenario: Fresh summary keeps working without a prompt
    Given the stored summary is fresh
    When the context budget is evaluated after a reload
    Then the user is not prompted
    And the mini instruction block contains the summary from ".pi/mini/agents.md"
