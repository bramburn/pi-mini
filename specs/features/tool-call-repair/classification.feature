Feature: Failure classification via the regex taxonomy
  Every tool call that RAN and FAILED is classified from (toolName, rawArgs,
  errorText) into exactly one class by a documented table of regex patterns
  over errorText plus structural checks over rawArgs. The class decides the
  fate of the failure: syntax-repairable enters the isolated repair loop,
  semantic is returned to the main loop as-is and never touches the model,
  transient retries with bounded backoff and never touches the model.
  Precedence is fixed: transient transport signals first, structural checks
  over rawArgs second, syntax error-text patterns third, semantic
  error-text patterns fourth, default semantic.

  Background:
    Given the tool-call repair feature is enabled
    And the classifier pattern table is the default table

Scenario Outline: Regex taxonomy over concrete error strings
    Given a failed call to tool "<toolName>" with raw args <rawArgs> and error text "<errorText>"
    When the failure is classified
    Then the classification class is "<class>"
    And the matched pattern id is "<patternId>"

    Examples:
      | toolName | rawArgs                                    | errorText                                                          | class             | patternId              |
      | edit     | {"path": "src/index.ts", "oldText": "const x | Unexpected end of JSON input                                       | syntax-repairable | args:unbalanced-json  |
      | edit     | {"path": "a.txt", "oldText": "x", "newText  | Unterminated string in JSON                                        | syntax-repairable | args:unbalanced-json  |
      | bash     | {"timeout": 5}                              | must have required property 'command'                              | syntax-repairable | syntax:missing-required |
      | bash     | {"command": "ls", "workdir": "/tmp"}        | must NOT have additional properties 'workdir'                      | syntax-repairable | syntax:additional-prop  |
      | bash     | {"command": "ls", "timeout": "fast"}        | must be of type integer                                            | syntax-repairable | syntax:type-mismatch    |
      | read     | {"path": 42}                                | must be of type string                                             | syntax-repairable | syntax:type-mismatch    |
      | bash     | {"command": ["npm", "test"]}                | must be of type string (contract says command is a string)         | syntax-repairable | contract:type-mismatch  |
      | edit     | {"path": "a.txt"}                           | missing required property 'oldText'                                | syntax-repairable | syntax:missing-required |
      | bash     | {"command": "cat missing.txt"}              | ENOENT: no such file or directory, open 'missing.txt'              | semantic          | semantic:file-not-found |
      | bash     | {"command": "sl"}                           | bash: sl: command not found                                        | semantic          | semantic:command-not-found |
      | bash     | {"command": "false"}                        | Command failed with exit code 1                                    | semantic          | semantic:exit-code      |
      | bash     | {"command": "npm test"}                     | connect ETIMEDOUT 127.0.0.1:11434                                  | transient         | transient:errno         |
      | bash     | {"command": "npm test"}                     | request timed out after 90000 ms                                   | transient         | transient:timeout       |
      | bash     | {"command": "npm test"}                     | fetch failed: connect ECONNREFUSED 127.0.0.1:11434                 | transient         | transient:errno         |
      | bash     | {"command": "npm test"}                     | 429 Too Many Requests                                              | transient         | transient:rate-limit    |
      | edit     | {"path": "a.txt", "oldText": "x", "newText": "y"} | unknown failure with well-formed args                         | semantic          | semantic:default        |

Scenario: Structural contract checks run even when the error text is silent
    Given a failed call to tool "edit" with contract requiring path, oldText, newText
    And raw args {"path": "a.txt", "newText": "y"}
    And error text "tool execution failed"
    When the failure is classified
    Then the classification class is "syntax-repairable"
    And the matched pattern id is "contract:missing-required"

Scenario: A string where the contract wants an array or object is repairable
    Given a failed call to tool "bash" with contract field "command" of type string
    And raw args {"command": ["npm", "install"]}
    And error text "must be of type string"
    When the failure is classified
    Then the classification class is "syntax-repairable"

Scenario: Classification makes zero model calls
    Given a failed call to tool "bash" with raw args {"command": "ls"} and error text "ENOENT: no such file or directory"
    When the failure is classified
    Then the classification class is "semantic"
    And no /api/chat call has been made

Scenario: Transient signals win over everything
    Given a failed call to tool "bash" with unbalanced raw args {"command": "ls
    And error text "connect ETIMEDOUT 127.0.0.1:11434"
    When the failure is classified
    Then the classification class is "transient"
    And no /api/chat call has been made
