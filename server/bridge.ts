// This function is serialized into node --eval because Paseo evaluates the plugin bundle without a file URL.
export async function acpBridge(electronRunAsNode?: string | null) {
  const { spawn } = await import("node:child_process");
  const { extname } = await import("node:path");
  const { createInterface } = await import("node:readline");
  const { once } = await import("node:events");
  const [command, ...args] = process.argv.slice(1);
  if (!command) throw new Error("Missing DSH executable");
  const prompts = new Map<unknown, string>();
  const permissions = new Map<unknown, { sessionId: string; withdrawn: boolean }>();

  function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function normalize(frame: unknown) {
    if (!object(frame)) return frame;
    const sessionId = prompts.get(frame.id);
    if (sessionId !== undefined && ("result" in frame || "error" in frame)) {
      prompts.delete(frame.id);
      for (const permission of permissions.values()) {
        if (permission.sessionId === sessionId) permission.withdrawn = true;
      }
    }
    if (!object(frame.params)) return frame;
    const params = frame.params;
    if (frame.method === "session/request_permission" && object(params.toolCall)) {
      if (typeof params.sessionId === "string" && "id" in frame) {
        permissions.set(frame.id, { sessionId: params.sessionId, withdrawn: false });
      }
      if (params.toolCall.rawInput === undefined) params.toolCall.rawInput = {};
    }
    if (frame.method === "session/update" && object(params.update)) {
      const update = params.update;
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        if (update.rawOutput === undefined && Array.isArray(update.content)) {
          const output = update.content.map((item: unknown) => {
            if (object(item) && item.type === "content" && object(item.content)) {
              if (item.content.type === "text" && typeof item.content.text === "string") {
                return item.content.text;
              }
            }
            return JSON.stringify(item);
          }).join("\n");
          if (output !== "") update.rawOutput = output;
        }
        if (update.status === "failed" && update.rawOutput == null) {
          update.rawOutput = { message: `DSH tool failed: ${update.title ?? update.toolCallId}` };
        }
      }
    }
    return frame;
  }

  // Keep the same cmd.exe quoting as Paseo 0.15.2 for dsh.cmd and bare dsh launches.
  function quote(value: string): string {
    const quoted = value.startsWith('"') && value.endsWith('"');
    const raw = quoted ? value.slice(1, -1) : value;
    const escaped = raw.replace(/([&|^<>()!])/g, "^$1");
    if (quoted || /[\s"]/u.test(raw)) {
      return `"${escaped.replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`).replace(/\\+$/u, slashes => `${slashes}${slashes}`)}"`;
    }
    return escaped;
  }

  const extension = extname(command).toLowerCase();
  const shell = process.platform === "win32" &&
    (extension === ".cmd" || extension === ".bat" || (!extension && !/[\\/]/u.test(command)));
  const childEnv = { ...process.env };
  if (electronRunAsNode === null) delete childEnv.ELECTRON_RUN_AS_NODE;
  else if (electronRunAsNode !== undefined) childEnv.ELECTRON_RUN_AS_NODE = electronRunAsNode;
  const child = spawn(shell ? quote(command) : command, shell ? args.map(quote) : args, {
    shell, stdio: "pipe", env: childEnv, windowsHide: true,
  });
  child.once("error", error => {
    process.stderr.write(`DSH launch failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.stdin.on("error", error => {
    if ("code" in error && error.code === "EPIPE") return;
    process.stderr.write(`DSH stdin failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.stderr.pipe(process.stderr, { end: false });
  const closed = new Promise<number>(resolve => {
    child.once("close", code => resolve(code ?? 1));
  });
  process.on("SIGTERM", () => child.kill("SIGKILL"));
  process.on("SIGINT", () => child.kill("SIGKILL"));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const forwardInput = async () => {
    for await (const line of input) {
      let output = line;
      try {
        const frame: unknown = JSON.parse(line);
        if (object(frame)) {
          const permission = permissions.get(frame.id);
          if (permission && ("result" in frame || "error" in frame)) {
            permissions.delete(frame.id);
            if (permission.withdrawn) {
              delete frame.error;
              frame.result = { outcome: { outcome: "cancelled" } };
              output = JSON.stringify(frame);
            }
          }
          if (object(frame.params) && typeof frame.params.sessionId === "string") {
            if (frame.method === "session/prompt") prompts.set(frame.id, frame.params.sessionId);
          }
        }
      } catch {
        // The ACP SDK owns validation on the host side.
      }
      if (!child.stdin.write(`${output}\n`)) await once(child.stdin, "drain");
    }
    child.stdin.end();
  };
  void forwardInput().catch(error => {
    if (error && typeof error === "object" && "code" in error && error.code === "EPIPE") return;
    process.stderr.write(`DSH input failed: ${String(error)}\n`);
    child.kill();
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let output = line;
      try {
        output = JSON.stringify(normalize(JSON.parse(line)));
      } catch {
        // Preserve malformed output so the ACP SDK reports the original protocol error.
      }
      if (!process.stdout.write(`${output}\n`)) await once(process.stdout, "drain");
    }
  } finally {
    input.close();
    process.stdin.pause();
    process.exitCode = await closed;
  }
}
