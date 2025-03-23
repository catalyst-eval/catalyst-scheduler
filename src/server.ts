// src/server.ts
import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import apiRoutes from './routes/index';
import { validateIntakeQWebhook } from './middleware/verify-signature';
import { SchedulerService } from './lib/scheduling/scheduler-service';
import schedulingRoutes from './routes/scheduling';
import { GoogleSheetsService } from './lib/google/sheets';
import { initializeServices, EnhancedServices } from './lib/util/service-initializer';
import { logger } from './lib/util/logger';
import diagnosticsRoutes from './routes/maintenance/diagnostics';
import testingRoutes from './routes/testing/office-assignments';
import { AppointmentSyncHandler } from './lib/intakeq/appointment-sync';
import { RowMonitorService } from './lib/util/row-monitor';

// Load environment variables
dotenv.config();

// Log environment variable status for debugging
logger.info('ENV check on startup:', {
  googleSheetsPrivateKeyExists: !!process.env.GOOGLE_SHEETS_PRIVATE_KEY,
  googleSheetsClientEmailExists: !!process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
  intakeQApiKeyExists: !!process.env.INTAKEQ_API_KEY,
  intakeQWebhookSecretExists: !!process.env.INTAKEQ_WEBHOOK_SECRET,
  disableApiCalls: process.env.DISABLE_API_CALLS,
  nodeEnv: process.env.NODE_ENV
});

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize services in correct order
const sheetsService = new GoogleSheetsService();

// Basic JSON parser for all routes
app.use(express.json());
app.use('/api/scheduling', schedulingRoutes);
app.use('/api/testing', testingRoutes);

// Initialize scheduler and make it available app-wide
const schedulerService = new SchedulerService();
app.locals.scheduler = schedulerService;
app.locals.sheetsService = sheetsService;

// Initialize enhanced services
initializeServices(sheetsService)
  .then((services: EnhancedServices) => {
    // Make services available application-wide
    app.locals.errorRecovery = services.errorRecovery;
    app.locals.rowMonitor = services.rowMonitor;
    
    // Set up AppointmentSyncHandler with sheets service
    const appointmentSyncHandler = new AppointmentSyncHandler(sheetsService);
    app.locals.appointmentSyncHandler = appointmentSyncHandler;
    
    // Connect dependent services to scheduler
    if (services.rowMonitor) {
      schedulerService.setRowMonitorService(services.rowMonitor);
      logger.info('Row monitor service connected to scheduler');
    }
    
    if (appointmentSyncHandler) {
      schedulerService.setAppointmentSyncHandler(appointmentSyncHandler);
      logger.info('Appointment sync handler connected to scheduler');
    }
    
    // Only after all dependencies are registered, initialize the scheduler
    schedulerService.initialize();
    logger.info('Scheduler service initialized with all dependencies');
    
    logger.info('Enhanced services successfully initialized');
  })
  .catch((error: unknown) => {
    const typedError = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to initialize enhanced services', typedError);
  });

// Simple health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version: '1.0.0',
    schedulerActive: true,
    enhancedServices: {
      errorRecovery: !!app.locals.errorRecovery,
      rowMonitor: !!app.locals.rowMonitor,
      appointmentSyncHandler: !!app.locals.appointmentSyncHandler
    }
  });
});

// Mount API routes
app.use('/api', apiRoutes);
app.use('/api/diagnostics', diagnosticsRoutes);

// Start server
const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  logger.info(`Webhook endpoint available at http://localhost:${PORT}/api/webhooks/intakeq`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  
  // Stop scheduler
  schedulerService.stop();
  
  // Stop enhanced services
  if (app.locals.errorRecovery) {
    app.locals.errorRecovery.stopRecovery();
  }
  
  if (app.locals.rowMonitor) {
    app.locals.rowMonitor.stopMonitoring();
  }
  
  // Close server
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  
  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
});

// Export for testing
export default app;