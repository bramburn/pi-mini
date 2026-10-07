Feature: Guardrails and retries for the repair loop
  The repair loop is bounded everywhere: at most 2 repair attempts per
  failed call, each failure re-classified before the next attempt; at most
  2 repair calls per user turn on a counter that is INDEPENDENT of the
  wrapfix conversion cap (2/turn) and the delegate_to_worker budget
  (8/turn). Repair calls never recurse. The 90s stall watchdog applies.
  When a call exhausts its attempts, the ORIGINAL error plus the last
  repair error are surfaced to the main loop as the tool_result — never
  silently dropped.

  Background:
    Given the tool-call repair feature is enabled
    And the repair policy is maxRepairAttemptsPerCall 2, maxRepairCallsPerTurn 2

Scenario Outline: Per-call attempts and per-turn caps compose with wrapfix and delegate budgets
    Given the current turn has used <wrapfixUsed> wrapfix conversions, <delegateUsed> delegate calls, and <repairUsed> repair calls
    And a failed call is classified syntax-repairable
    When the repair loop decides whether to start attempt <attempt>
    Then the decision is "<decision>"

    Examples:
      | wrapfixUsed | delegateUsed | repairUsed | attempt | decision |
      | 0           | 0            | 0          | 1       | start    |
      | 0           | 0            | 0          | 2       | start    |
      | 0           | 0            | 0          | 3       | refuse   |
      | 2           | 8            | 0          | 1       | start    |
      | 0           | 0            | 1          | 1       | start    |
      | 0           | 0            | 2          | 1       | refuse   |
      | 2           | 8            | 2          | 1       | refuse   |
      | 0           | 8            | 1          | 2       | start    |
      | 2           | 0            | 1          | 2       | start    |

Scenario: Two failed attempts exhaust the call and surface both errors
    Given a failed call classified syntax-repairable
    When repair attempt 1 fails validation
    And the failure is re-classified as syntax-repairable
    And repair attempt 2 fails extraction
    Then the call is exhausted
    And the tool_result surfaced to the main loop contains the original error
    And the tool_result also contains the last repair error
    And no third attempt is made

Scenario: A failure re-classified as semantic mid-repair stops the loop
    Given a failed call classified syntax-repairable
    When repair attempt 1 fails
    And the re-classification is semantic
    Then the call is rejected-non-syntax
    And no further attempt is made

Scenario: Repair calls never recurse
    Given a repair attempt is in flight in an isolated repair context
    When the repair call itself fails
    Then the repair failure is NOT fed back into the repair loop
    And the call is exhausted with the original error surfaced

Scenario: The per-turn cap counts repair calls, not repair-eligible failures
    Given the current turn has used 2 repair calls on a previous failed call
    When a new failed call is classified syntax-repairable
    Then the decision is "refuse"
    And the failure is surfaced to the main loop as-is

Scenario Outline: Transient retries use bounded backoff and no model
    Given a failed call is classified transient
    When transient retry <n> is scheduled
    Then the backoff is <backoffMs> ms
    And no /api/chat call has been made

    Examples:
      | n | backoffMs |
      | 1 | 500       |
      | 2 | 2000      |

Scenario: A third transient signal exhausts the backoff schedule
    Given a failed call is classified transient
    When transient retries 1 and 2 have already run
    And the call fails again with a transient signal
    Then the call is exhausted
    And the original error is surfaced to the main loop
    And no /api/chat call has ever been made for this failure

Scenario: Counters reset on user input, not on tool chatter
    Given the current turn has used 2 repair calls
    When the user sends a new message
    Then the repair counter resets for the next turn
    And a failed call in the new turn can be repaired again
