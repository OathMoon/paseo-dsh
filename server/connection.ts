import {
  PROVIDER_PROTOCOL_VERSION,
  ProviderEventSchema,
  ProviderInputSchema,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCapability,
  type ProviderConnectRequest,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
} from "@getpaseo/plugin/server/provider";
import { toProviderCatalog } from "./mappers/config.ts";
import { defaultDshLaunch } from "./launch.ts";
import { BridgeCatalogResultSchema, BridgeSessionListResultSchema } from "./protocol.ts";
import { DshSessionRuntime, nativePersistence } from "./session.ts";

const STARTUP_TIMEOUT_MS = 90_000;

interface ActiveSession {
  runtime: DshSessionRuntime;
  capabilities: readonly ProviderCapability[];
  mutationLane: Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createDirectDshConnection(
  request: ProviderConnectRequest,
): Promise<ProviderConnection> {
  if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION)) {
    throw new Error(`DSH direct provider requires protocol version ${PROVIDER_PROTOCOL_VERSION}`);
  }
  const baseLaunch: ProviderLaunch = request.launch ?? defaultDshLaunch("acp");

  // Short-lived probe process to verify DSH bridge and discover supported capabilities.
  const probe = await DshSessionRuntime.start({
    boundarySessionId: "capability-probe",
    baseLaunch,
    env: {},
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    emit: () => undefined,
  });
  const initCaps = probe.initInfo.capabilities;
  await probe.close();

  const supported: ProviderCapability[] = [
    "prompt.message",
    "prompt.steer",
    "session.configure",
    "session.list",
    "session.persistence",
    "permission",
  ];
  if (initCaps.commands) supported.push("prompt.command");
  if (initCaps.images) supported.push("prompt.image");
  if (initCaps.revert) supported.push("session.revert.conversation");
  if (initCaps.subsessions) supported.push("session.subsession");

  const capabilities = negotiateProviderCapabilities(request.capabilities, supported);
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, ActiveSession>();
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const emit = (event: ProviderEvent) => {
    if (closed) return;
    const parsed = ProviderEventSchema.parse(event);
    for (const listener of listeners) listener(parsed);
  };

  async function mutateSession(session: ActiveSession, op: () => Promise<void>): Promise<void> {
    const next = session.mutationLane.then(op);
    session.mutationLane = next.catch(() => undefined);
    return next;
  }

  function requireSession(sessionId: string): ActiveSession {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown DSH session: ${sessionId}`);
    return session;
  }

  function validateAdmission(input: ProviderInput): void {
    if (input.type === "session.open") {
      if (sessions.has(input.sessionId)) {
        throw new Error(`DSH session already exists: ${input.sessionId}`);
      }
      requireProviderCapabilities(capabilities, input);
      return;
    }
    if (!("sessionId" in input)) {
      requireProviderCapabilities(capabilities, input);
      return;
    }
    const session = requireSession(input.sessionId);
    requireProviderCapabilities(session.capabilities, input);
  }

  function emitFailure(input: ProviderInput, error: unknown): void {
    const failure = { message: describeError(error) };
    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: failure },
      });
      return;
    }
    if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error: failure });
      return;
    }
    if ("sessionId" in input) {
      emit({ type: "session.runtime_failed", sessionId: input.sessionId, error: failure });
    }
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog": {
        if (input.cwd === undefined) {
          emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: { models: [], modes: [] },
          });
          return;
        }
        const runtime = await DshSessionRuntime.start({
          boundarySessionId: "catalog",
          baseLaunch,
          env: {},
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
          emit: () => undefined,
        });
        try {
          const rawCatalog = await runtime.peer.request("catalog/get", {}, 30_000);
          const catalog = toProviderCatalog(BridgeCatalogResultSchema.parse(rawCatalog));
          emit({ type: "catalog", requestId: input.requestId, catalog });
        } finally {
          await runtime.close();
        }
        return;
      }

      case "sessions": {
        const runtime = await DshSessionRuntime.start({
          boundarySessionId: "sessions",
          baseLaunch,
          env: {},
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
          emit: () => undefined,
        });
        try {
          const rawList = await runtime.peer.request(
            "session/list",
            {
              ...(input.cwd ? { cwd: input.cwd } : {}),
              ...(input.limit ? { limit: input.limit } : {}),
            },
            30_000,
          );
          const list = BridgeSessionListResultSchema.parse(rawList);
          emit({
            type: "sessions",
            requestId: input.requestId,
            sessions: list.sessions.map((item) => ({
              persistence: nativePersistence(item.sessionId),
              cwd: item.cwd,
              ...(item.title ? { title: item.title } : {}),
              ...(item.updatedAt
                ? { updatedAt: new Date(item.updatedAt).toISOString() }
                : item.createdAt
                  ? { updatedAt: new Date(item.createdAt).toISOString() }
                  : {}),
            })),
          });
        } finally {
          await runtime.close();
        }
        return;
      }

      case "session.open": {
        const runtime = await DshSessionRuntime.start({
          boundarySessionId: input.sessionId,
          baseLaunch,
          env: input.config.env,
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
          emit,
        });
        try {
          const sessionCapabilities = await runtime.open(input, capabilities);
          if (closed) {
            await runtime.close();
            return;
          }
          sessions.set(input.sessionId, {
            runtime,
            capabilities: sessionCapabilities,
            mutationLane: Promise.resolve(),
          });
        } catch (error) {
          await runtime.close();
          throw error;
        }
        return;
      }

      case "session.prompt": {
        await requireSession(input.sessionId).runtime.prompt(input);
        return;
      }

      case "session.interrupt": {
        await requireSession(input.sessionId).runtime.interrupt();
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }

      case "session.permission": {
        requireSession(input.sessionId).runtime.respondToPermission(
          input.permissionId,
          input.response,
        );
        return;
      }

      case "session.configure": {
        const session = requireSession(input.sessionId);
        await mutateSession(session, () => session.runtime.configure(input.changes));
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }

      case "session.revert": {
        const session = requireSession(input.sessionId);
        await mutateSession(session, () => session.runtime.revert(input.token, input.scope));
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }

      case "session.close": {
        const session = requireSession(input.sessionId);
        sessions.delete(input.sessionId);
        await session.runtime.close("canceled");
        emit({ type: "session.closed", sessionId: input.sessionId });
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }

      case "session.archive":
      case "session.unarchive":
      case "session.can_stop_runtime":
        emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: `${input.type} is not supported by DSH provider` },
        });
    }
  }

  return {
    version: PROVIDER_PROTOCOL_VERSION,
    capabilities,
    async send(rawInput) {
      if (closed) throw new Error("DSH provider connection is closed");
      const input = ProviderInputSchema.parse(rawInput);
      validateAdmission(input);
      const operation = Promise.resolve().then(async () => {
        if (closed) return;
        await dispatch(input);
      });
      const settled = operation.catch((error) => {
        emitFailure(input, error);
      });
      inFlight.add(settled);
      void settled.finally(() => inFlight.delete(settled));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        // Terminalize active sessions while listeners can still observe terminal tool/turn items.
        const active = [...sessions.entries()];
        sessions.clear();
        await Promise.all(
          active.map(async ([sessionId, { runtime }]) => {
            await runtime.close("failed");
            emit({ type: "session.closed", sessionId });
          }),
        );
        closed = true;
        await Promise.allSettled(inFlight);
        listeners.clear();
      })();
      return closePromise;
    },
  };
}
