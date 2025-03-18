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
    
    // Start row monitoring service
    logger.info('Starting row monitoring service');
    rowMonitor.startMonitoring();
    
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
    // Attempt to delete the appointment
    await sheetsService.deleteAppointment(appointmentId);
    
    // Verify the deletion was successful
    const verified = await verifyAppointmentDeletion(sheetsService, appointmentId);
    
    if (!verified) {
      logger.warn(`Deletion verification failed for appointment ${appointmentId}, recording failed operation`);
      
      // Record the failed operation for later recovery
      errorRecovery.recordFailedOperation(
        OperationType.APPOINTMENT_DELETION,
        { appointmentId },
        'Deletion verification failed'
      );
      
      return false;
    }
    
    logger.info(`Successfully deleted and verified appointment ${appointmentId}`);
    return true;
  } catch (error: unknown) {
    const typedError = error instanceof Error ? error : new Error(String(error));
    logger.error(`Error deleting appointment ${appointmentId}`, typedError);
    
    // Record the failed operation for later recovery
    errorRecovery.recordFailedOperation(
      OperationType.APPOINTMENT_DELETION,
      { appointmentId },
      typedError
    );
    
    return false;
  }
}