import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = toJsonValue(v);
    }
    return out;
  }
  return String(value);
}

export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function extractToolOutputText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block !== undefined && block !== null) {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

export function buildToolCallDetail(
  name: string,
  rawInput: unknown,
  rawOutput?: unknown,
): ProviderToolCallDetail {
  const input = isRecord(rawInput) ? rawInput : {};
  const outputText = extractToolOutputText(rawOutput);
  const lower = normalizeToolName(name);

  if (lower === "bash" || lower === "shell" || lower === "exec" || lower === "run_command" || lower === "terminal") {
    const command = asString(input.command) ?? asString(input.cmd) ?? asString(input.script) ?? "";
    const cwd = asString(input.cwd) ?? asString(input.workdir);
    let exitCode: number | null | undefined;
    if (isRecord(rawOutput) && typeof rawOutput.exitCode === "number") {
      exitCode = rawOutput.exitCode;
    }
    return {
      type: "shell",
      command,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(outputText !== undefined ? { output: outputText } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }

  if (lower === "read" || lower === "read_file" || lower === "view_file") {
    const filePath = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path) ?? "";
    const offset = asNumber(input.offset) ?? asNumber(input.start_line) ?? asNumber(input.startLine);
    const limit = asNumber(input.limit) ?? asNumber(input.max_lines);
    return {
      type: "read",
      filePath,
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(outputText !== undefined ? { content: outputText } : {}),
    };
  }

  if (lower === "edit" || lower === "edit_file" || lower === "str_replace" || lower === "replace") {
    const filePath = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path) ?? "";
    const oldString = asString(input.old_string) ?? asString(input.oldString) ?? asString(input.old_str);
    const newString = asString(input.new_string) ?? asString(input.newString) ?? asString(input.new_str);
    const unifiedDiff = asString(input.diff) ?? asString(input.patch);
    return {
      type: "edit",
      filePath,
      ...(oldString !== undefined ? { oldString } : {}),
      ...(newString !== undefined ? { newString } : {}),
      ...(unifiedDiff !== undefined ? { unifiedDiff } : {}),
    };
  }

  if (lower === "write" || lower === "write_file" || lower === "create_file") {
    const filePath = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path) ?? "";
    const content = asString(input.content) ?? asString(input.text);
    return {
      type: "write",
      filePath,
      ...(content !== undefined ? { content } : {}),
    };
  }

  if (lower === "grep" || lower === "glob" || lower === "search" || lower === "find" || lower === "web_search") {
    const query =
      asString(input.pattern) ??
      asString(input.query) ??
      asString(input.glob) ??
      asString(input.path) ??
      "";
    const toolName =
      lower === "grep"
        ? "grep"
        : lower === "glob" || lower === "find"
          ? "glob"
          : lower === "web_search"
            ? "web_search"
            : "search";
    return {
      type: "search",
      query,
      toolName,
      ...(outputText !== undefined ? { content: outputText } : {}),
    };
  }

  if (lower === "fetch" || lower === "web_fetch" || lower === "webfetch") {
    const url = asString(input.url) ?? "";
    const prompt = asString(input.prompt);
    return {
      type: "fetch",
      url,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(outputText !== undefined ? { result: outputText } : {}),
    };
  }

  if (lower === "subagent" || lower === "task" || lower === "spawn_subagent" || lower === "agent") {
    const subAgentType = asString(input.subagent_type) ?? asString(input.type) ?? asString(input.agent);
    const description = asString(input.description) ?? asString(input.prompt);
    return {
      type: "sub_agent",
      ...(subAgentType !== undefined ? { subAgentType } : {}),
      ...(description !== undefined ? { description } : {}),
      log: outputText ?? "",
    };
  }

  const output: JsonValue =
    outputText !== undefined
      ? outputText
      : rawOutput !== undefined
        ? toJsonValue(rawOutput)
        : null;

  return {
    type: "unknown",
    input: toJsonValue(rawInput ?? {}),
    output,
  };
}
