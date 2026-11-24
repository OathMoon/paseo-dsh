import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { defaultDshLaunch, findDshAnchor, prepareDshBridgeLaunch } from "../server/launch.ts";
import {
  BridgeCatalogResultSchema,
  BridgeInitResultSchema,
  BridgeRpcPeer,
  BridgeSessionStateSchema,
  BridgeTurnPromptResultSchema,
} from "../server/protocol.ts";

const root = await mkdtemp(path.join(tmpdir(), "paseo-dsh-stage0-bridge-"));
const cwd = path.join(root, "workspace");
await mkdir(cwd);
console.log(`Stage 0 artifacts: ${root}`);

const dshBase = defaultDshLaunch("acp");
const anchorInfo = await findDshAnchor(dshBase);
assert.ok(anchorInfo, "Installed dsh executable is required for Stage 0 bridge probe");
const dshRequire = createRequire(anchorInfo.anchor);
const llmUrl = pathToFileURL(dshRequire.resolve("@deepseek-ai/dsh-llm")).href;

// Self-contained keyless deterministic LLM adapter fixture
const adapterPath = path.join(root, "fixture-llm.mjs");
await writeFile(
  adapterPath,
  `import { LlmAdapter } from ${JSON.stringify(llmUrl)};

class FixtureAdapter extends LlmAdapter {
  providerInfo(provider) {
    if (provider !== "control-fixture") throw new Error("unknown provider: " + provider);
    return { id: provider, name: "Control fixture" };
  }
  async listModels(provider) {
    if (provider !== "control-fixture") return [];
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
      context: { contextWindow: 8192 },
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
    const lastUserIndex = options.messages.findLastIndex(m => m.role === "user" && m.source?.kind === "user");
    const current = options.messages.slice(lastUserIndex);
    const userText = current.flatMap(m => m.content).filter(b => b.type === "text").map(b => b.text).join("");
    const hasToolResult = current.some(m => m.role === "tool");
    if (!hasToolResult) {
      const callId = userText.includes("cancel") ? "control-cancel-add" : "control-add-" + options.messages.length;
      yield { type: "block-start", index: 0, blockType: "reasoning" };
      yield { type: "reasoning-delta", index: 0, text: "checking the attached tool" };
      yield { type: "block-end", index: 0, block: { type: "reasoning", text: "checking the attached tool" } };
      yield { type: "block-start", index: 1, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 1, id: callId, name: "mcp__fixture__add", argumentsDelta: '{"a":2,"b":3}' };
      yield { type: "block-end", index: 1, block: { type: "tool-call", id: callId, name: "mcp__fixture__add", arguments: '{"a":2,"b":3}' } };
      yield { type: "usage", usage: { inputTokens: 8, outputTokens: 5 } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    if (userText.includes("cancel")) {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "waiting" };
      await new Promise((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error("cancelled")); return; }
        options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
      return;
    }
    const text = "model=" + options.model + "; tool=5";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "usage", usage: { inputTokens: 13, outputTokens: 5 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

export const name = "control-surface-llm";
export const inject = ["llm"];
export function apply(ctx) {
  ctx.llm.registerAdapter(["control-fixture"], new FixtureAdapter());
}
`,
  "utf8",
);

// Self-contained stdio MCP server with add(a, b) tool
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
      result: { tools: [{ name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }] }
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
      error: { code: -32601, message: "Method not found: " + msg.method }
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
    "    provider: control-fixture",
    "    model: alpha",
    "- id: session-persistence-jsonl",
    "  config:",
    `    root: ${JSON.stringify(path.join(root, "sessions"))}`,
    "    compression: none",
    "- id: session-log-deepseek",
    "  config:",
    "    enabled: false",
    "- insert:",
    "    - id: control-surface-llm",
    `      name: ${JSON.stringify(pathToFileURL(adapterPath).href)}`,
    "",
  ].join("\n"),
  "utf8",
);

const baseLaunch = {
  command: dshBase.command,
  args: ["--profile", "acp", "--patch", patchPath],
  env: {
    ...dshBase.env,
    DSH_HOME: path.join(root, "home"),
    DSH_AGENTS_HOME: path.join(root, "agents"),
    DSH_TELEMETRY_DISABLED: "1",
  },
};

const mcpServers = [
  {
    name: "fixture",
    type: "stdio",
    command: process.execPath,
    args: [mcpServerPath],
  },
];

async function spawnBridge() {
  const prepared = await prepareDshBridgeLaunch(baseLaunch);
  const child = spawnProcess(prepared.launch.command, prepared.launch.args, {
    env: prepared.launch.env,
    stdio: "pipe",
  });
  const notifications = [];
  const protocolErrors = [];
  let stderrText = "";
  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString("utf8");
  });
  const peer = new BridgeRpcPeer(child.stdin, child.stdout, {
    onNotification(method, params) {
      notifications.push({ method, params });
    },
    onProtocolError(error, rawLine) {
      protocolErrors.push({ message: error.message, rawLine });
    },
  });
  return {
    child,
    peer,
    notifications,
    protocolErrors,
    get stderr() {
      return stderrText;
    },
    async waitNotification(predicate, startIndex = 0, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = notifications.slice(startIndex).find(predicate);
        if (found) return found;
        await delay(20);
      }
      throw new Error(`Timed out waiting for bridge notification. stderr:\n${stderrText}`);
    },
    async close() {
      peer.close();
      if (child.exitCode === null && child.signalCode === null) {
        await terminateProcess(child, "SIGTERM");
      }
    },
  };
}

let bridge1;
let bridge2;
try {
  bridge1 = await spawnBridge();
  const init = BridgeInitResultSchema.parse(await bridge1.peer.request("bridge/init", {}, 60_000));
  assert.equal(init.protocolVersion, 1);
  assert.equal(init.capabilities.streaming, true);
  console.log(`Initialized DSH bridge: version=${init.dshVersion}, profile=${init.profile}, caps=${JSON.stringify(init.capabilities)}`);

  const catalog = BridgeCatalogResultSchema.parse(
    await bridge1.peer.request("catalog/get", {}, 30_000),
  );
  const modelNames = catalog.providers.flatMap((p) => p.models.map((m) => m.name));
  assert.ok(modelNames.includes("Alpha") && modelNames.includes("Beta"), `Unexpected models: ${modelNames.join(", ")}`);

  const opened = BridgeSessionStateSchema.parse(
    await bridge1.peer.request("session/open", { cwd, mcpServers }, 60_000),
  );
  assert.ok(opened.sessionId.length > 0);

  // 1. Prompt with MCP tool call & streaming check
  const startIdx = bridge1.notifications.length;
  const promptResult = BridgeTurnPromptResultSchema.parse(
    await bridge1.peer.request(
      "turn/prompt",
      {
        sessionId: opened.sessionId,
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "first bridge addition" }] },
      },
      30_000,
    ),
  );
  assert.equal(promptResult.kind, "turn");

  await bridge1.waitNotification(
    (n) => n.method === "event/session" && n.params?.event?.type === "turn/end",
    startIdx,
  );
  const turnEvents = bridge1.notifications.slice(startIdx);
  const hasToolResult5 = turnEvents.some(
    (n) =>
      n.method === "event/session" &&
      n.params?.event?.type === "tool/result" &&
      n.params?.event?.data?.message?.content?.[0]?.text === "5",
  );
  assert.ok(hasToolResult5, "Expected MCP tool result '5'");
  const hasStreamFrames = turnEvents.some((n) => n.method === "event/stream");
  assert.ok(hasStreamFrames, "Expected live event/stream frames");

  // 2. Cancel check
  const cancelStart = bridge1.notifications.length;
  await bridge1.peer.request(
    "turn/prompt",
    {
      sessionId: opened.sessionId,
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "cancel after tool" }] },
    },
    30_000,
  );
  await bridge1.waitNotification(
    (n) => n.method === "event/session" && n.params?.event?.type === "tool/result",
    cancelStart,
  );
  await bridge1.peer.request("turn/cancel", { sessionId: opened.sessionId }, 15_000);
  await bridge1.waitNotification(
    (n) => n.method === "event/session" && n.params?.event?.type === "turn/end",
    cancelStart,
  );

  // 3. Close cleanly and verify zero stdout protocol errors
  await bridge1.peer.request("session/close", { sessionId: opened.sessionId }, 15_000);
  assert.equal(bridge1.protocolErrors.length, 0, `Stdout noise detected: ${JSON.stringify(bridge1.protocolErrors)}`);
  await bridge1.close();
  bridge1 = undefined;

  // 4. Restart DSH and resume with history replay
  bridge2 = await spawnBridge();
  await bridge2.peer.request("bridge/init", {}, 60_000);
  const resumeStart = bridge2.notifications.length;
  const resumed = BridgeSessionStateSchema.parse(
    await bridge2.peer.request(
      "session/resume",
      { sessionId: opened.sessionId, cwd, mcpServers, history: "replay" },
      60_000,
    ),
  );
  assert.equal(resumed.sessionId, opened.sessionId);
  const replayNotification = bridge2.notifications
    .slice(resumeStart)
    .find((n) => n.method === "event/replay");
  assert.ok(replayNotification, "Expected event/replay notification on resume");
  assert.ok(replayNotification.params.events.length > 0, "Expected non-empty replayed events");
  assert.equal(bridge2.protocolErrors.length, 0, `Stdout noise on resume: ${JSON.stringify(bridge2.protocolErrors)}`);

  await bridge2.peer.request("session/close", { sessionId: opened.sessionId }, 15_000);
  await bridge2.close();
  bridge2 = undefined;

  console.log("PASS: Stage 0 bridge init -> catalog -> open -> MCP tool + stream -> cancel -> restart resume.");
} finally {
  await bridge1?.close();
  await bridge2?.close();
}
