import { AppConfig, EmbyServerProfile, getActiveEmbyServer, getEmbyServerById } from "./config.js";
import { resolveFromEmbyRequest } from "./emby.js";
import { MediaSourceCache } from "./mediaCache.js";
import { P115Client } from "./p115client.js";
import { PlaybackError } from "./playback_error.js";
import { PlaybackRequestQuery, ParsedPlaybackRequest } from "./request_parser.js";
import { normalizeStrmContent, readStrmContent } from "./strm.js";

export interface MediaResolutionResult {
  server: EmbyServerProfile;
  strmPath: string;
  strmContent: string;
  sourceText: string;
  sourcePickcode: string;
  sourceGuid: string;
  mediaSourceId: string;
  cacheHit: boolean;
  diagnostics: Array<{
    stage: string;
    event: string;
    status: "ok" | "skip" | "error";
    data?: Record<string, string>;
  }>;
}

export async function resolvePlaybackMedia(params: {
  config: AppConfig;
  parsed: ParsedPlaybackRequest;
  cache: MediaSourceCache;
  client: P115Client;
  sourceCookie: string;
  pathPrefixRules: string;
}): Promise<MediaResolutionResult> {
  const { config, parsed, cache, client, sourceCookie, pathPrefixRules } = params;
  const diagnostics: MediaResolutionResult["diagnostics"] = [];
  diagnostics.push({
    stage: "emby_fetch",
    event: "emby_resolve_start",
    status: "ok",
    data: {
      item_id: parsed.itemId,
      media_source_id: parsed.mediaSourceId
    }
  });
  const embyHint = await resolveFromEmbyRequest({
    path: parsed.requestUrl,
    query: {
      strmPath: parsed.query.strmPath,
      strmContent: parsed.query.strmContent,
      api_key: parsed.query.api_key,
      apiKey: parsed.query.apiKey,
      MediaSourceId: parsed.query.MediaSourceId,
      UserId: parsed.query.UserId
    },
    headers: parsed.normalizedHeaders,
    config
  });

  const hintedServer = getEmbyServerById(config, embyHint.serverId);
  const server = hintedServer && hintedServer.enabled ? hintedServer : getActiveEmbyServer(config);
  diagnostics.push({
    stage: "emby_fetch",
    event: "emby_resolve_done",
    status: "ok",
    data: {
      server_id: server.id,
      has_strm_path: embyHint.strmPath ? "1" : "0",
      has_strm_content: embyHint.strmContent ? "1" : "0"
    }
  });
  const sourceGuid = parsed.mediaSourceGuid || parsed.mediaSourceId || "";
  const cached = sourceGuid ? cache.get(sourceGuid) : undefined;
  diagnostics.push({
    stage: "media_cache",
    event: "media_cache_lookup",
    status: cached ? "ok" : "skip",
    data: {
      source_guid: sourceGuid,
      cache_hit: cached ? "1" : "0"
    }
  });

  let strmPath = parsed.query.strmPath || embyHint.strmPath || cached?.path || "";
  let strmContent = parsed.query.strmContent || embyHint.strmContent || "";
  let sourceText = strmContent ? normalizeStrmContent(strmContent) : "";

  if (!sourceText && strmPath) {
    try {
      sourceText = normalizeStrmContent(await readStrmContent(strmPath));
      diagnostics.push({
        stage: "path_parse",
        event: "strm_file_read",
        status: "ok",
        data: { strm_path: strmPath }
      });
    } catch (_error) {
      sourceText = "";
      diagnostics.push({
        stage: "path_parse",
        event: "strm_file_read",
        status: "error",
        data: { strm_path: strmPath }
      });
    }
  }
  if (!sourceText && cached?.path) {
    sourceText = cached.path;
  }
  if (!sourceText) {
    throw new PlaybackError({
      step: "emby_path",
      errorCode: "EMBY_PATH_MISSING",
      errorReason: "PlaybackInfo/ItemInfo 未返回可用 Path",
      userMessage: "无法获取Emby path信息",
      details: {
        itemId: parsed.itemId,
        mediaSourceId: parsed.mediaSourceId,
        serverId: server.id,
        strmPath,
        hasStrmContent: strmContent ? "1" : "0"
      }
    });
  }
  diagnostics.push({
    stage: "path_parse",
    event: "source_text_resolved",
    status: "ok",
    data: {
      source_text_len: String(sourceText.length)
    }
  });

  const regexRules = parseRegexRules(server.customPickcodeRegex);
  const pathParsingConfigured = String(pathPrefixRules || "").trim().length > 0;
  const regexConfigured = regexRules.length > 0;
  let sourcePickcode = cached?.pickcode || "";

  if (pathParsingConfigured) {
    const picked = await client.getPickcode(
      sourceText,
      parsed.requestUserAgent,
      pathPrefixRules,
      sourceCookie
    );
    if (picked.pickcode.trim()) {
      sourcePickcode = picked.pickcode.trim();
    }
    diagnostics.push({
      stage: "path_parse",
      event: "pickcode_bridge_extract",
      status: sourcePickcode ? "ok" : "skip",
      data: {
        source_pickcode: sourcePickcode,
        configured: "1"
      }
    });
    if (picked.path.trim()) {
      sourceText = picked.path.trim();
      strmContent = sourceText;
    }
  } else {
    diagnostics.push({
      stage: "path_parse",
      event: "pickcode_bridge_extract",
      status: "skip",
      data: {
        configured: "0",
        reason: "path_prefix_rules_empty",
        source_pickcode: sourcePickcode
      }
    });
  }

  if (regexConfigured) {
    const regexPickcode = sourcePickcode
      ? ""
      : extractPickcodeByRegexRules(sourceText, regexRules);
    if (regexPickcode) {
      sourcePickcode = regexPickcode;
    }
    diagnostics.push({
      stage: "path_parse",
      event: "pickcode_regex_extract",
      status: regexPickcode ? "ok" : "skip",
      data: {
        regex_count: String(regexRules.length),
        configured: "1",
        reason: sourcePickcode && !regexPickcode ? "existing_pickcode" : "",
        source_pickcode: sourcePickcode
      }
    });
  } else {
    diagnostics.push({
      stage: "path_parse",
      event: "pickcode_regex_extract",
      status: "skip",
      data: {
        regex_count: String(regexRules.length),
        configured: "0",
        reason: "custom_regex_empty",
        source_pickcode: sourcePickcode
      }
    });
  }

  if (sourceGuid) {
    cache.set(
      {
        sourceGuid,
        mediaSourceId: parsed.mediaSourceId || cached?.mediaSourceId || sourceGuid,
        path: sourceText,
        pickcode: sourcePickcode
      },
      86400
    );
    diagnostics.push({
      stage: "media_cache",
      event: "media_cache_store",
      status: "ok",
      data: {
        source_guid: sourceGuid,
        source_pickcode: sourcePickcode
      }
    });
  }

  return {
    server,
    strmPath,
    strmContent,
    sourceText,
    sourcePickcode,
    sourceGuid,
    mediaSourceId: parsed.mediaSourceId || cached?.mediaSourceId || sourceGuid,
    cacheHit: Boolean(cached),
    diagnostics
  };
}

function parseRegexRules(raw: string): RegExp[] {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const list: RegExp[] = [];
  for (const line of lines) {
    try {
      list.push(new RegExp(line, "i"));
    } catch (_error) {
      continue;
    }
  }
  return list;
}

function extractPickcodeByRegexRules(text: string, rules: RegExp[]): string {
  for (const rule of rules) {
    const matched = text.match(rule);
    if (!matched) {
      continue;
    }
    if (matched[1] && matched[1].trim()) {
      return matched[1].trim();
    }
    if (matched[0] && matched[0].trim()) {
      return matched[0].trim();
    }
  }
  return "";
}

export function buildPlaybackQuery(input: PlaybackRequestQuery): PlaybackRequestQuery {
  return {
    strmPath: input.strmPath,
    strmContent: input.strmContent,
    strategy: input.strategy,
    api_key: input.api_key,
    apiKey: input.apiKey,
    MediaSourceId: input.MediaSourceId,
    UserId: input.UserId
  };
}
