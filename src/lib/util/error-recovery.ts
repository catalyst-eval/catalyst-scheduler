// src/lib/util/error-recovery.ts

import { IGoogleSheetsService, AuditEventType } from '../google/sheets';
import { logger } from './logger';

/**
 * Defines a failed operation that needs recovery
 */
export interface FailedOperation {
  id: string;
  type: OperationType;
  timestamp: string;
  data: any;
  retryCount: number;
  lastAttempt: string;
  error: string;
}

/**
 * Types of operations that can be recovered
 */
export enum OperationType {
  APPOINTMENT_DELETION = 'APPOINTMENT_DELETION',
  APPOINTMENT_CREATION = 'APPOINTMENT_CREATION',
  APPOINTMENT_UPDATE = 'APPOINTMENT_UPDATE',
  CLIENT_UPDATE = 'CLIENT_UPDATE',
  AUDIT_LOG = 'AUDIT_LOG'
}

/**
 * Recovery strategy options
 */
export enum RecoveryStrategy {
  RETRY = 'RETRY',            // Try the same operation again
  ALTERNATIVE = 'ALTERNATIVE' // Try an alternative approach
}

/**
 * Error recovery service to handle failed operations
 * This maintains a record of failed operations and provides
 * automated recovery mechanisms
 */
export class ErrorRecoveryService {
  private failedOperations: Map<string, FailedOperation> = new Map();
  private readonly storageKey = 'catalyst_scheduler_failed_operations';
  private recoveryIntervalId: NodeJS.Timeout | null = null;
  
  constructor(
    private readonly sheetsService: IGoogleSheetsService,
    private readonly maxRetryCount = 5,
    private readonly initialRetryDelayMs = 30000, // 30 seconds
    private readonly recoveryIntervalMs = 300000  // 5 minutes
  ) {
    this.loadFailedOperations();
  }

  /**
   * Start the recovery process
   */
  public startRecovery(): void {
    if (this.recoveryIntervalId !== null) {
      return; // Already started
    }
    
    logger.info('Starting error recovery service');
    
    // Run recovery immediately and then schedule periodic recovery
    this.attemptRecovery()
      .catch(error => logger.error('Error in initial recovery attempt', error instanceof Error ? error : new Error(String(error))));
    
    this.recoveryIntervalId = setInterval(() => {
      this.attemptRecovery()
        .catch(error => logger.error('Error in scheduled recovery attempt', error instanceof Error ? error : new Error(String(error))));
    }, this.recoveryIntervalMs);
  }

  /**
   * Stop the recovery process
   */
  public stopRecovery(): void {
    if (this.recoveryIntervalId !== null) {
      clearInterval(this.recoveryIntervalId);
      this.recoveryIntervalId = null;
      logger.info('Stopped error recovery service');
    }
  }

  /**
   * Record a failed operation for later recovery
   */
  public recordFailedOperation(
    type: OperationType,
    data: any,
    error: Error | string
  ): string {
    const id = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const errorMessage = error instanceof Error ? error.message : error;
    
    const operation: FailedOperation = {
      id,
      type,
      timestamp: new Date().toISOString(),
      data,
      retryCount: 0,
      lastAttempt: new Date().toISOString(),
      error: errorMessage
    };
    
    this.failedOperations.set(id, operation);
    this.saveFailedOperations();
    
    logger.warn(`Recorded failed operation for later recovery`, { operationId: id, type, error: errorMessage });
    
    // Log to audit log
    this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'SYSTEM_ERROR' as AuditEventType,
      description: `Operation failed and queued for recovery: ${type}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({ operationId: id, error: errorMessage })
    }).catch(error => {
      logger.error('Failed to log failed operation to audit log', error instanceof Error ? error : new Error(String(error)));
    });
    
    return id;
  }

  /**
   * Manually retry a specific failed operation
   */
  public async retryOperation(id: string): Promise<boolean> {
    const operation = this.failedOperations.get(id);
    
    if (!operation) {
      logger.warn(`Attempted to retry unknown operation: ${id}`);
      return false;
    }
    
    return this.processFailedOperation(operation);
  }

  /**
   * Get all currently failed operations
   */
  public getFailedOperations(): FailedOperation[] {
    return Array.from(this.failedOperations.values());
  }

  /**
   * Clear failed operations (e.g., for cleanup)
   */
  public clearFailedOperations(): void {
    this.failedOperations.clear();
    this.saveFailedOperations();
    logger.info('Cleared all failed operations');
  }

  /**
   * Attempt recovery of all failed operations
   */
  private async attemptRecovery(): Promise<void> {
    if (this.failedOperations.size === 0) {
      return;
    }
    
    logger.info(`Attempting recovery of ${this.failedOperations.size} failed operations`);
    
    const operations = Array.from(this.failedOperations.values());
    const results: Record<string, boolean> = {};
    
    // Process operations in order of age (oldest first)
    const sortedOperations = operations.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    
    for (const operation of sortedOperations) {
      try {
        results[operation.id] = await this.processFailedOperation(operation);
      } catch (error) {
        logger.error(`Error processing recovery for operation ${operation.id}`, error instanceof Error ? error : new Error(String(error)));
        results[operation.id] = false;
      }
    }
    
    const successCount = Object.values(results).filter(Boolean).length;
    logger.info(`Recovery attempt completed: ${successCount}/${operations.length} operations recovered`);
    
    // Save failed operations (some may have been removed during processing)
    this.saveFailedOperations();
  }

  /**
   * Process a single failed operation
   */
  private async processFailedOperation(operation: FailedOperation): Promise<boolean> {
    // Check if we've exceeded max retry count
    if (operation.retryCount >= this.maxRetryCount) {
      logger.warn(`Operation ${operation.id} exceeded max retry count (${this.maxRetryCount}), moving to dead letter queue`);
      
      // In a production system, we might move this to a "dead letter" queue
      // For now, we'll just log it and remove it
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'CRITICAL_ERROR' as AuditEventType,
        description: `Failed operation abandoned after ${operation.retryCount} retries: ${operation.type}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({ 
          operationId: operation.id, 
          error: operation.error,
          data: operation.data
        })
      });
      
      // Remove from recovery queue
      this.failedOperations.delete(operation.id);
      return false;
    }
    
    // Update retry count and timestamp
    operation.retryCount++;
    operation.lastAttempt = new Date().toISOString();
    
    logger.info(`Attempting recovery for operation ${operation.id} (attempt ${operation.retryCount}/${this.maxRetryCount})`, { 
      type: operation.type,
      timestamp: operation.timestamp
    });
    
    // Determine recovery strategy
    const strategy = this.determineRecoveryStrategy(operation);
    
    try {
      let success = false;
      
      switch (operation.type) {
        case OperationType.APPOINTMENT_DELETION:
          success = await this.recoverAppointmentDeletion(operation, strategy);
          break;
        case OperationType.APPOINTMENT_CREATION:
          success = await this.recoverAppointmentCreation(operation, strategy);
          break;
        case OperationType.APPOINTMENT_UPDATE:
          success = await this.recoverAppointmentUpdate(operation, strategy);
          break;
        case OperationType.CLIENT_UPDATE:
          success = await this.recoverClientUpdate(operation, strategy);
          break;
        case OperationType.AUDIT_LOG:
          success = await this.recoverAuditLog(operation, strategy);
          break;
        default:
          logger.warn(`Unknown operation type for recovery: ${operation.type}`);
          success = false;
      }
      
      if (success) {
        logger.info(`Successfully recovered operation ${operation.id}`);
        this.failedOperations.delete(operation.id);
        
        // Log success to audit log
        await this.sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'SYSTEM_ERROR' as AuditEventType,
          description: `Successfully recovered operation: ${operation.type}`,
          user: 'SYSTEM',
          systemNotes: JSON.stringify({ operationId: operation.id, strategy })
        });
      } else {
        logger.warn(`Failed to recover operation ${operation.id} (attempt ${operation.retryCount}/${this.maxRetryCount})`);
      }
      
      return success;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error during recovery of operation ${operation.id}`, error instanceof Error ? error : new Error(errorMessage));
      
      // Update error message
      operation.error = errorMessage;
      
      return false;
    }
  }

  /**
   * Determine the best recovery strategy for an operation
   */
  private determineRecoveryStrategy(operation: FailedOperation): RecoveryStrategy {
    // Use alternative strategy after first retry for deletion operations
    if (operation.type === OperationType.APPOINTMENT_DELETION && operation.retryCount > 1) {
      return RecoveryStrategy.ALTERNATIVE;
    }
    
    // For other operations, use alternative strategy after 3 retries
    if (operation.retryCount > 3) {
      return RecoveryStrategy.ALTERNATIVE;
    }
    
    // Default to retry strategy
    return RecoveryStrategy.RETRY;
  }

  /**
   * Recover appointment deletion operation
   */
  private async recoverAppointmentDeletion(
    operation: FailedOperation, 
    strategy: RecoveryStrategy
  ): Promise<boolean> {
    const { appointmentId } = operation.data;
    
    try {
      if (strategy === RecoveryStrategy.RETRY) {
        // Try deletion again
        await this.sheetsService.deleteAppointment(appointmentId);
        return true;
      } else {
        // Alternative: Try to update status to cancelled instead
        const appointment = await this.sheetsService.getAppointment(appointmentId);
        
        if (!appointment) {
          // Appointment no longer exists, consider recovery successful
          return true;
        }
        
        // Update appointment with cancelled status
        const updatedAppointment = {
          ...appointment,
          status: 'cancelled' as 'cancelled',
          lastUpdated: new Date().toISOString(),
          notes: (appointment.notes || '') + `\nCancelled by recovery system: ${new Date().toISOString()}`
        };
        
        await this.sheetsService.updateAppointment(updatedAppointment);
        return true;
      }
    } catch (error) {
      logger.error(`Failed to recover appointment deletion for ${appointmentId}`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Recover appointment creation operation
   */
  private async recoverAppointmentCreation(
    operation: FailedOperation, 
    strategy: RecoveryStrategy
  ): Promise<boolean> {
    const appointmentData = operation.data;
    
    try {
      // Check if appointment already exists (avoid duplicates)
      const existingAppointment = await this.sheetsService.getAppointment(appointmentData.appointmentId);
      
      if (existingAppointment) {
        // Appointment already exists, recovery successful
        return true;
      }
      
      // Try to create the appointment again
      await this.sheetsService.addAppointment(appointmentData);
      return true;
    } catch (error) {
      logger.error(`Failed to recover appointment creation for ${appointmentData.appointmentId}`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Recover appointment update operation
   */
  private async recoverAppointmentUpdate(
    operation: FailedOperation, 
    strategy: RecoveryStrategy
  ): Promise<boolean> {
    const appointmentData = operation.data;
    
    try {
      // Check if appointment exists
      const existingAppointment = await this.sheetsService.getAppointment(appointmentData.appointmentId);
      
      if (!existingAppointment) {
        // Appointment doesn't exist, can't update
        logger.warn(`Cannot recover update for non-existent appointment ${appointmentData.appointmentId}`);
        return true; // Mark as "recovered" since we can't do anything
      }
      
      // Try to update the appointment again
      await this.sheetsService.updateAppointment(appointmentData);
      return true;
    } catch (error) {
      logger.error(`Failed to recover appointment update for ${appointmentData.appointmentId}`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Recover client update operation
   */
  private async recoverClientUpdate(
    operation: FailedOperation, 
    strategy: RecoveryStrategy
  ): Promise<boolean> {
    const clientData = operation.data;
    
    try {
      // Try to update client preferences again
      await this.sheetsService.updateClientPreference(clientData);
      return true;
    } catch (error) {
      logger.error(`Failed to recover client update for ${clientData.clientId}`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Recover audit log operation
   */
  private async recoverAuditLog(
    operation: FailedOperation, 
    strategy: RecoveryStrategy
  ): Promise<boolean> {
    const logEntry = operation.data;
    
    try {
      // Try to add audit log entry again
      await this.sheetsService.addAuditLog(logEntry);
      return true;
    } catch (error) {
      logger.error(`Failed to recover audit log entry`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Load failed operations from storage
   */
  private loadFailedOperations(): void {
    try {
      const stored = process.env.NODE_ENV === 'test' 
        ? null  // Skip loading in test environment
        : typeof localStorage !== 'undefined' 
          ? localStorage.getItem(this.storageKey)
          : null;
      
      if (stored) {
        const operations = JSON.parse(stored) as FailedOperation[];
        this.failedOperations = new Map(
          operations.map(op => [op.id, op])
        );
        logger.info(`Loaded ${this.failedOperations.size} failed operations from storage`);
      }
    } catch (error) {
      logger.error('Error loading failed operations from storage', error instanceof Error ? error : new Error(String(error)));
      // Start with empty map
      this.failedOperations = new Map();
    }
  }

  /**
   * Save failed operations to storage
   */
  private saveFailedOperations(): void {
    try {
      const operations = Array.from(this.failedOperations.values());
      
      if (process.env.NODE_ENV !== 'test' && typeof localStorage !== 'undefined') {
        localStorage.setItem(this.storageKey, JSON.stringify(operations));
        logger.debug(`Saved ${operations.length} failed operations to storage`);
      }
    } catch (error) {
      logger.error('Error saving failed operations to storage', error instanceof Error ? error : new Error(String(error)));
    }
  }
}