# (b) The Enable/Disable action persists the new `enabled` flag and applies
# the same state transition as the session commands.
Feature: Enable and disable pi-mini from the settings page
  The settings-page toggle is the PERSISTENT path: it writes `enabled` to
  ~/.pi/agent/pi-mini.json and applies the transition immediately. The
  session-only /mini on|off commands do not touch the flag.

  Background:
    Given pi-mini is installed
    And the tiny model ollama-mini/granite4.2:8b is in the model registry
    And a large model is configured

Scenario: enabling persists enabled=true and activates mini mode
    Given persisted config has enabled=false
    And mini mode is inactive
    When the user runs "/mini settings" and chooses "Enable pi-mini"
    Then persisted config has enabled=true
    And mini mode is active
    And the session model switches to the tiny model
    And the active tools become the curated set plus delegate_to_worker
    And the status line shows the MINI summary

Scenario: disabling persists enabled=false and restores previous state
    Given persisted config has enabled=true
    And mini mode is active with a remembered previous model and tools
    When the user runs "/mini settings" and chooses "Disable pi-mini"
    Then persisted config has enabled=false
    And mini mode is inactive
    And the previous session model is restored
    And the previous tool set is restored

Scenario: enablement toggle is idempotent
    Given persisted config has enabled=true
    And mini mode is active
    When the user runs "/mini settings" and chooses "Disable pi-mini"
    And the user runs "/mini settings" and chooses "Enable pi-mini"
    Then persisted config has enabled=true
    And a notification reports pi-mini is enabled again without duplicating state

Scenario: session-only /mini on does not persist
    Given persisted config has enabled=false
    When the user runs "/mini on"
    Then mini mode is active
    But persisted config has enabled=false
    And a new session starts with mini mode inactive

Scenario: new sessions honor persisted enabled=true
    Given persisted config has enabled=true
    When a new pi session starts
    Then mini mode activates automatically with the configured tiny model

Scenario Outline: enablement transitions keep the config consistent
    Given persisted config has enabled=<before>
    And mini mode is <session before>
    When the user chooses "<action>" in "/mini settings"
    Then persisted config has enabled=<after>
    And mini mode is <session after>

    Examples:
      | before | session before | action          | after | session after |
      | false  | inactive       | Enable pi-mini  | true  | active        |
      | true   | active         | Disable pi-mini | false | inactive      |
      | false  | active         | Disable pi-mini | false | inactive      |
      | true   | inactive       | Enable pi-mini  | true  | active        |
