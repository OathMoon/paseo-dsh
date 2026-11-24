import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

export const BRIDGE_PROTOCOL_VERSION = 1;

export const BridgeCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  commands: z.boolean(),
  permissionPresets: z.boolean(),
  images: z.boolean(),
  userQuestions: z.boolean(),
  revert: z.boolean(),
  subsessions: z.boolean(),
});
export type BridgeCapabilities = z.infer<typeof BridgeCapabilitiesSchema>;

export const BridgeInitResultSchema = z.object({
  protocolVersion: z.number().int(),
  dshVersion: z.string(),
  profile: z.string(),
  capabilities: BridgeCapabilitiesSchema,
});
export type BridgeInitResult = z.infer<typeof BridgeInitResultSchema>;

export const BridgeReasoningEffortSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
});
export type BridgeReasoningEffort = z.infer<typeof BridgeReasoningEffortSchema>;

export const BridgeModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  contextWindowMaxTokens: z.number().int().positive().optional(),
  inputModalities: z.array(z.string()).optional(),
  reasoning: z.object({
    defaultEffort: z.string().optional(),
    efforts: z.array(BridgeReasoningEffortSchema),
  }).optional(),
});
export type BridgeModelInfo = z.infer<typeof BridgeModelInfoSchema>;

export const BridgeProviderCatalogSchema = z.object({
  id: z.string(),
  name: z.string(),
  models: z.array(BridgeModelInfoSchema),
});
export type BridgeProviderCatalog = z.infer<typeof BridgeProviderCatalogSchema>;

export const BridgeModelSelectionSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
});
export type BridgeModelSelection = z.infer<typeof BridgeModelSelectionSchema>;

export const BridgePermissionPresetOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
});
export type BridgePermissionPresetOption = z.infer<typeof BridgePermissionPresetOptionSchema>;

export const BridgeCatalogResultSchema = z.object({
  providers: z.array(BridgeProviderCatalogSchema),
  defaultSelection: BridgeModelSelectionSchema.optional(),
  permissionPresets: z.object({
    defaultPreset: z.string(),
    options: z.array(BridgePermissionPresetOptionSchema),
  }).optional(),
});
export type BridgeCatalogResult = z.infer<typeof BridgeCatalogResultSchema>;

export const BridgeCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
});
export type BridgeCommand = z.infer<typeof BridgeCommandSchema>;

export const BridgeSessionStateSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  selection: BridgeModelSelectionSchema.optional(),
  mode: z.string().optional(),
  catalog: BridgeCatalogResultSchema,
  commands: z.array(BridgeCommandSchema).default([]),
  imageSupported: z.boolean().default(false),
});
export type BridgeSessionState = z.infer<typeof BridgeSessionStateSchema>;

export const BridgeSessionListItemSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
export type BridgeSessionListItem = z.infer<typeof BridgeSessionListItemSchema>;

export const BridgeSessionListResultSchema = z.object({
  sessions: z.array(BridgeSessionListItemSchema),
  nextCursor: z.string().optional(),
});
export type BridgeSessionListResult = z.infer<typeof BridgeSessionListResultSchema>;

export const BridgeTurnPromptResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("turn"),
    messageId: z.string(),
  }),
  z.object({
    kind: z.literal("steer"),
    messageId: z.string(),
  }),
  z.object({
    kind: z.literal("command"),
    commandId: z.string(),
    status: z.enum(["success", "error"]),
    text: z.string().optional(),
  }),
]);
export type BridgeTurnPromptResult = z.infer<typeof BridgeTurnPromptResultSchema>;

export const BridgeRevertResultSchema = z.object({
  newSessionId: z.string(),
});
export type BridgeRevertResult = z.infer<typeof BridgeRevertResultSchema>;

export const BridgeApprovalRequestParamsSchema = z.object({
  sessionId: z.string(),
  toolName: z.string(),
  callId: z.string().optional(),
  input: z.unknown().optional(),
  reason: z.string().optional(),
});
export type BridgeApprovalRequestParams = z.infer<typeof BridgeApprovalRequestParamsSchema>;

export const BridgeApprovalOutcomeSchema = z.enum(["allowed-once", "rejected", "cancelled"]);
export type BridgeApprovalOutcome = z.infer<typeof BridgeApprovalOutcomeSchema>;

export const BridgeUserQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

export const BridgeUserQuestionItemSchema = z.object({
  id: z.string(),
  header: z.string().optional(),
  question: z.string(),
  options: z.array(BridgeUserQuestionOptionSchema).default([]),
  multiSelect: z.boolean().optional(),
  allowCustom: z.boolean().optional(),
});
export type BridgeUserQuestionItem = z.infer<typeof BridgeUserQuestionItemSchema>;

export const BridgeUserQuestionRequestParamsSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  questions: z.array(BridgeUserQuestionItemSchema),
});
export type BridgeUserQuestionRequestParams = z.infer<typeof BridgeUserQuestionRequestParamsSchema>;

export type BridgeMcpServer =
  | {
      name: string;
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

export type BridgeInputBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; name?: string };

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export class BridgeRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "BridgeRpcError";
    this.code = code;
    this.data = data;
  }
}

interface PendingRpcRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface BridgeRpcPeerOptions {
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  onProtocolError?: (error: Error, rawLine: string) => void;
  onClose?: () => void;
}

/** Bidirectional JSON-RPC 2.0 peer over NDJSON streams. */
export class BridgeRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRpcRequest>();
  private readonly rl: ReturnType<typeof createInterface>;
  private closed = false;

  private readonly writable: Writable;
  private readonly options: BridgeRpcPeerOptions;

  constructor(
    writable: Writable,
    readable: Readable,
    options: BridgeRpcPeerOptions = {},
  ) {
    this.writable = writable;
    this.options = options;
    this.rl = createInterface({ input: readable, crlfDelay: Infinity });
    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let frame: unknown;
      try {
        frame = JSON.parse(trimmed);
      } catch (error) {
        this.options.onProtocolError?.(
          error instanceof Error ? error : new Error(String(error)),
          line,
        );
        return;
      }
      this.handleFrame(frame, line);
    });
    this.rl.on("close", () => {
      this.handleTransportClose(new Error("DSH bridge stream closed"));
    });
    this.writable.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
      this.handleTransportClose(error);
    });
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`DSH bridge peer is closed (method: ${method})`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRpcRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (timeoutMs !== undefined && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`DSH bridge request timed out after ${timeoutMs}ms: ${method}`));
          }
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.writeFrame({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.writeFrame({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  close(reason = "DSH bridge peer closed"): void {
    if (this.closed) return;
    this.handleTransportClose(new Error(reason));
    try {
      this.rl.close();
    } catch {
      // Ignore readline close races.
    }
    try {
      if (!this.writable.destroyed) this.writable.end();
    } catch {
      // Ignore stream close races.
    }
  }

  private writeFrame(frame: Record<string, unknown>): void {
    if (this.closed || this.writable.destroyed) return;
    try {
      this.writable.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      this.handleTransportClose(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleFrame(frame: unknown, rawLine: string): void {
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      this.options.onProtocolError?.(new Error("Invalid JSON-RPC frame"), rawLine);
      return;
    }
    const record = frame as Record<string, unknown>;
    const hasId = "id" in record && record.id !== undefined && record.id !== null;
    const hasMethod = typeof record.method === "string";

    if (hasId && !hasMethod) {
      const id = record.id as number;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      if ("error" in record && record.error && typeof record.error === "object") {
        const err = record.error as Partial<JsonRpcErrorObject>;
        entry.reject(
          new BridgeRpcError(
            typeof err.code === "number" ? err.code : -32603,
            typeof err.message === "string" ? err.message : "Unknown DSH bridge error",
            err.data,
          ),
        );
      } else {
        entry.resolve(record.result);
      }
      return;
    }

    if (hasMethod && hasId) {
      const id = record.id;
      const method = record.method as string;
      const handler = this.options.onRequest;
      if (!handler) {
        this.writeFrame({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unhandled bridge request: ${method}` },
        });
        return;
      }
      void handler(method, record.params).then(
        (result) => {
          this.writeFrame({ jsonrpc: "2.0", id, result: result ?? null });
        },
        (error: unknown) => {
          const code = error instanceof BridgeRpcError ? error.code : -32603;
          const message = error instanceof Error ? error.message : String(error);
          this.writeFrame({ jsonrpc: "2.0", id, error: { code, message } });
        },
      );
      return;
    }

    if (hasMethod) {
      this.options.onNotification?.(record.method as string, record.params);
    }
  }

  private handleTransportClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.options.onClose?.();
  }
}
