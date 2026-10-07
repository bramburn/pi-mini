Feature: Completion gate and audit
  The loop may finish only through the gate: when every blockCompletion task
  carries evidence the loop emits completion_requested (status
  awaiting_audit), an auditor re-verifies the evidence per config, and only
  an approved audit_result archives the goal and stops the loop. A
  disapproved audit returns the goal to active with the report as
  continuation guidance and the gate re-runs after further work.

  Background:
    Given mini mode is enabled
    And a goal is active with objective "add /mini settings command" at revision 2
    And the task list is:
      | id                | blockCompletion | status    | evidence                                    |
      | settings-command  | true            | complete  | settings.test.ts 9/9 pass                   |
      | docs              | false           | pending   |                                             |

Scenario: All blockCompletion tasks complete moves the goal to completing
    When the folder folds the ledger
    Then the goal status is "completing"
    And the pending non-blocking task "docs" does not block the gate

Scenario: completion_requested moves the goal to awaiting_audit
    When the loop emits "completion_requested" for revision 2
    Then the goal status is "awaiting_audit"

Scenario: An approved audit archives the goal and stops the loop
    Given the goal status is "awaiting_audit" at revision 2
    When an "audit_result" event arrives with verdict "approved", auditor "mini", and report "all blockCompletion evidence verified"
    Then the goal status is "complete"
    And a "goal_archived" event is appended with archivePath ".pi/goals/archived/goal_*.md"
    And the loopId is unbound from ".pi/loops/bindings-<session>.json"
    And the loop stops with stopReason "audit_approved"

Scenario: A disapproved audit continues the loop with continuation guidance
    Given the goal status is "awaiting_audit" at revision 2
    When an "audit_result" event arrives with verdict "disapproved", auditor "mini", report "settings.test.ts fails on main", and continuation "fix the dispatch regression and re-run node --test"
    Then the goal status is "active"
    And the next loop turn's prompt block contains "fix the dispatch regression"
    And the loop keeps working without new user input

Scenario: completion_requested is rejected while a blockCompletion task lacks evidence
    Given the task list is:
      | id                | blockCompletion | status      |
      | settings-command  | true            | in_progress |
    When the loop emits "completion_requested"
    Then the event is rejected with conflict "blockCompletion task settings-command lacks evidence"
    And the goal status stays "active"

Scenario Outline: The auditor is chosen per config
    Given the goal status is "awaiting_audit"
    And the config goalAudit is "<config>"
    When the audit runs
    Then the auditor is "<auditor>" and it runs via "<mechanism>"

    Examples:
      | config | auditor | mechanism                                    |
      | self   | mini    | mini self-audit prompt on the tiny model     |
      | worker | worker  | delegate_to_worker to the configured large model |

Scenario: The audit re-runs after a disapproval
    Given the goal status is "active" after a disapproved audit
    When the loop finishes the continuation guidance and all blockCompletion tasks carry evidence again
    Then the loop emits "completion_requested" for revision 2 again
    And the goal status is "awaiting_audit" again
