import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { encodeModelId, toProviderCatalog, toProviderConfigState } from "../server/mappers/config.ts";
import { mapProviderContentToBridgeBlocks } from "../server/mappers/content.ts";
import { buildToolCallDetail, extractToolOutputText } from "../server/mappers/tools.ts";
import { inspectDshStatus } from "../server/launch.ts";
import { BridgeRpcPeer, type BridgeCatalogResult, type BridgeSessionState } from "../server/protocol.ts";
import { nativePersistence, readNativeSessionId } from "../server/session.ts";

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
