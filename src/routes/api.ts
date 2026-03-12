import { FastifyInstance } from "fastify";
import { AppConfig, PlaybackStrategy, getActiveEmbyServer, mergeConfig } from "../modules/config.js";
import { LinkCache } from "../modules/cache.js";
import { RequestLogStore } from "../modules/logger.js";
import { resolveDirectLink } from "../modules/proxy.js";
import { P115Client } from "../modules/p115client.js";
import { getRuntimeStatus } from "../modules/status.js";

export interface ApiDeps {
  getConfig: () => AppConfig;
  setConfig: (next: AppConfig) => Promise<void>;
  cache: LinkCache;
  logs: RequestLogStore;
  client: P115Client;
  startedAt: number;
}

export async function registerApiRoutes(app: FastifyInstance, deps: ApiDeps) {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/config", async () => deps.getConfig());

  app.put("/api/config", async (request, reply) => {
    const current = deps.getConfig();
    const patch = request.body as Partial<AppConfig>;
    const next = mergeConfig(current, patch);
    await deps.setConfig(next);
    deps.logs.updateLimit(next.logging.retainLimit);
    deps.client.update({
      baseUrl: next.p115.baseUrl,
      authToken: next.p115.authToken,
      cookies: next.p115.cookies,
      userAgent: next.p115.userAgent,
      downloadPath: next.p115.downloadPath,
      pathPrefixRules: next.p115.pathPrefixRules,
      extraHeaders: next.p115.extraHeaders
    });
    reply.send(next);
  });

  app.post("/api/cache/clear", async () => {
    deps.cache.clear();
    return { ok: true };
  });

  app.post("/api/cache/delete", async (request, reply) => {
    const body = request.body as { key?: string };
    const key = (body?.key || "").trim();
    if (!key) {
      reply.status(400).send({ ok: false, error: "key is required" });
      return;
    }
    const removed = deps.cache.delete(key);
    reply.send({ ok: removed });
  });

  app.get("/api/cache", async (request) => {
    const { offset = "0", limit = "20" } = request.query as Record<string, string>;
    const parsedOffset = Number.parseInt(offset, 10);
    const parsedLimit = Number.parseInt(limit, 10);
    const safeOffset = Number.isNaN(parsedOffset) ? 0 : Math.max(0, parsedOffset);
    const safeLimit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(1, parsedLimit), 100);
    const listed = deps.cache.list(safeOffset, safeLimit);
    const now = Date.now();
    return {
      total: listed.total,
      offset: safeOffset,
      limit: safeLimit,
      items: listed.items.map((item) => ({
        key: item.key,
        sourcePath: item.sourcePath,
        directUrl: item.url,
        userId: item.userId || "",
        createdAt: item.createdAt,
        expiresAt: new Date(item.expiresAt).toISOString(),
        validSeconds: Math.max(0, Math.floor((item.expiresAt - now) / 1000)),
        headers: item.headers
      }))
    };
  });

  app.get("/api/logs", async (request, reply) => {
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
    reply.header("Pragma", "no-cache");
    reply.header("Expires", "0");
    const { offset = "0", limit = "100" } = request.query as Record<string, string>;
    const offsetNumber = Number.parseInt(offset, 10);
    const limitNumber = Number.parseInt(limit, 10);
    const safeOffset = Number.isNaN(offsetNumber) ? 0 : Math.max(0, offsetNumber);
    const maxLimit = Math.max(1, deps.getConfig().logging.retainLimit);
    const safeLimit = Number.isNaN(limitNumber)
      ? Math.min(100, maxLimit)
      : Math.min(Math.max(1, limitNumber), maxLimit);
    return deps.logs.list(
      safeOffset,
      safeLimit
    );
  });

  app.post("/api/logs/clear", async () => {
    await deps.logs.clear();
    return { ok: true };
  });

  app.get("/api/status", async () => {
    const config = deps.getConfig();
    const cookieCount = Array.isArray(config.p115.cookieProfiles)
      ? config.p115.cookieProfiles.length
      : 0;
    const userCount = await countActiveEmbyUsers(config);
    const fastTransferSuccessCount = deps.logs.countFastTransferSuccess();
    return getRuntimeStatus({
      startedAt: deps.startedAt,
      cacheSize: deps.cache.size(),
      logSize: deps.logs.size(),
      cookieCount,
      userCount,
      fastTransferSuccessCount
    });
  });

  app.post("/api/emby/test", async (request, reply) => {
    const body = request.body as {
      serverUrl?: string;
      apiKey?: string;
    };
    const activeServer = getActiveEmbyServer(deps.getConfig());
    const serverUrl = (body.serverUrl ?? activeServer.serverUrl ?? "").trim();
    const apiKey = (body.apiKey ?? activeServer.apiKey ?? "").trim();

    if (!serverUrl) {
      reply.status(400).send({
        ok: false,
        error: "serverUrl is required"
      });
      return;
    }

    let base: URL;
    try {
      base = new URL(serverUrl);
    } catch (_error) {
      reply.status(400).send({
        ok: false,
        error: "invalid serverUrl"
      });
      return;
    }

    if (base.protocol !== "http:" && base.protocol !== "https:") {
      reply.status(400).send({
        ok: false,
        error: "serverUrl must use http or https"
      });
      return;
    }

    const basePath = base.pathname.endsWith("/")
      ? base.pathname.slice(0, -1)
      : base.pathname;
    const infoWithKey = new URL(base.toString());
    infoWithKey.pathname = `${basePath}/System/Info`;
    const publicInfo = new URL(base.toString());
    publicInfo.pathname = `${basePath}/System/Info/Public`;
    if (apiKey) {
      infoWithKey.searchParams.set("api_key", apiKey);
    }

    const candidates = apiKey
      ? [
          { url: infoWithKey.toString(), useTokenHeader: true },
          { url: publicInfo.toString(), useTokenHeader: false }
        ]
      : [{ url: publicInfo.toString(), useTokenHeader: false }];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let lastError = "";

    try {
      for (const candidate of candidates) {
        const headers: Record<string, string> = {
          accept: "application/json"
        };
        if (candidate.useTokenHeader && apiKey) {
          headers["X-Emby-Token"] = apiKey;
        }

        try {
          const response = await fetch(candidate.url, {
            method: "GET",
            headers,
            signal: controller.signal
          });

          const text = await response.text();
          if (!response.ok) {
            lastError = `${response.status} ${text.slice(0, 180)}`.trim();
            continue;
          }

          let payload: Record<string, unknown> = {};
          try {
            payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch (_error) {
            payload = {};
          }

          reply.send({
            ok: true,
            endpoint: candidate.url,
            public: !candidate.useTokenHeader,
            status: response.status,
            serverName: typeof payload.ServerName === "string" ? payload.ServerName : null,
            version: typeof payload.Version === "string" ? payload.Version : null,
            id: typeof payload.Id === "string" ? payload.Id : null
          });
          return;
        } catch (error) {
          lastError = error instanceof Error ? error.message : "request failed";
        }
      }

      reply.status(400).send({
        ok: false,
        error: lastError || "cannot connect to emby server"
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  app.get("/api/emby/users", async (request, reply) => {
    const query = request.query as { serverId?: string };
    const config = deps.getConfig();
    const targetServer = query?.serverId
      ? config.emby.servers.find((item) => item.id === query.serverId && item.enabled)
      : getActiveEmbyServer(config);

    if (!targetServer || !targetServer.serverUrl) {
      reply.status(400).send({ ok: false, error: "emby server not configured" });
      return;
    }

    const apiKey = (targetServer.apiKey || "").trim();
    if (!apiKey) {
      reply.status(400).send({ ok: false, error: "emby api key is required" });
      return;
    }

    let base: URL;
    try {
      base = new URL(targetServer.serverUrl);
    } catch (_error) {
      reply.status(400).send({ ok: false, error: "invalid emby server url" });
      return;
    }

    const endpoint = new URL("Users", base);
    endpoint.searchParams.set("api_key", apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(endpoint.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          "X-Emby-Token": apiKey
        },
        signal: controller.signal
      });

      const text = await response.text();
      if (!response.ok) {
        reply.status(400).send({
          ok: false,
          error: `${response.status} ${text.slice(0, 200)}`.trim()
        });
        return;
      }

      let payload: unknown = [];
      try {
        payload = text ? JSON.parse(text) : [];
      } catch (_error) {
        payload = [];
      }

      const users = Array.isArray(payload)
        ? payload.map((item) => {
            const record = item as Record<string, unknown>;
            const policy = (record.Policy || {}) as Record<string, unknown>;
            return {
              id: typeof record.Id === "string" ? record.Id : "",
              name: typeof record.Name === "string" ? record.Name : "",
              hasPassword: Boolean(record.HasPassword),
              disabled: Boolean(policy.IsDisabled),
              administrator: Boolean(policy.IsAdministrator),
              lastActivityDate:
                typeof record.LastActivityDate === "string"
                  ? record.LastActivityDate
                  : ""
            };
          })
        : [];

      reply.send({
        ok: true,
        serverId: targetServer.id,
        serverName: targetServer.name,
        total: users.length,
        users
      });
    } catch (error) {
      reply.status(400).send({
        ok: false,
        error: error instanceof Error ? error.message : "request failed"
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  app.post("/api/resolve", async (request, reply) => {
    const body = request.body as {
      strmPath?: string;
      strmContent?: string;
      strategy?: PlaybackStrategy;
    };
    try {
      const result = await resolveDirectLink({
        options: {
          strmPath: body.strmPath,
          strmContent: body.strmContent,
          forceStrategy: body.strategy
        },
        config: deps.getConfig(),
        cache: deps.cache,
        client: deps.client
      });
      reply.send(result);
    } catch (error) {
      reply.status(400).send({
        error: error instanceof Error ? error.message : "resolve failed"
      });
    }
  });

  app.post("/api/p115/check-cookie", async (request, reply) => {
    const body = request.body as { cookies?: string; profileName?: string; profileId?: string };
    const cookies = (body?.cookies || "").trim();
    if (!cookies) {
      reply.status(400).send({ ok: false, message: "cookies is required" });
      return;
    }

    const config = deps.getConfig();
    const endpointUrl = new URL("https://proapi.115.com/android/2.0/ufile/files");
    endpointUrl.searchParams.set("aid", "1");
    endpointUrl.searchParams.set("count_folders", "1");
    endpointUrl.searchParams.set("limit", "1");
    endpointUrl.searchParams.set("offset", "0");
    endpointUrl.searchParams.set("record_open_time", "1");
    endpointUrl.searchParams.set("show_dir", "1");
    endpointUrl.searchParams.set("cid", "0");
    endpointUrl.searchParams.set("asc", "1");
    endpointUrl.searchParams.set("fc_mix", "1");
    endpointUrl.searchParams.set("o", "user_ptime");
    endpointUrl.searchParams.set("cur", "1");
    endpointUrl.searchParams.set("custom_order", "2");
    const endpoint = endpointUrl.toString();
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          cookie: cookies,
          "user-agent": config.p115.userAgent || "Emby302Proxy/0.1"
        }
      });
      const text = await response.text();
      const parsed = safeParseJson(text);
      const analysis = analyzeCookieStatus(response.status, text, parsed);

      reply.send({
        ok: true,
        profileName: body?.profileName || "",
        profileId: body?.profileId || "",
        cookieFingerprint: buildCookieFingerprint(cookies),
        expired: analysis.expired,
        riskControlled: analysis.riskControlled,
        message: analysis.message,
        endpoint,
        status: response.status,
        raw: parsed ?? text
      });
    } catch (error) {
      reply.status(502).send({
        ok: false,
        message: error instanceof Error ? error.message : "auth check failed"
      });
    }
  });

  app.post("/api/p115/profile-summary", async (request, reply) => {
    const body = request.body as { profileName?: string };
    const profileName = (body?.profileName || "").trim();
    if (!profileName) {
      reply.status(400).send({ ok: false, error: "profileName is required" });
      return;
    }

    const config = deps.getConfig();
    const profile = config.p115.cookieProfiles.find((item) => item.name === profileName);
    const cookies = (profile?.cookies || "").trim();
    if (!cookies) {
      reply.status(404).send({ ok: false, error: "cookie profile not found" });
      return;
    }

    const endpoint = "https://proapi.115.com/app/user/info";
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          cookie: cookies,
          "user-agent": config.p115.userAgent || "Emby302Proxy/0.1"
        }
      });

      const text = await response.text();
      const parsed = safeParseJson(text);
      if (!response.ok || !parsed) {
        reply.status(502).send({
          ok: false,
          error: `获取账号信息失败: ${response.status}`
        });
        return;
      }

      const userName = firstText(parsed, ["user_name", "nickname", "name", "nick_name"]);
      const avatarUrl = firstText(parsed, ["face_l", "face_m", "face_s", "face"]);
      const vipRaw = firstNumber(parsed, ["vip", "is_vip", "forever"]);
      const vip = vipRaw > 0;
      const forever = firstNumber(parsed, ["forever"]) > 0;
      const remain = firstNumber(parsed, ["space.size_remain", "space_remain"]);
      const total = firstNumber(parsed, ["space.size_total", "space_total"]);

      reply.send({
        ok: true,
        profileName,
        userName: userName || profileName,
        avatarUrl,
        vip,
        forever,
        remainBytes: remain,
        totalBytes: total
      });
    } catch (error) {
      reply.status(502).send({
        ok: false,
        error: error instanceof Error ? error.message : "获取账号信息失败"
      });
    }
  });

  app.post("/api/p115/cleanup-now", async (request, reply) => {
    const body = request.body as {
      profileName?: string;
      cookies?: string;
      directories?: string[];
      safeCode?: string;
    };

    const profileName = (body?.profileName || "").trim();
    const cookies = (body?.cookies || "").trim();
    const directories = Array.isArray(body?.directories)
      ? Array.from(new Set(body.directories.map((item) => String(item || "").trim()).filter(Boolean)))
      : [];
    const safeCode = String(body?.safeCode || "").replace(/\D+/g, "").slice(0, 6);

    if (!cookies) {
      reply.status(400).send({ ok: false, error: "cookies is required" });
      return;
    }
    if (directories.length === 0) {
      reply.status(400).send({ ok: false, error: "directories is required" });
      return;
    }

    try {
      const result = await deps.client.cleanupDirectories({
        directories,
        safeCode,
        cookieOverride: cookies,
        requestUserAgent: deps.getConfig().p115.userAgent
      });
      reply.send({
        ok: result.ok,
        profileName,
        deletedCount: result.deletedCount,
        directories: result.directories,
        recycleCleared: result.recycleCleared,
        errors: result.errors
      });
    } catch (error) {
      reply.status(502).send({
        ok: false,
        error: error instanceof Error ? error.message : "cleanup failed"
      });
    }
  });

  app.post("/api/p115/qr-login/start", async (request, reply) => {
    const body = request.body as { app?: string };
    try {
      const result = await deps.client.startQrLogin((body?.app || "").trim() || "android");
      reply.send({
        ok: true,
        sessionId: result.sessionId,
        app: result.app,
        uid: result.uid,
        qrcodeUrl: result.qrcodeUrl,
        imageDataUrl: result.imageDataUrl,
        expiresIn: result.expiresIn
      });
    } catch (error) {
      reply.status(502).send({
        ok: false,
        error: error instanceof Error ? error.message : "qr login start failed"
      });
    }
  });

  app.post("/api/p115/qr-login/poll", async (request, reply) => {
    const body = request.body as { sessionId?: string };
    const sessionId = (body?.sessionId || "").trim();
    if (!sessionId) {
      reply.status(400).send({ ok: false, error: "sessionId is required" });
      return;
    }

    try {
      const result = await deps.client.pollQrLogin(sessionId);
      reply.send({
        ok: true,
        sessionId: result.sessionId,
        app: result.app,
        uid: result.uid,
        status: result.status,
        message: result.message,
        cookies: result.cookies,
        data: result.data
      });
    } catch (error) {
      reply.status(502).send({
        ok: false,
        error: error instanceof Error ? error.message : "qr login poll failed"
      });
    }
  });
}

async function countActiveEmbyUsers(config: AppConfig): Promise<number> {
  const targetServer = getActiveEmbyServer(config);
  const serverUrl = (targetServer?.serverUrl || "").trim();
  const apiKey = (targetServer?.apiKey || "").trim();
  if (!serverUrl || !apiKey) {
    return 0;
  }

  let base: URL;
  try {
    base = new URL(serverUrl);
  } catch (_error) {
    return 0;
  }

  const endpoint = new URL("Users", base);
  endpoint.searchParams.set("api_key", apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "X-Emby-Token": apiKey
      },
      signal: controller.signal
    });
    if (!response.ok) {
      return 0;
    }
    const text = await response.text();
    let payload: unknown = [];
    try {
      payload = text ? JSON.parse(text) : [];
    } catch (_error) {
      payload = [];
    }
    return Array.isArray(payload) ? payload.length : 0;
  } catch (_error) {
    return 0;
  } finally {
    clearTimeout(timeout);
  }
}

function buildCookieFingerprint(cookieText: string): string {
  const text = cookieText.trim();
  if (!text) {
    return "len=0";
  }
  const head = text.slice(0, 10);
  const tail = text.slice(-6);
  return `len=${text.length};${head}...${tail}`;
}

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch (_error) {
    return null;
  }
}

function analyzeCookieStatus(
  statusCode: number,
  rawText: string,
  parsed: Record<string, unknown> | null
): { expired: boolean; riskControlled: boolean; message: string } {
  const state = typeof parsed?.state === "boolean" ? parsed.state : undefined;
  const errno = typeof parsed?.errno === "number" ? parsed.errno : undefined;
  const errorText = typeof parsed?.error === "string" ? parsed.error : "";
  if (state === true) {
    return { expired: false, riskControlled: false, message: "账号状态正常" };
  }

  const lower = [
    rawText,
    errorText,
    stringifyUnknown(parsed)
  ].join("\n").toLowerCase();

  const expiredKeywords = [
    "过期",
    "失效",
    "cookie expired",
    "not login",
    "invalid cookie",
    "unauthorized",
    "请先登录",
    "请登录",
    "login required",
    "re-login",
    "forbidden"
  ];
  const riskKeywords = [
    "风控",
    "risk",
    "验证码",
    "安全验证",
    "限制",
    "blocked",
    "threats to the server",
    "traceid"
  ];

  const expired = statusCode === 401 || expiredKeywords.some((item) => lower.includes(item));
  const riskControlled = riskKeywords.some((item) => lower.includes(item));

  if (errno === 99) {
    return { expired: true, riskControlled: false, message: "Cookies 已过期" };
  }

  if (expired) {
    return { expired: true, riskControlled, message: "Cookies 已过期" };
  }
  if (riskControlled) {
    return { expired: false, riskControlled: true, message: "账号疑似风控" };
  }
  if (state === false) {
    return {
      expired: false,
      riskControlled: false,
      message: errorText || "账号未登录或状态异常"
    };
  }
  if (statusCode >= 200 && statusCode < 300) {
    return { expired: false, riskControlled: false, message: "账号状态正常" };
  }
  return {
    expired: false,
    riskControlled: false,
    message: `检测接口响应 ${statusCode}`
  };
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return "";
  }
}

function firstText(data: Record<string, unknown>, paths: string[]): string {
  for (const path of paths) {
    const value = readByPath(data, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function firstNumber(data: Record<string, unknown>, paths: string[]): number {
  for (const path of paths) {
    const value = readByPath(data, path);
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return 0;
}

function readByPath(data: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  let current: unknown = data;
  for (const segment of segments) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    current = record[segment];
  }
  return current;
}
