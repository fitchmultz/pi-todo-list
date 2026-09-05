# @fitchmultz/pi-todo-list

A small native Pi extension that gives agents a persistent, nested todo list.

- Agent-callable `todo_list` tool with pending, in-progress, and completed states
- Start, pause, complete, reopen, update, move, remove, and atomic batch actions
- Nested items with recursive completion and deletion
- Paginated open-work listing plus an opt-in TUI widget and `/todos` controls
- Session-local, branch-aware persistence through tool result details
- Survives compaction, native context windows, resume, fork, and tree navigation

## Requirements

- Pi 0.84.1 or later

## Install

```bash
pi install git:github.com/fitchmultz/pi-todo-list@v0.6.1
```

For local development:

```bash
pi install /absolute/path/to/pi-todo-list
```

For a one-off run:

```bash
pi -e ./extensions/todo-list.ts
```

Then ask the agent to track the work. It will list todos when starting or resuming, mark items in progress, and leave nothing open when it reports the work finished. Related changes can be sent as one ordered `batch` of up to 100 operations; the whole batch rolls back if any operation fails.

`list` returns up to 100 open items and counts the completed ones in its header, matching the widget and the post-compaction summary. Use its zero-based `offset` and optional `limit` to continue through larger lists.

`clear_completed` returns a one-time receipt with every removed item's ID, full text, and parent ID when nested, ordered by ID. This also applies inside a successful batch. Receipts are not paginated or truncated; ordinary listing and context still omit completed items.

`/todos` shows the first page of open items and `/todos all` adds the completed ones with their text, up to 100 rows, since a human reading the terminal pays no tokens for them. `list` no longer returns completed items, so pass an id along from `/todos all` when you want one reopened and the agent no longer has it in context. `/todos toggle`, `/todos show`, and `/todos hide` control the widget. The widget starts hidden, and the footer status reports active and pending counts. Set `PI_TODO_WIDGET=show` to start it visible instead.

## Caching

The tool definition and system-prompt guidance are static. Mutations return only the change and status counts. Initial windows and ordinary requests add no todo context. After compaction, the extension injects one bounded active/pending summary for the retry or next request; inside a native window it queues the summary as soon as a later compaction replaces the window marker. At a native boundary, it injects the boundary-time snapshot immediately after Pi's marker and reuses that exact message for the rest of the window. Later mutations therefore cannot stale the provider-cacheable prefix.

## State behavior

Successful mutations persist as a compact operation log in tool-result `details`, while compaction context stays bounded and does not duplicate state. Resume and tree navigation replay those mutations on the active branch, using legacy version 1 and 2 snapshots when present. Native context-window snapshots are rebuilt from entries before their matching boundary, including an empty list that has prior todo history. If restore encounters corrupt history, it warns, preserves the contiguous valid state, and writes one recovery checkpoint on the next successful `todo_list` call. This keeps session history linear without an extra database or project file. A new session starts with an empty list.

Do not reopen a version 0.3 or later session with an older extension release; older versions do not understand mutation logs.

## Development

```bash
npm ci
npm run check
pi -e ./extensions/todo-list.ts --list-models
```
