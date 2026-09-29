# UI improvement loop — 2026-09-29

- Target branch: main. Worktree branch: codex/ui-improvement-loop.
- Continue implementation and GUI E2E until 16:00 JST. No review, as explicitly requested.
- Preserve authoritative Git/agent facts and all existing capabilities.
- Loop 1: improve home information hierarchy, filtering, keyboard access and readable Git terminology.
- Loop 2: investigate detail loading/action bugs; preserve selection and display explicit failures.
- Loop 3: responsive layouts, Git learning affordances and performance based on measurements.
- Validate each deployed iteration through browser interactions; run frontend/backend suites and production build.
- Commit changes, publish a PR targeting main and write developer-facing HTML summary with actual test results.

## Completed GUI checks through 15:24 JST

- Real Docker frontend/backend, 94 detected projects.
- Home search, no-match state, sort and compact mode; clearing filters preserves sort/density.
- Favorite toggle, favorites filter, persistence after reload; original favorite restored.
- `/` focuses search. Project detail and back link restore home query/sort/density.
- Rescan reproduced the old full-screen loading interruption; after repair the work list and search stay mounted.
- Network-blocked project request shows retry; unblocking and retry recovers.
- Network-blocked rescan explicitly reports an unconfirmed request, never completion.
- Work lane filters, no-match recovery, sort, tab round-trip preserves query.
- 390px and 320px views inspected visually; mobile work table is readable as cards.
- Light/dark rendering inspected. Theme survives reload. Path clipboard content matches the selected path.
- Graph branch selector scrolls to and focuses the chosen branch.
- Nested Git detail Escape closes only the topmost panel.
- Ctrl+K project switch, search, ArrowDown, Enter; Escape retains the underlying selection.
- Browser-only `/api/projects` fixtures: waiting-for-user selects Alpha, conflict selects Beta, unknown selects Unknown; null main_path offers no misleading link.
- Browser API interception removed and fixture tab closed. No fixture data written to backend.

## Measurements

- Before: `/api/projects` ~1.267 s; concurrent health request ~1.167 s.
- Off event loop: list ~1.266 s; concurrent health request ~0.002 s.
- Bounded parallel Git reads: list 0.373 / 0.378 / 0.374 s for 94 projects.
- Docker frontend context: 474.19 MB before ignore rules; 372.20 kB after.
- Latest frontend tests: 50 passing. Backend: 66 passing.
- A transient ghcr.io token timeout during build was resolved by retry; successful build/deployment followed.

## Additional GUI and performance loop through 15:40 JST

- Full-range graph on real 54-branch / 1,078-commit project renders and switches tabs after the ancestry repair.
- Original ancestry implementation: 15,794 ms. Iterative traversal: 3.15 ms. All 54 branch paths matched the original output exactly.
- Regression tests cover a repeated merge diamond and a 20,000-commit chain; frontend total now 52 passing.
- Commit request blocked in browser: explicit error, unblocked retry recovered 64-file detail; truncated patch banner exposed the exact git show command.
- Large activity list exposed 54 branch memberships per shared commit. Added accessible disclosure and render individual names only while open; search still considers all names.
- Added developer-facing HTML summary. Production build and Docker deployment completed repeatedly.

## Additional loop through 15:48 JST

- Activity disclosure reduced real full-history DOM elements from 51,080 to 12,936; expanding one event still exposes all 54 branch names.
- Browser Back/Forward restores activity/info tab and oldest-first order.
- 320px quick switch stays within viewport and opens another project correctly.
- Mobile selection focus cycles inside dialog and Escape restores the originating branch button. Real branch with no checkout disables Git details with explanation.
- Missing project path and invalid home sort show explicit errors; reset restores the list.
- Reproduced mobile detail at x=-10 due to 100vw including the scrollbar. Changed width to containing viewport percentage; x=0 and right edge=310 verified at 320px viewport.
- README HTML was shown literally in real project info. Parse prose without rendering HTML; ignore headings, badge images, script/style and code blocks. GUI confirms readable real description.
- Backend regression total 69 passing; frontend remains 52. Both deployed containers healthy/running.
- PR created: https://github.com/FujiwaraDaiki-NSE/git-manager/pull/30 . No reviewers requested.
