# (a) Opening /mini settings shows the Enable/Disable state, the current tiny
# model, and the model-list entry.
Feature: /mini settings menu
  As a pi user
  I want a /mini settings submenu whose first row toggles pi-mini and whose
  second row shows the tiny model, so that I can manage pi-mini without
  remembering slash commands.

  Background:
    Given pi-mini is installed

Scenario: menu shows enable entry when pi-mini is disabled
    Given persisted config has enabled=false
    And mini mode is inactive
    When the user runs "/mini settings"
    Then the settings menu opens as an overlay
    And the first option reads "Enable pi-mini"
    And the second option reads "Tiny model: ollama-mini/granite4.2:8b"
    And the menu contains a model-list entry for browsing local models

Scenario: menu shows disable entry when pi-mini is enabled
    Given persisted config has enabled=true
    And mini mode is active
    When the user runs "/mini settings"
    Then the first option reads "Disable pi-mini"
    And the second option shows the active tiny model ref

Scenario Outline: first option reflects the enablement state
    Given persisted config has enabled=<persisted>
    And mini mode is <session state>
    When the user runs "/mini settings"
    Then the first option reads "<first option>"

    Examples:
      | persisted | session state | first option      |
      | false     | inactive      | Enable pi-mini    |
      | true      | active        | Disable pi-mini   |
      | false     | active        | Disable pi-mini   |
      | true      | inactive      | Enable pi-mini    |

Scenario: settings is rejected with usage hint on unknown surface
    When the user runs "/mini settings bogus"
    Then a notification shows "Usage: /mini settings"
    And no config change is made
