# Development

[Back to the README](../README.md)

## Set up and check

Requires Node.js 24 or later. From the repository root:

```bash
npm ci --ignore-scripts
npm run check:compat
pi -e ./extensions/todo-list.ts --list-models
```

For an interactive one-off run:

```bash
pi -e ./extensions/todo-list.ts
```

For a persistent local installation:

```bash
pi install /absolute/path/to/pi-todo-list
```

The development Pi cohort is official `1.0.0` (all eight Pi packages and host TypeBox `1.3.27`); the extension's development schema dependency is TypeBox `1.3.34`. Host dependencies and runtime peers are unchanged. No fork-only API is required.

`check:compat` runs the state suite, native SDK lifecycle tests, typechecking, and a pack dry-run against the installed host. Native tests script only model output: Pi loads the extension, registers `todo_list` and `/todos`, executes and journals tools, navigates branches, resumes, and compacts. The retain-none test checks recovery after the public compaction boundary discards all prior provider context, without requiring retired native-window APIs. Use a disposable HOME/agent directory and no provider credentials.

## CI compatibility

CI uses the shared [Pi compatibility automation](https://github.com/fitchmultz/.github) on Node 24 to resolve the latest stable official Pi version and maintained fork SHA once per run, then qualify those exact targets. The supported development Pi floor is qualified separately, not used as the latest official target. Each qualification runs `check:compat`, including a pack dry-run; a fresh production-only checkout must also load through the selected host's CLI without extension errors.

## README diagram

The editable source is [`.github/readme/session-todos.svg`](../.github/readme/session-todos.svg); the README embeds [the PNG export](../.github/readme/session-todos.png). It shows the request, nested list, interactive view, native session journal, and recovery path. The behavior comes from `extensions/todo-list.ts` and `extensions/todo-state.ts`, with native lifecycle coverage in `tests/native-runtime.test.ts`.

To render the canonical source with librsvg:

```bash
rsvg-convert --zoom 2 .github/readme/session-todos.svg -o .github/readme/session-todos.png
```

Inspect the full PNG and an 880px-wide preview after any diagram change. The art uses a solid 1600px-wide dark canvas, glass cards, Inter and JetBrains Mono font stacks, and blue/violet/green accents. Diagram assets live under `.github/` and are excluded by the package's published file list.
