Feature: Gate a pull request on the mutants it left alive

  An agent that ran Stryker without the agent reporter still has the saved
  mutation.json. It converts that report to JSON Lines, then gates the pull
  request on the lines the pull request changed, so a survivor the pull
  request did not touch does not fail the check.

  Scenario: a survivor on a changed line fails the gate, and one outside it does not
    Given a git repository whose last commit changed one line of a source file
    And a saved Stryker report with one survivor on that changed line and one on an unchanged line
    When the agent converts the saved report to JSON Lines
    Then each survivor's line carries a patch and a rerun command
    When the agent gates the converted output since the commit before the change
    Then the gate exits 1 and names only the survivor on the changed line
