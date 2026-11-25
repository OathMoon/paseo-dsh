import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { PROVIDER_PROTOCOL_VERSION, type ProviderEvent } from "@getpaseo/plugin/server/provider";
import { createDirectDshConnection } from "../server/connection.ts";
import { applyDshBridge } from "../server/dsh-bridge-plugin.mjs";
import { encodeModelId, toProviderCatalog, toProviderConfigState } from "../server/mappers/config.ts";
import { mapProviderContentToBridgeBlocks } from "../server/mappers/content.ts";
import { buildToolCallDetail, extractToolOutputText, extractUserMessageText } from "../server/mappers/tools.ts";
import { inspectDshStatus } from "../server/launch.ts";
import { BridgeRpcPeer, type BridgeCatalogResult, type BridgeSessionState } from "../server/protocol.ts";
import { DshSessionRuntime, nativePersistence, readNativeSessionId } from "../server/session.ts";

test("persistence handle round-trips v1 sessionId format", () => {
  const handle = nativePersistence("11111111-2222-4333-8444-555555555555");
  assert.deepEqual(handle, {
    version: 1,
    data: { sessionId: "11111111-2222-4333-8444-555555555555" },
  });
  assert.equal(readNativeSessionId(handle), "11111111-2222-4333-8444-555555555555");
  assert.equal(readNativeSessionId({ version: 2, data: { sessionId: "x" } }), undefined);
  assert.equal(readNativeSessionId(undefined), undefined);
});

test("config mapper maps models, thinking options, and permission presets to Paseo modes", () => {
  const catalog: BridgeCatalogResult = {
    providers: [
      {
        id: "deepseek-official",
        name: "DeepSeek",
        models: [
          {
            id: "deepseek-v4",
            name: "DeepSeek V4",
            description: "Flagship",
            contextWindowMaxTokens: 128000,
            inputModalities: ["text", "image"],
            reasoning: {
              defaultEffort: "high",
              efforts: [
                { id: "low", name: "Low" },
                { id: "high", name: "High", description: "Deep reasoning" },
              ],
            },
          },
        ],
      },
    ],
    defaultSelection: { provider: "deepseek-official", model: "deepseek-v4", reasoningEffort: "high" },
    permissionPresets: {
      defaultPreset: "workspace-write",
      options: [
        { id: "workspace-write", name: "Workspace Write", description: "Ask outside workspace" },
        { id: "danger-full-access", name: "Full Access", description: "Unattended" },
      ],
    },
  };

  const mappedCatalog = toProviderCatalog(catalog);
  assert.equal(mappedCatalog.defaultModel, encodeModelId("deepseek-official", "deepseek-v4"));
  assert.equal(mappedCatalog.defaultMode, "workspace-write");
  assert.equal(mappedCatalog.defaultThinkingOption, "high");
  assert.equal(mappedCatalog.models.length, 1);
  assert.equal(mappedCatalog.models[0]?.contextWindowMaxTokens, 128000);
  assert.equal(mappedCatalog.modes.length, 2);
  assert.equal(mappedCatalog.modes[1]?.isUnattended, true);

  const state: BridgeSessionState = {
    sessionId: "sess-1",
    cwd: "E:/repo",
    selection: { provider: "deepseek-official", model: "deepseek-v4", reasoningEffort: "low" },
    mode: "danger-full-access",
    catalog,
    commands: [],
    imageSupported: true,
  };
  const cfg = toProviderConfigState(state);
  assert.equal(cfg.model, encodeModelId("deepseek-official", "deepseek-v4"));
  assert.equal(cfg.mode, "danger-full-access");
  assert.equal(cfg.thinkingOption, "low");
  assert.equal(cfg.thinkingOptions.length, 2);
});

test("tool mapper builds rich Paseo cards for shell, read, edit, write, search, fetch, sub_agent, and unknown", () => {
  assert.deepEqual(
    buildToolCallDetail("bash", { command: "npm test", cwd: "/repo" }, [{ type: "text", text: "ok" }]),
    { type: "shell", command: "npm test", cwd: "/repo", output: "ok" },
  );
  assert.deepEqual(
    buildToolCallDetail("read", { path: "README.md", offset: 1, limit: 20 }, [{ type: "text", text: "# Hi" }]),
    { type: "read", filePath: "README.md", offset: 1, limit: 20, content: "# Hi" },
  );
  assert.deepEqual(
    buildToolCallDetail("edit", { file_path: "a.ts", old_string: "foo", new_string: "bar" }),
    { type: "edit", filePath: "a.ts", oldString: "foo", newString: "bar" },
  );
  assert.deepEqual(
    buildToolCallDetail("write", { path: "b.ts", content: "export const x = 1;" }),
    { type: "write", filePath: "b.ts", content: "export const x = 1;" },
  );
  assert.deepEqual(
    buildToolCallDetail("grep", { pattern: "TODO" }, [{ type: "text", text: "a.ts:1" }]),
    { type: "search", query: "TODO", toolName: "grep", content: "a.ts:1" },
  );
  assert.deepEqual(
    buildToolCallDetail("web_fetch", { url: "https://example.com", prompt: "summarize" }, [{ type: "text", text: "Summary" }]),
    { type: "fetch", url: "https://example.com", prompt: "summarize", result: "Summary" },
  );
  assert.deepEqual(
    buildToolCallDetail("subagent", { type: "research", description: "find files" }, [{ type: "text", text: "done" }]),
    { type: "sub_agent", subAgentType: "research", description: "find files", log: "done" },
  );
  assert.deepEqual(
    buildToolCallDetail("mcp__fixture__add", { a: 2, b: 3 }, [{ type: "text", text: "5" }]),
    { type: "unknown", input: { a: 2, b: 3 }, output: "5" },
  );
  assert.equal(extractToolOutputText([{ type: "text", text: "line1" }, { type: "text", text: "line2" }]), "line1\nline2");
});

test("content mapper handles images, uploaded files, reviews, PRs, and text attachments", () => {
  const supported = mapProviderContentToBridgeBlocks(
    [
      { type: "text", text: "Please inspect" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "uploaded_file", id: "f1", fileName: "spec.pdf", mimeType: "application/pdf", size: 42, path: "/tmp/spec.pdf" },
      {
        type: "github_pr",
        mimeType: "application/github-pr",
        number: 12,
        title: "Upgrade provider",
        url: "https://github.com/org/repo/pull/12",
        headRefName: "feat",
        baseRefName: "main",
        body: "Details",
      },
      {
        type: "review",
        mimeType: "application/paseo-review",
        cwd: "/repo",
        mode: "uncommitted",
        comments: [
          {
            filePath: "src/a.ts",
            side: "new",
            lineNumber: 10,
            body: "Fix typo",
            context: {
              hunkHeader: "@@ -8,3 +8,3 @@",
              targetLine: { oldLineNumber: 10, newLineNumber: 10, type: "add", content: "const x = 1;" },
              lines: [{ oldLineNumber: 10, newLineNumber: 10, type: "add", content: "const x = 1;" }],
            },
          },
        ],
      },
    ],
    true,
  );
  assert.equal(supported.blocks.length, 5);
  assert.deepEqual(supported.blocks[1], { type: "image", data: "AAAA", mimeType: "image/png" });
  assert.match(supported.displayText, /Uploaded file: spec\.pdf/);
  assert.match(supported.displayText, /GitHub PR #12: Upgrade provider/);
  assert.match(supported.displayText, /File: src\/a\.ts:10/);

  const unsupported = mapProviderContentToBridgeBlocks(
    [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    false,
  );
  assert.equal(unsupported.blocks.length, 1);
  assert.equal(unsupported.blocks[0]?.type, "text");
});

test("BridgeRpcPeer handles bidirectional requests, notifications, and error propagation", async () => {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const seenNotifications: Array<{ method: string; params: unknown }> = [];

  const peerA = new BridgeRpcPeer(aToB, bToA, {
    onNotification(method, params) {
      seenNotifications.push({ method, params });
    },
    async onRequest(method, params) {
      if (method === "approval/request") return { outcome: "allowed-once", echo: params };
      throw new Error(`unexpected ${method}`);
    },
  });
  const peerB = new BridgeRpcPeer(bToA, aToB, {
    async onRequest(method) {
      if (method === "ping") return { pong: true };
      throw new Error("boom");
    },
  });

  try {
    assert.deepEqual(await peerA.request("ping"), { pong: true });
    await assert.rejects(() => peerA.request("fail"), /boom/);
    assert.deepEqual(await peerB.request("approval/request", { toolName: "bash" }), {
      outcome: "allowed-once",
      echo: { toolName: "bash" },
    });
    peerB.notify("event/stream", { delta: "hi" });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seenNotifications, [{ method: "event/stream", params: { delta: "hi" } }]);
  } finally {
    peerA.close();
    peerB.close();
  }
});

test("inspectDshStatus reports clear diagnostics for missing executable", async () => {
  const status = await inspectDshStatus({
    command: "nonexistent-dsh-binary-xyz",
    args: ["--profile", "acp"],
    env: {},
  });
  assert.equal(status.available, false);
  assert.match(status.diagnostic, /was not found/i);
});

const SAMPLE_CATALOG: BridgeCatalogResult = {
  providers: [
    {
      id: "deepseek",
      name: "DeepSeek",
      models: [
        {
          id: "v4",
          name: "DeepSeek V4",
          contextWindowMaxTokens: 128_000,
          inputModalities: ["text", "image"],
        },
      ],
    },
  ],
  defaultSelection: { provider: "deepseek", model: "v4" },
};

function makeFakeBridgeState(sessionId: string, cwd = "/repo"): BridgeSessionState {
  return {
    sessionId,
    cwd,
    selection: { provider: "deepseek", model: "v4" },
    catalog: SAMPLE_CATALOG,
    commands: [],
    imageSupported: true,
  };
}

function createFakeBridgeHarness(
  onRequest: (method: string, params: unknown, bridgePeer: BridgeRpcPeer) => Promise<unknown>,
  streamCoalesceMs = 0,
) {
  const hostToBridge = new PassThrough();
  const bridgeToHost = new PassThrough();
  const events: ProviderEvent[] = [];
  const bridgePeer: BridgeRpcPeer = new BridgeRpcPeer(bridgeToHost, hostToBridge, {
    onRequest: async (method, params): Promise<unknown> => {
      if (method === "bridge/init") {
        return {
          protocolVersion: 1,
          dshVersion: "0.2.2-test",
          profile: "acp",
          capabilities: {
            streaming: true,
            commands: true,
            permissionPresets: true,
            images: true,
            userQuestions: true,
            revert: true,
            subsessions: true,
          },
        };
      }
      return onRequest(method, params, bridgePeer);
    },
  });
  return {
    events,
    bridgePeer,
    startRuntime: () =>
      DshSessionRuntime.fromStreams({
        boundarySessionId: "s1",
        writable: hostToBridge,
        readable: bridgeToHost,
        streamCoalesceMs,
        emit: (e) => events.push(e),
      }),
    cleanup: () => {
      bridgePeer.close();
      hostToBridge.destroy();
      bridgeToHost.destroy();
    },
  };
}

test("revert switches live runtime to forked sessionId for subsequent prompts", async () => {
  const seenCalls: Array<{ method: string; params: unknown }> = [];
  const harness = createFakeBridgeHarness(async (method, params) => {
    seenCalls.push({ method, params });
    if (method === "session/open") return makeFakeBridgeState("sess-orig");
    if (method === "session/revert") return { newSessionId: "sess-fork" };
    if (method === "session/close") return {};
    if (method === "session/resume") {
      const p = params as { sessionId: string; cwd: string };
      return makeFakeBridgeState(p.sessionId, p.cwd);
    }
    if (method === "turn/prompt") return { kind: "turn", messageId: "m-after-fork" };
    throw new Error(`unexpected ${method}`);
  });

  const runtime = await harness.startRuntime();
  try {
    await runtime.open(
      {
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        history: "skip",
        config: { cwd: "/repo", mcpServers: {}, env: {}, settings: {}, persist: true },
      },
      ["prompt.message", "session.persistence", "session.revert.conversation"],
    );
    assert.equal(runtime.nativeSessionId, "sess-orig");

    await runtime.revert({ beforeSeq: 3 }, "conversation");
    assert.equal(runtime.nativeSessionId, "sess-fork");

    await runtime.prompt({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "c-2",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "after fork" }] },
      },
    });

    const promptCall = seenCalls.find((c) => c.method === "turn/prompt");
    assert.equal((promptCall?.params as { sessionId: string }).sessionId, "sess-fork");
    const closeCall = seenCalls.find((c) => c.method === "session/close");
    assert.equal((closeCall?.params as { sessionId: string }).sessionId, "sess-orig");
    const resumeCall = seenCalls.find((c) => c.method === "session/resume");
    assert.equal((resumeCall?.params as { sessionId: string }).sessionId, "sess-fork");
  } finally {
    await runtime.close();
    harness.cleanup();
  }
});

test("failed turn/prompt rolls back activeTurnId so steer fails and close emits no bogus turn end", async () => {
  const harness = createFakeBridgeHarness(async (method) => {
    if (method === "session/open") return makeFakeBridgeState("sess-1");
    if (method === "turn/prompt") throw new Error("bridge rejected prompt");
    if (method === "session/close") return {};
    throw new Error(`unexpected ${method}`);
  });

  const runtime = await harness.startRuntime();
  try {
    await runtime.open(
      {
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        history: "skip",
        config: { cwd: "/repo", mcpServers: {}, env: {}, settings: {}, persist: true },
      },
      ["prompt.message", "prompt.steer"],
    );
    await assert.rejects(
      () =>
        runtime.prompt({
          type: "session.prompt",
          sessionId: "s1",
          prompt: {
            clientMessageId: "c-1",
            delivery: "auto",
            input: { type: "message", content: [{ type: "text", text: "hi" }] },
          },
        }),
      /bridge rejected prompt/,
    );
    // Steer should report "No active turn to steer" instead of proceeding against a ghost turn.
    await runtime.prompt({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "c-2",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "nudge" }] },
      },
    });
    const steerRes = harness.events.find(
      (e) => e.type === "session.prompt_result" && e.clientMessageId === "c-2",
    );
    assert.equal(steerRes?.type, "session.prompt_result");
    if (steerRes?.type === "session.prompt_result") {
      assert.equal(steerRes.result.type, "failed");
    }

    await runtime.close();
    const turnEnds = harness.events.filter((e) => e.type === "session.turn");
    assert.equal(turnEnds.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("turn/end aborted maps to canceled, image user messages format cleanly, and stream coalesces with usage", async () => {
  const harness = createFakeBridgeHarness(
    async (method) => {
      if (method === "session/open") return makeFakeBridgeState("sess-1");
      if (method === "turn/prompt") return { kind: "turn", messageId: "u-1" };
      if (method === "session/close") return {};
      throw new Error(`unexpected ${method}`);
    },
    50,
  );

  const runtime = await harness.startRuntime();
  try {
    await runtime.open(
      {
        type: "session.open",
        requestId: "r1",
        sessionId: "s1",
        history: "skip",
        config: { cwd: "/repo", mcpServers: {}, env: {}, settings: {}, persist: true },
      },
      ["prompt.message"],
    );

    assert.equal(
      extractUserMessageText([
        { type: "text", text: "see attached" },
        { type: "image", attachment: { id: "att-1" } },
      ]),
      "see attached\n[image]",
    );

    await runtime.prompt({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "c-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "go" }] },
      },
    });

    // Leading chunk flushes immediately (0ms TTFT); subsequent rapid deltas coalesce until end.
    harness.bridgePeer.notify("event/stream", {
      sessionId: "sess-1",
      frame: { type: "start", attemptId: "a1" },
    });
    harness.bridgePeer.notify("event/stream", {
      sessionId: "sess-1",
      frame: { type: "chunk", attemptId: "a1", chunk: { type: "text-delta", text: "H" } },
    });
    harness.bridgePeer.notify("event/stream", {
      sessionId: "sess-1",
      frame: { type: "chunk", attemptId: "a1", chunk: { type: "text-delta", text: "el" } },
    });
    harness.bridgePeer.notify("event/stream", {
      sessionId: "sess-1",
      frame: { type: "chunk", attemptId: "a1", chunk: { type: "text-delta", text: "lo" } },
    });
    harness.bridgePeer.notify("event/stream", {
      sessionId: "sess-1",
      frame: { type: "end", attemptId: "a1", outcome: { kind: "committed", seq: 2 } },
    });
    harness.bridgePeer.notify("event/session", {
      sessionId: "sess-1",
      event: {
        seq: 2,
        type: "assistant/message",
        data: {
          message: { id: "m2", content: [{ type: "text", text: "Hello" }] },
          usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 },
        },
      },
    });
    harness.bridgePeer.notify("event/session", {
      sessionId: "sess-1",
      event: { seq: 3, type: "turn/end", data: { reason: { kind: "aborted", reason: { kind: "user" } } } },
    });

    await new Promise((r) => setTimeout(r, 30));

    const assistantItems = harness.events.filter(
      (e) => e.type === "timeline.item" && e.item.type === "assistant_message",
    );
    assert.equal(assistantItems.length, 2);
    if (assistantItems[1]?.type === "timeline.item" && assistantItems[1].item.type === "assistant_message") {
      assert.equal(assistantItems[1].item.text, "Hello");
    }

    const usageEvent = harness.events.find((e) => e.type === "session.usage");
    assert.ok(usageEvent && usageEvent.type === "session.usage");
    assert.equal(usageEvent.usage.contextWindowMaxTokens, 128_000);
    assert.equal(usageEvent.usage.contextWindowUsedTokens, 100);

    const turnEnd = harness.events.find((e) => e.type === "session.turn" && e.state !== "started");
    assert.ok(turnEnd && turnEnd.type === "session.turn");
    assert.equal(turnEnd.state, "canceled");
  } finally {
    await runtime.close();
    harness.cleanup();
  }
});

test("connection reuses utility runtime for catalog/sessions and closes racing session.open cleanly", async () => {
  let startCount = 0;
  let openRelease!: () => void;
  const openStarted = new Promise<void>((resolve) => {
    openRelease = resolve;
  });
  let finishOpen!: () => void;
  const openGate = new Promise<void>((resolve) => {
    finishOpen = resolve;
  });
  const closedRuntimes: string[] = [];

  const conn = await createDirectDshConnection(
    {
      versions: [PROVIDER_PROTOCOL_VERSION],
      capabilities: ["prompt.message", "session.list", "session.persistence"],
    },
    {
      utilityIdleTimeoutMs: 60_000,
      startRuntime: async (opts) => {
        startCount++;
        const harness = createFakeBridgeHarness(async (method) => {
          if (method === "catalog/get") return SAMPLE_CATALOG;
          if (method === "session/list") return { sessions: [] };
          if (method === "session/open") {
            openRelease();
            await openGate;
            return makeFakeBridgeState("sess-late");
          }
          if (method === "session/close") return {};
          throw new Error(`unexpected ${method}`);
        });
        const rt = await harness.startRuntime();
        const origClose = rt.close.bind(rt);
        rt.close = async (reason) => {
          closedRuntimes.push(opts.boundarySessionId);
          await origClose(reason);
          harness.cleanup();
        };
        return rt;
      },
    },
  );

  const events: ProviderEvent[] = [];
  conn.onEvent((e) => events.push(e));

  // Utility runtime should be reused for both catalog and sessions (still only 1 start).
  await conn.send({ type: "catalog", requestId: "cat-1", cwd: "/repo" });
  await conn.send({ type: "sessions", requestId: "list-1" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(startCount, 1);
  assert.ok(events.some((e) => e.type === "catalog" && e.requestId === "cat-1"));
  assert.ok(events.some((e) => e.type === "sessions" && e.requestId === "list-1"));

  // Start a session.open that stalls mid-flight, then close the connection concurrently.
  await conn.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "racing-s1",
    history: "skip",
    config: { cwd: "/repo", mcpServers: {}, env: {}, settings: {}, persist: true },
  });
  await openStarted;
  const closePromise = conn.close();
  finishOpen();
  await closePromise;

  assert.ok(closedRuntimes.includes("racing-s1"), "Racing session runtime must be closed on connection close");
  assert.ok(closedRuntimes.includes("utility"), "Utility runtime must be closed on connection close");
});

test("bridge suppresses agent/error for retryable errors and routes subagent approvals to root record", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();

  const rootSession = { id: "root-1", header: { cwd: "/repo" } };
  const rootAgent = {
    session: rootSession,
    model: { current: () => ({ provider: "deepseek", model: "v4" }), select: () => {} },
    cancel: () => {},
    whenIdle: async () => {},
  };
  const childSession = { id: "child-1", header: { cwd: "/repo", origin: "subagent", parentSession: "root-1" } };
  const childAgent = { session: childSession };

  const fakeCtx = {
    root: { lifecycle: { isActive: true } },
    sessionPersistence: { list: async () => [] },
    sessions: { flush: async () => {}, get: () => undefined },
    logger: { warn: () => {} },
    llm: {
      listProviders: () => [{ id: "deepseek", name: "DeepSeek" }],
      listModels: async () => [{ id: "v4", name: "DeepSeek V4" }],
      resolveModelInfo: async () => ({}),
      resolveCallConfig: async (sel: unknown) => sel,
    },
    agents: {
      create: async (opts: { sessionId: string }) => {
        rootSession.id = opts.sessionId;
        childSession.header.parentSession = opts.sessionId;
        return { agent: rootAgent, dispose: async () => {} };
      },
    },
    get: (name: string) => {
      if (name === "subagents") {
        return { rootOf: (a: unknown) => (a === childAgent ? rootAgent : a) };
      }
      return undefined;
    },
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {
        const cur = listeners.get(event);
        if (cur) {
          const idx = cur.indexOf(fn);
          if (idx >= 0) cur.splice(idx, 1);
        }
      };
    },
    effect: () => {},
  };

  // Provide a minimal fake require that resolves node builtins and a mock @deepseek-ai/dsh-llm module.
  const { createRequire } = await import("node:module");
  const realRequire = createRequire(import.meta.url);
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tmp = mkdtempSync(join(tmpdir(), "paseo-dsh-test-llm-"));
  const fakeLlmPath = join(tmp, "llm.mjs");
  writeFileSync(
    fakeLlmPath,
    `export const LLM_FAILURE_CODES = { RATE_LIMIT: { retryChoice: true }, SERVER: { retryChoice: true }, AUTH: {} };
export function errorChain(e) { return e instanceof Error ? e.message : String(e); }
`,
  );

  const fakeRequire = Object.assign(
    (id: string) => realRequire(id),
    {
      resolve: (id: string) => {
        if (id === "@deepseek-ai/dsh-llm") return fakeLlmPath;
        throw new Error(`not found: ${id}`);
      },
    },
  );

  const notifications: Array<{ method: string; params: unknown }> = [];
  const hostRequests: Array<{ method: string; params: unknown }> = [];
  const hostPeer = new BridgeRpcPeer(input, output, {
    onNotification: (method, params) => notifications.push({ method, params }),
    onRequest: async (method, params) => {
      hostRequests.push({ method, params });
      return { outcome: "allowed-once" };
    },
  });

  try {
    applyDshBridge(fakeCtx, { input, output, profile: "acp", dshVersion: "0.2.2-test" }, fakeRequire);
    await hostPeer.request("bridge/init", {});
    await hostPeer.request("session/open", { cwd: "/repo" });

    // 1. Retryable agent/error (RATE_LIMIT) must NOT emit event/agent-error.
    for (const fn of listeners.get("agent/error") ?? []) {
      fn({ agent: rootAgent, error: Object.assign(new Error("rate limited"), { code: "RATE_LIMIT" }) });
    }
    // 2. Non-retryable agent/error (AUTH) MUST emit event/agent-error.
    for (const fn of listeners.get("agent/error") ?? []) {
      fn({ agent: rootAgent, error: Object.assign(new Error("bad api key"), { code: "AUTH" }) });
    }

    // 3. Subagent tool/call + approval/request must preserve tool input via rootRecord.
    for (const fn of listeners.get("session/created") ?? []) {
      fn(childSession);
    }
    for (const fn of listeners.get("session/event") ?? []) {
      fn(childSession, { type: "tool/call", data: { callId: "sub-call-1", arguments: '{"command":"ls"}' } });
    }
    const approvalHandler = (listeners.get("approval/request") ?? [])[0];
    assert.ok(approvalHandler);
    const outcome = await approvalHandler(
      { agent: childAgent, toolName: "bash", callId: "sub-call-1", reason: "run ls" },
      () => "next",
    );
    assert.equal(outcome, "allowed-once");

    await new Promise((r) => setTimeout(r, 30));

    const agentErrors = notifications.filter((n) => n.method === "event/agent-error");
    assert.equal(agentErrors.length, 1);
    assert.equal((agentErrors[0]?.params as { message: string }).message, "bad api key");

    const approvalReq = hostRequests.find((r) => r.method === "approval/request");
    assert.ok(approvalReq);
    assert.deepEqual((approvalReq.params as { input: unknown }).input, { command: "ls" });
  } finally {
    hostPeer.close();
    input.destroy();
    output.destroy();
    rmSync(tmp, { recursive: true, force: true });
  }
});
