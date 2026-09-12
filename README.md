# @fitchmultz/pi-todo-list

A small native Pi extension that gives agents a persistent, nested todo list.

- Agent-callable `todo_list` tool with pending, in-progress, paused, and completed states
- Short action titles with optional links to detailed notes, plans, or evidence
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

`list` without an `id` returns up to 100 open items and counts the completed ones in its header, matching the widget and the post-compaction summary. Use its zero-based `offset` and optional `limit` to continue through larger lists.

`clear_completed` returns a one-time receipt with every removed item's ID, full text, detail link when present, and parent ID when nested, ordered by ID. This also applies inside a successful batch. Receipts are not paginated or truncated; ordinary listing and context still omit completed items.

`/todos <id>` shows one item's status, parent, and detail link, including completed items. `/todos` shows the first page of open items and `/todos all` adds the completed ones with their text, up to 100 rows, since a human reading the terminal pays no tokens for them. The agent's default list omits completed items, so pass an id along from `/todos all` when you want one reopened and the agent no longer has it in context. `/todos toggle`, `/todos show`, and `/todos hide` control the widget. The widget starts hidden, and the footer status reports active, pending, and nonzero paused counts. Set `PI_TODO_WIDGET=show` to start it visible instead.

## Keep current work readable

Use a short action title such as “Verify release”, not a title packed with commit hashes or test output. Set `link` on `add` or `update` to a URL or note/file path for those details. An update may change the title, the link, or both; `link: null` clears the link. Omitted fields stay unchanged.

Lists, the widget, and recovery summaries show `[details]` rather than the full link. Call `todo_list` with `action: "list"` and `id`, or use `/todos <id>`, to retrieve it. The extension stores the reference without reading or opening it. Relative file paths are relative to the session's working directory; prefer absolute paths across checkouts and worktrees. A notes tool may store notes under a different root.

When using notes, maintain one brief current summary: goal, current state, next step, blockers, and evidence links. Replace outdated state instead of appending a diary. Update todo titles and statuses when the plan changes, and remove work that no longer applies. Nothing is automatically deleted.

`pause` keeps an item open in a distinct paused state, shown as `⏸` rather than pending's `-` (or `○` in the widget). Use `start` to resume it. `reopen` returns an item and its descendants to pending; completion still includes descendants. Starting, pausing, or reopening a nested item reopens completed ancestors.

## Caching

The tool definition and system-prompt guidance are static. Mutations return only the change and status counts. Initial windows and ordinary requests add no todo context. After compaction, the extension injects one recovery summary with at most five active, five pending, and five paused titles for the retry or next request; inside a native window it queues the summary as soon as a later compaction replaces the window marker. At a native boundary, it injects the boundary-time snapshot immediately after Pi's marker and reuses that exact message for the rest of the window. The snapshot is labeled as a recovery snapshot: later tool results carry current state without rewriting the provider-cacheable prefix.

## State behavior

Successful mutations persist as a compact operation log in tool-result `details`, while compaction context stays bounded and does not duplicate state. Resume and tree navigation replay those mutations on the active branch, using legacy snapshots and recovery checkpoints when present. Current entries use format 5 for mutations/reads and format 6 for recovery checkpoints. Older format 3 pause operations retain their original pending state; old snapshots cannot distinguish paused work from other pending items. Native context-window snapshots are rebuilt from entries before their matching boundary, including an empty list that has prior todo history. If restore encounters corrupt history, it warns, preserves the contiguous valid state, and writes one recovery checkpoint on the next successful `todo_list` call. This keeps session history linear without an extra database or project file. A new session starts with an empty list.

Do not open sessions written by this version with an older extension: older releases do not understand the new paused state and detail links. Existing sessions remain readable by this version.

## Development

```bash
npm ci
npm run check
pi -e ./extensions/todo-list.ts --list-models
```
