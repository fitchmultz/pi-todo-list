import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyTodoBatch,
  applyTodoMutation,
  cloneState,
  emptyState,
  formatTodoCounts,
  formatTodoSnapshot,
  orderedTodos,
  todoCounts,
  TODO_MUTATIONS,
  type TodoState,
} from "./todo-state.ts";

const ACTIONS = ["list", ...TODO_MUTATIONS, "batch"] as const;
const TODO_CONTEXT_TYPE = "todo-list-context";

type Action = (typeof ACTIONS)[number];
interface TodoDetails {
  version: 1 | 2;
  action: Action;
  state: TodoState;
}

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
  operations: Type.Optional(Type.Array(Mutation, { minItems: 1, maxItems: 100, description: "Ordered mutations for batch" })),
});

function restore(ctx: ExtensionContext): TodoState {
  let restored = emptyState();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo_list") continue;
    const details = entry.message.details as TodoDetails | undefined;
    if (details?.version === 1 || details?.version === 2) restored = cloneState(details.state);
  }
  return restored;
}

export default function todoListExtension(pi: ExtensionAPI): void {
  let state = emptyState();
  let widgetVisible = true;

  const todoContextMessage = () => ({
    customType: TODO_CONTEXT_TYPE,
    content: `[TODO LIST - state after compaction]\n${formatTodoSnapshot(state)}\nKeep this list current with todo_list.`,
    display: false,
  });

  const needsTodoContext = (ctx: ExtensionContext): boolean => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index]!;
      if (entry.type === "custom_message" && entry.customType === TODO_CONTEXT_TYPE) return false;
      if (entry.type === "compaction") return true;
    }
    return false;
  };

  const updateWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const ordered = orderedTodos(state, false);
    if (ordered.length === 0) {
      ctx.ui.setWidget("todo-list", undefined);
      ctx.ui.setStatus("todo-list", undefined);
      return;
    }

    const counts = todoCounts(state);
    ctx.ui.setStatus("todo-list", ctx.ui.theme.fg("accent", `todo ${counts.inProgress} active · ${counts.pending} pending`));
    if (!widgetVisible) {
      ctx.ui.setWidget("todo-list", undefined);
      return;
    }

    const visible = ordered.slice(0, 8);
    const lines = visible.map(({ item, depth }) => {
      const active = item.status === "in_progress";
      return `${"  ".repeat(depth)}${ctx.ui.theme.fg(active ? "accent" : "muted", active ? "◉" : "○")} ${ctx.ui.theme.fg("accent", `#${item.id}`)} ${item.text}`;
    });
    if (ordered.length > visible.length) lines.push(ctx.ui.theme.fg("dim", `… ${ordered.length - visible.length} more`));
    ctx.ui.setWidget("todo-list", lines);
  };

  const rehydrate = (ctx: ExtensionContext): void => {
    state = restore(ctx);
    updateWidget(ctx);
  };

  pi.on("session_start", (_event, ctx) => rehydrate(ctx));
  pi.on("session_tree", (_event, ctx) => rehydrate(ctx));

  // Overflow compaction immediately retries the active run. Other compactions
  // are detected from the active branch when its next agent turn starts.
  pi.on("session_compact", (event) => {
    if (event.willRetry && state.items.length > 0) {
      pi.sendMessage(todoContextMessage(), { deliverAs: "steer", triggerTurn: false });
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (state.items.length > 0 && needsTodoContext(ctx)) return { message: todoContextMessage() };
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
      if (params.action === "list") {
        message = formatTodoSnapshot(state, true);
      } else if (params.action === "batch") {
        if (!params.operations) throw new Error("operations is required for batch");
        const messages = applyTodoBatch(state, params.operations);
        message = `Applied ${messages.length} operation(s):\n${messages.map((result) => `- ${result}`).join("\n")}`;
      } else {
        message = applyTodoMutation(state, {
          action: params.action,
          id: params.id,
          text: params.text,
          parentId: params.parentId,
        });
      }

      updateWidget(ctx);
      const content = params.action === "list" ? message : `${message}\n${formatTodoCounts(state)}`;
      return {
        content: [{ type: "text", text: content }],
        details: { version: 2, action: params.action, state: cloneState(state) } satisfies TodoDetails,
      };
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
      } else {
        ctx.ui.notify(formatTodoSnapshot(state, true), "info");
      }
    },
  });
}
