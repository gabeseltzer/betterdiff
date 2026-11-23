# Better Diff — Plan

Last updated: 2026-11-21.

## Goals

1. Current branch against its merge base with master.
2. Current branch against the same branch on the remote.
3. Diffs between stacked branches (stacked pull requests).
4. Walking a branch commit by commit.
5. Moved code shown in VS Code's diff editor, as `git show -M --color-moved=dimmed-zebra
   --color-moved-ws=allow-indentation-change` shows it in a terminal.

Always one file at a time, side by side, picked from a list. No multi-file diff editor.

## Design

```
src/git/exec.ts        run git; a per-refresh memo so the views share answers
src/git/model.ts       branches, merge bases, changed files, commits, stack parents from history
src/git/hunks.ts       `git diff --unified=0` parsed into deleted / added runs
src/git/github.ts      open pull requests from `gh pr list`
src/stack.ts           orders a stack from parent links (pull requests win over history)
src/fileTree.ts        changed files as a compacted folder tree
src/moves/detect.ts    move detection (from context-menu-editor, plus per-line matches)
src/moves/annotate.ts  moves → what each side of each file shows
src/moves/service.ts   moves per comparison, cached
--- everything above has no vscode import and is unit-tested ---
src/views/nodes.ts     tree nodes, lazy children, Next/Previous File and Commit (also no vscode)
src/views/roots.ts     the top level of each view (also no vscode)
src/views/provider.ts  TreeDataProvider, status badges
src/content.ts         `betterdiff:` documents: a file at a commit, an empty side, a moved block
src/diffOpener.ts      opens diffs; knows which of ours is in front; go to / compare a move
src/moves/decorator.ts editor decorations for moved code
src/repo.ts            repository discovery; watches HEAD and refs
src/extension.ts       wiring and commands
```

Decisions:

- **Commit walking renders, it doesn't check out.** Both sides are `git show` documents, so
  walking never touches the working tree or needs it clean.
- **A comparison is (base commit, head commit or working tree).** Branch, upstream, stack layer
  and single commit are all that, so files, moves and navigation are written once.
- **Upstream is a two-dot diff** (remote tip ↔ local): after a rebase it shows the net difference
  a force-push would make, which a three-dot diff wouldn't.
- **Stack layers diff from the merge base with the parent**, so a layer shows only its own
  changes even when its parent has moved on; that case is flagged `behind parent`.
- **Moves use decorations, not the diff editor's move arrows.** The arrows need a diff the
  renderer computes itself; feeding it ours takes the workbench injection context-menu-editor
  does (its docs/CROSS-FILE-MOVES.md). Decorations are stable API and give the dimmed-zebra
  reading: moved lines recede, edits inside a moved block keep their diff color.
- **Nodes are rebuilt on every refresh and found again by id** (`stack/<branch>/file:<path>`), so
  an open diff keeps its place in the list across refreshes.

## Done (0.0.1)

- Branch, Stack and Commits views; tree and list layouts; status badges and +/− counts.
- Working tree as the right side (editable), toggled from the Branch view.
- Next / Previous File and Commit, with keybindings and editor title buttons.
- Stack from `gh` pull requests plus history; open a layer's pull request.
- Moved code: dimming, labels, hover links, block compare, moved-line counts in the list.
- Unit tests (mocha) and integration tests (@vscode/test-cli).

## Next

- **GitHub's stacked pull requests feature.** The stack is read from pull request base branches,
  which is what any stacking tool produces. If `gh stack` (or the API) exposes the stack as its
  own object, read that first: it would also cover stacks whose lower pull requests already
  merged.
- **Check out while walking** (opt-in): `git switch --detach <sha>` per step so the right side is
  the real file with language features, and a "Return to <branch>" command. Refuse on a dirty
  tree.
- **Compare any two refs**, and pin comparisons in the Branch view.
- **Viewed checkmarks** per file per comparison, like a pull request review.
- **Moves in diffs other extensions open** (the built-in Git extension's and GitLens's `git:`
  URIs carry the ref and path).
- **Moves follow edits** in a working-tree diff before the file is saved (today they refresh on
  save).
- **Move arrows** across files, by porting context-menu-editor's synthesized left document; only
  with its live mode.
- Multi-root: the views show one repository at a time (Select Repository…); submodules and
  worktrees of other repositories aren't discovered.
- Encoding: file contents are read as UTF-8.
- CI workflow, icon, Marketplace metadata.
