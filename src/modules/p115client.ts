
export interface P115ClientOptions {
  baseUrl: string;
  authToken: string;
  cookies: string;
  userAgent: string;
  downloadPath: string;
  pathPrefixRules: string;
  extraHeaders: string;
}

export interface P115DownloadResult {
  url: string;
  raw: unknown;
}

export interface P115PickcodeResult {
  pickcode: string;
  path: string;
  raw: unknown;
}

export interface P115CleanupDirectoriesOptions {
  directories: string[];
  safeCode: string;
  cookieOverride?: string;
  requestUserAgent?: string;
}

export interface P115CleanupDirectoriesResult {
  ok: boolean;
  deletedCount: number;
  recycleCleared: boolean;
  directories: number;
  errors: string[];
  raw: unknown;
}

export interface P115QrLoginStartResult {
  sessionId: string;
  app: string;
  uid: string;
  qrcodeUrl: string;
  imageDataUrl: string;
  expiresIn: number;
  raw: unknown;
}

export interface P115QrLoginPollResult {
  sessionId: string;
  app: string;
  uid: string;
  status: string;
  message: string;
  cookies: string;
  data: unknown;
}

export class P115Client {
  private options: P115ClientOptions;

  constructor(options: P115ClientOptions) {
    this.options = options;
  }

  update(options: P115ClientOptions) {
    this.options = options;
  }

  async getDirectLink(
    path: string,
    requestUserAgent?: string,
    pathPrefixRulesOverride?: string,
    cookieOverride?: string
  ): Promise<P115DownloadResult> {
    const endpoint = new URL(this.options.downloadPath, this.options.baseUrl).toString();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": (requestUserAgent && requestUserAgent.trim()) || this.options.userAgent
    };
    if (this.options.authToken) {
      headers.authorization = `Bearer ${this.options.authToken}`;
    }
    const cookie =
      typeof cookieOverride === "string" && cookieOverride.trim().length > 0
        ? cookieOverride.trim()
        : this.options.cookies;
    if (cookie) {
      headers.cookie = cookie;
    }
    const pathPrefixRules =
      typeof pathPrefixRulesOverride === "string"
        ? pathPrefixRulesOverride
        : "";
    if (pathPrefixRules.trim()) {
      headers["x-path-prefix-rules"] = pathPrefixRules;
    }
    if (this.options.extraHeaders.trim()) {
      headers["x-p115-extra-headers"] = JSON.stringify(parseExtraHeaders(this.options.extraHeaders));
    }

    const body = JSON.stringify({ path });
    const timeoutMs = 30000;
    const maxAttempts = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: controller.signal
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            throw new Error("p115client response missing location header");
          }
          return { url: location, raw: { location } };
        }

        if (!response.ok) {
          const text = await response.text();
          const error = new Error(`p115client error ${response.status}: ${text}`);
          if (response.status >= 500 && attempt < maxAttempts) {
            lastError = error;
            await waitMs(200 * attempt);
            continue;
          }
          throw error;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const payload = (await response.json()) as unknown;
          const url = extractUrl(payload);
          if (!url) {
            throw new Error("p115client response does not contain download url");
          }
          return { url, raw: payload };
        }

        const text = await response.text();
        const url = findUrl(text);
        if (!url) {
          throw new Error("p115client response does not contain download url");
        }
        return { url, raw: text };
      } catch (error) {
        if (attempt < maxAttempts && shouldRetry(error)) {
          lastError = toError(error);
          await waitMs(200 * attempt);
          continue;
        }
        throw enrichFetchError(error, endpoint, attempt, maxAttempts, timeoutMs);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw enrichFetchError(lastError ?? new Error("unknown fetch failure"), endpoint, maxAttempts, maxAttempts, timeoutMs);
  }

  async getPickcode(
    path: string,
    requestUserAgent?: string,
    pathPrefixRulesOverride?: string,
    cookieOverride?: string
  ): Promise<P115PickcodeResult> {
    const endpoint = new URL("/api/tool/pickcode", this.options.baseUrl).toString();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": (requestUserAgent && requestUserAgent.trim()) || this.options.userAgent
    };
    if (this.options.authToken) {
      headers.authorization = `Bearer ${this.options.authToken}`;
    }
    const cookie =
      typeof cookieOverride === "string" && cookieOverride.trim().length > 0
        ? cookieOverride.trim()
        : this.options.cookies;
    if (cookie) {
      headers.cookie = cookie;
    }
    const pathPrefixRules =
      typeof pathPrefixRulesOverride === "string"
        ? pathPrefixRulesOverride
        : "";
    if (pathPrefixRules.trim()) {
      headers["x-path-prefix-rules"] = pathPrefixRules;
    }
    if (this.options.extraHeaders.trim()) {
      headers["x-p115-extra-headers"] = JSON.stringify(parseExtraHeaders(this.options.extraHeaders));
    }

    const timeoutMs = 30000;
    const maxAttempts = 3;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ path }),
          signal: controller.signal
        });
        if (!response.ok) {
          const text = await response.text();
          const error = new Error(`p115client pickcode error ${response.status}: ${text}`);
          if (response.status >= 500 && attempt < maxAttempts) {
            lastError = error;
            await waitMs(200 * attempt);
            continue;
          }
          throw error;
        }
        const payload = (await response.json()) as Record<string, unknown>;
        const pickcode = typeof payload.pickcode === "string" ? payload.pickcode.trim() : "";
        const resolvedPath = typeof payload.path === "string" ? payload.path : path;
        return {
          pickcode,
          path: resolvedPath,
          raw: payload
        };
      } catch (error) {
        if (attempt < maxAttempts && shouldRetry(error)) {
          lastError = toError(error);
          await waitMs(200 * attempt);
          continue;
        }
        throw enrichFetchError(error, endpoint, attempt, maxAttempts, timeoutMs);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw enrichFetchError(lastError ?? new Error("unknown pickcode fetch failure"), endpoint, maxAttempts, maxAttempts, timeoutMs);
  }

  async cleanupDirectories(
    options: P115CleanupDirectoriesOptions
  ): Promise<P115CleanupDirectoriesResult> {
    const endpoint = new URL("/api/tool/cleanup-directories", this.options.baseUrl).toString();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": (options.requestUserAgent && options.requestUserAgent.trim()) || this.options.userAgent
    };

    const cookie =
      typeof options.cookieOverride === "string" && options.cookieOverride.trim().length > 0
        ? options.cookieOverride.trim()
        : this.options.cookies;
    if (cookie) {
      headers.cookie = cookie;
    }

    const body = JSON.stringify({
      cookie,
      directories: Array.from(new Set((options.directories || []).map((item) => String(item || "").trim()).filter(Boolean))),
      safe_code: String(options.safeCode || "").replace(/\D+/g, "").slice(0, 6),
      user_agent: headers["user-agent"]
    });

    const timeoutMs = 60000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal
      });
      const text = await response.text();
      let payload: Record<string, unknown> = {};
      try {
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch (_error) {
        payload = {};
      }

      if (!response.ok) {
        const detail = typeof payload?.detail === "string"
          ? payload.detail
          : text;
        throw new Error(`cleanup directories failed ${response.status}: ${detail}`);
      }

      return {
        ok: payload.ok === true,
        deletedCount: Number.isFinite(Number(payload.deleted_count)) ? Number(payload.deleted_count) : 0,
        recycleCleared: payload.recycle_cleared === true,
        directories: Number.isFinite(Number(payload.directories)) ? Number(payload.directories) : 0,
        errors: Array.isArray(payload.errors) ? payload.errors.map((item) => String(item || "")) : [],
        raw: payload
      };
    } catch (error) {
      throw enrichFetchError(error, endpoint, 1, 1, timeoutMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  async startQrLogin(appName: string): Promise<P115QrLoginStartResult> {
    const endpoint = new URL("/api/tool/qr-login/start", this.options.baseUrl).toString();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        app: String(appName || "").trim() || "android"
      })
    });
    const text = await response.text();
    const payload = safeParseRecord(text);
    if (!response.ok || !payload) {
      throw new Error(readErrorMessage(text, payload, `qr login start failed ${response.status}`));
    }
    return {
      sessionId: typeof payload.session_id === "string" ? payload.session_id : "",
      app: typeof payload.app === "string" ? payload.app : "",
      uid: typeof payload.uid === "string" ? payload.uid : "",
      qrcodeUrl: typeof payload.qrcode_url === "string" ? payload.qrcode_url : "",
      imageDataUrl: typeof payload.image_data_url === "string" ? payload.image_data_url : "",
      expiresIn: Number.isFinite(Number(payload.expires_in)) ? Number(payload.expires_in) : 300,
      raw: payload
    };
  }

  async pollQrLogin(sessionId: string): Promise<P115QrLoginPollResult> {
    const endpoint = new URL("/api/tool/qr-login/poll", this.options.baseUrl).toString();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        session_id: String(sessionId || "").trim()
      })
    });
    const text = await response.text();
    const payload = safeParseRecord(text);
    if (!response.ok || !payload) {
      throw new Error(readErrorMessage(text, payload, `qr login poll failed ${response.status}`));
    }
    return {
      sessionId: typeof payload.session_id === "string" ? payload.session_id : "",
      app: typeof payload.app === "string" ? payload.app : "",
      uid: typeof payload.uid === "string" ? payload.uid : "",
      status: typeof payload.status === "string" ? payload.status : "waiting",
      message: typeof payload.message === "string" ? payload.message : "",
      cookies: typeof payload.cookies === "string" ? payload.cookies : "",
      data: payload.data
    };
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetry(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  const message = error.message.toLowerCase();
  if (message.includes("fetch failed") || message.includes("timeout")) {
    return true;
  }
  const code = extractCauseCode(error.cause);
  return code === "ECONNREFUSED"
    || code === "ECONNRESET"
    || code === "ETIMEDOUT"
    || code === "ENOTFOUND"
    || code === "EAI_AGAIN";
}

function extractCauseCode(cause: unknown): string {
  if (!cause || typeof cause !== "object") {
    return "";
  }
  const record = cause as Record<string, unknown>;
  return typeof record.code === "string" ? record.code : "";
}

function safeParseRecord(text: string): Record<string, unknown> | null {
  try {
    const payload = text ? JSON.parse(text) : null;
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  } catch (_error) {
    return null;
  }
}

function readErrorMessage(
  text: string,
  payload: Record<string, unknown> | null,
  fallback: string
): string {
  if (payload && typeof payload.detail === "string" && payload.detail.trim()) {
    return payload.detail.trim();
  }
  if (payload && typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }
  return text.trim() || fallback;
}

function enrichFetchError(
  error: unknown,
  endpoint: string,
  attempt: number,
  maxAttempts: number,
  timeoutMs: number
): Error {
  const base = toError(error);
  const cause = readCause(base.cause);
  const parts = [
    `p115 bridge fetch failed after ${attempt}/${maxAttempts} attempts`,
    `endpoint=${endpoint}`,
    `timeoutMs=${timeoutMs}`,
    `message=${base.message}`
  ];
  if (cause.code) {
    parts.push(`causeCode=${cause.code}`);
  }
  if (cause.syscall) {
    parts.push(`syscall=${cause.syscall}`);
  }
  if (cause.address) {
    parts.push(`address=${cause.address}`);
  }
  if (cause.port) {
    parts.push(`port=${cause.port}`);
  }
  if (cause.name && cause.name !== "Error") {
    parts.push(`causeName=${cause.name}`);
  }
  if (cause.message) {
    parts.push(`causeMessage=${cause.message}`);
  }
  return new Error(parts.join("; "));
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : "unknown error");
}

function readCause(cause: unknown): {
  code: string;
  syscall: string;
  address: string;
  port: string;
  name: string;
  message: string;
} {
  if (!cause || typeof cause !== "object") {
    return {
      code: "",
      syscall: "",
      address: "",
      port: "",
      name: "",
      message: ""
    };
  }
  const record = cause as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : "",
    syscall: typeof record.syscall === "string" ? record.syscall : "",
    address: typeof record.address === "string" ? record.address : "",
    port: typeof record.port === "number" || typeof record.port === "string"
      ? String(record.port)
      : "",
    name: typeof record.name === "string" ? record.name : "",
    message: typeof record.message === "string" ? record.message : ""
  };
}

function extractUrl(payload: unknown): string | null {
  if (typeof payload === "string") {
    return findUrl(payload);
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const candidates = [
    record.url,
    record.download_url,
    record.direct_url,
    record.link,
    record.downloadUrl
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  const nested = [
    record.data,
    record.result,
    record.payload,
    record.response
  ];
  for (const item of nested) {
    if (item && typeof item === "object") {
      const nestedRecord = item as Record<string, unknown>;
      const nestedCandidates = [
        nestedRecord.url,
        nestedRecord.download_url,
        nestedRecord.direct_url,
        nestedRecord.link,
        nestedRecord.downloadUrl
      ];
      for (const candidate of nestedCandidates) {
        if (typeof candidate === "string") {
          return candidate;
        }
      }
    }
  }
  return null;
}

function findUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s"']+/i);
  return match ? match[0] : null;
}

function parseExtraHeaders(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const item = line.trim();
    if (!item || !item.includes(":")) {
      continue;
    }
    const [key, ...rest] = item.split(":");
    const value = rest.join(":").trim();
    const headerKey = key.trim();
    if (!headerKey || !value) {
      continue;
    }
    result[headerKey] = value;
  }
  return result;
}
