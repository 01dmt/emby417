import { FastifyRequest } from "fastify";
import { PlaybackStrategy } from "./config.js";

export interface PlaybackRequestQuery {
  [key: string]: string | undefined;
  strmPath?: string;
  strmContent?: string;
  strategy?: PlaybackStrategy;
  api_key?: string;
  apiKey?: string;
  MediaSourceId?: string;
  UserId?: string;
}

export interface ParsedPlaybackRequest {
  routePath: string;
  requestUrl: string;
  itemId: string;
  mediaSourceId: string;
  mediaSourceGuid: string;
  userId: string;
  apiKey: string;
  requestUserAgent: string;
  query: PlaybackRequestQuery;
  normalizedHeaders: Record<string, string | undefined>;
}

export function parsePlaybackRequest(
  request: FastifyRequest,
  query: PlaybackRequestQuery
): ParsedPlaybackRequest {
  const requestUrl = request.url || "";
  const routePath = requestUrl.split("?")[0] || "/play";
  const normalizedHeaders = normalizeHeaderMap(
    request.headers as Record<string, string | string[] | undefined>
  );
  const userId = resolvePlaybackUserId(query, normalizedHeaders);
  const sourceId = extractMediaSourceIdFromUrl(requestUrl) || "";
  return {
    routePath,
    requestUrl,
    itemId: extractItemIdFromPath(requestUrl) || "",
    mediaSourceId: sourceId,
    mediaSourceGuid: sourceId,
    userId,
    apiKey: query.api_key || query.apiKey || normalizedHeaders["x-emby-token"] || "",
    requestUserAgent: extractHeaderValue(request.headers["user-agent"]) || "",
    query,
    normalizedHeaders
  };
}

export function resolvePlaybackUserId(
  query: { UserId?: string; [key: string]: string | undefined },
  headers: Record<string, string | undefined>
): string {
  const userId =
    query.UserId
    || headers["x-emby-user-id"]
    || headers["x-emby-userid"]
    || headers["emby-userid"]
    || headers["x-mediabrowser-userid"]
    || extractUserIdFromAuthHeader(headers["x-emby-authorization"])
    || extractUserIdFromAuthHeader(headers.authorization)
    || "";
  return String(userId).trim();
}

export function normalizeHeaderMap(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
      continue;
    }
    if (Array.isArray(value) && value.length > 0) {
      normalized[key.toLowerCase()] = value[0];
    }
  }
  return normalized;
}

export function extractHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return undefined;
}

export function extractMediaSourceIdFromUrl(rawUrl: string): string | undefined {
  const queryText = rawUrl.split("?")[1] || "";
  const params = new URLSearchParams(queryText);
  const source = params.get("MediaSourceId") || "";
  const cleaned = source.trim();
  if (!cleaned) {
    return undefined;
  }
  if (/^mediasource_/i.test(cleaned)) {
    return cleaned.replace(/^mediasource_/i, "");
  }
  return cleaned;
}

export function extractItemIdFromPath(pathname: string): string | null {
  const matched = pathname.match(/\/emby\/[Vv]ideos\/([^/?]+)/);
  return matched ? matched[1] : null;
}

function extractUserIdFromAuthHeader(value: string | undefined): string {
  if (!value || typeof value !== "string") {
    return "";
  }
  const match = value.match(/UserId\s*=\s*"?([0-9a-fA-F-]{8,})"?/i);
  return match && match[1] ? match[1].trim() : "";
}
