# Changelog

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
