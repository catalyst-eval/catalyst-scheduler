// src/routes/webhooks/intakeq.ts
import { Request, Response, NextFunction } from 'express';
import { WebhookHandler } from '../../lib/intakeq/webhook-handler';
import { AppointmentSyncHandler } from '../../lib/intakeq/appointment-sync';
import { IntakeQService } from '../../lib/intakeq/service';
import { GoogleSheetsService, AuditEventType } from '../../lib/google/sheets';
import { logger } from '../../lib/util/logger';
import { enhancedDeleteAppointment } from '../../lib/util/service-initializer';
import { verifyAppointmentDeletion } from '../../lib/util/row-monitor';
import { ErrorRecoveryService, OperationType } from '../../lib/util/error-recovery';
import * as crypto from 'crypto';

// Create service instances
const sheetsService = new GoogleSheetsService();
const intakeQService = new IntakeQService(sheetsService);
const appointmentSyncHandler = new AppointmentSyncHandler(sheetsService, intakeQService);
const webhookHandler = new WebhookHandler(sheetsService, appointmentSyncHandler, intakeQService);

/**
 * Middleware to validate IntakeQ webhook signature
 */
export async function validateWebhookSignature(req: Request, res: Response, next: NextFunction) {
  try {
    const signature = req.headers['x-intakeq-signature'] as string;
    
    if (!signature) {
      logger.warn('Missing X-IntakeQ-Signature header');
      return res.status(401).json({
        success: false,
        error: 'Missing signature header',
        timestamp: new Date().toISOString()
      });
    }
    
    // Get raw body as string for signature verification
    const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    
    // Verify the signature
    const isValid = await intakeQService.validateWebhookSignature(payload, signature);
    
    if (!isValid) {
      logger.warn('Invalid webhook signature');
      await sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Invalid webhook signature',
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          signatureProvided: signature.substring(0, 10) + '...',
          signatureLength: signature.length,
          payloadLength: payload.length,
          headers: req.headers
        })
      });
      
      return res.status(401).json({
        success: false,
        error: 'Invalid signature',
        timestamp: new Date().toISOString()
      });
    }
    
    next();
  } catch (error: unknown) {
    const typedError = error instanceof Error ? error : new Error(String(error));
    logger.error('Error validating webhook signature:', typedError);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error validating signature',
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Process IntakeQ webhook
 * Enhanced with improved response handling and webhook queueing
 */
export async function processIntakeQWebhook(req: Request, res: Response) {
  const startTime = Date.now();
  const requestId = crypto.randomUUID(); // Generate unique request ID
  
  try {
    const payload = req.body;
    const eventType = payload.EventType || payload.Type;
    
    // Enhanced logging with additional context
    logger.info(`Received webhook: ${eventType} [${requestId}]`, {
      clientId: payload.ClientId,
      appointmentId: payload.Appointment?.Id,
      receivedAt: new Date().toISOString(),
      requestId
    });
    
    // Return a quick response to prevent IntakeQ webhook timeout
    // This is especially important for Render deployment
    res.status(202).json({
      success: true,
      message: 'Webhook received and queued for processing',
      timestamp: new Date().toISOString(),
      requestId
    });
    
    // Check if it's an appointment-related webhook 
    const isAppointmentRelated = payload.Appointment?.Id && 
      (eventType?.includes('Appointment') || eventType?.includes('appointment'));
      
    // Add to webhook queue to ensure proper sequencing
    if (isAppointmentRelated) {
      // Get or create entity-specific queue
      const queueKey = `appointment-${payload.Appointment.Id}`;
      
      // Add to queue with webhook manager
      if (req.app.locals.webhookManager) {
        req.app.locals.webhookManager.enqueueWebhook(
          queueKey, 
          payload, 
          req.app.locals.errorRecovery
        );
        logger.info(`Webhook for ${payload.Appointment.Id} added to processing queue [${requestId}]`);
      } else {
        // Fallback to immediate processing if webhook manager not available
        logger.warn(`Webhook manager not available, processing immediately [${requestId}]`);
        await processWebhookAsync(payload, req.app.locals.errorRecovery);
      }
    } else {
      // For non-appointment webhooks, process immediately
      await processWebhookAsync(payload, req.app.locals.errorRecovery);
    }
  } catch (error: unknown) {
    const processingTime = Date.now() - startTime;
    const typedError = error instanceof Error ? error : new Error(String(error));
    logger.error(`Webhook request handling error after ${processingTime}ms [${requestId}]:`, typedError);
    
    // Send error response if we haven't already sent a response
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error processing webhook',
        timestamp: new Date().toISOString(),
        requestId
      });
    }
  }
}

/**
 * Process webhook asynchronously with retry logic
 * Enhanced with better error handling and recurring pattern detection
 */
async function processWebhookAsync(
  payload: any, 
  errorRecovery?: ErrorRecoveryService,
  attempt = 0
): Promise<{ success: boolean; error?: string }> {
  const startTime = Date.now();
  const webhookId = crypto.randomUUID();
  
  try {
    // Log the start of processing
    logger.info(`Beginning webhook processing [${webhookId}]`, {
      type: payload.EventType || payload.Type,
      entityId: payload.Appointment?.Id || payload.IntakeId || '',
      attempt: attempt + 1
    });
    
    // Check if this is an appointment event
    const eventType = payload.EventType || payload.Type;
    const isAppointmentEvent = eventType && (
      eventType.includes('Appointment') || eventType.includes('appointment')
    );
    
    // Check for recurring appointment pattern
    const hasRecurrencePattern = payload.Appointment?.RecurrencePattern || 
      (payload.Appointment?.Notes && 
       (payload.Appointment.Notes.includes('recurring') || 
        payload.Appointment.Notes.includes('weekly') || 
        payload.Appointment.Notes.includes('biweekly')));
    
    // Process with appropriate handler
    let result;
    if (isAppointmentEvent && payload.Appointment) {
      // Check if it's a cancellation and use enhanced handling
      if (eventType.includes('Cancelled') || eventType.includes('Canceled') || eventType.includes('Deleted')) {
        if (errorRecovery) {
          // For cancellations, add slight delay to ensure creation webhook is processed first
          if (attempt === 0) {
            logger.info(`Adding 500ms delay before processing cancellation [${webhookId}]`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          
          // Process cancellation with enhanced error recovery
          result = await processEnhancedCancellation(payload, errorRecovery);
        } else {
          // Use standard handler if error recovery is not available
          result = await appointmentSyncHandler.processAppointmentEvent(payload);
        }
      } else if (hasRecurrencePattern) {
        // Special handling for recurring appointments
        logger.info(`Processing recurring appointment pattern [${webhookId}]`);
        result = await appointmentSyncHandler.processRecurringAppointment(payload);
      } else {
        // Use standard handler for other appointment events
        result = await appointmentSyncHandler.processAppointmentEvent(payload);
      }
    } else {
      result = await webhookHandler.processWebhook(payload);
    }
    
    // Log processing time
    const processingTime = Date.now() - startTime;
    logger.info(`Webhook processing complete in ${processingTime}ms [${webhookId}]`, {
      success: result.success,
      type: eventType,
      entityId: payload.Appointment?.Id || payload.IntakeId || ''
    });
    
    return result;
  } catch (error: unknown) {
    const processingTime = Date.now() - startTime;
    const typedError = error instanceof Error ? error : new Error(String(error));
    logger.error(`Webhook processing error after ${processingTime}ms [${webhookId}]:`, typedError);
    
    // Determine if we should retry
    const isRetryable = isRetryableError(error);
    const shouldRetry = isRetryable && attempt < 3;
    
    if (shouldRetry) {
      // Exponential backoff
      const delay = Math.pow(2, attempt) * 1000;
      logger.info(`Retrying webhook in ${delay}ms (attempt ${attempt + 1}) [${webhookId}]`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return processWebhookAsync(payload, errorRecovery, attempt + 1);
    } else {
      // Record failed operation for later recovery if error recovery is available
      if (errorRecovery && isAppointmentEventPayload(payload)) {
        const operationType = getOperationTypeForEvent(payload);
        if (operationType) {
          errorRecovery.recordFailedOperation(
            operationType,
            {
              appointmentId: payload.Appointment?.Id,
              payload: payload,
              processedAt: new Date().toISOString(),
              webhookId
            },
            typedError // Properly typed Error object
          );
          
          logger.info('Failed operation recorded for recovery', {
            type: operationType,
            appointmentId: payload.Appointment?.Id,
            webhookId
          });
        }
      }
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

/**
 * WebhookManager class to handle webhook queue processing
 * This ensures webhooks for the same entity are processed in sequence
 */
export class WebhookManager {
  private queues: Map<string, Array<any>> = new Map();
  private processing: Set<string> = new Set();
  private readonly MAX_QUEUE_SIZE = 100;
  
  constructor() {
    // Start background processing
    setInterval(() => this.processQueues(), 1000);
    
    // Log queue status periodically
    setInterval(() => this.logQueueStatus(), 30000);
  }
  
  /**
   * Add a webhook to its entity-specific queue
   */
  enqueueWebhook(queueKey: string, payload: any, errorRecovery?: ErrorRecoveryService): void {
    // Get or create queue
    if (!this.queues.has(queueKey)) {
      this.queues.set(queueKey, []);
    }
    
    const queue = this.queues.get(queueKey)!;
    
    // Cap queue size to prevent memory issues
    if (queue.length >= this.MAX_QUEUE_SIZE) {
      logger.warn(`Queue for ${queueKey} has reached maximum size, dropping oldest item`);
      queue.shift(); // Remove oldest item
    }
    
    // Add to queue with metadata
    queue.push({
      payload,
      addedAt: Date.now(),
      errorRecovery
    });
    
    logger.debug(`Added webhook to queue ${queueKey}, queue size: ${queue.length}`);
  }
  
  /**
   * Process all queues in the background
   */
  private async processQueues(): Promise<void> {
    // Process each queue that isn't already being processed
    for (const [queueKey, queue] of this.queues.entries()) {
      if (queue.length > 0 && !this.processing.has(queueKey)) {
        this.processing.add(queueKey);
        
        // Process the next item in the queue
        try {
          const item = queue[0];
          
          // Log queue processing
          logger.debug(`Processing webhook from queue ${queueKey}, queue size: ${queue.length}`);
          
          // Process webhook
          await processWebhookAsync(item.payload, item.errorRecovery);
          
          // Remove the processed item
          queue.shift();
        } catch (error: unknown) {
          // Properly type-narrow the error
          const typedError = error instanceof Error 
            ? error 
            : new Error(typeof error === 'string' ? error : 'Unknown error during webhook processing');
          
          logger.error(`Error processing webhook from queue ${queueKey}:`, typedError);
        } finally {
          // Release the queue
          this.processing.delete(queueKey);
        }
      }
    }
    
    // Clean up empty queues
    for (const [queueKey, queue] of this.queues.entries()) {
      if (queue.length === 0) {
        this.queues.delete(queueKey);
      }
    }
  }
  
  /**
   * Log queue status for monitoring
   */
  private logQueueStatus(): void {
    const queueSizes = Array.from(this.queues.entries()).map(([key, queue]) => ({
      queue: key,
      size: queue.length,
      oldestItem: queue.length > 0 ? Date.now() - queue[0].addedAt : 0
    }));
    
    if (queueSizes.length > 0) {
      logger.info('Current webhook queue status:', {
        totalQueues: this.queues.size,
        totalItems: queueSizes.reduce((sum, q) => sum + q.size, 0),
        activeProcessing: this.processing.size,
        queues: queueSizes
      });
    }
  }
}

/**
 * Enhanced cancellation processing with error recovery
 */
async function processEnhancedCancellation(
  payload: any,
  errorRecovery: ErrorRecoveryService
): Promise<{ success: boolean; error?: string; details?: any }> {
  try {
    logger.info('Processing appointment cancellation with enhanced error recovery', {
      appointmentId: payload.Appointment?.Id
    });
    
    // 1. Check if appointment exists
    const existingAppointment = await sheetsService.getAppointment(payload.Appointment.Id);
    
    if (!existingAppointment) {
      return {
        success: false,
        error: `Appointment ${payload.Appointment.Id} not found for cancellation`,
        details: {
          appointmentId: payload.Appointment.Id,
          action: 'appointment_not_found'
        }
      };
    }
    
    try {
      // 2. Use the enhanced delete method for improved reliability
      const success = await enhancedDeleteAppointment(
        sheetsService,
        errorRecovery,
        payload.Appointment.Id
      );
      
      if (!success) {
        logger.warn(`Enhanced delete failed for appointment ${payload.Appointment.Id}, attempting fallback`);
        
        // Fallback to status update
        const cancellationUpdate = {
          ...existingAppointment,
          status: 'cancelled' as 'cancelled',
          lastUpdated: new Date().toISOString(),
          notes: (existingAppointment.notes || '') + 
                 `\nCancelled: ${new Date().toISOString()}` + 
                 (payload.Appointment.CancellationReason ? `\nReason: ${payload.Appointment.CancellationReason}` : '')
        };
        
        // Update the appointment with cancelled status
        await sheetsService.updateAppointment(cancellationUpdate);
        logger.info(`Fallback successful: Updated appointment ${payload.Appointment.Id} status to cancelled`);
      }
    } catch (error: unknown) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      logger.error(`Both deletion and status update failed for appointment ${payload.Appointment.Id}`, typedError);
      throw error;
    }
    
    // 3. Log cancellation
    await sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'APPOINTMENT_CANCELLED' as AuditEventType,
      description: `Cancelled appointment ${payload.Appointment.Id}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        appointmentId: payload.Appointment.Id,
        clientId: payload.ClientId,
        reason: payload.Appointment.CancellationReason || 'No reason provided'
      })
    });

    return {
      success: true,
      details: {
        appointmentId: payload.Appointment.Id,
        action: 'cancelled_and_processed'
      }
    };
  } catch (error: unknown) {
    const typedError = error instanceof Error ? error : new Error(String(error));
    logger.error('Error handling appointment cancellation:', typedError);
    
    // Add detailed error logging
    await sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'SYSTEM_ERROR' as AuditEventType,
      description: `Error cancelling appointment ${payload.Appointment?.Id}`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    throw error;
  }
}

/**
 * Check if a payload is an appointment event
 */
function isAppointmentEventPayload(payload: any): boolean {
  const eventType = payload.EventType || payload.Type;
  return !!(eventType && 
    (eventType.includes('Appointment') || eventType.includes('appointment')) &&
    payload.Appointment);
}

/**
 * Get operation type for event
 */
function getOperationTypeForEvent(payload: any): OperationType | null {
  const eventType = payload.EventType || payload.Type;
  
  if (!eventType) return null;
  
  if (eventType.includes('Cancelled') || eventType.includes('Canceled')) {
    return OperationType.APPOINTMENT_DELETION;
  } else if (eventType.includes('Created')) {
    return OperationType.APPOINTMENT_CREATION;
  } else if (eventType.includes('Updated') || eventType.includes('Rescheduled')) {
    return OperationType.APPOINTMENT_UPDATE;
  }
  
  return null;
}

/**
 * Determine if an error is retryable
 */
function isRetryableError(error: unknown): boolean {
  // First type-narrow the error
  const typedError = error instanceof Error ? error : 
                    (typeof error === 'string' ? new Error(error) : 
                    new Error('Unknown error'));
  
  // Network errors are typically retryable
  if (typedError.message.includes('network') || 
      typedError.message.includes('timeout') ||
      typedError.message.includes('ECONNREFUSED') ||
      typedError.message.includes('ETIMEDOUT')) {
    return true;
  }

  // API rate limiting errors are retryable
  if (typedError.message.includes('rate limit') || 
      typedError.message.includes('429') ||
      typedError.message.includes('too many requests')) {
    return true;
  }

  // Temporary service errors are retryable
  if (typedError.message.includes('503') || 
      typedError.message.includes('502') ||
      typedError.message.includes('temporary') ||
      typedError.message.includes('unavailable')) {
    return true;
  }
  
  // Axios specific error detection - with proper type checking
  if (error && typeof error === 'object') {
    const errorObj = error as Record<string, any>; // Safe type assertion after previous checks
    const isAxiosError = 'isAxiosError' in errorObj && errorObj.isAxiosError === true;
    
    if (isAxiosError) {
      const status = errorObj.response?.status;
      if (status && (status === 429 || status >= 500)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Test webhook endpoint for development and testing
 */
export async function testWebhook(req: Request, res: Response) {
  try {
    const payload = req.body;
    logger.info('Received test webhook:', { payload });
    
    if (!payload || !payload.ClientId) {
      res.status(400).json({
        success: false,
        error: 'Invalid payload format. Must include ClientId field.'
      });
      return;
    }
    
    // Generate a signature for testing
    const payloadStr = JSON.stringify(payload);
    const secret = process.env.INTAKEQ_WEBHOOK_SECRET || 'test-secret';
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payloadStr);
    const signature = hmac.digest('hex');
    
    logger.info('Test webhook signature:', {
      generated: signature.substring(0, 10) + '...',
      secret: secret ? '[PRESENT]' : '[MISSING]',
      payloadLength: payloadStr.length
    });
    
    // Process webhook with bypassing signature verification
    const eventType = payload.EventType || payload.Type;
    const isAppointmentEvent = eventType && (
      eventType.includes('Appointment') || eventType.includes('appointment')
    );
    
    let result;
    if (isAppointmentEvent) {
      result = await appointmentSyncHandler.processAppointmentEvent(payload);
    } else {
      result = await webhookHandler.processWebhook(payload);
    }
    
    res.json({
      success: result.success,
      data: result.details,
      error: result.error,
      signature: signature.substring(0, 10) + '...',
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    const typedError = error instanceof Error ? error : new Error(String(error));
    logger.error('Error processing test webhook:', typedError);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Diagnostic endpoint for webhook configuration
 */
export async function getWebhookHealth(req: Request, res: Response) {
  try {
    // Test IntakeQ connection
    const intakeQConnected = await intakeQService.testConnection();
    
    // Test Google Sheets connection
    let sheetsConnected = false;
    let sheetsData = {};
    try {
      const offices = await sheetsService.getOffices();
      sheetsConnected = true;
      sheetsData = {
        officesCount: offices.length,
        sheetNames: {
          officesSheet: 'Offices_Configuration',
          appointmentsSheet: 'Appointments',
          clientPreferencesSheet: 'Client_Preferences',
          clientAccessibilitySheet: 'Client_Accessibility_Info'
        }
      };
    } catch (error: unknown) {
      sheetsData = {
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
    
    // Check if enhanced services are available
    const enhancedServices = {
      errorRecovery: !!req.app.locals.errorRecovery,
      rowMonitor: !!req.app.locals.rowMonitor,
      webhookManager: !!req.app.locals.webhookManager
    };
    
    res.json({
      status: (intakeQConnected && sheetsConnected) ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      message: 'Webhook service diagnostic results',
      environment: process.env.NODE_ENV,
      enhancedServices,
      webhooks: {
        intakeq: {
          enabled: true,
          connected: intakeQConnected,
          config: {
            apiKeyConfigured: !!process.env.INTAKEQ_API_KEY,
            webhookSecretConfigured: !!process.env.INTAKEQ_WEBHOOK_SECRET
          }
        }
      },
      googleSheets: {
        connected: sheetsConnected,
        ...sheetsData
      }
    });
  } catch (error: unknown) {
    const typedError = error instanceof Error ? error : new Error(String(error));
    logger.error('Error getting webhook health:', typedError);
    
    res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
}