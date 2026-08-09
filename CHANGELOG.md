# Changelog

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
