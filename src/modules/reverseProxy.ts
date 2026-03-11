import http, { IncomingMessage, ServerResponse } from "node:http";
import net, { Socket } from "node:net";
import { Duplex, Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import tls from "node:tls";
import { AppConfig, EmbyServerProfile } from "./config.js";

interface ProxyTarget {
  serverId: string;
  serverUrl: string;
}

export class ReverseProxyManager {
  private listeners = new Map<number, { target: ProxyTarget; server: http.Server }>();
  private readonly webUiForwardHost: string;

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly webUiPort: number,
    private readonly host: string,
    private readonly log: {
      info: (message: string) => void;
      warn: (message: string) => void;
      error: (message: string) => void;
    }
  ) {
    this.webUiForwardHost =
      this.host === "0.0.0.0" || this.host === "::" ? "127.0.0.1" : this.host;
  }

  async sync(): Promise<void> {
    const expected = this.collectTargets(this.getConfig());

    for (const [port, current] of this.listeners.entries()) {
      const next = expected.get(port);
      if (!next || next.serverId !== current.target.serverId || next.serverUrl !== current.target.serverUrl) {
        await this.stopListener(port);
      }
    }

    for (const [port, target] of expected.entries()) {
      if (!this.listeners.has(port)) {
        try {
          await this.startListener(port, target);
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown error";
          this.log.error(`Failed to start reverse proxy on ${port}: ${message}`);
        }
      }
    }
  }

  async closeAll(): Promise<void> {
    const ports = Array.from(this.listeners.keys());
    for (const port of ports) {
      await this.stopListener(port);
    }
  }

  private collectTargets(config: AppConfig): Map<number, ProxyTarget> {
    const targets = new Map<number, ProxyTarget>();

    for (const server of config.emby.servers) {
      for (const rawPort of server.reverseProxyPorts) {
        const port = Number.parseInt(rawPort, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          continue;
        }
        if (port === this.webUiPort) {
          this.log.warn(`Skip reverse proxy port ${port}: reserved for WebUI`);
          continue;
        }
        if (targets.has(port)) {
          this.log.warn(`Skip duplicate reverse proxy port ${port}`);
          continue;
        }
        if (!isValidHttpUrl(server.serverUrl)) {
          continue;
        }

        targets.set(port, {
          serverId: server.id,
          serverUrl: server.serverUrl
        });
      }
    }

    return targets;
  }

  private async startListener(port: number, target: ProxyTarget): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res, target).catch((error) => {
        const message = error instanceof Error ? error.message : "proxy request failed";
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json; charset=utf-8");
        }
        res.end(JSON.stringify({ error: message }));
      });
    });
    server.on("upgrade", (req, socket, head) => {
      this.handleUpgrade(req, socket, head, target);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, this.host);
    });

    this.listeners.set(port, { target, server });
    this.log.info(`Emby reverse proxy listening on ${this.host}:${port} -> ${target.serverUrl}`);
  }

  private async stopListener(port: number): Promise<void> {
    const entry = this.listeners.get(port);
    if (!entry) {
      return;
    }

    await new Promise<void>((resolve) => {
      entry.server.close(() => resolve());
    });

    this.listeners.delete(port);
    this.log.info(`Stopped reverse proxy listener on ${this.host}:${port}`);
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    target: ProxyTarget
  ): Promise<void> {
    const method = req.method || "GET";
    const path = req.url || "/";

    const forwardToWebUi = isPlaybackIntercept(method, path);
    const targetBase = forwardToWebUi
      ? `http://${this.webUiForwardHost}:${this.webUiPort}`
      : target.serverUrl;

    let targetUrl: URL;
    try {
      targetUrl = new URL(path, targetBase);
    } catch (_error) {
      res.statusCode = 400;
      res.end("Bad target URL");
      return;
    }

    const headers = sanitizeHeaders(req.headers, targetUrl.host, forwardToWebUi ? target.serverId : undefined);
    const body = await readRequestBody(req);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const upstream = await fetch(targetUrl, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal
      });

      res.statusCode = upstream.status;
      upstream.headers.forEach((value, key) => {
        if (isHopByHopHeader(key)) {
          return;
        }
        res.setHeader(key, value);
      });

      if (!upstream.body) {
        res.end();
        return;
      }

      const stream = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>);
      stream.on("error", () => {
        res.destroy();
      });
      stream.pipe(res);
    } catch (error) {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json; charset=utf-8");
      const message = error instanceof Error ? error.message : "proxy request failed";
      res.end(JSON.stringify({ error: message }));
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleUpgrade(
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
    target: ProxyTarget
  ): void {
    let upstreamUrl: URL;
    try {
      upstreamUrl = new URL(req.url || "/", target.serverUrl);
    } catch (_error) {
      clientSocket.destroy();
      return;
    }

    const useTls = upstreamUrl.protocol === "https:";
    const upstreamPort = upstreamUrl.port
      ? Number.parseInt(upstreamUrl.port, 10)
      : useTls
        ? 443
        : 80;

    const upstreamSocket = useTls
      ? tls.connect({
          host: upstreamUrl.hostname,
          port: upstreamPort,
          servername: upstreamUrl.hostname
        })
      : net.connect({
          host: upstreamUrl.hostname,
          port: upstreamPort
        });

    const closeBoth = () => {
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
      if (!upstreamSocket.destroyed) {
        upstreamSocket.destroy();
      }
    };

    upstreamSocket.once("error", () => {
      closeBoth();
    });
    clientSocket.once("error", () => {
      closeBoth();
    });

    upstreamSocket.once("connect", () => {
      const headerLines = buildUpgradeHeaderLines(req.headers, upstreamUrl.host);
      const requestLine = `${req.method || "GET"} ${upstreamUrl.pathname}${upstreamUrl.search} HTTP/1.1\r\n`;
      const payload = `${requestLine}${headerLines.join("\r\n")}\r\n\r\n`;
      upstreamSocket.write(payload);
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    });
  }
}

function sanitizeHeaders(
  headers: IncomingMessage["headers"],
  host: string,
  serverId?: string
): Record<string, string> {
  const out: Record<string, string> = {
    host
  };

  if (serverId) {
    out["x-emby-target-server-id"] = serverId;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (!value || isHopByHopHeader(key) || key.toLowerCase() === "host") {
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.join(", ");
      continue;
    }
    out[key] = value;
  }

  return out;
}

function buildUpgradeHeaderLines(
  headers: IncomingMessage["headers"],
  host: string
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  lines.push(`Host: ${host}`);
  seen.add("host");

  for (const [key, value] of Object.entries(headers)) {
    if (!value) {
      continue;
    }
    const lower = key.toLowerCase();
    if (lower === "host") {
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`${key}: ${value.join(", ")}`);
      seen.add(lower);
      continue;
    }
    lines.push(`${key}: ${value}`);
    seen.add(lower);
  }

  if (!seen.has("connection")) {
    lines.push("Connection: Upgrade");
  }
  if (!seen.has("upgrade")) {
    lines.push("Upgrade: websocket");
  }

  return lines;
}

async function readRequestBody(req: IncomingMessage): Promise<Blob | undefined> {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return new Blob([Buffer.concat(chunks)]);
}

function isPlaybackIntercept(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  const [pathname, queryText = ""] = path.split("?");
  const query = new URLSearchParams(queryText);

  if (/^\/emby\/[Vv]ideos\/[^/]+\/original(?:\.[^/]+)?$/i.test(pathname)) {
    return true;
  }

  if (/^\/emby\/[Vv]ideos\/[^/]+\/stream/i.test(pathname)) {
    const isStatic = query.get("static");
    if (isStatic && isStatic.toLowerCase() === "true") {
      return true;
    }
  }

  return false;
}

function isHopByHopHeader(header: string): boolean {
  const key = header.toLowerCase();
  return (
    key === "connection" ||
    key === "keep-alive" ||
    key === "proxy-authenticate" ||
    key === "proxy-authorization" ||
    key === "te" ||
    key === "trailer" ||
    key === "transfer-encoding" ||
    key === "upgrade"
  );
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

export function findEmbyServerByPort(
  servers: EmbyServerProfile[],
  port: number
): EmbyServerProfile | undefined {
  return servers.find((server) => {
    return server.reverseProxyPorts.some((item) => Number.parseInt(item, 10) === port);
  });
}
