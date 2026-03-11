export interface RedirectCacheEntry {
  key: string;
  directUrl: string;
  finalPickcode: string;
  cookieName: string;
  createdAt: string;
  expiresAt: number;
}

export class RedirectCache {
  private store = new Map<string, RedirectCacheEntry>();

  get(key: string): RedirectCacheEntry | undefined {
    this.sweep();
    return this.store.get(key);
  }

  set(
    key: string,
    payload: { directUrl: string; finalPickcode: string; cookieName: string },
    ttlSeconds: number
  ): RedirectCacheEntry {
    const now = Date.now();
    const entry: RedirectCacheEntry = {
      key,
      directUrl: payload.directUrl,
      finalPickcode: payload.finalPickcode,
      cookieName: payload.cookieName,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + Math.max(0, Math.floor(ttlSeconds)) * 1000
    };
    this.store.set(key, entry);
    return entry;
  }

  private sweep() {
    const now = Date.now();
    for (const [key, value] of this.store.entries()) {
      if (now > value.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}

export function makeRedirectCacheKey(payload: {
  finalPickcode: string;
  cookieValue: string;
  userAgent: string;
  embyUserId: string;
}): string {
  const parts = [
    `pc=${payload.finalPickcode.trim()}`,
    `cookie=${payload.cookieValue.trim()}`,
    `ua=${payload.userAgent.trim()}`,
    `uid=${payload.embyUserId.trim()}`
  ];
  return parts.join("::");
}
