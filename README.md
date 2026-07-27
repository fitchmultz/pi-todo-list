# pi-todo-list

A small native Pi extension that gives agents a persistent, nested todo list.

- Agent-callable `todo_list` tool: list, add, update, move, complete, reopen, remove, clear completed items, and atomic batches
- Nested items with recursive completion and deletion
- TUI widget plus `/todos toggle`, `/todos show`, and `/todos hide`
- Session-local, branch-aware persistence through tool result details
- Survives compaction, resume, fork, and tree navigation

## Install

```bash
pi install /absolute/path/to/pi-todo-list
```

For a one-off run:

```bash
pi -e ./extensions/todo-list.ts
```

Then ask the agent to create or update todos. Related changes can be sent as one ordered `batch` of up to 100 operations; the whole batch rolls back if any operation fails. Use `/todos toggle` to collapse or restore the widget; `/todos` still shows the full list.

## Caching

The tool definition and system-prompt guidance are static. Mutations return the current open list in their normal append-only tool result. The extension injects a fresh hidden snapshot only after compaction, so it preserves the provider-cacheable conversation prefix without accumulating per-call duplicate messages.

## State behavior

Each successful tool result stores a complete snapshot in `details`. Pi already persists those results in the session tree, so the extension restores the latest snapshot on the active branch without an extra database or project file. A new session starts with an empty list.

## Development

```bash
npm test
pi --no-approve -e ./extensions/todo-list.ts --list-models
```
