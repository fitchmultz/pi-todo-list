import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import todoListExtension from "../extensions/todo-list.ts";
import {
  addTodo,
  applyTodoBatch,
  clearCompleted,
  cloneState,
  completeTodo,
  emptyState,
  formatTodoContext,
  formatTodoPage,
  moveTodo,
  orderedTodos,
  pauseTodo,
  removeTodo,
  reopenTodo,
  startTodo,
  todoCounts,
  TODO_TEXT_LIMIT,
  type TodoState,
  updateTodo,
} from "../extensions/todo-state.ts";

test("nested todo lifecycle", () => {
  const state = emptyState();
  assert.throws(() => addTodo(state, "  "), /cannot be empty/);
  assert.equal(state.nextId, 1);
  const parent = addTodo(state, "Ship extension");
  const child = addTodo(state, "Run checks", parent.id);
  updateTodo(state, child.id, "Run validation");

  startTodo(state, child.id);
  assert.equal(formatTodoPage(state), "TODO: 1 active, 1 pending, 0 completed\n- #1 Ship extension\n  > #2 Run validation");
  pauseTodo(state, child.id);
  assert.equal(completeTodo(state, parent.id), 2);
  assert.equal(formatTodoContext(state), "TODO: 0 active, 0 pending, 2 completed");
  assert.equal(reopenTodo(state, child.id), 1);
  assert.equal(parent.status, "pending");
  assert.equal(reopenTodo(state, parent.id), 2);

  const laterParent = addTodo(state, "Later parent");
  moveTodo(state, parent.id, laterParent.id);
  assert.equal(completeTodo(state, laterParent.id), 3);
  assert.equal(reopenTodo(state, laterParent.id), 3);
  moveTodo(state, parent.id);
  removeTodo(state, laterParent.id);

  moveTodo(state, child.id);
  assert.throws(() => moveTodo(state, parent.id, parent.id), /itself or its descendant/);
  assert.equal(removeTodo(state, parent.id), 1);
  completeTodo(state, child.id);
  assert.equal(clearCompleted(state), 1);
  assert.deepEqual(state.items, []);
});

test("batch mutations are ordered and atomic", () => {
  const state = emptyState();
  assert.deepEqual(
    applyTodoBatch(state, [
      { action: "add", text: "First" },
      { action: "add", text: "Second", parentId: 1 },
      { action: "update", id: 2, text: "Updated second" },
      { action: "start", id: 2 },
    ]),
    ["Added #1: First", "Added #2: Second", "Updated #2: Updated second", "Started #2: Updated second"],
  );
  assert.equal(formatTodoPage(state), "TODO: 1 active, 1 pending, 0 completed\n- #1 First\n  > #2 Updated second");

  const before = cloneState(state);
  assert.throws(
    () => applyTodoBatch(state, [{ action: "pause", id: 2 }, { action: "remove", id: 999 }]),
    /not found/,
  );
  assert.deepEqual(state, before);
});

test("todo text is bounded and safe to render", () => {
  const state = emptyState();
  const todo = addTodo(state, "\u001b[31mred\u001b[0m\nline");
  assert.equal(todo.text, "[31mred [0m line");
  assert.throws(() => addTodo(state, "x".repeat(TODO_TEXT_LIMIT + 1)), /cannot exceed 240 characters/);
  assert.throws(
    () => cloneState({ nextId: 2, items: [{ id: 1, text: "x".repeat(TODO_TEXT_LIMIT + 1), status: "pending" }] }),
    /cannot exceed 240 characters/,
  );
});

test("legacy done snapshots migrate to statuses", () => {
  const migrated = cloneState({
    nextId: 1,
    items: [
      { id: 1, text: "Done", done: true },
      { id: 2, text: "Open", done: false },
    ],
  } as unknown as TodoState);
  assert.deepEqual(
    migrated.items.map((item) => item.status),
    ["completed", "pending"],
  );
  assert.equal(migrated.nextId, 3);
});

test("exhausted todo IDs fail without mutating state", () => {
  const exhausted = cloneState({ nextId: Number.MAX_SAFE_INTEGER, items: [] });
  assert.throws(() => addTodo(exhausted, "Never added"), /id limit reached/);
  assert.deepEqual(exhausted, { nextId: Number.MAX_SAFE_INTEGER, items: [] });
});

test("malformed snapshots and ancestry fail without partial mutations", () => {
  assert.throws(() => cloneState(undefined as never), /Invalid todo state/);
  assert.throws(
    () => cloneState({ nextId: 2, items: [{ id: 1, text: "Duplicate", status: "pending" }, { id: 1, text: "Again", status: "pending" }] }),
    /duplicate todo id/,
  );
  assert.throws(
    () => cloneState({ nextId: 2, items: [{ id: 1, text: "Orphan", status: "pending", parentId: 99 }] }),
    /missing parent/,
  );
  assert.throws(
    () => cloneState({ nextId: 2, items: [{ id: 1, text: "Cycle", status: "pending", parentId: 1 }] }),
    /cycle/,
  );
  assert.throws(
    () => cloneState({ nextId: 2, items: [{ id: 1, text: "Bad status", status: "paused" as never }] }),
    /Invalid status/,
  );
  assert.throws(
    () => cloneState({ nextId: 3, items: [{ id: 1, text: "Done parent", status: "completed" }, { id: 2, text: "Open child", status: "pending", parentId: 1 }] }),
    /open under completed parent/,
  );

  const orphan = { nextId: 2, items: [{ id: 1, text: "Orphan", status: "completed" as const, parentId: 99 }] };
  assert.throws(() => startTodo(orphan, 1), /missing parent/);
  assert.equal(orphan.items[0]!.status, "completed");

  const cycle = { nextId: 2, items: [{ id: 1, text: "Cycle", status: "completed" as const, parentId: 1 }] };
  assert.throws(() => pauseTodo(cycle, 1), /cycle/);
  assert.equal(cycle.items[0]!.status, "completed");
});

test("deep tree operations are iterative", () => {
  const size = 6_000;
  const state: TodoState = {
    nextId: size + 1,
    items: Array.from({ length: size }, (_, index) => ({
      id: index + 1,
      text: `Todo ${index + 1}`,
      status: "pending" as const,
      ...(index === 0 ? {} : { parentId: index }),
    })),
  };

  const ordered = orderedTodos(state);
  assert.equal(ordered.length, size);
  assert.equal(ordered.at(-1)?.depth, size - 1);
  const deepPage = formatTodoPage(state, 5_900);
  assert.ok(deepPage.length < 30_000);
  assert.match(deepPage, /… - #5901 Todo 5901/);
  assert.equal(completeTodo(state, 1), size);
  assert.deepEqual(todoCounts(state), { pending: 0, inProgress: 0, completed: size });
  startTodo(state, size);
  assert.deepEqual(todoCounts(state), { pending: size - 1, inProgress: 1, completed: 0 });
});

test("wide tree operations avoid argument-count limits", () => {
  const size = 150_000;
  const state: TodoState = {
    nextId: size + 1,
    items: Array.from({ length: size }, (_, index) => ({
      id: index + 1,
      text: `Todo ${index + 1}`,
      status: "pending",
      ...(index === 0 ? {} : { parentId: 1 }),
    })),
  };

  assert.equal(completeTodo(state, 1), size);
});

test("batch errors identify the operation and preserve state", () => {
  const state = emptyState();
  assert.throws(
    () => applyTodoBatch(state, [{ action: "add", text: "First" }, { action: "missing" as never }]),
    /Batch operation 2 \(missing\).*No changes applied/,
  );
  assert.deepEqual(state, emptyState());
});

test("list pages and compaction context stay bounded", () => {
  const text = "x".repeat(240);
  const state: TodoState = {
    nextId: 131,
    items: Array.from({ length: 130 }, (_, index) => ({
      id: index + 1,
      text,
      status: index < 30 ? "in_progress" : "pending",
    })),
  };

  const firstPage = formatTodoPage(state);
  assert.match(firstPage, /Showing 1-100 of 130/);
  assert.match(firstPage, /> #1 /);
  assert.doesNotMatch(firstPage, /- #101 /);
  const lastPage = formatTodoPage(state, 100, 30);
  assert.match(lastPage, /Showing 101-130 of 130/);
  assert.match(lastPage, /- #130 /);

  const context = formatTodoContext(state);
  assert.ok(context.length < 10_000);
  assert.match(context, /5 active and 75 pending not shown/);
  assert.doesNotMatch(context, /> #26 /);
  assert.doesNotMatch(context, /- #56 /);
});

function createExtensionHarness() {
  type Handler = (...args: any[]) => any;
  type Tool = { execute: (...args: any[]) => Promise<unknown> };
  type Command = { handler: (args: string, ctx: any) => Promise<void> };
  const handlers = new Map<string, Handler>();
  const sent: Array<{
    message: { customType?: string; content: string; display?: boolean; details?: unknown };
    options?: { deliverAs?: string; triggerTurn?: boolean };
  }> = [];
  let branch: Array<Record<string, unknown>> = [];
  let hasUI = true;
  const widgetUpdates: Array<string[] | undefined> = [];
  const statusUpdates: Array<string | undefined> = [];
  const notifications: string[] = [];
  const ctx = {
    get hasUI() { return hasUI; },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget(_key: string, content: string[] | undefined) { widgetUpdates.push(content); },
      setStatus(_key: string, text: string | undefined) { statusUpdates.push(text); },
      notify(message: string) { notifications.push(message); },
    },
    sessionManager: { getBranch: () => branch },
  };
  let tool: Tool | undefined;
  let command: Command | undefined;

  const api = {
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    registerTool: (registered: Tool) => { tool = registered; },
    registerCommand: (_name: string, registered: Command) => { command = registered; },
    sendMessage: (message, options) => {
      sent.push({ message: message as (typeof sent)[number]["message"], options });
    },
  } satisfies Pick<ExtensionAPI, "on" | "registerTool" | "registerCommand" | "sendMessage">;
  todoListExtension(api as unknown as ExtensionAPI);

  const emit = (event: string, payload: Record<string, unknown>) => {
    const result = handlers.get(event)?.(payload, ctx);
    const message = (result as { message?: Record<string, unknown> } | undefined)?.message;
    if (event === "before_agent_start" && message) branch.push({ type: "custom_message", ...message });
    return result;
  };

  return {
    sent,
    widgetUpdates,
    statusUpdates,
    notifications,
    branch: () => structuredClone(branch),
    setHasUI(value: boolean) { hasUI = value; },
    async runCommand(args: string) {
      assert.ok(command);
      await command.handler(args, ctx);
    },
    switchBranch(entries: Array<Record<string, unknown>>) {
      branch = structuredClone(entries);
      return emit("session_tree", {});
    },
    compact(willRetry: boolean, id: string) {
      const compactionEntry = { type: "compaction", id };
      branch.push(compactionEntry);
      const sentBefore = sent.length;
      const result = emit("session_compact", { willRetry, compactionEntry });
      for (const queued of sent.slice(sentBefore)) branch.push({ type: "custom_message", ...queued.message });
      return result;
    },
    async execute(params: Record<string, unknown>) {
      assert.ok(tool);
      const result = await tool.execute("test-call", params, undefined, undefined, ctx);
      branch.push({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo_list",
          details: (result as { details?: unknown }).details,
        },
      });
      return result;
    },
    emit,
  };
}

test("UI updates and commands honor availability", async () => {
  const interactive = createExtensionHarness();
  await interactive.execute({ action: "add", text: "Visible todo" });
  assert.match(interactive.statusUpdates.at(-1) ?? "", /todo 0 active · 1 pending/);
  assert.match(interactive.widgetUpdates.at(-1)?.join("\n") ?? "", /#1 Visible todo/);
  await interactive.runCommand("hide");
  assert.equal(interactive.widgetUpdates.at(-1), undefined);
  assert.equal(interactive.notifications.at(-1), "Todo widget hidden");
  await interactive.runCommand("gibberish");
  assert.equal(interactive.notifications.at(-1), "Usage: /todos [toggle|show|hide]");

  const headless = createExtensionHarness();
  headless.setHasUI(false);
  await headless.execute({ action: "add", text: "Headless todo" });
  await headless.runCommand("show");
  assert.equal(headless.widgetUpdates.length, 0);
  assert.equal(headless.statusUpdates.length, 0);
  assert.equal(headless.notifications.length, 0);
});

test("compact mutation logs restore branches and skip malformed snapshots", async () => {
  const harness = createExtensionHarness();
  const added = (await harness.execute({ action: "add", text: "Persist me" })) as {
    content: Array<{ text: string }>;
    details?: { version: number; operations?: unknown[]; state?: unknown };
  };
  assert.equal(added.details?.version, 3);
  assert.equal(added.details?.operations?.length, 1);
  assert.equal(added.details?.state, undefined);

  const listed = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }>; details?: unknown };
  assert.equal(listed.details, undefined);
  assert.match(listed.content[0]!.text, /#1 Persist me/);
  const savedBranch = harness.branch();

  harness.switchBranch([]);
  const empty = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.equal(empty.content[0]!.text, "No todos");
  harness.switchBranch(savedBranch);
  const restored = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.match(restored.content[0]!.text, /#1 Persist me/);

  const legacyState = { nextId: 2, items: [{ id: 1, text: "Legacy", status: "pending" }] };
  harness.switchBranch([
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 1, action: "add", state: legacyState } } },
  ]);
  const versionOne = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.match(versionOne.content[0]!.text, /#1 Legacy/);

  harness.switchBranch([
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 2, action: "add", state: legacyState } } },
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 2, action: "add", state: null } } },
  ]);
  const legacy = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.match(legacy.content[0]!.text, /#1 Legacy/);
});

test("restore stops safely at a corrupt mutation log", async () => {
  const harness = createExtensionHarness();
  harness.switchBranch([
    {
      type: "custom_message",
      customType: "todo-list-context",
      details: { version: 3, state: { nextId: 2, items: [{ id: 1, text: "Checkpoint", status: "pending" }] } },
    },
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 3, operations: [{ action: "add", text: "Before corrupt log" }] } } },
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 3, operations: [{ action: "missing" }] } } },
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 3, operations: [{ action: "add", text: "After corrupt log" }] } } },
  ]);

  const restored = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.match(restored.content[0]!.text, /#1 Checkpoint/);
  assert.match(restored.content[0]!.text, /#2 Before corrupt log/);
  assert.doesNotMatch(restored.content[0]!.text, /After corrupt log/);
});

test("malformed compaction context is replaced", async () => {
  const harness = createExtensionHarness();
  harness.switchBranch([
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 3, operations: [{ action: "add", text: "Persist me" }] } } },
    { type: "compaction", id: "checkpoint" },
    { type: "custom_message", customType: "todo-list-context", details: { version: 3, state: null } },
  ]);

  assert.ok((harness.emit("before_agent_start", {}) as { message?: unknown } | undefined)?.message);
});

test("compaction context stays bounded without duplicating state", async () => {
  const harness = createExtensionHarness();
  await harness.execute({ action: "add", text: "Before checkpoint" });
  harness.compact(false, "checkpoint");
  const context = (await harness.emit("before_agent_start", {})) as { message?: { details?: unknown } } | undefined;
  assert.ok(context?.message);
  assert.equal(context.message.details, undefined);
  await harness.execute({ action: "add", text: "After checkpoint" });
  const branch = harness.branch();

  harness.switchBranch([]);
  harness.switchBranch(branch);
  const restored = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.match(restored.content[0]!.text, /#1 Before checkpoint/);
  assert.match(restored.content[0]!.text, /#2 After checkpoint/);
});

test("ordinary compaction injects live state only on its active branch", async () => {
  const empty = createExtensionHarness();
  empty.compact(false, "compaction-empty");
  assert.equal(empty.emit("before_agent_start", {}), undefined);

  const harness = createExtensionHarness();
  await harness.execute({ action: "add", text: "Ship extension" });
  const branchBeforeCompaction = harness.branch();
  harness.compact(false, "compaction-a");
  const compactedBranch = harness.branch();

  harness.switchBranch(branchBeforeCompaction);
  assert.equal(harness.emit("before_agent_start", {}), undefined);

  harness.switchBranch(compactedBranch);
  await harness.execute({ action: "complete", id: 1 });
  assert.equal(harness.sent.length, 0);
  const result = (await harness.emit("before_agent_start", {})) as { message?: { content?: string } } | undefined;
  assert.equal(
    result?.message?.content,
    "[TODO LIST - state after compaction]\nTODO: 0 active, 0 pending, 1 completed\nKeep this list current with todo_list.",
  );
  assert.equal(await harness.emit("before_agent_start", {}), undefined);
});

test("compaction refreshes an emptied list", async () => {
  const harness = createExtensionHarness();
  await harness.execute({ action: "add", text: "Temporary" });
  await harness.execute({ action: "remove", id: 1 });
  harness.compact(false, "compaction-empty-history");

  const result = (await harness.emit("before_agent_start", {})) as { message?: { content?: string } } | undefined;
  assert.equal(result?.message?.content, "[TODO LIST - state after compaction]\nNo todos\nKeep this list current with todo_list.");
});

test("overflow compaction immediately steers the current todo state", async () => {
  const empty = createExtensionHarness();
  empty.compact(true, "compaction-empty-overflow");
  assert.equal(empty.sent.length, 0);

  const harness = createExtensionHarness();
  await harness.execute({ action: "add", text: "Retry turn" });
  harness.compact(true, "compaction-overflow");

  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0]!.message.content, /TODO: 0 active, 1 pending, 0 completed/);
  assert.deepEqual(harness.sent[0]!.options, { deliverAs: "steer", triggerTurn: false });
  // Overflow retries use agent.continue() in Pi 0.84.1; guard against duplicate context if that lifecycle changes.
  assert.equal(harness.emit("before_agent_start", {}), undefined);
});
