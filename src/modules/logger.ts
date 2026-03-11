import { promises as fs } from "node:fs";
import { runtimePaths } from "./runtime_paths.js";

export interface RequestLog {
  id: string;
  trace_id?: string;
  time: string;
  route: string;
  strategy: string;
  cached: boolean;
  status: number;
  message: string;
  detail?: {
    requestRaw?: string;
    headers?: Record<string, string>;
    extracted?: Record<string, string>;
    embySource?: string;
    directUrl?: string;
    cacheKey?: string;
    cacheNo?: string;
    cacheSource?: string;
    cacheCreatedAt?: string;
    cacheHeaders?: Record<string, string>;
    trace_summary?: {
      trace_id: string;
      stage_count: number;
      elapsed_ms: number;
    };
    events?: Array<{
      trace_id?: string;
      stage?: string;
      event?: string;
      status?: "ok" | "skip" | "error";
      label: string;
      at: string;
      clock: string;
      sinceStartMs: number;
      data?: Record<string, string>;
    }>;
  };
}

const logDir = runtimePaths.appLogDir;
const logFile = runtimePaths.logFilePath;

export class RequestLogStore {
  private buffer: RequestLog[] = [];
  private retainLimit: number;

  constructor(retainLimit: number) {
    this.retainLimit = retainLimit;
  }

  async append(entry: RequestLog) {
    this.buffer.unshift(entry);
    if (this.buffer.length > this.retainLimit) {
      this.buffer = this.buffer.slice(0, this.retainLimit);
    }
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  list(offset = 0, limit = 100): RequestLog[] {
    const page = this.buffer.slice(offset, offset + limit);
    if (page.length === 0) {
      return [];
    }

    const traceIds = new Set(page.map((item) => this.resolveTraceId(item)).filter(Boolean));
    if (traceIds.size === 0) {
      return page;
    }

    const selectedIds = new Set(page.map((item) => item.id));
    const expanded = page.slice();
    for (const item of this.buffer) {
      if (selectedIds.has(item.id)) {
        continue;
      }
      const traceId = this.resolveTraceId(item);
      if (!traceId || !traceIds.has(traceId)) {
        continue;
      }
      expanded.push(item);
    }

    return expanded;
  }

  async clear(): Promise<void> {
    this.buffer = [];
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(logFile, "", "utf-8");
  }

  size(): number {
    return this.buffer.length;
  }

  countFastTransferSuccess(): number {
    return this.buffer.reduce((count, item) => {
      const message = typeof item.message === "string" ? item.message : "";
      if (!message.includes("秒传成功")) {
        return count;
      }
      return count + 1;
    }, 0);
  }

  updateLimit(next: number) {
    this.retainLimit = next;
    if (this.buffer.length > next) {
      this.buffer = this.buffer.slice(0, next);
    }
  }

  private resolveTraceId(item: RequestLog): string {
    const top = typeof item.trace_id === "string" ? item.trace_id.trim() : "";
    if (top) {
      return top;
    }
    const nested = typeof item.detail?.trace_summary?.trace_id === "string"
      ? item.detail.trace_summary.trace_id.trim()
      : "";
    if (nested) {
      return nested;
    }
    if (Array.isArray(item.detail?.events)) {
      const eventTrace = item.detail.events.find((event) => typeof event?.trace_id === "string" && event.trace_id.trim());
      if (eventTrace?.trace_id) {
        return eventTrace.trace_id.trim();
      }
    }
    return "";
  }
}