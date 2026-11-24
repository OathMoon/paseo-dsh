import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type {
  ProviderCapability,
  ProviderConfigChanges,
  ProviderEvent,
  ProviderInput,
  ProviderLaunch,
  ProviderMcpServerConfig,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderPersistence,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import { toProviderConfigState } from "./mappers/config.ts";
import { mapProviderContentToBridgeBlocks } from "./mappers/content.ts";
import { buildToolCallDetail, extractToolOutputText, parseToolArguments, toJsonValue } from "./mappers/tools.ts";
import { prepareDshBridgeLaunch } from "./launch.ts";
import {
  BridgeApprovalRequestParamsSchema,
  BridgeInitResultSchema,
  BridgeRevertResultSchema,
  BridgeRpcPeer,
  BridgeSessionStateSchema,
  BridgeTurnPromptResultSchema,
  BridgeUserQuestionRequestParamsSchema,
  type BridgeInitResult,
  type BridgeMcpServer,
  type BridgeSessionState,
  type BridgeUserQuestionItem,
} from "./protocol.ts";

type ToolCallTimelineItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;

interface StreamAttemptState {
  textId: string;
  text: string;
  reasoningId: string;
  reasoning: string;
}

interface PendingApproval {
  kind: "approval";
  permissionId: string;
  resolve(outcome: "allowed-once" | "rejected" | "cancelled"): void;
}

interface PendingQuestion {
  kind: "question";
  permissionId: string;
  questions: readonly BridgeUserQuestionItem[];
  resolve(answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> } | { cancelled: true }): void;
}

type PendingPermission = PendingApproval | PendingQuestion;

export interface DshSessionRuntimeOptions {
  boundarySessionId: string;
  baseLaunch: ProviderLaunch;
  env: Readonly<Record<string, string>>;
  startupTimeoutMs: number;
  emit(event: ProviderEvent): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nativePersistence(sessionId: string): ProviderPersistence {
  return { version: 1, data: { sessionId } };
}

export function readNativeSessionId(persistence: ProviderPersistence | undefined): string | undefined {
  if (!persistence || persistence.version !== 1 || !isRecord(persistence.data)) return undefined;
  return typeof persistence.data.sessionId === "string" && persistence.data.sessionId.length > 0
    ? persistence.data.sessionId
    : undefined;
}

function toBridgeMcpServers(
  mcpServers: Readonly<Record<string, ProviderMcpServerConfig>>,
): BridgeMcpServer[] {
  const result: BridgeMcpServer[] = [];
  for (const [name, server] of Object.entries(mcpServers)) {
    if (server.type === "stdio") {
      result.push({
        name,
        type: "stdio",
        command: server.command,
        ...(server.args ? { args: [...server.args] } : {}),
        ...(server.env ? { env: { ...server.env } } : {}),
      });
    } else if (server.type === "http" || server.type === "sse") {
      result.push({
        name,
        type: server.type,
        url: server.url,
        ...(server.headers ? { headers: { ...server.headers } } : {}),
      });
    }
  }
  return result;
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class DshSessionRuntime {
  readonly boundarySessionId: string;
  private readonly emit: (event: ProviderEvent) => void;
  private readonly child: ChildProcessWithoutNullStreams;
  readonly peer: BridgeRpcPeer;
  readonly initInfo: BridgeInitResult;

  nativeSessionId = "";
  cwd = "";
  private imageSupported = false;
  private closing = false;
  private processFailed = false;
  private stderrTail = "";

  private activeTurnId: string | null = null;
  private pendingPromptClientMessageId: string | null = null;
  private pendingPromptTurnResolver: (() => void) | null = null;
  private readonly runningTools = new Map<string, { item: ToolCallTimelineItem; rawInput: unknown }>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly streamAttempts = new Map<string, StreamAttemptState>();
  private readonly activeStreamKeyBySession = new Map<string, string>();
  private readonly committedStreams = new Map<number, { hadText: boolean; hadReasoning: boolean }>();
  private readonly openSubsessions = new Set<string>();
  private readonly emittedUserMessageIds = new Set<string>();

  static async start(options: DshSessionRuntimeOptions): Promise<DshSessionRuntime> {
    const prepared = await prepareDshBridgeLaunch(options.baseLaunch);
    const child = spawnProcess(prepared.launch.command, prepared.launch.args, {
      env: { ...prepared.launch.env, ...options.env },
      stdio: "pipe",
    });
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", reject);
    });
    const runtime = new DshSessionRuntime(child, options);
    try {
      const rawInit = await Promise.race([
        runtime.peer.request("bridge/init", {}, options.startupTimeoutMs),
        spawnFailure,
      ]);
      const initInfo = BridgeInitResultSchema.parse(rawInit);
      if (initInfo.protocolVersion !== 1) {
        throw new Error(
          `Unsupported DSH bridge protocol version ${initInfo.protocolVersion} (DSH ${initInfo.dshVersion})`,
        );
      }
      (runtime as { initInfo: BridgeInitResult }).initInfo = initInfo;
      return runtime;
    } catch (error) {
      await runtime.close("failed");
      throw error;
    }
  }

  private constructor(
    child: ChildProcessWithoutNullStreams,
    options: DshSessionRuntimeOptions,
  ) {
    this.boundarySessionId = options.boundarySessionId;
    this.emit = options.emit;
    this.child = child;
    this.initInfo = {
      protocolVersion: 1,
      dshVersion: "unknown",
      profile: "unknown",
      capabilities: {
        streaming: true,
        commands: false,
        permissionPresets: false,
        images: false,
        userQuestions: false,
        revert: false,
        subsessions: false,
      },
    };

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-4096);
    });

    this.peer = new BridgeRpcPeer(child.stdin, child.stdout, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleHostRequest(method, params),
    });

    child.on("error", (error) => {
      this.handleProcessFailure(error.message);
    });
    child.once("close", (code, signal) => {
      if (this.closing || this.processFailed) return;
      this.handleProcessFailure(
        `DSH process exited unexpectedly (${signal ?? code ?? "unknown"})${this.stderrTail ? `: ${this.stderrTail.trim().split("\n").at(-1)}` : ""}`,
      );
    });
  }

  async open(
    input: Extract<ProviderInput, { type: "session.open" }>,
    connectionCapabilities: readonly ProviderCapability[],
  ): Promise<readonly ProviderCapability[]> {
    this.cwd = input.config.cwd;
    const mcpServers = toBridgeMcpServers(input.config.mcpServers);
    const resumeId = readNativeSessionId(input.persistence);
    const rawState = resumeId
      ? await this.peer.request(
          "session/resume",
          {
            sessionId: resumeId,
            cwd: input.config.cwd,
            mcpServers,
            ...(input.config.model ? { model: input.config.model } : {}),
            ...(input.config.mode ? { mode: input.config.mode } : {}),
            ...(input.config.thinkingOption ? { thinkingOption: input.config.thinkingOption } : {}),
            history: input.history,
          },
          90_000,
        )
      : await this.peer.request(
          "session/open",
          {
            cwd: input.config.cwd,
            mcpServers,
            ...(input.config.model ? { model: input.config.model } : {}),
            ...(input.config.mode ? { mode: input.config.mode } : {}),
            ...(input.config.thinkingOption ? { thinkingOption: input.config.thinkingOption } : {}),
            persist: input.config.persist,
          },
          90_000,
        );

    const state = BridgeSessionStateSchema.parse(rawState);
    this.nativeSessionId = state.sessionId;
    this.imageSupported = state.imageSupported;

    const sessionCapabilities = connectionCapabilities.filter((cap) => {
      if (cap === "prompt.image") return state.imageSupported;
      if (cap === "prompt.command") return this.initInfo.capabilities.commands;
      if (cap === "session.revert.conversation") return this.initInfo.capabilities.revert;
      if (cap === "session.subsession") return this.initInfo.capabilities.subsessions;
      return true;
    });

    this.emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId: this.boundarySessionId,
      capabilities: sessionCapabilities,
      restoration: "core",
      persistence: nativePersistence(this.nativeSessionId),
      title: input.config.title,
      cwd: input.config.cwd,
    });
    this.emitSessionState(state);
    this.emit({
      type: "session.ready",
      requestId: input.requestId,
      sessionId: this.boundarySessionId,
    });
    return sessionCapabilities;
  }

  async prompt(input: Extract<ProviderInput, { type: "session.prompt" }>): Promise<void> {
    const { prompt } = input;
    if (prompt.input.type === "command") {
      try {
        const raw = await this.peer.request("turn/prompt", {
          sessionId: this.nativeSessionId,
          delivery: "auto",
          input: {
            type: "command",
            name: prompt.input.name,
            arguments: prompt.input.arguments,
          },
        });
        const result = BridgeTurnPromptResultSchema.parse(raw);
        if (result.kind === "command") {
          if (result.text) {
            this.emit({
              type: "session.notice",
              sessionId: this.boundarySessionId,
              notice: {
                id: result.commandId,
                severity: result.status === "error" ? "error" : "info",
                title: `/${prompt.input.name}`,
                description: result.text,
              },
            });
          }
          if (result.status === "error") {
            this.emit({
              type: "session.prompt_result",
              sessionId: this.boundarySessionId,
              clientMessageId: prompt.clientMessageId,
              result: { type: "failed", error: { message: result.text ?? `Command /${prompt.input.name} failed` } },
            });
          } else {
            this.emit({
              type: "session.prompt_result",
              sessionId: this.boundarySessionId,
              clientMessageId: prompt.clientMessageId,
              result: { type: "completed" },
            });
          }
        }
      } catch (error) {
        this.emit({
          type: "session.prompt_result",
          sessionId: this.boundarySessionId,
          clientMessageId: prompt.clientMessageId,
          result: {
            type: "failed",
            error: { message: error instanceof Error ? error.message : String(error) },
          },
        });
      }
      return;
    }

    const { blocks, displayText } = mapProviderContentToBridgeBlocks(
      prompt.input.content,
      this.imageSupported,
    );

    if (prompt.delivery === "steer") {
      if (!this.activeTurnId) {
        this.emit({
          type: "session.prompt_result",
          sessionId: this.boundarySessionId,
          clientMessageId: prompt.clientMessageId,
          result: { type: "failed", error: { message: "No active turn to steer" } },
        });
        return;
      }
      const raw = await this.peer.request("turn/prompt", {
        sessionId: this.nativeSessionId,
        delivery: "steer",
        input: { type: "message", content: blocks },
      });
      const result = BridgeTurnPromptResultSchema.parse(raw);
      this.emittedUserMessageIds.add(result.kind === "steer" ? result.messageId : prompt.clientMessageId);
      this.emit({
        type: "timeline.item",
        sessionId: this.boundarySessionId,
        item: {
          type: "user_message",
          id: result.kind === "steer" ? result.messageId : prompt.clientMessageId,
          text: displayText,
          clientMessageId: prompt.clientMessageId,
        },
      });
      this.emit({
        type: "session.prompt_result",
        sessionId: this.boundarySessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "steer", turnId: this.activeTurnId },
      });
      return;
    }

    const turnId = `dsh:${prompt.clientMessageId}`;
    this.activeTurnId = turnId;
    this.pendingPromptClientMessageId = prompt.clientMessageId;

    const raw = await this.peer.request("turn/prompt", {
      sessionId: this.nativeSessionId,
      delivery: "auto",
      input: { type: "message", content: blocks },
    });
    const result = BridgeTurnPromptResultSchema.parse(raw);
    const messageId = result.kind === "turn" ? result.messageId : prompt.clientMessageId;
    this.emittedUserMessageIds.add(messageId);

    this.emit({
      type: "timeline.item",
      sessionId: this.boundarySessionId,
      item: {
        type: "user_message",
        id: messageId,
        text: displayText,
        clientMessageId: prompt.clientMessageId,
      },
    });
    this.emit({
      type: "session.prompt_result",
      sessionId: this.boundarySessionId,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.emit({
      type: "session.turn",
      sessionId: this.boundarySessionId,
      turnId,
      state: "started",
    });
  }

  async interrupt(): Promise<void> {
    // Cancel all locally pending permissions first so DSH tool execution unblocks immediately.
    this.cancelPendingPermissions();
    if (this.nativeSessionId) {
      await this.peer.request("turn/cancel", { sessionId: this.nativeSessionId }, 10_000).catch(() => {});
    }
    if (this.activeTurnId) {
      await settlesWithin(
        new Promise<void>((resolve) => {
          this.pendingPromptTurnResolver = resolve;
        }),
        5_000,
      );
      this.pendingPromptTurnResolver = null;
    }
  }

  respondToPermission(permissionId: string, response: ProviderPermissionResponse): void {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) return;
    this.pendingPermissions.delete(permissionId);
    if (pending.kind === "approval") {
      const outcome = response.behavior === "allow" ? "allowed-once" : "rejected";
      pending.resolve(outcome);
    } else {
      if (response.behavior === "deny") {
        pending.resolve({ cancelled: true });
      } else {
        const answers = this.buildQuestionAnswers(pending.questions, response);
        pending.resolve({ answers });
      }
    }
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.boundarySessionId,
      permissionId,
    });
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    const raw = await this.peer.request(
      "session/configure",
      {
        sessionId: this.nativeSessionId,
        ...(changes.model !== undefined ? { model: changes.model } : {}),
        ...(changes.mode !== undefined ? { mode: changes.mode } : {}),
        ...(changes.thinkingOption !== undefined ? { thinkingOption: changes.thinkingOption } : {}),
      },
      30_000,
    );
    const state = BridgeSessionStateSchema.parse(raw);
    this.imageSupported = state.imageSupported;
    this.emitSessionState(state);
  }

  async revert(token: JsonValue, scope: "conversation" | "files" | "both"): Promise<void> {
    if (scope !== "conversation") {
      throw new Error(`DSH only supports conversation revert (got scope: ${scope})`);
    }
    const beforeSeq = isRecord(token) && typeof token.beforeSeq === "number" ? token.beforeSeq : undefined;
    if (beforeSeq === undefined || !Number.isSafeInteger(beforeSeq)) {
      throw new Error("Invalid DSH revert token: missing integer beforeSeq");
    }
    const raw = await this.peer.request(
      "session/revert",
      { sessionId: this.nativeSessionId, beforeSeq },
      30_000,
    );
    const { newSessionId } = BridgeRevertResultSchema.parse(raw);
    this.emit({
      type: "session.persistence",
      sessionId: this.boundarySessionId,
      persistence: nativePersistence(newSessionId),
    });
  }

  async close(terminalReason: "canceled" | "failed" = "canceled"): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.cancelPendingPermissions();
    this.terminalizeRunningTools(terminalReason);
    if (this.activeTurnId) {
      const turnId = this.activeTurnId;
      this.activeTurnId = null;
      this.emit({
        type: "session.turn",
        sessionId: this.boundarySessionId,
        turnId,
        state: terminalReason,
        ...(terminalReason === "failed"
          ? { error: { message: "DSH session terminated during active turn" } }
          : {}),
      });
    }
    for (const childId of this.openSubsessions) {
      this.emit({ type: "session.closed", sessionId: childId });
    }
    this.openSubsessions.clear();

    if (this.nativeSessionId && !this.processFailed) {
      await this.peer
        .request("session/close", { sessionId: this.nativeSessionId }, 3_000)
        .catch(() => {});
    }
    this.peer.close();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const closed = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
      await terminateProcess(this.child, "SIGTERM");
      if (!(await settlesWithin(closed, 1_500))) {
        await terminateProcess(this.child);
      }
    }
  }

  private handleProcessFailure(message: string): void {
    if (this.closing || this.processFailed) return;
    this.processFailed = true;
    this.cancelPendingPermissions();
    this.terminalizeRunningTools("failed");
    if (this.activeTurnId) {
      const turnId = this.activeTurnId;
      this.activeTurnId = null;
      this.emit({
        type: "session.turn",
        sessionId: this.boundarySessionId,
        turnId,
        state: "failed",
        error: { message },
      });
    }
    if (this.nativeSessionId) {
      this.emit({
        type: "session.runtime_failed",
        sessionId: this.boundarySessionId,
        error: { message },
      });
    }
  }

  private cancelPendingPermissions(): void {
    for (const [permissionId, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(permissionId);
      if (pending.kind === "approval") {
        pending.resolve("cancelled");
      } else {
        pending.resolve({ cancelled: true });
      }
      this.emit({
        type: "session.permission_resolved",
        sessionId: this.boundarySessionId,
        permissionId,
      });
    }
  }

  private terminalizeRunningTools(state: "canceled" | "failed"): void {
    for (const [callId, entry] of this.runningTools) {
      this.runningTools.delete(callId);
      const item: ToolCallTimelineItem =
        state === "failed"
          ? {
              ...entry.item,
              status: "failed",
              error: { message: "Tool interrupted before completion" },
            }
          : {
              ...entry.item,
              status: "canceled",
              error: null,
            };
      this.emit({
        type: "timeline.item",
        sessionId: this.boundarySessionId,
        item,
      });
    }
  }

  private emitSessionState(state: BridgeSessionState): void {
    this.emit({
      type: "session.config",
      sessionId: this.boundarySessionId,
      config: toProviderConfigState(state),
    });
    if (state.commands.length > 0 || this.initInfo.capabilities.commands) {
      this.emit({
        type: "session.commands",
        sessionId: this.boundarySessionId,
        commands: state.commands.map((cmd) => ({
          name: cmd.name,
          description: cmd.description,
          ...(cmd.argumentHint !== undefined ? { argumentHint: cmd.argumentHint } : {}),
        })),
      });
    }
  }

  private async handleHostRequest(method: string, rawParams: unknown): Promise<unknown> {
    if (method === "approval/request") {
      const params = BridgeApprovalRequestParamsSchema.parse(rawParams);
      const permissionId = `approval:${params.callId ?? randomUUID()}`;
      const detail = buildToolCallDetail(params.toolName, params.input ?? {});
      const request: ProviderPermissionRequest = {
        id: permissionId,
        name: params.toolName,
        kind: "tool",
        title: `Allow ${params.toolName}`,
        ...(params.reason ? { description: params.reason } : {}),
        input: isRecord(params.input) ? (toJsonValue(params.input) as Record<string, JsonValue>) : {},
        detail,
        actions: [
          { id: "allow-once", label: "Allow once", behavior: "allow", variant: "primary" },
          { id: "reject-once", label: "Reject", behavior: "deny", variant: "danger" },
        ],
      };
      return await new Promise<{ outcome: "allowed-once" | "rejected" | "cancelled" }>((resolve) => {
        this.pendingPermissions.set(permissionId, {
          kind: "approval",
          permissionId,
          resolve: (outcome) => resolve({ outcome }),
        });
        this.emit({
          type: "session.permission",
          sessionId: this.boundarySessionId,
          request,
        });
      });
    }

    if (method === "user-question/ask") {
      const params = BridgeUserQuestionRequestParamsSchema.parse(rawParams);
      const permissionId = `question:${params.requestId}`;
      const questionsPayload = params.questions.map((q) => ({
        question: q.question,
        header: q.header ?? q.id,
        options: q.options.map((opt) => ({
          label: opt.label,
          ...(opt.description ? { description: opt.description } : {}),
        })),
        ...(q.multiSelect ? { multiSelect: true } : {}),
        allowOther: q.allowCustom !== false,
      }));
      const request: ProviderPermissionRequest = {
        id: permissionId,
        name: "question",
        kind: "question",
        title: params.questions[0]?.header ?? "Question",
        input: { questions: questionsPayload },
        metadata: { source: "dsh_user_question", requestId: params.requestId },
      };
      return await new Promise((resolve) => {
        this.pendingPermissions.set(permissionId, {
          kind: "question",
          permissionId,
          questions: params.questions,
          resolve,
        });
        this.emit({
          type: "session.permission",
          sessionId: this.boundarySessionId,
          request,
        });
      });
    }

    throw new Error(`Unsupported DSH host request: ${method}`);
  }

  private buildQuestionAnswers(
    questions: readonly BridgeUserQuestionItem[],
    response: Extract<ProviderPermissionResponse, { behavior: "allow" }>,
  ): Array<{ id: string; selected: string[]; custom?: string }> {
    const rawAnswers = isRecord(response.updatedInput) ? response.updatedInput.answers : undefined;
    if (Array.isArray(rawAnswers)) {
      return questions.map((q, idx) => {
        const entry = rawAnswers[idx];
        if (isRecord(entry) && Array.isArray(entry.selected)) {
          return {
            id: q.id,
            selected: entry.selected.map(String),
            ...(typeof entry.custom === "string" ? { custom: entry.custom } : {}),
          };
        }
        return { id: q.id, selected: entry !== undefined ? [String(entry)] : [] };
      });
    }
    if (isRecord(rawAnswers)) {
      return questions.map((q) => {
        const val = rawAnswers[q.id] ?? rawAnswers[q.question] ?? rawAnswers[q.header ?? ""];
        if (Array.isArray(val)) return { id: q.id, selected: val.map(String) };
        if (typeof val === "string") {
          const isOption = q.options.some((opt) => opt.label === val);
          return isOption ? { id: q.id, selected: [val] } : { id: q.id, selected: [], custom: val };
        }
        return { id: q.id, selected: [] };
      });
    }
    if (response.selectedActionId) {
      return questions.map((q) => ({ id: q.id, selected: [response.selectedActionId!] }));
    }
    return questions.map((q) => ({
      id: q.id,
      selected: q.options[0] ? [q.options[0].label] : [],
    }));
  }

  private handleNotification(method: string, rawParams: unknown): void {
    if (this.closing || !isRecord(rawParams)) return;

    if (method === "event/replay" && Array.isArray(rawParams.events)) {
      for (const ev of rawParams.events) {
        this.processSessionEvent(this.boundarySessionId, ev, true);
      }
      return;
    }

    if (method === "event/stream") {
      const targetSessionId =
        rawParams.isSubagent === true && typeof rawParams.sessionId === "string"
          ? rawParams.sessionId
          : this.boundarySessionId;
      this.processStreamFrame(targetSessionId, rawParams.frame);
      return;
    }

    if (method === "event/session") {
      const targetSessionId =
        rawParams.isSubagent === true && typeof rawParams.sessionId === "string"
          ? rawParams.sessionId
          : this.boundarySessionId;
      this.processSessionEvent(targetSessionId, rawParams.event, false);
      return;
    }

    if (method === "event/config" && rawParams.state) {
      const parsed = BridgeSessionStateSchema.safeParse(rawParams.state);
      if (parsed.success) {
        this.imageSupported = parsed.data.imageSupported;
        this.emitSessionState(parsed.data);
      }
      return;
    }

    if (method === "event/commands" && Array.isArray(rawParams.commands)) {
      this.emit({
        type: "session.commands",
        sessionId: this.boundarySessionId,
        commands: rawParams.commands
          .filter(isRecord)
          .map((cmd) => ({
            name: String(cmd.name ?? ""),
            description: String(cmd.description ?? ""),
            ...(typeof cmd.argumentHint === "string" ? { argumentHint: cmd.argumentHint } : {}),
          }))
          .filter((cmd) => cmd.name.length > 0),
      });
      return;
    }

    if (method === "event/question-cancelled" && typeof rawParams.requestId === "string") {
      const permissionId = `question:${rawParams.requestId}`;
      const pending = this.pendingPermissions.get(permissionId);
      if (pending && pending.kind === "question") {
        this.pendingPermissions.delete(permissionId);
        pending.resolve({ cancelled: true });
        this.emit({
          type: "session.permission_resolved",
          sessionId: this.boundarySessionId,
          permissionId,
        });
      }
      return;
    }

    if (method === "event/subagent") {
      const kind = rawParams.kind;
      const childSessionId = typeof rawParams.childSessionId === "string" ? rawParams.childSessionId : undefined;
      if (!childSessionId) return;
      if (kind === "started") {
        const parentId =
          typeof rawParams.parentSessionId === "string" && rawParams.parentSessionId !== this.nativeSessionId
            ? rawParams.parentSessionId
            : this.boundarySessionId;
        this.openSubsessions.add(childSessionId);
        this.emit({
          type: "session.opened",
          sessionId: childSessionId,
          parentSessionId: parentId,
          ...(typeof rawParams.toolCallId === "string" ? { toolCallId: rawParams.toolCallId } : {}),
          capabilities: [],
          restoration: "parent",
          title: "DSH Subagent",
          cwd: this.cwd,
        });
        this.emit({ type: "session.ready", sessionId: childSessionId });
      } else if (kind === "finished") {
        if (this.openSubsessions.delete(childSessionId)) {
          this.emit({ type: "session.closed", sessionId: childSessionId });
        }
      }
      return;
    }

    if (method === "event/agent-error" && typeof rawParams.message === "string") {
      if (this.activeTurnId) {
        const turnId = this.activeTurnId;
        this.activeTurnId = null;
        this.terminalizeRunningTools("failed");
        this.emit({
          type: "session.turn",
          sessionId: this.boundarySessionId,
          turnId,
          state: "failed",
          error: { message: rawParams.message },
        });
        this.pendingPromptTurnResolver?.();
      }
    }
  }

  private processStreamFrame(targetSessionId: string, rawFrame: unknown): void {
    if (!isRecord(rawFrame) || typeof rawFrame.attemptId !== "string") return;
    const attemptId = rawFrame.attemptId;
    const key = `${targetSessionId}:${attemptId}`;

    if (rawFrame.type === "start") {
      this.streamAttempts.set(key, {
        textId: `stream:text:${attemptId}`,
        text: "",
        reasoningId: `stream:reasoning:${attemptId}`,
        reasoning: "",
      });
      this.activeStreamKeyBySession.set(targetSessionId, key);
      return;
    }

    if (rawFrame.type === "chunk" && isRecord(rawFrame.chunk)) {
      const attempt = this.streamAttempts.get(key) ?? {
        textId: `stream:text:${attemptId}`,
        text: "",
        reasoningId: `stream:reasoning:${attemptId}`,
        reasoning: "",
      };
      this.streamAttempts.set(key, attempt);
      this.activeStreamKeyBySession.set(targetSessionId, key);
      const chunk = rawFrame.chunk;
      if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text.length > 0) {
        attempt.text += chunk.text;
        this.emit({
          type: "timeline.item",
          sessionId: targetSessionId,
          item: {
            type: "assistant_message",
            id: attempt.textId,
            text: attempt.text,
          },
        });
      } else if (
        chunk.type === "reasoning-delta" &&
        typeof chunk.text === "string" &&
        chunk.text.length > 0
      ) {
        attempt.reasoning += chunk.text;
        this.emit({
          type: "timeline.item",
          sessionId: targetSessionId,
          item: {
            type: "reasoning",
            id: attempt.reasoningId,
            text: attempt.reasoning,
          },
        });
      }
      return;
    }

    if (rawFrame.type === "end") {
      const attempt = this.streamAttempts.get(key);
      this.streamAttempts.delete(key);
      if (this.activeStreamKeyBySession.get(targetSessionId) === key) {
        this.activeStreamKeyBySession.delete(targetSessionId);
      }
      const outcome = isRecord(rawFrame.outcome) ? rawFrame.outcome : undefined;
      if (attempt && outcome?.kind === "committed" && typeof outcome.seq === "number") {
        this.committedStreams.set(outcome.seq, {
          hadText: attempt.text.length > 0,
          hadReasoning: attempt.reasoning.length > 0,
        });
      }
    }
  }

  private processSessionEvent(targetSessionId: string, rawEvent: unknown, isReplay: boolean): void {
    if (!isRecord(rawEvent) || typeof rawEvent.type !== "string") return;
    const type = rawEvent.type;
    const data = isRecord(rawEvent.data) ? rawEvent.data : {};
    const seq = typeof rawEvent.seq === "number" ? rawEvent.seq : undefined;

    if (type === "user/message") {
      const source = isRecord(data.source) ? data.source : undefined;
      if (source?.kind !== "user") return;
      const msgId = typeof data.id === "string" ? data.id : `user:${seq ?? randomUUID()}`;
      const text = extractToolOutputText(data.content) ?? "";
      const clientMessageId =
        !isReplay && this.pendingPromptClientMessageId && this.emittedUserMessageIds.has(msgId)
          ? this.pendingPromptClientMessageId
          : undefined;
      this.emit({
        type: "timeline.item",
        sessionId: targetSessionId,
        item: {
          type: "user_message",
          id: msgId,
          text,
          ...(clientMessageId ? { clientMessageId } : {}),
          ...(seq !== undefined ? { revertToken: { beforeSeq: seq } } : {}),
        },
      });
      return;
    }

    if (type === "assistant/message") {
      const message = isRecord(data.message) ? data.message : {};
      const msgId = typeof message.id === "string" ? message.id : `assistant:${seq ?? randomUUID()}`;
      const content = Array.isArray(message.content) ? message.content : [];
      let streamed = !isReplay && seq !== undefined ? this.committedStreams.get(seq) : undefined;
      if (seq !== undefined) this.committedStreams.delete(seq);
      if (!isReplay && !streamed) {
        const activeKey = this.activeStreamKeyBySession.get(targetSessionId);
        const activeAttempt = activeKey ? this.streamAttempts.get(activeKey) : undefined;
        if (activeAttempt && (activeAttempt.text.length > 0 || activeAttempt.reasoning.length > 0)) {
          streamed = {
            hadText: activeAttempt.text.length > 0,
            hadReasoning: activeAttempt.reasoning.length > 0,
          };
        }
      }

      const reasoningParts: string[] = [];
      const textParts: string[] = [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "reasoning" && typeof block.text === "string" && block.text.length > 0) {
          reasoningParts.push(block.text);
        } else if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          textParts.push(block.text);
        }
      }

      if (reasoningParts.length > 0 && !streamed?.hadReasoning) {
        this.emit({
          type: "timeline.item",
          sessionId: targetSessionId,
          item: {
            type: "reasoning",
            id: `${msgId}:reasoning`,
            text: reasoningParts.join("\n"),
          },
        });
      }
      if (textParts.length > 0 && !streamed?.hadText) {
        this.emit({
          type: "timeline.item",
          sessionId: targetSessionId,
          item: {
            type: "assistant_message",
            id: msgId,
            text: textParts.join("\n"),
          },
        });
      }

      const usage = isRecord(data.usage) ? data.usage : isRecord(message.usage) ? message.usage : undefined;
      if (usage && !isReplay && targetSessionId === this.boundarySessionId) {
        this.emit({
          type: "session.usage",
          sessionId: this.boundarySessionId,
          ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
          usage: {
            ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
            ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
            ...(typeof usage.cachedInputTokens === "number"
              ? { cachedInputTokens: usage.cachedInputTokens }
              : {}),
          },
        });
      }
      return;
    }

    if (type === "tool/call") {
      const callId = typeof data.callId === "string" ? data.callId : `tool:${seq ?? randomUUID()}`;
      const name = typeof data.name === "string" ? data.name : "tool";
      const parsedInput = parseToolArguments(data.arguments);
      const item: ToolCallTimelineItem = {
        type: "tool_call",
        id: `tool:${callId}`,
        callId,
        name,
        status: "running",
        detail: buildToolCallDetail(name, parsedInput),
        error: null,
      };
      if (!isReplay && targetSessionId === this.boundarySessionId) {
        this.runningTools.set(callId, { item, rawInput: parsedInput });
      }
      this.emit({
        type: "timeline.item",
        sessionId: targetSessionId,
        item,
      });
      return;
    }

    if (type === "tool/result") {
      const message = isRecord(data.message) ? data.message : {};
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : `tool:${seq ?? randomUUID()}`;
      const prev = this.runningTools.get(callId);
      if (!isReplay && targetSessionId === this.boundarySessionId) {
        this.runningTools.delete(callId);
      }
      const name = prev?.item.name ?? (typeof message.toolName === "string" ? message.toolName : "tool");
      const rawInput = prev?.rawInput ?? {};
      const isError = message.isError === true;
      const outputText = extractToolOutputText(message.content);
      const detail = buildToolCallDetail(name, rawInput, message.content);
      const item: ToolCallTimelineItem = isError
        ? {
            type: "tool_call",
            id: `tool:${callId}`,
            callId,
            name,
            status: "failed",
            detail,
            error: outputText && outputText.length > 0 ? outputText : { message: `Tool ${name} failed` },
          }
        : {
            type: "tool_call",
            id: `tool:${callId}`,
            callId,
            name,
            status: "completed",
            detail,
            error: null,
          };
      this.emit({
        type: "timeline.item",
        sessionId: targetSessionId,
        item,
      });
      return;
    }

    if (type === "compaction/start" || type === "compaction/end" || type === "context/compacted") {
      this.emit({
        type: "timeline.item",
        sessionId: targetSessionId,
        item: {
          type: "compaction",
          id: `compaction:${seq ?? randomUUID()}`,
          status: type === "compaction/start" ? "loading" : "completed",
          ...(typeof data.preTokens === "number" ? { preTokens: data.preTokens } : {}),
        },
      });
      return;
    }

    if (type === "turn/end" && !isReplay && targetSessionId === this.boundarySessionId) {
      const reason = isRecord(data.reason) ? data.reason : {};
      const kind = typeof reason.kind === "string" ? reason.kind : "completed";
      const turnId = this.activeTurnId;
      this.activeTurnId = null;
      this.pendingPromptClientMessageId = null;
      this.cancelPendingPermissions();

      if (kind === "cancelled" || kind === "canceled") {
        this.terminalizeRunningTools("canceled");
        if (turnId) {
          this.emit({
            type: "session.turn",
            sessionId: this.boundarySessionId,
            turnId,
            state: "canceled",
          });
        }
      } else if (kind === "error") {
        const errMsg =
          isRecord(reason.error) && typeof reason.error.message === "string"
            ? reason.error.message
            : "DSH turn failed";
        this.terminalizeRunningTools("failed");
        if (turnId) {
          this.emit({
            type: "session.turn",
            sessionId: this.boundarySessionId,
            turnId,
            state: "failed",
            error: { message: errMsg },
          });
        }
      } else {
        this.terminalizeRunningTools("canceled");
        if (turnId) {
          this.emit({
            type: "session.turn",
            sessionId: this.boundarySessionId,
            turnId,
            state: "completed",
          });
        }
      }
      this.pendingPromptTurnResolver?.();
    }
  }
}
