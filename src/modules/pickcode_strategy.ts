import { AppConfig, EmbyServerProfile, findUser302Rule } from "./config.js";
import { runFastTransferByPickcode } from "./fastTransfer.js";
import { FolderIdCache } from "./mediaCache.js";
import { P115Client } from "./p115client.js";
import { PlaybackError, PlaybackErrorAttempt, parseErrorCodeAndReason } from "./playback_error.js";
import { checkMediaOccupied } from "./session_checker.js";
import { resolvePickcodeDirectLink } from "./p115_service.js";

export interface StrategyInput {
  config: AppConfig;
  server: EmbyServerProfile;
  requestUserId: string;
  requestUserAgent: string;
  requestApiKey: string;
  requestItemId: string;
  requestMediaSourceId: string;
  requestPlaySessionId: string;
  sourcePickcode: string;
  sourceCookie: string;
  sourceCookieName: string;
  sourcePath: string;
  client: P115Client;
  pathPrefixRules: string;
  folderIdCache: FolderIdCache;
}

export interface StrategyResult {
  finalPickcode: string;
  finalCookie: string;
  finalCookieName: string;
  directUrl: string;
  strategyTrail: string[];
  transferDetail?: Record<string, string>;
  diagnostics: Array<{
    stage: string;
    event: string;
    status: "ok" | "skip" | "error";
    data?: Record<string, string>;
  }>;
}

const recentTargetFileNames = new Map<string, number>();
const targetNameKeepMs = 24 * 60 * 60 * 1000;

export async function resolveFinalPlaybackStrategy(input: StrategyInput): Promise<StrategyResult> {
  const strategyTrail: string[] = [];
  const diagnostics: StrategyResult["diagnostics"] = [];
  let finalPickcode = input.sourcePickcode;
  let finalCookie = input.sourceCookie;
  let finalCookieName = input.sourceCookieName;
  let transferDetail: Record<string, string> | undefined;

  const userRule = findUser302Rule(input.config, input.requestUserId);
  diagnostics.push({
    stage: "strategy",
    event: "user302_rule_match",
    status: userRule ? "ok" : "skip",
    data: {
      emby_user_id: input.requestUserId,
      rule_id: userRule?.id || ""
    }
  });
  if (userRule && finalPickcode) {
    strategyTrail.push(`user302:${userRule.name || userRule.id}`);
    const targetProfile = input.config.p115.cookieProfiles.find((item) => item.name === userRule.targetCookieName);
    const targetCookie = (targetProfile?.cookies || "").trim();
    if (!targetCookie) {
      diagnostics.push({
        stage: "transfer",
        event: "user302_transfer",
        status: "error",
        data: {
          target_cookie_name: userRule.targetCookieName,
          error: "target_cookie_missing"
        }
      });
      throw new PlaybackError({
        step: "fast_transfer",
        accountName: userRule.targetCookieName,
        errorCode: "COOKIE_MISSING",
        errorReason: "未配置Cookie",
        userMessage: `指定用户秒传失败：账号【${userRule.targetCookieName}】未配置Cookie`
      });
    }
    const targetFileName = createUniqueTransferTargetFileName(input.sourcePath);
    const transfer = await runFastTransferByPickcode({
      sourceCookie: input.sourceCookie,
      sourcePickcode: finalPickcode,
      targetCookie,
      targetPath: userRule.targetPath || "/sha1cache",
      targetFileName
    });
    if (transfer.ok && transfer.target_pickcode) {
      const renameMismatch = resolveRenameMismatch(transfer.file_name, targetFileName);
      if (renameMismatch) {
        diagnostics.push({
          stage: "transfer",
          event: "user302_transfer_rename_mismatch",
          status: "skip",
          data: {
            target_cookie_name: userRule.targetCookieName,
            expected_file_name: targetFileName,
            returned_file_name: transfer.file_name || "",
            error: renameMismatch
          }
        });
      }
      finalPickcode = transfer.target_pickcode;
      finalCookie = targetCookie;
      finalCookieName = userRule.targetCookieName;
      transferDetail = {
        ruleId: userRule.id,
        ruleName: userRule.name,
        embyUserId: userRule.embyUserId,
        sourceCookieName: input.sourceCookieName,
        sourcePickcode: transfer.source_pickcode || input.sourcePickcode,
        targetPickcode: transfer.target_pickcode,
        targetCookieName: userRule.targetCookieName,
        targetPath: userRule.targetPath || "/sha1cache",
        sourceUid: transfer.source_uid || "",
        targetUid: transfer.target_uid || "",
        fileName: transfer.file_name || targetFileName,
        fileNameRequested: targetFileName,
        fileNameReturned: transfer.file_name || "",
        fileSize: String(transfer.file_size || 0),
        fileSha1: transfer.file_sha1 || "",
        rangeVerified: transfer.range_verified ? "1" : "0"
      };
      diagnostics.push({
        stage: "transfer",
        event: "user302_transfer",
        status: "ok",
        data: {
          source_pickcode: transfer.source_pickcode || input.sourcePickcode,
          target_pickcode: transfer.target_pickcode,
          target_file_name: targetFileName,
          returned_file_name: transfer.file_name || "",
          target_name_applied: isRequestedFileNameApplied(transfer.file_name, targetFileName) ? "1" : "0",
          target_cookie_name: userRule.targetCookieName
        }
      });
    } else {
      const reason = transfer.error || "unknown";
      const parsedReason = parseErrorCodeAndReason(reason);
      diagnostics.push({
        stage: "transfer",
        event: "user302_transfer",
        status: "error",
        data: {
          target_cookie_name: userRule.targetCookieName,
          error: reason
        }
      });
      throw new PlaybackError({
        step: "fast_transfer",
        accountName: userRule.targetCookieName,
        errorCode: parsedReason.errorCode || "FAST_TRANSFER_FAILED",
        errorReason: parsedReason.errorReason || reason,
        userMessage: formatTransferFailureMessage(
          "指定用户秒传失败",
          [{
            accountName: userRule.targetCookieName,
            errorCode: parsedReason.errorCode || "FAST_TRANSFER_FAILED",
            errorReason: parsedReason.errorReason || reason
          }]
        )
      });
    }
  }

  const antiRiskNames = Array.isArray(input.server.antiRiskCookieNames)
    ? input.server.antiRiskCookieNames
    : [];
  if (antiRiskNames.length > 0 && finalPickcode) {
    const availableTargets = antiRiskNames
      .map((antiRiskNameRaw) => String(antiRiskNameRaw || "").trim())
      .filter((antiRiskName) => antiRiskName.length > 0)
      .map((antiRiskName) => {
        const antiRiskProfile = input.config.p115.cookieProfiles.find((item) => item.name === antiRiskName);
        const antiRiskCookie = (antiRiskProfile?.cookies || "").trim();
        return {
          antiRiskName,
          antiRiskCookie
        };
      })
      .filter((item) => item.antiRiskCookie && item.antiRiskCookie !== finalCookie);

    if (availableTargets.length === 0) {
      diagnostics.push({
        stage: "transfer",
        event: "anti_risk_transfer",
        status: "skip",
        data: {
          reason: "no_available_target_cookie"
        }
      });
    } else {
      const randomOffset = availableTargets.length > 1 ? Math.floor(Math.random() * availableTargets.length) : 0;
      const orderedTargets = availableTargets
        .slice(randomOffset)
        .concat(availableTargets.slice(0, randomOffset));
      let antiRiskSucceeded = false;
      let lastError = "unknown";
      const antiRiskFailures: PlaybackErrorAttempt[] = [];
      for (const selectedTarget of orderedTargets) {
        strategyTrail.push(`anti-risk:${selectedTarget.antiRiskName}`);
        diagnostics.push({
          stage: "transfer",
          event: "anti_risk_target_selected",
          status: "ok",
          data: {
            anti_risk_cookie_name: selectedTarget.antiRiskName,
            selection_mode: orderedTargets.length > 1 ? "round_robin_random_start" : "single",
            candidate_count: String(orderedTargets.length)
          }
        });

        const targetFileName = createUniqueTransferTargetFileName(input.sourcePath);
        const transfer = await runFastTransferByPickcode({
          sourceCookie: input.sourceCookie,
          sourcePickcode: finalPickcode,
          targetCookie: selectedTarget.antiRiskCookie,
          targetPath: "/sha1cache",
          targetFileName
        });
        if (transfer.ok && transfer.target_pickcode) {
          const renameMismatch = resolveRenameMismatch(transfer.file_name, targetFileName);
          if (renameMismatch) {
            diagnostics.push({
              stage: "transfer",
              event: "anti_risk_transfer_rename_mismatch",
              status: "skip",
              data: {
                anti_risk_cookie_name: selectedTarget.antiRiskName,
                expected_file_name: targetFileName,
                returned_file_name: transfer.file_name || "",
                error: renameMismatch
              }
            });
          }
          finalPickcode = transfer.target_pickcode;
          finalCookie = selectedTarget.antiRiskCookie;
          finalCookieName = selectedTarget.antiRiskName;
          transferDetail = {
            ruleId: "anti-risk",
            ruleName: "防风控秒传",
            embyUserId: input.requestUserId,
            sourceCookieName: input.sourceCookieName,
            sourcePickcode: transfer.source_pickcode || input.sourcePickcode,
            targetPickcode: transfer.target_pickcode,
            targetCookieName: selectedTarget.antiRiskName,
            targetPath: "/sha1cache",
            sourceUid: transfer.source_uid || "",
            targetUid: transfer.target_uid || "",
            fileName: transfer.file_name || targetFileName,
            fileNameRequested: targetFileName,
            fileNameReturned: transfer.file_name || "",
            fileSize: String(transfer.file_size || 0),
            fileSha1: transfer.file_sha1 || "",
            rangeVerified: transfer.range_verified ? "1" : "0"
          };
          diagnostics.push({
            stage: "transfer",
            event: "anti_risk_transfer",
            status: "ok",
            data: {
              anti_risk_cookie_name: selectedTarget.antiRiskName,
              target_file_name: transfer.file_name || targetFileName,
              returned_file_name: transfer.file_name || "",
              target_name_applied: isRequestedFileNameApplied(transfer.file_name, targetFileName) ? "1" : "0",
              target_pickcode: transfer.target_pickcode
            }
          });
          antiRiskSucceeded = true;
          break;
        }

        lastError = transfer.error || "unknown";
        const parsedReason = parseErrorCodeAndReason(lastError);
        antiRiskFailures.push({
          accountName: selectedTarget.antiRiskName,
          errorCode: parsedReason.errorCode || "FAST_TRANSFER_FAILED",
          errorReason: parsedReason.errorReason || lastError
        });
        diagnostics.push({
          stage: "transfer",
          event: "anti_risk_transfer",
          status: "error",
          data: {
            anti_risk_cookie_name: selectedTarget.antiRiskName,
            error: lastError
          }
        });
      }

      if (!antiRiskSucceeded) {
        throw new PlaybackError({
          step: "fast_transfer",
          errorCode: antiRiskFailures[antiRiskFailures.length - 1]?.errorCode || "FAST_TRANSFER_ALL_FAILED",
          errorReason: antiRiskFailures[antiRiskFailures.length - 1]?.errorReason || lastError,
          attempts: antiRiskFailures,
          userMessage: formatTransferFailureMessage("防风控秒传失败", antiRiskFailures)
        });
      }
    }
  }

  if (finalPickcode) {
    diagnostics.push({
      stage: "sessions",
      event: "sessions_query_start",
      status: "ok",
      data: {
        item_id: input.requestItemId,
        media_source_id: input.requestMediaSourceId
      }
    });
    const occupied = await checkMediaOccupied({
      server: input.server,
      apiKey: input.requestApiKey,
      itemId: input.requestItemId,
      mediaSourceId: input.requestMediaSourceId,
      playSessionId: input.requestPlaySessionId
    });
    if (occupied.occupied) {
      diagnostics.push({
        stage: "sessions",
        event: "sessions_filter_result",
        status: "ok",
        data: {
          total_sessions: String(occupied.totalSessions),
          playable_sessions: String(occupied.playableSessions),
          filtered_paused: String(occupied.filteredPaused),
          filtered_no_now_playing: String(occupied.filteredNoNowPlaying)
        }
      });
      strategyTrail.push(`same-play:${occupied.matchedSessionId || "occupied"}`);
      const cacheKey = [
        `cookie=${finalCookieName}`,
        `path=/sha1cache`
      ].join("::");
      const cachedFolderId = input.folderIdCache.get(cacheKey);
      diagnostics.push({
        stage: "same_play",
        event: "same_play_detected",
        status: "ok",
        data: {
          matched_session_id: occupied.matchedSessionId,
          matched_user_id: occupied.matchedUserId,
          folder_cache_hit: cachedFolderId ? "1" : "0"
        }
      });
      const targetPath = "/sha1cache";
      const targetFileName = createUniqueTransferTargetFileName(input.sourcePath);
      if (cachedFolderId) {
        diagnostics.push({
          stage: "transfer",
          event: "same_play_copy",
          status: "skip",
          data: {
            reason: "cached_folder_hit",
            cached_folder_id: cachedFolderId
          }
        });
      } else {
        const transfer = await runFastTransferByPickcode({
          sourceCookie: finalCookie,
          sourcePickcode: finalPickcode,
          targetCookie: finalCookie,
          targetPath,
          targetFileName
        });
        if (transfer.ok && transfer.target_pickcode) {
          const renameMismatch = resolveRenameMismatch(transfer.file_name, targetFileName);
          finalPickcode = transfer.target_pickcode;
          transferDetail = {
            ruleId: "same-play",
            ruleName: "同播复制",
            embyUserId: input.requestUserId,
            sourceCookieName: finalCookieName,
            sourcePickcode: transfer.source_pickcode || input.sourcePickcode,
            targetPickcode: transfer.target_pickcode,
            targetCookieName: finalCookieName,
            targetPath,
            sourceUid: transfer.source_uid || "",
            targetUid: transfer.target_uid || "",
            fileName: transfer.file_name || targetFileName,
            fileNameRequested: targetFileName,
            fileNameReturned: transfer.file_name || "",
            fileSize: String(transfer.file_size || 0),
            fileSha1: transfer.file_sha1 || "",
            rangeVerified: transfer.range_verified ? "1" : "0"
          };
          if (renameMismatch) {
            diagnostics.push({
              stage: "transfer",
              event: "same_play_copy_rename_mismatch",
              status: "skip",
              data: {
                target_path: targetPath,
                expected_file_name: targetFileName,
                returned_file_name: transfer.file_name || "",
                error: renameMismatch
              }
            });
          } else {
            diagnostics.push({
              stage: "transfer",
              event: "same_play_copy",
              status: "ok",
            data: {
              target_path: targetPath,
              target_file_name: targetFileName,
              returned_file_name: transfer.file_name || "",
              target_name_applied: isRequestedFileNameApplied(transfer.file_name, targetFileName) ? "1" : "0",
              target_pickcode: transfer.target_pickcode
            }
          });
          }
        } else {
          diagnostics.push({
            stage: "transfer",
            event: "same_play_copy",
            status: "error",
            data: {
              target_path: targetPath,
              error: transfer.error || "unknown"
            }
          });
        }
      }
      if (!cachedFolderId) {
        input.folderIdCache.set(cacheKey, targetPath, 86400);
      }
    } else {
      diagnostics.push({
        stage: "sessions",
        event: "sessions_filter_result",
        status: "skip",
        data: {
          total_sessions: String(occupied.totalSessions),
          playable_sessions: String(occupied.playableSessions),
          filtered_paused: String(occupied.filteredPaused),
          filtered_no_now_playing: String(occupied.filteredNoNowPlaying)
        }
      });
    }
  }

  if (!finalPickcode) {
    finalPickcode = input.sourcePickcode;
  }
  if (!finalPickcode) {
    throw new Error("cannot produce final playable pickcode");
  }

  diagnostics.push({
    stage: "redirect_cache",
    event: "redirect_cache_lookup",
    status: "skip",
    data: {
      redirect_cache_hit: "0",
      reason: "removed_pickcode_cookie_match",
      final_pickcode: finalPickcode
    }
  });

  const resolved = await resolvePickcodeDirectLink({
    client: input.client,
    pickcode: finalPickcode,
    requestUserAgent: input.requestUserAgent,
    sourceCookie: finalCookie,
    pathPrefixRules: input.pathPrefixRules
  });
  diagnostics.push({
    stage: "redirect_cache",
    event: "redirect_cache_store",
    status: "skip",
    data: {
      reason: "removed_pickcode_cookie_match",
      final_pickcode: finalPickcode,
      final_cookie_name: finalCookieName
    }
  });

  return {
    finalPickcode,
    finalCookie,
    finalCookieName,
    directUrl: resolved.url,
    strategyTrail,
    transferDetail,
    diagnostics
  };
}

function createUniqueTransferTargetFileName(sourcePath: string): string {
  sweepOldTargetNames();
  const baseName = extractBaseName(sourcePath) || "file";
  const dotIndex = baseName.lastIndexOf(".");
  const hasExt = dotIndex > 0 && dotIndex < baseName.length - 1;
  const namePart = hasExt ? baseName.slice(0, dotIndex) : baseName;
  const extPart = hasExt ? baseName.slice(dotIndex) : "";
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const suffix = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    const candidate = `${namePart}-${suffix}${extPart}`;
    if (!recentTargetFileNames.has(candidate)) {
      recentTargetFileNames.set(candidate, Date.now());
      return candidate;
    }
  }
  const fallback = `${namePart}-${String(Date.now() % 10000).padStart(4, "0")}${extPart}`;
  recentTargetFileNames.set(fallback, Date.now());
  return fallback;
}

function extractBaseName(pathText: string): string {
  const normalized = String(pathText || "").replace(/\\/g, "/").trim();
  if (!normalized) {
    return "";
  }
  const chunks = normalized.split("/").filter(Boolean);
  return chunks.length ? chunks[chunks.length - 1] : normalized;
}

function sweepOldTargetNames() {
  const now = Date.now();
  for (const [name, createdAt] of recentTargetFileNames.entries()) {
    if (now - createdAt > targetNameKeepMs) {
      recentTargetFileNames.delete(name);
    }
  }
  if (recentTargetFileNames.size > 20000) {
    const sorted = Array.from(recentTargetFileNames.entries()).sort((a, b) => a[1] - b[1]);
    const removeCount = recentTargetFileNames.size - 12000;
    for (let index = 0; index < removeCount; index += 1) {
      recentTargetFileNames.delete(sorted[index][0]);
    }
  }
}

function isRequestedFileNameApplied(returnedName: string | undefined, requestedName: string): boolean {
  const returned = String(returnedName || "").trim();
  const requested = String(requestedName || "").trim();
  if (!returned || !requested) {
    return false;
  }
  return returned === requested;
}

function resolveRenameMismatch(returnedName: string | undefined, requestedName: string): string {
  const returned = String(returnedName || "").trim();
  const requested = String(requestedName || "").trim();
  if (!requested) {
    return "";
  }
  if (!returned) {
    return "秒传返回文件名为空，无法确认后缀命名生效";
  }
  if (returned !== requested) {
    return `秒传文件名未按后缀命名，期望=${requested}，实际=${returned}`;
  }
  return "";
}

function formatTransferFailureMessage(prefix: string, attempts: PlaybackErrorAttempt[]): string {
  if (!attempts.length) {
    return `${prefix}：未知错误`;
  }
  return `${prefix}：${attempts
    .map((item) => {
      const codeSuffix = item.errorCode ? `（${item.errorCode}）` : "";
      return `账号【${item.accountName || "未知账号"}】${item.errorReason || "未知错误"}${codeSuffix}`;
    })
    .join("；")}`;
}
