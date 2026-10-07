Feature: Goal definition and loop start
  A short, explicitly defined goal is the loop's single objective (Roo Code /
  Klein style). `/mini goal <objective>` creates the goal, appends
  goal_created + task_list_set to .pi/goals/goal_events.jsonl, binds a loopId
  to the session in .pi/loops/bindings-<session>.json, and starts an
  autonomous loop: on every agent_settled the loop re-injects the goal
  prompt block through the before_agent_start seam and keeps working without
  new user input until every blockCompletion task carries evidence.

  Background:
    Given mini mode is enabled with tiny model "granite4.2:8b"
    And no goal is active for the session

Scenario: /mini goal defines a goal and starts the loop
    When the user runs "/mini goal add /mini settings command"
    Then a "goal_created" event is appended to ".pi/goals/goal_events.jsonl" with objective "add /mini settings command"
    And the goal status is "active" and the revision is 1
    And the goal has a "task_list_set" event with taskCount 2
    And a loopId is bound to the session in ".pi/loops/bindings-<session>.json"

Scenario: An empty objective is rejected
    When the user runs "/mini goal"
    Then no ledger event is appended
    And the reply is "Usage: /mini goal <objective> — a goal must be explicitly defined"

Scenario Outline: The loop continues autonomously across agent_settled cycles
    Given a goal is active with objective "add /mini settings command"
    And the task list has <complete> of <total> blockCompletion tasks complete
    And context usage is <percent> percent
    When the agent settles <cycles> times without new user input
    Then each cycle re-injects the goal prompt block via "before_agent_start"
    And the loop decision is "<decision>"

    Examples:
      | complete | total | percent | cycles | decision           |
      | 0        | 2     | 20      | 1      | continue           |
      | 1        | 2     | 45      | 3      | continue           |
      | 2        | 2     | 45      | 1      | request_completion |
      | 0        | 2     | 82      | 1      | compact_and_continue |

Scenario: The prompt block carries objective, open tasks, and the completion signal
    Given a goal is active with objective "add /mini settings command"
    And task "settings-command" is in_progress with verification contract "settings.test.ts covers the dispatch; node --test green"
    When the goal prompt block is built
    Then the block contains "add /mini settings command"
    And the block contains the open task "settings-command" and its verification contract
    And the block contains the completion signal "GOAL_STATUS: complete"
    And the block is under the 4096 byte prompt budget
