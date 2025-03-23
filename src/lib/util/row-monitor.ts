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
    
    logger.info('Starting row count monitoring service - ONE-TIME MODE');
    
    // Take initial snapshot only
    this.takeSnapshot()
      .catch((error: unknown) => {
        const typedError = error instanceof Error ? error : new Error(String(error));
        logger.error('Error taking initial row count snapshot', typedError);
      });
    
    // DO NOT start an interval - will be called by scheduler instead
  }
  
  /**
   * Run scheduled row count monitoring
   */
  public async runScheduledMonitoring(): Promise<void> {
    logger.info('Running scheduled row count monitoring check');
    try {
      await this.checkRowCounts();
      logger.info('Scheduled row count monitoring completed');
    } catch (error: unknown) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      logger.error('Error in scheduled row count monitoring', typedError);
      throw typedError; // Let the scheduler handle the error
    }
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
 * Verify deleted appointments were actually removed with enhanced verification
 * FIXED to improve row index calculation and fallback mechanisms
 */
export async function verifyAppointmentDeletion(
    sheetsService: IGoogleSheetsService,
    appointmentId: string,
    expectedRowRemoval = true,
    options = { maxRetries: 2, retryDelayMs: 1000, forceCleanup: false }
  ): Promise<boolean> {
    try {
      logger.info(`Verifying deletion of appointment ${appointmentId}`);
      
      // Wait a short delay for potential sheet sync (Google Sheets can have latency)
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check if appointment exists after deletion
      const appointment = await sheetsService.getAppointment(appointmentId);
      
      if (appointment === null) {
        logger.info(`Verification successful: Appointment ${appointmentId} was properly deleted`);
        return true;
      }
      
      // The appointment still exists - try to understand why
      logger.warn(`Verification failed: Appointment ${appointmentId} still exists after deletion attempt`);
      
      // Log the values found for debugging
      logger.info(`Current appointment data in sheet: ${JSON.stringify({
        appointmentId: appointment.appointmentId,
        status: appointment.status,
        startTime: appointment.startTime,
        assignedOfficeId: appointment.assignedOfficeId
      })}`);
      
      // If force cleanup is enabled, try alternative deletion methods
      if (options.forceCleanup) {
        for (let attempt = 0; attempt < options.maxRetries; attempt++) {
          logger.info(`Attempting alternative deletion method ${attempt + 1} for appointment ${appointmentId}`);
          
          try {
            // Try alternative deletion approach
            await attemptAlternativeDeletion(sheetsService, appointmentId, attempt);
            
            // Wait for potential sheet sync
            await new Promise(resolve => setTimeout(resolve, options.retryDelayMs));
            
            // Verify again
            const appointmentAfterRetry = await sheetsService.getAppointment(appointmentId);
            if (appointmentAfterRetry === null) {
              logger.info(`Alternative deletion method ${attempt + 1} successfully deleted appointment ${appointmentId}`);
              
              // Log the recovery
              await sheetsService.addAuditLog({
                timestamp: new Date().toISOString(),
                eventType: 'SYSTEM_ERROR' as AuditEventType,
                description: `Successfully recovered failed deletion for appointment ${appointmentId}`,
                user: 'DELETION_VERIFICATION',
                systemNotes: JSON.stringify({
                  appointmentId,
                  verificationTimestamp: new Date().toISOString(),
                  recoveryMethod: `alternative_deletion_${attempt + 1}`
                })
              });
              
              return true;
            }
          } catch (retryError: unknown) {
            const typedError = retryError instanceof Error ? retryError : new Error(String(retryError));
            logger.error(`Alternative deletion method ${attempt + 1} failed for appointment ${appointmentId}`, typedError);
          }
          
          // Wait before next attempt
          await new Promise(resolve => setTimeout(resolve, options.retryDelayMs));
        }
        
        // If expected row removal, update status to cancelled as last resort
        if (expectedRowRemoval && appointment.status !== 'cancelled') {
          try {
            logger.info(`Falling back to status update for appointment ${appointmentId}`);
            
            const cancellationUpdate = {
              ...appointment,
              status: 'cancelled' as 'cancelled',
              lastUpdated: new Date().toISOString(),
              notes: (appointment.notes || '') + `\nForced cancellation after failed deletion: ${new Date().toISOString()}`
            };
            
            await sheetsService.updateAppointment(cancellationUpdate);
            
            logger.info(`Successfully updated appointment ${appointmentId} status to cancelled as fallback`);
            
            // Log the fallback action
            await sheetsService.addAuditLog({
              timestamp: new Date().toISOString(),
              eventType: 'SYSTEM_ERROR' as AuditEventType,
              description: `Applied fallback cancellation for appointment ${appointmentId}`,
              user: 'DELETION_VERIFICATION',
              systemNotes: JSON.stringify({
                appointmentId,
                verificationTimestamp: new Date().toISOString(),
                action: 'status_update_fallback',
                previousStatus: appointment.status
              })
            });
            
            return false; // Row still exists but we did our best
          } catch (updateError: unknown) {
            const typedError = updateError instanceof Error ? updateError : new Error(String(updateError));
            logger.error(`Status update fallback failed for appointment ${appointmentId}`, typedError);
          }
        }
      }
      
      // Log the verification failure
      await sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'SYSTEM_ERROR' as AuditEventType,
        description: `Failed to delete appointment ${appointmentId}`,
        user: 'DELETION_VERIFICATION',
        systemNotes: JSON.stringify({
          appointmentId,
          verificationTimestamp: new Date().toISOString(),
          status: appointment.status,
          expectedRowRemoval: expectedRowRemoval,
          actionTaken: options.forceCleanup ? 'attempted_recovery' : 'none'
        })
      });
      
      // If row wasn't expected to be removed, but status is cancelled, consider it a success
      if (!expectedRowRemoval && appointment.status === 'cancelled') {
        logger.info(`Verification successful: Appointment ${appointmentId} was marked as cancelled`);
        return true;
      }
      
      logger.warn(`Verification failed: Appointment ${appointmentId} still exists and deletion recovery attempts failed`);
      return false;
    } catch (error: unknown) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      logger.error(`Error verifying deletion of appointment ${appointmentId}`, typedError);
      return false;
    }
  }
  
  /**
   * Try alternative deletion methods based on attempt number
   * FIXED to improve row index calculation
   */
  async function attemptAlternativeDeletion(
    sheetsService: IGoogleSheetsService, 
    appointmentId: string,
    attempt: number
  ): Promise<void> {
    // Get row index for this appointment
    const rowIndex = await findAppointmentRowIndex(sheetsService, appointmentId);
    if (rowIndex === -1) {
      throw new Error(`Could not find row index for appointment ${appointmentId}`);
    }
    
    // Get actual sheet ID for Appointments sheet
    const sheetInfo = await getSheetInfo(sheetsService);
    const appointmentsSheet = sheetInfo.find(sheet => sheet.title === 'Appointments');
    
    if (!appointmentsSheet) {
      throw new Error('Could not find Appointments sheet');
    }
    
    // Attempt 0: Clear cell values instead of deleting row (less disruptive)
    if (attempt === 0) {
      logger.info(`Alternative method 1: Clearing cell values for appointment ${appointmentId} at row ${rowIndex + 2}`);
      
      // Use direct Google Sheets API to clear values
      try {
        // Access the sheets API directly through sheets service
        const sheets = (sheetsService as any).sheets;
        if (!sheets) {
          throw new Error('Cannot access sheets API directly');
        }
        
        // Use values.clear to clear the row content
        const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
        await sheets.spreadsheets.values.clear({
          spreadsheetId,
          range: `Appointments!A${rowIndex + 2}:Q${rowIndex + 2}`
        });
        
        logger.info(`Successfully cleared values for appointment ${appointmentId}`);
      } catch (clearError: unknown) {
        const typedClearError = clearError instanceof Error ? clearError : new Error(String(clearError));
        logger.error(`Failed to clear values for appointment ${appointmentId}`, typedClearError);
        throw clearError;
      }
    }
    // Attempt 1: Use directly configured sheet ID for deletion
    else if (attempt === 1) {
      logger.info(`Alternative method 2: Using direct sheet ID ${appointmentsSheet.sheetId} for deletion`);
      
      try {
        // Access the sheets API directly through sheets service
        const sheets = (sheetsService as any).sheets;
        if (!sheets) {
          throw new Error('Cannot access sheets API directly');
        }
        
        // Use batchUpdate with explicit sheet ID
        const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
        
        // Prepare and log the exact request being sent
        // FIX: adjusted indices for proper row deletion
        const deleteRequest = {
          spreadsheetId,
          requestBody: {
            requests: [{
              deleteDimension: {
                range: {
                  sheetId: appointmentsSheet.sheetId,
                  dimension: 'ROWS',
                  startIndex: rowIndex + 1, // +1 for header row, DON'T add another +1
                  endIndex: rowIndex + 2    // +2 because endIndex is exclusive
                }
              }
            }]
          }
        };
        
        logger.info(`Delete request with direct sheet ID: ${JSON.stringify(deleteRequest, null, 2)}`);
        
        // Execute the delete request and capture the full response
        const response = await sheets.spreadsheets.batchUpdate(deleteRequest);
        
        // Log the full response
        logger.info(`Delete response with direct sheet ID: ${JSON.stringify(response.data, null, 2)}`);
      } catch (deleteError: unknown) {
        const typedDeleteError = deleteError instanceof Error ? deleteError : new Error(String(deleteError));
        logger.error(`Failed to delete with direct sheet ID for appointment ${appointmentId}`, typedDeleteError);
        throw deleteError;
      }
    }
    // Attempt 2: Try using broader range clearing
    else if (attempt === 2) {
      logger.info(`Alternative method 3: Using broader range clearing for appointment ${appointmentId}`);
      
      try {
        // Access the sheets API directly through sheets service
        const sheets = (sheetsService as any).sheets;
        if (!sheets) {
          throw new Error('Cannot access sheets API directly');
        }
        
        // Use values.clear with a broader range to ensure deletion
        const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
        await sheets.spreadsheets.values.clear({
          spreadsheetId,
          // Clear the row plus one cell above and below to handle potential index drift
          range: `Appointments!A${Math.max(2, rowIndex + 1)}:Q${rowIndex + 3}`
        });
        
        logger.info(`Successfully cleared broader range for appointment ${appointmentId}`);
      } catch (clearError: unknown) {
        const typedClearError = clearError instanceof Error ? clearError : new Error(String(clearError));
        logger.error(`Failed to clear broader range for appointment ${appointmentId}`, typedClearError);
        throw clearError;
      }
    }
  }
  
  /**
   * Find the row index for a specific appointment ID
   */
  async function findAppointmentRowIndex(
    sheetsService: IGoogleSheetsService,
    appointmentId: string
  ): Promise<number> {
    try {
      // Access the sheets API directly through sheets service if possible
      const sheets = (sheetsService as any).sheets;
      
      if (sheets) {
        // Direct API method (faster)
        const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: 'Appointments!A:A'
        });
        
        const values = response.data.values || [];
        return values.findIndex((row: any[]) => row[0] === appointmentId) - 1; // -1 for header row
      } else {
        // Fallback to using the sheet service
        try {
          // Read only appointment IDs for efficiency
          const rows = await (sheetsService as any).readSheet('Appointments!A:A');
          
          if (!rows || !Array.isArray(rows)) {
            throw new Error('Failed to read appointment IDs');
          }
          
          // Find the row with this appointment ID
          const rowIndex = rows.findIndex(row => row[0] === appointmentId);
          
          if (rowIndex === -1) {
            logger.warn(`Could not find appointment ${appointmentId} in sheet`);
            return -1;
          }
          
          return rowIndex - 1; // -1 for header row
        } catch (readError: unknown) {
          const typedReadError = readError instanceof Error ? readError : new Error(String(readError));
          logger.error(`Error reading appointments`, typedReadError);
          throw readError;
        }
      }
    } catch (error: unknown) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      logger.error(`Error finding row index for appointment ${appointmentId}`, typedError);
      return -1;
    }
  }
  
  /**
   * Get sheet information directly from Google Sheets API
   */
  async function getSheetInfo(sheetsService: IGoogleSheetsService): Promise<Array<{
    title: string;
    sheetId: number;
    index: number;
  }>> {
    try {
      // Access the sheets API directly through sheets service
      const sheets = (sheetsService as any).sheets;
      if (!sheets) {
        throw new Error('Cannot access sheets API directly');
      }
      
      const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      const response = await sheets.spreadsheets.get({
        spreadsheetId
      });
      
      return (response.data.sheets || []).map((sheet: any, index: number) => ({
        title: sheet.properties?.title || '',
        sheetId: sheet.properties?.sheetId || 0,
        index
      }));
    } catch (error: unknown) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      logger.error('Error getting sheet info', typedError);
      return [];
    }
  }