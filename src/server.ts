import fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { loadConfig, saveConfig, AppConfig, CookieAutoDeleteConfig, CookieProfile } from "./modules/config.js";
import { syncCaddyConfig } from "./modules/caddy.js";
import { LinkCache } from "./modules/cache.js";
import { RequestLogStore } from "./modules/logger.js";
import { P115Client } from "./modules/p115client.js";
import { MediaSourceCache, FolderIdCache } from "./modules/mediaCache.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerPlayRoutes } from "./routes/play.js";

const app = fastify({
  logger: true
});

function resolveWebUiPort(): number {
  const raw = String(process.env.WEB_UI_PORT || "8417").trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return 8417;
  }
  return parsed;
}

function resolveCanonicalHost(): string {
  return String(process.env.CANONICAL_HOST || "").trim().toLowerCase();
}

const startedAt = Date.now();
let config: AppConfig = await loadConfig();

const cache = new LinkCache();
const mediaCache = new MediaSourceCache();
const folderIdCache = new FolderIdCache();
const logs = new RequestLogStore(config.logging.retainLimit);
const client = new P115Client({
  baseUrl: config.p115.baseUrl,
  authToken: config.p115.authToken,
  cookies: config.p115.cookies,
  userAgent: config.p115.userAgent,
  downloadPath: config.p115.downloadPath,
  pathPrefixRules: config.p115.pathPrefixRules,
  extraHeaders: config.p115.extraHeaders
});

const autoDeleteRunState = new Map<string, { lastMinuteKey: string; running: boolean }>();
const autoDeleteTimer = setInterval(() => {
  void runAutoDeleteTick();
}, 15000);

app.register(cors, { origin: true });

const host = process.env.HOST ?? "127.0.0.1";
const webUiPort = resolveWebUiPort();
const canonicalHost = resolveCanonicalHost();

app.addHook("onRequest", async (request, reply) => {
  if (!canonicalHost) {
    return;
  }
  const rawHost = String(request.headers.host || "").trim().toLowerCase();
  const requestHost = rawHost.split(":")[0] || String(request.hostname || "").trim().toLowerCase();
  if (!requestHost || requestHost === canonicalHost) {
    return;
  }
  const rawPath = String(request.raw.url || request.url || "/").trim() || "/";
  const targetUrl = new URL(rawPath.startsWith("/") ? rawPath : `/${rawPath}`, `${request.protocol}://${canonicalHost}:${webUiPort}`);
  reply.redirect(308, targetUrl.toString());
});

app.register(fastifyStatic, {
  root: path.resolve("public"),
  prefix: "/admin/"
});

app.get("/", async (_request, reply) => {
  reply.redirect("/admin/");
});

await registerApiRoutes(app, {
  getConfig: () => config,
  setConfig: async (next) => {
    await syncCaddyConfig(next);
    config = next;
    await saveConfig(next);
  },
  cache,
  logs,
  client,
  startedAt
});

await registerPlayRoutes(app, {
  getConfig: () => config,
  cache,
  mediaCache,
  folderIdCache,
  logs,
  client
});

await syncCaddyConfig(config);

try {
  await app.listen({ port: webUiPort, host });
  app.log.info(`Emby WebUI listening on ${host}:${webUiPort}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

const shutdown = async () => {
  clearInterval(autoDeleteTimer);
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

async function runAutoDeleteTick() {
  const profiles = Array.isArray(config.p115.cookieProfiles) ? config.p115.cookieProfiles : [];
  const activeNames = new Set(profiles.map((item) => item.name));
  for (const key of autoDeleteRunState.keys()) {
    if (!activeNames.has(key)) {
      autoDeleteRunState.delete(key);
    }
  }

  const now = new Date();
  const minuteKey = toMinuteKey(now);

  for (const profile of profiles) {
    const profileName = profile.name || "unknown";
    const settings = profile.autoDelete;
    if (!settings || !settings.enabled) {
      continue;
    }
    if (!profile.cookies.trim()) {
      continue;
    }
    if (!settings.directories || settings.directories.length === 0) {
      continue;
    }
    if (!cronMatches(settings.cron, now)) {
      continue;
    }

    const state = autoDeleteRunState.get(profileName) ?? { lastMinuteKey: "", running: false };
    if (state.running || state.lastMinuteKey === minuteKey) {
      continue;
    }

    state.running = true;
    state.lastMinuteKey = minuteKey;
    autoDeleteRunState.set(profileName, state);

    void runAutoDeleteForProfile(profile, settings)
      .catch((error) => {
        app.log.error({ err: error, profile: profileName }, "auto-delete run failed");
      })
      .finally(() => {
        const nextState = autoDeleteRunState.get(profileName);
        if (nextState) {
          nextState.running = false;
          autoDeleteRunState.set(profileName, nextState);
        }
      });
  }
}

async function runAutoDeleteForProfile(profile: CookieProfile, settings: CookieAutoDeleteConfig) {
  const profileName = profile.name || "unknown";
  app.log.info({ profile: profileName, cron: settings.cron, directories: settings.directories.length }, "auto-delete run started");
  const result = await client.cleanupDirectories({
    directories: settings.directories,
    safeCode: settings.safeCode,
    cookieOverride: profile.cookies,
    requestUserAgent: config.p115.userAgent
  });
  if (!result.ok || result.errors.length > 0) {
    app.log.warn({
      profile: profileName,
      ok: result.ok,
      deletedCount: result.deletedCount,
      recycleCleared: result.recycleCleared,
      errors: result.errors
    }, "auto-delete run completed with warnings");
    return;
  }
  app.log.info({
    profile: profileName,
    deletedCount: result.deletedCount,
    recycleCleared: result.recycleCleared,
    directories: result.directories
  }, "auto-delete run completed");
}

function toMinuteKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}`;
}

function cronMatches(cron: string, date: Date): boolean {
  const parts = String(cron || "").trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }
  const [minuteExpr, hourExpr, dayExpr, monthExpr, weekExpr] = parts;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const week = date.getDay();

  if (!matchCronField(minuteExpr, minute, 0, 59)) {
    return false;
  }
  if (!matchCronField(hourExpr, hour, 0, 23)) {
    return false;
  }
  if (!matchCronField(monthExpr, month, 1, 12)) {
    return false;
  }

  const dayWildcard = dayExpr.trim() === "*";
  const weekWildcard = weekExpr.trim() === "*";
  const dayMatch = matchCronField(dayExpr, day, 1, 31);
  const weekMatch = matchCronField(weekExpr, week, 0, 7, true);

  if (dayWildcard && weekWildcard) {
    return true;
  }
  if (dayWildcard) {
    return weekMatch;
  }
  if (weekWildcard) {
    return dayMatch;
  }
  return dayMatch || weekMatch;
}

function matchCronField(
  expression: string,
  value: number,
  min: number,
  max: number,
  mapSunday = false
): boolean {
  const source = expression.trim();
  if (!source) {
    return false;
  }

  const normalizedValue = mapSunday && value === 0 ? 7 : value;
  const segments = source.split(",").map((item) => item.trim()).filter(Boolean);
  if (segments.length === 0) {
    return false;
  }

  return segments.some((segment) => matchCronSegment(segment, normalizedValue, min, max, mapSunday));
}

function matchCronSegment(
  segment: string,
  value: number,
  min: number,
  max: number,
  mapSunday: boolean
): boolean {
  if (segment === "*") {
    return true;
  }

  const stepSplit = segment.split("/");
  if (stepSplit.length > 2) {
    return false;
  }

  const rawBase = stepSplit[0].trim();
  const step = stepSplit.length === 2 ? parsePositiveInt(stepSplit[1]) : 1;
  if (!step || step <= 0) {
    return false;
  }

  let start = min;
  let end = max;
  if (rawBase !== "*" && rawBase.length > 0) {
    if (rawBase.includes("-")) {
      const [leftRaw, rightRaw] = rawBase.split("-", 2);
      const left = parseCronValue(leftRaw, min, max, mapSunday);
      const right = parseCronValue(rightRaw, min, max, mapSunday);
      if (left === null || right === null || left > right) {
        return false;
      }
      start = left;
      end = right;
    } else {
      const single = parseCronValue(rawBase, min, max, mapSunday);
      if (single === null) {
        return false;
      }
      start = single;
      end = single;
    }
  }

  if (value < start || value > end) {
    return false;
  }
  return ((value - start) % step) === 0;
}

function parseCronValue(raw: string, min: number, max: number, mapSunday: boolean): number | null {
  const parsed = parsePositiveInt(raw);
  if (parsed === null) {
    return null;
  }
  if (mapSunday && parsed === 0) {
    return 7;
  }
  if (parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

function parsePositiveInt(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return Number.parseInt(text, 10);
}
