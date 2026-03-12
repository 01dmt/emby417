import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import http from "node:http";
import https from "node:https";
import {
  AppConfig,
  PlaybackStrategy,
  findUser302Rule,
  getCacheExpirySecondsByCookie,
  resolveServerCookie
} from "../modules/config.js";
import { CacheEntry, LinkCache, makeDirectLinkCacheKey } from "../modules/cache.js";
import { RequestLogStore } from "../modules/logger.js";
import { P115Client } from "../modules/p115client.js";
import { FolderIdCache, MediaSourceCache } from "../modules/mediaCache.js";
import { PlaybackError, PlaybackErrorInfo, parseErrorCodeAndReason } from "../modules/playback_error.js";
import { parsePlaybackRequest } from "../modules/request_parser.js";
import { resolvePlaybackMedia } from "../modules/media_resolver.js";
import { resolveFinalPlaybackStrategy } from "../modules/pickcode_strategy.js";
import { resolveSourceDirectLink } from "../modules/p115_service.js";
import { resolveUserBySessionContext } from "../modules/session_checker.js";

export interface PlayDeps {
  getConfig: () => AppConfig;
  cache: LinkCache;
  mediaCache: MediaSourceCache;
  folderIdCache: FolderIdCache;
  logs: RequestLogStore;
  client: P115Client;
}

interface PlaybackGateState {
  done: Promise<void>;
  resolve: () => void;
  startedAt: number;
  ownerTraceId: string;
}

const playbackInFlight = new Map<string, PlaybackGateState>();

export async function registerPlayRoutes(app: FastifyInstance, deps: PlayDeps) {
  const handlePlayback = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    const query = request.query as {
      strmPath?: string;
      strmContent?: string;
      strategy?: PlaybackStrategy;
      api_key?: string;
      apiKey?: string;
      MediaSourceId?: string;
      UserId?: string;
    };

    const config = deps.getConfig();
    const started = Date.now();
    const parsedRequest = parsePlaybackRequest(request, query);
    const routePath = parsedRequest.routePath;
    const traceId = resolveTraceId();
    const timeline = createTimeline(started, traceId);
    timeline.mark("request", "request_enter", "ok", {
      route: routePath,
      request_url: request.url || "",
      user_agent: parsedRequest.requestUserAgent || ""
    });
    const normalizedHeaders = parsedRequest.normalizedHeaders;
    const gateKey = buildPlaybackGateKey({
      routePath,
      itemId: parsedRequest.itemId,
      mediaSourceId: parsedRequest.mediaSourceId,
      deviceId: String((query as Record<string, string | undefined>).DeviceId || normalizedHeaders["x-emby-device-id"] || ""),
      serverHint: normalizedHeaders["x-emby-target-server-id"] || normalizedHeaders["x-forwarded-port"] || ""
    });
    const gateLease = acquirePlaybackGate(gateKey, traceId);
    if (gateLease.owner) {
      timeline.mark("gate", "request_gate_owner", "ok", {
        gate_key: gateKey,
        gate_waiting_ms: "0"
      });
    } else {
      timeline.mark("gate", "request_gate_wait", "ok", {
        gate_key: gateKey,
        gate_owner_trace_id: gateLease.ownerTraceId
      });
      const waitedMs = Date.now() - gateLease.startedAt;
      const released = await waitForGateRelease(gateLease.done, 30000);
      timeline.mark("gate", "request_gate_resume", released ? "ok" : "skip", {
        gate_key: gateKey,
        gate_owner_trace_id: gateLease.ownerTraceId,
        gate_waiting_ms: String(waitedMs),
        reason: released ? "owner_done" : "wait_timeout"
      });
    }
    const playSessionId = extractPlaySessionId(request.url || "");
    const requestDeviceId = String((query as Record<string, string | undefined>).DeviceId || normalizedHeaders["x-emby-device-id"] || "");
    let requestUserId = parsedRequest.userId;
    let requestUserIdSource = requestUserId ? "请求头/参数" : "";
    let requestUserName = String(normalizedHeaders["x-emby-username"] || "").trim();
    let requestUserNameSource = requestUserName ? "请求头" : "";
    const canTrySessionFallback = Boolean(playSessionId || (parsedRequest.mediaSourceId && requestDeviceId));
    if ((!requestUserId || !requestUserName) && canTrySessionFallback) {
      const hintServer = resolveServerFromPort(config, normalizedHeaders["x-forwarded-port"] || "");
      const apiKeyCandidates = Array.from(new Set([
        String(hintServer.apiKey || "").trim(),
        String(query.api_key || "").trim(),
        String(query.apiKey || "").trim(),
        String(normalizedHeaders["x-emby-token"] || "").trim()
      ].filter((item) => item.length > 0)));
      let resolvedBySession = {
        userId: "",
        userName: "",
        matchedSessionId: "",
        totalSessions: 0,
        matchedBy: "",
        debug: {} as Record<string, string>
      };
      for (const key of apiKeyCandidates) {
        resolvedBySession = await resolveUserBySessionContext({
          server: hintServer,
          apiKey: key,
          playSessionId,
          mediaSourceId: parsedRequest.mediaSourceId,
          deviceId: requestDeviceId
        });
        if (resolvedBySession.userId) {
          break;
        }
      }
      if (resolvedBySession.userId) {
        if (!requestUserId) {
          requestUserId = resolvedBySession.userId;
          requestUserIdSource = resolvedBySession.matchedBy === "media_source_device"
            ? "Sessions(MediaSourceId+DeviceId)"
            : (resolvedBySession.matchedBy === "device_only"
              ? "Sessions(DeviceId)"
              : "Sessions(PlaySessionId)");
        }
        if (!requestUserName && resolvedBySession.userName) {
          requestUserName = resolvedBySession.userName;
          requestUserNameSource = requestUserIdSource;
        }
        timeline.mark("request", "request_userid_fallback", "ok", {
          play_session_id: playSessionId,
          media_source_id: parsedRequest.mediaSourceId,
          device_id: requestDeviceId,
          api_key_candidates: String(apiKeyCandidates.length),
          resolved_user_id: requestUserId,
          resolved_user_name: requestUserName,
          matched_by: resolvedBySession.matchedBy,
          matched_session_id: resolvedBySession.matchedSessionId,
          total_sessions: String(resolvedBySession.totalSessions),
          ...resolvedBySession.debug
        });
      } else {
        timeline.mark("request", "request_userid_fallback", "skip", {
          play_session_id: playSessionId,
          media_source_id: parsedRequest.mediaSourceId,
          device_id: requestDeviceId,
          api_key_candidates: String(apiKeyCandidates.length),
          reason: "sessions_not_matched",
          ...resolvedBySession.debug
        });
      }
    }
    let embyHint: { strmPath?: string; strmContent?: string; serverId?: string } | undefined;
    let matchedServerName = "";
    let transferDetail: Record<string, string> | undefined;
    let currentCookieName = "";
    let resolvedForLog:
      | {
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
      | undefined;
    const emitProcessLog = async (
      message: string,
      detail: Record<string, string>,
      status = 200,
      cached = false
    ) => {
      await appendLogSafe(deps.logs, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        trace_id: traceId,
        time: new Date().toISOString(),
        route: routePath,
        strategy: query.strategy ?? config.playback.defaultStrategy,
        cached,
        status,
        message,
        detail: {
          extracted: detail,
          trace_summary: {
            trace_id: traceId,
            stage_count: timeline.events().length,
            elapsed_ms: timeline.events().length ? timeline.events()[timeline.events().length - 1].sinceStartMs : 0
          },
          events: timeline.events()
        }
      });
    };

    try {
      await emitProcessLog(`拦截请求：${safeDecodeText(request.url || "")}`, {
        "请求url原文": safeDecodeText(request.url || "")
      });
      await emitProcessLog(`请求头：${JSON.stringify(normalizedHeaders)}`, {
        "请求头原文": JSON.stringify(normalizedHeaders)
      });

      timeline.mark("request", "request_params_extracted", "ok", {
        item_id: parsedRequest.itemId,
        media_source_id: parsedRequest.mediaSourceId,
        user_id: requestUserId,
        user_id_source: requestUserIdSource || "未提取",
        user_name: requestUserName,
        user_name_source: requestUserNameSource || "未提取",
        play_session_id: playSessionId
      });
      await emitProcessLog("提取的参数", {
        DeviceId: String((query as Record<string, string | undefined>).DeviceId || ""),
        ItemId: parsedRequest.itemId,
        "x-emby-source": String(normalizedHeaders["x-emby-source"] || ""),
        MediaSourceId: parsedRequest.mediaSourceId,
        PlaySessionId: playSessionId,
        api_key: String(query.api_key || query.apiKey || ""),
        "X-Emby-Token": String(normalizedHeaders["x-emby-token"] || ""),
        UserId: requestUserId,
        "UserId来源": requestUserIdSource || "未提取",
        UserName: requestUserName,
        "UserName来源": requestUserNameSource || "未提取"
      });
      timeline.mark("media_resolver", "media_resolver_start", "ok");
      const activeServer = resolveServerFromPort(config, normalizedHeaders["x-forwarded-port"] || "");
      const sourceCookie = resolveServerCookie(config, activeServer);
      const mediaResolved = await resolvePlaybackMedia({
        config,
        parsed: parsedRequest,
        cache: deps.mediaCache,
        client: deps.client,
        sourceCookie,
        pathPrefixRules: activeServer.pathPrefixRules || ""
      });
      embyHint = {
        strmPath: mediaResolved.strmPath,
        strmContent: mediaResolved.strmContent,
        serverId: mediaResolved.server.id
      };
      timeline.mark("media_resolver", "media_resolver_done", "ok", {
        source_guid: mediaResolved.sourceGuid,
        source_pickcode: mediaResolved.sourcePickcode,
        source_cache_hit: mediaResolved.cacheHit ? "1" : "0"
      });
      for (const item of mediaResolved.diagnostics) {
        timeline.mark(item.stage, item.event, item.status, item.data || {});
      }
      if (mediaResolved.cacheHit) {
        await emitProcessLog(`命中缓存：${mediaResolved.mediaSourceId}（缓存命名以MediaSourceId命名。）`, {
          MediaSourceId: mediaResolved.mediaSourceId,
          "Emby源文件": mediaResolved.sourceText
        }, 200, true);
      } else {
        await emitProcessLog(`向Emby确定源文件：${safeDecodeText(request.url || "")}`, {
          "请求url": safeDecodeText(request.url || ""),
          "Emby源文件": mediaResolved.sourceText,
          "已缓存": mediaResolved.mediaSourceId
        });
      }
      const matchedServer = mediaResolved.server;
      matchedServerName = matchedServer.name;
      currentCookieName = matchedServer.p115CookieName || config.p115.activeCookieName;
      const expectedUserRule = findUser302Rule(config, requestUserId);

      timeline.mark("p115", "direct_link_resolve_start", "ok");
      const directCacheLookup = mediaResolved.cacheHit && config.cache.enabled
        ? findDirectCacheHitByPathVariants({
          cache: deps.cache,
          userAgent: parsedRequest.requestUserAgent,
          userId: requestUserId,
          mediaSourceId: mediaResolved.mediaSourceId,
          pathCandidates: [
            mediaResolved.sourceText,
            mediaResolved.strmContent,
            mediaResolved.strmPath
          ]
        })
        : undefined;
      let reusableDirectCache = directCacheLookup && isSafeRedirectUrl(directCacheLookup.entry.url)
        ? directCacheLookup
        : undefined;
      if (reusableDirectCache && expectedUserRule) {
        const cachedFinalCookieName = String(reusableDirectCache.entry.headers?.["x-final-cookie-name"] || "").trim();
        if (cachedFinalCookieName !== expectedUserRule.targetCookieName) {
          timeline.mark("cache", "direct_cache_cookie_mismatch", "skip", {
            expected_cookie_name: expectedUserRule.targetCookieName,
            cached_cookie_name: cachedFinalCookieName
          });
          reusableDirectCache = undefined;
        }
      }
      const sourcePickcode = mediaResolved.sourcePickcode || "";
      const requestCacheHeaders = normalizePlaybackCacheHeaders(normalizedHeaders);
      const resolved = reusableDirectCache
        ? {
          strategy: query.strategy ?? config.playback.defaultStrategy,
          directUrl: reusableDirectCache.entry.url,
          cached: true,
          cacheKey: reusableDirectCache.key,
          sourceText: mediaResolved.sourceText,
          sourcePickcode: reusableDirectCache.entry.pickcode || mediaResolved.sourcePickcode,
          cacheSourcePath: reusableDirectCache.entry.sourcePath,
          cacheCreatedAt: reusableDirectCache.entry.createdAt,
          cacheHeaders: reusableDirectCache.entry.headers
        }
        : sourcePickcode
          ? {
            strategy: query.strategy ?? config.playback.defaultStrategy,
            directUrl: "",
            cached: false,
            cacheKey: makeDirectLinkCacheKey({
              path: mediaResolved.sourceText,
              userAgent: parsedRequest.requestUserAgent,
              userId: requestUserId,
              mediaSourceId: mediaResolved.mediaSourceId
            }),
            sourceText: mediaResolved.sourceText,
            sourcePickcode: sourcePickcode,
            cacheSourcePath: mediaResolved.sourceText,
            cacheCreatedAt: "",
            cacheHeaders: requestCacheHeaders
          }
        : await resolveSourceDirectLink({
          config,
          cache: deps.cache,
          client: deps.client,
          sourceText: mediaResolved.sourceText,
          sourceCookie,
          requestHeaders: normalizedHeaders,
          requestUserAgent: parsedRequest.requestUserAgent,
          requestUserId: requestUserId,
          requestMediaSourceId: mediaResolved.mediaSourceId,
          pathPrefixRules: matchedServer.pathPrefixRules || "",
          forceStrategy: query.strategy
        });
      timeline.mark(
        "p115",
        "direct_link_resolve_done",
        "ok",
        {
          cache_hit: resolved.cached ? "1" : "0",
          cache_no: makeCacheNo(resolved.cacheKey),
          source_pickcode: resolved.sourcePickcode,
          cache_source: reusableDirectCache ? "media_hit_shortcut" : (sourcePickcode ? "pickcode_only" : "default")
        }
      );
      if (reusableDirectCache) {
        await emitProcessLog(`使用缓存的重定向URL:${reusableDirectCache.entry.url}`, {
          "重定向URL": reusableDirectCache.entry.url,
          "缓存键": makeCacheNo(resolved.cacheKey)
        }, 200, true);
      } else {
        await emitProcessLog("缓存不存在或已过期：重新获取重定向URL", {
          "缓存键": makeCacheNo(resolved.cacheKey)
        });
      }

      let finalDirectUrl = resolved.directUrl;
      let effectiveResolved = {
        ...resolved,
        sourceText: mediaResolved.sourceText,
        sourcePickcode: mediaResolved.sourcePickcode || resolved.sourcePickcode
      };
      resolvedForLog = effectiveResolved;
      const strategySourcePickcode = mediaResolved.sourcePickcode || resolved.sourcePickcode;
      if (reusableDirectCache) {
        timeline.mark("strategy", "strategy_judgement_skip", "skip", {
          reason: "media_cache_hit_direct_cache_reuse"
        });
        await emitProcessLog("播放策略：直接播放", {
          "播放策略": "直接播放",
          "重定向URL": finalDirectUrl
        }, 200, true);
      } else if (strategySourcePickcode) {
        timeline.mark("strategy", "strategy_judgement_start", "ok", {
          source_pickcode: strategySourcePickcode
        });
        const strategyResult = await resolveFinalPlaybackStrategy({
          config,
          server: matchedServer,
          requestUserId: requestUserId,
          requestUserAgent: parsedRequest.requestUserAgent,
          requestApiKey: parsedRequest.apiKey,
          requestItemId: parsedRequest.itemId,
          requestMediaSourceId: mediaResolved.mediaSourceId,
          requestPlaySessionId: playSessionId,
          sourcePickcode: strategySourcePickcode,
          sourceCookie,
          sourceCookieName: matchedServer.p115CookieName || config.p115.activeCookieName,
          sourcePath: mediaResolved.sourceText,
          client: deps.client,
          pathPrefixRules: matchedServer.pathPrefixRules || "",
          folderIdCache: deps.folderIdCache
        });
        transferDetail = strategyResult.transferDetail;
        timeline.mark("strategy", "strategy_judgement_done", "ok", {
          strategy_trail: strategyResult.strategyTrail.join(" -> ") || "direct"
        });
        for (const item of strategyResult.diagnostics) {
          timeline.mark(item.stage, item.event, item.status, item.data || {});
        }
        if (strategyResult.directUrl && isSafeRedirectUrl(strategyResult.directUrl)) {
          finalDirectUrl = strategyResult.directUrl;
        }
        currentCookieName = strategyResult.finalCookieName;
        effectiveResolved = {
          ...effectiveResolved,
          sourcePickcode: strategyResult.finalPickcode || effectiveResolved.sourcePickcode,
          cached: resolved.cached,
          cacheKey: resolved.cacheKey,
          cacheCreatedAt: new Date().toISOString(),
          cacheHeaders: {
            ...resolved.cacheHeaders,
            "x-final-cookie-name": strategyResult.finalCookieName,
            "x-strategy-trail": strategyResult.strategyTrail.join("|")
          }
        };
        resolvedForLog = effectiveResolved;

        const trail = strategyResult.strategyTrail.join("|");
        if (trail.includes("same-play:")) {
          await emitProcessLog("播放策略：同播复制", {
            "播放策略": "同播复制"
          });
          await emitProcessLog("复制同播：检测到复制同播，开始执行复制", {
            "策略链": trail
          });
          if (transferDetail?.targetPickcode) {
            await emitProcessLog(`复制成功，文件名：${transferDetail.fileName || ""}, ${transferDetail.targetPickcode}`, {
              "新文件名": transferDetail.fileName || "",
              "请求目标文件名": transferDetail.fileNameRequested || "",
              "秒传返回文件名": transferDetail.fileNameReturned || "",
              pickcode: transferDetail.targetPickcode
            });
          }
          await emitProcessLog(`重定向URL: ${finalDirectUrl}`, {
            "重定向URL": finalDirectUrl
          });
        } else if (trail.includes("user302:")) {
          await emitProcessLog("播放策略：指定用户秒传", {
            "播放策略": "指定用户秒传"
          });
      await emitProcessLog(`115秒传# 开始秒传：${transferDetail?.sourceCookieName || ""} =》 ${transferDetail?.targetCookieName || ""}`, {
        "源账号": transferDetail?.sourceCookieName || "",
        "目标账号": transferDetail?.targetCookieName || "",
        "源账号id": transferDetail?.sourceUid || "",
        "目标账号id": transferDetail?.targetUid || ""
      });
          await emitProcessLog(`115秒传#  文件信息: ${transferDetail?.fileName || ""}, 大小: ${transferDetail?.fileSize || "0"}, SHA1: ${transferDetail?.fileSha1 || ""}`, {
            "原文件名": transferDetail?.fileName || "",
            "大小": transferDetail?.fileSize || "0",
            SHA1: transferDetail?.fileSha1 || ""
          });
          if (transferDetail?.rangeVerified === "1") {
            await emitProcessLog("115秒传#  📋 文件大于等于1MB，使用range验证秒传...", {
              "range验证": "已触发"
            });
          }
          await emitProcessLog(`115秒传#  秒传成功: ${transferDetail?.fileName || ""}${transferDetail?.targetPickcode || ""}`, {
            "新文件名": transferDetail?.fileName || "",
            "请求目标文件名": transferDetail?.fileNameRequested || "",
            "秒传返回文件名": transferDetail?.fileNameReturned || "",
            pickcode: transferDetail?.targetPickcode || ""
          });
          await emitProcessLog(`重定向URL: ${finalDirectUrl}`, {
            "重定向URL": finalDirectUrl
          });
        } else if (trail.includes("anti-risk:")) {
          await emitProcessLog("播放策略：防风控秒传", {
            "播放策略": "防风控秒传"
          });
      await emitProcessLog(`115秒传# 开始秒传：${transferDetail?.sourceCookieName || ""} =》 ${transferDetail?.targetCookieName || ""}`, {
        "源账号": transferDetail?.sourceCookieName || "",
        "目标账号": transferDetail?.targetCookieName || "",
        "源账号id": transferDetail?.sourceUid || "",
        "目标账号id": transferDetail?.targetUid || ""
      });
          await emitProcessLog(`115秒传#  文件信息: ${transferDetail?.fileName || ""}, 大小: ${transferDetail?.fileSize || "0"}, SHA1: ${transferDetail?.fileSha1 || ""}`, {
            "原文件名": transferDetail?.fileName || "",
            "大小": transferDetail?.fileSize || "0",
            SHA1: transferDetail?.fileSha1 || ""
          });
          if (transferDetail?.rangeVerified === "1") {
            await emitProcessLog("115秒传#  📋 文件大于等于1MB，使用range验证秒传...", {
              "range验证": "已触发"
            });
          }
          await emitProcessLog(`115秒传#  秒传成功: ${transferDetail?.fileName || ""}${transferDetail?.targetPickcode || ""}`, {
            "新文件名": transferDetail?.fileName || "",
            "请求目标文件名": transferDetail?.fileNameRequested || "",
            "秒传返回文件名": transferDetail?.fileNameReturned || "",
            pickcode: transferDetail?.targetPickcode || ""
          });
          await emitProcessLog(`重定向URL: ${finalDirectUrl}`, {
            "重定向URL": finalDirectUrl
          });
        } else {
          await emitProcessLog("播放策略：直接播放", {
            "播放策略": "直接播放",
            "重定向URL": finalDirectUrl
          });
        }
      } else {
        if (expectedUserRule) {
          throw new Error("指定用户秒传失败：源文件缺少Pickcode，无法按策略获取目标直链");
        }
        timeline.mark("strategy", "strategy_judgement_skip", "skip", {
          reason: "source_pickcode_empty"
        });
        await emitProcessLog("播放策略：直接播放", {
          "播放策略": "直接播放",
          "重定向URL": finalDirectUrl
        });
      }

      if (effectiveResolved.strategy === "prefer302") {
        if (config.playback.allowProxy && isSafeRedirectUrl(finalDirectUrl)) {
          const upstreamHeaders = buildUpstreamHeaders(request.headers, config);
          const upstream = await openProxyStream(finalDirectUrl, request.method, upstreamHeaders);

          if (upstream.statusCode >= 400) {
            const upstreamText = await readNodeResponseText(upstream.response);
            throw new Error(`proxy playback failed ${upstream.statusCode}: ${upstreamText.slice(0, 300)}`);
          }

          timeline.mark("response", "final_response_summary", "ok", {
            mode: "proxy",
            status: String(upstream.statusCode),
            cache_no: makeCacheNo(effectiveResolved.cacheKey),
            trace_id: traceId
          });
          await appendLogSafe(deps.logs, {
            id: `${started}-${Math.random().toString(36).slice(2)}`,
            trace_id: traceId,
            time: new Date().toISOString(),
            route: routePath,
            strategy: effectiveResolved.strategy,
            cached: effectiveResolved.cached,
            status: upstream.statusCode,
            message: "代理播放成功",
            detail: buildLogDetail({
              request,
              query: { ...query, UserId: requestUserId || query.UserId },
              resolved: effectiveResolved,
              embyHint,
              matchedServerName,
              transferDetail,
              headers: normalizedHeaders,
              directUrl: finalDirectUrl,
              traceId,
              events: timeline.events()
            })
          });

          reply.hijack();
          reply.raw.statusCode = upstream.statusCode;
          for (const [key, value] of Object.entries(upstream.response.headers)) {
            if (isHopByHopHeader(key)) {
              continue;
            }
            if (typeof value === "undefined") {
              continue;
            }
            reply.raw.setHeader(key, value);
          }

          if (request.method === "HEAD") {
            upstream.response.resume();
            reply.raw.end();
            return;
          }

          upstream.response.on("error", () => {
            reply.raw.destroy();
          });
          upstream.response.pipe(reply.raw);
          return;
        }

        if (!reusableDirectCache && isSafeRedirectUrl(finalDirectUrl)) {
          const cacheTtlSeconds = getCacheExpirySecondsByCookie(config, sourceCookie);
          deps.cache.set(effectiveResolved.cacheKey, {
            url: finalDirectUrl,
            sourcePath: effectiveResolved.sourceText,
            mediaSourceId: mediaResolved.mediaSourceId,
            headers: {
              ...requestCacheHeaders,
              ...effectiveResolved.cacheHeaders,
              "x-final-cookie-name": String(effectiveResolved.cacheHeaders?.["x-final-cookie-name"] || ""),
              "x-strategy-trail": String(effectiveResolved.cacheHeaders?.["x-strategy-trail"] || "")
            },
            pickcode: effectiveResolved.sourcePickcode,
            userId: requestUserId
          }, cacheTtlSeconds);
          timeline.mark("cache", "direct_cache_store", "ok", {
            cache_no: makeCacheNo(effectiveResolved.cacheKey),
            reason: "post_strategy_success",
            ttl_seconds: String(cacheTtlSeconds)
          });
        }
        timeline.mark("response", "final_response_summary", "ok", {
          mode: "302",
          status: "302",
          cache_no: makeCacheNo(effectiveResolved.cacheKey),
          trace_id: traceId
        });
        await appendLogSafe(deps.logs, {
          id: `${started}-${Math.random().toString(36).slice(2)}`,
          trace_id: traceId,
          time: new Date().toISOString(),
          route: routePath,
          strategy: effectiveResolved.strategy,
          cached: effectiveResolved.cached,
          status: 302,
          message: "302重定向成功",
          detail: buildLogDetail({
            request,
            query: { ...query, UserId: requestUserId || query.UserId },
            resolved: effectiveResolved,
            embyHint,
            matchedServerName,
            transferDetail,
            headers: normalizedHeaders,
            directUrl: finalDirectUrl,
            traceId,
            events: timeline.events()
          })
        });
        reply.redirect(302, finalDirectUrl);
        return;
      }

      timeline.mark("response", "final_response_summary", "error", {
        mode: "direct_link_required",
        status: "503",
        trace_id: traceId
      });
      await appendLogSafe(deps.logs, {
        id: `${started}-${Math.random().toString(36).slice(2)}`,
        trace_id: traceId,
        time: new Date().toISOString(),
        route: routePath,
        strategy: effectiveResolved.strategy,
        cached: effectiveResolved.cached,
        status: 503,
        message: "未获得可用直链，禁止兜底播放",
        detail: buildLogDetail({
          request,
          query: { ...query, UserId: requestUserId || query.UserId },
          resolved: effectiveResolved,
          embyHint,
          matchedServerName,
          transferDetail,
          headers: normalizedHeaders,
          traceId,
          events: timeline.events()
        })
      });
      reply.status(503).send({
        error: "direct-link required; fallback playback is forbidden"
      });
      return;
    } catch (error) {
      const errorInfo = resolvePlaybackErrorInfo({
        error,
        embyHint,
        transferDetail,
        currentCookieName
      });
      const errorMessage = errorInfo?.userMessage || (error instanceof Error ? error.message : "播放失败");
      timeline.mark("response", "final_response_summary", "error", {
        mode: "error",
        status: "500",
        error: errorMessage,
        trace_id: traceId
      });
      await appendLogSafe(deps.logs, {
        id: `${started}-${Math.random().toString(36).slice(2)}`,
        trace_id: traceId,
        time: new Date().toISOString(),
        route: routePath,
        strategy: query.strategy ?? config.playback.defaultStrategy,
        cached: false,
        status: 500,
        message: errorMessage,
        detail: buildLogDetail({
          request,
          query: { ...query, UserId: requestUserId || query.UserId },
          resolved: resolvedForLog,
          embyHint,
          matchedServerName,
          transferDetail,
          headers: normalizedHeaders,
          traceId,
          events: timeline.events(),
          errorInfo
        })
      });
      reply.status(500).send({
        error: errorMessage
      });
      await emitProcessLog(`处理失败：${errorMessage}`, {
        "报错原因": errorMessage,
        "失败步骤": errorInfo?.step || "",
        "失败账号": errorInfo?.accountName || "",
        "错误代码": errorInfo?.errorCode || "",
        "错误原因": errorInfo?.errorReason || ""
      }, 500);
    } finally {
      gateLease.release();
    }
  };

  app.get("/play", handlePlayback);
  app.get("/emby/videos/*", handlePlayback);
  app.get("/emby/Videos/*", handlePlayback);
}

function acquirePlaybackGate(key: string, traceId: string): {
  owner: boolean;
  done: Promise<void>;
  release: () => void;
  startedAt: number;
  ownerTraceId: string;
} {
  const existing = playbackInFlight.get(key);
  if (existing) {
    return {
      owner: false,
      done: existing.done,
      release: () => {},
      startedAt: existing.startedAt,
      ownerTraceId: existing.ownerTraceId
    };
  }
  let resolve = () => {};
  const done = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  const state: PlaybackGateState = {
    done,
    resolve,
    startedAt: Date.now(),
    ownerTraceId: traceId
  };
  playbackInFlight.set(key, state);
  return {
    owner: true,
    done: state.done,
    startedAt: state.startedAt,
    ownerTraceId: state.ownerTraceId,
    release: () => {
      const current = playbackInFlight.get(key);
      if (current !== state) {
        return;
      }
      playbackInFlight.delete(key);
      state.resolve();
    }
  };
}

async function waitForGateRelease(done: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const released = await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
    return released;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function buildPlaybackGateKey(params: {
  routePath: string;
  itemId: string;
  mediaSourceId: string;
  deviceId: string;
  serverHint: string;
}): string {
  return [
    `route=${String(params.routePath || "").trim()}`,
    `item=${String(params.itemId || "").trim()}`,
    `msid=${String(params.mediaSourceId || "").trim()}`,
    `did=${String(params.deviceId || "").trim().toLowerCase()}`,
    `server=${String(params.serverHint || "").trim()}`
  ].join("|");
}

function normalizePlaybackCacheHeaders(
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

async function appendLogSafe(
  logs: RequestLogStore,
  entry: Parameters<RequestLogStore["append"]>[0]
) {
  try {
    await logs.append(entry);
  } catch (_error) {
    // Keep playback path resilient when log persistence fails.
  }
}

function buildLogDetail(params: {
  request: FastifyRequest;
  query: {
    strmPath?: string;
    strmContent?: string;
    strategy?: PlaybackStrategy;
    api_key?: string;
    apiKey?: string;
    UserId?: string;
  };
  resolved:
    | {
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
    | undefined;
  embyHint: { strmPath?: string; strmContent?: string; serverId?: string } | undefined;
  matchedServerName?: string;
  transferDetail?: Record<string, string>;
  headers: Record<string, string | undefined>;
  directUrl?: string;
  traceId: string;
  errorInfo?: PlaybackErrorInfo;
  events?: Array<{
    trace_id: string;
    stage: string;
    event: string;
    status: "ok" | "skip" | "error";
    label: string;
    at: string;
    clock: string;
    sinceStartMs: number;
    data?: Record<string, string>;
  }>;
}): {
  requestRaw: string;
  headers: Record<string, string>;
  extracted: Record<string, string>;
  embySource: string;
  directUrl: string;
  cacheKey: string;
  cacheNo: string;
  cacheSource: string;
  cacheCreatedAt: string;
  cacheHeaders: Record<string, string>;
  errorInfo?: PlaybackErrorInfo;
  trace_summary: { trace_id: string; stage_count: number; elapsed_ms: number };
  events: Array<{
    trace_id: string;
    stage: string;
    event: string;
    status: "ok" | "skip" | "error";
    label: string;
    at: string;
    clock: string;
    sinceStartMs: number;
    data?: Record<string, string>;
  }>;
} {
  const { request, query, resolved, embyHint, matchedServerName, transferDetail, headers, directUrl, traceId, errorInfo, events } = params;
  const requestRaw = safeDecodeText(request.url || "");
  const itemId = extractItemIdFromPath(request.url || "") || "";
  const mediaSourceId = extractMediaSourceIdFromUrl(request.url || "") || "";
  const apiToken = query.api_key || query.apiKey || headers["x-emby-token"] || "";
  const extracted: Record<string, string> = {
    "播放策略": resolved?.strategy || query.strategy || "",
    "匹配服务器": matchedServerName || "",
    "提取ItemId": itemId,
    "提取MediaSourceId": mediaSourceId,
    "请求APIKey": apiToken,
    "提取UserId": resolvePlaybackUserId(query, headers),
    "strmPath": query.strmPath || embyHint?.strmPath || "",
    "strmContent": query.strmContent || embyHint?.strmContent || "",
    "源文件Pickcode": resolved?.sourcePickcode || transferDetail?.sourcePickcode || "",
    "最终源内容": resolved?.sourceText || ""
  };
  if (transferDetail) {
      extracted["用户302规则"] = transferDetail.ruleName || transferDetail.ruleId || "";
      extracted["秒传源账号"] = transferDetail.sourceCookieName || "";
      extracted["秒传目标账号"] = transferDetail.targetCookieName || "";
      extracted["秒传目标目录"] = transferDetail.targetPath || "";
      extracted["秒传目标Pickcode"] = transferDetail.targetPickcode || "";
  }
  if (errorInfo) {
    extracted["失败步骤"] = errorInfo.step || "";
    extracted["失败账号"] = errorInfo.accountName || "";
    extracted["错误代码"] = errorInfo.errorCode || "";
    extracted["错误原因"] = errorInfo.errorReason || "";
    extracted["错误摘要"] = errorInfo.userMessage || "";
    if (Array.isArray(errorInfo.attempts) && errorInfo.attempts.length > 0) {
      extracted["失败账号明细"] = errorInfo.attempts
        .map((item) => {
          const codeSuffix = item.errorCode ? `（${item.errorCode}）` : "";
          return `${item.accountName || "未知账号"}: ${item.errorReason || "未知错误"}${codeSuffix}`;
        })
        .join("；");
    }
  }

  const headerSnapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string" && value.trim()) {
      headerSnapshot[key] = value;
    }
  }

  const cacheKey = resolved?.cacheKey || "";
  const cacheNo = cacheKey ? makeCacheNo(cacheKey) : "";

  return {
    requestRaw,
    headers: headerSnapshot,
    extracted,
    embySource: resolved?.sourceText || embyHint?.strmContent || embyHint?.strmPath || "",
    directUrl: directUrl || resolved?.directUrl || "",
    cacheKey,
    cacheNo,
    cacheSource: resolved?.cacheSourcePath || "",
    cacheCreatedAt: resolved?.cacheCreatedAt || "",
    cacheHeaders: resolved?.cacheHeaders || {},
    errorInfo,
    trace_summary: {
      trace_id: traceId,
      stage_count: events?.length || 0,
      elapsed_ms: events && events.length ? events[events.length - 1].sinceStartMs : 0
    },
    events: events || []
  };
}

function createTimeline(started: number, traceId: string) {
  const entries: Array<{
    trace_id: string;
    stage: string;
    event: string;
    status: "ok" | "skip" | "error";
    label: string;
    at: string;
    clock: string;
    sinceStartMs: number;
    data?: Record<string, string>;
  }> = [];
  const lastFingerprintByLabel = new Map<string, string>();
  return {
    mark(
      stage: string,
      event: string,
      status: "ok" | "skip" | "error",
      data?: Record<string, string>
    ) {
      const now = Date.now();
      const label = `${stage}:${event}`;
      const fingerprint = `${status}\u0000${stableRecordFingerprint(data)}`;
      const previousFingerprint = lastFingerprintByLabel.get(label);
      if (previousFingerprint === fingerprint) {
        return;
      }
      lastFingerprintByLabel.set(label, fingerprint);
      entries.push({
        trace_id: traceId,
        stage,
        event,
        status,
        label,
        at: new Date(now).toISOString(),
        clock: formatClock(now),
        sinceStartMs: now - started,
        data
      });
    },
    events() {
      return entries.slice();
    }
  };
}

function stableRecordFingerprint(data?: Record<string, string>): string {
  if (!data) {
    return "";
  }
  const keys = Object.keys(data).sort();
  const pairs: string[] = [];
  for (const key of keys) {
    pairs.push(`${key}=${data[key]}`);
  }
  return pairs.join("&");
}

function formatClock(time: number): string {
  const date = new Date(time);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss},${ms}`;
}

function makeCacheNo(cacheKey: string): string {
  let hash = 2166136261;
  for (let index = 0; index < cacheKey.length; index += 1) {
    hash ^= cacheKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return `CK-${unsigned.toString(16).padStart(8, "0")}`;
}

function resolveTraceId(): string {
  return nextDailyTraceId();
}

let traceDate = "";
let traceSeq = 0;

function nextDailyTraceId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const today = `${year}${month}${day}`;
  if (traceDate !== today) {
    traceDate = today;
    traceSeq = 0;
  }
  traceSeq += 1;
  return `${today}-${String(traceSeq).padStart(4, "0")}`;
}

function extractPlaySessionId(requestUrl: string): string {
  const queryText = requestUrl.split("?")[1] || "";
  const params = new URLSearchParams(queryText);
  const keys = ["PlaySessionId", "playSessionId", "playsessionid"];
  for (const key of keys) {
    const value = (params.get(key) || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function safeDecodeText(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch (_error) {
    return text;
  }
}

function extractItemIdFromPath(pathname: string): string | null {
  const matched = pathname.match(/\/emby\/[Vv]ideos\/([^/?]+)/);
  return matched ? matched[1] : null;
}

function extractMediaSourceIdFromUrl(rawUrl: string): string | undefined {
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

function resolvePlaybackUserId(
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

function extractUserIdFromAuthHeader(value: string | undefined): string {
  if (!value || typeof value !== "string") {
    return "";
  }
  const match = value.match(/UserId\s*=\s*"?([0-9a-fA-F-]{8,})"?/i);
  return match && match[1] ? match[1].trim() : "";
}

function isSafeRedirectUrl(value: string): boolean {
  const text = String(value || "").trim();
  if (!text || text.length > 2048) {
    return false;
  }
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    if (url.username || url.password) {
      return false;
    }
    return Boolean(url.hostname);
  } catch (_error) {
    return false;
  }
}

function buildUpstreamHeaders(
  headers: Record<string, string | string[] | undefined>,
  config: AppConfig
): Record<string, string> {
  const result: Record<string, string> = {};
  result["accept-encoding"] = "identity";
  const rangeValue = headers.range;
  if (typeof rangeValue === "string" && rangeValue.trim()) {
    result.range = rangeValue;
  }
  const requestUserAgent = extractHeaderValue(headers["user-agent"]);
  if (requestUserAgent && requestUserAgent.trim()) {
    result["user-agent"] = requestUserAgent.trim();
  } else if (config.p115.userAgent.trim()) {
    result["user-agent"] = config.p115.userAgent.trim();
  }
  const extra = parseExtraHeaders(config.p115.extraHeaders);
  for (const [key, value] of Object.entries(extra)) {
    if (!(key in result)) {
      result[key] = value;
    }
  }
  return result;
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

function normalizeHeaderMap(
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

function extractHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return undefined;
}

function parseExtraHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const text = line.trim();
    if (!text || !text.includes(":")) {
      continue;
    }
    const [key, ...rest] = text.split(":");
    const value = rest.join(":").trim();
    const header = key.trim().toLowerCase();
    if (!header || !value) {
      continue;
    }
    out[header] = value;
  }
  return out;
}

async function openProxyStream(
  targetUrl: string,
  method: string,
  headers: Record<string, string>
): Promise<{ statusCode: number; response: http.IncomingMessage }> {
  const url = new URL(targetUrl);
  const client = url.protocol === "https:" ? https : http;

  return await new Promise((resolve, reject) => {
    const req = client.request(url, {
      method,
      headers
    }, (response) => {
      resolve({
        statusCode: response.statusCode || 502,
        response
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.end();
  });
}

async function readNodeResponseText(response: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function findDirectCacheHitByPathVariants(params: {
  cache: LinkCache;
  userAgent: string;
  userId: string;
  mediaSourceId: string;
  pathCandidates: Array<string | undefined>;
}): { key: string; path: string; entry: CacheEntry } | undefined {
  const seen = new Set<string>();
  for (const rawPath of params.pathCandidates) {
    const path = String(rawPath || "").trim();
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    const key = makeDirectLinkCacheKey({
      path,
      userAgent: params.userAgent,
      userId: params.userId,
      mediaSourceId: params.mediaSourceId
    });
    const entry = params.cache.get(key);
    if (entry) {
      return { key, path, entry };
    }
  }
  return undefined;
}

function resolvePlaybackErrorInfo(params: {
  error: unknown;
  embyHint?: { strmPath?: string; strmContent?: string; serverId?: string };
  transferDetail?: Record<string, string>;
  currentCookieName?: string;
}): PlaybackErrorInfo | undefined {
  if (params.error instanceof PlaybackError) {
    return params.error.info;
  }

  const message = params.error instanceof Error
    ? params.error.message
    : String(params.error || "").trim();
  if (!message) {
    return undefined;
  }

  if (message.includes("cannot resolve media source text from request")) {
    return {
      step: "emby_path",
      errorCode: "EMBY_PATH_MISSING",
      errorReason: "PlaybackInfo/ItemInfo 未返回可用 Path",
      userMessage: "无法获取Emby path信息",
      details: {
        serverId: params.embyHint?.serverId || "",
        strmPath: params.embyHint?.strmPath || "",
        hasStrmContent: params.embyHint?.strmContent ? "1" : "0"
      }
    };
  }

  if (message.includes("p115 bridge fetch failed") || message.includes("p115client error")) {
    const parsed = parseErrorCodeAndReason(message);
    const accountName =
      params.transferDetail?.targetCookieName
      || params.transferDetail?.sourceCookieName
      || params.currentCookieName
      || "";
    return {
      step: "direct_link",
      accountName,
      errorCode: parsed.errorCode || "DIRECT_LINK_FAILED",
      errorReason: parsed.errorReason || "无法获取直链",
      userMessage: formatDirectLinkFailureMessage(accountName, parsed.errorCode, parsed.errorReason || "无法获取直链")
    };
  }

  if (message.startsWith("proxy playback failed")) {
    const parsed = parseErrorCodeAndReason(message);
    const accountName =
      params.transferDetail?.targetCookieName
      || params.transferDetail?.sourceCookieName
      || params.currentCookieName
      || "";
    const reason = parsed.errorReason || message;
    return {
      step: "proxy_playback",
      accountName,
      errorCode: parsed.errorCode || "PROXY_PLAYBACK_FAILED",
      errorReason: reason,
      userMessage: accountName
        ? `账号【${accountName}】代理播放失败：${reason}${parsed.errorCode ? `（${parsed.errorCode}）` : ""}`
        : `代理播放失败：${reason}${parsed.errorCode ? `（${parsed.errorCode}）` : ""}`
    };
  }

  return undefined;
}

function formatDirectLinkFailureMessage(accountName: string, errorCode: string, errorReason: string): string {
  const accountLabel = accountName ? `账号【${accountName}】` : "当前账号";
  const codeSuffix = errorCode ? `，错误代码：${errorCode}` : "";
  return `${accountLabel}无法获取直链${codeSuffix}，原因：${errorReason}`;
}

function resolveServerFromPort(config: AppConfig, forwardedPort: string): {
  id: string;
  name: string;
  serverUrl: string;
  apiKey: string;
  p115CookieName: string;
  antiRiskCookieNames: string[];
  customPickcodeRegex: string;
  p115Cookie: string;
  enabled: boolean;
  reverseProxyPorts: string[];
  pathPrefixRules: string;
} {
  const port = String(forwardedPort || "").trim();
  if (port) {
    const byPort = config.emby.servers.find((server) => {
      return server.enabled && Array.isArray(server.reverseProxyPorts) && server.reverseProxyPorts.includes(port);
    });
    if (byPort) {
      return byPort;
    }
  }
  const enabled = config.emby.servers.find((server) => server.enabled);
  if (enabled) {
    return enabled;
  }
  return config.emby.servers[0];
}
