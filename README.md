# @fitchmultz/pi-todo-list

A small native Pi extension that gives agents a persistent, nested todo list.

- Agent-callable `todo_list` tool with pending, in-progress, and completed states
- Start, pause, complete, reopen, update, move, remove, and atomic batch actions
- Nested items with recursive completion and deletion
- Paginated list output plus a compact TUI widget and `/todos` controls
- Session-local, branch-aware persistence through tool result details
- Survives compaction, resume, fork, and tree navigation

## Requirements

- Pi 0.84.1 or later

## Install

```bash
pi install git:github.com/fitchmultz/pi-todo-list@v0.3.0
```

For local development:

```bash
pi install /absolute/path/to/pi-todo-list
```

For a one-off run:

```bash
pi -e ./extensions/todo-list.ts
```

Then ask the agent to track the work. It will list todos when starting or resuming, mark items in progress, and reconcile outstanding items before finishing. Related changes can be sent as one ordered `batch` of up to 100 operations; the whole batch rolls back if any operation fails.

`list` returns up to 100 items. Use its zero-based `offset` and optional `limit` to continue through larger lists. `/todos` shows the first page; `/todos toggle`, `/todos show`, and `/todos hide` control the widget.

## Caching

The tool definition and system-prompt guidance are static. Mutations return only the change and status counts. After compaction, the extension injects one bounded active/pending summary when the active branch's retry or next agent turn starts, so later mutations cannot stale it and the provider-cacheable conversation prefix stays intact.

## State behavior

Successful mutations persist as a compact operation log in tool-result `details`, while compaction context stays bounded and does not duplicate state. Resume replays those mutations on the active branch, using legacy version 1 and 2 snapshots when present. If restore encounters corrupt history, it warns, preserves the contiguous valid state, and writes one recovery checkpoint on the next successful `todo_list` call. This keeps session history linear without an extra database or project file. A new session starts with an empty list.

Do not reopen a version 0.3 session with an older extension release; older versions do not understand mutation logs.

## Development

```bash
npm ci
npm run check
pi -e ./extensions/todo-list.ts --list-models
```
