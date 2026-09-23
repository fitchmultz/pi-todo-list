import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
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
  TODO_LINK_LIMIT,
  TODO_REF_LIMIT,
  type TodoBatchMutation,
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
  assert.equal(child.status, "paused");
  assert.equal(formatTodoPage(state), "TODO: 0 active, 1 pending, 1 paused, 0 completed\n- #1 Ship extension\n  ⏸ #2 Run validation");
  assert.equal(completeTodo(state, parent.id), 2);
  pauseTodo(state, child.id);
  assert.equal(parent.status, "pending", "pausing a completed child reopens its completed ancestors");
  startTodo(state, child.id);
  assert.equal(child.status, "in_progress");
  completeTodo(state, parent.id);
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
    ]).messages,
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

test("batch refs resolve in order without changing cascades or persistent numeric IDs", () => {
  const state = emptyState();
  addTodo(state, "Existing");
  const operations: TodoBatchMutation[] = [
    { action: "add", text: "Parent", status: "in_progress", ref: "1" },
    { action: "add", text: "Child", parentId: "1", status: "paused", ref: "child" },
    { action: "add", text: "Grandchild", parentId: "child", status: "completed", ref: "leaf" },
    { action: "update", id: 1, text: "Existing numeric ID" },
    { action: "update", id: "1", text: "String ref" },
    { action: "complete", id: "1" },
    { action: "start", id: "leaf" },
    { action: "pause", id: "child" },
    { action: "move", id: "leaf", parentId: 1 },
  ];
  const before = structuredClone(operations);
  const result = applyTodoBatch(state, operations);
  assert.deepEqual(operations, before, "reference resolution does not mutate the caller's inputs");
  assert.deepEqual(state, { nextId: 5, items: [
    { id: 1, text: "Existing numeric ID", status: "pending" },
    { id: 2, text: "String ref", status: "pending" },
    { id: 3, text: "Child", status: "paused", parentId: 2 },
    { id: 4, text: "Grandchild", status: "in_progress", parentId: 1 },
  ] });
  assert.deepEqual(result.operations, [
    { action: "add", text: "Parent", status: "in_progress" },
    { action: "add", text: "Child", parentId: 2, status: "paused" },
    { action: "add", text: "Grandchild", parentId: 3, status: "completed" },
    { action: "update", id: 1, text: "Existing numeric ID" },
    { action: "update", id: 2, text: "String ref" },
    { action: "complete", id: 2 },
    { action: "start", id: 4 },
    { action: "pause", id: 3 },
    { action: "move", id: 4, parentId: 1 },
  ]);
  assert.throws(() => applyTodoBatch(state, [{ action: "remove", id: "child" }]), /Unknown or forward batch ref/);
  applyTodoBatch(state, [{ action: "reopen", id: 1 }]);
  assert.equal(state.items[3]!.status, "pending");
});

test("invalid batch references and statuses roll back items and the ID counter", () => {
  const failures: TodoBatchMutation[][] = [
    [{ action: "add", text: "Duplicate", ref: "new" }],
    [{ action: "start", id: "missing" }],
    [{ action: "add", text: "Forward child", parentId: "later" }, { action: "add", text: "Later", ref: "later" }],
    [{ action: "update", id: "new", text: "Bad ref", ref: "rename" }],
    [{ action: "add", text: "Invalid status", status: "blocked" as never }],
    [{ action: "start", id: "new", status: "completed" }],
    [{ action: "remove", id: "new" }, { action: "pause", id: "new" }],
    [{ action: "add", text: "Self reference", ref: "self", parentId: "self" }],
    [{ action: "move", id: "new", parentId: "missing" }],
  ];
  for (const failure of failures) {
    const state = emptyState();
    addTodo(state, "Unchanged");
    const before = cloneState(state);
    assert.throws(() => applyTodoBatch(state, [{ action: "add", text: "Rolled back", ref: "new" }, ...failure]), /No changes applied/);
    assert.deepEqual(state, before);
    assert.equal(addTodo(state, "Next ID").id, 2);
  }
  const state = emptyState();
  assert.throws(() => applyTodoBatch(state, []), /1-100/);
  assert.throws(() => applyTodoBatch(state, Array.from({ length: 101 }, () => ({ action: "add", text: "Too many" }))), /1-100/);
  assert.deepEqual(state, emptyState());
});

test("batch reference uses reject unsafe labels before lookup and roll back", () => {
  for (const ref of ["new\nother", "\u001b[31mnew", "\u202enew", " new ", "", "x".repeat(TODO_REF_LIMIT + 1)]) {
    for (const operation of [
      { action: "add", text: "Invalid declaration", ref },
      { action: "start", id: ref },
      { action: "add", text: "Invalid parent ref", parentId: ref },
    ] satisfies TodoBatchMutation[]) {
      const state = emptyState();
      addTodo(state, "Existing");
      const before = cloneState(state);
      assert.throws(() => applyTodoBatch(state, [{ action: "add", text: "Rolled back", ref: "new" }, operation]), (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ref (?:must|cannot)/);
        assert.doesNotMatch(error.message, /[\n\u001b\u202e]/);
        assert.match(error.message, /No changes applied/);
        return true;
      });
      assert.deepEqual(state, before);
      assert.equal(addTodo(state, "Next ID").id, 2);
    }
  }
});

test("todo text is bounded and safe to render", () => {
  const state = emptyState();
  const bidiControls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
  const todo = addTodo(state, `\u001b[31mred\u001b[0m\n${bidiControls}line`);
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
  assert.throws(
    () => cloneState({ nextId: 2, items: [{ id: 1, text: "Invalid legacy flag", done: "false" }] } as unknown as TodoState),
    /Invalid done flag/,
  );
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
    () => cloneState({ nextId: 2, items: [{ id: 1, text: "Bad status", status: "blocked" as never }] }),
    /Invalid status/,
  );
  assert.throws(
    () => cloneState({ nextId: 2, items: [{ id: 1, text: "Missing status" }] } as unknown as TodoState),
    /exactly one status field/,
  );
  assert.throws(
    () => cloneState({ nextId: 2, items: [{ id: 1, text: "Conflicting status", status: "pending", done: true }] } as unknown as TodoState),
    /exactly one status field/,
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
  assert.deepEqual(todoCounts(state), { pending: 0, inProgress: 0, paused: 0, completed: size });
  startTodo(state, size);
  assert.deepEqual(todoCounts(state), { pending: size - 1, inProgress: 1, paused: 0, completed: 0 });
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

test("list shows open work and counts the completed items", () => {
  const state = emptyState();
  addTodo(state, "Open parent");
  addTodo(state, "Done parent");
  addTodo(state, "Done child", 2);
  completeTodo(state, 2);
  assert.equal(
    formatTodoPage(state),
    "TODO: 0 active, 1 pending, 2 completed\n- #1 Open parent\n… 2 completed not shown",
  );

  completeTodo(state, 1);
  assert.equal(formatTodoPage(state), "TODO: 0 active, 0 pending, 3 completed");
});

test("list pages and compaction context stay bounded", () => {
  const text = "x".repeat(240);
  const state: TodoState = {
    nextId: 131,
    items: Array.from({ length: 130 }, (_, index) => ({
      id: index + 1,
      text,
      status: index < 30 ? "in_progress" : index < 100 ? "pending" : "paused",
      link: `https://example.com/evidence/${"x".repeat(1000)}`,
    })),
  };

  const firstPage = formatTodoPage(state);
  assert.match(firstPage, /Showing 1-100 of 130 open/);
  assert.match(firstPage, /> #1 /);
  assert.doesNotMatch(firstPage, /- #101 /);
  const lastPage = formatTodoPage(state, 100, 30);
  assert.match(lastPage, /Showing 101-130 of 130 open/);
  assert.match(lastPage, /⏸ #130 /);
  assert.match(formatTodoPage(state, Number.NaN, Number.NaN), /Showing 1-100 of 130 open/);
  assert.match(formatTodoPage(state, 200), /No open todos at offset 200; 130 open/);

  const context = formatTodoContext(state);
  assert.ok(context.length < 3_000);
  assert.match(context, /25 active and 65 pending and 25 paused not shown; use todo_list list to page through the open items/);
  assert.match(context, /⏸ #101 /);
  assert.match(context, /\[details\]/);
  assert.match(context, /list with id for detail links/);
  assert.doesNotMatch(context, /https:|> #6 |- #36 |⏸ #106 /);
});

function createExtensionHarness(sessionManager?: SessionManager) {
  type Handler = (...args: any[]) => any;
  type Tool = { execute: (...args: any[]) => Promise<unknown>; executionMode?: string };
  type Command = { handler: (args: string, ctx: any) => Promise<void> };
  const handlers = new Map<string, Handler>();
  const sent: Array<{
    message: { customType?: string; content: string; display?: boolean; details?: unknown };
    options?: { deliverAs?: string; triggerTurn?: boolean };
  }> = [];
  let branch: Array<Record<string, unknown>> = [];
  let hasUI = true;
  const widgetUpdates: Array<string[] | undefined> = [];
  let widgetFailure: Error | undefined;
  const statusUpdates: Array<string | undefined> = [];
  const notifications: string[] = [];
  const ctx = {
    get hasUI() { return hasUI; },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget(_key: string, content: string[] | undefined) {
        if (widgetFailure) {
          const failure = widgetFailure;
          widgetFailure = undefined;
          throw failure;
        }
        widgetUpdates.push(content);
      },
      setStatus(_key: string, text: string | undefined) { statusUpdates.push(text); },
      notify(message: string) { notifications.push(message); },
    },
    sessionManager: sessionManager ?? { getBranch: () => branch },
  };
  let tool: Tool | undefined;
  let command: Command | undefined;

  const api = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => { if (handlers.get(event) === handler) handlers.delete(event); };
    },
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
    toolDefinition() {
      assert.ok(tool);
      return tool;
    },
    setHasUI(value: boolean) { hasUI = value; },
    failNextWidgetUpdate() { widgetFailure = new Error("widget render failed"); },
    async runCommand(args: string) {
      assert.ok(command);
      await command.handler(args, ctx);
    },
    startSession(entries: Array<Record<string, unknown>>) {
      branch = structuredClone(entries);
      return emit("session_start", {});
    },
    switchBranch(entries: Array<Record<string, unknown>>) {
      branch = structuredClone(entries);
      return emit("session_tree", {});
    },
    startContextWindow(id: string) {
      branch.push({ type: "context_window", id });
    },
    compact(willRetry: boolean, id: string) {
      const compactionEntry = { type: "compaction", id };
      branch.push(compactionEntry);
      const sentBefore = sent.length;
      const result = emit("session_compact", { willRetry, compactionEntry });
      for (const queued of sent.slice(sentBefore)) branch.push({ type: "custom_message", ...queued.message });
      return result;
    },
    // tolerateRejection models Pi: a thrown execute() becomes an isError result
    // carrying no details, which restore skips.
    async execute(params: Record<string, unknown>, tolerateRejection = false) {
      assert.ok(tool);
      let result: unknown;
      try {
        result = await tool.execute("test-call", params, undefined, undefined, ctx);
      } catch (error) {
        if (!tolerateRejection) throw error;
        branch.push({ type: "message", message: { role: "toolResult", toolName: "todo_list", isError: true } });
        return undefined;
      }
      const returned = result as { content: Array<{ type: "text"; text: string }>; details?: ToolResultMessage["details"] };
      const message = {
        role: "toolResult" as const,
        toolCallId: "test-call",
        toolName: "todo_list",
        content: returned.content,
        details: returned.details,
        isError: false,
        timestamp: Date.now(),
      };
      if (sessionManager) sessionManager.appendMessage(message);
      else branch.push({ type: "message", message });
      return returned;
    },
    emit,
  };
}

test("add accepts every initial status standalone and in batches while defaulting to pending", async () => {
  for (const batch of [false, true]) {
    const harness = createExtensionHarness();
    for (const [index, status] of [undefined, "pending", "in_progress", "paused", "completed"].entries()) {
      const operation = { action: "add", text: `Initial ${status ?? "default"}`, ...(status === undefined ? {} : { status }) };
      await harness.execute(batch ? { action: "batch", operations: [operation] } : operation);
      assert.equal((await harness.execute({ action: "list", id: index + 1 }))?.content[0]?.text,
        `#${index + 1} Initial ${status ?? "default"}\nStatus: ${(status ?? "pending").replace("_", " ")}`);
    }
    await harness.execute({ action: "add", text: "Also active", status: "in_progress" });
    assert.match((await harness.execute({ action: "list" }))?.content[0]?.text ?? "", /TODO: 2 active, 2 pending, 1 paused, 1 completed/);
    for (const status of ["pending", "in_progress", "paused", "completed"]) {
      const operation = { action: "add", text: "Rejected child", parentId: 5, status };
      await assert.rejects(harness.execute(batch ? { action: "batch", operations: [operation] } : operation), /Cannot add under a completed todo/);
    }
    await assert.rejects(harness.execute({ action: "add", text: "Invalid status", status: "blocked" }), /Invalid todo status/);
    await assert.rejects(harness.execute({ action: "start", id: 1, status: "completed" }), /status is only supported for add/);
    await assert.rejects(harness.execute({ action: "add", text: "Standalone ref", ref: "outside" }), /ref is only supported/);
    await assert.rejects(harness.execute({ action: "update", id: "1", text: "String outside batch" }), /positive safe integer/);
    await harness.execute({ action: "add", text: "Next ID" });
    assert.match((await harness.execute({ action: "list", id: 7 }))?.content[0]?.text ?? "", /#7 Next ID/);
  }
});

test("canonical numeric operations restore nested ref batches and preserve links", async () => {
  const harness = createExtensionHarness();
  await harness.execute({ action: "add", text: "Existing" });
  const result = await harness.execute({ action: "batch", operations: [
    { action: "add", text: "Parent", ref: "1", status: "in_progress", link: "/parent.md" },
    { action: "add", text: "Child", ref: "child", parentId: "1", status: "paused" },
    { action: "update", id: "1", text: "Renamed parent" },
    { action: "move", id: "child", parentId: 1 },
  ] });
  assert.deepEqual(result?.details, { version: 7, operations: [
    { action: "add", text: "Parent", status: "in_progress", link: "/parent.md" },
    { action: "add", text: "Child", parentId: 2, status: "paused" },
    { action: "update", id: 2, text: "Renamed parent" },
    { action: "move", id: 3, parentId: 1 },
  ] });
  const resumed = createExtensionHarness();
  resumed.startSession(JSON.parse(JSON.stringify(harness.branch())));
  assert.deepEqual(resumed.notifications, []);
  assert.equal((await resumed.execute({ action: "list", id: 2 }))?.content[0]?.text,
    "#2 Renamed parent\nStatus: in progress\nDetails: /parent.md");
  assert.equal((await resumed.execute({ action: "list", id: 3 }))?.content[0]?.text, "#3 Child\nStatus: paused\nParent: #1");
  await assert.rejects(resumed.execute({ action: "batch", operations: [{ action: "remove", id: "child" }] }), /Unknown or forward batch ref/);
});

test("100 additions with initial statuses stay within one restorable journal envelope", async () => {
  const manager = SessionManager.inMemory();
  const source = createExtensionHarness(manager);
  const statuses = ["pending", "in_progress", "paused", "completed"] as const;
  const operations = Array.from({ length: 100 }, (_, index) => ({
    action: "add", text: `Task ${index + 1}`, status: statuses[index % statuses.length], ref: `task-${index}`,
  }));
  const result = await source.execute({ action: "batch", operations });
  assert.deepEqual(result?.details, { version: 7, operations: operations.map(({ ref, ...operation }) => operation) });
  const resumed = createExtensionHarness();
  resumed.startSession(JSON.parse(JSON.stringify(manager.getBranch())));
  assert.deepEqual(resumed.notifications, []);
  assert.match((await resumed.execute({ action: "list" }))?.content[0]?.text ?? "", /TODO: 25 active, 25 pending, 25 paused, 25 completed/);
  for (const [index, operation] of operations.entries()) {
    assert.equal((await resumed.execute({ action: "list", id: index + 1 }))?.content[0]?.text,
      `#${index + 1} ${operation.text}\nStatus: ${operation.status!.replace("_", " ")}`);
  }
  assert.match((await resumed.execute({ action: "add", text: "After journal" }))?.content[0]?.text ?? "", /Added #101:/);
});

test("detail links stay out of titles and are retrieved on demand", async () => {
  const harness = createExtensionHarness();
  const link = "https://example.com/pull/123#evidence";
  await harness.execute({ action: "add", text: "Verify release", link });
  await harness.execute({ action: "pause", id: 1 });
  await harness.runCommand("show");
  assert.equal(harness.widgetUpdates.at(-1)?.join("\n"), "⏸ #1 Verify release [details]");
  assert.equal(harness.statusUpdates.at(-1), "todo 0 active · 0 pending · 1 paused");
  assert.equal((await harness.execute({ action: "list" }))?.content[0]?.text,
    "TODO: 0 active, 0 pending, 1 paused, 0 completed\n⏸ #1 Verify release [details]");
  const detail = `#1 Verify release\nStatus: paused\nDetails: ${link}`;
  assert.equal((await harness.execute({ action: "list", id: 1 }))?.content[0]?.text, detail);
  await harness.runCommand("1");
  assert.equal(harness.notifications.at(-1), detail);
  await harness.runCommand("999");
  assert.equal(harness.notifications.at(-1), "Todo #999 not found");

  await harness.execute({ action: "update", id: 1, text: "Ship release" });
  assert.equal((await harness.execute({ action: "list", id: 1 }))?.content[0]?.text,
    `#1 Ship release\nStatus: paused\nDetails: ${link}`);
  await harness.execute({ action: "update", id: 1, link: "/repo/notes/current.md" });
  const beforeFailure = (await harness.execute({ action: "list", id: 1 }))?.content;
  await assert.rejects(harness.execute({ action: "update", id: 1, text: "Must not change", link: " " }), /link cannot be empty/);
  await assert.rejects(harness.execute({ action: "batch", operations: [
    { action: "update", id: 1, link: "/wrong.md" }, { action: "remove", id: 999 },
  ] }), /No changes applied/);
  assert.deepEqual((await harness.execute({ action: "list", id: 1 }))?.content, beforeFailure);
  await assert.rejects(harness.execute({ action: "update", id: 1 }), /text or link is required/);
  await harness.execute({ action: "update", id: 1, link: null });
  assert.equal((await harness.execute({ action: "list", id: 1 }))?.content[0]?.text, "#1 Ship release\nStatus: paused");
  await harness.execute({ action: "batch", operations: [
    { action: "update", id: 1, link }, { action: "complete", id: 1 },
  ] });
  assert.equal((await harness.execute({ action: "list", id: 1 }))?.content[0]?.text,
    `#1 Ship release\nStatus: completed\nDetails: ${link}`);
  assert.match((await harness.execute({ action: "clear_completed" }))?.content[0]?.text ?? "",
    /x #1: Ship release\n  Details: https:\/\/example.com\/pull\/123#evidence/);
});

test("links are bounded and terminal-safe at the tool and restore boundaries", async () => {
  const harness = createExtensionHarness();
  await assert.rejects(harness.execute({ action: "add", text: "Not added", link: "x".repeat(TODO_LINK_LIMIT + 1) }), /link cannot exceed 2048/);
  await assert.rejects(harness.execute({ action: "add", text: "Not added", link: 123 }), /link must be a URL or note\/file path/);
  const added = await harness.execute({ action: "add", text: "Read evidence", link: "\u001b\u202e/report.md\n" });
  assert.match(added?.content[0]?.text ?? "", /Added #1:/);
  assert.equal((await harness.execute({ action: "list", id: 1 }))?.content[0]?.text,
    "#1 Read evidence\nStatus: pending\nDetails: /report.md");
  const snapshot = { nextId: 2, items: [{ id: 1, text: "Evidence", status: "paused" as const, link: "/report.md" }] };
  assert.deepEqual(cloneState(snapshot), snapshot);
  assert.throws(() => cloneState({ ...snapshot, items: [{ ...snapshot.items[0]!, link: "x".repeat(TODO_LINK_LIMIT + 1) }] }), /link cannot exceed 2048/);
});

test("paused state and detail links survive native replay and recovery without changing old pause semantics", async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "toolResult", toolCallId: "checkpoint", toolName: "todo_list", content: [], isError: false, timestamp: 1,
    details: { version: 4, state: { nextId: 2, items: [{ id: 1, text: "Legacy pause", status: "pending" }] } } });
  manager.appendMessage({ role: "toolResult", toolCallId: "old", toolName: "todo_list", content: [], isError: false, timestamp: 2,
    details: { version: 3, operations: [
      { action: "start", id: 1 }, { action: "pause", id: 1 },
    ] } });
  const harness = createExtensionHarness(manager);
  harness.emit("session_start", {});
  await harness.execute({ action: "batch", operations: [
    { action: "add", text: "Current pause", parentId: 1, link: "/repo/current.md" },
    { action: "start", id: 2 }, { action: "pause", id: 2 },
  ] });
  const branch = JSON.parse(JSON.stringify(manager.getBranch()));
  const resumed = createExtensionHarness();
  resumed.startSession(branch);
  assert.equal((await resumed.execute({ action: "list", id: 1 }))?.content[0]?.text, "#1 Legacy pause\nStatus: pending");
  const detail = "#2 Current pause\nStatus: paused\nParent: #1\nDetails: /repo/current.md";
  assert.equal((await resumed.execute({ action: "list", id: 2 }))?.content[0]?.text, detail);
  resumed.startContextWindow("paused-window");
  const context = resumed.emit("context", { messages: [contextWindowMarker("paused-window")] });
  assert.match(context.messages[1].content, /⏸ #2 Current pause \[details\] \(under #1\)/);
  assert.doesNotMatch(context.messages[1].content, /\/repo\/current.md/);

  resumed.switchBranch([...branch, { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 99 } } }]);
  const checkpoint = await resumed.execute({ action: "list" });
  assert.equal((checkpoint?.details as { version: number }).version, 6);
  resumed.startSession(resumed.branch());
  assert.equal((await resumed.execute({ action: "list", id: 2 }))?.content[0]?.text, detail);
  assert.equal((await resumed.execute({ action: "list", id: 1 }))?.content[0]?.text, "#1 Legacy pause\nStatus: pending");
  await resumed.execute({ action: "start", id: 2 });
  assert.match((await resumed.execute({ action: "list", id: 2 }))?.content[0]?.text ?? "", /Status: in progress/);
});

test("legacy snapshots and logs ignore historical extra fields and keep target-only pause", async () => {
  for (const version of [1, 2, 4, 6]) {
    for (const logVersion of [3, 5]) {
      const root = version === 1
        ? { id: 1, text: "Root", done: false }
        : { id: 1, text: "Root", status: "pending" };
      const checkpoint = {
        type: "message", message: { role: "toolResult", toolName: "todo_list", details: {
          version, ...(version < 3 ? { action: "add" } : {}), state: { nextId: 2, items: [root] },
        } },
      };
      const branch = [checkpoint, { type: "message", message: { role: "toolResult", toolName: "todo_list", details: {
        version: logVersion, operations: [
          { action: "add", text: "Child", parentId: 1, status: "completed", ref: "ignored" },
          { action: "add", text: "Grandchild", parentId: 2, status: "invalid", ref: "ignored" },
          { action: "update", id: 2, text: "Renamed child", parentId: 999, status: "invalid", ref: "ignored" },
          { action: "complete", id: 1 },
          { action: "pause", id: 2 },
          { action: "add", text: "Still pending", status: "in_progress", ref: "ignored" },
        ],
      } } }];
      const harness = createExtensionHarness();
      harness.startSession(branch);
      assert.deepEqual(harness.notifications, [], `snapshot ${version}, log ${logVersion}`);
      assert.equal((await harness.execute({ action: "list", id: 1 }))?.content[0]?.text, "#1 Root\nStatus: pending");
      assert.equal((await harness.execute({ action: "list", id: 2 }))?.content[0]?.text,
        `#2 Renamed child\nStatus: ${logVersion === 3 ? "pending" : "paused"}\nParent: #1`);
      assert.equal((await harness.execute({ action: "list", id: 3 }))?.content[0]?.text,
        "#3 Grandchild\nStatus: completed\nParent: #2");
      assert.equal((await harness.execute({ action: "list", id: 4 }))?.content[0]?.text, "#4 Still pending\nStatus: pending");
      harness.switchBranch([checkpoint]);
      assert.match((await harness.execute({ action: "add", text: "Forked from checkpoint", status: "paused" }))?.content[0]?.text ?? "", /Added #2:/);
      harness.switchBranch(branch);
      assert.match((await harness.execute({ action: "add", text: "After legacy log", status: "in_progress" }))?.content[0]?.text ?? "", /Added #5:/);
    }
  }
});

test("legacy v3 logs ignore link inputs while v5 and current logs retain links", async () => {
  const harness = createExtensionHarness();
  const legacy = { type: "message", message: { role: "toolResult", toolName: "todo_list", details: {
    version: 3, operations: [
      { action: "add", text: "Parent", link: "/ignored.md" },
      { action: "add", text: "Child", parentId: 1, link: 123 },
      { action: "update", id: 2, text: "Renamed child", parentId: 1, link: { ignored: true } },
    ],
  } } };
  harness.startSession([legacy]);
  assert.deepEqual(harness.notifications, []);
  assert.equal((await harness.execute({ action: "list", id: 1 }))?.content[0]?.text, "#1 Parent\nStatus: pending");
  assert.equal((await harness.execute({ action: "list", id: 2 }))?.content[0]?.text, "#2 Renamed child\nStatus: pending\nParent: #1");
  harness.switchBranch([legacy, { type: "message", message: { role: "toolResult", toolName: "todo_list", details: {
    version: 5, operations: [
      { action: "update", id: 2, link: "/v5-child.md" },
      { action: "add", text: "Linked", link: "/v5-add.md" },
      { action: "update", id: 3, text: "Linked rename" },
    ],
  } } }]);
  assert.deepEqual(harness.notifications, []);
  assert.equal((await harness.execute({ action: "list", id: 2 }))?.content[0]?.text,
    "#2 Renamed child\nStatus: pending\nParent: #1\nDetails: /v5-child.md");
  assert.equal((await harness.execute({ action: "list", id: 3 }))?.content[0]?.text,
    "#3 Linked rename\nStatus: pending\nDetails: /v5-add.md");
  await harness.execute({ action: "update", id: 3, link: "/current.md" });
  harness.startSession(harness.branch());
  assert.equal((await harness.execute({ action: "list", id: 3 }))?.content[0]?.text,
    "#3 Linked rename\nStatus: pending\nDetails: /current.md");
});

test("clear_completed receipts identify nested items and surviving parents in standalone and batch results", async () => {
  for (const batch of [false, true]) {
    const manager = SessionManager.inMemory();
    const harness = createExtensionHarness(manager);
    await harness.execute({ action: "batch", operations: [
      { action: "add", text: "Moved child" },
      { action: "add", text: "Surviving parent" },
      { action: "add", text: "Completed parent", parentId: 2 },
      { action: "add", text: "Completed child", parentId: 3 },
      { action: "move", id: 1, parentId: 3 },
      { action: "add", text: "Completed root (under #99)" },
      { action: "complete", id: 3 },
      { action: "complete", id: 5 },
    ] });
    const listed = await harness.execute({ action: "list" });
    assert.equal(listed?.content[0]?.text, "TODO: 0 active, 1 pending, 4 completed\n- #2 Surviving parent\n… 4 completed not shown");
    const params = batch ? { action: "batch", operations: [{ action: "clear_completed" }] } : { action: "clear_completed" };
    const result = await harness.execute(params);
    assert.equal(result?.content[0]?.text, [
      ...(batch ? ["Applied 1 operation(s):"] : []),
      `${batch ? "- " : ""}Removed 4 completed item(s)`,
      "x #1 (under #3): Moved child",
      "x #3 (under #2): Completed parent",
      "x #4 (under #3): Completed child",
      "x #5: Completed root (under #99)",
      "TODO: 0 active, 1 pending, 0 completed",
    ].join("\n"));
    assert.deepEqual(JSON.parse(JSON.stringify(result?.details)), { version: 7, operations: [{ action: "clear_completed" }] });
    const modelMessage = manager.buildSessionContext().messages.at(-1);
    assert.equal(modelMessage?.role, "toolResult");
    assert.deepEqual(modelMessage?.content, result?.content);
    assert.deepEqual(harness.notifications, [], "cleanup does not add an interactive confirmation");
    assert.equal((await harness.execute(params))?.content[0]?.text,
      `${batch ? "Applied 1 operation(s):\n- " : ""}Removed 0 completed item(s)\nTODO: 0 active, 1 pending, 0 completed`);
  }
});

test("clear_completed receipts retain every full identity beyond one list page and deep render limits", async () => {
  const manager = SessionManager.inMemory();
  const harness = createExtensionHarness(manager);
  const text = "x".repeat(TODO_TEXT_LIMIT);
  const operations = Array.from({ length: 130 }, (_, index) => ({
    action: "add", text, ...(index === 0 ? {} : { parentId: index }),
  }));
  await harness.execute({ action: "batch", operations: operations.slice(0, 100) });
  await harness.execute({ action: "batch", operations: operations.slice(100) });
  await harness.execute({ action: "complete", id: 1 });
  const result = await harness.execute({ action: "clear_completed" });
  assert.equal(result?.content[0]?.text, [
    "Removed 130 completed item(s)",
    ...operations.map((_, index) => `x #${index + 1}${index === 0 ? "" : ` (under #${index})`}: ${text}`),
    "TODO: 0 active, 0 pending, 0 completed",
  ].join("\n"));
  const modelMessage = manager.buildSessionContext().messages.at(-1);
  assert.equal(modelMessage?.role, "toolResult");
  assert.deepEqual(modelMessage.content, result?.content);
  assert.equal((await harness.execute({ action: "list" }))?.content[0]?.text, "No todos");
});

test("clear_completed batch receipts follow mutations and preserve rollback, IDs and native session replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-todo-receipts-"));
  try {
    const manager = SessionManager.create(directory, directory);
    // Native persistence starts with the first assistant message; no model call is needed.
    manager.appendMessage({ role: "assistant", content: [], api: "openai-responses", provider: "openai", model: "fixture",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 1 });
    const harness = createExtensionHarness(manager);
    await harness.execute({ action: "batch", operations: [
      { action: "add", text: "Surviving parent" },
      { action: "add", text: "Original child", parentId: 1 },
      { action: "complete", id: 2 },
    ] });
    const beforeCleanup = manager.getLeafId()!;
    const operations = [
      { action: "clear_completed" },
      { action: "add", text: "Replacement", parentId: 1 },
      { action: "update", id: 3, text: "Renamed replacement" },
      { action: "complete", id: 3 },
      { action: "clear_completed" },
      { action: "clear_completed" },
    ];
    const result = await harness.execute({ action: "batch", operations });
    assert.equal(result?.content[0]?.text, [
      "Applied 6 operation(s):",
      "- Removed 1 completed item(s)",
      "x #2 (under #1): Original child",
      "- Added #3: Replacement",
      "- Updated #3: Renamed replacement",
      "- Completed #3",
      "- Removed 1 completed item(s)",
      "x #3 (under #1): Renamed replacement",
      "- Removed 0 completed item(s)",
      "TODO: 0 active, 1 pending, 0 completed",
    ].join("\n"));
    assert.deepEqual(result?.details, { version: 7, operations });
    const afterCleanup = manager.getLeafId()!;
    const sessionFile = manager.getSessionFile()!;
    const beforeFailure = readFileSync(sessionFile, "utf8");
    await assert.rejects(harness.execute({ action: "batch", operations: [
      { action: "complete", id: 1 },
      { action: "clear_completed" },
      { action: "add", text: "Rolled back" },
      { action: "remove", id: 999 },
    ] }), /^Error: Batch operation 4 \(remove\) failed: Todo #999 not found\. No changes applied\.$/);
    assert.equal(readFileSync(sessionFile, "utf8"), beforeFailure, "failed cleanup returns no receipt or persisted mutation");
    assert.equal((await harness.execute({ action: "add", text: "Next ID" }))?.content[0]?.text,
      "Added #4: Next ID\nTODO: 0 active, 2 pending, 0 completed");

    const reopened = SessionManager.open(sessionFile, directory);
    const resumed = createExtensionHarness(reopened);
    resumed.emit("session_start", {});
    assert.equal((await resumed.execute({ action: "list" }))?.content[0]?.text,
      "TODO: 0 active, 2 pending, 0 completed\n- #1 Surviving parent\n- #4 Next ID");
    reopened.branch(beforeCleanup);
    resumed.emit("session_tree", {});
    assert.equal((await resumed.execute({ action: "clear_completed" }))?.content[0]?.text,
      "Removed 1 completed item(s)\nx #2 (under #1): Original child\nTODO: 0 active, 1 pending, 0 completed");
    reopened.branch(afterCleanup);
    resumed.emit("session_tree", {});
    assert.equal((await resumed.execute({ action: "add", text: "Branch ID" }))?.content[0]?.text,
      "Added #4: Branch ID\nTODO: 0 active, 2 pending, 0 completed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const contextWindowMarker = (windowId: string) => ({
  role: "custom",
  customType: "context-window",
  content: `Context window ${windowId} starts here.`,
  display: true,
  details: { windowId },
  timestamp: 1,
});

const userMessage = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 2 });

test("native context injection has no initial-window or never-used-list tax", async () => {
  const harness = createExtensionHarness();
  assert.equal(harness.emit("context", { messages: [userMessage("Initial request")] }), undefined);

  await harness.execute({ action: "add", text: "Ordinary request" });
  assert.equal(harness.emit("context", { messages: [userMessage("Still initial")] }), undefined);
  await harness.execute({ action: "remove", id: 1 });

  const unused = createExtensionHarness();
  unused.startContextWindow("empty-window");
  assert.equal(unused.emit("context", { messages: [contextWindowMarker("empty-window")] }), undefined);

  harness.startContextWindow("empty-history-window");
  const result = harness.emit("context", { messages: [contextWindowMarker("empty-history-window")] }) as {
    messages: Array<{ customType?: string; content?: string; display?: boolean }>;
  };
  assert.deepEqual(result.messages.slice(1), [{
    role: "custom",
    customType: "todo-list-context",
    content: "[TODO LIST - recovery snapshot]\nNo todos\nLater todo_list results supersede this snapshot.",
    display: false,
    timestamp: 1,
  }]);
});

test("native context injects the boundary-time todo snapshot immediately after its marker", async () => {
  const harness = createExtensionHarness();
  await harness.execute({ action: "add", text: "Before boundary" });
  harness.startContextWindow("window-a");
  await harness.execute({ action: "add", text: "After boundary" });

  const marker = contextWindowMarker("window-a");
  const later = userMessage("Continue");
  const result = harness.emit("context", { messages: [marker, later] }) as { messages: Array<Record<string, unknown>> };
  assert.deepEqual(result.messages, [
    marker,
    {
      role: "custom",
      customType: "todo-list-context",
      content: "[TODO LIST - recovery snapshot]\nTODO: 0 active, 1 pending, 0 completed\n- #1 Before boundary\nLater todo_list results supersede this snapshot.",
      display: false,
      timestamp: 1,
    },
    later,
  ]);
});

test("native context keeps one byte-stable boundary snapshot after later mutations", async () => {
  const harness = createExtensionHarness();
  await harness.execute({ action: "add", text: "Before boundary" });
  harness.startContextWindow("stable-window");
  const marker = contextWindowMarker("stable-window");
  const first = harness.emit("context", { messages: [marker] }) as { messages: Array<Record<string, unknown>> };
  const firstBytes = JSON.stringify(first.messages[1]);
  first.messages[1]!.content = "downstream mutation";

  await harness.execute({ action: "complete", id: 1 });
  assert.match((await harness.execute({ action: "clear_completed" }))?.content[0]?.text ?? "", /x #1: Before boundary/);
  await harness.execute({ action: "add", text: "After boundary" });
  const repeated = harness.emit("context", { messages: [marker, userMessage("Later request")] }) as {
    messages: Array<Record<string, unknown>>;
  };
  assert.equal(JSON.stringify(repeated.messages[1]), firstBytes);
  assert.doesNotMatch(String(repeated.messages[1]?.content), /After boundary/);
});

test("native context snapshots recompute on resume and tree navigation", async () => {
  const previousSource = createExtensionHarness();
  await previousSource.execute({ action: "add", text: "Previous boundary" });
  previousSource.startContextWindow("shared-window");
  const harness = createExtensionHarness();
  harness.switchBranch(previousSource.branch());
  harness.emit("context", { messages: [contextWindowMarker("shared-window")] });

  const resumeSource = createExtensionHarness();
  await resumeSource.execute({ action: "add", text: "Resume boundary" });
  resumeSource.startContextWindow("shared-window");
  harness.startSession(resumeSource.branch());
  const resumed = harness.emit("context", { messages: [contextWindowMarker("shared-window")] }) as {
    messages: Array<{ content?: string }>;
  };
  assert.match(resumed.messages[1]?.content ?? "", /#1 Resume boundary/);
  assert.doesNotMatch(resumed.messages[1]?.content ?? "", /Previous boundary/);

  const treeSource = createExtensionHarness();
  await treeSource.execute({ action: "add", text: "Tree boundary" });
  treeSource.startContextWindow("shared-window");
  harness.switchBranch(treeSource.branch());
  const navigated = harness.emit("context", { messages: [contextWindowMarker("shared-window")] }) as {
    messages: Array<{ content?: string }>;
  };
  assert.match(navigated.messages[1]?.content ?? "", /#1 Tree boundary/);
  assert.doesNotMatch(navigated.messages[1]?.content ?? "", /Resume boundary/);
});

test("native context does not duplicate an existing todo context", async () => {
  const harness = createExtensionHarness();
  await harness.execute({ action: "add", text: "Existing context" });
  harness.startContextWindow("deduplicated-window");
  const existing = {
    role: "custom",
    customType: "todo-list-context",
    content: "already present",
    display: false,
    timestamp: 2,
  };
  assert.equal(harness.emit("context", { messages: [contextWindowMarker("deduplicated-window"), existing] }), undefined);
});

test("UI updates and commands honor availability", async () => {
  delete process.env.PI_TODO_WIDGET;
  const interactive = createExtensionHarness();
  await interactive.execute({ action: "add", text: "Visible todo" });
  assert.match(interactive.statusUpdates.at(-1) ?? "", /todo 0 active · 1 pending/);
  assert.equal(interactive.widgetUpdates.length, 1);
  assert.equal(interactive.widgetUpdates.at(-1), undefined, "the widget stays hidden until /todos show");
  await interactive.runCommand("show");
  assert.match(interactive.widgetUpdates.at(-1)?.join("\n") ?? "", /#1 Visible todo/);
  await interactive.runCommand("toggle");
  assert.equal(interactive.widgetUpdates.at(-1), undefined);
  assert.equal(interactive.notifications.at(-1), "Todo widget hidden");
  await interactive.runCommand("gibberish");
  assert.equal(interactive.notifications.at(-1), "Usage: /todos [id|all|toggle|show|hide]");

  const nested = createExtensionHarness();
  await nested.runCommand("show");
  await nested.execute({
    action: "batch",
    operations: Array.from({ length: 10 }, (_, index) => ({ action: "add", text: `Nested ${index + 1}`, ...(index === 0 ? {} : { parentId: index }) })),
  });
  const nestedWidget = nested.widgetUpdates.at(-1) ?? [];
  assert.equal(nestedWidget.length, 9);
  assert.match(nestedWidget[7] ?? "", /#8 Nested 8/);
  assert.equal(nestedWidget[8], "… 2 more");

  const headless = createExtensionHarness();
  headless.setHasUI(false);
  await headless.execute({ action: "add", text: "Headless todo" });
  await headless.runCommand("show");
  assert.equal(headless.widgetUpdates.length, 0);
  assert.equal(headless.statusUpdates.length, 0);
  assert.equal(headless.notifications.length, 0);
});

test("todo_list opts into parallel tool batches and mutates atomically", async () => {
  const harness = createExtensionHarness();
  // Pi serializes an entire tool batch when any tool in it declares executionMode "sequential".
  assert.equal(harness.toolDefinition().executionMode, undefined);

  await harness.execute({ action: "add", text: "Parent" });
  const concurrent = (await Promise.all([
    harness.execute({ action: "add", text: "First child", parentId: 1 }),
    harness.execute({ action: "add", text: "Second child", parentId: 1 }),
    harness.execute({ action: "start", id: 1 }),
  ])) as Array<{ content: Array<{ text: string }> }>;
  assert.match(concurrent[0]!.content[0]!.text, /Added #2: First child/);
  assert.match(concurrent[1]!.content[0]!.text, /Added #3: Second child/);
  assert.match(concurrent[2]!.content[0]!.text, /Started #1: Parent/);

  const branch = harness.branch();
  harness.switchBranch([]);
  harness.switchBranch(branch);
  const listed = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.equal(
    listed.content[0]!.text,
    "TODO: 1 active, 2 pending, 0 completed\n> #1 Parent\n  - #2 First child\n  - #3 Second child",
  );
});

test("namespaced todo_list results cannot change the local list on restore", async () => {
  const source = createExtensionHarness();
  await source.execute({ action: "add", text: "ALPHA retained" });
  await source.execute({ action: "add", text: "BETA retained" });
  for (const details of [
    { source: "unrelated-tool" },
    { version: 7, operations: [{ action: "clear_completed" }, { action: "remove", id: 1 }] },
    { version: 6, state: { items: [], nextId: 1 } },
  ]) {
    const branch = source.branch();
    branch.splice(1, 0, { type: "message", message: {
      role: "toolResult", toolName: "todo_list", namespace: "other", isError: false, details,
    } });
    const resumed = createExtensionHarness();
    for (const restore of [() => resumed.startSession(branch), () => resumed.switchBranch(branch)]) {
      restore();
      assert.equal((await resumed.execute({ action: "list" }))?.content[0]?.text,
        "TODO: 0 active, 2 pending, 0 completed\n- #1 ALPHA retained\n- #2 BETA retained");
      assert.deepEqual(resumed.notifications, []);
    }
  }
});

test("committed mutation details survive a downstream error flag", async () => {
  const source = createExtensionHarness();
  await source.execute({ action: "add", text: "Committed before postprocessing" });
  const branch = source.branch();
  (branch[0]!.message as Record<string, unknown>).isError = true;
  branch.push(
    { type: "message", message: { role: "toolResult", toolName: "todo_list", isError: true } },
    { type: "message", message: { role: "toolResult", toolName: "todo_list", isError: true, details: {} } },
  );
  const resumed = createExtensionHarness();
  resumed.startSession(branch);
  assert.equal((await resumed.execute({ action: "list" }))?.content[0]?.text,
    "TODO: 0 active, 1 pending, 0 completed\n- #1 Committed before postprocessing");
  assert.match((await resumed.execute({ action: "add", text: "After postprocessing" }))?.content[0]?.text ?? "", /Added #2:/);
  assert.deepEqual(resumed.notifications, []);
});

test("error-flagged commits still validate operations and recovery snapshots", async () => {
  for (const invalid of [
    { action: "add", text: "Bad status", status: "blocked" },
    { action: "add", text: "Leaked ref", ref: "temporary" },
    { action: "update", id: "1", text: "Noncanonical ID" },
    { action: "update", id: 1, text: "Unexpected parent", parentId: 1 },
  ]) {
    const harness = createExtensionHarness();
    harness.startSession([
      { type: "message", message: { role: "toolResult", toolName: "todo_list", isError: true, details: {
        version: 6, state: { nextId: 9, items: [{ id: 1, text: "Valid checkpoint", status: "paused" }] },
      } } },
      { type: "message", message: { role: "toolResult", toolName: "todo_list", isError: true, details: {
        version: 7, operations: [{ action: "add", text: "Partial must roll back" }, invalid],
      } } },
      { type: "message", message: { role: "toolResult", toolName: "todo_list", details: {
        version: 7, operations: [{ action: "add", text: "Must not cross corruption" }],
      } } },
    ]);
    const result = await harness.execute({ action: "add", text: "Recovered", status: "in_progress" });
    assert.match(result?.content[0]?.text ?? "", /Warning: Todo history was corrupt[\s\S]*Added #9:/);
    assert.deepEqual(result?.details, { version: 6, state: { nextId: 10, items: [
      { id: 1, text: "Valid checkpoint", status: "paused" },
      { id: 9, text: "Recovered", status: "in_progress" },
    ] } });
  }
});

test("a widget failure cannot discard a persisted mutation", async () => {
  const harness = createExtensionHarness();
  harness.failNextWidgetUpdate();
  await harness.execute({ action: "add", text: "Survives a render failure" }, true);

  const branch = harness.branch();
  harness.switchBranch([]);
  harness.switchBranch(branch);
  const listed = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.match(listed.content[0]!.text, /#1 Survives a render failure/);
});

test("/todos all shows the completed history the agent no longer pays for", async () => {
  const harness = createExtensionHarness();
  await harness.execute({ action: "add", text: "Finished thing" });
  await harness.execute({ action: "complete", id: 1 });

  await harness.runCommand("");
  assert.doesNotMatch(harness.notifications.at(-1) ?? "", /Finished thing/);
  await harness.runCommand("all");
  assert.match(harness.notifications.at(-1) ?? "", /x #1 Finished thing/);

  await harness.execute({
    action: "batch",
    operations: Array.from({ length: 100 }, (_, index) => ({ action: "add", text: `Filler ${index + 1}` })),
  });
  await harness.runCommand("all");
  const truncated = harness.notifications.at(-1) ?? "";
  assert.match(truncated, /Showing 100 of 101/);
  assert.doesNotMatch(truncated, /#101 Filler 100/);
});

test("PI_TODO_WIDGET=show starts the widget visible", async () => {
  process.env.PI_TODO_WIDGET = " Show ";
  try {
    const harness = createExtensionHarness();
    await harness.execute({ action: "add", text: "Configured visible" });
    assert.match(harness.widgetUpdates.at(-1)?.join("\n") ?? "", /#1 Configured visible/);
  } finally {
    delete process.env.PI_TODO_WIDGET;
  }
});

test("compact mutation logs restore branches and skip malformed snapshots", async () => {
  const harness = createExtensionHarness();
  const added = (await harness.execute({ action: "add", text: "Persist me" })) as {
    content: Array<{ text: string }>;
    details?: { version: number; operations?: unknown[]; state?: unknown };
  };
  assert.equal(added.details?.version, 7);
  assert.equal(added.details?.operations?.length, 1);
  assert.equal(added.details?.state, undefined);

  const listed = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }>; details?: unknown };
  assert.deepEqual(listed.details, { version: 7, read: "list" });
  assert.match(listed.content[0]!.text, /#1 Persist me/);
  const savedBranch = harness.branch();

  harness.switchBranch([]);
  const empty = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.equal(empty.content[0]!.text, "No todos");
  harness.switchBranch(savedBranch);
  const restored = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.match(restored.content[0]!.text, /#1 Persist me/);

  const versionOneState = { nextId: 2, items: [{ id: 1, text: "Legacy v1", done: false }] };
  harness.switchBranch([
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 1, action: "add", state: versionOneState } } },
  ]);
  const versionOne = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.match(versionOne.content[0]!.text, /#1 Legacy v1/);

  const legacyState = { nextId: 2, items: [{ id: 1, text: "Legacy v2", status: "pending" }] };
  harness.switchBranch([
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 2, action: "add", state: legacyState } } },
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 2, action: "add", state: null } } },
  ]);
  const legacy = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.match(legacy.content[0]!.text, /#1 Legacy v2/);
});

test("restore validates version-specific legacy snapshot items", async () => {
  const malformedSnapshots = [
    { version: 1, action: "add", state: { nextId: 2, items: [{ id: 1, text: "v1 with status", status: "pending" }] } },
    { version: 1, action: "add", state: { nextId: 2, items: [{ id: 1, text: "v1 conflict", done: false, status: "completed" }] } },
    { version: 2, action: "add", state: { nextId: 2, items: [{ id: 1, text: "v2 with done", done: false }] } },
    { version: 2, action: "add", state: { nextId: 2, items: [{ id: 1, text: "v2 missing status" }] } },
  ];

  for (const details of malformedSnapshots) {
    const harness = createExtensionHarness();
    harness.switchBranch([
      { type: "message", message: { role: "toolResult", toolName: "todo_list", details } },
      { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 3, operations: [{ action: "add", text: "After malformed snapshot" }] } } },
    ]);
    const restored = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
    assert.match(restored.content[0]!.text, /Warning: Todo history was corrupt[\s\S]*No todos/);
    assert.match(harness.notifications.at(-1) ?? "", /restore stopped at corrupt session data/);
  }
});

test("restore stops at conflicting and unknown persisted detail shapes", async () => {
  const corruptDetails = [
    { version: 3, read: "list", operations: [{ action: "add", text: "Conflicting detail" }] },
    { version: 4, state: { nextId: 1, items: [] }, operations: [{ action: "add", text: "Conflicting recovery" }] },
    { version: 99, operations: [{ action: "add", text: "Unknown version" }] },
  ];
  for (const details of corruptDetails) {
    const harness = createExtensionHarness();
    harness.switchBranch([
      { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 3, operations: [{ action: "add", text: "Before gap" }] } } },
      { type: "message", message: { role: "toolResult", toolName: "todo_list", isError: true } },
      { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 3, operations: [{ action: "add", text: "After harmless error" }] } } },
      { type: "message", message: { role: "toolResult", toolName: "todo_list", details } },
      { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 3, operations: [{ action: "add", text: "After gap" }] } } },
    ]);

    const restored = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
    assert.match(restored.content[0]!.text, /#1 Before gap/);
    assert.match(restored.content[0]!.text, /#2 After harmless error/);
    assert.doesNotMatch(restored.content[0]!.text, /After gap|Conflicting detail|Conflicting recovery|Unknown version/);
    assert.match(harness.notifications.at(-1) ?? "", /restore stopped at corrupt session data/);
  }
});

test("restore rolls back a partially corrupt batch", async () => {
  const harness = createExtensionHarness();
  harness.switchBranch([
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 2, action: "add", state: { nextId: 2, items: [{ id: 1, text: "Checkpoint", status: "pending" }] } } } },
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 3, operations: [{ action: "add", text: "Before corrupt batch" }] } } },
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 3, operations: [{ action: "add", text: "Partial" }, { action: "missing" }] } } },
    { type: "message", message: { role: "toolResult", toolName: "todo_list", details: { version: 3, operations: [{ action: "add", text: "After corrupt batch" }] } } },
  ]);

  const added = await harness.execute({ action: "add", text: "Recovered" });
  assert.ok(added);
  assert.match(added.content[0]!.text, /Warning: Todo history was corrupt/);
  assert.match(added.content[0]!.text, /Added #3: Recovered/);
  assert.deepEqual(added.details, {
    version: 6,
    state: {
      nextId: 4,
      items: [
        { id: 1, text: "Checkpoint", status: "pending" },
        { id: 2, text: "Before corrupt batch", status: "pending" },
        { id: 3, text: "Recovered", status: "pending" },
      ],
    },
  });

  const healedBranch = harness.branch();
  harness.switchBranch(healedBranch);
  const resumed = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.match(resumed.content[0]!.text, /#1 Checkpoint/);
  assert.match(resumed.content[0]!.text, /#2 Before corrupt batch/);
  assert.match(resumed.content[0]!.text, /#3 Recovered/);
  assert.doesNotMatch(resumed.content[0]!.text, /Warning: Todo history was corrupt|Partial|After corrupt batch/);

  await harness.execute({ action: "add", text: "After healing" });
  const durableBranch = harness.branch();
  harness.switchBranch(durableBranch);
  const durable = (await harness.execute({ action: "list" })) as { content: Array<{ text: string }> };
  assert.match(durable.content[0]!.text, /#4 After healing/);
});

test("add-only batch-log restore avoids per-log state clones", async (t) => {
  const makeBranch = (size: number) => Array.from({ length: size / 2 }, (_, index) => ({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "todo_list",
      details: { version: 3, operations: [{ action: "add", text: `Todo ${index * 2 + 1}` }, { action: "add", text: `Todo ${index * 2 + 2}` }] },
    },
  }));
  const prepare = (size: number) => {
    const harness = createExtensionHarness();
    harness.setHasUI(false);
    // Copy the fixture once, outside measurement. session_tree still runs the
    // production restore from scratch, not the tool's incremental mutation path.
    harness.switchBranch(makeBranch(size));
    return harness;
  };
  const measure = (harness: ReturnType<typeof createExtensionHarness>, windowMs = 250) => {
    const started = performance.now();
    let runs = 0;
    let elapsed: number;
    do {
      harness.emit("session_tree", {});
      runs += 1;
      elapsed = performance.now() - started;
    } while (elapsed < windowMs);
    return elapsed / runs;
  };
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const smallHarness = prepare(1_000);
  const largeHarness = prepare(4_000);
  // Individual restores can take less than a millisecond. Give both sizes time
  // to warm up, then amortize JIT/GC/scheduling noise over longer windows; a
  // 25ms window still drifted substantially across samples on hosted runners.
  measure(smallHarness, 500);
  measure(largeHarness, 500);
  const samples = [[], []] as [number[], number[]];
  const harnesses = [smallHarness, largeHarness];
  for (let sample = 0; sample < 5; sample += 1) {
    for (const index of sample % 2 === 0 ? [0, 1] : [1, 0]) {
      samples[index]!.push(measure(harnesses[index]!));
    }
  }
  const small = median(samples[0]);
  const large = median(samples[1]);
  t.diagnostic(`Restore ms/run (1000, 4000 todos; >=250ms/sample): ${JSON.stringify(samples)}`);

  // Four times the items permits 6x work, but not per-log cloning's ~16x.
  assert.ok(large < small * 6, `Expected add-only restore to scale near-linearly, got ${small.toFixed(2)}ms -> ${large.toFixed(2)}ms`);
  for (const [harness, size] of [[smallHarness, 1_000], [largeHarness, 4_000]] as const) {
    // Check every restored item outside the timer, independently of replay logic.
    for (let offset = 0; offset < size; offset += 100) {
      const restored = await harness.execute({ action: "list", offset });
      assert.equal(restored?.content[0]?.text, [
        `TODO: 0 active, ${size} pending, 0 completed`,
        ...Array.from({ length: 100 }, (_, index) => `- #${offset + index + 1} Todo ${offset + index + 1}`),
        `Showing ${offset + 1}-${offset + 100} of ${size} open`,
      ].join("\n"));
    }
  }
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

test("a native window ignores older compaction and restores state after newer compaction", async () => {
  const harness = createExtensionHarness();
  await harness.execute({ action: "add", text: "Before compaction" });
  harness.compact(false, "older-compaction");
  harness.startContextWindow("after-compaction");
  assert.equal(harness.emit("before_agent_start", {}), undefined);

  await harness.execute({ action: "add", text: "Inside window" });
  harness.compact(false, "inside-window-compaction");
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0]!.message.content, /#1 Before compaction/);
  assert.match(harness.sent[0]!.message.content, /#2 Inside window/);
  assert.equal(harness.emit("before_agent_start", {}), undefined);
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
    "[TODO LIST - recovery snapshot]\nTODO: 0 active, 0 pending, 1 completed\nLater todo_list results supersede this snapshot.",
  );
  assert.equal(await harness.emit("before_agent_start", {}), undefined);
});

test("compaction refreshes an emptied list", async () => {
  const harness = createExtensionHarness();
  await harness.execute({ action: "add", text: "Temporary" });
  await harness.execute({ action: "remove", id: 1 });
  harness.compact(false, "compaction-empty-history");

  const result = (await harness.emit("before_agent_start", {})) as { message?: { content?: string } } | undefined;
  assert.equal(result?.message?.content, "[TODO LIST - recovery snapshot]\nNo todos\nLater todo_list results supersede this snapshot.");
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
  assert.deepEqual(harness.sent[0]!.options, { deliverAs: "steer" });
  // Overflow retries use agent.continue() in Pi 0.84.1; guard against duplicate context if that lifecycle changes.
  assert.equal(harness.emit("before_agent_start", {}), undefined);
});
