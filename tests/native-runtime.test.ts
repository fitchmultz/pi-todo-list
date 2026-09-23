import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { contentText, createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import {
  AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ContextEvent,
} from "@earendil-works/pi-coding-agent";

// Script only model output. Pi owns loading, tool execution, persistence and event delivery.
async function fixture(resultErrorTitle?: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-native-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"),
    refreshOnCreate: false, allowModelNetwork: false,
  });
  runtime.registerProvider("offline-todo", {
    api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text"],
      contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const model = runtime.getModel("offline-todo", "scripted");
  assert(model);
  const errors: unknown[] = [];
  let contexts: ContextEvent["messages"][] = [];
  let session: AgentSession | undefined;
  let callId = 0;
  const start = async (sessionManager: SessionManager) => {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../extensions/todo-list.ts", import.meta.url))],
      extensionFactories: [(pi) => {
        pi.on("context", (event) => { contexts.push(structuredClone(event.messages)); });
        pi.on("tool_result", (event) => {
          if (resultErrorTitle && event.toolName === "todo_list"
            && event.input.action === "add" && event.input.text === resultErrorTitle) {
            return { isError: true };
          }
        });
        pi.on("session_before_compact", (event) => ({ compaction: {
          summary: "Offline fixture summary; deliberately no todo state",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        } }));
      }],
    });
    await loader.reload({ resolveProjectTrust: async () => false });
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader, settingsManager: settings, sessionManager,
      modelRuntime: runtime, model, thinkingLevel: "off", tools: ["todo_list"],
    }));
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    assert.deepEqual(session.getActiveToolNames(), ["todo_list"]);
    return session;
  };
  const prompt = async (args: ToolCall["arguments"] | ToolCall["arguments"][], expectError = false) => {
    assert(session);
    const calls: ToolCall[] = (Array.isArray(args) ? args : [args]).map((arguments_) => ({
      type: "toolCall", id: `todo-${++callId}`, name: "todo_list", arguments: arguments_,
    }));
    let turn = 0;
    contexts = [];
    session.agent.streamFunction = () => {
      const toolCalls = turn++ === 0 ? calls : undefined;
      const message: AssistantMessage = {
        role: "assistant", content: toolCalls ?? [{ type: "text", text: "done" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: toolCalls ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: toolCalls ? "toolUse" : "stop", message });
      return stream;
    };
    await session.prompt("Run the scripted todo operation.");
    await session.waitForIdle();
    assert.deepEqual(errors, []);
    const branch = session.sessionManager.getBranch();
    const results = calls.map((call) => {
      const entry = branch.find((entry) => entry.type === "message"
        && entry.message.role === "toolResult" && entry.message.toolCallId === call.id);
      assert(entry?.type === "message" && entry.message.role === "toolResult");
      assert.equal(entry.message.isError, expectError, contentText(entry.message.content));
      return { entryId: entry.id, text: contentText(entry.message.content), details: entry.message.details };
    });
    return { ...results[0]!, results, contexts };
  };
  return {
    start, prompt,
    createManager: () => SessionManager.create(cwd, join(root, "sessions")),
    close: () => { session?.dispose(); session = undefined; },
    cleanup: async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

test("native todo tool persists, follows tree selection, resumes, and survives compaction", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    let session = await f.start(f.createManager());
    const alpha = await f.prompt({ action: "add", text: "ALPHA retained task" });
    await f.prompt({ action: "add", text: "BETA abandoned task" });
    assert.equal((await session.navigateTree(alpha.entryId, { summarize: false })).cancelled, false);
    const selected = await f.prompt({ action: "list" });
    assert.match(selected.text, /ALPHA retained task/);
    assert.doesNotMatch(selected.text, /BETA abandoned task/);
    await session.reload();
    assert.match((await f.prompt({ action: "list" })).text, /ALPHA retained task/);
    const file = session.sessionFile;
    assert(file);
    f.close();
    session = await f.start(SessionManager.open(file));
    const resumed = await f.prompt({ action: "list" });
    assert.match(resumed.text, /ALPHA retained task/);
    assert.doesNotMatch(resumed.text, /BETA abandoned task/);
    await session.compact();
    assert(session.sessionManager.getBranch().some((entry) => entry.type === "compaction"));
    const compacted = await f.prompt({ action: "list" });
    assert.match(compacted.text, /ALPHA retained task/);
    const snapshots = compacted.contexts[0]!.filter((message) => message.role === "custom" && message.customType === "todo-list-context");
    assert.equal(snapshots.length, 1, "ordinary compaction must inject one live recovery snapshot");
    assert.match(JSON.stringify(snapshots), /ALPHA retained task/);
    assert.doesNotMatch(JSON.stringify(snapshots), /BETA abandoned task/);
  } finally { await f.cleanup(); }
});

test("native null link placeholders work without changing explicit link clearing", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const session = await f.start(f.createManager());
    await f.prompt({ action: "add", text: "Linked task", link: "/notes/task.md" });
    const completed = await f.prompt({
      action: "complete", id: 1, text: null, link: null, status: null,
      parentId: null, operations: null, offset: null, limit: null,
    });
    assert.deepEqual(completed.details, { version: 7, operations: [{ action: "complete", id: 1 }] });
    assert.equal((await f.prompt({ action: "list", id: 1 })).text,
      "#1 Linked task\nStatus: completed\nDetails: /notes/task.md");

    const operations = [
      { action: "reopen", id: 1 }, { action: "start", id: 1 },
      { action: "pause", id: 1 }, { action: "move", id: 1 },
    ];
    const batch = await f.prompt({
      action: "batch", operations: operations.map((operation) => ({ ...operation, link: null })),
    });
    assert.deepEqual(batch.details, { version: 7, operations });
    await session.reload();
    assert.equal((await f.prompt({ action: "list", id: 1 })).text,
      "#1 Linked task\nStatus: paused\nDetails: /notes/task.md");

    await f.prompt({ action: "update", id: 1, link: null });
    assert.equal((await f.prompt({ action: "list", id: 1 })).text, "#1 Linked task\nStatus: paused");
    await f.prompt({ action: "batch", operations: [
      { action: "add", text: "Temporary task", link: null },
      { action: "remove", id: 2, link: null },
      { action: "complete", id: 1, link: null },
      { action: "clear_completed", link: null },
    ] });
    assert.equal((await f.prompt({ action: "list" })).text, "No todos");
  } finally { await f.cleanup(); }
});

test("native committed todo survives a downstream result error and disk resume", { timeout: 30_000 }, async () => {
  const f = await fixture("Committed despite presentation error");
  try {
    const session = await f.start(f.createManager());
    const committed = await f.prompt({ action: "add", text: "Committed despite presentation error" }, true);
    assert.match(JSON.stringify(committed.details), /"operations"/);
    assert.match((await f.prompt({ action: "list" })).text, /#1 Committed despite presentation error/);
    const file = session.sessionFile;
    assert(file);
    f.close();
    await f.start(SessionManager.open(file));
    assert.match((await f.prompt({ action: "list" })).text, /#1 Committed despite presentation error/);
    await f.prompt({ action: "remove", id: 999 }, true);
    f.close();
    await f.start(SessionManager.open(file));
    assert.match((await f.prompt({ action: "list" })).text, /#1 Committed despite presentation error/);
  } finally { await f.cleanup(); }
});

test("native sibling results preserve reference commits and exact branch boundaries", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    let session = await f.start(f.createManager());
    await f.prompt({ action: "batch", operations: [
      { action: "add", text: "Old work" }, { action: "complete", id: 1 }, { action: "clear_completed" },
    ] });
    const siblings = await f.prompt([
      { action: "batch", operations: [
        { action: "add", text: "Paused parent", status: "paused", ref: "001", link: "/notes/parent.md" },
        { action: "add", text: "Active child", status: "in_progress", parentId: "001" },
      ] },
      { action: "add", text: "Later sibling", status: "completed" },
    ]);
    const [first, second] = siblings.results;
    assert(first && second);
    assert.match(first.text, /Added #2: Paused parent/);
    assert.match(second.text, /Added #4: Later sibling/);
    const persisted = JSON.stringify(first.details);
    assert.match(persisted, /"parentId":2/);
    assert.doesNotMatch(persisted, /"ref"|"parentId":"001"/);
    assert.match((await f.prompt({ action: "list", id: 4 })).text, /Status: completed/);

    assert.equal((await session.navigateTree(first.entryId, { summarize: false })).cancelled, false);
    assert.match((await f.prompt({ action: "add", text: "Branch allocation" })).text, /Added #4: Branch allocation/);
    await session.reload();
    const file = session.sessionFile;
    assert(file);
    f.close();
    session = await f.start(SessionManager.open(file));
    await session.compact();
    const restored = await f.prompt({ action: "list" });
    assert.match(restored.text, /1 active, 1 pending, 1 paused, 0 completed/);
    assert.doesNotMatch(restored.text, /Later sibling/);
    assert.equal((await f.prompt({ action: "list", id: 3 })).text,
      "#3 Active child\nStatus: in progress\nParent: #2");
    assert.match((await f.prompt({ action: "list", id: 2 })).text, /Status: paused\nDetails: \/notes\/parent.md/);
  } finally { await f.cleanup(); }
});

test("native sibling todo IDs survive delayed execution and reload", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const session = await f.start(f.createManager());
    session.agent.subscribe(async (event) => {
      const prepared = event as { type: string; toolName?: string; args?: { text?: string } };
      if (prepared.type === "tool_execution_prepared" && prepared.toolName === "todo_list" && prepared.args?.text === "Delayed first") {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
    await f.prompt([{ action: "add", text: "Delayed first" }, { action: "add", text: "Fast second" }]);
    const beforeReload = (await f.prompt({ action: "list" })).text;
    assert.match(beforeReload, /Delayed first/);
    assert.match(beforeReload, /Fast second/);
    await session.reload();
    assert.equal((await f.prompt({ action: "list" })).text, beforeReload);
  } finally { await f.cleanup(); }
});

type WindowSession = AgentSession & { newContext?: (options?: { handoff?: string }) => void };
const hasWindows = typeof (AgentSession.prototype as WindowSession).newContext === "function";
if (process.env.PI_COMPAT_HOST === "fork" && !hasWindows) {
  throw new Error("Fork qualification requires native context windows; tests must not skip");
}

test("native fresh windows inject the pre-window todo snapshot without persisting duplicates", {
  timeout: 30_000, skip: !hasWindows && "Selected host does not provide native context windows",
}, async () => {
  const f = await fixture();
  try {
    const session = await f.start(f.createManager()) as WindowSession;
    await f.prompt({ action: "batch", operations: [
      { action: "add", text: "ALPHA window task", status: "paused", ref: "parent" },
      { action: "add", text: "BETA window child", status: "in_progress", parentId: "parent" },
    ] });
    session.newContext!({ handoff: "Continue with a fresh context" });
    assert(session.sessionManager.getBranch().some((entry) => (entry as { type: string }).type === "context_window"));
    const result = await f.prompt({ action: "list" });
    assert.match(result.text, /ALPHA window task/);
    for (const messages of result.contexts) {
      const snapshots = messages.filter((message) => message.role === "custom" && message.customType === "todo-list-context");
      assert.equal(snapshots.length, 1);
      assert.match(JSON.stringify(snapshots), /ALPHA window task/);
      assert.match(JSON.stringify(snapshots), /BETA window child/);
      assert.match(JSON.stringify(snapshots), /1 active, 0 pending, 1 paused/);
    }
    assert.equal(session.sessionManager.getBranch().filter((entry) =>
      entry.type === "custom_message" && entry.customType === "todo-list-context").length, 0);
    await session.reload();
    assert.match((await f.prompt({ action: "list" })).text, /ALPHA window task/);
  } finally { await f.cleanup(); }
});
