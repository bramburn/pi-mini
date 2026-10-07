# (c) The tiny-model picker lists ONLY local models: GET /api/tags merged
# with local-runtime registry entries. Remote providers never appear.
Feature: Local-model selection for the tiny slot
  The picker data source merges the live Ollama /api/tags payload with
  registry entries whose provider is a LocalRuntimeTag (ollama,
  ollama-mini, llama-cpp), deduped by (provider, modelId) with the
  ollama-tags copy winning, and sorted current-model-first.

  Background:
    Given pi-mini is installed
    And the model registry has providers ollama-mini, ollama, minimax

Scenario: picker lists pulled local models from /api/tags
    Given Ollama is reachable
    And GET /api/tags returns models "granite4.2:8b" and "llama3.2:3b"
    When the user opens the tiny-model picker from "/mini settings"
    Then the picker shows "ollama/granite4.2:8b" sourced from ollama-tags
    And the picker shows "ollama/llama3.2:3b" sourced from ollama-tags
    And every entry has source "ollama-tags" or "registry"
    And no entry has a remote provider

Scenario Outline: local-runtime classification decision table
    Given an entry with provider "<provider>" and source "<source>"
    When the picker list is built
    Then the entry is <visibility>

    Examples:
      | provider    | source       | visibility         |
      | ollama      | ollama-tags  | included as local  |
      | ollama-mini | registry     | included as local  |
      | ollama      | registry     | included as local  |
      | llama-cpp   | registry     | included as local  |
      | minimax     | registry     | excluded as remote |
      | openai      | registry     | excluded as remote |
      | anthropic   | registry     | excluded as remote |

Scenario: registry-only local entries are shown but flagged not pulled
    Given Ollama is reachable
    And GET /api/tags returns only "granite4.2:8b"
    And the registry has ollama-mini model "granite4.2:8b"
    And the registry has llama-cpp model "local-drafts:7b"
    When the user opens the tiny-model picker
    Then "ollama-mini/granite4.2:8b" appears with source "registry"
    And "llama-cpp/local-drafts:7b" appears with source "registry"
    And registry-only entries are marked not pulled

Scenario: unreachable Ollama falls back to registry-only with a warning
    Given Ollama is unreachable
    When the user opens the tiny-model picker
    Then a warning notification mentions Ollama is unreachable
    And the picker lists registry local entries only
    And the picker shows no ollama-tags entries

Scenario: selecting a model persists it to the tiny slot
    Given the picker is open
    When the user confirms "ollama/granite4.2:8b"
    Then persisted config tiny is ollama/granite4.2:8b
    And a notification confirms the tiny model change

Scenario: selecting a non-ollama-mini model warns about the native pipeline
    Given the picker is open
    When the user confirms "ollama/llama3.2:3b"
    Then a warning notes think:false, wrap-fix, and the stall watchdog only apply to ollama-mini models
