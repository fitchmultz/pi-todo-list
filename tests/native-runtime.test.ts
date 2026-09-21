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
async function fixture() {
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
  const prompt = async (args: ToolCall["arguments"]) => {
    assert(session);
    const id = `todo-${++callId}`;
    let turn = 0;
    contexts = [];
    session.agent.streamFunction = () => {
      const calls: ToolCall[] | undefined = turn++ === 0
        ? [{ type: "toolCall", id, name: "todo_list", arguments: args }] : undefined;
      const message: AssistantMessage = {
        role: "assistant", content: calls ?? [{ type: "text", text: "done" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: calls ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message });
      return stream;
    };
    await session.prompt("Run the scripted todo operation.");
    await session.waitForIdle();
    assert.deepEqual(errors, []);
    const entry = session.sessionManager.getBranch().find((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id);
    assert(entry?.type === "message" && entry.message.role === "toolResult");
    assert.equal(entry.message.isError, false, contentText(entry.message.content));
    return { entryId: entry.id, text: contentText(entry.message.content), contexts };
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
    await f.prompt({ action: "add", text: "ALPHA window task" });
    session.newContext!({ handoff: "Continue with a fresh context" });
    assert(session.sessionManager.getBranch().some((entry) => (entry as { type: string }).type === "context_window"));
    const result = await f.prompt({ action: "list" });
    assert.match(result.text, /ALPHA window task/);
    for (const messages of result.contexts) {
      const snapshots = messages.filter((message) => message.role === "custom" && message.customType === "todo-list-context");
      assert.equal(snapshots.length, 1);
      assert.match(JSON.stringify(snapshots), /ALPHA window task/);
    }
    assert.equal(session.sessionManager.getBranch().filter((entry) =>
      entry.type === "custom_message" && entry.customType === "todo-list-context").length, 0);
    await session.reload();
    assert.match((await f.prompt({ action: "list" })).text, /ALPHA window task/);
  } finally { await f.cleanup(); }
});
