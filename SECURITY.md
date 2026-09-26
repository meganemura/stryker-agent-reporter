# Security

Report a vulnerability through GitHub's private vulnerability reporting on this repository, from the Security tab.
Do not open a public issue for it.

The report gets an answer within a week. A fix ships as a patch release, and the changelog names the advisory once the fix is out.

This package reads a Stryker report and writes JSON Lines; `gate` also reads the current working tree and runs `git diff` on it. A report that shows a crafted report or repository content reaching an unintended file write, or an argument passed to `git` unescaped, is in scope.
