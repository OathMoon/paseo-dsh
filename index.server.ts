import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { acpBridge } from "./server/bridge.ts";
import { createDirectDshConnection } from "./server/connection.ts";
import { prepareDshHistoryLaunch } from "./server/history-launch.ts";
import { inspectDshStatus } from "./server/launch.ts";
import { withPermissionCleanup } from "./server/permissions.ts";

export default function contribute(server: PluginServerContext) {
  if (process.env.PASEO_DSH_ENGINE === "acp") {
    const provider = runAcpProvider({
      id: "dsh",
      label: "DeepSeek Harness",
      command: ["dsh", "--profile", "acp"],
      acpOptions: { workspaceOnlyCatalog: true, startupTimeoutMs: 90_000 },
    });
    server.registerProvider({
      ...provider,
      status: (request) => inspectDshStatus(request.launch),
      async connect(request) {
        const launch = await prepareDshHistoryLaunch(
          request.launch ?? {
            command: "dsh",
            args: ["--profile", "acp"],
            env: Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          },
        );
        const electron = process.versions.electron !== undefined;
        const bridgeArgument = electron
          ? JSON.stringify(launch.env.ELECTRON_RUN_AS_NODE ?? null)
          : "";
        return withPermissionCleanup(
          await provider.connect({
            ...request,
            launch: {
              command: process.execPath,
              args: [
                "--input-type=module",
                "--eval",
                `(${acpBridge.toString()})(${bridgeArgument})`,
                "--",
                launch.command,
                ...launch.args,
              ],
              env: electron ? { ...launch.env, ELECTRON_RUN_AS_NODE: "1" } : launch.env,
            },
          }),
        );
      },
    });
    return () => {};
  }

  server.registerProvider({
    id: "dsh",
    label: "DeepSeek Harness",
    description: "DeepSeek Harness direct provider with streaming, rich tools, modes, commands, steer, revert, and subsessions",
    command: ["dsh", "--profile", "acp"],
    status: (request) => inspectDshStatus(request.launch),
    connect: (request) => createDirectDshConnection(request),
  });
  return () => {};
}
