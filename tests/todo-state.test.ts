import assert from "node:assert/strict";
import test from "node:test";
import {
  addTodo,
  applyTodoBatch,
  clearCompleted,
  cloneState,
  emptyState,
  formatTodos,
  moveTodo,
  removeTodo,
  setTodoDone,
  updateTodo,
} from "../extensions/todo-state.ts";

test("nested todo lifecycle", () => {
  const state = emptyState();
  assert.throws(() => addTodo(state, "  "), /cannot be empty/);
  assert.equal(state.nextId, 1);
  const parent = addTodo(state, "Ship extension");
  const child = addTodo(state, "Run checks", parent.id);
  updateTodo(state, child.id, "Run validation");

  assert.equal(formatTodos(state), "[ ] #1 Ship extension\n  [ ] #2 Run validation");
  assert.equal(setTodoDone(state, parent.id, true), 2);
  assert.equal(formatTodos(state, false), "No todos");
  assert.equal(setTodoDone(state, child.id, false), 1);
  assert.equal(parent.done, false);
  assert.equal(setTodoDone(state, parent.id, false), 2);

  const laterParent = addTodo(state, "Later parent");
  moveTodo(state, parent.id, laterParent.id);
  assert.equal(setTodoDone(state, laterParent.id, true), 3);
  assert.equal(setTodoDone(state, laterParent.id, false), 3);
  moveTodo(state, parent.id);
  removeTodo(state, laterParent.id);

  moveTodo(state, child.id);
  assert.throws(() => moveTodo(state, parent.id, parent.id), /itself or its descendant/);
  assert.equal(removeTodo(state, parent.id), 1);
  setTodoDone(state, child.id, true);
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
    ]),
    ["Added #1: First", "Added #2: Second", "Updated #2: Updated second"],
  );
  assert.equal(formatTodos(state), "[ ] #1 First\n  [ ] #2 Updated second");

  const before = cloneState(state);
  assert.throws(
    () => applyTodoBatch(state, [{ action: "update", id: 1, text: "Changed" }, { action: "remove", id: 999 }]),
    /not found/,
  );
  assert.deepEqual(state, before);
});
