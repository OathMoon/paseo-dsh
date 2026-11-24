import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import contribute from "../index.server.ts";
import { defaultDshLaunch, findDshAnchor } from "../server/launch.ts";

const root = await mkdtemp(path.join(tmpdir(), "paseo-dsh-direct-e2e-"));
const cwd = path.join(root, "workspace");
const wrongCwd = path.join(root, "other workspace");
await mkdir(cwd);
await mkdir(wrongCwd);
console.log(`Direct E2E artifacts: ${root}`);

const dshBase = defaultDshLaunch("acp");
const anchorInfo = await findDshAnchor(dshBase);
assert.ok(anchorInfo, "Installed dsh executable is required");
const dshRequire = createRequire(anchorInfo.anchor);
const llmUrl = pathToFileURL(dshRequire.resolve("@deepseek-ai/dsh-llm")).href;

// Keyless fixture plugin registering LLM adapter + approval tool + slow tool + ask_user tool
const adapterPath = path.join(root, "e2e-fixture.mjs");
await writeFile(
  adapterPath,
  `import { LlmAdapter } from ${JSON.stringify(llmUrl)};

class E2EAdapter extends LlmAdapter {
  providerInfo(provider) {
    if (provider !== "e2e-fixture") throw new Error("unknown provider: " + provider);
    return { id: provider, name: "E2E Fixture" };
  }
  async listModels(provider) {
    if (provider !== "e2e-fixture") return [];
    return [
      { provider, id: "alpha", name: "Alpha", inputModalities: ["text"] },
      { provider, id: "beta", name: "Beta", inputModalities: ["text"] },
    ];
  }
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ["text"],
      context: { contextWindow: 200000 },
      reasoning: {
        efforts: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
        defaultEffort: "high",
      },
    };
  }
  async *stream(options) {
    const userMessages = options.messages.filter(m => m.role === "user" && m.source?.kind === "user");
    const lastUserIndex = options.messages.findLastIndex(m => m.role === "user" && m.source?.kind === "user");
    const allUserTexts = userMessages.flatMap(m => m.content).filter(b => b.type === "text").map(b => b.text);
    const lastUserText = allUserTexts.at(-1) ?? "";
    const currentSlice = options.messages.slice(lastUserIndex);
    const toolResults = currentSlice.filter(m => m.role === "tool");
    const hasToolResult = toolResults.length > 0;

    // 1. Slow tool for steer or reload test
    if (lastUserText.includes("slow-tool") && !hasToolResult) {
      const callId = "slow-" + options.messages.length;
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id: callId, name: "e2e_slow", argumentsDelta: '{"ms":400}' };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id: callId, name: "e2e_slow", arguments: '{"ms":400}' } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    if (lastUserText.includes("hang-tool") && !hasToolResult) {
      const callId = "hang-" + options.messages.length;
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id: callId, name: "e2e_slow", argumentsDelta: '{"ms":30000}' };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id: callId, name: "e2e_slow", arguments: '{"ms":30000}' } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }

    // 2. Approval tool test
    if (lastUserText.includes("need-approval") && !hasToolResult) {
      const callId = "approve-" + options.messages.length;
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id: callId, name: "e2e_approve", argumentsDelta: '{"target":"file.txt"}' };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id: callId, name: "e2e_approve", arguments: '{"target":"file.txt"}' } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }

    // 3. Ask user question test
    if (lastUserText.includes("need-question") && !hasToolResult) {
      const callId = "ask-" + options.messages.length;
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id: callId, name: "e2e_ask", argumentsDelta: '{}' };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id: callId, name: "e2e_ask", arguments: '{}' } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }

    // 4. Standard MCP add tool
    if (lastUserText.includes("add-tool") && !hasToolResult) {
      const callId = "add-" + options.messages.length;
      yield { type: "block-start", index: 0, blockType: "reasoning" };
      yield { type: "reasoning-delta", index: 0, text: "step 1 " };
      yield { type: "reasoning-delta", index: 0, text: "step 2" };
      yield { type: "block-end", index: 0, block: { type: "reasoning", text: "step 1 step 2" } };
      yield { type: "block-start", index: 1, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 1, id: callId, name: "mcp__fixture__add", argumentsDelta: '{"a":2,"b":3}' };
      yield { type: "block-end", index: 1, block: { type: "tool-call", id: callId, name: "mcp__fixture__add", arguments: '{"a":2,"b":3}' } };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 6 } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }

    const lastToolText = toolResults.at(-1)?.content?.filter(b => b.type === "text")?.map(b => b.text)?.join("") ?? "none";
    const memory = allUserTexts.join("|");
    const text = "model=" + options.model + ";tool=" + lastToolText + ";users=" + memory;
    const mid = Math.max(1, Math.floor(text.length / 2));
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: text.slice(0, mid) };
    yield { type: "text-delta", index: 0, text: text.slice(mid) };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "usage", usage: { inputTokens: 20, outputTokens: 10 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

export const name = "e2e-fixture";
export const inject = ["llm", "tools", "approval"];
export function apply(ctx) {
  ctx.llm.registerAdapter(["e2e-fixture"], new E2EAdapter());
  ctx.tools.register({
    name: "e2e_slow",
    description: "Wait for ms",
    parameters: { ms: { type: "number", required: true } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, args.ms);
        exec.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
      return "slept";
    },
  });
  ctx.tools.register({
    name: "e2e_approve",
    description: "Require approval",
    parameters: { target: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      const outcome = await ctx.approval.request({
        agent: exec.agent,
        toolName: "e2e_approve",
        callId: exec.callId,
        reason: "Approve write to " + args.target,
        signal: exec.signal,
      });
      return "approval=" + outcome;
    },
  });
  ctx.tools.register({
    name: "e2e_ask",
    description: "Ask user a structured question",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(_args, exec) {
      const uq = ctx.get("userQuestions");
      const answer = await uq.ask({
        agent: exec.agent,
        signal: exec.signal,
        questions: [{
          id: "q1",
          header: "Runtime Choice",
          question: "Which mode?",
          options: [{ label: "Fast" }, { label: "Safe" }],
        }],
      });
      return "answered=" + JSON.stringify(answer);
    },
  });
}
`,
  "utf8",
);

const mcpServerPath = path.join(root, "fixture-mcp.mjs");
await writeFile(
  mcpServerPath,
  `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } }
    }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { tools: [{ name: "add", description: "Add", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }] }
    }) + "\\n");
  } else if (msg.method === "tools/call") {
    const { a, b } = msg.params.arguments ?? {};
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { content: [{ type: "text", text: String(Number(a) + Number(b)) }] }
    }) + "\\n");
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      error: { code: -32601, message: "Method not found" }
    }) + "\\n");
  }
});
`,
  "utf8",
);

const patchPath = path.join(root, "fixture.yml");
await writeFile(
  patchPath,
  [
    "- id: llm-deepseek",
    "  disabled: true",
    "- id: acp",
    "  config:",
    "    provider: e2e-fixture",
    "    model: alpha",
    "- id: session-persistence-jsonl",
    "  config:",
    `    root: ${JSON.stringify(path.join(root, "sessions"))}`,
    "    compression: none",
    "- id: session-log-deepseek",
    "  config:",
    "    enabled: false",
    "- insert:",
    "    - id: e2e-fixture",
    `      name: ${JSON.stringify(pathToFileURL(adapterPath).href)}`,
    "",
  ].join("\n"),
  "utf8",
);

const launch = {
  command: dshBase.command,
  args: ["--profile", "acp", "--patch", patchPath],
  env: {
    ...dshBase.env,
    DSH_HOME: path.join(root, "home"),
    DSH_AGENTS_HOME: path.join(root, "agents"),
    DSH_TELEMETRY_DISABLED: "1",
  },
};

let provider;
contribute({ registerProvider(reg) { provider = reg; } });
assert.ok(provider, "Provider must register");

// 0. Status check
const status = await provider.status({ launch });
assert.equal(status.available, true, `Expected available status, got: ${JSON.stringify(status)}`);
console.log(`Status OK: ${status.diagnostic}`);

const ALL_CAPS = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.revert.conversation",
  "session.subsession",
  "permission",
];

const config = {
  cwd,
  env: {},
  settings: {},
  persist: true,
  mcpServers: {
    fixture: { type: "stdio", command: process.execPath, args: [mcpServerPath] },
  },
};

async function createClient() {
  const conn = await provider.connect({ launch, versions: [1], capabilities: ALL_CAPS });
  const events = [];
  conn.onEvent((ev) => events.push(ev));
  async function until(predicate, start = 0, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.slice(start).find(predicate);
      if (found) return found;
      await delay(20);
    }
    throw new Error(`Timed out waiting for event. Last 5 events: ${JSON.stringify(events.slice(-5))}`);
  }
  return { conn, events, until };
}

let client;
try {
  client = await createClient();
  console.log(`Negotiated capabilities: ${client.conn.capabilities.join(", ")}`);
  assert.ok(client.conn.capabilities.includes("prompt.steer"));
  assert.ok(client.conn.capabilities.includes("prompt.command"));
  assert.ok(client.conn.capabilities.includes("session.revert.conversation"));
  assert.ok(client.conn.capabilities.includes("session.subsession"));

  // 1. Catalog check (global empty, workspace populated with models + modes)
  await client.conn.send({ type: "catalog", requestId: "cat-global" });
  const globalCat = await client.until((e) => e.type === "catalog" && e.requestId === "cat-global");
  assert.equal(globalCat.catalog.models.length, 0);

  await client.conn.send({ type: "catalog", requestId: "cat-ws", cwd });
  const wsCat = await client.until((e) => e.type === "catalog" && e.requestId === "cat-ws");
  assert.ok(wsCat.catalog.models.some((m) => m.label === "Alpha"));
  assert.ok(wsCat.catalog.models.some((m) => m.label === "Beta"));
  assert.ok(wsCat.catalog.modes.length >= 2, "Expected permissionPresets mapped to modes");
  console.log("PASS [Stage 1/2]: catalog models + permissionPresets modes");

  // 2. Open session, stream + MCP tool + dedup check
  await client.conn.send({ type: "session.open", requestId: "open-1", sessionId: "s1", history: "skip", config });
  await client.until((e) => e.type === "session.ready" && e.sessionId === "s1");
  const opened = client.events.find((e) => e.type === "session.opened" && e.sessionId === "s1");
  const handle1 = opened.persistence;
  assert.equal(handle1.version, 1);
  assert.equal(typeof handle1.data.sessionId, "string");

  const t1Start = client.events.length;
  await client.conn.send({
    type: "session.prompt",
    sessionId: "s1",
    prompt: { clientMessageId: "m1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "add-tool turn1" }] } },
  });
  const t1End = await client.until((e) => e.type === "session.turn" && e.sessionId === "s1" && e.state !== "started", t1Start);
  assert.equal(t1End.state, "completed");

  const t1Events = client.events.slice(t1Start);
  const assistantStreamUpdates = t1Events.filter((e) => e.type === "timeline.item" && e.item.type === "assistant_message");
  assert.ok(assistantStreamUpdates.length >= 2, `Expected incremental streaming updates, got ${assistantStreamUpdates.length}`);
  const uniqueAssistantIds = new Set(assistantStreamUpdates.map((e) => e.item.id));
  assert.equal(uniqueAssistantIds.size, 1, "Committed assistant/message must NOT duplicate streamed assistant_message");
  assert.ok(assistantStreamUpdates.at(-1).item.text.includes("model=alpha;tool=5"));
  assert.ok(t1Events.some((e) => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.status === "completed" && e.item.detail.output === "5"));
  console.log("PASS [Stage 2]: token-level streaming + dedup + MCP tool output");

  // 3. Configure model -> Beta & mode -> danger-full-access
  const betaModel = wsCat.catalog.models.find((m) => m.label === "Beta");
  await client.conn.send({
    type: "session.configure",
    requestId: "cfg-1",
    sessionId: "s1",
    changes: { model: betaModel.id, mode: "danger-full-access", thinkingOption: "low" },
  });
  await client.until((e) => e.type === "request.completed" && e.requestId === "cfg-1");
  const latestCfg = client.events.filter((e) => e.type === "session.config" && e.sessionId === "s1").at(-1);
  assert.equal(latestCfg.config.model, betaModel.id);
  assert.equal(latestCfg.config.mode, "danger-full-access");
  assert.equal(latestCfg.config.thinkingOption, "low");
  console.log("PASS [Stage 2]: dynamic model + mode + thinkingOption configure");

  // 4. Native slash command (/permission)
  const cmdStart = client.events.length;
  await client.conn.send({
    type: "session.prompt",
    sessionId: "s1",
    prompt: { clientMessageId: "cmd-1", delivery: "auto", input: { type: "command", name: "permission", arguments: "workspace-write" } },
  });
  const cmdRes = await client.until((e) => e.type === "session.prompt_result" && e.clientMessageId === "cmd-1", cmdStart);
  assert.equal(cmdRes.result.type, "completed");
  assert.ok(client.events.slice(cmdStart).some((e) => e.type === "session.notice"));
  console.log("PASS [Stage 3]: native slash command execution");

  // 5. Approval allow-once flow
  const appStart = client.events.length;
  await client.conn.send({
    type: "session.prompt",
    sessionId: "s1",
    prompt: { clientMessageId: "app-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "need-approval" }] } },
  });
  const permReq = await client.until((e) => e.type === "session.permission" && e.request.kind === "tool", appStart);
  assert.equal(permReq.request.name, "e2e_approve");
  await client.conn.send({
    type: "session.permission",
    sessionId: "s1",
    permissionId: permReq.request.id,
    response: { behavior: "allow" },
  });
  const appEnd = await client.until((e) => e.type === "session.turn" && e.state !== "started", appStart);
  assert.equal(appEnd.state, "completed");
  const appReply = client.events.slice(appStart).filter((e) => e.type === "timeline.item" && e.item.type === "assistant_message").at(-1);
  assert.ok(appReply.item.text.includes("approval=allowed-once"));
  console.log("PASS [Stage 1]: native approval request/allow flow");

  // 6. User question (ask_user) flow
  const qStart = client.events.length;
  await client.conn.send({
    type: "session.prompt",
    sessionId: "s1",
    prompt: { clientMessageId: "q-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "need-question" }] } },
  });
  const qReq = await client.until((e) => e.type === "session.permission" && e.request.kind === "question", qStart);
  assert.equal(qReq.request.kind, "question");
  await client.conn.send({
    type: "session.permission",
    sessionId: "s1",
    permissionId: qReq.request.id,
    response: { behavior: "allow", updatedInput: { answers: { q1: "Fast" } } },
  });
  const qEnd = await client.until((e) => e.type === "session.turn" && e.state !== "started", qStart);
  assert.equal(qEnd.state, "completed");
  const qReply = client.events.slice(qStart).filter((e) => e.type === "timeline.item" && e.item.type === "assistant_message").at(-1);
  assert.ok(qReply.item.text.includes("Fast"), `Expected Fast in reply, got: ${qReply.item.text}`);
  console.log("PASS [Stage 3]: user-question ask -> answer flow");

  // 7. Steer during slow tool
  const steerStart = client.events.length;
  await client.conn.send({
    type: "session.prompt",
    sessionId: "s1",
    prompt: { clientMessageId: "slow-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "slow-tool" }] } },
  });
  await client.until((e) => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.name === "e2e_slow" && e.item.status === "running", steerStart);
  await client.conn.send({
    type: "session.prompt",
    sessionId: "s1",
    prompt: { clientMessageId: "steer-1", delivery: "steer", input: { type: "message", content: [{ type: "text", text: "STEER_INJECTED" }] } },
  });
  const steerRes = await client.until((e) => e.type === "session.prompt_result" && e.clientMessageId === "steer-1", steerStart);
  assert.equal(steerRes.result.type, "steer");
  const steerEnd = await client.until((e) => e.type === "session.turn" && e.state !== "started", steerStart);
  assert.equal(steerEnd.state, "completed");
  const steerReply = client.events.slice(steerStart).filter((e) => e.type === "timeline.item" && e.item.type === "assistant_message").at(-1);
  assert.ok(steerReply.item.text.includes("STEER_INJECTED"), `Expected steer text in reply: ${steerReply.item.text}`);
  console.log("PASS [Stage 3]: steer during active tool without cancelling turn");

  // 8. Conversation revert via buildForkSeed
  const userMsgsWithRevert = client.events.filter((e) => e.type === "timeline.item" && e.item.type === "user_message" && e.item.revertToken);
  assert.ok(userMsgsWithRevert.length >= 2, "Expected revert tokens on user messages");
  const secondRevertToken = userMsgsWithRevert[1].item.revertToken;
  const revStart = client.events.length;
  await client.conn.send({
    type: "session.revert",
    requestId: "rev-1",
    sessionId: "s1",
    token: secondRevertToken,
    scope: "conversation",
  });
  await client.until((e) => e.type === "request.completed" && e.requestId === "rev-1", revStart);
  const newPersist = client.events.slice(revStart).find((e) => e.type === "session.persistence" && e.sessionId === "s1");
  assert.ok(newPersist && newPersist.persistence.data.sessionId !== handle1.data.sessionId, "Revert must fork a new sessionId");
  console.log("PASS [Stage 3]: conversation revert forked new sessionId without mutating original");

  // 9. Active tool terminalization on connection.close() (reload simulation)
  const hangStart = client.events.length;
  await client.conn.send({
    type: "session.prompt",
    sessionId: "s1",
    prompt: { clientMessageId: "hang-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hang-tool" }] } },
  });
  await client.until((e) => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.name === "e2e_slow" && e.item.status === "running", hangStart);
  await client.conn.close();
  const afterClose = client.events.slice(hangStart);
  const terminalTool = afterClose.find((e) => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.name === "e2e_slow" && e.item.status !== "running");
  assert.ok(terminalTool, "Expected activeToolTerminalObserved=true on close/reload!");
  console.log(`PASS [Stage 1]: activeToolTerminalObserved=true (status=${terminalTool.item.status})`);
  client = undefined;

  // 10. Restart, list sessions, replay reverted fork, and verify wrong-cwd rejection
  client = await createClient();
  await client.conn.send({ type: "sessions", requestId: "list-1", cwd });
  const listRes = await client.until((e) => e.type === "sessions" && e.requestId === "list-1");
  assert.ok(listRes.sessions.length >= 2, "Expected both original and forked sessions in session.list");

  const replayStart = client.events.length;
  await client.conn.send({
    type: "session.open",
    requestId: "open-fork",
    sessionId: "s-fork",
    history: "replay",
    persistence: newPersist.persistence,
    config,
  });
  await client.until((e) => e.type === "session.ready" && e.sessionId === "s-fork", replayStart);
  const replayedUsers = client.events.slice(replayStart).filter((e) => e.type === "timeline.item" && e.item.type === "user_message");
  assert.equal(replayedUsers.length, 1, `Reverted fork should replay only 1 user message, got ${replayedUsers.length}`);

  await client.conn.send({
    type: "session.open",
    requestId: "wrong-cwd",
    sessionId: "s-wrong",
    history: "replay",
    persistence: handle1,
    config: { ...config, cwd: wrongCwd },
  });
  const wrongFail = await client.until((e) => e.type === "request.failed" && e.requestId === "wrong-cwd");
  assert.ok(wrongFail);
  console.log("PASS [Stage 1/3]: session.list + fork history replay + wrong-cwd rejection");

  console.log("ALL DIRECT PROVIDER E2E GATES (STAGES 1-3) PASSED!");
} finally {
  await client?.conn.close();
}
