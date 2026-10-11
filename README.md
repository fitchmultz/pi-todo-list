# Pi Todo List

Pi Todo List gives your [Pi](https://github.com/earendil-works/pi) agent a nested todo list for multi-step work. You can check what's left with `/todos` and return to the same list when you resume a session.

![A request flows into a nested todo list in Pi. You can view it with /todos; changes are saved in Pi's session journal and restored when you resume, fork, or compact the session.](.github/readme/session-todos.png)

*Your todo list is saved in Pi's session journal and restored with the session.*

## Install and start

You'll need Pi 1.0.0 or later (official releases or the maintained fork) and Node.js 24 or later.

```bash
pi install git:github.com/fitchmultz/pi-todo-list
pi
```

Ask Pi to use the list:

> Track this change with todos: investigate the bug, implement a fix, and verify it.

Type `/todos` to see the open work or `/todos show` to keep a small progress widget visible. The [terminal controls](#check-progress) are below; the [tool reference](docs/reference.md) covers batches and other details.

## Working with the list

Ask Pi to break a task into subtasks. Each item can be pending, in progress, paused, or completed. Pi updates them through its `todo_list` tool as it works.

You can attach a URL or note/file path to an item without putting all the detail in its title. The list shows `[details]`; `/todos <id>` reveals the link. The extension stores the link without opening it.

## Check progress

These commands run in Pi's interactive terminal:

| Command | What you see |
| --- | --- |
| `/todos` | The first page of open items, plus status counts |
| `/todos 3` | Item #3's status, parent, and detail link, even if completed |
| `/todos all` | Open and completed items, up to 100 rows |
| `/todos show` | A widget showing up to eight open items |
| `/todos hide` | Hide the widget |
| `/todos toggle` | Switch the widget on or off |

The widget starts hidden. The footer shows active and pending counts, plus paused work when present. To start each Pi process with the widget visible:

```bash
PI_TODO_WIDGET=show pi
```

To change an item, tell the agent what you want:

> Pause item #3 until the API credentials are available.
>
> Reopen item #2 and its subtasks.

The agent's ordinary list omits completed items. Use `/todos all` to find an old item's ID and include that ID in your request.

## How the list stays with your work

Todos live in Pi's native session journal, on the selected branch. A new session starts with an empty list. Resuming a saved session brings its list back, and forking or navigating the session tree follows the branch you select. The list also survives context compaction, even when Pi discards all previous provider context.

Completing or removing a parent affects all its descendants. Reopening it returns the whole subtree to pending. Starting, pausing, or reopening a child also reopens any completed ancestors. Completed work stays in the journal and can be looked up until you remove it or clear completed items; nothing is automatically deleted.

Use extension version 0.10.3 or later for sessions written by 0.10.3. Older versions can stop at an unfamiliar journal entry and save an incomplete list. See [journal compatibility](docs/reference.md#journal-compatibility) before downgrading.

If you see a corruption or persistence warning, inspect the list before retrying a change. A successful recovery read saves only the valid prefix of the history. You'll still need to reconcile missing tasks and ID gaps using the [recovery guide](docs/reference.md#manual-reconciliation-after-a-corruption-warning) before creating new work.

## Try it locally or contribute

From a checkout, load it for one invocation:

```bash
pi -e ./extensions/todo-list.ts
```

Or install a local checkout with `pi install /absolute/path/to/pi-todo-list`.

- [Tool and persistence reference](docs/reference.md): actions, batches, recovery, and journal formats
- [Development guide](docs/development.md): setup, tests, and compatibility checks
- [Changelog](CHANGELOG.md): release history
- [Issues](https://github.com/fitchmultz/pi-todo-list/issues): bugs and feature requests

## License

[MIT](LICENSE) · Copyright © 2026 Mitch Fultz.
