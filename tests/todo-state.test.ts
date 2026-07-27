import assert from "node:assert/strict";
import test from "node:test";
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
