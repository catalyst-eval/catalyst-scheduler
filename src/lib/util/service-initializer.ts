// src/lib/util/service-initializer.ts

import { logger } from './logger';
import { runSheetVerification } from './sheet-verification';
import { ErrorRecoveryService, OperationType } from './error-recovery';
import { RowMonitorService, verifyAppointmentDeletion } from './row-monitor';
import { IGoogleSheetsService } from '../google/sheets';

/**
 * Interface defining the return value of initializeServices
 */
export interface EnhancedServices {
  errorRecovery: ErrorRecoveryService;
  rowMonitor: RowMonitorService;
}

/**
 * Initialize all utility services
 * This provides a single point to start up all the enhancement services
 */
// Modify initializeServices to set row monitoring correctly
export async function initializeServices(sheetsService: IGoogleSheetsService): Promise<EnhancedServices> {
  logger.info('Initializing enhanced services');
  
  // Create services
  const errorRecovery = new ErrorRecoveryService(sheetsService);
  const rowMonitor = new RowMonitorService(sheetsService);
  
  try {
    // Run sheet verification at startup
    logger.info('Running sheet structure verification');
    const verificationResult = await runSheetVerification();
    
    if (!verificationResult.verified) {
      logger.warn('Sheet structure verification failed - see logs for details');
    }
    
    // Start error recovery service
    logger.info('Starting error recovery service');
    errorRecovery.startRecovery();
    
    // Initialize row monitoring but DO NOT start automatic monitoring
    logger.info('Initializing row monitoring service (scheduled mode)');
    rowMonitor.startMonitoring(); // This will now only take an initial snapshot without intervals
    
    logger.info('Enhanced services successfully initialized');
    
    return {
      errorRecovery,
      rowMonitor
    };
  } catch (error: unknown) {
    const typedError = error instanceof Error ? error : new Error(String(error));
    logger.error('Error initializing enhanced services', typedError);
    throw typedError;
  }
}

/**
 * Enhanced wrapper for deleteAppointment that includes verification and recovery
 * This demonstrates how to use the new utilities for improved reliability
 */
export async function enhancedDeleteAppointment(
    sheetsService: IGoogleSheetsService,
    errorRecovery: ErrorRecoveryService,
    appointmentId: string
  ): Promise<boolean> {
    logger.info(`Enhanced delete appointment: ${appointmentId}`);
    
    try {
      // 1. Attempt to delete the appointment
      await sheetsService.deleteAppointment(appointmentId);
      
      // 2. Verify the deletion was successful with enhanced verification
      // Enable forceCleanup to try alternative deletion methods if verification fails
      const verified = await verifyAppointmentDeletion(
        sheetsService, 
        appointmentId, 
        true, 
        { maxRetries: 2, retryDelayMs: 1000, forceCleanup: true }
      );
      
      if (!verified) {
        logger.warn(`Deletion verification failed for appointment ${appointmentId}, recording failed operation`);
        
        // Record the failed operation for later recovery
        errorRecovery.recordFailedOperation(
          OperationType.APPOINTMENT_DELETION,
          { appointmentId },
          'Deletion verification failed despite recovery attempts'
        );
        
        return false;
      }
      
      logger.info(`Successfully deleted and verified appointment ${appointmentId}`);
      return true;
    } catch (error: unknown) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      logger.error(`Error deleting appointment ${appointmentId}`, typedError);
      
      // Try the alternative deletion methods immediately as a fallback
      try {
        logger.info(`Attempting direct alternative deletion for ${appointmentId} after primary method failed`);
        
        // Get access to the appointment
        const appointment = await sheetsService.getAppointment(appointmentId);
        
        if (appointment) {
          // First try alternative deletion methods through verification
          const alternativeSuccess = await verifyAppointmentDeletion(
            sheetsService, 
            appointmentId, 
            true, 
            { maxRetries: 2, retryDelayMs: 1000, forceCleanup: true }
          );
          
          if (alternativeSuccess) {
            logger.info(`Alternative deletion successful for appointment ${appointmentId}`);
            return true;
          }
          
          // If still not deleted, fall back to status update
          logger.info(`Falling back to status update for appointment ${appointmentId}`);
          
          const cancellationUpdate = {
            ...appointment,
            status: 'cancelled' as 'cancelled',
            lastUpdated: new Date().toISOString(),
            notes: (appointment.notes || '') + `\nCancelled after failed deletion: ${new Date().toISOString()}`
          };
          
          await sheetsService.updateAppointment(cancellationUpdate);
          logger.info(`Successfully updated appointment ${appointmentId} status to cancelled as fallback`);
          
          // While we didn't delete the row, we did implement the cancellation logic successfully
          return true;
        }
      } catch (fallbackError: unknown) {
        const typedFallbackError = fallbackError instanceof Error 
          ? fallbackError 
          : new Error(String(fallbackError));
        
        logger.error(`Fallback methods also failed for appointment ${appointmentId}`, typedFallbackError);
      }
      
      // Record the failed operation for later recovery
      errorRecovery.recordFailedOperation(
        OperationType.APPOINTMENT_DELETION,
        { appointmentId },
        typedError
      );
      
      return false;
    }
  }