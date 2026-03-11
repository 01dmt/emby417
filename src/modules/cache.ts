export interface CacheEntry {
  url: string;
  sourcePath: string;
  mediaSourceId?: string;
  pickcode?: string;
  userId?: string;
  headers: Record<string, string>;
  createdAt: string;
  expiresAt: number;
}

export interface CacheRecord extends CacheEntry {
  key: string;
}

export class LinkCache {
  private store = new Map<string, CacheEntry>();

  private sweepExpired() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  get(key: string): CacheEntry | undefined {
    this.sweepExpired();
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    return entry;
  }

  set(
    key: string,
    payload: {
      url: string;
      sourcePath: string;
      mediaSourceId?: string;
      pickcode?: string;
      userId?: string;
      headers: Record<string, string>;
    },
    ttlSeconds: number
  ): CacheEntry {
    const now = Date.now();
    const entry = {
      url: payload.url,
      sourcePath: payload.sourcePath,
      mediaSourceId: String(payload.mediaSourceId || "").trim(),
      pickcode: payload.pickcode,
      userId: payload.userId,
      headers: payload.headers,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + ttlSeconds * 1000
    };
    this.store.set(key, entry);
    return entry;
  }

  clear() {
    this.store.clear();
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  size(): number {
    this.sweepExpired();
    return this.store.size;
  }

  list(offset = 0, limit = 20): { total: number; items: CacheRecord[] } {
    this.sweepExpired();
    const rows: CacheRecord[] = [];
    for (const [key, entry] of this.store.entries()) {
      rows.push({ key, ...entry });
    }
    rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
    return {
      total: rows.length,
      items: rows.slice(safeOffset, safeOffset + safeLimit)
    };
  }
}

export function makeDirectLinkCacheKey(payload: {
  path: string;
  userAgent: string;
  userId: string;
  mediaSourceId?: string;
}): string {
  const sourcePath = String(payload.path || "").trim();
  const userAgent = String(payload.userAgent || "").trim();
  const userId = String(payload.userId || "").trim();
  const mediaSourceId = String(payload.mediaSourceId || "").trim();
  return [
    sourcePath,
    `ua=${userAgent}`,
    `uid=${userId}`,
    `msid=${mediaSourceId}`
  ].join("::");
}
