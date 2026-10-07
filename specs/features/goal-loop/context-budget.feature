Feature: Context budget policy
  The loop never drops the goal because the context filled up. The default
  policy compacts when ctx.getContextUsage().percent reaches 80 percent of
  the effective context window: outstanding work is delegated or summarized
  via delegate_to_worker, the goal state lives in the ledger (not the
  context), and the loop continues with the amended objective intact.
  Compaction takes precedence over requesting completion — an audit is never
  started in a nearly-full context.

  Background:
    Given the context policy is the default policy
    And the compaction threshold is 80 percent of the effective context window

Scenario Outline: The loop decision over context usage and goal state
    Given the goal status is "<status>"
    And the blockCompletion tasks are "<tasks>"
    When ctx.getContextUsage() reports percent <percent>
    Then the loop decision is "<decision>"

    Examples:
      | status         | tasks       | percent | decision           |
      | active         | incomplete  | 79.0    | continue           |
      | active         | incomplete  | 80.0    | compact_and_continue |
      | active         | incomplete  | 91.0    | compact_and_continue |
      | active         | all complete | 85.0   | compact_and_continue |
      | completing     | all complete | 45.0   | request_completion |
      | awaiting_audit | all complete | 95.0   | audit              |
      | archived       | all complete | 10.0   | stop_archived      |

Scenario: Compaction delegates outstanding work and preserves the goal
    Given the goal is active with objective "add /mini settings command"
    And ctx.getContextUsage() reports percent 85
    When the loop compacts
    Then outstanding work is delegated or summarized via delegate_to_worker
    And the goal objective "add /mini settings command" and revision are preserved in the ledger
    And the next loop turn re-injects the goal prompt block via "before_agent_start"
    And the loop decision is "continue"

Scenario: Usage accounting accumulates across loop turns
    Given the goal usage is tokensUsed 42000 and activeSeconds 640
    When one more loop turn consumes 1800 tokens and 30 active seconds
    Then the goal usage is tokensUsed 43800 and activeSeconds 670
