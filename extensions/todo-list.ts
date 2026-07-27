import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyTodoBatch,
  applyTodoMutation,
  cloneState,
  emptyState,
  formatTodos,
  orderedTodos,
  TODO_MUTATIONS,
  type TodoState,
} from "./todo-state.ts";

const ACTIONS = ["list", ...TODO_MUTATIONS, "batch"] as const;

type Action = (typeof ACTIONS)[number];
interface TodoDetails {
  version: 1;
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
  id: Type.Optional(Type.Integer({ minimum: 1, description: "Todo ID for update, move, complete, reopen, or remove" })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 240, description: "Concise todo text for add or update" })),
  parentId: Type.Optional(Type.Integer({ minimum: 1, description: "Parent todo ID for add or move; omit on move to make it top-level" })),
  operations: Type.Optional(Type.Array(Mutation, { minItems: 1, maxItems: 100, description: "Ordered mutations for batch" })),
});

function restore(ctx: ExtensionContext): TodoState {
  let restored = emptyState();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo_list") continue;
    const details = entry.message.details as TodoDetails | undefined;
    if (details?.version === 1) restored = cloneState(details.state);
  }
  return restored;
}

export default function todoListExtension(pi: ExtensionAPI): void {
  let state = emptyState();
  let widgetVisible = true;

  const updateWidget = (ctx: ExtensionContext): void => {
    const ordered = orderedTodos(state, false);
    if (ordered.length === 0) {
      ctx.ui.setWidget("todo-list", undefined);
      ctx.ui.setStatus("todo-list", undefined);
      return;
    }

    ctx.ui.setStatus("todo-list", ctx.ui.theme.fg("accent", `todo ${ordered.length}/${state.items.length}`));
    if (!widgetVisible) {
      ctx.ui.setWidget("todo-list", undefined);
      return;
    }

    const visible = ordered.slice(0, 8);
    const lines = visible.map(({ item, depth }) =>
      `${"  ".repeat(depth)}${ctx.ui.theme.fg("muted", "○")} ${ctx.ui.theme.fg("accent", `#${item.id}`)} ${item.text}`,
    );
    if (ordered.length > visible.length) lines.push(ctx.ui.theme.fg("dim", `… ${ordered.length - visible.length} more`));
    ctx.ui.setWidget("todo-list", lines);
  };

  const rehydrate = (ctx: ExtensionContext): void => {
    state = restore(ctx);
    updateWidget(ctx);
  };

  pi.on("session_start", (_event, ctx) => rehydrate(ctx));
  pi.on("session_tree", (_event, ctx) => rehydrate(ctx));

  // Refresh model-visible state only at compaction boundaries. Normal tool results
  // are append-only, preserving the provider-cacheable conversation prefix.
  pi.on("session_compact", (event) => {
    const remaining = formatTodos(state, false);
    if (remaining === "No todos") return;
    pi.sendMessage(
      {
        customType: "todo-list-context",
        content: `[TODO LIST - remaining work after compaction]\n${remaining}\nKeep this list current with todo_list.`,
        display: false,
      },
      // Overflow compaction is already retrying. Other compactions wait for the
      // next user turn instead of causing an unsolicited model response.
      { deliverAs: event.willRetry ? "steer" : "nextTurn", triggerTurn: false },
    );
  });

  pi.registerTool({
    name: "todo_list",
    label: "Todo List",
    description: "Manage the session's concise nested todo list, including atomic batches",
    promptSnippet: "Create, update, nest, complete, reopen, remove, batch, or list persistent session todos",
    promptGuidelines: [
      "Use todo_list to track remaining work on multi-step tasks; keep items concise and update them as work changes. Batch related mutations into one call.",
    ],
    parameters: Params,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let message: string;
      if (params.action === "list") {
        message = formatTodos(state);
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
      const content = params.action === "list" ? message : `${message}\n\nRemaining:\n${formatTodos(state, false)}`;
      return {
        content: [{ type: "text", text: content }],
        details: { version: 1, action: params.action, state: cloneState(state) } satisfies TodoDetails,
      };
    },
  });

  pi.registerCommand("todos", {
    description: "Show todos, or use /todos toggle|show|hide to control the widget",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (["toggle", "show", "hide"].includes(command)) {
        widgetVisible = command === "show" || (command === "toggle" && !widgetVisible);
        updateWidget(ctx);
        ctx.ui.notify(`Todo widget ${widgetVisible ? "shown" : "hidden"}`, "info");
      } else {
        ctx.ui.notify(formatTodos(state), "info");
      }
    },
  });
}
