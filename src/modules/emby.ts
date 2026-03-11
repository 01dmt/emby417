import http from "node:http";
import https from "node:https";

import { AppConfig, getActiveEmbyServer, getEmbyServerById } from "./config.js";

export interface EmbySourceHint {
  strmPath?: string;
  strmContent?: string;
  serverId?: string;
}

export async function resolveFromEmbyRequest(params: {
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  config: AppConfig;
}): Promise<EmbySourceHint> {
  const { path, query, headers, config } = params;

  if (query.strmPath || query.strmContent) {
    return {
      strmPath: query.strmPath,
      strmContent: query.strmContent,
      serverId: headers["x-emby-target-server-id"]
    };
  }

  const itemId = extractItemId(path);
  if (!itemId) {
    return {};
  }

  const matchedServer = resolveTargetServer(config, headers);
  const apiKey = query.api_key || query.apiKey || getTokenFromHeaders(headers) || matchedServer.apiKey;
  const mediaSourceId = extractMediaSourceId(query.MediaSourceId || headers["x-emby-source"]);
  const userId =
    query.UserId ||
    headers["x-emby-user-id"] ||
    headers["x-emby-userid"] ||
    headers["emby-userid"] ||
    headers["x-mediabrowser-userid"] ||
    extractUserIdFromAuthHeader(headers["x-emby-authorization"]) ||
    extractUserIdFromAuthHeader(headers.authorization);

  const playbackInfo = await fetchPlaybackInfo(
    matchedServer.serverUrl,
    itemId,
    apiKey,
    mediaSourceId,
    userId,
    headers
  );

  const playbackSources = playbackInfo ? readMediaSources(playbackInfo.MediaSources) : [];
  const selectedPlaybackSource = selectMediaSource(playbackSources, mediaSourceId);
  const playbackPath = pickString(selectedPlaybackSource?.Path);

  if (playbackPath) {
    if (/\.strm$/i.test(playbackPath)) {
      return { strmPath: playbackPath, serverId: matchedServer.id };
    }
    return { strmContent: playbackPath, serverId: matchedServer.id };
  }

  const itemInfo = await fetchItemInfo(matchedServer.serverUrl, itemId, apiKey);
  if (!itemInfo) {
    const fallback = fallbackFromRequestIds(itemId, mediaSourceId);
    return fallback ? { strmContent: fallback, serverId: matchedServer.id } : { serverId: matchedServer.id };
  }

  const mediaSources = readMediaSources(itemInfo.MediaSources);
  const preferredSource = selectMediaSource(mediaSources, mediaSourceId);
  const mediaPath =
    pickString(preferredSource?.Path) ||
    pickString(mediaSources[0]?.Path);

  if (!mediaPath) {
    const fallback = fallbackFromRequestIds(itemId, mediaSourceId);
    return fallback ? { strmContent: fallback, serverId: matchedServer.id } : { serverId: matchedServer.id };
  }

  if (/\.strm$/i.test(mediaPath)) {
    return { strmPath: mediaPath, serverId: matchedServer.id };
  }

  return { strmContent: mediaPath, serverId: matchedServer.id };
}

function resolveTargetServer(
  config: AppConfig,
  headers: Record<string, string | undefined>
) {
  const activeServer = getActiveEmbyServer(config);
  const explicitServer = getEmbyServerById(config, headers["x-emby-target-server-id"]);
  if (explicitServer) {
    return explicitServer;
  }

  const byForwardedHost = matchServerByHostHeader(config, headers["x-forwarded-host"]);
  if (byForwardedHost) {
    return byForwardedHost;
  }

  const byHost = matchServerByHostHeader(config, headers.host);
  if (byHost) {
    return byHost;
  }

  const byForwardedPort = matchServerByReversePort(config, headers["x-forwarded-port"]);
  if (byForwardedPort) {
    return byForwardedPort;
  }

  return activeServer;
}

function matchServerByHostHeader(
  config: AppConfig,
  headerValue: string | undefined
) {
  const hostInfo = parseHostHeader(headerValue);
  if (!hostInfo) {
    return undefined;
  }

  if (hostInfo.port) {
    const byPort = matchServerByReversePort(config, hostInfo.port);
    if (byPort) {
      return byPort;
    }
  }

  return config.emby.servers.find((server) => {
    if (!server.enabled || !server.serverUrl) {
      return false;
    }
    try {
      const url = new URL(server.serverUrl);
      return url.hostname.toLowerCase() === hostInfo.hostname;
    } catch (_error) {
      return false;
    }
  });
}

function matchServerByReversePort(
  config: AppConfig,
  portValue: string | undefined
) {
  if (!portValue) {
    return undefined;
  }
  const port = portValue.trim();
  if (!/^\d+$/.test(port)) {
    return undefined;
  }
  return config.emby.servers.find((server) => {
    return server.enabled && Array.isArray(server.reverseProxyPorts) && server.reverseProxyPorts.includes(port);
  });
}

function parseHostHeader(value: string | undefined): { hostname: string; port?: string } | undefined {
  if (!value) {
    return undefined;
  }
  const first = value.split(",")[0];
  const text = first.trim();
  if (!text) {
    return undefined;
  }

  const normalized = text.includes("://") ? text : `http://${text}`;
  try {
    const url = new URL(normalized);
    return {
      hostname: url.hostname.toLowerCase(),
      port: url.port || undefined
    };
  } catch (_error) {
    return undefined;
  }
}

function extractItemId(pathname: string): string | null {
  const matched = pathname.match(/\/emby\/videos\/([^\/?]+)/i);
  return matched ? matched[1] : null;
}

function getTokenFromHeaders(headers: Record<string, string | undefined>): string | undefined {
  return (
    headers["x-emby-token"] ||
    headers["x-mediabrowser-token"] ||
    headers.authorization?.replace(/^Bearer\s+/i, "")
  );
}

function extractUserIdFromAuthHeader(value: string | undefined): string | undefined {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/UserId\s*=\s*"?([0-9a-fA-F-]{8,})"?/i);
  if (!match) {
    return undefined;
  }
  const id = (match[1] || "").trim();
  return id || undefined;
}

async function fetchItemInfo(
  serverUrl: string,
  itemId: string,
  apiKey?: string
): Promise<Record<string, unknown> | null> {
  const candidates = [
    `/Items/${itemId}`,
    `/emby/Items/${itemId}`,
    `/Items?Ids=${encodeURIComponent(itemId)}`,
    `/emby/Items?Ids=${encodeURIComponent(itemId)}`
  ];

  for (const route of candidates) {
    const endpoint = new URL(route, serverUrl);
    endpoint.searchParams.set("Fields", "Path,MediaSources");
    endpoint.searchParams.set("EnableTotalRecordCount", "false");
    if (apiKey) {
      endpoint.searchParams.set("api_key", apiKey);
    }

    const payload = await requestJson(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        ...(apiKey ? { "x-emby-token": apiKey } : {})
      }
    });
    if (!payload) {
      continue;
    }
    const item = extractItemPayload(payload);
    if (item) {
      return item;
    }
  }

  return null;
}

async function fetchPlaybackInfo(
  serverUrl: string,
  itemId: string,
  token: string | undefined,
  mediaSourceId: string | undefined,
  userId: string | undefined,
  headers: Record<string, string | undefined>
): Promise<Record<string, unknown> | null> {
  const routes = [
    `/Items/${itemId}/PlaybackInfo`,
    `/emby/Items/${itemId}/PlaybackInfo`
  ];

  const methods: Array<"POST" | "GET"> = ["POST", "GET"];
  const normalizedMediaSourceId = mediaSourceId || "";

  for (const route of routes) {
    for (const method of methods) {
      const endpoint = new URL(route, serverUrl);
      if (token) {
        endpoint.searchParams.set("api_key", token);
      }
      if (userId) {
        endpoint.searchParams.set("UserId", userId);
      }
      if (normalizedMediaSourceId) {
        endpoint.searchParams.set("MediaSourceId", normalizedMediaSourceId);
      }

      const requestHeaders = buildPlaybackInfoHeaders(token, headers);
      const requestInit: {
        method: "GET" | "POST";
        headers: Record<string, string>;
        body?: string;
      } = {
        method,
        headers: requestHeaders
      };

      if (method === "POST") {
        requestHeaders["content-type"] = "application/json";
        requestInit.body = JSON.stringify({
          UserId: userId || undefined,
          MediaSourceId: normalizedMediaSourceId || undefined,
          EnableDirectPlay: true,
          EnableDirectStream: true,
          EnableTranscoding: false
        });
      }

      const payload = await requestJson(endpoint, requestInit);
      if (!payload || typeof payload !== "object") {
        continue;
      }
      const record = payload as Record<string, unknown>;
      if (Array.isArray(record.MediaSources) || Array.isArray(record.Items)) {
        return record;
      }
    }
  }

  return null;
}

function buildPlaybackInfoHeaders(
  token: string | undefined,
  headers: Record<string, string | undefined>
): Record<string, string> {
  const requestHeaders: Record<string, string> = {
    accept: "application/json",
    "accept-encoding": "identity"
  };

  const ua = headers["user-agent"];
  if (ua) {
    requestHeaders["user-agent"] = ua;
  }

  if (token) {
    requestHeaders["x-emby-token"] = token;
    requestHeaders["x-mediabrowser-token"] = token;
  }

  return requestHeaders;
}

function extractMediaSourceId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const cleaned = value.trim();
  if (!cleaned) {
    return undefined;
  }
  if (/^mediasource_/i.test(cleaned)) {
    return cleaned.replace(/^mediasource_/i, "");
  }
  return cleaned;
}

function fallbackFromRequestIds(itemId: string, mediaSourceId?: string): string | undefined {
  if (mediaSourceId && /^\d+$/.test(mediaSourceId)) {
    return mediaSourceId;
  }
  if (/^\d+$/.test(itemId)) {
    return itemId;
  }
  return undefined;
}

function selectMediaSource(
  mediaSources: Array<Record<string, unknown>>,
  mediaSourceId: string | undefined
): Record<string, unknown> | undefined {
  if (mediaSources.length === 0) {
    return undefined;
  }

  if (mediaSourceId) {
    const exact = mediaSources.find((item) => {
      const id = extractMediaSourceId(pickString(item.Id));
      return id === mediaSourceId;
    });
    if (exact) {
      return exact;
    }
  }

  const localSource = mediaSources.find((item) => pickBoolean(item.IsRemote) === false);
  if (localSource) {
    return localSource;
  }

  const directPlaySource = mediaSources.find((item) => pickBoolean(item.SupportsDirectPlay) === true);
  if (directPlaySource) {
    return directPlaySource;
  }

  return mediaSources[0];
}

function extractItemPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.Items)) {
    const first = record.Items.find((item) => item && typeof item === "object");
    if (first && typeof first === "object") {
      return first as Record<string, unknown>;
    }
  }
  return record;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function readMediaSources(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => {
    return Boolean(item) && typeof item === "object";
  });
}

async function requestJson(
  endpoint: URL,
  options: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  }
): Promise<unknown | null> {
  const client = endpoint.protocol === "https:" ? https : http;

  return await new Promise((resolve, reject) => {
    const req = client.request(endpoint, {
      method: options.method,
      headers: options.headers
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          resolve(null);
          return;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
      res.on("error", (error) => {
        reject(error);
      });
    });

    req.setTimeout(15000, () => {
      req.destroy(new Error(`emby request timeout: ${endpoint.toString()}`));
    });
    req.on("error", (error) => {
      reject(error);
    });
    if (typeof options.body === "string" && options.body.length > 0) {
      req.write(options.body);
    }
    req.end();
  });
}
