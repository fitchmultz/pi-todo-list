import assert from "node:assert/strict";
import test from "node:test";
import todoListExtension from "../extensions/todo-list.ts";
import {
  addTodo,
  applyTodoBatch,
  clearCompleted,
  cloneState,
  completeTodo,
  emptyState,
  formatTodoSnapshot,
  formatTodos,
  moveTodo,
  pauseTodo,
  removeTodo,
  reopenTodo,
  startTodo,
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
  assert.equal(formatTodos(state), "- #1 Ship extension\n  > #2 Run validation");
  pauseTodo(state, child.id);
  assert.equal(completeTodo(state, parent.id), 2);
  assert.equal(formatTodoSnapshot(state), "TODO: 0 active, 0 pending, 2 completed");
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
  assert.equal(formatTodoSnapshot(state, true), "TODO: 1 active, 1 pending, 0 completed\n- #1 First\n  > #2 Updated second");

  const before = cloneState(state);
  assert.throws(
    () => applyTodoBatch(state, [{ action: "pause", id: 2 }, { action: "remove", id: 999 }]),
    /not found/,
  );
  assert.deepEqual(state, before);
});

test("legacy done snapshots migrate to statuses", () => {
  const migrated = cloneState({
    nextId: 3,
    items: [
      { id: 1, text: "Done", done: true },
      { id: 2, text: "Open", done: false },
    ],
  } as unknown as TodoState);
  assert.deepEqual(
    migrated.items.map((item) => item.status),
    ["completed", "pending"],
  );
});

function createExtensionHarness() {
  type Handler = (...args: unknown[]) => unknown;
  type Tool = { execute: (...args: unknown[]) => Promise<unknown> };
  type Command = { handler: (args: string, ctx: unknown) => Promise<void> };
  const handlers = new Map<string, Handler>();
  const sent: Array<{
    message: { content: string };
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

  todoListExtension({
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    registerTool: (registered: Tool) => { tool = registered; },
    registerCommand: (_name: string, registered: Command) => { command = registered; },
    sendMessage: (message: { content: string }, options?: { deliverAs?: string; triggerTurn?: boolean }) => {
      sent.push({ message, options });
    },
  } as never);

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
      return emit("session_compact", { willRetry, compactionEntry });
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

  const headless = createExtensionHarness();
  headless.setHasUI(false);
  await headless.execute({ action: "add", text: "Headless todo" });
  await headless.runCommand("show");
  assert.equal(headless.widgetUpdates.length, 0);
  assert.equal(headless.statusUpdates.length, 0);
  assert.equal(headless.notifications.length, 0);
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
});
