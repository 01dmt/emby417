import { promises as fs } from "node:fs";
import { runtimePaths } from "./runtime_paths.js";

export type PlaybackStrategy = "forceProxy" | "prefer302";

export interface CookieProfile {
  name: string;
  cookies: string;
  cacheExpirySeconds: number;
  autoDelete: CookieAutoDeleteConfig;
}

export interface CookieAutoDeleteConfig {
  enabled: boolean;
  cron: string;
  directories: string[];
  safeCode: string;
}

export interface EmbyServerProfile {
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
}

export interface AppConfig {
  emby: {
    serverUrl: string;
    activeServerId: string;
    servers: EmbyServerProfile[];
  };
  p115: {
    baseUrl: string;
    authToken: string;
    cookies: string;
    cookieProfiles: CookieProfile[];
    activeCookieName: string;
    userAgent: string;
    downloadPath: string;
    pathPrefixRules: string;
    extraHeaders: string;
  };
  playback: {
    defaultStrategy: PlaybackStrategy;
    allowProxy: boolean;
  };
  user302: {
    enabled: boolean;
    rules: User302Rule[];
  };
  cache: {
    enabled: boolean;
    ttlSeconds: number;
  };
  logging: {
    retainLimit: number;
  };
}

export interface User302Rule {
  id: string;
  name: string;
  embyUserId: string;
  targetCookieName: string;
  targetPath: string;
  enabled: boolean;
}

const dataDir = runtimePaths.appDataDir;
const configPath = runtimePaths.configPath;

const defaultConfig: AppConfig = {
  emby: {
    serverUrl: "http://127.0.0.1:8096",
    activeServerId: "default-emby",
    servers: [
      {
        id: "default-emby",
        name: "默认 Emby",
        serverUrl: "http://127.0.0.1:8096",
        apiKey: "",
        p115CookieName: "",
        antiRiskCookieNames: [],
        customPickcodeRegex: "",
        p115Cookie: "",
        enabled: true,
        reverseProxyPorts: ["5088"],
        pathPrefixRules: ""
      }
    ]
  },
  p115: {
    baseUrl: "http://127.0.0.1:8115",
    authToken: "",
    cookies: "",
    cookieProfiles: [
      {
        name: "default",
        cookies: "",
        cacheExpirySeconds: 1800,
        autoDelete: {
          enabled: false,
          cron: "0 4 * * *",
          directories: [],
          safeCode: ""
        }
      }
    ],
    activeCookieName: "default",
    userAgent: "Emby302Proxy/0.1",
    downloadPath: "/api/tool/download",
    pathPrefixRules: "",
    extraHeaders: "Referer: https://115.com/\nOrigin: https://115.com/\nAccept: */*"
  },
  playback: {
    defaultStrategy: "prefer302",
    allowProxy: false
  },
  user302: {
    enabled: true,
    rules: []
  },
  cache: {
    enabled: true,
    ttlSeconds: 1800
  },
  logging: {
    retainLimit: 2000
  }
};

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

export async function loadConfig(): Promise<AppConfig> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as AppConfig;
    return sanitizeConfig({
      ...defaultConfig,
      ...parsed,
      emby: { ...defaultConfig.emby, ...parsed.emby },
      p115: { ...defaultConfig.p115, ...parsed.p115 },
      playback: { ...defaultConfig.playback, ...parsed.playback },
      user302: { ...defaultConfig.user302, ...parsed.user302 },
      cache: { ...defaultConfig.cache, ...parsed.cache },
      logging: { ...defaultConfig.logging, ...parsed.logging }
    });
  } catch (error) {
    await saveConfig(defaultConfig);
    return { ...defaultConfig };
  }
}

export async function saveConfig(next: AppConfig): Promise<void> {
  await ensureDataDir();
  const body = JSON.stringify(sanitizeConfig(next), null, 2);
  await fs.writeFile(configPath, body, "utf-8");
}

export function mergeConfig(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
  return sanitizeConfig({
    ...base,
    ...patch,
    emby: { ...base.emby, ...patch.emby },
    p115: { ...base.p115, ...patch.p115 },
    playback: { ...base.playback, ...patch.playback },
    user302: { ...base.user302, ...patch.user302 },
    cache: { ...base.cache, ...patch.cache },
    logging: { ...base.logging, ...patch.logging }
  });
}

function sanitizeConfig(config: AppConfig): AppConfig {
  const ttl = Number.isFinite(config.cache.ttlSeconds)
    ? Math.max(0, Math.floor(config.cache.ttlSeconds))
    : defaultConfig.cache.ttlSeconds;
  const retain = Number.isFinite(config.logging.retainLimit)
    ? Math.max(100, Math.floor(config.logging.retainLimit))
    : defaultConfig.logging.retainLimit;

  const profiles = normalizeCookieProfiles(config.p115.cookieProfiles, config.p115.cookies);
  const activeCookieName = profiles.some((item) => item.name === config.p115.activeCookieName)
    ? config.p115.activeCookieName
    : profiles[0].name;
  const activeCookieValue = profiles.find((item) => item.name === activeCookieName)?.cookies ?? "";
  const embyServers = normalizeEmbyServers(config.emby.servers, config.emby.serverUrl);
  const user302Rules = normalizeUser302Rules(config.user302?.rules);
  const enabledServers = embyServers.filter((item) => item.enabled);
  const activeCandidates = enabledServers.length > 0 ? enabledServers : embyServers;
  const activeServerId = activeCandidates.some((item) => item.id === config.emby.activeServerId)
    ? config.emby.activeServerId
    : activeCandidates[0].id;
  const activeServer = activeCandidates.find((item) => item.id === activeServerId) ?? activeCandidates[0];

  return {
    ...config,
    emby: {
      serverUrl: activeServer.serverUrl || defaultConfig.emby.serverUrl,
      activeServerId,
      servers: embyServers
    },
    p115: {
      ...config.p115,
      baseUrl: config.p115.baseUrl || defaultConfig.p115.baseUrl,
      cookies: activeCookieValue,
      cookieProfiles: profiles,
      activeCookieName,
      downloadPath: config.p115.downloadPath || defaultConfig.p115.downloadPath,
      userAgent: config.p115.userAgent || defaultConfig.p115.userAgent,
      pathPrefixRules: "",
      extraHeaders:
        typeof config.p115.extraHeaders === "string"
          ? config.p115.extraHeaders
          : defaultConfig.p115.extraHeaders
    },
    playback: {
      defaultStrategy:
        config.playback.defaultStrategy === "forceProxy" ? "forceProxy" : "prefer302",
      allowProxy: Boolean(config.playback.allowProxy)
    },
    user302: {
      enabled: config.user302?.enabled !== false,
      rules: user302Rules
    },
    cache: {
      enabled: Boolean(config.cache.enabled),
      ttlSeconds: ttl
    },
    logging: {
      retainLimit: retain
    }
  };
}

export function findUser302Rule(config: AppConfig, embyUserId: string | undefined): User302Rule | undefined {
  const userId = typeof embyUserId === "string" ? embyUserId.trim() : "";
  if (!userId || config.user302.enabled === false) {
    return undefined;
  }
  return config.user302.rules.find((item) => item.enabled && item.embyUserId === userId);
}

export function getActiveEmbyServer(config: AppConfig): EmbyServerProfile {
  const enabledServers = config.emby.servers.filter((item) => item.enabled);
  const candidates = enabledServers.length > 0 ? enabledServers : config.emby.servers;
  return (
    candidates.find((item) => item.id === config.emby.activeServerId) ||
    candidates[0]
  );
}

export function getEmbyServerById(
  config: AppConfig,
  serverId: string | undefined
): EmbyServerProfile | undefined {
  if (!serverId) {
    return undefined;
  }
  return config.emby.servers.find((item) => item.id === serverId);
}

export function resolveServerCookie(config: AppConfig, server: EmbyServerProfile): string {
  const profileName = typeof server.p115CookieName === "string" ? server.p115CookieName.trim() : "";
  if (profileName) {
    const byName = config.p115.cookieProfiles.find((item) => item.name === profileName);
    if (byName && byName.cookies.trim()) {
      return byName.cookies.trim();
    }
  }
  if (typeof server.p115Cookie === "string" && server.p115Cookie.trim()) {
    return server.p115Cookie.trim();
  }
  return config.p115.cookies;
}

export function getCacheExpirySecondsByCookie(
  config: AppConfig,
  cookieValue: string | undefined
): number {
  const fallback = normalizeCacheExpirySeconds(config.cache.ttlSeconds, defaultConfig.cache.ttlSeconds);
  const cookie = typeof cookieValue === "string" ? cookieValue.trim() : "";
  if (!cookie) {
    const active =
      config.p115.cookieProfiles.find((item) => item.name === config.p115.activeCookieName)
      ?? config.p115.cookieProfiles[0];
    if (!active) {
      return fallback;
    }
    return normalizeCacheExpirySeconds(active.cacheExpirySeconds, fallback);
  }

  const matched = config.p115.cookieProfiles.find((item) => item.cookies.trim() === cookie);
  if (!matched) {
    return fallback;
  }
  return normalizeCacheExpirySeconds(matched.cacheExpirySeconds, fallback);
}

function normalizeCookieProfiles(
  input: CookieProfile[] | undefined,
  fallbackCookie: string
): CookieProfile[] {
  const source = Array.isArray(input) ? input : [];
  const used = new Set<string>();
  const normalized: CookieProfile[] = [];

  for (const item of source) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rawName = typeof item.name === "string" ? item.name.trim() : "";
    const rawCookie = typeof item.cookies === "string" ? item.cookies.trim() : "";
    const baseName = rawName || `cookie-${normalized.length + 1}`;
    const uniqueName = ensureUniqueName(baseName, used);
    normalized.push({
      name: uniqueName,
      cookies: rawCookie,
      cacheExpirySeconds: normalizeCacheExpirySeconds(item.cacheExpirySeconds, defaultConfig.cache.ttlSeconds),
      autoDelete: normalizeCookieAutoDeleteConfig((item as Partial<CookieProfile>).autoDelete)
    });
  }

  const fallback = typeof fallbackCookie === "string" ? fallbackCookie.trim() : "";

  if (normalized.length === 0) {
    normalized.push({
      name: "default",
      cookies: fallback,
      cacheExpirySeconds: defaultConfig.cache.ttlSeconds,
      autoDelete: normalizeCookieAutoDeleteConfig(undefined)
    });
    return normalized;
  }

  const hasNonEmptyCookie = normalized.some((item) => item.cookies.trim().length > 0);
  if (!hasNonEmptyCookie && fallback) {
    normalized[0].cookies = fallback;
  }

  return normalized;
}

function normalizeCookieAutoDeleteConfig(input: unknown): CookieAutoDeleteConfig {
  const source = input && typeof input === "object"
    ? (input as Partial<CookieAutoDeleteConfig>)
    : {};

  const cronRaw = typeof source.cron === "string" ? source.cron.trim() : "";
  const cron = cronRaw || "0 4 * * *";
  const directories = normalizeAutoDeleteDirectoriesFromUnknown(source.directories);
  const safeCodeRaw = typeof source.safeCode === "string" ? source.safeCode : "";
  const safeCode = safeCodeRaw.replace(/\D+/g, "").slice(0, 6);

  return {
    enabled: Boolean(source.enabled),
    cron,
    directories,
    safeCode
  };
}

function normalizeAutoDeleteDirectoriesFromUnknown(input: unknown): string[] {
  if (Array.isArray(input)) {
    return Array.from(new Set(input
      .map((item) => String(item || "").trim())
      .filter((item) => item.length > 0)));
  }

  if (typeof input === "string") {
    return Array.from(new Set(input
      .split(/[\r\n;]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)));
  }

  return [];
}

function normalizeCacheExpirySeconds(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(0, Math.floor(fallback));
  }
  return Math.max(0, Math.floor(value));
}

function ensureUniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let index = 2;
  while (used.has(`${name}-${index}`)) {
    index += 1;
  }
  const unique = `${name}-${index}`;
  used.add(unique);
  return unique;
}

function normalizeEmbyServers(
  input: EmbyServerProfile[] | undefined,
  fallbackUrl: string
): EmbyServerProfile[] {
  const source = Array.isArray(input) ? input : [];
  const normalized: EmbyServerProfile[] = [];
  const usedIds = new Set<string>();

  for (const item of source) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const id = ensureUniqueId(typeof item.id === "string" ? item.id.trim() : "", usedIds, normalized.length + 1);
    const serverUrl = typeof item.serverUrl === "string" ? item.serverUrl.trim() : "";
    if (!serverUrl) {
      continue;
    }

    const reverseProxyPorts = Array.isArray(item.reverseProxyPorts)
      ? item.reverseProxyPorts
          .map((port) => String(port).trim())
          .filter((port) => /^\d+$/.test(port))
      : [];

    normalized.push({
      id,
      name:
        typeof item.name === "string" && item.name.trim().length > 0
          ? item.name.trim()
          : `emby-${normalized.length + 1}`,
      serverUrl,
      apiKey: typeof item.apiKey === "string" ? item.apiKey.trim() : "",
      p115CookieName: typeof item.p115CookieName === "string" ? item.p115CookieName.trim() : "",
      antiRiskCookieNames: normalizeAntiRiskCookieNames(item),
      customPickcodeRegex: typeof item.customPickcodeRegex === "string" ? item.customPickcodeRegex : "",
      p115Cookie: typeof item.p115Cookie === "string" ? item.p115Cookie.trim() : "",
      enabled: item.enabled !== false,
      reverseProxyPorts: Array.from(new Set(reverseProxyPorts)),
      pathPrefixRules: typeof item.pathPrefixRules === "string" ? item.pathPrefixRules : ""
    });
  }

  if (normalized.length > 0) {
    return normalized;
  }

  const url = fallbackUrl && fallbackUrl.trim() ? fallbackUrl.trim() : defaultConfig.emby.serverUrl;
  return [
    {
      id: "default-emby",
      name: "默认 Emby",
      serverUrl: url,
      apiKey: "",
      p115CookieName: "",
      antiRiskCookieNames: [],
      customPickcodeRegex: "",
      p115Cookie: "",
      enabled: true,
      reverseProxyPorts: ["5088"],
      pathPrefixRules: ""
    }
  ];
}

function normalizeAntiRiskCookieNames(item: unknown): string[] {
  const source = item as { antiRiskCookieNames?: unknown; antiRiskCookieName?: unknown };
  const names = Array.isArray(source.antiRiskCookieNames)
    ? source.antiRiskCookieNames
    : [];
  const list = names
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter((name) => name.length > 0);
  if (list.length > 0) {
    return Array.from(new Set(list));
  }
  const legacy = typeof source.antiRiskCookieName === "string" ? source.antiRiskCookieName.trim() : "";
  return legacy ? [legacy] : [];
}

function normalizeUser302Rules(input: User302Rule[] | undefined): User302Rule[] {
  const source = Array.isArray(input) ? input : [];
  const normalized: User302Rule[] = [];
  const used = new Set<string>();

  for (const item of source) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const embyUserId = typeof item.embyUserId === "string" ? item.embyUserId.trim() : "";
    const targetCookieName = typeof item.targetCookieName === "string" ? item.targetCookieName.trim() : "";
    if (!embyUserId || !targetCookieName) {
      continue;
    }
    const id = ensureUniqueId(typeof item.id === "string" ? item.id.trim() : "", used, normalized.length + 1);
    normalized.push({
      id,
      name: typeof item.name === "string" ? item.name.trim() : "",
      embyUserId,
      targetCookieName,
      targetPath: typeof item.targetPath === "string" && item.targetPath.trim()
      ? item.targetPath.trim()
      : "/sha1cache",
      enabled: item.enabled !== false
    });
  }

  return normalized;
}

function ensureUniqueId(raw: string, used: Set<string>, fallbackIndex: number): string {
  const base = raw || `emby-${fallbackIndex}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let index = 2;
  while (used.has(`${base}-${index}`)) {
    index += 1;
  }
  const id = `${base}-${index}`;
  used.add(id);
  return id;
}
