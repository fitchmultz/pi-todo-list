# Pi Todo List

Keep track of a multi-step task while you work with [Pi](https://github.com/earendil-works/pi). This extension gives your agent a nested todo list that stays with the session, so you can see what is active, paused, or still to do when you return.

![A request flows into a nested todo list in Pi. You can view it with /todos; changes are saved in Pi's session journal and restored when you resume, fork, or compact the session.](.github/readme/session-todos.png)

*Pi updates the list, you check it with `/todos`, and the session journal carries it forward.*

## Install and start

Requires **Pi 1.0.0 or later** (official releases or the maintained fork) and **Node.js 24 or later**.

```bash
pi install git:github.com/fitchmultz/pi-todo-list
pi
```

Ask Pi to use the list:

> Track this change with todos: investigate the bug, implement a fix, and verify it.

Type `/todos` to see the open work or `/todos show` to keep a small progress widget visible. See [terminal controls](#check-progress) below or the [tool reference](docs/reference.md) for more detail. The current 0.10.3 release is available through Git/GitHub only.

## What you get

- **A plan you can follow.** Tasks have pending, in-progress, paused, and completed states; subtasks sit under their parent task.
- **Short titles with details nearby.** Attach a URL or note/file path for a plan, logs, or evidence. The list shows `[details]`; an item lookup reveals the link.
- **Work that survives a long session.** Todos restore when you resume, fork, navigate the session tree, or compact context, including a rollover that discards all previous provider context.
- **Several changes together.** The agent can create, update, move, or change the state of tasks in a single batch of up to 100 operations. Invalid operations roll back the whole batch.

The agent uses the `todo_list` tool. Its guidance asks it to add or start work before doing it, pause interrupted work, and mark items complete only after observing successful verification.

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

Todos live in **Pi's native session journal**, on the selected branch. A new session starts with an empty list; resuming a saved session brings its list back. The extension also saves mutations made through nested tool calls such as codemode.

Completing or removing a parent affects all its descendants. Reopening it returns the whole subtree to pending. Starting, pausing, or reopening a child also reopens any completed ancestors. Completed work stays in the journal and can be looked up until you remove it or clear completed items; nothing is automatically deleted.

**Keep readers up to date:** sessions written by 0.10.3 require this extension at 0.10.3 or later. An older extension can stop at an unfamiliar journal entry and save an incomplete list. See [journal compatibility](docs/reference.md#journal-compatibility).

**If you see a corruption or persistence warning:** inspect the list before retrying a change. A successful recovery read saves only the valid prefix, so missing tasks and ID gaps still need manual reconciliation. Follow the [recovery guide](docs/reference.md#manual-reconciliation-after-a-corruption-warning) before creating new work.

## Try it locally or contribute

From a checkout, load it for one invocation:

```bash
pi -e ./extensions/todo-list.ts
```

Or install a local checkout with `pi install /absolute/path/to/pi-todo-list`.

- [Tool and persistence reference](docs/reference.md) — actions, batches, detail links, recovery, and journal formats
- [Development guide](docs/development.md) — setup, tests, compatibility checks, and diagram rendering
- [Changelog](CHANGELOG.md) — release history
- [Issues](https://github.com/fitchmultz/pi-todo-list/issues) — bugs and feature requests

## License

[MIT](LICENSE) · Copyright © 2026 Mitch Fultz.
