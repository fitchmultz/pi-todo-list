# Changelog

## [0.5.0] - 2026-08-19

### Changed

- Return open items from `list` and count the completed ones in its header, so a long session stops paying for finished work on every page. This matches the widget and the post-compaction summary, which were already open-only.
- Read `PI_TODO_WIDGET=show` at startup to start the widget visible instead of hidden. An ad-hoc `/todos toggle` still lasts only for the process.

### Added

- Add `/todos all`, which lists completed items with their text for the human reading the terminal. The agent's `list` stays open-only.

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
