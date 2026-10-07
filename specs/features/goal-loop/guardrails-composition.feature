Feature: Guardrails composition inside the loop
  The existing per-turn guardrails keep applying inside the goal loop:
  wrapfix conversions are capped at 2 per turn and delegate_to_worker is
  capped at the delegate budget (default 8) per turn. A turn that exhausts
  them ends cleanly — the loop decision for the next cycle is still computed
  from the goal ledger, never from guardrail state, so goal state cannot be
  corrupted by a throttled turn.

  Background:
    Given mini mode is enabled with delegate budget 8
    And a goal is active with an incomplete blockCompletion task "settings-command"
    And context usage is 20 percent

Scenario Outline: Guardrail exhaustion does not change the loop decision
    Given the current turn has used <wrapfixUsed> wrapfix conversions and <delegateUsed> delegate calls
    When the loop decision is made after the agent settles
    Then the decision is "continue"
    And the goal status stays "active"
    And the task "settings-command" stays "in_progress"

    Examples:
      | wrapfixUsed | delegateUsed |
      | 2           | 0            |
      | 0           | 8            |
      | 2           | 8            |
      | 1           | 7            |

Scenario: A blocked wrapfix call terminates the turn with a self-correcting reason
    Given the current turn has already used 2 wrapfix conversions
    When the model emits a third text-wrapped tool call
    Then the call is blocked and the turn terminates with reason "Stop repeating the JSON block and finish your turn with a normal reply"
    And no ledger event is written for the blocked call

Scenario: A blocked delegate call finishes the turn within budget
    Given the current turn has already used 8 delegate calls
    When the model calls delegate_to_worker a ninth time
    Then the call is blocked with reason "The delegate_to_worker budget for this turn (8) is reached"
    And the loop decision is "continue" and the goal state is unchanged

Scenario: Per-turn budgets reset on steering input, not across the whole goal
    Given the current turn has used 2 wrapfix conversions and 8 delegate calls
    When the user sends a steering message mid-run
    Then the wrapfix and delegate counters reset for the next turn
    And a "goal_amended" event is appended with the next revision
