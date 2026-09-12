# Changelog

## [0.7.0] - 2026-09-12

### Added

- Keep paused work distinct from pending work in listings, counts, the widget, and restored sessions.
- Attach a detail link to a short todo title; retrieve it with `list` plus `id` or `/todos <id>`. Links also survive batches, recovery, and cleanup receipts.

### Changed

- Limit recovery summaries to five titles per open state, keep detail links out of summaries, and clarify that later tool results supersede the snapshot.
- Guide agents to replace stale status and maintain one concise current note instead of appending history.
- Use terminal-default colors for the widget and footer so theme changes cannot leave stale colors behind; status symbols remain distinct.
- Write version 5 mutation/read entries and version 6 recovery checkpoints. Existing histories remain readable, including the original pending meaning of old pause operations; older extension releases cannot read new entries.

## [0.6.1] - 2026-09-05

### Fixed

- Include every removed item's ID, full text, and parent association in `clear_completed` results, including successful batches, without adding completed items to normal listings or context.

## [0.6.0] - 2026-09-02

### Fixed

- Restore the exact boundary-time todo snapshot after a native context-window cut and keep it stable across later mutations in that window.
- Preserve empty todo history as `No todos` while keeping initial windows and sessions without todo history free of injected context.
- Ignore older compaction state at native window boundaries, restore live state after later in-window compaction, and avoid duplicate todo context.

## [0.5.0] - 2026-08-19

### Changed

- Return open items from `list` and count the completed ones in its header, so a long session stops paying for finished work on every page. This matches the widget and the post-compaction summary, which were already open-only.
- Read `PI_TODO_WIDGET=show` at startup to start the widget visible instead of hidden. An ad-hoc `/todos toggle` still lasts only for the process.

### Added

- Add `/todos all`, which lists completed items with their text for the human reading the terminal, up to 100 rows and reporting the total when it truncates. The agent's `list` stays open-only.

## [0.4.0] - 2026-08-19

### Changed

- Hide the todo widget by default. The footer status still reports active and pending counts, and `/todos show` reveals the widget.
- Stop declaring `todo_list` as a sequential tool. A single sequential tool serializes every sibling call in an assistant message, and todo mutations never yield mid-call.
- Stop asking agents to spend a `todo_list` call reconciling before they finish. The guidance still requires leaving no item open, which the counts in every result already answer.

### Fixed

- Keep a mutation that already changed state when widget rendering fails, so the change is not dropped on the next resume.

## [0.3.0] - 2026-08-09

### Added

- Add paginated `list` output with `offset` and `limit` parameters.
- Add bounded active/pending context after compaction without duplicating persisted state.
- Add validation for persisted state and compatibility tests for version 1 and 2 snapshots.

### Changed

- Replace full-state details on every tool result with compact mutation logs, reducing session growth from quadratic to linear.
- Make deep tree traversal and subtree mutations iterative.
- Require Pi 0.84.1 or later.
- Sessions written by 0.3.0 require version 0.3.0 or later to resume.

### Fixed

- Prevent deep todo trees from overflowing the JavaScript call stack.
- Strip terminal control characters and reject overlong restored todo text.
- Stop safely at corrupt restore entries, heal with one recovery checkpoint, repair stale next IDs, and reject duplicate, orphaned, cyclic, or invalid items.
- Include the failing operation number and rollback confirmation in batch errors.
- Show usage instead of the full list for invalid `/todos` arguments.
- Bound widget rendering to eight rows and skip tree formatting while hidden.

## [0.2.0] - 2026-08-06

### Changed

- Rename the package to `@fitchmultz/pi-todo-list` to avoid the unrelated unscoped npm package.
- Require Pi 0.84.0 or later and align peer and development dependencies with the released runtime.
- Name `todo_list` explicitly in its prompt guidance and skip UI-only work in headless modes.

## [0.1.0] - 2026-08-02

### Added

- Initial persistent, nested todo-list extension.
- Add pending, in-progress, and completed states with atomic batch mutations.
- Persist branch-aware todo snapshots through tool-result details and restore them after compaction or session navigation.
- Add the `/todos` command and TUI widget.
