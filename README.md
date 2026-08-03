# pi-todo-list

A small native Pi extension that gives agents a persistent, nested todo list.

- Agent-callable `todo_list` tool with pending, in-progress, and completed states
- Start, pause, complete, reopen, update, move, remove, and atomic batch actions
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

Then ask the agent to track the work. It will list todos when starting or resuming, mark items in progress, and reconcile outstanding items before finishing. Related changes can be sent as one ordered `batch` of up to 100 operations; the whole batch rolls back if any operation fails. Use `/todos toggle` to collapse or restore the widget; `/todos` still shows the full list.

## Caching

The tool definition and system-prompt guidance are static. Mutations return only the change and status counts; the full state stays in persisted tool-result details. After compaction, the extension injects one compact active/pending snapshot when the active branch's retry or next agent turn starts, so later mutations cannot stale it and the provider-cacheable conversation prefix stays intact.

## State behavior

Each successful tool result stores a complete snapshot in `details`. Pi already persists those results in the session tree, so the extension restores the latest snapshot on the active branch without an extra database or project file. A new session starts with an empty list.

## Development

```bash
npm test
pi --no-approve -e ./extensions/todo-list.ts --list-models
```
