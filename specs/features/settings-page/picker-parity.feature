# (d) Picker interaction parity with pi's /model ModelSelectorComponent:
# fuzzyFilter type-to-search, 10-row sliding window, wrap-around navigation,
# ✓ on current, (n/total) indicator, Enter confirms, Esc cancels with no
# config change, selecting the current model is a no-op.
Feature: Picker interaction parity with pi /model
  The settings-page picker mirrors pi's /model selector interaction model
  (tui.select.up/down/confirm/cancel keybindings), restricted to local
  models and writing the tiny slot on confirm.

  Background:
    Given pi-mini is installed
    And mini mode is inactive
    And the current tiny model is ollama-mini/granite4.2:8b
    And Ollama serves 15 local models

Scenario: initial state shows current model first with a checkmark
    When the user opens the tiny-model picker
    Then the first row is the current model marked with "✓"
    And the list is sorted current-model-first then provider alphabetical

Scenario Outline: fuzzy type-to-search filters the list
    Given the picker is open
    When the user types "<query>"
    Then the visible rows are "<matches>"

    Examples:
      | query    | matches                              |
      | grnt     | rows containing a granite model      |
      | l3       | rows fuzzy-matching llama3-style ids |
      | zzqq     | no matching models                   |

Scenario: the list scrolls through a 10-row centered window
    Given the picker is open with 15 local models
    When the user moves the selection down 12 times
    Then at most 10 rows are visible at any time
    And the visible window is centered on the selection
    And the position indicator shows "(13/15)"

Scenario Outline: navigation wraps around at the edges
    Given the picker is open with "<count>" models
    And the selection is at index "<start>"
    When the user presses "<key>"
    Then the selection is at index "<end>"

    Examples:
      | count | start | key  | end |
      | 15    | 0     | up   | 14  |
      | 15    | 14    | down | 0   |
      | 15    | 7     | down | 8   |
      | 1     | 0     | down | 0   |

Scenario: Enter confirms and persists the selection
    Given the picker is open
    When the user navigates to "ollama/llama3.2:3b"
    And the user presses Enter
    Then the picker closes
    And persisted config tiny is ollama/llama3.2:3b

Scenario: Escape cancels with no config change
    Given the picker is open
    And persisted config tiny is ollama-mini/granite4.2:8b
    When the user navigates to "ollama/llama3.2:3b"
    And the user presses Escape
    Then the picker closes
    And persisted config tiny is unchanged
    And no notification about a model change is shown

Scenario: selecting the current model is a no-op
    Given the picker is open
    When the user confirms the current model "ollama-mini/granite4.2:8b"
    Then the picker closes
    And the config file mtime is unchanged
    And no model-change notification is shown

Scenario: footer shows the Model Name hint
    Given the picker is open
    Then the footer shows "Model Name:" for the selected row
    And the footer shows the type-to-search hint
