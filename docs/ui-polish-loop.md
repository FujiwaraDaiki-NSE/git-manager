# UI improvement loop — 2026-09-29, 16:27–18:00 JST

- Starting branch: main. Implementation: codex/ui-polish-20260929, dedicated worktree.
- Running app was built from PR #30 (codex/ui-improvement-loop). Its clean committed changes are preserved as the base of this follow-up.
- No review performed or requested, per user instruction. GUI E2E plus unit/integration tests instead.

## Loop 1: readable commit patches

- Added shared patch viewer for selected commit and repository detail.
- Unified diff line numbers, additions/deletions, per-file disclosure, wrap toggle and exact raw patch copy.
- Combined merge diffs remain readable raw content without invented two-column line numbers.
- Closed files do not render their patch rows.
- GUI on real commit 9a2dac14: 4 sections, 14 additions, 4 deletions; expand all/collapse all; collapse removes all rendered rows; copied 7,588 characters.
- 390px mobile screenshot inspected; panel bounds 19–351px, no document horizontal overflow.
- Frontend 56 tests and production build pass. Backend baseline 69 tests pass.

## Loop 2: Git ref updates remain live

- Reproduced missing nested remote-ref notification using a disposable repository: callback false, 2 watched directories before; true, 6 after.
- Watch refs/reflogs recursively (not objects or working files), register newly created namespaces and recover deleted/recreated watches.
- Stop waits for the read loop before closing inotify, avoiding a shutdown race found by integration tests.
- Closed an existing test HTTP server socket exposed by warnings-as-errors.
- Backend 73 tests pass with `-W error`.
- Real Docker GUI E2E: isolated local-origin project, commit updates unpushed 0→1, local push updates 1→0 without a rescan. Existing user repositories were not modified by this test.

## Loop 3: shareable and restorable filtered views

- Work/activity query, filter and order are URL state. Reload and copied links preserve the view; tab and sort changes remain navigable with Back/Forward.
- Explicitly invalid tab/range/filter/order/merged/timeline values now show an error with an action that removes only invalid conditions.
- GUI: `ui-` work search persists on reload; Back/Forward switches name/latest and retains query. Activity `graph` + oldest copied URL exactly matches browser location.
- GUI: invalid activity filter and timeline=101 show both invalid keys; recovery preserves valid path, tab, queries and order.
- Frontend 58 tests and production build pass; frontend container rebuilt.

## Loop 4: smaller initial history and direct work navigation

- Activity initially renders 100 entries; next 100/all are explicit choices. Search covers every fetched entry and adds focus to the first newly displayed row.
- Real design_db all-history GUI: 1,078 rows / 12,937 DOM elements before; 100 / 1,265 after (~90% fewer elements). Next→200, all→1,078; oldest matching commit still searchable. Search→clear resets to 100 after a GUI-discovered restoration bug was fixed.
- Home status counts link directly to work lanes with the corresponding filter. GUI dirty link preserved home search and selected the dirty filter; back link restored the home query.
- Same-name projects expose their paths. Two mel-ladder checkouts visually verified at 390px in light theme, no horizontal overflow.
- Quiet agent summaries remain expandable even with partially unknown data, avoiding six mostly unknown tiles taking the mobile first screen after one completed report.
- Frontend 58 tests and Docker production build pass.
