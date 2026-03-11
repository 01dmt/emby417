export interface MediaSourceCacheEntry {
  sourceGuid: string;
  mediaSourceId: string;
  path: string;
  pickcode: string;
  createdAt: string;
  expiresAt: number;
}

export class MediaSourceCache {
  private store = new Map<string, MediaSourceCacheEntry>();

  private sweepExpired() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  get(sourceGuid: string): MediaSourceCacheEntry | undefined {
    this.sweepExpired();
    const key = String(sourceGuid || "").trim();
    if (!key) {
      return undefined;
    }
    return this.store.get(key);
  }

  set(payload: {
    sourceGuid: string;
    mediaSourceId: string;
    path: string;
    pickcode: string;
  }, ttlSeconds = 86400): MediaSourceCacheEntry {
    const now = Date.now();
    const sourceGuid = String(payload.sourceGuid || "").trim();
    const entry: MediaSourceCacheEntry = {
      sourceGuid,
      mediaSourceId: String(payload.mediaSourceId || "").trim(),
      path: String(payload.path || "").trim(),
      pickcode: String(payload.pickcode || "").trim(),
      createdAt: new Date(now).toISOString(),
      expiresAt: now + Math.max(0, Math.floor(ttlSeconds)) * 1000
    };
    if (sourceGuid) {
      this.store.set(sourceGuid, entry);
    }
    return entry;
  }
}

export class FolderIdCache {
  private store = new Map<string, { folderId: string; createdAt: string; expiresAt: number }>();

  private sweepExpired() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  get(cookieKey: string): string {
    this.sweepExpired();
    const key = String(cookieKey || "").trim();
    if (!key) {
      return "";
    }
    const hit = this.store.get(key);
    return hit?.folderId || "";
  }

  set(cookieKey: string, folderId: string, ttlSeconds = 86400): void {
    const key = String(cookieKey || "").trim();
    const value = String(folderId || "").trim();
    if (!key || !value) {
      return;
    }
    const now = Date.now();
    this.store.set(key, {
      folderId: value,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + Math.max(0, Math.floor(ttlSeconds)) * 1000
    });
  }

  delete(cookieKey: string): void {
    const key = String(cookieKey || "").trim();
    if (!key) {
      return;
    }
    this.store.delete(key);
  }
}
