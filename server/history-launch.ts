import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { execCommand } from "@getpaseo/plugin/server";
import { Document, isMap, isSeq, parseDocument, type YAMLMap } from "yaml";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { applyDshHistory } from "./dsh-history.mjs";

const dshPackage = z.object({ name: z.literal("@deepseek-ai/dsh") });
const patches = new Map<string, Promise<string>>();

async function isDshPackage(directory: string): Promise<boolean> {
  const manifest = join(directory, "package.json");
  if (!existsSync(manifest)) return false;
  const data: unknown = JSON.parse(await readFile(manifest, "utf8"));
  return dshPackage.safeParse(data).success;
}

function resolveCommand(launch: ProviderLaunch): string | undefined {
  if (isAbsolute(launch.command)) return launch.command;
  const searchPath = Object.entries(launch.env).find(([key]) => key.toLowerCase() === "path")?.[1];
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of searchPath?.split(delimiter) ?? []) {
    for (const extension of extensions) {
      const candidate = resolve(directory, launch.command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function findDshAnchor(launch: ProviderLaunch): Promise<string | undefined> {
  for (const argument of launch.args) {
    if (!isAbsolute(argument) || !/\.[cm]?[jt]s$/iu.test(argument)) continue;
    for (const directory of [dirname(argument), dirname(dirname(argument))]) {
      if (await isDshPackage(directory)) return argument;
    }
  }
  const command = resolveCommand(launch);
  if (!command || !/^dsh(?:\.(?:cmd|bat|exe|[cm]?js))?$/iu.test(parse(command).base)) return undefined;
  const packageDirectory = join(dirname(command), "node_modules", "@deepseek-ai", "dsh");
  if (!await isDshPackage(packageDirectory)) return undefined;
  const anchor = join(packageDirectory, "lib", "bin.js");
  if (!existsSync(anchor)) throw new Error(`DSH CLI is missing: ${anchor}`);
  return anchor;
}

async function createHistoryPatch(originalAcpPath: string, entry: YAMLMap): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-dsh-history-"));
  const modulePath = join(directory, "acp-history.mjs");
  const originalUrl = pathToFileURL(originalAcpPath).href;
  const module = [
    'import { createRequire } from "node:module";',
    `const original = await import(${JSON.stringify(originalUrl)});`,
    `const require = createRequire(${JSON.stringify(originalUrl)});`,
    "export const name = original.name;",
    "export const inject = original.inject;",
    "export const Config = original.Config;",
    `export function apply(ctx, config) { return (${applyDshHistory.toString()})(ctx, config, original, require); }`,
    "",
  ].join("\n");
  await writeFile(modulePath, module);
  const patchPath = join(directory, "history.patch.yml");
  const replacement = entry.clone();
  replacement.set("id", "paseo-dsh-acp-history");
  replacement.set("name", pathToFileURL(modulePath).href);
  const document = new Document([{ id: "acp", disabled: true }, { insert: [] }]);
  const insert = document.getIn([1, "insert"]);
  if (!isSeq(insert)) throw new Error("Unable to build DSH history configuration");
  insert.add(replacement);
  await writeFile(patchPath, document.toString());
  return patchPath;
}

export async function prepareDshHistoryLaunch(launch: ProviderLaunch): Promise<ProviderLaunch> {
  const anchor = await findDshAnchor(launch);
  if (!anchor) return launch;
  const originalAcpPath = createRequire(anchor).resolve("@deepseek-ai/dsh-acp");
  const dump = await execCommand(launch.command, [...launch.args, "--dump-config"], {
    env: launch.env, timeout: 15000, maxBuffer: 16 * 1024 * 1024,
  });
  const document = parseDocument(dump.stdout, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] });
  if (document.errors.length) throw new Error("Unable to read DSH effective ACP configuration");
  function findAcp(entries: unknown): YAMLMap | undefined {
    if (!isSeq(entries)) return undefined;
    for (const entry of entries.items) {
      if (!isMap(entry)) continue;
      if (entry.get("id") === "acp") return entry;
      if (entry.get("group") === true) {
        const found = findAcp(entry.get("config"));
        if (found) return found;
      }
    }
    return undefined;
  }
  const entry = findAcp(document.contents);
  if (!entry || entry.get("disabled") === true) throw new Error("DSH profile does not have an enabled ACP server");
  const cacheKey = `${originalAcpPath}\0${entry.toString()}`;
  let pending = patches.get(cacheKey);
  if (!pending) {
    pending = createHistoryPatch(originalAcpPath, entry);
    patches.set(cacheKey, pending);
    void pending.catch(() => { patches.delete(cacheKey); });
  }
  return { ...launch, args: [...launch.args, "--patch", await pending] };
}
