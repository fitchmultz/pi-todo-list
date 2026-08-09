import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyTodoBatch,
  applyTodoMutation,
  cloneState,
  emptyState,
  formatTodoContext,
  formatTodoCounts,
  formatTodoPage,
  orderedTodos,
  todoCounts,
  TODO_MUTATIONS,
  type TodoMutation,
  type TodoState,
} from "./todo-state.ts";

const ACTIONS = ["list", ...TODO_MUTATIONS, "batch"] as const;
const TODO_CONTEXT_TYPE = "todo-list-context";
const DETAILS_VERSION = 3;
const LIST_LIMIT = 100;
const WIDGET_LIMIT = 8;

type Action = (typeof ACTIONS)[number];
interface SnapshotDetails {
  version: 1 | 2 | 3;
  state: TodoState;
}
interface MutationDetails {
  version: 3;
  operations: TodoMutation[];
}
type TodoDetails = SnapshotDetails | MutationDetails;

const Mutation = Type.Object({
  action: StringEnum(TODO_MUTATIONS),
  id: Type.Optional(Type.Integer({ minimum: 1 })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  parentId: Type.Optional(Type.Integer({ minimum: 1 })),
});

const Params = Type.Object({
  action: StringEnum(ACTIONS),
  id: Type.Optional(Type.Integer({ minimum: 1, description: "Todo ID for update, move, start, pause, complete, reopen, or remove" })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 240, description: "Concise todo text for add or update" })),
  parentId: Type.Optional(Type.Integer({ minimum: 1, description: "Parent todo ID for add or move; omit on move to make it top-level" })),
  operations: Type.Optional(Type.Array(Mutation, { minItems: 1, maxItems: 100, description: "Required for batch. Ordered mutations applied atomically" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based list offset" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIST_LIMIT, description: `List page size (default and maximum ${LIST_LIMIT})` })),
});

function entryDetails(entry: unknown): TodoDetails | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const candidate = entry as {
    type?: string;
    customType?: string;
    details?: unknown;
    message?: { role?: string; toolName?: string; details?: unknown };
  };
  if (candidate.type === "message" && candidate.message?.role === "toolResult" && candidate.message.toolName === "todo_list") {
    return candidate.message.details as TodoDetails | undefined;
  }
  if (candidate.type === "custom_message" && candidate.customType === TODO_CONTEXT_TYPE) {
    return candidate.details as TodoDetails | undefined;
  }
  return undefined;
}

function isSnapshot(details: TodoDetails | undefined): details is SnapshotDetails {
  return !!details && [1, 2, 3].includes(details.version) && "state" in details;
}

function isMutationLog(details: TodoDetails | undefined): details is MutationDetails {
  return details?.version === DETAILS_VERSION && "operations" in details && Array.isArray(details.operations);
}

function restore(ctx: ExtensionContext): TodoState {
  const branch = ctx.sessionManager.getBranch();
  let restored = emptyState();
  let checkpointIndex = -1;

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const details = entryDetails(branch[index]);
    if (!isSnapshot(details)) continue;
    try {
      restored = cloneState(details.state);
      checkpointIndex = index;
      break;
    } catch {
      // Ignore malformed historical state and keep looking for a valid checkpoint.
    }
  }

  for (let index = checkpointIndex + 1; index < branch.length; index += 1) {
    const details = entryDetails(branch[index]);
    if (!isMutationLog(details)) continue;
    try {
      if (details.operations.length === 1) applyTodoMutation(restored, details.operations[0]!);
      else applyTodoBatch(restored, details.operations);
    } catch {
      // Later ID-based mutations are unsafe once replay has a gap.
      break;
    }
  }
  return restored;
}

export default function todoListExtension(pi: ExtensionAPI): void {
  let state = emptyState();
  let widgetVisible = true;

  const todoContextMessage = () => ({
    customType: TODO_CONTEXT_TYPE,
    content: `[TODO LIST - state after compaction]\n${formatTodoContext(state)}\nKeep this list current with todo_list.`,
    display: false,
    details: { version: DETAILS_VERSION, state: cloneState(state) } satisfies SnapshotDetails,
  });

  const needsTodoContext = (ctx: ExtensionContext): boolean => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index]!;
      if (entry.type === "custom_message" && entry.customType === TODO_CONTEXT_TYPE) {
        const details = entryDetails(entry);
        if (!isSnapshot(details)) continue;
        try {
          cloneState(details.state);
          return false;
        } catch {
          continue;
        }
      }
      if (entry.type === "compaction") return true;
    }
    return false;
  };

  const updateWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const counts = todoCounts(state);
    const openCount = counts.inProgress + counts.pending;
    if (openCount === 0) {
      ctx.ui.setWidget("todo-list", undefined);
      ctx.ui.setStatus("todo-list", undefined);
      return;
    }

    ctx.ui.setStatus("todo-list", ctx.ui.theme.fg("accent", `todo ${counts.inProgress} active · ${counts.pending} pending`));
    if (!widgetVisible) {
      ctx.ui.setWidget("todo-list", undefined);
      return;
    }

    const visible = orderedTodos(state, false, WIDGET_LIMIT);
    const lines = visible.map(({ item, depth }) => {
      const active = item.status === "in_progress";
      return `${"  ".repeat(depth)}${ctx.ui.theme.fg(active ? "accent" : "muted", active ? "◉" : "○")} ${ctx.ui.theme.fg("accent", `#${item.id}`)} ${item.text}`;
    });
    if (openCount > visible.length) lines.push(ctx.ui.theme.fg("dim", `… ${openCount - visible.length} more`));
    ctx.ui.setWidget("todo-list", lines);
  };

  const rehydrate = (ctx: ExtensionContext): void => {
    state = restore(ctx);
    updateWidget(ctx);
  };

  const hasTodoHistory = (): boolean => state.items.length > 0 || state.nextId > 1;

  pi.on("session_start", (_event, ctx) => rehydrate(ctx));
  pi.on("session_tree", (_event, ctx) => rehydrate(ctx));

  // Overflow compaction immediately retries the active run. Other compactions
  // are detected from the active branch when its next agent turn starts.
  pi.on("session_compact", (event) => {
    if (event.willRetry && hasTodoHistory()) {
      pi.sendMessage(todoContextMessage(), { deliverAs: "steer", triggerTurn: false });
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (hasTodoHistory() && needsTodoContext(ctx)) return { message: todoContextMessage() };
  });

  pi.registerTool({
    name: "todo_list",
    label: "Todo List",
    description: "Manage a persistent nested todo list with pending, in-progress, and completed items, including atomic batches",
    promptSnippet: "Track persistent pending, in-progress, and completed work across context compaction",
    promptGuidelines: [
      "Use todo_list at the start or resumption of multi-step work. Start items before working, complete them after verification, and pause interrupted work.",
      "Before claiming completion, use todo_list to reconcile outstanding items. Keep items concise and batch related mutations into one call.",
    ],
    parameters: Params,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let message: string;
      let details: MutationDetails | undefined;
      if (params.action === "list") {
        message = formatTodoPage(state, params.offset ?? 0, params.limit ?? LIST_LIMIT);
      } else if (params.action === "batch") {
        if (!params.operations) throw new Error("operations is required for batch");
        const messages = applyTodoBatch(state, params.operations);
        message = `Applied ${messages.length} operation(s):\n${messages.map((result) => `- ${result}`).join("\n")}`;
        details = { version: DETAILS_VERSION, operations: params.operations.map((operation) => ({ ...operation })) };
      } else {
        const operation: TodoMutation = {
          action: params.action,
          id: params.id,
          text: params.text,
          parentId: params.parentId,
        };
        message = applyTodoMutation(state, operation);
        details = { version: DETAILS_VERSION, operations: [operation] };
      }

      updateWidget(ctx);
      const content = params.action === "list" ? message : `${message}\n${formatTodoCounts(state)}`;
      return { content: [{ type: "text", text: content }], details };
    },
  });

  pi.registerCommand("todos", {
    description: "Show todos, or use /todos toggle|show|hide to control the widget",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const command = args.trim();
      if (["toggle", "show", "hide"].includes(command)) {
        widgetVisible = command === "show" || (command === "toggle" && !widgetVisible);
        updateWidget(ctx);
        ctx.ui.notify(`Todo widget ${widgetVisible ? "shown" : "hidden"}`, "info");
      } else if (!command) {
        ctx.ui.notify(formatTodoPage(state), "info");
      } else {
        ctx.ui.notify("Usage: /todos [toggle|show|hide]", "warning");
      }
    },
  });
}
