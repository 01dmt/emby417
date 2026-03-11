export interface FastTransferParams {
  sourceCookie: string;
  sourcePickcode: string;
  targetCookie: string;
  targetPath: string;
  targetFileName?: string;
  timeoutMs?: number;
}

export interface FastTransferResult {
  ok: boolean;
  target_url?: string;
  target_pickcode?: string;
  source_pickcode?: string;
  error?: string;
  source_uid?: string;
  target_uid?: string;
  file_name?: string;
  file_size?: number;
  file_sha1?: string;
  range_verified?: boolean;
}

const bridgeBaseUrl = (process.env.P115_BRIDGE_BASE_URL || "http://127.0.0.1:8115").trim();
const maxConcurrentTransfers = 2;
let activeTransfers = 0;
const transferQueue: Array<() => void> = [];

export async function runFastTransferByPickcode(
  params: FastTransferParams
): Promise<FastTransferResult> {
  const timeoutMs = Number.isFinite(params.timeoutMs)
    ? Math.max(5000, Math.floor(params.timeoutMs as number))
    : 60000;

  await acquireTransferSlot();
  try {
    const endpoint = new URL("/api/tool/fast-transfer", bridgeBaseUrl).toString();
    const targetDirPath = String(params.targetPath || "/sha1cache").trim() || "/sha1cache";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          cookie_a: params.sourceCookie,
          pickcode_a: params.sourcePickcode,
          cookie_b: params.targetCookie,
          path_b: targetDirPath,
          target_path: targetDirPath,
          path_b_dir: targetDirPath,
          filename: params.targetFileName || "",
          file_name_b: params.targetFileName || "",
          file_name: params.targetFileName || "",
          target_name: params.targetFileName || "",
          new_name: params.targetFileName || "",
          name: params.targetFileName || "",
          name_b: params.targetFileName || "",
          target_file_name: params.targetFileName || ""
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          ok: false,
          error: `内部秒传接口错误 ${response.status}: ${truncate(text, 400)}`
        };
      }

      const payload = (await response.json()) as Record<string, unknown>;
      return {
        ok: Boolean(payload.ok),
        target_pickcode: pickString(payload.target_pickcode),
        source_pickcode: pickString(payload.source_pickcode),
        target_url: pickString(payload.target_url),
        error: pickString(payload.error),
        source_uid: pickString(payload.source_uid),
        target_uid: pickString(payload.target_uid),
        file_name: pickString(payload.file_name),
        file_size: pickNumber(payload.file_size),
        file_sha1: pickString(payload.file_sha1),
        range_verified: Boolean(payload.range_verified)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal fast transfer request failed";
      return {
        ok: false,
        error: message
      };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    releaseTransferSlot();
  }
}

function pickString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pickNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function acquireTransferSlot(): Promise<void> {
  if (activeTransfers < maxConcurrentTransfers) {
    activeTransfers += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    transferQueue.push(() => {
      activeTransfers += 1;
      resolve();
    });
  });
}

function releaseTransferSlot() {
  activeTransfers = Math.max(0, activeTransfers - 1);
  const next = transferQueue.shift();
  if (next) {
    next();
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...`;
}
