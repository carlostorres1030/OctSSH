export type ConnectionLease<T> = {
  value: T;
  release: () => void;
};

export type ConnectionPoolOptions = {
  maxConnections: number;
  idleTtlMs: number;
};

type Entry<T> = {
  value: T;
  lastUsedAt: number;
  refCount: number;
};

export class ConnectionPool<K, T> {
  private readonly create: (key: K) => Promise<T>;
  private readonly closeFn: (value: T) => Promise<void> | void;
  private readonly maxConnections: number;
  private readonly idleTtlMs: number;
  private readonly entries = new Map<K, Entry<T>>();

  constructor(params: {
    create: (key: K) => Promise<T>;
    close: (value: T) => Promise<void> | void;
    options: ConnectionPoolOptions;
  }) {
    this.create = params.create;
    this.closeFn = params.close;
    this.maxConnections = params.options.maxConnections;
    this.idleTtlMs = params.options.idleTtlMs;
  }

  size() {
    return this.entries.size;
  }

  async get(key: K): Promise<ConnectionLease<T>> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing) {
      existing.refCount += 1;
      existing.lastUsedAt = now;
      return {
        value: existing.value,
        release: () => {
          existing.refCount = Math.max(0, existing.refCount - 1);
          existing.lastUsedAt = Date.now();
        },
      };
    }

    await this.evictIfNeeded();
    const value = await this.create(key);
    const entry: Entry<T> = { value, lastUsedAt: now, refCount: 1 };
    this.entries.set(key, entry);
    return {
      value,
      release: () => {
        entry.refCount = Math.max(0, entry.refCount - 1);
        entry.lastUsedAt = Date.now();
      },
    };
  }

  async close(key: K) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await this.closeFn(entry.value);
  }

  async sweep(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.refCount > 0) continue;
      if (now - entry.lastUsedAt < this.idleTtlMs) continue;
      await this.close(key);
    }
  }

  private async evictIfNeeded() {
    if (this.entries.size < this.maxConnections) return;

    // Evict the least recently used idle entry.
    let victimKey: K | null = null;
    let victimLastUsed = Infinity;
    for (const [k, v] of this.entries) {
      if (v.refCount > 0) continue;
      if (v.lastUsedAt < victimLastUsed) {
        victimLastUsed = v.lastUsedAt;
        victimKey = k;
      }
    }

    if (victimKey === null) {
      throw new Error(
        `Max connections reached (${this.maxConnections}); no idle connection available to evict.`
      );
    }

    await this.close(victimKey);
  }
}
