// src/lib/util/distributed-lock.ts

import { GoogleSheetsService } from '../google/sheets';
import { logger } from './logger';

interface LockInfo {
  lockId: string;
  task: string;
  acquiredAt: string;
  expiresAt: string;
  instanceId: string;
}

/**
 * Distributed locking mechanism using Google Sheets
 * Prevents multiple application instances from running the same tasks
 */
export class DistributedLockService {
  private sheetsService: GoogleSheetsService;
  private readonly instanceId: string;
  private readonly lockSheetName = 'System_Locks';
  private readonly lockTTLMs = 15 * 60 * 1000; // 15 minutes default TTL
  private acquiredLocks: Map<string, LockInfo> = new Map();
  
  constructor(sheetsService?: GoogleSheetsService) {
    this.sheetsService = sheetsService || new GoogleSheetsService();
    // Generate a unique instance ID for this application instance
    this.instanceId = `instance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Setup cleanup on process exit
    process.on('SIGTERM', () => this.releaseAllLocks());
    process.on('SIGINT', () => this.releaseAllLocks());
    
    // Setup periodic cleanup of expired locks
    setInterval(() => this.cleanupExpiredLocks(), 5 * 60 * 1000); // Check every 5 minutes
    
    logger.info(`Distributed lock service initialized with instance ID: ${this.instanceId}`);
  }
  
  /**
   * Try to acquire a lock for a specific task
   * @param taskName The task identifier to lock
   * @param ttlMs Time-to-live in milliseconds (default: 15 minutes)
   * @returns true if lock acquired, false otherwise
   */
  async acquireLock(taskName: string, ttlMs = this.lockTTLMs): Promise<boolean> {
    try {
      logger.info(`Attempting to acquire lock for task: ${taskName}`);
      
      // First check if the lock is already held by another instance
      const existingLock = await this.getLock(taskName);
      
      if (existingLock) {
        // Check if lock has expired
        const now = Date.now();
        const expiresAt = new Date(existingLock.expiresAt).getTime();
        
        if (now < expiresAt) {
          // Lock is still valid and held by someone else
          logger.info(`Lock for task ${taskName} is already held by instance ${existingLock.instanceId} until ${existingLock.expiresAt}`);
          return false;
        }
        
        // Lock has expired, we can take it (will be overwritten below)
        logger.info(`Found expired lock for task ${taskName}, acquiring it`);
      }
      
      // Create new lock info
      const lockInfo: LockInfo = {
        lockId: `lock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        task: taskName,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        instanceId: this.instanceId
      };
      
      // Try to write the lock to Google Sheets
      await this.writeLock(lockInfo);
      
      // Double-check we actually hold the lock (in case of race condition)
      const verifyLock = await this.getLock(taskName);
      if (verifyLock && verifyLock.lockId === lockInfo.lockId) {
        // Successfully acquired the lock
        this.acquiredLocks.set(taskName, lockInfo);
        logger.info(`Successfully acquired lock for task: ${taskName}, expires at ${lockInfo.expiresAt}`);
        return true;
      }
      
      logger.info(`Failed to acquire lock for task: ${taskName} due to race condition`);
      return false;
    } catch (error) {
      const errorObj = {
        message: error instanceof Error ? error.message : String(error)
      };
      logger.error(`Error acquiring lock for task ${taskName}:`, errorObj);
      
      // In case of error, assume we couldn't get the lock
      return false;
    }
  }
  
  /**
   * Release a previously acquired lock
   * @param taskName The task identifier to unlock
   * @returns true if lock released, false otherwise
   */
  async releaseLock(taskName: string): Promise<boolean> {
    try {
      logger.info(`Attempting to release lock for task: ${taskName}`);
      
      // Check if we hold this lock
      const lockInfo = this.acquiredLocks.get(taskName);
      if (!lockInfo) {
        logger.info(`We don't hold the lock for task: ${taskName}`);
        return false;
      }
      
      // Verify we still hold the lock in the sheet
      const currentLock = await this.getLock(taskName);
      if (!currentLock || currentLock.lockId !== lockInfo.lockId) {
        logger.warn(`Lock for task ${taskName} has changed or been removed`);
        this.acquiredLocks.delete(taskName);
        return false;
      }
      
      // Remove the lock from the sheet
      await this.deleteLock(taskName);
      
      // Remove from our local tracking
      this.acquiredLocks.delete(taskName);
      
      logger.info(`Successfully released lock for task: ${taskName}`);
      return true;
    } catch (error) {
      const errorObj = {
        message: error instanceof Error ? error.message : String(error)
      };
      logger.error(`Error releasing lock for task ${taskName}:`, errorObj);
      return false;
    }
  }
  
  /**
   * Release all locks held by this instance
   */
  async releaseAllLocks(): Promise<void> {
    logger.info(`Releasing all locks held by instance: ${this.instanceId}`);
    
    const taskNames = Array.from(this.acquiredLocks.keys());
    for (const taskName of taskNames) {
      await this.releaseLock(taskName);
    }
  }
  
  /**
   * Retrieve current lock information for a task
   */
  private async getLock(taskName: string): Promise<LockInfo | null> {
    try {
      // Try to get the lock from the sheet
      const locks = await this.getAllLocks();
      return locks.find(lock => lock.task === taskName) || null;
    } catch (error) {
      const errorObj = {
        message: error instanceof Error ? error.message : String(error)
      };
      logger.error(`Error getting lock for task ${taskName}:`, errorObj);
      return null;
    }
  }
  
  /**
   * Get all locks from the sheet
   */
  private async getAllLocks(): Promise<LockInfo[]> {
    try {
      // Check if the lock sheet exists
      await this.ensureLockSheetExists();
      
      // Get all locks from the sheet - use the public API instead of private methods
      const response = await this.sheetsService.getSheetData(this.lockSheetName, "A:E");
      
      // Skip header row and parse lock information
      const locks: LockInfo[] = [];
      
      if (response && response.length > 1) {
        for (let i = 1; i < response.length; i++) {
          const row = response[i];
          if (row && row.length >= 5) {
            locks.push({
              lockId: row[0],
              task: row[1],
              acquiredAt: row[2],
              expiresAt: row[3],
              instanceId: row[4]
            });
          }
        }
      }
      
      return locks;
    } catch (error) {
      const errorObj = {
        message: error instanceof Error ? error.message : String(error)
      };
      logger.error('Error getting all locks:', errorObj);
      return [];
    }
  }
  
  /**
   * Write a lock to the sheet
   */
  private async writeLock(lockInfo: LockInfo): Promise<void> {
    try {
      // Ensure lock sheet exists
      await this.ensureLockSheetExists();
      
      // Check if lock already exists for this task
      const existingLock = await this.getLock(lockInfo.task);
      
      if (existingLock) {
        // For existing locks, we'll use a public method to find and update
        const allLockData = await this.sheetsService.getSheetData(this.lockSheetName, "A:A");
        const rowIndex = allLockData?.findIndex((row: string[]) => row[0] === existingLock.lockId);
        
        if (rowIndex !== undefined && rowIndex >= 0) {
          // Use addOrUpdateRows to modify this row
          await this.sheetsService.addOrUpdateRow(
            this.lockSheetName,
            rowIndex + 2, // +2 because Google Sheets is 1-indexed and we have a header
            [
              lockInfo.lockId,
              lockInfo.task,
              lockInfo.acquiredAt,
              lockInfo.expiresAt,
              lockInfo.instanceId
            ]
          );
        }
      } else {
        // Add new lock - using addOrUpdateRows
        await this.sheetsService.addRow(
          this.lockSheetName,
          [
            lockInfo.lockId,
            lockInfo.task,
            lockInfo.acquiredAt,
            lockInfo.expiresAt,
            lockInfo.instanceId
          ]
        );
      }
    } catch (error) {
      const errorObj = {
        message: error instanceof Error ? error.message : String(error)
      };
      logger.error(`Error writing lock for task ${lockInfo.task}:`, errorObj);
      throw error;
    }
  }
  
  /**
   * Delete a lock from the sheet
   */
  private async deleteLock(taskName: string): Promise<void> {
    try {
      // Get all locks
      const locks = await this.getAllLocks();
      
      // Filter out the one we want to delete
      const updatedLocks = locks.filter(lock => lock.task !== taskName);
      
      // Clear the sheet and rewrite
      await this.rewriteLockSheet(updatedLocks);
    } catch (error) {
      const errorObj = {
        message: error instanceof Error ? error.message : String(error)
      };
      logger.error(`Error deleting lock for task ${taskName}:`, errorObj);
      throw error;
    }
  }
  
  /**
   * Clean up expired locks
   */
  private async cleanupExpiredLocks(): Promise<void> {
    try {
      logger.info('Cleaning up expired locks');
      
      // Get all locks
      const locks = await this.getAllLocks();
      
      // Filter out expired locks
      const now = Date.now();
      const validLocks = locks.filter(lock => {
        const expiresAt = new Date(lock.expiresAt).getTime();
        return now < expiresAt;
      });
      
      // If there are expired locks, rewrite the sheet
      if (validLocks.length < locks.length) {
        await this.rewriteLockSheet(validLocks);
        logger.info(`Cleaned up ${locks.length - validLocks.length} expired locks`);
      } else {
        logger.info('No expired locks found');
      }
    } catch (error) {
      const errorObj = {
        message: error instanceof Error ? error.message : String(error)
      };
      logger.error('Error cleaning up expired locks:', errorObj);
    }
  }
  
  /**
   * Rewrite the entire lock sheet with new data
   */
  private async rewriteLockSheet(locks: LockInfo[]): Promise<void> {
    try {
      // Ensure lock sheet exists
      await this.ensureLockSheetExists();
      
      // Clear existing data (except header)
      await this.sheetsService.clearRange(this.lockSheetName, "A2:E");
      
      // If there are no locks, we're done
      if (locks.length === 0) {
        return;
      }
      
      // Create rows for all locks
      const rows = locks.map(lock => [
        lock.lockId,
        lock.task,
        lock.acquiredAt,
        lock.expiresAt,
        lock.instanceId
      ]);
      
      // Write all locks one by one
      for (const row of rows) {
        await this.sheetsService.addRow(this.lockSheetName, row);
      }
    } catch (error) {
      const errorObj = {
        message: error instanceof Error ? error.message : String(error)
      };
      logger.error('Error rewriting lock sheet:', errorObj);
      throw error;
    }
  }
  
  /**
   * Ensure the lock sheet exists
   */
  private async ensureLockSheetExists(): Promise<void> {
    try {
      // Check if sheet exists by trying to read it
      try {
        await this.sheetsService.getSheetData(this.lockSheetName, "A1");
        // If we get here, sheet exists
        return;
      } catch (error) {
        // Sheet likely doesn't exist, continue to create it
        logger.info(`Lock sheet ${this.lockSheetName} does not exist, creating it`);
      }
      
      // Create the sheet using public API
      await this.sheetsService.createSheet(this.lockSheetName);
      
      // Add header row
      await this.sheetsService.addRow(
        this.lockSheetName,
        ['LockId', 'Task', 'AcquiredAt', 'ExpiresAt', 'InstanceId']
      );
      
      logger.info(`Created lock sheet: ${this.lockSheetName}`);
    } catch (error) {
      // Check if error is because sheet already exists
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (typeof errorMessage === 'string' && errorMessage.includes('already exists')) {
        logger.info(`Lock sheet ${this.lockSheetName} already exists`);
        return;
      }
      
      const errorObj = {
        message: errorMessage
      };
      logger.error(`Error ensuring lock sheet exists:`, errorObj);
      throw error;
    }
  }
}

// Singleton instance
let lockServiceInstance: DistributedLockService | null = null;

/**
 * Get the distributed lock service instance
 */
export function getLockService(sheetsService?: GoogleSheetsService): DistributedLockService {
  if (!lockServiceInstance) {
    lockServiceInstance = new DistributedLockService(sheetsService);
  }
  return lockServiceInstance;
}