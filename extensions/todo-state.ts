export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: number;
  text: string;
  status: TodoStatus;
  parentId?: number;
}

export interface TodoState {
  items: TodoItem[];
  nextId: number;
}

export const TODO_MUTATIONS = [
  "add",
  "update",
  "move",
  "start",
  "pause",
  "complete",
  "reopen",
  "remove",
  "clear_completed",
] as const;
export type TodoMutationAction = (typeof TODO_MUTATIONS)[number];
export interface TodoMutation {
  action: TodoMutationAction;
  id?: number;
  text?: string;
  parentId?: number;
}

export const emptyState = (): TodoState => ({ items: [], nextId: 1 });

export function cloneState(state: TodoState): TodoState {
  return {
    items: state.items.map((item) => {
      const legacy = item as TodoItem & { done?: boolean };
      const { done, ...copy } = legacy;
      return { ...copy, status: copy.status ?? (done ? "completed" : "pending") };
    }),
    nextId: state.nextId,
  };
}

function item(state: TodoState, id: number): TodoItem {
  const found = state.items.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Todo #${id} not found`);
  return found;
}

function concise(text: string): string {
  const value = text.trim();
  if (!value) throw new Error("Todo text cannot be empty");
  return value;
}

function descendants(state: TodoState, id: number): Set<number> {
  const ids = new Set([id]);
  // ponytail: O(n²) keeps this obvious; index children if lists ever become large.
  while (true) {
    const before = ids.size;
    for (const candidate of state.items) {
      if (candidate.parentId !== undefined && ids.has(candidate.parentId)) ids.add(candidate.id);
    }
    if (ids.size === before) return ids;
  }
}

function reopenCompletedAncestors(state: TodoState, target: TodoItem): void {
  let parentId = target.parentId;
  while (parentId !== undefined) {
    const parent = item(state, parentId);
    if (parent.status === "completed") parent.status = "pending";
    parentId = parent.parentId;
  }
}

export function addTodo(state: TodoState, text: string, parentId?: number): TodoItem {
  const value = concise(text);
  if (parentId !== undefined && item(state, parentId).status === "completed") throw new Error("Cannot add under a completed todo");
  const added = { id: state.nextId++, text: value, status: "pending" as const, ...(parentId === undefined ? {} : { parentId }) };
  state.items.push(added);
  return added;
}

export function updateTodo(state: TodoState, id: number, text: string): TodoItem {
  const found = item(state, id);
  found.text = concise(text);
  return found;
}

export function moveTodo(state: TodoState, id: number, parentId?: number): TodoItem {
  const found = item(state, id);
  if (parentId !== undefined) {
    const parent = item(state, parentId);
    if (descendants(state, id).has(parent.id)) throw new Error("Cannot move a todo under itself or its descendant");
    if (parent.status === "completed") throw new Error("Cannot move under a completed todo");
    found.parentId = parentId;
  } else {
    delete found.parentId;
  }
  return found;
}

export function startTodo(state: TodoState, id: number): TodoItem {
  const target = item(state, id);
  target.status = "in_progress";
  reopenCompletedAncestors(state, target);
  return target;
}

export function pauseTodo(state: TodoState, id: number): TodoItem {
  const target = item(state, id);
  target.status = "pending";
  reopenCompletedAncestors(state, target);
  return target;
}

export function completeTodo(state: TodoState, id: number): number {
  const ids = descendants(state, item(state, id).id);
  for (const candidate of state.items) if (ids.has(candidate.id)) candidate.status = "completed";
  return ids.size;
}

export function reopenTodo(state: TodoState, id: number): number {
  const target = item(state, id);
  const ids = descendants(state, target.id);
  for (const candidate of state.items) if (ids.has(candidate.id)) candidate.status = "pending";
  reopenCompletedAncestors(state, target);
  return ids.size;
}

export function removeTodo(state: TodoState, id: number): number {
  const ids = descendants(state, item(state, id).id);
  state.items = state.items.filter((candidate) => !ids.has(candidate.id));
  return ids.size;
}

export function clearCompleted(state: TodoState): number {
  const before = state.items.length;
  state.items = state.items.filter((candidate) => candidate.status !== "completed");
  return before - state.items.length;
}

function requiredId(operation: TodoMutation): number {
  if (operation.id === undefined) throw new Error("id is required for this action");
  return operation.id;
}

function requiredText(operation: TodoMutation): string {
  if (operation.text === undefined) throw new Error("text is required for this action");
  return operation.text;
}

export function applyTodoMutation(state: TodoState, operation: TodoMutation): string {
  switch (operation.action) {
    case "add": {
      const todo = addTodo(state, requiredText(operation), operation.parentId);
      return `Added #${todo.id}: ${todo.text}`;
    }
    case "update": {
      const todo = updateTodo(state, requiredId(operation), requiredText(operation));
      return `Updated #${todo.id}: ${todo.text}`;
    }
    case "move": {
      const todo = moveTodo(state, requiredId(operation), operation.parentId);
      return `Moved #${todo.id}${todo.parentId === undefined ? " to top level" : ` under #${todo.parentId}`}`;
    }
    case "start": {
      const todo = startTodo(state, requiredId(operation));
      return `Started #${todo.id}: ${todo.text}`;
    }
    case "pause": {
      const todo = pauseTodo(state, requiredId(operation));
      return `Paused #${todo.id}: ${todo.text}`;
    }
    case "complete": {
      const id = requiredId(operation);
      const count = completeTodo(state, id);
      return `Completed #${id}${count > 1 ? ` and ${count - 1} nested item(s)` : ""}`;
    }
    case "reopen": {
      const id = requiredId(operation);
      const count = reopenTodo(state, id);
      return `Reopened #${id}${count > 1 ? ` and ${count - 1} nested item(s)` : ""}`;
    }
    case "remove": {
      const id = requiredId(operation);
      const count = removeTodo(state, id);
      return `Removed #${id}${count > 1 ? ` and ${count - 1} nested item(s)` : ""}`;
    }
    case "clear_completed":
      return `Removed ${clearCompleted(state)} completed item(s)`;
  }
}

export function applyTodoBatch(state: TodoState, operations: TodoMutation[]): string[] {
  if (operations.length === 0) throw new Error("operations cannot be empty");
  const draft = cloneState(state);
  const messages = operations.map((operation) => applyTodoMutation(draft, operation));
  state.items = draft.items;
  state.nextId = draft.nextId;
  return messages;
}

export function orderedTodos(state: TodoState, includeCompleted = true): Array<{ item: TodoItem; depth: number }> {
  const byParent = new Map<number | undefined, TodoItem[]>();
  for (const candidate of state.items) {
    const siblings = byParent.get(candidate.parentId) ?? [];
    siblings.push(candidate);
    byParent.set(candidate.parentId, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.id - b.id);

  const ordered: Array<{ item: TodoItem; depth: number }> = [];
  const visit = (parentId: number | undefined, depth: number) => {
    for (const candidate of byParent.get(parentId) ?? []) {
      if (includeCompleted || candidate.status !== "completed") ordered.push({ item: candidate, depth });
      visit(candidate.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return ordered;
}

export function todoCounts(state: TodoState): { pending: number; inProgress: number; completed: number } {
  return {
    pending: state.items.filter((item) => item.status === "pending").length,
    inProgress: state.items.filter((item) => item.status === "in_progress").length,
    completed: state.items.filter((item) => item.status === "completed").length,
  };
}

export function formatTodoCounts(state: TodoState): string {
  const counts = todoCounts(state);
  return `TODO: ${counts.inProgress} active, ${counts.pending} pending, ${counts.completed} completed`;
}

export function formatTodos(state: TodoState, includeCompleted = true): string {
  const rows = orderedTodos(state, includeCompleted);
  return rows.length
    ? rows
        .map(({ item: todo, depth }) => {
          const marker = todo.status === "in_progress" ? ">" : todo.status === "completed" ? "x" : "-";
          return `${"  ".repeat(depth)}${marker} #${todo.id} ${todo.text}`;
        })
        .join("\n")
    : "No todos";
}

export function formatTodoSnapshot(state: TodoState, includeCompleted = false): string {
  if (state.items.length === 0) return "No todos";
  const rows = formatTodos(state, includeCompleted);
  return rows === "No todos" ? formatTodoCounts(state) : `${formatTodoCounts(state)}\n${rows}`;
}
