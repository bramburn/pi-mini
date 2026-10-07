Feature: Mini context window policy
  The mini loop runs an effective context window of 32768 tokens even though
  the local model is pinned at 131072 (num_ctx): tiny-model attention quality,
  the wrap-fix residue guard, and TINY_MAX_TOKENS (8192) output all need
  headroom. When pi's ctx.getContextUsage().percent reaches 80% of the
  effective window, the loop compacts — delegating or summarizing outstanding
  work — rather than losing the goal. Instruction budget counts toward the
  window.

  Background:
    Given the mini context budget policy is the default policy
    And the effective context window is 32768
    And the output reserve of 8192 tokens counts as occupied before each turn

Scenario: Effective window is smaller than the model maximum
    Given the model is pinned with num_ctx 131072
    Then the mini effective context window is 32768
    And every usage percentage is evaluated against 32768 not 131072

Scenario Outline: Compaction triggers at 80 percent of the effective window
    Given the instruction block consumes <instruction> tokens
    And the conversation has consumed <conversation> tokens so far
    When projected usage percent is computed as (conversation + instruction + 8192 reserve) / 32768
    Then the loop compaction decision is "<decision>"

    Examples:
      | instruction | conversation | percent | decision     |
      | 900         | 15000        | 73.5    | continue     |
      | 900         | 17000        | 80.0    | compact      |
      | 900         | 22000        | 95.0    | compact      |
      | 1000        | 17000        | 80.2    | compact      |

Scenario: Compaction delegates rather than dropping the goal
    Given the loop compaction decision is "compact"
    When the next turn would exceed the effective window
    Then outstanding work is delegated or summarized via delegate_to_worker
    And the current goal is preserved in the loop state

Scenario: Instruction budget counts toward the window
    Given the instruction block consumes 1000 estimated tokens
    When the size accounting is computed
    Then instruction block + conversation headroom + 8192 TINY_MAX_TOKENS must fit within 32768
    And the resolved instruction block must fit even after compaction
