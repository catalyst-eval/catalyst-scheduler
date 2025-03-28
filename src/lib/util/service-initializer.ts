// src/lib/util/service-initializer.ts

import { GoogleSheetsService } from '../google/sheets';
import { IntakeQService } from '../intakeq/service';
import { AppointmentSyncHandler } from '../intakeq/appointment-sync';
import { WebhookHandler } from '../intakeq/webhook-handler';
import { ErrorRecoveryService, OperationType } from './error-recovery';
import { RowMonitorService } from './row-monitor';
import { verifyAppointmentDeletion } from './row-monitor';
import { logger } from './logger';
import { DailyScheduleService } from '../scheduling/daily-schedule-service';
import { SchedulerService } from '../scheduling/scheduler-service';
import { EmailService } from '../email/service';

/**
 * Safely handle errors for logging
 */
function handleError(error: unknown): { message: string, details?: any } {
  if (error instanceof Error) {
    return {
      message: error.message,
      details: error.stack
    };
  } else if (typeof error === 'string') {
    return {
      message: error
    };
  } else if (error && typeof error === 'object') {
    return {
      message: String(error),
      details: error
    };
  } else {
    return {
      message: 'Unknown error'
    };
  }
}

/**
 * Application services container
 * Central registry of all application services for dependency injection
 */
export interface ServiceContainer {
  sheetsService: GoogleSheetsService;
  intakeQService: IntakeQService;
  appointmentSyncHandler: AppointmentSyncHandler;
  webhookHandler: WebhookHandler;
  dailyScheduleService: DailyScheduleService;
  schedulerService: SchedulerService;
  emailService: EmailService;
  errorRecovery?: ErrorRecoveryService;
  rowMonitor?: RowMonitorService;
}

/**
 * Initialize all core services
 * Creates and connects all services with proper dependency injection
 */
export async function initializeServices(
  options: {
    enableErrorRecovery?: boolean;
    enableRowMonitoring?: boolean;
    runSheetVerification?: boolean;
    initializeScheduler?: boolean;
  } = {}
): Promise<ServiceContainer> {
  logger.info('Initializing application services', options);

  try {
    // 1. Create base Google Sheets service - foundation for all other services
    const sheetsService = new GoogleSheetsService();
    logger.info('GoogleSheetsService initialized');

    // 2. Create IntakeQ service with sheets dependency
    const intakeQService = new IntakeQService(sheetsService);
    logger.info('IntakeQService initialized');

    // 3. Create appointment sync handler
    const appointmentSyncHandler = new AppointmentSyncHandler(sheetsService, intakeQService);
    logger.info('AppointmentSyncHandler initialized');

    // 4. Create webhook handler with all dependencies
    const webhookHandler = new WebhookHandler(sheetsService, appointmentSyncHandler, intakeQService);
    logger.info('WebhookHandler initialized');

    // 6. Create email service
    const emailService = new EmailService(sheetsService);
    logger.info('EmailService initialized');

    // 7. Create daily schedule service
    const dailyScheduleService = new DailyScheduleService(sheetsService);
    logger.info('DailyScheduleService initialized');

    // 8. Create scheduler service with its dependencies
    const schedulerService = new SchedulerService();
    // The scheduler initializes its own dependencies internally
    // This is maintained for backward compatibility
    logger.info('SchedulerService created (will be initialized later if requested)');

    // 9. Initialize optional enhanced services based on options
    let errorRecovery: ErrorRecoveryService | undefined;
    let rowMonitor: RowMonitorService | undefined;

    if (options.enableErrorRecovery) {
      errorRecovery = new ErrorRecoveryService(sheetsService);
      errorRecovery.startRecovery();
      logger.info('ErrorRecoveryService initialized and started');
    }

    if (options.enableRowMonitoring) {
      rowMonitor = new RowMonitorService(sheetsService);
      rowMonitor.startMonitoring();
      logger.info('RowMonitorService initialized and started');
    }

    // 10. Initialize the scheduler if requested
    if (options.initializeScheduler) {
      schedulerService.initialize();
      logger.info('SchedulerService initialized');
      
      // Set appointment sync handler in scheduler
      schedulerService.setAppointmentSyncHandler(appointmentSyncHandler);
      
      // Set row monitor in scheduler if available
      if (rowMonitor) {
        schedulerService.setRowMonitorService(rowMonitor);
      }
    }

    // Create service container
    const services: ServiceContainer = {
      sheetsService,
      intakeQService,
      appointmentSyncHandler,
      webhookHandler,
      dailyScheduleService,
      schedulerService,
      emailService,
      errorRecovery,
      rowMonitor
    };

    logger.info('Service initialization complete');
    return services;
  } catch (error) {
    const errorInfo = handleError(error);
    logger.error('Failed to initialize services', errorInfo);
    throw error;
  }
}

/**
 * Shutdown all services gracefully
 */
export async function shutdownServices(container: ServiceContainer): Promise<void> {
  logger.info('Shutting down services...');

  try {
    // Stop enhanced services first
    if (container.errorRecovery) {
      container.errorRecovery.stopRecovery();
      logger.info('ErrorRecoveryService stopped');
    }

    if (container.rowMonitor) {
      container.rowMonitor.stopMonitoring();
      logger.info('RowMonitorService stopped');
    }

    // Log successful shutdown
    logger.info('All services shut down successfully');
  } catch (error) {
    const errorInfo = handleError(error);
    logger.error('Error during service shutdown', errorInfo);
    throw error;
  }
}

/**
 * Enhanced appointment deletion with verification and error recovery
 */
export async function enhancedDeleteAppointment(
  sheetsService: GoogleSheetsService,
  errorRecovery: ErrorRecoveryService | undefined,
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
      if (errorRecovery) {
        errorRecovery.recordFailedOperation(
          OperationType.APPOINTMENT_DELETION,
          { appointmentId },
          'Deletion verification failed despite recovery attempts'
        );
      }
      
      return false;
    }
    
    logger.info(`Successfully deleted and verified appointment ${appointmentId}`);
    return true;
  } catch (error) {
    const errorInfo = handleError(error);
    logger.error(`Error deleting appointment ${appointmentId}`, errorInfo);
    
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
    } catch (fallbackError) {
      const fallbackErrorInfo = handleError(fallbackError);
      logger.error(`Fallback methods also failed for appointment ${appointmentId}`, fallbackErrorInfo);
    }
    
    // Record the failed operation for later recovery
    if (errorRecovery) {
      errorRecovery.recordFailedOperation(
        OperationType.APPOINTMENT_DELETION,
        { appointmentId },
        errorInfo.message
      );
    }
    
    return false;
  }
}