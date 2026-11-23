# Better Diff

A sidebar for the git diffs you look at all day, opened one file at a time in VS Code's
side-by-side diff editor.

> [!NOTE]
> This is a vibe-coded project. The code is AI-sloppy. If you're not comfortable with that, then you should look for another extension.

## Views

**Branch**

- `my-branch ↔ origin/master`: everything the branch changed since its merge base with the base
  branch.
- `my-branch ↔ origin/my-branch`: what differs from the same branch on the remote, with how many
  commits there are to push and to pull.

**Stack**: the stacked branches the current branch is part of, top first. Each one expands to its
own changes against the branch below it, and to its commits. The stack comes from open pull
requests (`gh pr list`: a pull request's base is the branch below it) and, for branches without
one, from git history. A branch whose parent has moved on is marked `behind parent`.

**Commits**: the branch's commits, oldest first, each expanding to the files it changed. Nothing
is checked out; both sides come from `git show`.

Click a file to open its diff. With **Toggle Uncommitted Changes** on (the default), the right
side is the real file on disk, so you can edit it in the diff.

## Walking

| Command | Key | |
|---|---|---|
| Next File / Previous File | `Alt+J` / `Alt+K` | Through the list the diff was opened from. In Commits, the last file of a commit leads to the first of the next. |
| Next Commit / Previous Commit | `Alt+Shift+J` / `Alt+Shift+K` | To the first file of the next commit. With no diff open, starts at the branch's first commit. |

## Moved code

Like `git diff --color-moved=dimmed-zebra --color-moved-ws=allow-indentation-change`, in the diff
editor: lines that only moved (within a file or between files, re-indented or not) are dimmed, in
two alternating colors, so what really changed stands out. A line edited on the way keeps its
normal diff color. The first line of each block says where it went or came from; hover a block to
**go to the other side** or **compare the two blocks**. Files in the list show how many of their
lines only moved (`⇄ 12 moved`).

Colors: `betterdiff.movedBackground`, `betterdiff.movedAlternateBackground`,
`betterdiff.movedLabelForeground` under `workbench.colorCustomizations`.

## Settings

| Setting | Default | |
|---|---|---|
| `betterdiff.baseBranch` | detect | Branch to compare with. Detection: the remote's default branch, then `origin/master`, `origin/main`, `master`, `main`. |
| `betterdiff.includeWorkingTree` | `true` | Compare with the files on disk instead of the last commit. |
| `betterdiff.fileLayout` | `tree` | `tree` or `list`. |
| `betterdiff.commits.order` | `oldestFirst` | |
| `betterdiff.stack.useGitHubCli` | `true` | Build the stack from open pull requests. |
| `betterdiff.moves.enabled` | `true` | |
| `betterdiff.moves.minLines` / `minCharacters` / `bridgeLines` | 3 / 20 / 2 | What counts as a moved block. |

## Development

```
npm install
npm test                  # unit tests (mocha), against throwaway git repositories
npm run test:integration  # in a real VS Code, downloaded to .vscode-test/ on first run
npm run lint
```

Launch configurations: **Run Extension**, **Run Extension (pick a folder to open)**,
**Debug Unit Tests**, **Debug Integration Tests**.

`docs/PLAN.md` has the design and what's next.
