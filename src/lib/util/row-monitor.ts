// src/lib/util/row-monitor.ts

import { IGoogleSheetsService, AuditEventType } from '../google/sheets';
import { logger } from './logger';

/**
 * Row count snapshot for a sheet
 */
interface SheetRowSnapshot {
  sheetName: string;
  rowCount: number;
  timestamp: string;
}

/**
 * Row count change event
 */
interface RowCountChange {
  sheetName: string;
  previousCount: number;
  currentCount: number;
  delta: number;
  previousSnapshot: string; // timestamp
  currentSnapshot: string;  // timestamp
}

/**
 * Monitors row counts in Google Sheets to verify operations
 * This helps identify when rows are not being properly deleted
 */
export class RowMonitorService {
  private snapshots: Map<string, SheetRowSnapshot> = new Map();
  private monitorIntervalId: NodeJS.Timeout | null = null;
  
  // Key sheets to monitor for row counts
  private readonly MONITORED_SHEETS = [
    'Appointments',
    'Client_Accessibility_Info',
    'Audit_Log'
  ];
  
  constructor(
    private readonly sheetsService: IGoogleSheetsService,
    private readonly monitorIntervalMs = 3600000 // 1 hour
  ) {}

  /**
   * Start row count monitoring
   */
  public startMonitoring(): void {
    if (this.monitorIntervalId !== null) {
      return; // Already started
    }
    
    logger.info('Starting row count monitoring service');
    
    // Take initial snapshot
    this.takeSnapshot()
      .catch((error: unknown) => {
        const typedError = error instanceof Error ? error : new Error(String(error));
        logger.error('Error taking initial row count snapshot', typedError);
      });
    
    // Schedule periodic monitoring
    this.monitorIntervalId = setInterval(() => {
      this.checkRowCounts()
        .catch((error: unknown) => {
          const typedError = error instanceof Error ? error : new Error(String(error));
          logger.error('Error checking row counts', typedError);
        });
    }, this.monitorIntervalMs);
  }

  /**
   * Stop row count monitoring
   */
  public stopMonitoring(): void {
    if (this.monitorIntervalId !== null) {
      clearInterval(this.monitorIntervalId);
      this.monitorIntervalId = null;
      logger.info('Stopped row count monitoring service');
    }
  }

  /**
   * Take a snapshot of current row counts
   */
  public async takeSnapshot(): Promise<Map<string, SheetRowSnapshot>> {
    logger.info('Taking row count snapshot');
    
    const timestamp = new Date().toISOString();
    const newSnapshots = new Map<string, SheetRowSnapshot>();
    
    try {
      for (const sheetName of this.MONITORED_SHEETS) {
        const rowCount = await this.getRowCount(sheetName);
        
        const snapshot: SheetRowSnapshot = {
          sheetName,
          rowCount,
          timestamp
        };
        
        newSnapshots.set(sheetName, snapshot);
        logger.debug(`Snapshot for ${sheetName}: ${rowCount} rows`);
      }
      
      // Update snapshots
      this.snapshots = newSnapshots;
      
      return newSnapshots;
    } catch (error: unknown) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      logger.error('Error taking row count snapshots', typedError);
      throw typedError;
    }
  }

  /**
   * Check for row count changes and analyze them
   */
  public async checkRowCounts(): Promise<RowCountChange[]> {
    logger.info('Checking row counts for changes');
    
    if (this.snapshots.size === 0) {
      logger.info('No previous snapshots available, taking initial snapshot');
      await this.takeSnapshot();
      return [];
    }
    
    const changes: RowCountChange[] = [];
    const currentSnapshot = new Date().toISOString();
    
    try {
      for (const sheetName of this.MONITORED_SHEETS) {
        const previousSnapshot = this.snapshots.get(sheetName);
        
        if (!previousSnapshot) {
          logger.warn(`No previous snapshot for ${sheetName}, skipping`);
          continue;
        }
        
        const currentRowCount = await this.getRowCount(sheetName);
        const delta = currentRowCount - previousSnapshot.rowCount;
        
        // Record all changes for analysis
        changes.push({
          sheetName,
          previousCount: previousSnapshot.rowCount,
          currentCount: currentRowCount,
          delta,
          previousSnapshot: previousSnapshot.timestamp,
          currentSnapshot
        });
        
        // Update the snapshot
        this.snapshots.set(sheetName, {
          sheetName,
          rowCount: currentRowCount,
          timestamp: currentSnapshot
        });
        
        // Log significant changes
        if (delta !== 0) {
          const changeType = delta > 0 ? 'increased' : 'decreased';
          logger.info(`Row count for ${sheetName} ${changeType} by ${Math.abs(delta)}`);
          
          // Log to audit log for significant changes that might indicate issues
          if (this.isAnomalous(sheetName, delta)) {
            await this.logAnomalousChange(sheetName, previousSnapshot.rowCount, currentRowCount, delta);
          }
        }
      }
      
      // Take new snapshot
      await this.takeSnapshot();
      
      return changes;
    } catch (error: unknown) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      logger.error('Error checking row counts', typedError);
      throw typedError;
    }
  }

  /**
   * Get current row count for a sheet
   */
  private async getRowCount(sheetName: string): Promise<number> {
    try {
      // For Appointments sheet
      if (sheetName === 'Appointments') {
        const appointments = await this.sheetsService.getAllAppointments();
        return appointments.length;
      }
      
      // For other sheets, use a generic approach
      // This is just a placeholder - in a real implementation, we would
      // add methods to the IGoogleSheetsService interface to get the raw row counts
      // For now, we'll simulate with a direct API call
      
      // This is a placeholder with mock implementation
      return new Promise((resolve) => {
        // Return mock counts for testing
        if (sheetName === 'Client_Accessibility_Info') {
          resolve(100); // Mock value
        } else if (sheetName === 'Audit_Log') {
          resolve(500); // Mock value
        } else {
          resolve(50); // Default mock value
        }
      });
    } catch (error: unknown) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      logger.error(`Error getting row count for ${sheetName}`, typedError);
      throw typedError;
    }
  }

  /**
   * Determine if a row count change is anomalous
   */
  private isAnomalous(sheetName: string, delta: number): boolean {
    // Define thresholds for each sheet type
    
    // For Appointments, any unexpected decrease might be an issue
    if (sheetName === 'Appointments' && delta < -5) {
      return true;
    }
    
    // For Client_Accessibility_Info, large changes are suspicious
    if (sheetName === 'Client_Accessibility_Info' && (delta < -3 || delta > 10)) {
      return true;
    }
    
    // Audit_Log should always grow or stay the same
    if (sheetName === 'Audit_Log' && delta < 0) {
      return true;
    }
    
    return false;
  }

  /**
   * Log anomalous row count change to audit log
   */
  private async logAnomalousChange(
    sheetName: string, 
    previousCount: number,
    currentCount: number,
    delta: number
  ): Promise<void> {
    try {
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'SYSTEM_ERROR' as AuditEventType,
        description: `Anomalous row count change detected in ${sheetName}`,
        user: 'ROW_MONITOR',
        systemNotes: JSON.stringify({
          sheetName,
          previousCount,
          currentCount,
          delta,
          timestamp: new Date().toISOString()
        })
      });
      
      logger.warn(`Logged anomalous row count change in ${sheetName}: delta=${delta}`);
    } catch (error: unknown) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      logger.error(`Failed to log anomalous row count change for ${sheetName}`, typedError);
    }
  }
}

/**
 * Verify deleted appointments were actually removed
 * This utility can be called after appointment deletion operations
 */
export async function verifyAppointmentDeletion(
  sheetsService: IGoogleSheetsService,
  appointmentId: string,
  expectedRowRemoval = true
): Promise<boolean> {
  try {
    logger.info(`Verifying deletion of appointment ${appointmentId}`);
    
    // Check if appointment exists after deletion
    const appointment = await sheetsService.getAppointment(appointmentId);
    
    if (appointment === null) {
      logger.info(`Verification successful: Appointment ${appointmentId} was properly deleted`);
      return true;
    }
    
    // The appointment still exists
    if (expectedRowRemoval) {
      // This is unexpected - the row should have been removed
      logger.warn(`Verification failed: Appointment ${appointmentId} still exists after deletion`);
      
      // Log the issue
      await sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'SYSTEM_ERROR' as AuditEventType,
        description: `Failed to delete appointment ${appointmentId}`,
        user: 'DELETION_VERIFICATION',
        systemNotes: JSON.stringify({
          appointmentId,
          verificationTimestamp: new Date().toISOString(),
          status: appointment.status
        })
      });
      
      return false;
    } else {
      // Check if the status was updated to 'cancelled'
      if (appointment.status === 'cancelled') {
        logger.info(`Verification successful: Appointment ${appointmentId} was marked as cancelled`);
        return true;
      } else {
        logger.warn(`Verification failed: Appointment ${appointmentId} exists and is not cancelled`);
        return false;
      }
    }
  } catch (error: unknown) {
    const typedError = error instanceof Error ? error : new Error(String(error));
    logger.error(`Error verifying deletion of appointment ${appointmentId}`, typedError);
    return false;
  }
}