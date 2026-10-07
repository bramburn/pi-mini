Feature: Isolated repair context
  A failed syntax-repairable call is extracted into a separate, small
  context call that asks the model to fix ONLY the call's syntax. The
  context is byte-budgeted and contains exactly the fixer system prompt,
  the tool's argument-contract summary, the failed rawArgs verbatim, and
  the failure classification — nothing else. The reply is extracted with
  strict-JSON-only parsing and MUST validate against the contract before
  the repaired args are accepted for re-execution.

  Background:
    Given the tool-call repair feature is enabled
    And the edit tool contract requires path, oldText, newText all of type string

Scenario: The repair context contains only what the fixer needs
    Given a failed edit call with raw args {"path": "src/index.ts", "oldText": "const x
    And the failure classification is syntax-repairable (args:unbalanced-json)
    When the repair context is built for attempt 1
    Then the context contains the edit contract summary
    And the context contains the failed raw args verbatim
    And the context contains the failure classification
    And the context system prompt says to repair ONLY the syntax and output STRICT JSON only
    And the context is under the byte budget
    And the context contains nothing from the session history

Scenario Outline: Strict-JSON-only extraction of the repair reply
    Given the model replied with <reply>
    When the repaired args are extracted
    Then the extraction result is "<result>"

    Examples:
      | reply                                                                                | result   |
      | {"path":"a.txt","oldText":"x","newText":"y"}                                         | accepted |
      | ```json\n{"path":"a.txt","oldText":"x","newText":"y"}\n```                           | accepted |
      | Here is the fix: {"path":"a.txt","oldText":"x","newText":"y"} done!                  | rejected |
      | {"path":"a.txt","oldText":"x","newText":"y"} Let me explain why this is correct.     | rejected |
      | The problem was the missing quote. Fixed version below.                              | rejected |
      | ```json\n{"path":"a.txt","oldText":"x"}\n``` The newText stays the same.             | rejected |
      | not json at all                                                                      | rejected |

Scenario: Repaired args MUST validate against the contract before acceptance
    Given the model replied with {"path":"a.txt","oldText":"x"}
    When the repaired args are extracted and validated
    Then the extraction is accepted
    But the validation fails with a missing required field
    And the repair attempt is recorded as failed, not accepted

Scenario: Unknown fields in the repair are rejected
    Given the model replied with {"path":"a.txt","oldText":"x","newText":"y","confidence":0.9}
    When the repaired args are extracted and validated
    Then the validation fails with an unknown field
    And the repaired args are NOT re-executed

Scenario: The repair call is small and watchdog-bounded
    When a repair attempt runs
    Then the /api/chat call uses think false
    And num_ctx is 4096
    And num_predict is at most 300
    And the 90 second stall watchdog applies

Scenario Outline: Intent is preserved verbatim — the fixer may not change meaning
    Given a failed bash call with raw args {"command": "npm test
    And the failure classification is syntax-repairable (args:unbalanced-json)
    When the repair context is built
    Then the context instructs the model to preserve the call's intent verbatim
    And any repaired args whose values differ in meaning from the original fragments are caught by the contract validation, not by trust
