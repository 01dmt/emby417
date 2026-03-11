import { EmbyServerProfile } from "./config.js";

export interface SessionOccupancyResult {
  occupied: boolean;
  matchedSessionId: string;
  matchedUserId: string;
  totalSessions: number;
  playableSessions: number;
  filteredPaused: number;
  filteredNoNowPlaying: number;
}

export interface SessionUserResolveResult {
  userId: string;
  userName: string;
  matchedSessionId: string;
  totalSessions: number;
  matchedBy: string;
  debug: Record<string, string>;
}

export async function resolveUserBySessionContext(params: {
  server: EmbyServerProfile;
  apiKey: string;
  playSessionId: string;
  mediaSourceId?: string;
  deviceId?: string;
}): Promise<SessionUserResolveResult> {
  const targetPlaySessionId = String(params.playSessionId || "").trim();
  const targetMediaSourceId = normalizeMediaSourceId(params.mediaSourceId);
  const targetDeviceId = normalizeText(params.deviceId);
  if (!targetPlaySessionId && !targetMediaSourceId) {
    return buildEmptyResolveResult(0, {
      reason: "missing_play_session_and_media_source",
      target_device_id: targetDeviceId
    });
  }

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const payload = await fetchSessionsPayload(params.server, params.apiKey);
    if (!payload) {
      return buildEmptyResolveResult(0, {
        reason: "sessions_fetch_failed",
        target_device_id: targetDeviceId
      });
    }

    const resolved = resolveUserFromSessions({
      payload,
      targetPlaySessionId,
      targetMediaSourceId,
      targetDeviceId
    });
    if (resolved.userId) {
      return resolved;
    }
    if (attempt < maxAttempts - 1) {
      await wait(220);
    }
  }

  return buildEmptyResolveResult(0, {
    reason: "retry_exhausted_without_match",
    target_device_id: targetDeviceId
  });
}

function resolveUserFromSessions(params: {
  payload: unknown[];
  targetPlaySessionId: string;
  targetMediaSourceId: string;
  targetDeviceId: string;
}): SessionUserResolveResult {
  const mediaSourceDeviceCandidates: SessionUserResolveResult[] = [];
  const playSessionCandidates: SessionUserResolveResult[] = [];
  const deviceOnlyCandidates: SessionUserResolveResult[] = [];
  let ignoredInvalidRows = 0;
  let ignoredMissingUserRows = 0;
  let ignoredDeviceMismatchRows = 0;

  for (const row of params.payload) {
    if (!row || typeof row !== "object") {
      ignoredInvalidRows += 1;
      continue;
    }
    const session = row as Record<string, unknown>;
    const sessionId = pickString(session.Id);
    const playState = asRecord(session.PlayState);
    const nowPlaying = asRecord(session.NowPlayingItem);
    const playStateId = pickString(playState?.PlaySessionId);
    const topPlaySessionId = pickString(session.PlaySessionId);
    const candidateIds = [
      sessionId,
      playStateId,
      topPlaySessionId
    ].filter((item) => item.length > 0);

    const mediaSourceCandidates = [
      normalizeMediaSourceId(playState?.MediaSourceId),
      normalizeMediaSourceId(nowPlaying?.MediaSourceId),
      ...extractMediaSourceIdsFromNowPlaying(nowPlaying)
    ].filter((item) => item.length > 0);
    const deviceCandidates = [
      normalizeText(session.DeviceId),
      normalizeText(session.DeviceID),
      normalizeText(playState?.DeviceId),
      normalizeText(session.Client),
      normalizeText(session.DeviceName)
    ].filter((item) => item.length > 0);

    const playSessionMatched = params.targetPlaySessionId
      ? candidateIds.includes(params.targetPlaySessionId)
      : false;
    const mediaMatched = params.targetMediaSourceId
      ? mediaSourceCandidates.includes(params.targetMediaSourceId)
      : false;
    const deviceMatched = params.targetDeviceId
      ? deviceCandidates.includes(params.targetDeviceId)
      : true;

    if (mediaMatched && deviceMatched) {
      const userId = pickString(session.UserId);
      if (!userId) {
        ignoredMissingUserRows += 1;
        continue;
      }
      mediaSourceDeviceCandidates.push({
        userId,
        userName: pickString(session.UserName),
        matchedSessionId: sessionId || playStateId || topPlaySessionId,
        totalSessions: params.payload.length,
        matchedBy: "media_source_device",
        debug: {}
      });
      continue;
    }

    if (playSessionMatched) {
      const userId = pickString(session.UserId);
      if (!userId) {
        ignoredMissingUserRows += 1;
        continue;
      }
      playSessionCandidates.push({
        userId,
        userName: pickString(session.UserName),
        matchedSessionId: sessionId || playStateId || topPlaySessionId,
        totalSessions: params.payload.length,
        matchedBy: "play_session",
        debug: {}
      });
      continue;
    }

    if (
      params.targetDeviceId
      && deviceMatched
      && pickString(session.UserId)
    ) {
      deviceOnlyCandidates.push({
        userId: pickString(session.UserId),
        userName: pickString(session.UserName),
        matchedSessionId: sessionId || playStateId || topPlaySessionId,
        totalSessions: params.payload.length,
        matchedBy: "device_only",
        debug: {}
      });
    } else if (params.targetDeviceId && !deviceMatched) {
      ignoredDeviceMismatchRows += 1;
    }
  }

  const debugBase: Record<string, string> = {
    target_play_session_id: params.targetPlaySessionId,
    target_media_source_id: params.targetMediaSourceId,
    target_device_id: params.targetDeviceId,
    total_sessions: String(params.payload.length),
    ignored_invalid_rows: String(ignoredInvalidRows),
    ignored_missing_user_rows: String(ignoredMissingUserRows),
    ignored_device_mismatch_rows: String(ignoredDeviceMismatchRows),
    media_source_device_candidates: String(mediaSourceDeviceCandidates.length),
    play_session_candidates: String(playSessionCandidates.length),
    device_only_candidates: String(deviceOnlyCandidates.length)
  };

  const mediaSourceDeviceSelected = pickDeterministicCandidate(mediaSourceDeviceCandidates);
  if (mediaSourceDeviceSelected) {
    return {
      ...mediaSourceDeviceSelected,
      debug: {
        ...debugBase,
        selected_tier: "media_source_device",
        ambiguous_users: "0"
      }
    };
  }
  if (hasAmbiguousUsers(mediaSourceDeviceCandidates)) {
    return buildEmptyResolveResult(params.payload.length, {
      ...debugBase,
      selected_tier: "media_source_device",
      reason: "ambiguous_users_in_media_source_device",
      ambiguous_users: "1"
    });
  }

  const playSessionSelected = pickDeterministicCandidate(playSessionCandidates);
  if (playSessionSelected) {
    return {
      ...playSessionSelected,
      debug: {
        ...debugBase,
        selected_tier: "play_session",
        ambiguous_users: "0"
      }
    };
  }
  if (hasAmbiguousUsers(playSessionCandidates)) {
    return buildEmptyResolveResult(params.payload.length, {
      ...debugBase,
      selected_tier: "play_session",
      reason: "ambiguous_users_in_play_session",
      ambiguous_users: "1"
    });
  }

  const deviceOnlySelected = pickDeterministicCandidate(deviceOnlyCandidates);
  if (deviceOnlySelected) {
    return {
      ...deviceOnlySelected,
      debug: {
        ...debugBase,
        selected_tier: "device_only",
        ambiguous_users: "0"
      }
    };
  }
  if (hasAmbiguousUsers(deviceOnlyCandidates)) {
    return buildEmptyResolveResult(params.payload.length, {
      ...debugBase,
      selected_tier: "device_only",
      reason: "ambiguous_users_in_device_only",
      ambiguous_users: "1"
    });
  }

  return buildEmptyResolveResult(params.payload.length, {
    ...debugBase,
    reason: "no_candidate_with_user"
  });
}

export async function resolveUserIdByPlaySessionId(params: {
  server: EmbyServerProfile;
  apiKey: string;
  playSessionId: string;
}): Promise<SessionUserResolveResult> {
  return resolveUserBySessionContext({
    server: params.server,
    apiKey: params.apiKey,
    playSessionId: params.playSessionId
  });
}

export async function checkMediaOccupied(params: {
  server: EmbyServerProfile;
  apiKey: string;
  itemId: string;
  mediaSourceId: string;
  playSessionId?: string;
}): Promise<SessionOccupancyResult> {
  const endpoint = new URL("/Sessions", params.server.serverUrl);
  if (params.apiKey) {
    endpoint.searchParams.set("api_key", params.apiKey);
  }

  const response = await fetch(endpoint.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
      ...(params.apiKey ? { "x-emby-token": params.apiKey } : {})
    }
  });
  if (!response.ok) {
    return {
      occupied: false,
      matchedSessionId: "",
      matchedUserId: "",
      totalSessions: 0,
      playableSessions: 0,
      filteredPaused: 0,
      filteredNoNowPlaying: 0
    };
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    return {
      occupied: false,
      matchedSessionId: "",
      matchedUserId: "",
      totalSessions: 0,
      playableSessions: 0,
      filteredPaused: 0,
      filteredNoNowPlaying: 0
    };
  }

  const normalizedItemId = params.itemId.trim();
  const normalizedMediaSourceId = params.mediaSourceId.trim();
  const normalizedPlaySessionId = pickString(params.playSessionId);
  let playableSessions = 0;
  let filteredPaused = 0;
  let filteredNoNowPlaying = 0;
  let matchedPlayableSessions = 0;
  let matchedOtherSessions = 0;
  let firstMatchedSessionId = "";
  let firstMatchedUserId = "";
  for (const row of payload) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const session = row as Record<string, unknown>;
    const nowPlaying = asRecord(session.NowPlayingItem);
    const playState = asRecord(session.PlayState);
    const isPaused = Boolean(playState?.IsPaused);
    if (!nowPlaying) {
      filteredNoNowPlaying += 1;
      continue;
    }
    if (isPaused) {
      filteredPaused += 1;
      continue;
    }
    playableSessions += 1;

    const itemId = pickString(nowPlaying.Id);
    const mediaSourceId = pickString(playState?.MediaSourceId);
    const itemMatched = normalizedItemId && itemId === normalizedItemId;
    const mediaMatched = normalizedMediaSourceId && mediaSourceId === normalizedMediaSourceId;
    if (itemMatched || mediaMatched) {
      const sessionId = pickString(session.Id);
      matchedPlayableSessions += 1;
      if (!firstMatchedSessionId) {
        firstMatchedSessionId = sessionId;
        firstMatchedUserId = pickString(session.UserId);
      }
      if (!normalizedPlaySessionId) {
        if (matchedPlayableSessions >= 2) {
          matchedOtherSessions = 1;
        }
      } else if (sessionId && sessionId !== normalizedPlaySessionId) {
        matchedOtherSessions += 1;
      }
    }
  }

  if (matchedOtherSessions > 0) {
    return {
      occupied: true,
      matchedSessionId: firstMatchedSessionId,
      matchedUserId: firstMatchedUserId,
      totalSessions: payload.length,
      playableSessions,
      filteredPaused,
      filteredNoNowPlaying
    };
  }

  return {
    occupied: false,
    matchedSessionId: "",
    matchedUserId: "",
    totalSessions: payload.length,
    playableSessions,
    filteredPaused,
    filteredNoNowPlaying
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeMediaSourceId(value: unknown): string {
  const raw = pickString(value);
  if (!raw) {
    return "";
  }
  return raw.replace(/^mediasource_/i, "").trim();
}

function normalizeText(value: unknown): string {
  const raw = pickString(value);
  if (!raw) {
    return "";
  }
  return raw.toLowerCase();
}

function extractMediaSourceIdsFromNowPlaying(nowPlaying: Record<string, unknown> | null): string[] {
  if (!nowPlaying) {
    return [];
  }
  const mediaSources = nowPlaying.MediaSources;
  if (!Array.isArray(mediaSources)) {
    return [];
  }
  const ids: string[] = [];
  for (const item of mediaSources) {
    if (!item || typeof item !== "object") {
      continue;
    }
    ids.push(normalizeMediaSourceId((item as Record<string, unknown>).Id));
  }
  return ids.filter((item) => item.length > 0);
}

function buildEmptyResolveResult(totalSessions: number, debug: Record<string, string>): SessionUserResolveResult {
  return {
    userId: "",
    userName: "",
    matchedSessionId: "",
    totalSessions,
    matchedBy: "",
    debug
  };
}

function pickDeterministicCandidate(candidates: SessionUserResolveResult[]): SessionUserResolveResult | undefined {
  if (!candidates.length) {
    return undefined;
  }
  const distinctUserIds = new Set(candidates.map((item) => item.userId));
  if (distinctUserIds.size > 1) {
    return undefined;
  }
  return candidates
    .slice()
    .sort((left, right) => {
      const leftKey = `${left.matchedSessionId}\u0000${left.userId}\u0000${left.userName}`;
      const rightKey = `${right.matchedSessionId}\u0000${right.userId}\u0000${right.userName}`;
      return leftKey.localeCompare(rightKey);
    })[0];
}

function hasAmbiguousUsers(candidates: SessionUserResolveResult[]): boolean {
  if (candidates.length < 2) {
    return false;
  }
  return new Set(candidates.map((item) => item.userId)).size > 1;
}

async function fetchSessionsPayload(server: EmbyServerProfile, apiKey: string): Promise<unknown[] | null> {
  const endpoint = new URL("/Sessions", server.serverUrl);
  if (apiKey) {
    endpoint.searchParams.set("api_key", apiKey);
  }

  const response = await fetch(endpoint.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
      ...(apiKey ? { "x-emby-token": apiKey } : {})
    }
  });
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? payload : null;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
