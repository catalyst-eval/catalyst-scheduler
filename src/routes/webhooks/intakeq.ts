// src/routes/webhooks/intakeq.ts
import { Request, Response, NextFunction } from 'express';
import { WebhookHandler } from '../../lib/intakeq/webhook-handler';
import { AppointmentSyncHandler } from '../../lib/intakeq/appointment-sync';
import { IntakeQService } from '../../lib/intakeq/service';
import { GoogleSheetsService, AuditEventType } from '../../lib/google/sheets';

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
      console.warn('Missing X-IntakeQ-Signature header');
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
      console.warn('Invalid webhook signature');
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
  } catch (error) {
    console.error('Error validating webhook signature:', error);
    
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
    console.log(`[${new Date().toISOString()}] Received webhook: ${eventType}`, {
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
    processWebhookAsync(payload)
      .then(result => {
        const processingTime = Date.now() - startTime;
        console.log(`Webhook processing completed in ${processingTime}ms`, {
          success: result.success,
          type: eventType,
          appointmentId: payload.Appointment?.Id
        });
      })
      .catch(error => {
        const processingTime = Date.now() - startTime;
        console.error(`Webhook processing failed after ${processingTime}ms:`, error);
        
        // Log the error
        sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: AuditEventType.SYSTEM_ERROR,
          description: `Failed to process webhook ${eventType}`,
          user: 'SYSTEM',
          systemNotes: error instanceof Error ? error.message : 'Unknown error'
        }).catch(logError => {
          console.error('Failed to log error to audit log:', logError);
        });
      });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`Webhook request handling error after ${processingTime}ms:`, error);
    
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
async function processWebhookAsync(payload: any, attempt = 0): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if this is an appointment event
    const eventType = payload.EventType || payload.Type;
    const isAppointmentEvent = eventType && (
      eventType.includes('Appointment') || eventType.includes('appointment')
    );
    
    // Process with appropriate handler
    if (isAppointmentEvent && payload.Appointment) {
      return await appointmentSyncHandler.processAppointmentEvent(payload);
    } else {
      return await webhookHandler.processWebhook(payload);
    }
  } catch (error) {
    console.error(`Webhook processing error (attempt ${attempt + 1}):`, error);
    
    // Determine if we should retry
    const isRetryable = isRetryableError(error);
    const shouldRetry = isRetryable && attempt < 3;
    
    if (shouldRetry) {
      // Exponential backoff
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`Retrying webhook in ${delay}ms (attempt ${attempt + 1})`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return processWebhookAsync(payload, attempt + 1);
    } else {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
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
    console.log('Received test webhook:', payload);
    
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
    
    console.log('Test webhook signature:', {
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
  } catch (error) {
    console.error('Error processing test webhook:', error);
    
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
    } catch (error) {
      sheetsData = {
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
    
    res.json({
      status: (intakeQConnected && sheetsConnected) ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      message: 'Webhook service diagnostic results',
      environment: process.env.NODE_ENV,
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
  } catch (error) {
    console.error('Error getting webhook health:', error);
    
    res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
}