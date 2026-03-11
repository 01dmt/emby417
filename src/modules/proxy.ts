import { LinkCache, makeDirectLinkCacheKey } from "./cache.js";
import { AppConfig, PlaybackStrategy, getCacheExpirySecondsByCookie } from "./config.js";
import { P115Client } from "./p115client.js";
import { normalizeStrmContent, readStrmContent } from "./strm.js";

export interface ResolveOptions {
  strmPath?: string;
  strmContent?: string;
  forceStrategy?: PlaybackStrategy;
  requestUserAgent?: string;
  requestCookie?: string;
  requestHeaders?: Record<string, string | undefined>;
  pathPrefixRules?: string;
  requestUserId?: string;
  requestMediaSourceId?: string;
}

export interface ResolveResult {
  strategy: PlaybackStrategy;
  directUrl: string;
  cached: boolean;
  cacheKey: string;
  sourceText: string;
  sourcePickcode: string;
  cacheSourcePath: string;
  cacheCreatedAt: string;
  cacheHeaders: Record<string, string>;
}

export async function resolveDirectLink(params: {
  options: ResolveOptions;
  config: AppConfig;
  cache: LinkCache;
  client: P115Client;
}): Promise<ResolveResult> {
  const { options, config, cache, client } = params;
  let content = options.strmContent;
  if (options.strmPath) {
    try {
      content = await readStrmContent(options.strmPath);
    } catch (error) {
      if (!content) {
        throw error;
      }
    }
  }
  if (!content) {
    throw new Error("strm content or path is required");
  }
  const normalized = normalizeStrmContent(content);
  const userAgentTag = (options.requestUserAgent || config.p115.userAgent || "").trim();
  const requestUserId = (options.requestUserId || "").trim();
  const cacheKey = makeDirectLinkCacheKey({
    path: normalized,
    userAgent: userAgentTag,
    userId: requestUserId,
    mediaSourceId: options.requestMediaSourceId
  });
  const strategy = options.forceStrategy ?? config.playback.defaultStrategy;

  if (config.cache.enabled) {
    const cachedEntry = cache.get(cacheKey);
    if (cachedEntry) {
      return {
        strategy,
        directUrl: cachedEntry.url,
        cached: true,
        cacheKey,
        sourceText: normalized,
        sourcePickcode: cachedEntry.pickcode || "",
        cacheSourcePath: cachedEntry.sourcePath,
        cacheCreatedAt: cachedEntry.createdAt,
        cacheHeaders: cachedEntry.headers
      };
    }
  }

  const result = await client.getDirectLink(
    normalized,
    options.requestUserAgent,
    options.pathPrefixRules,
    options.requestCookie
  );
  const requestHeaders = normalizeCacheHeaders(options.requestHeaders);
  const entry = config.cache.enabled
    ? cache.set(
      cacheKey,
        {
          url: result.url,
          sourcePath: normalized,
          mediaSourceId: options.requestMediaSourceId,
          headers: requestHeaders,
          pickcode: extractPickcode(result.raw),
          userId: requestUserId
        },
      getCacheExpirySecondsByCookie(config, options.requestCookie)
    )
    : {
      url: result.url,
      sourcePath: normalized,
      pickcode: extractPickcode(result.raw),
      headers: requestHeaders,
      createdAt: new Date().toISOString()
    };

  return {
    strategy,
    directUrl: entry.url,
    cached: false,
    cacheKey,
    sourceText: normalized,
    sourcePickcode: entry.pickcode || extractPickcode(result.raw),
    cacheSourcePath: entry.sourcePath,
    cacheCreatedAt: entry.createdAt,
    cacheHeaders: entry.headers
  };
}

function extractPickcode(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return "";
  }
  const record = raw as Record<string, unknown>;
  const direct = [record.pickcode, record.pick_code, record.pc];
  for (const value of direct) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const nestedCandidates = [record.data, record.result, record.payload, record.response];
  for (const item of nestedCandidates) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const nested = item as Record<string, unknown>;
    const nestedValues = [nested.pickcode, nested.pick_code, nested.pc];
    for (const value of nestedValues) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return "";
}

function normalizeCacheHeaders(
  headers: Record<string, string | undefined> | undefined
): Record<string, string> {
  const playbackHeaderKeys = new Set([
    "user-agent",
    "x-emby-device-id",
    "x-emby-device-name",
    "x-emby-client",
    "x-emby-client-version",
    "x-application",
    "x-application-version",
    "x-mediabrowser-device-id",
    "x-mediabrowser-device-name",
    "x-mediabrowser-client",
    "x-mediabrowser-client-version"
  ]);
  const out: Record<string, string> = {};
  if (!headers) {
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (!playbackHeaderKeys.has(normalizedKey)) {
      continue;
    }
    if (typeof value !== "string") {
      continue;
    }
    const text = value.trim();
    if (!text) {
      continue;
    }
    out[normalizedKey] = text;
  }
  return out;
}
