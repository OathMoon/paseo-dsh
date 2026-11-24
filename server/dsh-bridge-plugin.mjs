/**
 * Self-contained Cordis plugin injected into DSH via `--patch` for direct Paseo integration.
 *
 * IMPORTANT: Paseo bundles plugin code without preserving module file URLs, so `applyDshBridge`
 * is serialized via `.toString()` into a temporary ESM file at launch time. Keep all helper
 * functions inside `applyDshBridge` with zero top-level imports.
 */
export function applyDshBridge(ctx, config, require) {
  const cryptoMod = require("node:crypto");
  const fsPromises = require("node:fs/promises");
  const httpMod = require("node:http");
  const pathMod = require("node:path");
  const readlineMod = require("node:readline");
  const urlMod = require("node:url");

  const { randomUUID, createHash } = cryptoMod;
  const { realpath } = fsPromises;
  const { validateHeaderName, validateHeaderValue } = httpMod;
  const { isAbsolute, resolve } = pathMod;
  const { createInterface } = readlineMod;
  const { pathToFileURL } = urlMod;

  const input = config.input ?? process.stdin;
  const output = config.output ?? process.stdout;
  const earlyLines = [];
  let onLine = (line) => {
    earlyLines.push(line);
  };
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => onLine(line));

  let closed = false;
  let quiescing;

  async function importDsh(specifier) {
    return import(pathToFileURL(require.resolve(specifier)).href);
  }

  async function tryImportDsh(specifier) {
    try {
      return await importDsh(specifier);
    } catch {
      return undefined;
    }
  }

  const initPromise = (async () => {
    const dshLlm = await importDsh("@deepseek-ai/dsh-llm");
    const dshAgent = await tryImportDsh("@deepseek-ai/dsh-agent");
    const dshSession = await tryImportDsh("@deepseek-ai/dsh-session");
    const dshSessionFork = await tryImportDsh("@deepseek-ai/dsh-session/fork");
    const dshMcpClient = await tryImportDsh("@deepseek-ai/dsh-mcp-client");
    const dshAttachment = await tryImportDsh("@deepseek-ai/dsh-attachment");
    const dshUserQuestions = await tryImportDsh("@deepseek-ai/dsh-user-questions");

    const persistence = ctx.sessionPersistence;
    const logger = ctx.logger;
    const sessions = new Map();
    const activating = new Set();
    const subagentParents = new Map();
    const pendingOutbound = new Map();
    let nextOutboundId = 1;
    const lifetime = new AbortController();

    const profile = typeof config.profile === "string" ? config.profile : "unknown";
    const dshVersion = typeof config.dshVersion === "string" ? config.dshVersion : "unknown";
    const defaultProvider = typeof config.provider === "string" ? config.provider : undefined;
    const defaultModel = typeof config.model === "string" ? config.model : undefined;

  function errorMessage(error) {
    if (typeof dshLlm?.errorChain === "function") {
      try {
        return dshLlm.errorChain(error);
      } catch {
        // Fall through to standard formatting.
      }
    }
    return error instanceof Error ? error.message : String(error);
  }

  function rpcError(code, message) {
    const err = new Error(message);
    err.rpcCode = code;
    return err;
  }

  function writeFrame(frame) {
    if (closed || output.destroyed) return;
    try {
      output.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      logger.warn(`paseo-dsh-bridge: stdout write failed: ${errorMessage(error)}`);
    }
  }

  function notify(method, params) {
    writeFrame({ jsonrpc: "2.0", method, params });
  }

  function requestHost(method, params, signal) {
    if (closed) return Promise.reject(new Error("DSH bridge is closed"));
    const id = nextOutboundId++;
    return new Promise((resolveReq, rejectReq) => {
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (pendingOutbound.delete(id)) {
          cleanup();
          rejectReq(new Error(`Bridge host request aborted: ${method}`));
        }
      };
      if (signal?.aborted) {
        rejectReq(new Error(`Bridge host request aborted: ${method}`));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      pendingOutbound.set(id, {
        resolve(value) {
          cleanup();
          resolveReq(value);
        },
        reject(error) {
          cleanup();
          rejectReq(error);
        },
      });
      writeFrame({ jsonrpc: "2.0", id, method, params });
    });
  }

  async function sameDirectory(left, right) {
    if (left === undefined) return false;
    try {
      const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)]);
      return realLeft === realRight;
    } catch {
      return resolve(left) === resolve(right);
    }
  }

  function ownsAgent(agent) {
    const record = sessions.get(agent.session.id);
    if (record?.agent === agent) return true;
    const subagents = ctx.get("subagents");
    if (!subagents || typeof subagents.rootOf !== "function") return false;
    try {
      const root = subagents.rootOf(agent);
      return sessions.get(root.session.id)?.agent === root;
    } catch {
      return false;
    }
  }

  function normalizeServerName(name) {
    if (typeof name !== "string" || name.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw rpcError(-32602, "mcpServers contains an invalid server name");
    }
    if (/^[A-Za-z0-9_-]{1,32}$/.test(name)) return name;
    const slug = name
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 20) || "server";
    const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
    return `${slug}_${digest}`.slice(0, 32);
  }

  async function mountMcpServers(agentCtx, servers, sessionCwd) {
    if (!Array.isArray(servers) || servers.length === 0) return;
    if (!dshMcpClient) {
      throw rpcError(-32603, "DSH MCP client package (@deepseek-ai/dsh-mcp-client) is unavailable");
    }
    const seen = new Set();
    for (let index = 0; index < servers.length; index++) {
      const server = servers[index];
      const serverName = normalizeServerName(server.name);
      if (seen.has(serverName)) {
        throw rpcError(-32602, `mcpServers contains duplicate normalized name: ${serverName}`);
      }
      seen.add(serverName);
      if (server.type === "stdio") {
        if (!isAbsolute(server.command)) {
          throw rpcError(-32602, `mcpServers[${index}].command must be an absolute path`);
        }
        const env = Object.create(null);
        for (const [k, v] of Object.entries(server.env ?? {})) {
          if (!k || k.includes("=") || k.includes("\0") || String(v).includes("\0")) {
            throw rpcError(-32602, `mcpServers[${index}].env contains an invalid entry`);
          }
          env[k] = String(v);
        }
        const cfg = dshMcpClient.Config({
          transport: "stdio",
          serverName,
          command: server.command,
          args: server.args ?? [],
          env,
          cwd: sessionCwd,
          failOnStartupError: true,
        });
        await agentCtx.plugin(dshMcpClient, { ...cfg, env });
      } else if (server.type === "http") {
        const parsed = new URL(server.url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw rpcError(-32602, `mcpServers[${index}].url must be HTTP(S)`);
        }
        const headers = Object.create(null);
        for (const [k, v] of Object.entries(server.headers ?? {})) {
          validateHeaderName(k);
          validateHeaderValue(k, String(v));
          headers[k] = String(v);
        }
        const cfg = dshMcpClient.Config({
          transport: "streamable-http",
          serverName,
          url: server.url,
          headers,
          failOnStartupError: true,
        });
        await agentCtx.plugin(dshMcpClient, { ...cfg, headers });
      } else {
        throw rpcError(-32602, `mcpServers[${index}] transport ${String(server.type)} is not supported`);
      }
    }
  }

  async function buildCatalog(currentSelection) {
    const llm = ctx.llm;
    const providers = await Promise.all(
      llm.listProviders().map(async (provider) => {
        try {
          const models = await llm.listModels(provider.id);
          const detailed = await Promise.all(
            models.map(async (model) => {
              let info;
              try {
                info = await llm.resolveModelInfo(provider.id, model.id);
              } catch {
                info = undefined;
              }
              return {
                id: model.id,
                name: model.name,
                ...(model.description !== undefined ? { description: model.description } : {}),
                ...(typeof info?.context?.contextWindow === "number" && info.context.contextWindow > 0
                  ? { contextWindowMaxTokens: info.context.contextWindow }
                  : typeof info?.contextWindow === "number" && info.contextWindow > 0
                    ? { contextWindowMaxTokens: info.contextWindow }
                    : typeof info?.maxContextTokens === "number" && info.maxContextTokens > 0
                      ? { contextWindowMaxTokens: info.maxContextTokens }
                      : {}),
                ...(Array.isArray(info?.inputModalities)
                  ? { inputModalities: [...info.inputModalities] }
                  : {}),
                ...(info?.reasoning !== undefined
                  ? {
                      reasoning: {
                        ...(info.reasoning.defaultEffort !== undefined
                          ? { defaultEffort: String(info.reasoning.defaultEffort) }
                          : {}),
                        efforts: info.reasoning.efforts.map((effort) => ({
                          id: String(effort.id),
                          name: effort.name,
                          ...(effort.description !== undefined ? { description: effort.description } : {}),
                        })),
                      },
                    }
                  : {}),
              };
            }),
          );
          return { id: provider.id, name: provider.name, models: detailed };
        } catch {
          return { id: provider.id, name: provider.name, models: [] };
        }
      }),
    );

    let defaultSelection = currentSelection;
    if (!defaultSelection && defaultProvider && defaultModel) {
      try {
        const resolved = await llm.resolveCallConfig({ provider: defaultProvider, model: defaultModel });
        defaultSelection = {
          provider: resolved.provider,
          model: resolved.model,
          ...(resolved.reasoningEffort !== undefined
            ? { reasoningEffort: String(resolved.reasoningEffort) }
            : {}),
        };
      } catch {
        defaultSelection = { provider: defaultProvider, model: defaultModel };
      }
    }
    if (!defaultSelection) {
      const firstProvider = providers.find((p) => p.models.length > 0);
      if (firstProvider) {
        defaultSelection = { provider: firstProvider.id, model: firstProvider.models[0].id };
      }
    }

    const permissionPresetsService = ctx.get("permissionPresets");
    let permissionPresets;
    if (permissionPresetsService && typeof permissionPresetsService.catalog === "function") {
      try {
        const cat = permissionPresetsService.catalog();
        permissionPresets = {
          defaultPreset: cat.defaultPreset,
          options: cat.options.map((opt) => ({
            id: opt.value,
            name: opt.name,
            ...(opt.description !== undefined ? { description: opt.description } : {}),
          })),
        };
      } catch {
        permissionPresets = undefined;
      }
    }

    return {
      providers: providers.filter((p) => p.models.length > 0),
      ...(defaultSelection ? { defaultSelection } : {}),
      ...(permissionPresets ? { permissionPresets } : {}),
    };
  }

  function listCommands(agent) {
    const commands = ctx.get("commands");
    if (!commands || typeof commands.list !== "function") return [];
    try {
      return commands.list(agent).map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        ...(cmd.input?.hint ? { argumentHint: cmd.input.hint } : {}),
      }));
    } catch {
      return [];
    }
  }

  async function supportsImagesForSelection(selection) {
    const attachments = ctx.get("attachments");
    if (!attachments || !selection) return false;
    try {
      const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model);
      return info?.inputModalities?.includes("image") === true;
    } catch {
      return false;
    }
  }

  async function buildSessionState(record) {
    const agent = record.agent;
    const current = agent.model.current();
    let selection = current
      ? {
          provider: current.provider,
          model: current.model,
          ...(current.reasoningEffort !== undefined
            ? { reasoningEffort: String(current.reasoningEffort) }
            : {}),
        }
      : undefined;
    if (selection) {
      try {
        const resolved = await ctx.llm.resolveCallConfig(selection);
        selection = {
          provider: resolved.provider,
          model: resolved.model,
          ...(resolved.reasoningEffort !== undefined
            ? { reasoningEffort: String(resolved.reasoningEffort) }
            : {}),
        };
      } catch {
        // Keep current selection when route resolution fails transiently.
      }
    }
    const catalog = await buildCatalog(selection);
    const permissionPresets = ctx.get("permissionPresets");
    let mode;
    if (permissionPresets && typeof permissionPresets.current === "function") {
      try {
        mode = permissionPresets.current(agent.session);
      } catch {
        mode = undefined;
      }
    }
    const imageSupported = await supportsImagesForSelection(selection);
    return {
      sessionId: String(agent.session.id),
      cwd: agent.session.header.cwd ?? record.cwd,
      ...(selection ? { selection } : {}),
      ...(mode !== undefined ? { mode } : {}),
      catalog,
      commands: listCommands(agent),
      imageSupported,
    };
  }

  function parseModelSelection(modelId) {
    if (typeof modelId !== "string" || !modelId) return undefined;
    try {
      const parsed = JSON.parse(modelId);
      if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
        return { provider: parsed[0], model: parsed[1] };
      }
    } catch {
      // Not a JSON tuple.
    }
    const slash = modelId.indexOf("/");
    if (slash > 0 && slash < modelId.length - 1) {
      return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
    }
    return undefined;
  }

  async function admitContentBlocks(blocks) {
    const result = [];
    const pendingImages = [];
    const imagePositions = [];
    for (const block of blocks) {
      if (block.type === "text") {
        if (block.text.length > 0) result.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        imagePositions.push(result.length);
        result.push(null);
        pendingImages.push({
          data: block.data,
          mediaType: block.mimeType,
          ...(block.name ? { name: block.name } : {}),
        });
      }
    }
    if (pendingImages.length > 0) {
      const attachments = ctx.get("attachments");
      if (!attachments || !dshAttachment?.admitEncodedImages) {
        throw rpcError(-32602, "DSH attachment store is unavailable for image input");
      }
      const refs = await dshAttachment.admitEncodedImages(attachments, pendingImages);
      for (let i = 0; i < refs.length; i++) {
        result[imagePositions[i]] = { type: "image", attachment: refs[i] };
      }
    }
    if (result.length === 0) {
      throw rpcError(-32602, "Prompt content cannot be empty");
    }
    return result;
  }

  async function serializeEventForWire(event) {
    // Rehydrate image attachments inline when needed, keeping all other fields intact.
    if (event.type === "assistant/message" && Array.isArray(event.data?.message?.content)) {
      const attachments = ctx.get("attachments");
      const content = await Promise.all(
        event.data.message.content.map(async (block) => {
          if (block.type === "image" && block.attachment && attachments) {
            try {
              const stored = await attachments.readImage(block.attachment);
              return {
                type: "image",
                data: Buffer.from(stored.data).toString("base64"),
                mimeType: stored.ref.mediaType,
              };
            } catch {
              return block;
            }
          }
          return block;
        }),
      );
      return {
        ...event,
        data: { ...event.data, message: { ...event.data.message, content } },
      };
    }
    return event;
  }

  function createSessionRecord(handle, cwd) {
    const agent = handle.agent;
    const record = {
      agent,
      handle,
      cwd,
      outputTail: Promise.resolve(),
      closing: undefined,
      toolInputs: new Map(),
      enqueue(fn) {
        this.outputTail = this.outputTail.then(fn).catch((error) => {
          logger.warn(`paseo-dsh-bridge: event delivery failed: ${errorMessage(error)}`);
        });
        return this.outputTail;
      },
      async close() {
        if (this.closing) return this.closing;
        this.closing = (async () => {
          try {
            this.agent.cancel({ kind: "user" });
          } catch {
            // Ignore cancel errors during teardown.
          }
          try {
            await this.agent.whenIdle();
          } catch {
            // Ignore idle drain errors during teardown.
          }
          await this.outputTail;
          const subagents = ctx.get("subagents");
          if (subagents && typeof subagents.drainDescendants === "function") {
            try {
              await subagents.drainDescendants([this.agent]);
            } catch (error) {
              logger.warn(`paseo-dsh-bridge: subagent teardown failed: ${errorMessage(error)}`);
            }
          }
          try {
            await ctx.sessions.flush(this.agent.session);
          } catch (error) {
            logger.warn(`paseo-dsh-bridge: session flush failed: ${errorMessage(error)}`);
          }
          await this.handle.dispose();
        })();
        return this.closing;
      },
    };
    return record;
  }

  const disposers = [];
  let readyResolved = Boolean(ctx.root?.lifecycle?.isActive);
  let resolveReady;
  const readyPromise = readyResolved
    ? Promise.resolve()
    : new Promise((resolveFn) => {
        resolveReady = resolveFn;
      });
  if (!readyResolved) {
    disposers.push(
      ctx.on("ready", () => {
        readyResolved = true;
        resolveReady?.();
      }),
    );
  }

  disposers.push(
    ctx.on("session/event", (session, event) => {
      const sessionId = String(session.id);
      const record = sessions.get(sessionId);
      if (record && record.agent.session === session) {
        if (event.type === "tool/call" && event.data?.callId) {
          let parsedInput;
          try {
            parsedInput = JSON.parse(event.data.arguments);
          } catch {
            parsedInput = event.data.arguments;
          }
          record.toolInputs.set(event.data.callId, parsedInput);
        }
        record.enqueue(async () => {
          const wireEvent = await serializeEventForWire(event);
          notify("event/session", { sessionId, event: wireEvent });
        });
        return;
      }
      const parentSessionId = subagentParents.get(sessionId);
      if (parentSessionId) {
        const parentRecord = sessions.get(parentSessionId);
        if (parentRecord) {
          parentRecord.enqueue(async () => {
            const wireEvent = await serializeEventForWire(event);
            notify("event/session", {
              sessionId,
              parentSessionId,
              isSubagent: true,
              event: wireEvent,
            });
          });
        }
      }
    }),
  );

  disposers.push(
    ctx.on("agent/assistant-stream", ({ agent, frame }) => {
      const sessionId = String(agent.session.id);
      const record = sessions.get(sessionId);
      if (record?.agent === agent) {
        record.enqueue(() => {
          notify("event/stream", { sessionId, frame });
        });
        return;
      }
      const parentSessionId = subagentParents.get(sessionId);
      if (parentSessionId) {
        const parentRecord = sessions.get(parentSessionId);
        if (parentRecord) {
          parentRecord.enqueue(() => {
            notify("event/stream", { sessionId, parentSessionId, isSubagent: true, frame });
          });
        }
      }
    }),
  );

  disposers.push(
    ctx.on("agent/error", ({ agent, error }) => {
      const sessionId = String(agent.session.id);
      const record = sessions.get(sessionId);
      if (record?.agent !== agent) return;
      record.enqueue(() => {
        notify("event/agent-error", { sessionId, message: errorMessage(error) });
      });
    }),
  );

  disposers.push(
    ctx.on("agent/status", ({ agent, status }) => {
      const sessionId = String(agent.session.id);
      const record = sessions.get(sessionId);
      if (record?.agent !== agent) return;
      record.enqueue(() => {
        notify("event/agent-status", { sessionId, status });
      });
    }),
  );

  disposers.push(
    ctx.on("llm/adapters-updated", () => {
      for (const record of sessions.values()) {
        void buildSessionState(record)
          .then((state) => {
            if (!closed && !record.closing) {
              notify("event/config", { sessionId: state.sessionId, state });
            }
          })
          .catch(() => {});
      }
    }),
  );

  disposers.push(
    ctx.on("commands/change", () => {
      for (const record of sessions.values()) {
        if (!closed && !record.closing) {
          notify("event/commands", {
            sessionId: String(record.agent.session.id),
            commands: listCommands(record.agent),
          });
        }
      }
    }),
  );

  disposers.push(
    ctx.on("permission-presets/catalog-changed", () => {
      for (const record of sessions.values()) {
        void buildSessionState(record)
          .then((state) => {
            if (!closed && !record.closing) {
              notify("event/config", { sessionId: state.sessionId, state });
            }
          })
          .catch(() => {});
      }
    }),
  );

  disposers.push(
    ctx.on("approval/request", (request, next) => {
      if (!ownsAgent(request.agent)) return next();
      const sessionId = String(request.agent.session.id);
      const record = sessions.get(sessionId);
      const rootRecord = record ?? [...sessions.values()].find((r) => ownsAgent(request.agent));
      const drain = rootRecord ? rootRecord.outputTail : Promise.resolve();
      const signal = request.signal
        ? AbortSignal.any([request.signal, lifetime.signal])
        : lifetime.signal;
      return drain
        .then(() => {
          const input = request.callId && record ? record.toolInputs.get(request.callId) : undefined;
          return requestHost(
            "approval/request",
            {
              sessionId,
              toolName: request.toolName,
              ...(request.callId !== undefined ? { callId: request.callId } : {}),
              ...(input !== undefined ? { input } : {}),
              ...(request.reason !== undefined ? { reason: request.reason } : {}),
            },
            signal,
          );
        })
        .then(
          (result) => {
            const outcome = result?.outcome;
            if (outcome === "allowed-once" || outcome === "rejected" || outcome === "cancelled") {
              return outcome;
            }
            return "cancelled";
          },
          () => "cancelled",
        );
    }),
  );

  disposers.push(
    ctx.on("user-questions/request", async (request, next) => {
      const agent = request.agent;
      if (!agent || !ownsAgent(agent)) return next();
      const sessionId = String(agent.session.id);
      const requestId = randomUUID();
      const signal = request.signal
        ? AbortSignal.any([request.signal, lifetime.signal])
        : lifetime.signal;
      const UserQuestionError = dshUserQuestions?.UserQuestionError;
      const makeError = (message, code, cause) =>
        UserQuestionError ? new UserQuestionError(message, code, cause ? { cause } : undefined) : new Error(message);
      if (signal.aborted) throw makeError("User question aborted", "ASK_ABORTED");
      const onAbort = () => {
        notify("event/question-cancelled", { requestId, sessionId });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await requestHost(
          "user-question/ask",
          { requestId, sessionId, questions: request.questions },
          signal,
        );
        if (result && typeof result === "object" && result.cancelled === true) {
          throw makeError("The user dismissed the question", "ASK_CANCELLED");
        }
        if (result && typeof result === "object" && Array.isArray(result.answers)) {
          return { answers: result.answers };
        }
        throw makeError("Invalid user question answer from host", "BAD_ANSWER");
      } catch (error) {
        if (UserQuestionError && error instanceof UserQuestionError) throw error;
        throw makeError(
          signal.aborted ? "User question cancelled" : `User question failed: ${errorMessage(error)}`,
          signal.aborted ? "ASK_ABORTED" : "PROVIDER_ERROR",
          error,
        );
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }),
  );

  disposers.push(
    ctx.on("session/created", (session) => {
      const parentSession = session.header?.parentSession;
      if (session.header?.origin !== "subagent" || !parentSession) return;
      const parentSessionId = String(parentSession);
      const childSessionId = String(session.id);
      if (!sessions.has(parentSessionId) && !subagentParents.has(parentSessionId)) return;
      const rootId = sessions.has(parentSessionId) ? parentSessionId : subagentParents.get(parentSessionId);
      subagentParents.set(childSessionId, rootId);
      notify("event/subagent", {
        kind: "started",
        parentSessionId,
        childSessionId,
        ...(session.header?.spawnToolCallId ? { toolCallId: String(session.header.spawnToolCallId) } : {}),
      });
    }),
  );

  disposers.push(
    ctx.on("subagent/end", (info) => {
      if (!info?.local) return;
      const childSessionId = String(info.id);
      const parentSessionId = String(info.parentSessionId);
      if (!subagentParents.has(childSessionId) && !sessions.has(parentSessionId)) return;
      subagentParents.delete(childSessionId);
      notify("event/subagent", {
        kind: "finished",
        parentSessionId,
        childSessionId,
        provider: info.provider,
        stopReason: info.stopReason,
        status: info.stopReason === "completed" ? "ok" : "error",
        ...(info.lastAssistantMessage !== undefined
          ? { lastAssistantMessage: [...info.lastAssistantMessage] }
          : {}),
      });
    }),
  );

  async function handleRequest(method, params) {
    if (closed) throw rpcError(-32603, "DSH bridge is closed");
    switch (method) {
      case "bridge/init": {
        if (!readyResolved && ctx.llm.listProviders().length === 0) {
          await Promise.race([
            readyPromise,
            new Promise((resolveFn) => {
              const off = ctx.on("llm/adapters-updated", () => {
                off();
                resolveFn();
              });
              setTimeout(() => {
                off();
                resolveFn();
              }, 3_000);
            }),
          ]);
        }
        const capabilities = {
          streaming: true,
          commands: ctx.get("commands") !== undefined,
          permissionPresets: ctx.get("permissionPresets") !== undefined,
          images: ctx.get("attachments") !== undefined,
          userQuestions: dshUserQuestions !== undefined,
          revert: typeof dshSessionFork?.buildForkSeed === "function",
          subsessions: ctx.get("subagents") !== undefined,
        };
        return {
          protocolVersion: 1,
          dshVersion,
          profile,
          capabilities,
        };
      }

      case "catalog/get": {
        return buildCatalog();
      }

      case "session/list": {
        const cwd = params?.cwd;
        if (cwd !== undefined && cwd !== null && !isAbsolute(cwd)) {
          throw rpcError(-32602, `cwd must be an absolute path: ${cwd}`);
        }
        const limit = typeof params?.limit === "number" && params.limit > 0 ? params.limit : 100;
        const listed = await persistence.list();
        const filtered = await Promise.all(
          listed.map(async ({ header }) => {
            if (header.origin === "subagent" || !header.cwd || !isAbsolute(header.cwd)) return undefined;
            if (cwd && !(await sameDirectory(header.cwd, cwd))) return undefined;
            return {
              sessionId: String(header.id),
              cwd: header.cwd,
              ...(header.title ? { title: header.title } : {}),
              createdAt: header.createdAt,
              ...(header.updatedAt ? { updatedAt: header.updatedAt } : {}),
            };
          }),
        );
        const entries = filtered
          .filter(Boolean)
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        return { sessions: entries.slice(0, limit) };
      }

      case "session/open": {
        const cwd = params?.cwd;
        if (typeof cwd !== "string" || !isAbsolute(cwd)) {
          throw rpcError(-32602, `cwd must be an absolute path: ${String(cwd)}`);
        }
        const sessionId = randomUUID();
        const parsedModel = parseModelSelection(params?.model);
        const agentOptions = {
          ...(parsedModel ?? (defaultProvider && defaultModel ? { provider: defaultProvider, model: defaultModel } : {})),
          ...(params?.thinkingOption ? { reasoningEffort: params.thinkingOption } : {}),
        };
        const fs = ctx.get("fs");
        const resolvedCwd = fs ? fs.processPath(await fs.resolve(cwd)) : cwd;
        const handle = await ctx.agents.create({
          sessionId,
          meta: { cwd: resolvedCwd },
          agentOptions,
          setup: async (agentCtx, agent) => {
            if (typeof dshAgent?.installModelSelection === "function") {
              dshAgent.installModelSelection(agentCtx);
            }
            await mountMcpServers(agentCtx, params?.mcpServers ?? [], resolvedCwd);
            if (params?.mode) {
              const presets = ctx.get("permissionPresets");
              if (presets && typeof presets.set === "function") {
                presets.set(agent.session, params.mode);
              }
            }
          },
        });
        const record = createSessionRecord(handle, resolvedCwd);
        sessions.set(sessionId, record);
        try {
          await ctx.sessions.flush(handle.agent.session);
          return await buildSessionState(record);
        } catch (error) {
          sessions.delete(sessionId);
          await record.close().catch(() => {});
          throw error;
        }
      }

      case "session/resume": {
        const sessionId = params?.sessionId;
        const cwd = params?.cwd;
        if (typeof sessionId !== "string" || !sessionId) {
          throw rpcError(-32602, "session/resume requires sessionId");
        }
        if (typeof cwd !== "string" || !isAbsolute(cwd)) {
          throw rpcError(-32602, `cwd must be an absolute path: ${String(cwd)}`);
        }
        if (sessions.has(sessionId) || activating.has(sessionId) || ctx.sessions.get(sessionId) !== undefined) {
          throw rpcError(-32602, `session is already active: ${sessionId}`);
        }
        activating.add(sessionId);
        try {
          const stat = await persistence.stat(sessionId);
          const persisted = stat?.header;
          if (!persisted || persisted.origin === "subagent") {
            throw rpcError(-32602, `session is not resumable: ${sessionId}`);
          }
          if (!(await sameDirectory(persisted.cwd, cwd))) {
            throw rpcError(-32602, `session cwd does not match: ${cwd}`);
          }
          let replayEvents;
          if (params?.history === "replay") {
            const readHandle = await persistence.open(sessionId, "read");
            let rawEvents;
            try {
              ({ events: rawEvents } = await readHandle.read());
            } finally {
              await readHandle.close();
            }
            const closers = typeof dshSession?.interruptedTurnClosers === "function"
              ? dshSession.interruptedTurnClosers(rawEvents)
              : [];
            replayEvents = await Promise.all([...rawEvents, ...closers].map(serializeEventForWire));
          }
          const parsedModel = parseModelSelection(params?.model);
          const agentOptions = {
            ...(parsedModel ?? (defaultProvider && defaultModel ? { provider: defaultProvider, model: defaultModel } : {})),
            ...(params?.thinkingOption ? { reasoningEffort: params.thinkingOption } : {}),
          };
          const handle = await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions,
            setup: async (agentCtx, agent) => {
              if (typeof dshAgent?.installModelSelection === "function") {
                dshAgent.installModelSelection(agentCtx);
              }
              await mountMcpServers(agentCtx, params?.mcpServers ?? [], cwd);
              if (parsedModel) {
                agent.model.select({
                  ...parsedModel,
                  ...(params?.thinkingOption ? { reasoningEffort: params.thinkingOption } : {}),
                });
              }
              if (params?.mode) {
                const presets = ctx.get("permissionPresets");
                if (presets && typeof presets.set === "function") {
                  presets.set(agent.session, params.mode);
                }
              }
            },
          });
          const record = createSessionRecord(handle, cwd);
          sessions.set(sessionId, record);
          if (replayEvents) {
            notify("event/replay", { sessionId, events: replayEvents });
          }
          return await buildSessionState(record);
        } finally {
          activating.delete(sessionId);
        }
      }

      case "session/configure": {
        const sessionId = params?.sessionId;
        const record = sessions.get(sessionId);
        if (!record) throw rpcError(-32602, `unknown session: ${String(sessionId)}`);
        const agent = record.agent;
        const current = agent.model.current();
        if (params?.model !== undefined && params.model !== null) {
          const parsed = parseModelSelection(params.model);
          if (!parsed) throw rpcError(-32602, `invalid model identifier: ${String(params.model)}`);
          await ctx.llm.resolveCallConfig(parsed);
          agent.model.select(parsed);
        }
        if (params?.thinkingOption !== undefined) {
          const latest = agent.model.current() ?? current;
          if (!latest) throw rpcError(-32602, "session has no active model selection");
          const effort = params.thinkingOption === null || params.thinkingOption === ""
            ? undefined
            : String(params.thinkingOption);
          const resolved = await ctx.llm.resolveCallConfig({
            provider: latest.provider,
            model: latest.model,
            ...(effort !== undefined ? { reasoningEffort: effort } : {}),
          });
          agent.model.select({
            provider: resolved.provider,
            model: resolved.model,
            ...(effort !== undefined ? { reasoningEffort: effort } : {}),
          });
        }
        if (params?.mode !== undefined && params.mode !== null) {
          const presets = ctx.get("permissionPresets");
          if (!presets) throw rpcError(-32602, "permission presets service is unavailable");
          presets.resolve(params.mode);
          presets.set(agent.session, params.mode);
        }
        return await buildSessionState(record);
      }

      case "turn/prompt": {
        const sessionId = params?.sessionId;
        const record = sessions.get(sessionId);
        if (!record) throw rpcError(-32602, `unknown session: ${String(sessionId)}`);
        const agent = record.agent;
        if (params?.input?.type === "command") {
          const commands = ctx.get("commands");
          if (!commands) throw rpcError(-32602, "DSH commands service is unavailable");
          const argStr = typeof params.input.arguments === "string" && params.input.arguments.length > 0
            ? ` ${params.input.arguments}`
            : "";
          const line = `/${params.input.name}${argStr}`;
          const execution = await commands.execute(agent, line, [], lifetime.signal);
          if (!execution) {
            throw rpcError(-32602, `Unknown command: /${params.input.name}`);
          }
          return {
            kind: "command",
            commandId: String(execution.commandId),
            status: execution.result.kind,
            ...(execution.result.text !== undefined ? { text: execution.result.text } : {}),
          };
        }

        const content = await admitContentBlocks(params?.input?.content ?? []);
        const message = dshLlm.createUserMessage({
          content,
          source: { kind: "user" },
        });
        if (params?.delivery === "steer") {
          if (typeof agent.steer === "function") {
            agent.steer(message);
          } else {
            agent.inbox.append("next-step", message);
          }
          return { kind: "steer", messageId: String(message.id) };
        }
        agent.followup(message);
        return { kind: "turn", messageId: String(message.id) };
      }

      case "turn/cancel": {
        const sessionId = params?.sessionId;
        const record = sessions.get(sessionId);
        if (!record) throw rpcError(-32602, `unknown session: ${String(sessionId)}`);
        record.agent.cancel({ kind: "user" });
        return {};
      }

      case "session/revert": {
        const sessionId = params?.sessionId;
        const beforeSeq = params?.beforeSeq;
        if (typeof sessionId !== "string" || typeof beforeSeq !== "number" || !Number.isSafeInteger(beforeSeq)) {
          throw rpcError(-32602, "session/revert requires sessionId and integer beforeSeq");
        }
        if (typeof dshSessionFork?.buildForkSeed !== "function") {
          throw rpcError(-32601, "DSH session fork is unavailable");
        }
        const record = sessions.get(sessionId);
        if (record) {
          await ctx.sessions.flush(record.agent.session);
        }
        const readHandle = await persistence.open(sessionId, "read");
        const header = readHandle.header;
        let events;
        try {
          ({ events } = await readHandle.read());
        } finally {
          await readHandle.close();
        }
        const boundary = beforeSeq - 1;
        if (boundary < -1 || boundary >= events.length) {
          throw rpcError(-32602, `Invalid revert boundary: beforeSeq=${beforeSeq}, events=${events.length}`);
        }
        const newSessionId = randomUUID();
        const seedEvents = boundary >= 0 ? dshSessionFork.buildForkSeed(events, boundary) : [];
        const newHeader = {
          ...header,
          id: newSessionId,
          createdAt: Date.now(),
          ...(boundary >= 0 ? { isSeeded: true } : {}),
        };
        delete newHeader.parentSession;
        if (newHeader.origin === "subagent") delete newHeader.origin;
        const writeHandle = await persistence.create(
          newHeader,
          boundary >= 0 ? { inheritedEventCount: boundary + 1 } : undefined,
        );
        try {
          if (seedEvents.length > 0) {
            await writeHandle.append(seedEvents);
          }
          if (typeof writeHandle.flush === "function") {
            await writeHandle.flush();
          }
        } finally {
          await writeHandle.close();
        }
        return { newSessionId };
      }

      case "session/close": {
        const sessionId = params?.sessionId;
        const record = sessions.get(sessionId);
        if (!record) return {};
        sessions.delete(sessionId);
        await record.close();
        return {};
      }

      default:
        throw rpcError(-32601, `Unknown DSH bridge method: ${method}`);
    }
  }

  function quiesce() {
    if (quiescing) return quiescing;
    closed = true;
    lifetime.abort(new Error("DSH bridge shutting down"));
    for (const [id, pending] of pendingOutbound) {
      pendingOutbound.delete(id);
      pending.reject(new Error("DSH bridge shutting down"));
    }
    while (disposers.length > 0) {
      try {
        disposers.pop()?.();
      } catch {
        // Ignore disposer errors during teardown.
      }
    }
    const records = [...sessions.values()];
    sessions.clear();
    quiescing = Promise.allSettled(records.map((record) => record.close())).then(() => undefined);
    return quiescing;
  }

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
    const hasId = "id" in frame && frame.id !== undefined && frame.id !== null;
    const hasMethod = typeof frame.method === "string";

    if (hasId && !hasMethod) {
      const pending = pendingOutbound.get(frame.id);
      if (!pending) return;
      pendingOutbound.delete(frame.id);
      if (frame.error) {
        pending.reject(new Error(frame.error.message ?? "Host RPC error"));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    if (hasMethod) {
      void handleRequest(frame.method, frame.params).then(
        (result) => {
          if (hasId) writeFrame({ jsonrpc: "2.0", id: frame.id, result: result ?? null });
        },
        (error) => {
          if (hasId) {
            writeFrame({
              jsonrpc: "2.0",
              id: frame.id,
              error: {
                code: typeof error?.rpcCode === "number" ? error.rpcCode : -32603,
                message: errorMessage(error),
              },
            });
          } else {
            logger.warn(`paseo-dsh-bridge: notification ${frame.method} failed: ${errorMessage(error)}`);
          }
        },
      );
    }
  }

  onLine = handleLine;
  while (earlyLines.length > 0) {
    handleLine(earlyLines.shift());
  }

  rl.on("close", () => {
    void quiesce();
  });

  return quiesce;
  })();

  ctx.effect(() => () => {
    try {
      rl.close();
    } catch {
      // Ignore readline close error.
    }
    return initPromise.then((quiesceFn) => quiesceFn?.(), () => undefined);
  }, "paseo-dsh-bridge");
}
