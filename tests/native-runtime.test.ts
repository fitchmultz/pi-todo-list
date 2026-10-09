import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { contentText, createAssistantMessageEventStream, type AssistantMessage, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  AgentSession, createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ContextWithSystemEvent, type ToolCallEvent, type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

// Script only model output. Pi owns loading, tool execution, persistence and event delivery.
async function fixture(resultErrorTitle?: string, beforeToolCall?: (event: ToolCallEvent) => Promise<void>, producerOrder?: "before" | "after", codemode = false, afterToolCall?: (event: ToolResultEvent) => void) {
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
      compat: { supportsMidConvoSystemMessages: true },
      contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const model = runtime.getModel("offline-todo", "scripted");
  assert(model);
  const errors: unknown[] = [];
  let contexts: ContextWithSystemEvent["messages"][] = [];
  let promptSection = "";
  let session: AgentSession | undefined;
  let callId = 0;
  const todoPath = fileURLToPath(new URL("../extensions/todo-list.ts", import.meta.url));
  const producerPath = fileURLToPath(new URL("./fixtures/retain-none.ts", import.meta.url));
  const extensionPaths = producerOrder === "before" ? [producerPath, todoPath]
    : producerOrder === "after" ? [todoPath, producerPath] : [todoPath];
  const start = async (sessionManager: SessionManager) => {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: extensionPaths,
      extensionFactories: [...(codemode ? [createCodemodeExtension()] : []), (pi) => {
        if (beforeToolCall) pi.on("tool_call", beforeToolCall);
        pi.on("context_with_system", (event) => { contexts.push(structuredClone(event.messages)); });
        pi.on("before_agent_start", (event) => {
          if (promptSection) event.systemPromptOptions.sections.fixture = promptSection;
        });
        pi.on("tool_result", (event) => {
          afterToolCall?.(event);
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
    assert.deepEqual(loader.getExtensions().extensions.slice(0, extensionPaths.length).map((extension) => extension.path), extensionPaths);
    ({ session } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader, settingsManager: settings, sessionManager,
      modelRuntime: runtime, model, thinkingLevel: "off", tools: codemode ? ["todo_list", "codemode"] : ["todo_list"],
    }));
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    assert.deepEqual(session.getActiveToolNames(), codemode ? ["todo_list", "codemode"] : ["todo_list"]);
    assert(session.extensionRunner.getCommand("todos"));
    return session;
  };
  const prompt = async (args: ToolCall["arguments"] | ToolCall["arguments"][], expectError = false, inputTokens = 0, nextArgs?: ToolCall["arguments"], toolName = "todo_list", forcedCallId?: string) => {
    assert(session);
    const calls: ToolCall[] = (Array.isArray(args) ? args : [args]).map((arguments_) => ({
      type: "toolCall", id: forcedCallId ?? `todo-${++callId}`, name: toolName, arguments: arguments_,
    }));
    const turns = [calls];
    if (nextArgs) turns.push([{ type: "toolCall", id: `todo-${++callId}`, name: "todo_list", arguments: nextArgs }]);
    const requests: TranscriptContext["messages"][] = [];
    let turn = 0;
    contexts = [];
    session.agent.streamFunction = (_model, context) => {
      requests.push(structuredClone(context.messages));
      const toolCalls = turns[turn++];
      const message: AssistantMessage = {
        role: "assistant", content: toolCalls ?? [{ type: "text", text: "done" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: toolCalls ? "toolUse" : "stop",
        usage: { input: toolCalls ? inputTokens : 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: toolCalls ? inputTokens : 0,
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
    const results = turns.flat().map((call) => {
      const entry = branch.findLast((entry) => entry.type === "message"
        && entry.message.role === "toolResult" && entry.message.toolCallId === call.id);
      assert(entry?.type === "message" && entry.message.role === "toolResult");
      assert.equal(entry.message.isError, expectError, contentText(entry.message.content));
      return { entryId: entry.id, text: contentText(entry.message.content), details: entry.message.details };
    });
    return { ...results[0]!, results, contexts, requests };
  };
  return {
    start, prompt,
    script: (code: string, expectError = false, id?: string) => prompt({ code }, expectError, 0, undefined, "codemode", id),
    setPromptSection: (text: string) => { promptSection = text; },
    createManager: () => SessionManager.create(cwd, join(root, "sessions")),
    close: () => { session?.dispose(); session = undefined; },
    cleanup: async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

test("native tool IDs can repeat or be empty without losing direct or nested commits", { timeout: 30_000 }, async (t) => {
  for (const id of ["reused", ""]) await t.test(id || "empty", async () => {
    const f = await fixture(undefined, undefined, undefined, true);
    try {
      let session = await f.start(f.createManager());
      await f.prompt({ action: "add", text: "First" }, false, 0, undefined, "todo_list", id);
      await f.prompt({ action: "add", text: "Second" }, false, 0, undefined, "todo_list", id);
      await f.prompt({ action: "complete", id: 1 }, false, 0, undefined, "todo_list", id);
      const direct = "TODO: 0 active, 1 pending, 1 completed\n- #2 Second\n… 1 completed not shown";
      assert.equal((await f.prompt({ action: "list" })).text, direct);
      await session.reload();
      assert.equal((await f.prompt({ action: "list" })).text, direct);
      await f.script('return await tools.todo_list({action:"add",text:"Nested third"})', false, id);
      await f.script('return await tools.todo_list({action:"add",text:"Nested fourth"})', false, id);
      const expected = "TODO: 0 active, 3 pending, 1 completed\n- #2 Second\n- #3 Nested third\n- #4 Nested fourth\n… 1 completed not shown";
      await session.reload();
      assert.equal((await f.prompt({ action: "list" })).text, expected);
      const file = session.sessionFile;
      assert(file);
      f.close();
      session = await f.start(SessionManager.open(file));
      assert.equal((await f.prompt({ action: "list" })).text, expected);
    } finally { await f.cleanup(); }
  });
});

test("native persist failure preserves the original error and current branch projection across reload", { timeout: 30_000 }, async () => {
  let session: AgentSession | undefined;
  let faultFile: string | undefined;
  const f = await fixture(undefined, async event => {
    if (event.toolName === "todo_list" && event.input.text === "Persist failure") {
      assert(session?.sessionFile);
      faultFile = session.sessionFile;
      renameSync(faultFile, `${faultFile}.saved`);
      mkdirSync(faultFile);
    }
  }, undefined, false, event => {
    if (event.toolName === "todo_list" && event.input.text === "Persist failure") {
      assert(faultFile);
      rmdirSync(faultFile);
      renameSync(`${faultFile}.saved`, faultFile);
      faultFile = undefined;
    }
  });
  try {
    session = await f.start(f.createManager());
    await f.prompt({ action: "add", text: "Retained" });
    const failure = await f.prompt({ action: "add", text: "Persist failure" }, true);
    assert.match(failure.text, /EISDIR/);
    const expected = "TODO: 0 active, 2 pending, 0 completed\n- #1 Retained\n- #2 Persist failure";
    assert.equal((await f.prompt({ action: "list" })).text, expected);
    await session.reload();
    assert.equal((await f.prompt({ action: "list" })).text, expected);
    assert.match((await f.prompt({ action: "add", text: "Next ID" })).text, /Added #3: Next ID/);
  } finally {
    if (faultFile) {
      rmdirSync(faultFile);
      renameSync(`${faultFile}.saved`, faultFile);
    }
    await f.cleanup();
  }
});

test("native nested Todo commits survive script failure, reload, tree navigation and disk resume", { timeout: 30_000 }, async () => {
  const f = await fixture(undefined, undefined, undefined, true);
  try {
    let session = await f.start(f.createManager());
    const first = await f.prompt({ action: "add", text: "Original task" });
    const nested = await f.script(`await tools.todo_list({action:"batch",operations:[
      {action:"add",text:"Nested parent",status:"paused",link:"/parent.md",ref:"parent"},
      {action:"add",text:"Nested child",status:"in_progress",parentId:"parent",link:"/child.md"}
    ]}); throw new Error("After committed mutation");`, true);
    const before = (await f.prompt({ action: "list" })).text;
    assert.equal(before, "TODO: 1 active, 1 pending, 1 paused, 0 completed\n- #1 Original task\n⏸ #2 Nested parent [details]\n  > #3 Nested child [details]");
    await session.reload();
    assert.equal((await f.prompt({ action: "list" })).text, before);
    assert.equal((await f.prompt({ action: "list", id: 3 })).text,
      "#3 Nested child\nStatus: in progress\nParent: #2\nDetails: /child.md");
    assert.equal((await session.navigateTree(first.entryId, { summarize: false })).cancelled, false);
    assert.match((await f.script('return await tools.todo_list({action:"add",text:"Alternate branch"})')).text, /Added #2: Alternate branch/);
    assert.equal((await session.navigateTree(nested.entryId, { summarize: false })).cancelled, false);
    assert.equal((await f.prompt({ action: "list" })).text, before);
    await session.compact();
    const file = session.sessionFile;
    assert(file);
    f.close();
    session = await f.start(SessionManager.open(file));
    assert.equal((await f.prompt({ action: "list" })).text, before);
    assert.match((await f.script('return await tools.todo_list({action:"add",text:"After resume",status:"completed"})')).text, /Added #4: After resume/);
    await session.reload();
    assert.equal((await f.prompt({ action: "list", id: 4 })).text, "#4 After resume\nStatus: completed");
    session.sessionManager.appendCustomEntry("todo-list-state", {
      toolCallId: "corrupt-custom-commit", details: { version: 7, operations: [
        { action: "add", text: "Partial corrupt batch" }, { action: "missing" },
      ] },
    });
    session.sessionManager.appendCustomEntry("todo-list-state", {
      toolCallId: "after-corruption", details: { version: 7, operations: [{ action: "add", text: "Must not cross gap" }] },
    });
    await session.reload();
    const recovered = await f.script('return await tools.todo_list({action:"list"})');
    assert.match(recovered.text, /Warning: Todo history was corrupt/);
    assert.match(recovered.text, /Nested child/);
    assert.doesNotMatch(recovered.text, /Partial corrupt batch|Must not cross gap/);
    await session.reload();
    assert.equal((await f.prompt({ action: "list", id: 4 })).text, "#4 After resume\nStatus: completed");
    assert.match((await f.prompt({ action: "add", text: "After recovery checkpoint" })).text, /Added #5: After recovery checkpoint/);
  } finally { await f.cleanup(); }
});

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

test("native threshold compaction restores todos before the next response in the same prompt", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const session = await f.start(f.createManager());
    await f.prompt({ action: "add", text: "Required release check", status: "in_progress" });
    session.settingsManager.setCompactionEnabled(true);
    // Provider usage crosses the 200k window's threshold after this tool call.
    // The list page deliberately contains no titles, and the summary omits todos.
    const result = await f.prompt({ action: "list", offset: 1 }, false, 190_000);
    assert(session.sessionManager.getBranch().some((entry) => entry.type === "compaction"));
    assert.equal(result.contexts.length, 2);
    const nextRequest = result.contexts[1]!;
    const snapshots = nextRequest.filter((message) => message.role === "custom" && message.customType === "todo-list-context");
    assert.equal(snapshots.length, 1);
    assert.match(JSON.stringify(snapshots), /Required release check/);
    assert.match(JSON.stringify(snapshots), /1 active/);
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
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let delayedCalls = 0;
  let delayedCallId: string | undefined;
  const f = await fixture(undefined, async (event) => {
    if (event.toolName === "todo_list" && event.input.text === "Delayed first") {
      delayedCalls++;
      delayedCallId = event.toolCallId;
      entered.resolve();
      await gate.promise;
    }
  });
  try {
    const session = await f.start(f.createManager());
    const execution = f.prompt([{ action: "add", text: "Delayed first" }, { action: "add", text: "Fast second" }]);
    try {
      assert.equal(await Promise.race([
        entered.promise.then(() => "entered"), execution.then(() => "finished"),
      ]), "entered", "the delay must be entered before execution finishes");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(delayedCalls, 1);
      assert(!session.sessionManager.getBranch().some((entry) => entry.type === "message"
        && entry.message.role === "toolResult" && entry.message.toolCallId === delayedCallId),
      "the delayed tool must not produce a result while its gate is held");
    } finally {
      gate.resolve();
      await execution;
    }
    assert.equal(delayedCalls, 1, "the delayed callback must run exactly once");
    const results = (await execution).results;
    assert.match(results[0]!.text, /Added #1: Delayed first/);
    assert.match(results[1]!.text, /Added #2: Fast second/);
    const beforeReload = (await f.prompt({ action: "list" })).text;
    assert.match(beforeReload, /Delayed first/);
    assert.match(beforeReload, /Fast second/);
    await session.reload();
    assert.equal((await f.prompt({ action: "list" })).text, beforeReload);
  } finally { await f.cleanup(); }
});

test("native retain-none compaction recovers todos on the next request and reload", { timeout: 30_000 }, async (t) => {
  const f = await fixture();
  try {
    const session = await f.start(f.createManager());
    await f.prompt({ action: "batch", operations: [
      { action: "add", text: "ALPHA window task", status: "paused", ref: "parent" },
      { action: "add", text: "BETA window child", status: "in_progress", parentId: "parent" },
    ] });
    session.sessionManager.appendCompaction("", null, 0);
    session.refreshContext();
    assert(!JSON.stringify(session.sessionManager.buildSessionContext().messages).includes("ALPHA window task"),
      "Retain-none removes the prior tool results from provider context");
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
      entry.type === "custom_message" && entry.customType === "todo-list-context").length, 0,
    "retain-none recovery is request-only, not an extra persistent entry");
    await session.reload();
    assert.match((await f.prompt({ action: "list" })).text, /ALPHA window task/);
  } finally { await f.cleanup(); }

  for (const order of ["before", "after"] as const) await t.test(`in-run producer loaded ${order} Todo`, async () => {
    const live = await fixture(undefined, undefined, order);
    try {
      const session = await live.start(live.createManager());
      await live.prompt({ action: "batch", operations: [
        { action: "add", text: "OLD boundary task", status: "paused", ref: "parent" },
        { action: "add", text: "BETA boundary child", status: "in_progress", parentId: "parent" },
        ...Array.from({ length: 6 }, (_, index) => ({ action: "add", text: `Extra paused ${index}`, status: "paused" })),
      ] });
      const result = await live.prompt({ action: "update", id: 1, text: "CURRENT boundary task" }, false, 0,
        { action: "update", id: 2, text: "AFTER boundary child" });
      assert.equal(result.requests.length, 3, "rollover must not add a provider round");
      const compactions = session.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
      assert.equal(compactions.length, 1);
      assert.equal(compactions[0]!.summary, "");
      assert.equal(compactions[0]!.firstKeptEntryId, compactions[0]!.id);
      const nextRequest = result.contexts[1]!;
      assert(!nextRequest.some((message) => message.role === "toolResult"), "old tool history must be discarded");
      assert.doesNotMatch(JSON.stringify(result.requests[1]), /OLD boundary task/);
      assert.match(JSON.stringify(result.requests[1]), /\[TODO LIST - recovery snapshot\]/);
      assert.match(JSON.stringify(result.requests[1]), /CURRENT boundary task/);
      const snapshots = nextRequest.filter((message) => message.role === "custom" && message.customType === "todo-list-context");
      assert.equal(snapshots.length, 1, "the first continued request must receive recovery");
      assert.match(JSON.stringify(snapshots), /CURRENT boundary task/);
      assert.match(JSON.stringify(snapshots), /BETA boundary child/);
      assert.match(JSON.stringify(snapshots), /1 active, 0 pending, 7 paused/);
      assert.doesNotMatch(JSON.stringify(snapshots), /Extra paused 4|Extra paused 5|AFTER boundary child/);
      assert.deepEqual(result.requests[2]!.slice(0, result.requests[1]!.length), result.requests[1],
        "later mutations must append results without rewriting the recovery prefix");
      for (const messages of result.contexts.slice(1)) {
        assert.equal(messages.filter((message) => message.role === "custom" && message.customType === "todo-list-context").length, 1);
      }
      const initialHead = result.requests[1]![0]!;
      assert.equal(initialHead.role, "system", "the initial head must remain first");
      live.setPromptSection("Incremental prompt after rollover");
      const listed = await live.prompt({ action: "list", id: 2 });
      assert.equal(listed.text, "#2 AFTER boundary child\nStatus: in progress\nParent: #1");
      assert.deepEqual(listed.requests[0]!.slice(0, result.requests[2]!.length), result.requests[2],
        "an incremental prompt update must preserve the full submitted prefix");
      const systemUpdates = listed.requests[0]!.filter((message) => message.role === "system");
      assert.equal(systemUpdates.length, 2, "the prompt change must append, not fold into the initial head");
      assert.deepEqual(systemUpdates[0], initialHead);
      assert.match(JSON.stringify(systemUpdates[1]), /Incremental prompt after rollover/);
      assert.deepEqual(listed.requests[1]!.slice(0, listed.requests[0]!.length), listed.requests[0],
        "a later mutation request must retain the incremental system update");
      await session.reload();
      const reloaded = await live.prompt({ action: "list", id: 1 });
      assert.equal(reloaded.text, "#1 CURRENT boundary task\nStatus: paused");
      assert.deepEqual(reloaded.requests[0]!.slice(0, listed.requests[1]!.length), listed.requests[1],
        "reload must preserve the initial head and appended system update");
      assert.deepEqual(reloaded.requests[0]!.filter((message) => message.role === "system"), systemUpdates);
      assert.equal(session.sessionManager.getBranch().filter((entry) =>
        entry.type === "custom_message" && entry.customType === "todo-list-context").length, 0,
      "request-only recovery must not accumulate persistent snapshots");
    } finally { await live.cleanup(); }
  });
});
