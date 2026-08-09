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

const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];
const CONTEXT_ITEMS_PER_STATUS = 25;
const CONTEXT_TEXT_LENGTH = 160;
const LIST_PAGE_LIMIT = 100;
const MAX_RENDER_DEPTH = 12;

export const emptyState = (): TodoState => ({ items: [], nextId: 1 });

export function cloneState(state: TodoState): TodoState {
  const source = state as TodoState | undefined;
  if (!source || !Array.isArray(source.items)) throw new Error("Invalid todo state");

  const ids = new Set<number>();
  const items = source.items.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid todo item");
    const raw = value as TodoItem & { done?: boolean };
    if (!Number.isSafeInteger(raw.id) || raw.id < 1 || ids.has(raw.id)) throw new Error(`Invalid or duplicate todo id: ${String(raw.id)}`);
    if (typeof raw.text !== "string" || !raw.text.trim()) throw new Error(`Invalid text for todo #${raw.id}`);
    if (raw.parentId !== undefined && (!Number.isSafeInteger(raw.parentId) || raw.parentId < 1)) {
      throw new Error(`Invalid parent for todo #${raw.id}`);
    }

    let status: TodoStatus;
    if (TODO_STATUSES.includes(raw.status)) status = raw.status;
    else if (raw.status === undefined) status = raw.done ? "completed" : "pending";
    else throw new Error(`Invalid status for todo #${raw.id}`);

    ids.add(raw.id);
    return { id: raw.id, text: raw.text.trim(), status, ...(raw.parentId === undefined ? {} : { parentId: raw.parentId }) };
  });

  const byId = new Map(items.map((todo) => [todo.id, todo]));
  for (const todo of items) {
    if (todo.parentId === undefined) continue;
    const parent = byId.get(todo.parentId);
    if (!parent) throw new Error(`Todo #${todo.id} has missing parent #${todo.parentId}`);
    if (parent.status === "completed" && todo.status !== "completed") {
      throw new Error(`Todo #${todo.id} is open under completed parent #${parent.id}`);
    }
  }

  const resolved = new Set<number>();
  for (const todo of items) {
    const path = new Set<number>();
    let current: TodoItem | undefined = todo;
    while (current && !resolved.has(current.id)) {
      if (path.has(current.id)) throw new Error(`Todo hierarchy contains a cycle at #${current.id}`);
      path.add(current.id);
      current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    }
    for (const id of path) resolved.add(id);
  }

  const maxId = items.reduce((max, todo) => Math.max(max, todo.id), 0);
  if (maxId === Number.MAX_SAFE_INTEGER) throw new Error("Todo id limit reached");
  const requestedNextId = Number.isSafeInteger(source.nextId) && source.nextId > 0 ? source.nextId : 1;
  return { items, nextId: Math.max(requestedNextId, maxId + 1) };
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
  const byParent = new Map<number, number[]>();
  for (const candidate of state.items) {
    if (candidate.parentId === undefined) continue;
    const children = byParent.get(candidate.parentId) ?? [];
    children.push(candidate.id);
    byParent.set(candidate.parentId, children);
  }

  const ids = new Set<number>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ids.has(current)) continue;
    ids.add(current);
    stack.push(...(byParent.get(current) ?? []));
  }
  return ids;
}

function ancestorChain(state: TodoState, target: TodoItem): TodoItem[] {
  const byId = new Map(state.items.map((todo) => [todo.id, todo]));
  const seen = new Set([target.id]);
  const ancestors: TodoItem[] = [];
  let parentId = target.parentId;
  while (parentId !== undefined) {
    if (seen.has(parentId)) throw new Error(`Todo hierarchy contains a cycle at #${parentId}`);
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) throw new Error(`Todo #${target.id} has missing parent #${parentId}`);
    ancestors.push(parent);
    parentId = parent.parentId;
  }
  return ancestors;
}

function reopenCompleted(ancestors: TodoItem[]): void {
  for (const ancestor of ancestors) if (ancestor.status === "completed") ancestor.status = "pending";
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
  const ancestors = ancestorChain(state, target);
  target.status = "in_progress";
  reopenCompleted(ancestors);
  return target;
}

export function pauseTodo(state: TodoState, id: number): TodoItem {
  const target = item(state, id);
  const ancestors = ancestorChain(state, target);
  target.status = "pending";
  reopenCompleted(ancestors);
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
  const ancestors = ancestorChain(state, target);
  for (const candidate of state.items) if (ids.has(candidate.id)) candidate.status = "pending";
  reopenCompleted(ancestors);
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
  throw new Error(`Unknown todo action: ${String((operation as { action?: unknown }).action)}`);
}

export function applyTodoBatch(state: TodoState, operations: TodoMutation[]): string[] {
  if (operations.length === 0) throw new Error("operations cannot be empty");
  const draft = cloneState(state);
  const messages: string[] = [];
  for (const [index, operation] of operations.entries()) {
    try {
      messages.push(applyTodoMutation(draft, operation));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Batch operation ${index + 1} (${String(operation.action)}) failed: ${reason}. No changes applied.`);
    }
  }
  state.items = draft.items;
  state.nextId = draft.nextId;
  return messages;
}

export function orderedTodos(
  state: TodoState,
  includeCompleted = true,
  limit = Number.POSITIVE_INFINITY,
  offset = 0,
): Array<{ item: TodoItem; depth: number }> {
  const byParent = new Map<number | undefined, TodoItem[]>();
  for (const candidate of state.items) {
    const siblings = byParent.get(candidate.parentId) ?? [];
    siblings.push(candidate);
    byParent.set(candidate.parentId, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.id - b.id);

  const roots = byParent.get(undefined) ?? [];
  const stack = [...roots].reverse().map((candidate) => ({ item: candidate, depth: 0 }));
  const ordered: Array<{ item: TodoItem; depth: number }> = [];
  const visited = new Set<number>();
  let visibleIndex = 0;
  while (stack.length > 0 && ordered.length < limit) {
    const row = stack.pop()!;
    if (visited.has(row.item.id)) continue;
    visited.add(row.item.id);
    if (!includeCompleted && row.item.status === "completed") continue;

    if (visibleIndex >= offset) ordered.push(row);
    visibleIndex += 1;
    const children = byParent.get(row.item.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ item: children[index]!, depth: row.depth + 1 });
    }
  }
  return ordered;
}

export function todoCounts(state: TodoState): { pending: number; inProgress: number; completed: number } {
  const counts = { pending: 0, inProgress: 0, completed: 0 };
  for (const todo of state.items) {
    if (todo.status === "pending") counts.pending += 1;
    else if (todo.status === "in_progress") counts.inProgress += 1;
    else counts.completed += 1;
  }
  return counts;
}

export function formatTodoCounts(state: TodoState): string {
  const counts = todoCounts(state);
  return `TODO: ${counts.inProgress} active, ${counts.pending} pending, ${counts.completed} completed`;
}

function formatRows(rows: Array<{ item: TodoItem; depth: number }>): string {
  return rows
    .map(({ item: todo, depth }) => {
      const marker = todo.status === "in_progress" ? ">" : todo.status === "completed" ? "x" : "-";
      const indent = `${"  ".repeat(Math.min(depth, MAX_RENDER_DEPTH))}${depth > MAX_RENDER_DEPTH ? "… " : ""}`;
      return `${indent}${marker} #${todo.id} ${todo.text}`;
    })
    .join("\n");
}

export function formatTodos(state: TodoState, includeCompleted = true): string {
  const rows = orderedTodos(state, includeCompleted);
  return rows.length > 0 ? formatRows(rows) : "No todos";
}

export function formatTodoSnapshot(state: TodoState, includeCompleted = false): string {
  if (state.items.length === 0) return "No todos";
  const rows = formatTodos(state, includeCompleted);
  return rows === "No todos" ? formatTodoCounts(state) : `${formatTodoCounts(state)}\n${rows}`;
}

export function formatTodoPage(state: TodoState, offset = 0, limit = LIST_PAGE_LIMIT): string {
  if (state.items.length === 0) return "No todos";
  const start = Math.max(0, Math.floor(offset));
  const pageSize = Math.min(LIST_PAGE_LIMIT, Math.max(1, Math.floor(limit)));
  const rows = orderedTodos(state, true, pageSize, start);
  const counts = formatTodoCounts(state);
  if (rows.length === 0) return `${counts}\nNo todos at offset ${start}; ${state.items.length} total`;

  const page = `${counts}\n${formatRows(rows)}`;
  if (start === 0 && rows.length === state.items.length) return page;
  return `${page}\nShowing ${start + 1}-${start + rows.length} of ${state.items.length}`;
}

function shorten(text: string): string {
  const characters = [...text];
  return characters.length <= CONTEXT_TEXT_LENGTH ? text : `${characters.slice(0, CONTEXT_TEXT_LENGTH - 1).join("")}…`;
}

export function formatTodoContext(state: TodoState): string {
  if (state.items.length === 0) return "No todos";
  const counts = todoCounts(state);
  const active = state.items.filter((todo) => todo.status === "in_progress").sort((a, b) => a.id - b.id);
  const pending = state.items.filter((todo) => todo.status === "pending").sort((a, b) => a.id - b.id);
  const shown = [...active.slice(0, CONTEXT_ITEMS_PER_STATUS), ...pending.slice(0, CONTEXT_ITEMS_PER_STATUS)];
  if (shown.length === 0) return formatTodoCounts(state);

  const lines = shown.map((todo) => {
    const marker = todo.status === "in_progress" ? ">" : "-";
    return `${marker} #${todo.id} ${shorten(todo.text)}${todo.parentId === undefined ? "" : ` (under #${todo.parentId})`}`;
  });
  const hiddenActive = counts.inProgress - Math.min(counts.inProgress, CONTEXT_ITEMS_PER_STATUS);
  const hiddenPending = counts.pending - Math.min(counts.pending, CONTEXT_ITEMS_PER_STATUS);
  if (hiddenActive + hiddenPending > 0) {
    const hidden = [hiddenActive > 0 ? `${hiddenActive} active` : "", hiddenPending > 0 ? `${hiddenPending} pending` : ""].filter(Boolean).join(" and ");
    lines.push(`… ${hidden} not shown; use todo_list list with offset to continue`);
  }
  return `${formatTodoCounts(state)}\n${lines.join("\n")}`;
}
