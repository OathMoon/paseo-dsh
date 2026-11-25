import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { execCommand } from "@getpaseo/plugin/server";
import { Document, isMap, isSeq, parseDocument, type YAMLMap } from "yaml";
import type { ProviderLaunch, ProviderStatus } from "@getpaseo/plugin/server/provider";
import { applyDshBridge } from "./dsh-bridge-plugin.mjs";

const dshPackageSchema = z.object({
  name: z.literal("@deepseek-ai/dsh"),
  version: z.string().optional(),
});

const DUMP_CONFIG_CACHE_TTL_MS = 60_000;
const patchCache = new Map<string, Promise<string>>();
const dumpConfigCache = new Map<string, { expiresAt: number; promise: Promise<PreparedDshBridgeLaunch> }>();

export interface PreparedDshBridgeLaunch {
  launch: ProviderLaunch;
  anchor: string;
  profile: string;
  dshVersion: string;
}

interface DshAnchorInfo {
  anchor: string;
  version: string;
}

async function readDshPackage(directory: string): Promise<{ version: string } | undefined> {
  const manifest = join(directory, "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    const data: unknown = JSON.parse(await readFile(manifest, "utf8"));
    const parsed = dshPackageSchema.safeParse(data);
    if (!parsed.success) return undefined;
    return { version: parsed.data.version ?? "unknown" };
  } catch {
    return undefined;
  }
}

export function resolveLaunchCommand(launch: ProviderLaunch): string | undefined {
  if (isAbsolute(launch.command)) return existsSync(launch.command) ? launch.command : undefined;
  const searchPath = Object.entries(launch.env).find(([key]) => key.toLowerCase() === "path")?.[1];
  let extensions: string[];
  if (process.platform === "win32") {
    const pathExtRaw = Object.entries(launch.env).find(([key]) => key.toLowerCase() === "pathext")?.[1];
    const parsedExts = (pathExtRaw ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext.startsWith("."));
    extensions = [...new Set(parsedExts), ""];
  } else {
    extensions = [""];
  }
  for (const directory of searchPath?.split(delimiter) ?? []) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, launch.command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function findDshAnchor(launch: ProviderLaunch): Promise<DshAnchorInfo | undefined> {
  for (const argument of launch.args) {
    if (!isAbsolute(argument) || !/\.[cm]?[jt]s$/iu.test(argument)) continue;
    for (const directory of [dirname(argument), dirname(dirname(argument))]) {
      const pkg = await readDshPackage(directory);
      if (pkg) return { anchor: argument, version: pkg.version };
    }
  }
  const command = resolveLaunchCommand(launch);
  if (!command || !/^dsh(?:\.(?:cmd|bat|exe|[cm]?js))?$/iu.test(parse(command).base)) {
    return undefined;
  }

  // Follow symlinks (common on macOS/Linux global installs) and walk up to locate @deepseek-ai/dsh.
  let realCommand = command;
  try {
    realCommand = realpathSync(command);
  } catch {
    // Keep original command path if realpath fails.
  }
  let cursor = dirname(realCommand);
  for (let depth = 0; depth < 6; depth++) {
    const pkg = await readDshPackage(cursor);
    if (pkg) {
      const anchor = join(cursor, "lib", "bin.js");
      if (existsSync(anchor)) return { anchor, version: pkg.version };
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  // Fallback for Windows npm shims (<prefix>/dsh.cmd -> <prefix>/node_modules/@deepseek-ai/dsh).
  const packageDirectory = join(dirname(command), "node_modules", "@deepseek-ai", "dsh");
  const pkg = await readDshPackage(packageDirectory);
  if (!pkg) return undefined;
  const anchor = join(packageDirectory, "lib", "bin.js");
  if (!existsSync(anchor)) throw new Error(`DSH CLI entry is missing: ${anchor}`);
  return { anchor, version: pkg.version };
}

function detectProfileName(args: readonly string[]): string {
  const idx = args.indexOf("--profile");
  if (idx >= 0 && typeof args[idx + 1] === "string") return args[idx + 1];
  return "default";
}

function findStdoutServerRows(entries: unknown, results: YAMLMap[] = []): YAMLMap[] {
  if (!isSeq(entries)) return results;
  for (const entry of entries.items) {
    if (!isMap(entry)) continue;
    const id = entry.get("id");
    if ((id === "acp" || id === "sdk-jsonrpc-server") && entry.get("disabled") !== true) {
      results.push(entry);
    }
    if (entry.get("group") === true) {
      findStdoutServerRows(entry.get("config"), results);
    }
  }
  return results;
}

function extractInjectList(rows: readonly YAMLMap[]): string[] {
  const result = new Set<string>(["agents", "llm", "sessionPersistence", "sessions"]);
  for (const row of rows) {
    const inject = row.get("inject");
    if (isSeq(inject)) {
      for (const item of inject.items) {
        const value = typeof item === "string" ? item : (item as { value?: unknown })?.value;
        if (typeof value === "string" && value.length > 0) result.add(value);
      }
    }
  }
  return [...result];
}

function extractDefaultRoute(rows: readonly YAMLMap[]): { provider?: string; model?: string } {
  for (const row of rows) {
    const cfg = row.get("config");
    if (isMap(cfg)) {
      const provider = cfg.get("provider");
      const model = cfg.get("model");
      if (typeof provider === "string" && typeof model === "string") {
        return { provider, model };
      }
    }
  }
  return {};
}

async function createBridgePatch(
  anchor: string,
  dshVersion: string,
  profile: string,
  stdoutRows: readonly YAMLMap[],
): Promise<string> {
  const anchorUrl = pathToFileURL(anchor).href;
  const moduleSource = [
    'import { createRequire } from "node:module";',
    `const require = createRequire(${JSON.stringify(anchorUrl)});`,
    'export const name = "paseo-dsh-bridge";',
    'export const inject = ["agents", "llm", "sessionPersistence", "sessions"];',
    `export function apply(ctx, config) { return (${applyDshBridge.toString()})(ctx, config ?? {}, require); }`,
    "",
  ].join("\n");

  const patchItems: unknown[] = [];
  for (const row of stdoutRows) {
    const id = row.get("id");
    if (typeof id === "string") {
      patchItems.push({ id, disabled: true });
    }
  }
  const route = extractDefaultRoute(stdoutRows);
  const inject = extractInjectList(stdoutRows);
  const digest = createHash("sha256")
    .update(moduleSource)
    .update("\0")
    .update(JSON.stringify({ profile, dshVersion, route, inject, ids: stdoutRows.map((r) => r.get("id")) }))
    .digest("hex")
    .slice(0, 16);
  const directory = join(tmpdir(), `paseo-dsh-bridge-${digest}`);
  await mkdir(directory, { recursive: true });
  const modulePath = join(directory, "paseo-dsh-bridge.mjs");
  await writeFile(modulePath, moduleSource, "utf8");

  patchItems.push({
    insert: [
      {
        id: "paseo-dsh-bridge",
        name: pathToFileURL(modulePath).href,
        inject,
        config: {
          profile,
          dshVersion,
          ...route,
        },
      },
    ],
  });

  const patchPath = join(directory, "bridge.patch.yml");
  const document = new Document(patchItems);
  await writeFile(patchPath, document.toString(), "utf8");
  return patchPath;
}

export function defaultDshLaunch(profile = "acp"): ProviderLaunch {
  return {
    command: "dsh",
    args: ["--profile", profile],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
}

export async function prepareDshBridgeLaunch(
  launch: ProviderLaunch,
): Promise<PreparedDshBridgeLaunch> {
  const anchorInfo = await findDshAnchor(launch);
  if (!anchorInfo) {
    throw new Error(
      `Unable to locate @deepseek-ai/dsh package for launch command "${launch.command}"`,
    );
  }
  // Verify core DSH LLM package is resolvable from this anchor before spawning.
  createRequire(anchorInfo.anchor).resolve("@deepseek-ai/dsh-llm");

  const envKey = Object.entries(launch.env)
    .filter(([k]) => /^(?:DSH_|DEEPSEEK_|HOME$|USERPROFILE$|XDG_)/i.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\0");
  const dumpKey = [
    launch.command,
    ...launch.args,
    anchorInfo.anchor,
    anchorInfo.version,
    envKey,
  ].join("\0");

  const now = Date.now();
  const cached = dumpConfigCache.get(dumpKey);
  if (cached && cached.expiresAt > now) {
    const resolved = await cached.promise;
    return {
      ...resolved,
      launch: { ...launch, args: [...launch.args, "--patch", resolved.launch.args.at(-1)!] },
    };
  }

  const promise = (async (): Promise<PreparedDshBridgeLaunch> => {
    const dump = await execCommand(launch.command, [...launch.args, "--dump-config"], {
      env: launch.env,
      timeout: 45_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const document = parseDocument(dump.stdout, {
      customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }],
    });
    if (document.errors.length > 0) {
      throw new Error(`Unable to parse DSH effective configuration: ${document.errors[0]?.message}`);
    }
    const stdoutRows = findStdoutServerRows(document.contents);
    const profile = detectProfileName(launch.args);
    const cacheKey = [
      anchorInfo.anchor,
      anchorInfo.version,
      profile,
      ...stdoutRows.map((row) => row.toString()),
    ].join("\0");

    let pending = patchCache.get(cacheKey);
    if (!pending) {
      pending = createBridgePatch(anchorInfo.anchor, anchorInfo.version, profile, stdoutRows);
      patchCache.set(cacheKey, pending);
      void pending.catch(() => {
        patchCache.delete(cacheKey);
      });
    }
    const patchPath = await pending;
    return {
      launch: { ...launch, args: [...launch.args, "--patch", patchPath] },
      anchor: anchorInfo.anchor,
      profile,
      dshVersion: anchorInfo.version,
    };
  })();

  dumpConfigCache.set(dumpKey, { expiresAt: now + DUMP_CONFIG_CACHE_TTL_MS, promise });
  void promise.catch(() => {
    if (dumpConfigCache.get(dumpKey)?.promise === promise) {
      dumpConfigCache.delete(dumpKey);
    }
  });
  return promise;
}

export async function inspectDshStatus(launch?: ProviderLaunch): Promise<ProviderStatus> {
  const effective = launch ?? defaultDshLaunch();
  try {
    const resolved = resolveLaunchCommand(effective);
    if (!resolved) {
      return {
        available: false,
        diagnostic: `DSH executable "${effective.command}" was not found on PATH. Install @deepseek-ai/dsh or configure agents.providers.dsh.command.`,
      };
    }
    const anchor = await findDshAnchor(effective);
    if (!anchor) {
      return {
        available: false,
        diagnostic: `Command "${effective.command}" does not point to an @deepseek-ai/dsh installation.`,
      };
    }
    return {
      available: true,
      diagnostic: `DeepSeek Harness ${anchor.version} (${detectProfileName(effective.args)} profile)`,
    };
  } catch (error) {
    return {
      available: false,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}
