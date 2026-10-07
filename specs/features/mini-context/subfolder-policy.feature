Feature: Subfolder AGENTS.md exclusion
  Mini mode deliberately relies on pi's upward-walk resource loading and must
  NEVER load AGENTS.md (or any CLAUDE.md candidate) from a subfolder of the
  repository into mini context. Subfolder discovery, if it happens at all, is
  purely defensive: such files are reported as rejected and omitted.

  Background:
    Given the mini context budget policy is the default policy
    And mini mode is enabled in the repository

Scenario Outline: Subfolder instruction files are never loaded
    Given an AGENTS.md exists at "<path>"
    When the context budget is evaluated
    Then the file at "<path>" has scope "rejected-subfolder"
    And the file verdict is "omitted"
    And the mini instruction block contains nothing from "<path>"

    Examples:
      | path                          |
      | <repo>/src/AGENTS.md          |
      | <repo>/docs/CLAUDE.md         |
      | <repo>/packages/a/AGENTS.MD   |
      | <repo>/.pi/mini/AGENTS.md     |

Scenario: A nested AGENTS.md does not change mini context
    Given mini mode is enabled with an effective instruction block already resolved
    When a new AGENTS.md is created in a subfolder "src/deep/nested/AGENTS.md"
    And the context budget is evaluated on the next session start
    Then the effective instruction block is byte-identical to before
    And no subfolder content appears in the mini system prompt
    And the nested file is reported as scope "rejected-subfolder"

Scenario: Only the repo root and the global file are eligible
    Given pi's resource loader walks upward from the cwd collecting ancestor files
    And an AGENTS.md exists in a parent directory above the repo root
    When the context budget is evaluated
    Then mini does not measure or modify that ancestor file
    And the ancestor file remains pi's responsibility
    And mini's instruction block only reflects the global file and repo-root candidates
