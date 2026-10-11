# Tool and persistence reference

[Back to the README](../README.md)

## Agent workflow

The extension registers the agent-callable `todo_list` tool with pending, in-progress, paused, and completed states. Actions are `list`, `add`, `update`, `move`, `start`, `pause`, `complete`, `reopen`, `remove`, `clear_completed`, and `batch`.

Its prompt guidance asks the agent to list todos when starting or resuming and add or start items before their first work call in the same tool batch. Updates can accompany other tool calls when their status is already known, but completion must wait until the agent has observed successful verification from an earlier batch. After the final check, a separate completion call is appropriate if no other work remains; failed or unverified work stays open. It should leave nothing open when it reports the work finished. Related changes can be sent as one ordered `batch` of up to 100 operations; the whole batch rolls back if any operation fails validation or application. This does not guarantee atomic disk persistence; see [state behavior](#state-behavior).

## Listing and cleanup

`list` without an `id` returns up to 100 open items and counts the completed ones in its header, matching the widget and the post-compaction summary. Use its zero-based `offset` and optional `limit` (1–100) to continue through larger lists.

```json
{ "action": "list", "offset": 100, "limit": 50 }
```

`list` with an `id` retrieves one item's status, parent, and detail link, including completed items:

```json
{ "action": "list", "id": 3 }
```

`clear_completed` returns a one-time receipt with every removed item's ID, full text, detail link when present, and parent ID when nested, ordered by ID. This also applies inside a successful batch. Receipts are not paginated or truncated; ordinary listing and context still omit completed items.

`/todos <id>` shows one item's status, parent, and detail link, including completed items. `/todos` shows the first page of open items and `/todos all` adds the completed ones with their text, up to 100 rows, since a human reading the terminal pays no tokens for them. The agent's default list omits completed items, so pass an ID along from `/todos all` when you want one reopened and the agent no longer has it in context. `/todos toggle`, `/todos show`, and `/todos hide` control the widget. The widget starts hidden, shows up to eight open rows, and the footer status reports active, pending, and nonzero paused counts. Set `PI_TODO_WIDGET=show` to start it visible instead; an interactive toggle lasts only for that process. UI-only work is skipped in headless modes.

## Create and start work together

Set `status` on `add` to `pending`, `in_progress`, `paused`, or `completed`. Omit it to create pending work. This works for standalone additions and additions inside a batch.

Within a batch, an `add` can declare a `ref` label. Later operations can use that label in `id` or `parentId` without guessing the generated ID:

```json
{
  "action": "batch",
  "operations": [
    { "action": "add", "text": "Ship change", "status": "in_progress", "ref": "ship" },
    { "action": "add", "text": "Verify release", "parentId": "ship", "ref": "verify" },
    { "action": "update", "id": "verify", "link": "notes/release.md" }
  ]
}
```

An `add` may also set a numeric `id` at least the next available ID, for manually recreating a known missing item while skipping deliberately deleted IDs. Omit `id` for normal sequential allocation. Skipping forward permanently leaves the gap unused: later additions cannot use IDs below the new next ID, even if those items were removed. Add IDs cannot be batch ref labels; its `parentId` and later operations can still use refs. IDs must be positive safe integers below `Number.MAX_SAFE_INTEGER`, leaving a safe next ID. All validation and batch rollback rules still apply.

Labels are case-sensitive, 1–64 characters, and cannot contain control characters or leading/trailing whitespace. They are unique within the batch and refer only to earlier additions in that batch. A duplicate, unknown, forward, or non-add reference fails the entire batch without consuming IDs. Returned IDs remain numbers; use those in later calls. Persisted mutation details contain resolved numeric IDs, so restoring the list does not depend on temporary labels.

## Keep current work readable

Use a short action title such as “Verify release”, not a title packed with commit hashes or test output. Set `link` on `add` or `update` to a URL or note/file path for those details. An update may change the title, the link, or both; `link: null` clears the link. Omitted fields stay unchanged. Other actions ignore `link: null`.

Lists, the widget, and recovery summaries show `[details]` rather than the full link. Call `todo_list` with `action: "list"` and `id`, or use `/todos <id>`, to retrieve it. The extension stores the reference without reading or opening it. Relative file paths are relative to the session's working directory; prefer absolute paths across checkouts and worktrees. A notes tool may store notes under a different root.

When using notes, maintain one brief current summary: goal, current state, next step, blockers, and evidence links. Replace outdated state instead of appending a diary. Update todo titles and statuses when the plan changes, and remove work that no longer applies. Nothing is automatically deleted.

`pause` keeps an item open in a distinct paused state, shown as `⏸` rather than pending's `-` (or `○` in the widget). Use `start` to resume it. `reopen` returns an item and its descendants to pending; completion and removal also include descendants. Starting, pausing, or reopening a nested item reopens completed ancestors. `move` changes an item's parent; omit `parentId` to make it top-level. Adding or moving under a completed parent is rejected, as is moving an item under itself or a descendant.

## Caching

The tool definition and system-prompt guidance are static. Mutations return only the change and status counts. Ordinary requests add no todo context. After compaction, including retain-none rollover, the extension injects one recovery summary with at most five active, five pending, and five paused titles for the retry or next request, including automatic compaction between tool turns. The snapshot is labeled as a recovery snapshot: later tool results carry current state without rewriting the provider-cacheable prefix.

Ordinary requests cache the latest compaction (including its absence), inspecting only new ancestry entries. A new retain-none boundary replays the selected branch once to freeze its snapshot. Session/tree changes reset this lookup; no independent state journal or arbitrary history cap is introduced.

Retain-none recovery reaches the first continued request in the same run. It is a request-only snapshot of the list at that boundary, not another journal entry, and stays byte-stable across later mutations and reloads.

Recovery append-failure metadata is indexed lazily once per runtime/session when a format 6 checkpoint needs classification, and updated for the extension's own failures. Ordinary tools, requests, and widget updates do not scan all session entries.

## State behavior

Successful mutations persist as compact `todo-list-state` custom entries in the native session journal, independently of how the tool was called. This includes nested calls from codemode and calls committed before a script fails. Ordinary reads add no custom entry. Tool-result `details` remain available for callers and older histories; replay uses each custom commit once and ignores only its matching transport result within that assistant turn. Tool-call IDs may be empty or reused in later turns. Resume and tree navigation replay only the selected branch, using legacy snapshots and recovery checkpoints when present.

Commit data contains the tool-call ID and format 8 mutation details, a format 6 successful recovery checkpoint, or a format 9 pending-recovery snapshot after a partial checkpoint write failure. Mutation logs store the exact assigned numeric ID of every addition (including default allocation), resolved references, and initial statuses. Formats 1–7 remain readable with their original semantics, including implicit add allocation in formats 3, 5, and 7; format 7 still rejects add IDs. Older format 3 pause operations retain their original pending state; old snapshots cannot distinguish paused work from other pending items. Legacy context-window snapshot replay remains supported by the extension; current hosts use public compaction rather than native windows. Old-format journals must follow the host's conversion procedure rather than being resumed directly.

If restore encounters corrupt history, it warns and preserves the contiguous valid prefix. All mutations, including batches, are rejected before changing state, consuming IDs, or appending a commit. Only a successful `todo_list` call with `action: "list"` writes a recovery checkpoint of that unchanged prefix; failed reads do not unblock mutations. The read warns that the checkpoint is incomplete and manual reconciliation is required. Original history is preserved. Validated committed mutations also survive restoration if another extension subsequently marks their tool result as an error; failed calls without a commit leave state unchanged.

A rejection before native append leaves state and IDs unchanged. If the native session retains an in-memory entry before its disk write fails, Todo follows that current branch and rethrows the original persistence error. When that entry is a failed recovery read's checkpoint, Todo best-effort appends a validated format 9 snapshot of the same prefix so reload and tree navigation still require a successful warned list read. An error writing that pending snapshot never replaces the original error; preappend rejections add no marker. A validated pending snapshot also identifies its exact parent checkpoint as failed when tree navigation selects that parent without its descendants. Only failure metadata is consulted across branches; task state still comes exclusively from the selected branch. A later successful recovery read writes a different format 6 checkpoint and clears the pending boundary.

This does not guarantee atomic disk persistence; inspect the current list before retrying a failed mutation, since the native branch may already contain it. This keeps session history linear without an extra database or project file. A new session starts with an empty list. Older nested calls whose results were never journaled require manual recovery from available evidence; the extension does not guess state from script text or lossy call metadata.

## Manual reconciliation after a corruption warning

A successful recovery read permits subsequent mutations; it does **not** certify that missing history has been recovered. The displayed next ID comes only from the valid prefix and may already belong to an omitted task. Before creating new work, compare against trusted task records, reconcile missing items and later changes through ordinary add/update/move/lifecycle operations, and preserve deliberately deleted IDs. Use explicit add IDs in increasing order to skip known gaps; batch refs use the actual assigned IDs. Do not guess missing state or infer a safe allocator from the largest visible ID. This is manual missing-only creation, not an import or reset API; IDs below the current next ID cannot be restored with add. Previously saved incomplete checkpoints cannot be detected or repaired automatically.

## Journal compatibility

Do not open sessions written by this version with an older extension: format 8 mutations and format 9 pending-recovery snapshots require 0.10.3 or later. Older readers can stop at an unfamiliar entry and checkpoint an incomplete list; releases before 0.10.2 also cannot replay custom commits, including nested mutations and recovery checkpoints. Existing journals remain readable by this version. Version 0.10.3 is distributed through Git/GitHub only, without an npm publication.

For a fixed installation of that journal-format baseline:

```bash
pi install git:github.com/fitchmultz/pi-todo-list@v0.10.3
```

A tag-pinned installation stays at that tag. The [README's unpinned source](../README.md#install-and-start) follows the repository's default branch when updated.
