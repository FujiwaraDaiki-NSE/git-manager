# Issue #5 UI project board implementation plan

## Cause

The repository list exposes worktree metadata but still treats every checkout as an independent flat row and expands detail inline. This separates related checkouts, moves the list when inspecting repositories, duplicates status vocabulary, and makes responsive and dark-mode behavior inconsistent.

## Acceptance criteria

- Project, main checkout, and linked-worktree rows form one board; a project with no linked worktree remains a single repository row.
- Project and worktree ordering, six-item disclosure, worktree/merged/prunable filtering, four metric cards, and project/worktree masthead counts match Issues #6 and #8.
- Every simultaneous Git state is represented by text and a semantic token through `stateBadges`; components contain no duplicate status-color decision logic.
- Selecting a row never expands the list. At 1200 px and wider detail is a sticky right pane; below 1200 px it is a dismissible drawer with a scrim.
- Detail selection and tab are restored from `repo` and `tab` URL parameters; only the active detail tab loads its API.
- Arrow keys navigate the visible repository rows, Enter selects, Escape closes detail, and list focus remains stable.
- Light/dark themes, 13 px body and 11 px auxiliary type, reduced motion, graph skeleton/truncation wording, and middle-ellipsis refs meet Issue #8.
- The production build passes and the running Compose application is verified through the same browser interactions a user performs at desktop, 1024 px, and 375 px widths.

## Work unit

1. Centralize status vocabulary and visual tokens.
2. Replace the flat list/accordion composition with the project board and selected-row model.
3. Convert repository detail to lazy tabs and adaptive pane/drawer presentation with URL and keyboard state.
4. Update README and developer summary, then build, run Compose, and execute browser acceptance checks.
5. Review the complete diff, commit, push, and open a stacked pull request against `codex/issues-1-4`.
