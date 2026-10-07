Feature: Steering amendment mid-run
  Any user prompt that arrives mid-run (interactive or rpc source) amends the
  active goal instead of starting a new turn's work in a vacuum: the runtime
  appends a goal_amended event carrying the next revision number, applies the
  objective replacement and/or taskListOps, and the next loop turns reflect
  the amended objective. Only tasks with blockCompletion: true gate
  completion.

  Background:
    Given mini mode is enabled
    And a goal is active with objective "add /mini settings command" at revision 1

Scenario: A mid-loop user message amends the goal
    When the user sends "also expose the delegate budget in the settings output" mid-run
    Then a "goal_amended" event is appended with revision 2
    And the "goal_amended" event reason is "also expose the delegate budget in the settings output"
    And a task "delegate-budget-status" with blockCompletion true is added to the task list
    And the next loop turn's prompt block contains "delegate budget"

Scenario: Objective replacement bumps the revision
    When the user sends "focus: the settings command must also support /mini settings status" mid-run
    Then the goal revision is 2
    And the folded goal objective mentions "/mini settings status"
    And the previous revision's objective is preserved in the ledger only

Scenario Outline: Amendments recompute the completion gate
    Given the goal status is "<status>"
    And all blockCompletion tasks are complete
    When the user amends the goal with a taskListOps add of a blockCompletion task "extra-audit"
    Then the goal status is "<next>"
    And the goal revision is 2

    Examples:
      | status         | next       |
      | active         | active     |
      | completing     | active     |
      | awaiting_audit | active     |

Scenario: A stale-revision audit result is ignored after an amendment
    Given the goal status is "awaiting_audit" at revision 1
    And all blockCompletion tasks are complete
    When the user amends the goal
    And an "audit_result" event for revision 1 arrives with verdict "approved"
    Then the audit verdict is not applied
    And the goal status is "completing" for revision 2, ready to re-request completion
