Feature: Repair evidence logging
  Every repair attempt is appended as one JSONL record to
  .pi/mini/tool-repairs.jsonl, per the existing .pi conventions
  (.pi/mini/agents.md, .pi/goals/*). The log is append-only evidence: it
  records the classification, every attempt with its bounded request and
  raw response, and the final status — so audits can prove the guardrails
  held and no failure was silently dropped.

  Background:
    Given the tool-call repair feature is enabled
    And the log file is .pi/mini/tool-repairs.jsonl

Scenario: Every attempt appends a record when the loop closes
    Given a failed call classified syntax-repairable
    When repair attempt 1 fails validation
    And repair attempt 2 succeeds
    Then exactly one record is appended for the call
    And the record contains 2 attempts
    And the record finalStatus is "repaired"

Scenario: An exhausted call logs both the original and the final error
    Given a failed call classified syntax-repairable
    When repair attempt 1 fails extraction
    And repair attempt 2 fails validation
    Then the record finalStatus is "exhausted"
    And the record contains the originalError verbatim
    And the record contains the finalError from the last repair attempt

Scenario: A semantic rejection is logged without any attempt detail
    Given a failed call classified semantic
    When the failure is returned to the main loop as-is
    Then a record is appended with finalStatus "rejected-non-syntax"
    And the record has zero attempts
    And the record contains the originalError verbatim

Scenario: Every record carries the audit identity fields
    Given any repair loop outcome
    When the record is appended
    Then it contains ts, turn, toolName, classification, attempts, finalStatus, and originalError

Scenario: The log is append-only and never rewritten
    Given the log already contains records from earlier turns
    When a new repair loop closes
    Then the new record is appended after the existing lines
    And no existing line is modified or removed
