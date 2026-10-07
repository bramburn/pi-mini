Feature: Boundary with the pre-execution wrap-fix
  wrapfix.ts repairs degraded tool-call TEXT before the stream's done event
  (pre-execution): text-wrapped or truncated JSON is converted back into a
  real toolCall, capped at 2 conversions per turn, with a 200-character
  residual-prose guard. The repair loop in this feature is POST-execution:
  it is the fallback for calls that slip through wrapfix or fail validation
  at execution time. The two layers never overlap: wrapfix output that
  executes successfully never enters repair, and repair never rewrites
  stream text.

  Background:
    Given mini mode is enabled
    And the tool-call repair feature is enabled

Scenario: Wrapfix converts before execution, so a successful call never reaches repair
    Given the model emits a truncated edit call as text {"path": "a.txt", "oldText": "const x
    When the stream's done event fires
    Then wrapfix converts it into a real toolCall before the done event
    And the call executes with repaired arguments
    And no repair event is emitted

Scenario: A wrapfix-converted call that fails validation at execution enters repair
    Given the model emits a text-wrapped bash call {"timeout": 5}
    And wrapfix converts it into a real toolCall before the done event
    When the executed call fails with "must have required property 'command'"
    Then the failure is classified syntax-repairable
    And the post-execution repair loop starts

Scenario: Residual prose over 200 characters is documentation, not a call, and never reaches repair
    Given the model emits a fenced JSON example buried in more than 200 characters of prose
    When the stream's done event fires
    Then wrapfix leaves the text alone
    And no toolCall is created
    And no repair event is emitted

Scenario: Semantic failures never enter repair at either layer
    Given a bash call with well-formed args {"command": "cat missing.txt"} executes
    When it fails with "ENOENT: no such file or directory, open 'missing.txt'"
    Then the failure is classified semantic
    And the original error is returned to the main loop as-is
    And no repair /api/chat call is made
    And a repair_rejected (non-syntax) event is appended

Scenario: Transient failures never enter repair at either layer
    Given a bash call with well-formed args {"command": "npm test"} executes
    When it fails with "connect ETIMEDOUT 127.0.0.1:11434"
    Then the failure is classified transient
    And it retries with bounded backoff 500 then 2000 ms
    And no repair /api/chat call is made

Scenario: The per-turn counters are independent across the two layers
    Given the current turn has used 2 wrapfix conversions
    When a call that ran and failed is classified syntax-repairable
    Then the repair loop may still start because the repair counter is separate
    And spending the wrapfix budget does not shrink the repair budget
