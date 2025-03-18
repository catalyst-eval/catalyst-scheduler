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
 */
export async function processIntakeQWebhook(req: Request, res: Response) {
  const startTime = Date.now();
  
  try {
    const payload = req.body;
    const eventType = payload.EventType || payload.Type;
    
    // Log the webhook receipt immediately
    logger.info(`Received webhook: ${eventType}`, {
      clientId: payload.ClientId,
      appointmentId: payload.Appointment?.Id,
      receivedAt: new Date().toISOString()
    });
    
    // Return a quick response to prevent IntakeQ webhook timeout
    // This is especially important for Render deployment
    res.status(202).json({
      success: true,
      message: 'Webhook received and queued for processing',
      timestamp: new Date().toISOString()
    });
    
    // Process the webhook asynchronously
    processWebhookAsync(payload, req.app.locals.errorRecovery)
      .then(result => {
        const processingTime = Date.now() - startTime;
        logger.info(`Webhook processing completed in ${processingTime}ms`, {
          success: result.success,
          type: eventType,
          appointmentId: payload.Appointment?.Id
        });
      })
      .catch((error: unknown) => {
        const processingTime = Date.now() - startTime;
        const typedError = error instanceof Error ? error : new Error(String(error));
        logger.error(`Webhook processing failed after ${processingTime}ms:`, typedError);
        
        // Log the error
        sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: AuditEventType.SYSTEM_ERROR,
          description: `Failed to process webhook ${eventType}`,
          user: 'SYSTEM',
          systemNotes: error instanceof Error ? error.message : 'Unknown error'
        }).catch((logError: unknown) => {
          const typedLogError = logError instanceof Error ? logError : new Error(String(logError));
          logger.error('Failed to log error to audit log:', typedLogError);
        });
      });
  } catch (error: unknown) {
    const processingTime = Date.now() - startTime;
    const typedError = error instanceof Error ? error : new Error(String(error));
    logger.error(`Webhook request handling error after ${processingTime}ms:`, typedError);
    
    // Send error response if we haven't already sent a response
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error processing webhook',
        timestamp: new Date().toISOString()
      });
    }
  }
}

/**
 * Process webhook asynchronously with retry logic
 */
async function processWebhookAsync(
  payload: any, 
  errorRecovery?: ErrorRecoveryService,
  attempt = 0
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if this is an appointment event
    const eventType = payload.EventType || payload.Type;
    const isAppointmentEvent = eventType && (
      eventType.includes('Appointment') || eventType.includes('appointment')
    );
    
    // Process with appropriate handler
    if (isAppointmentEvent && payload.Appointment) {
      // Use enhanced appointment handling if it's a cancellation and errorRecovery is available
      if (eventType.includes('Cancelled') || eventType.includes('Canceled')) {
        if (errorRecovery) {
          // Process cancellation with enhanced error recovery
          return await processEnhancedCancellation(payload, errorRecovery);
        }
      }
      
      // Use standard handler for other appointment events
      return await appointmentSyncHandler.processAppointmentEvent(payload);
    } else {
      return await webhookHandler.processWebhook(payload);
    }
  } catch (error: unknown) {
    const typedError = error instanceof Error ? error : new Error(String(error));
    logger.error(`Webhook processing error (attempt ${attempt + 1}):`, typedError);
    
    // Determine if we should retry
    const isRetryable = isRetryableError(error);
    const shouldRetry = isRetryable && attempt < 3;
    
    if (shouldRetry) {
      // Exponential backoff
      const delay = Math.pow(2, attempt) * 1000;
      logger.info(`Retrying webhook in ${delay}ms (attempt ${attempt + 1})`);
      
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
              processedAt: new Date().toISOString()
            },
            typedError
          );
          
          logger.info('Failed operation recorded for recovery', {
            type: operationType,
            appointmentId: payload.Appointment?.Id
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
  if (error instanceof Error) {
    // Network errors are typically retryable
    if (error.message.includes('network') || 
        error.message.includes('timeout') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ETIMEDOUT')) {
      return true;
    }

    // API rate limiting errors are retryable
    if (error.message.includes('rate limit') || 
        error.message.includes('429') ||
        error.message.includes('too many requests')) {
      return true;
    }

    // Temporary service errors are retryable
    if (error.message.includes('503') || 
        error.message.includes('502') ||
        error.message.includes('temporary') ||
        error.message.includes('unavailable')) {
      return true;
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
    const hmac = require('crypto').createHmac('sha256', secret);
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
      rowMonitor: !!req.app.locals.rowMonitor
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