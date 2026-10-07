# (e) Config persistence and validation: round-trips, per-field fallback,
# legacy migration, and the new enabled flag.
Feature: Settings persistence and validation
  The settings page reads and writes PiMiniConfig vNext with the same
  field-by-field validation fallback as settings.ts loadConfig: every
  invalid or missing field falls back to its documented default and never
  invalidates the rest of the file.

  Background:
    Given pi-mini is installed

Scenario: saved config round-trips through load
    Given persisted config has enabled=true
    And the tiny model is ollama/llama3.2:3b
    And think is true
    And toolsMode is "all"
    And delegateBudget is 3
    When the config is reloaded
    Then all fields retain their saved values

Scenario Outline: invalid fields fall back per the schema defaults
    Given the config file contains "<field>" set to <value>
    When the config is loaded
    Then the effective "<field>" is <effective>

    Examples:
      | field          | value                         | effective                 |
      | enabled        | "yes"                         | false                     |
      | think          | "yes"                         | false                     |
      | toolsMode      | "everything"                  | curated                   |
      | delegateBudget | -2                            | 8                         |
      | delegateBudget | 3.9                           | 3                         |
      | tiny           | {"modelId":"x"}               | ollama-mini/granite4.2:8b |
      | large          | {"provider":42,"modelId":"x"} | unset                     |

Scenario: malformed JSON keeps all defaults
    Given the config file contains "{not json"
    When the config is loaded
    Then the effective config equals the defaults
    And enabled is false

Scenario: legacy tiny model is migrated
    Given the config file contains the legacy tiny ref ollama/hf.co/mradermacher/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF:Q4_K_M
    When the config is loaded
    Then the tiny model is ollama-mini/granite4.2:8b
    And other fields are preserved

Scenario: config written before the settings page has enabled=false
    Given the config file predates the enabled field
    When the config is loaded
    Then enabled is false
    And existing fields are preserved

Scenario: disabling then restarting survives
    Given the user disabled pi-mini from the settings page
    When pi restarts
    Then persisted config has enabled=false
    And mini mode is inactive
