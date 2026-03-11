import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { AppConfig } from "./config.js";
import { runtimePaths } from "./runtime_paths.js";

const execFileAsync = promisify(execFile);
const caddyfilePath = runtimePaths.caddyfilePath;

function resolveWebUiPort(): number {
  const raw = String(process.env.WEB_UI_PORT || "8417").trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return 8417;
  }
  return parsed;
}

function isCaddyReloadDisabled(): boolean {
  const raw = String(process.env.DISABLE_CADDY_RELOAD || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

interface PortMapping {
  port: number;
  serverId: string;
  serverUrl: string;
}

export async function syncCaddyConfig(config: AppConfig): Promise<void> {
  const mappings = collectMappings(config);
  if (mappings.length === 0) {
    return;
  }

  const content = renderCaddyfile(mappings);
  await fs.mkdir(path.dirname(caddyfilePath), { recursive: true });
  await fs.writeFile(caddyfilePath, content, "utf-8");

  if (isCaddyReloadDisabled()) {
    return;
  }

  await execFileAsync("caddy", ["reload", "--config", caddyfilePath, "--adapter", "caddyfile"]);
}

function collectMappings(config: AppConfig): PortMapping[] {
  const webUiPort = resolveWebUiPort();
  const seen = new Set<number>();
  const mappings: PortMapping[] = [];

  for (const server of config.emby.servers) {
    if (!server.enabled) {
      continue;
    }
    const serverUrl = (server.serverUrl || "").trim();
    if (!serverUrl) {
      continue;
    }

    for (const rawPort of server.reverseProxyPorts) {
      const port = Number.parseInt(rawPort, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        continue;
      }
      if (port === webUiPort || seen.has(port)) {
        continue;
      }
      seen.add(port);
      mappings.push({
        port,
        serverId: server.id,
        serverUrl
      });
    }
  }

  return mappings;
}

function renderCaddyfile(mappings: PortMapping[]): string {
  const webUiPort = resolveWebUiPort();
  const blocks = mappings.map((item) => {
    return [
      `:${item.port} {`,
      "  @play_get {",
      "    method GET HEAD",
      "    path_regexp embyplay ^/emby/[Vv]ideos/.*$",
      "  }",
      "",
      "  handle @play_get {",
      `    reverse_proxy 127.0.0.1:${webUiPort} {`,
      `      header_up x-emby-target-server-id ${item.serverId}`,
      "    }",
      "  }",
      "",
      "  handle {",
      `    reverse_proxy ${item.serverUrl}`,
      "  }",
      "}"
    ].join("\n");
  });

  const globalOptions = [
    "{",
    "  grace_period 2s",
    "}"
  ].join("\n");

  return `${globalOptions}\n\n${blocks.join("\n\n")}\n`;
}