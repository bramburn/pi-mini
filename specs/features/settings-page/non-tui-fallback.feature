# (f) Headless / non-TUI fallback: the same settings flows work through
# ctx.ui.select and ctx.ui.notify when no TUI is attached.
Feature: Non-TUI fallback for the settings page
  When pi runs without a TUI (hasUI false or mode not tui), the settings
  page degrades to ctx.ui.select menus and ctx.ui.notify messages instead
  of the overlay picker.

  Background:
    Given pi-mini is installed
    And pi is running without a TUI

Scenario: settings menu renders as a select list
    Given persisted config has enabled=false
    When the user runs "/mini settings"
    Then a select menu is offered via ctx.ui.select
    And the options include "Enable pi-mini"
    And the options include the tiny model entry

Scenario: enable works through the fallback menu
    Given persisted config has enabled=false
    When the user chooses "Enable pi-mini" from the select menu
    Then persisted config has enabled=true
    And a notification confirms pi-mini is enabled

Scenario: model picker falls back to a select of local models
    Given Ollama is reachable
    And GET /api/tags returns models "granite4.2:8b" and "llama3.2:3b"
    When the user opens the tiny-model picker
    Then ctx.ui.select is called with only the local model labels
    And no remote provider label is offered

Scenario: fallback picker cancel changes nothing
    Given the tiny-model fallback select is open
    When the user cancels the select
    Then persisted config tiny is unchanged

Scenario: unreachable Ollama notifies a warning in fallback mode
    Given Ollama is unreachable
    When the user opens the tiny-model picker
    Then ctx.ui.notify is called with a warning about unreachable Ollama
    And the select offers registry local entries only
