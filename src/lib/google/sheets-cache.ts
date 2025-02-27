// src/lib/google/sheets-cache.ts

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class SheetsCacheService {
  private cache: Map<string, CacheEntry<any>>;
  private defaultTTL: number;

  constructor(defaultTTL = 60000) { // 1 minute default TTL
    this.cache = new Map();
    this.defaultTTL = defaultTTL;
  }

  async getOrFetch<T>(
    key: string, 
    fetchFn: () => Promise<T>, 
    ttl = this.defaultTTL
  ): Promise<T> {
    const cached = this.cache.get(key);
    
    if (cached && Date.now() - cached.timestamp < ttl) {
      return cached.data as T;
    }

    const data = await fetchFn();
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });

    return data;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clearAll(): void {
    this.cache.clear();
  }
}

export default SheetsCacheService;