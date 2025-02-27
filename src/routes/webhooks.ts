// src/routes/webhooks.ts
import express, { Request, Response, NextFunction } from 'express';
import { validateIntakeQWebhook, IntakeQWebhookRequest } from '../middleware/verify-signature';
import { WebhookHandler } from '../lib/intakeq/webhook-handler';
import { AppointmentSyncHandler } from '../lib/intakeq/appointment-sync';
import GoogleSheetsService from '../lib/google/sheets';

// Create router
const router = express.Router();

// Initialize services
const sheetsService = new GoogleSheetsService();
const appointmentSyncHandler = new AppointmentSyncHandler(sheetsService);
const webhookHandler = new WebhookHandler(sheetsService);

// Apply basic validation middleware to the IntakeQ route
router.use('/intakeq', (req: Request, res: Response, next: NextFunction) => {
  validateIntakeQWebhook(req, res, next);
});

// Define route handlers separately to avoid TypeScript issues
const handleWebhook = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting webhook processing`);
  
  try {
    const payload = req.body;

    console.log('Received webhook:', { 
      type: payload.EventType || payload.Type,
      clientId: payload.ClientId,
      appointmentId: payload.Appointment?.Id,
      timestamp: new Date().toISOString()
    });

    // Check if it's an appointment event
    const eventType = payload.EventType || payload.Type;
    const isAppointmentEvent = eventType && (
      eventType.includes('Appointment') || eventType.includes('appointment')
    );

    // Use appropriate handler
    const processPromise = isAppointmentEvent 
      ? appointmentSyncHandler.processAppointmentEvent(payload)
      : webhookHandler.processWebhook(payload);

    const result = await processPromise;
    const processingTime = Date.now() - startTime;
    
    console.log('Webhook event processed:', {
      ...result,
      processingTime: `${processingTime}ms`
    });

    // Return appropriate response
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
        details: result.details,
        processingTime,
        timestamp: new Date().toISOString()
      });
    } else {
      res.json({
        success: true,
        data: result.details,
        processingTime,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error: unknown) {
    const processingTime = Date.now() - startTime;
    console.error('Webhook processing error:', {
      error,
      processingTime: `${processingTime}ms`
    });
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      processingTime,
      timestamp: new Date().toISOString()
    });
  }
};

const handleTestWebhook = async (req: Request, res: Response): Promise<void> => {
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
    
    // Process without signature verification
    const eventType = payload.EventType || payload.Type;
    const isAppointmentEvent = eventType && (
      eventType.includes('Appointment') || eventType.includes('appointment')
    );

    // Use appropriate handler
    const processPromise = isAppointmentEvent 
      ? appointmentSyncHandler.processAppointmentEvent(payload)
      : webhookHandler.processWebhook(payload);
    
    try {
      const result = await processPromise;
      res.json({
        success: result.success,
        data: result.details,
        error: result.error,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
};

const getRecentWebhooks = async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const logs = await sheetsService.getRecentAuditLogs(limit);
    
    const webhookLogs = logs.filter(log => 
      log.eventType === 'WEBHOOK_RECEIVED' || 
      log.eventType.includes('APPOINTMENT_')
    );
    
    res.json({
      success: true,
      data: webhookLogs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
};

const getHealth = (req: Request, res: Response): void => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    message: 'Webhook service is running correctly',
    webhooks: {
      intakeq: {
        enabled: true,
        config: {
          apiKeyConfigured: !!process.env.INTAKEQ_API_KEY
        }
      }
    },
    environment: process.env.NODE_ENV
  });
};

// Apply routes
router.post('/intakeq', handleWebhook);
router.post('/test-webhook', handleTestWebhook);
router.get('/recent', getRecentWebhooks);
router.get('/health', getHealth);

export default router;