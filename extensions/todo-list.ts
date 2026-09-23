import { StringEnum } from "@earendil-works/pi-ai";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyTodoBatch,
  applyTodoMutation,
  normalizeTodoMutation,
  cloneState,
  emptyState,
  formatTodoContext,
  formatTodoCounts,
  formatTodoDetail,
  formatRows,
  formatTodoPage,
  orderedTodos,
  todoCounts,
  LIST_PAGE_LIMIT,
  TODO_MUTATIONS,
  TODO_TEXT_LIMIT,
  TODO_LINK_LIMIT,
  TODO_REF_LIMIT,
  TODO_STATUSES,
  BATCH_OPERATION_LIMIT,
  type TodoMutation,
  type TodoState,
} from "./todo-state.ts";

const ACTIONS = ["list", ...TODO_MUTATIONS, "batch"] as const;
const TODO_CONTEXT_TYPE = "todo-list-context";
const DETAILS_VERSION = 7;
const RECOVERY_VERSION = 6;
const WIDGET_LIMIT = 8;

interface LegacySnapshotDetails {
  version: 1 | 2;
  action: string;
  state: unknown;
}
interface RecoveryDetails {
  version: 4 | 6;
  state: unknown;
}
type SnapshotDetails = LegacySnapshotDetails | RecoveryDetails;
interface MutationDetails {
  version: 3 | 5 | 7;
  operations: TodoMutation[];
}
interface ReadDetails {
  version: 3 | 5 | 7;
  read: "list";
}
const Link = Type.Optional(Type.Union([
  Type.String({ minLength: 1, maxLength: TODO_LINK_LIMIT }),
  Type.Null(),
], { description: "URL or note/file path for details on add or update; null clears it. Keep evidence out of the title" }));

const Status = Type.Optional(StringEnum(TODO_STATUSES, { description: "Initial status for add; defaults to pending" }));
const BatchId = Type.Optional(Type.Union([
  Type.Integer({ minimum: 1 }),
  Type.String({ minLength: 1, maxLength: TODO_REF_LIMIT }),
], { description: "Existing numeric todo ID or an earlier add's ref in this batch" }));

const Mutation = Type.Object({
  action: StringEnum(TODO_MUTATIONS),
  id: BatchId,
  text: Type.Optional(Type.String({ minLength: 1, maxLength: TODO_TEXT_LIMIT })),
  link: Link,
  parentId: BatchId,
  status: Status,
  ref: Type.Optional(Type.String({ minLength: 1, maxLength: TODO_REF_LIMIT, description: "Label on add for later id/parentId references in this batch only" })),
});

const Params = Type.Object({
  action: StringEnum(ACTIONS),
  id: Type.Optional(Type.Integer({ minimum: 1, description: "Todo ID for list (one item with its detail link), update, move, start, pause, complete, reopen, or remove" })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: TODO_TEXT_LIMIT, description: "Short action title for add or update; put hashes, logs, and evidence in the linked details" })),
  link: Link,
  status: Status,
  parentId: Type.Optional(Type.Integer({ minimum: 1, description: "Parent todo ID for add or move; omit on move to make it top-level" })),
  operations: Type.Optional(Type.Array(Mutation, { minItems: 1, maxItems: BATCH_OPERATION_LIMIT, description: "Required for batch. Ordered mutations applied atomically" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based offset into the open items" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIST_PAGE_LIMIT, description: `Page size for open items (default and maximum ${LIST_PAGE_LIMIT})` })),
});

const NOT_TODO_RESULT = Symbol("not-todo-result");
const NO_TODO_CHANGE = Symbol("no-todo-change");
type BranchEntry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];

function entryDetails(entry: BranchEntry): unknown {
  if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo_list") {
    if ("namespace" in entry.message && entry.message.namespace !== undefined) return NOT_TODO_RESULT;
    const { details, isError } = entry.message;
    // A result hook can mark a committed mutation as an error after execute returns.
    if (isError && !isSnapshot(details) && !isMutationLog(details) && !isReadMarker(details)) return NO_TODO_CHANGE;
    return details;
  }
  return NOT_TODO_RESULT;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSnapshot(details: unknown): details is SnapshotDetails {
  if (!details || typeof details !== "object") return false;
  const candidate = details as { version?: unknown; action?: unknown };
  if (candidate.version === 4 || candidate.version === RECOVERY_VERSION) return hasExactKeys(details, ["version", "state"]);
  return (candidate.version === 1 || candidate.version === 2)
    && typeof candidate.action === "string"
    && hasExactKeys(details, ["version", "action", "state"]);
}

function isMutationLog(details: unknown): details is MutationDetails {
  if (!details || typeof details !== "object") return false;
  const candidate = details as { version?: unknown; operations?: unknown };
  return (candidate.version === 3 || candidate.version === 5 || candidate.version === DETAILS_VERSION)
    && Array.isArray(candidate.operations)
    && candidate.operations.length > 0
    && candidate.operations.length <= BATCH_OPERATION_LIMIT
    && hasExactKeys(details, ["version", "operations"]);
}

function isReadMarker(details: unknown): details is ReadDetails {
  if (!details || typeof details !== "object") return false;
  const candidate = details as { version?: unknown; read?: unknown };
  return (candidate.version === 3 || candidate.version === 5 || candidate.version === DETAILS_VERSION) && candidate.read === "list" && hasExactKeys(details, ["version", "read"]);
}

function validatedSnapshot(details: SnapshotDetails): TodoState | undefined {
  if (!details.state || typeof details.state !== "object") return undefined;
  const state = details.state as { items?: unknown };
  if (!Array.isArray(state.items)) return undefined;
  for (const value of state.items) {
    if (!value || typeof value !== "object") return undefined;
    const item = value as Record<string, unknown>;
    if (details.version === 1) {
      if (!Object.hasOwn(item, "done") || typeof item.done !== "boolean" || "status" in item) return undefined;
    } else if (!Object.hasOwn(item, "status") || typeof item.status !== "string" || "done" in item) return undefined;
  }
  try {
    return cloneState(details.state as TodoState);
  } catch {
    return undefined;
  }
}

function decodeLegacyOperation(value: unknown, version: 3 | 5): TodoMutation {
  if (!value || typeof value !== "object") throw new Error("Invalid legacy todo operation");
  const old = value as TodoMutation;
  // Old logs kept ignored inputs, including update.parentId and add.status/ref.
  const operation: TodoMutation = { action: old.action };
  if (old.action !== "add" && old.action !== "clear_completed") operation.id = old.id;
  if (old.action === "add" || old.action === "update") {
    operation.text = old.text;
    if (version === 5) operation.link = old.link;
  }
  if (old.action === "add" || old.action === "move") operation.parentId = old.parentId;
  return normalizeTodoMutation(operation);
}

function replayLog(state: TodoState, log: MutationDetails): void {
  for (const stored of log.operations) {
    const operation = log.version === DETAILS_VERSION ? normalizeTodoMutation(stored) : decodeLegacyOperation(stored, log.version);
    applyTodoMutation(state, operation, false);
    // Before v5, pause meant pending. Preserve the state of those older branches.
    if (log.version === 3 && operation.action === "pause") state.items.find((todo) => todo.id === operation.id)!.status = "pending";
  }
}

function restore(branch: BranchEntry[], endIndex = branch.length): { state: TodoState; recoveryNeeded: boolean } {
  let restored = emptyState();
  let checkpointIndex = -1;
  let restoreStopped = false;

  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const details = entryDetails(branch[index]!);
    if (!isSnapshot(details)) continue;
    const checkpoint = validatedSnapshot(details);
    if (!checkpoint) {
      restoreStopped = true;
      continue;
    }
    restored = checkpoint;
    checkpointIndex = index;
    break;
  }

  const base = cloneState(restored);
  const appliedLogs: MutationDetails[] = [];
  for (let index = checkpointIndex + 1; index < endIndex; index += 1) {
    const details = entryDetails(branch[index]!);
    if (details === NOT_TODO_RESULT || details === NO_TODO_CHANGE) continue;
    if (isReadMarker(details)) continue;
    if (!isMutationLog(details)) {
      restoreStopped = true;
      break;
    }
    try {
      replayLog(restored, details);
      appliedLogs.push(details);
    } catch {
      try {
        restored = cloneState(base);
        for (const log of appliedLogs) replayLog(restored, log);
      } catch {
        restored = emptyState();
      }
      restoreStopped = true;
      break;
    }
  }

  return { state: restored, recoveryNeeded: restoreStopped };
}

export default function todoListExtension(pi: ExtensionAPI): void {
  let state = emptyState();
  let recoveryNeeded = false;
  let widgetVisible = process.env.PI_TODO_WIDGET?.trim().toLowerCase() === "show";
  let windowContext: { id: string; message: ContextEvent["messages"][number] | null } | undefined;

  const todoContextMessage = (snapshot = state) => ({
    customType: TODO_CONTEXT_TYPE,
    content: `[TODO LIST - recovery snapshot]\n${formatTodoContext(snapshot)}\nLater todo_list results supersede this snapshot.`,
    display: false,
  });

  const needsTodoContext = (ctx: ExtensionContext): boolean => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index]!;
      if (entry.type === "custom_message" && entry.customType === TODO_CONTEXT_TYPE) return false;
      if ((entry as { type: string }).type === "context_window") return false;
      if (entry.type === "compaction") return true;
    }
    return false;
  };

  const updateWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const counts = todoCounts(state);
    const openCount = counts.inProgress + counts.pending + counts.paused;
    if (openCount === 0) {
      ctx.ui.setWidget("todo-list", undefined);
      ctx.ui.setStatus("todo-list", undefined);
      return;
    }

    ctx.ui.setStatus("todo-list", `todo ${counts.inProgress} active · ${counts.pending} pending${counts.paused ? ` · ${counts.paused} paused` : ""}`);
    if (!widgetVisible) {
      ctx.ui.setWidget("todo-list", undefined);
      return;
    }

    const visible = orderedTodos(state, false, WIDGET_LIMIT);
    const lines = visible.map(({ item, depth }) => {
      const active = item.status === "in_progress";
      const paused = item.status === "paused";
      // A row appears only once all of its ancestors have, so depth stays below
      // WIDGET_LIMIT here and never reaches the cap that paged output needs.
      return `${"  ".repeat(depth)}${active ? "◉" : paused ? "⏸" : "○"} #${item.id} ${item.text}${item.link ? " [details]" : ""}`;
    });
    if (openCount > visible.length) lines.push(`… ${openCount - visible.length} more`);
    ctx.ui.setWidget("todo-list", lines);
  };

  const rehydrate = (ctx: ExtensionContext): void => {
    windowContext = undefined;
    const restored = restore(ctx.sessionManager.getBranch());
    state = restored.state;
    recoveryNeeded = restored.recoveryNeeded;
    if (recoveryNeeded && ctx.hasUI) ctx.ui.notify("Todo restore stopped at corrupt session data; later changes were not replayed.", "warning");
    updateWidget(ctx);
  };

  const hasTodoHistory = (): boolean => state.items.length > 0 || state.nextId > 1;

  pi.on("session_start", (_event, ctx) => rehydrate(ctx));
  pi.on("session_tree", (_event, ctx) => rehydrate(ctx));

  pi.on("context", (event, ctx) => {
    if (event.messages.some((message) => message.role === "custom" && message.customType === TODO_CONTEXT_TYPE)) return;
    const markerIndex = event.messages.findIndex((message) =>
      message.role === "custom"
      && message.customType === "context-window"
      && message.details !== null
      && typeof message.details === "object"
      && typeof (message.details as { windowId?: unknown }).windowId === "string"
    );
    if (markerIndex < 0) return;

    const marker = event.messages[markerIndex] as ContextEvent["messages"][number] & { details: { windowId: string } };
    const windowId = marker.details.windowId;
    if (windowContext?.id !== windowId) {
      const branch = ctx.sessionManager.getBranch();
      const boundaryIndex = branch.findIndex((entry) =>
        (entry as { type: string }).type === "context_window" && entry.id === windowId
      );
      if (boundaryIndex < 0) return;
      const snapshot = restore(branch, boundaryIndex).state;
      windowContext = {
        id: windowId,
        message: snapshot.items.length > 0 || snapshot.nextId > 1
          ? { role: "custom", ...todoContextMessage(snapshot), timestamp: marker.timestamp }
          : null,
      };
    }
    const message = windowContext?.message;
    if (!message) return;
    return { messages: [...event.messages.slice(0, markerIndex + 1), structuredClone(message), ...event.messages.slice(markerIndex + 1)] };
  });

  // A later compaction drops a native window's transient marker and snapshot.
  // Queue live state for that window, overflow retries, and between-turn compaction.
  pi.on("session_compact", (event, ctx) => {
    const inNativeWindow = ctx.sessionManager.getBranch().some((entry) =>
      (entry as { type: string }).type === "context_window"
    );
    if ((event.reason === "threshold" || event.willRetry || inNativeWindow) && hasTodoHistory()) {
      pi.sendMessage(todoContextMessage(), { deliverAs: "steer" });
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (hasTodoHistory() && needsTodoContext(ctx)) return { message: todoContextMessage() };
  });

  pi.registerTool({
    name: "todo_list",
    label: "Todo List",
    description: "Manage persistent nested todos with pending, in-progress, paused, and completed states, including atomic batches. list shows open titles and counts; list with id shows one item and its detail link",
    promptSnippet: "Track current work with short titles, detail links, and a distinct paused state across context compaction",
    promptGuidelines: [
      "Use todo_list at the start or resumption of multi-step work. Start items before working, complete them after verification, and pause interrupted work.",
      "Use short action titles in todo_list; keep hashes, logs, and evidence in a linked note/file or URL via link. Use list with id to retrieve that link. When using notes, update one concise current summary in place: goal, current state, next step, blockers, and evidence links, not a running history.",
      "Update stale todo_list titles and statuses when plans change; remove work that no longer applies. Batch related mutations. Leave no item open when you report multi-step work finished; the counts in each result cover that without an extra call.",
      "Starting, pausing, or reopening a nested todo with todo_list reopens completed ancestors.",
      "Use todo_list add with status to create work in its current state. In a batch, label additions with ref and use those labels as later id/parentId values.",
    ],
    parameters: Params,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let message: string;
      let details: MutationDetails | ReadDetails | RecoveryDetails;
      if (params.status !== undefined && params.action !== "add") throw new Error("status is only supported for add");
      if (Object.hasOwn(params, "ref")) throw new Error("ref is only supported on add inside a batch");
      if (params.action === "list") {
        message = params.id === undefined
          ? formatTodoPage(state, params.offset ?? 0, params.limit ?? LIST_PAGE_LIMIT)
          : formatTodoDetail(state, params.id);
        details = { version: DETAILS_VERSION, read: "list" };
      } else if (params.action === "batch") {
        if (!params.operations) throw new Error("operations is required for batch");
        const batch = applyTodoBatch(state, params.operations);
        message = `Applied ${batch.messages.length} operation(s):\n${batch.messages.map((result) => `- ${result}`).join("\n")}`;
        details = { version: DETAILS_VERSION, operations: batch.operations };
      } else {
        const operation = normalizeTodoMutation(params);
        message = applyTodoMutation(state, operation);
        details = { version: DETAILS_VERSION, operations: [operation] };
      }

      // State is already mutated; a render failure must not prevent returning its commit.
      try {
        updateWidget(ctx);
      } catch {}
      const recovering = recoveryNeeded;
      if (recovering) {
        details = { version: RECOVERY_VERSION, state: cloneState(state) };
        recoveryNeeded = false;
      }
      const result = params.action === "list" ? message : `${message}\n${formatTodoCounts(state)}`;
      const notice = recovering
        ? "Warning: Todo history was corrupt; later changes were not replayed. Saved the current list as a recovery checkpoint.\n"
        : "";
      return { content: [{ type: "text", text: `${notice}${result}` }], details };
    },
  });

  pi.registerCommand("todos", {
    description: "Show open todos, /todos <id> for details, /todos all for completed history, or /todos toggle|show|hide for the widget",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const command = args.trim();
      if (["toggle", "show", "hide"].includes(command)) {
        widgetVisible = command === "show" || (command === "toggle" && !widgetVisible);
        updateWidget(ctx);
        ctx.ui.notify(`Todo widget ${widgetVisible ? "shown" : "hidden"}`, "info");
      } else if (!command) {
        ctx.ui.notify(formatTodoPage(state), "info");
      } else if (/^\d+$/.test(command) && Number.isSafeInteger(Number(command)) && Number(command) > 0) {
        try {
          ctx.ui.notify(formatTodoDetail(state, Number(command)), "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
      } else if (command === "all") {
        // The agent pays tokens for every list; a human reading /todos does not.
        const rows = orderedTodos(state, true, LIST_PAGE_LIMIT);
        const more = rows.length < state.items.length ? `\nShowing ${rows.length} of ${state.items.length}` : "";
        ctx.ui.notify(rows.length === 0 ? "No todos" : `${formatTodoCounts(state)}\n${formatRows(rows)}${more}`, "info");
      } else {
        ctx.ui.notify("Usage: /todos [id|all|toggle|show|hide]", "warning");
      }
    },
  });
}
