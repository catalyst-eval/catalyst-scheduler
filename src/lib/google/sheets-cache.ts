// src/lib/google/sheets-cache.ts

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class SheetsCacheService {
  private cache: Map<string, CacheEntry<any>>;
  private defaultTTL: number;
  private memoryCache: Map<string, any>; // New in-memory cache for high-frequency data
  private memoryTTL: number; // Special TTL for memory cache

  constructor(defaultTTL = 60000, memoryTTL = 300000) { // 1 minute default TTL, 5 minutes for memory
    this.cache = new Map();
    this.memoryCache = new Map();
    this.defaultTTL = defaultTTL;
    this.memoryTTL = memoryTTL;
    
    // Preload high-frequency configuration data
    this.preloadCommonData();
    
    // Set up memory cache cleanup interval
    setInterval(() => this.cleanupMemoryCache(), 60000); // Check every minute
  }
  
  /**
   * Preload common configuration data
   */
  private async preloadCommonData() {
    try {
      // Load offices, clinicians, rules in background
      // This prevents multiple initial loads during startup
      setTimeout(async () => {
        await this.preloadDataItem('config:offices');
        await this.preloadDataItem('config:clinicians');
        await this.preloadDataItem('config:rules');
        await this.preloadDataItem('config:client_preferences');
        console.log('Preloaded common configuration data');
      }, 100);
    } catch (error) {
      console.error('Error preloading common data:', error);
    }
  }
  
  /**
   * Preload a specific data item
   */
  private async preloadDataItem(key: string) {
    try {
      // Just mark as loading - actual data will be loaded when needed
      this.memoryCache.set(key, { loading: true, timestamp: Date.now() });
    } catch (error) {
      console.error(`Error preloading ${key}:`, error);
    }
  }

  /**
   * Get data from memory cache if available
   */
  getFromMemory<T>(key: string): T | null {
    const entry = this.memoryCache.get(key);
    
    if (!entry) return null;
    
    // Check if entry is still valid
    if (entry.timestamp && Date.now() - entry.timestamp > this.memoryTTL) {
      this.memoryCache.delete(key);
      return null;
    }
    
    // Don't return if marked as loading
    if (entry.loading === true) return null;
    
    return entry.data;
  }
  
  /**
   * Set data in memory cache
   */
  setInMemory<T>(key: string, value: T): void {
    this.memoryCache.set(key, {
      data: value,
      timestamp: Date.now(),
      loading: false
    });
  }
  
  /**
   * Clean up expired entries from memory cache
   */
  private cleanupMemoryCache(): void {
    const now = Date.now();
    let expiredCount = 0;
    
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.timestamp && now - entry.timestamp > this.memoryTTL) {
        this.memoryCache.delete(key);
        expiredCount++;
      }
    }
    
    if (expiredCount > 0) {
      console.log(`Cleaned up ${expiredCount} expired entries from memory cache`);
    }
  }

  /**
   * Fetch data with caching
   * Enhanced with memory cache support
   */
  async getOrFetch<T>(
    key: string, 
    fetchFn: () => Promise<T>, 
    ttl = this.defaultTTL
  ): Promise<T> {
    // First check memory cache for frequently accessed data
    if (key.startsWith('config:') || key.startsWith('daily:')) {
      const memoryData = this.getFromMemory<T>(key);
      if (memoryData !== null) {
        return memoryData;
      }
    }
    
    // Then check regular cache
    const cached = this.cache.get(key);
    
    if (cached && Date.now() - cached.timestamp < ttl) {
      return cached.data as T;
    }

    const data = await fetchFn();
    
    // Store in regular cache
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
    
    // Also store in memory cache for config data
    if (key.startsWith('config:') || key.startsWith('daily:')) {
      this.setInMemory(key, data);
    }

    return data;
  }

  /**
   * Invalidate a specific cache key
   */
  invalidate(key: string): void {
    this.cache.delete(key);
    this.memoryCache.delete(key);
  }

  /**
   * Clear all caches
   */
  clearAll(): void {
    this.cache.clear();
    this.memoryCache.clear();
  }
}

export default SheetsCacheService;