// src/server.ts
import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import apiRoutes from './routes/index';
import { validateIntakeQWebhook } from './middleware/verify-signature';
import { SchedulerService } from './lib/scheduling/scheduler-service';
import schedulingRoutes from './routes/scheduling';
import { GoogleSheetsService } from './lib/google/sheets';
import { initializeServices, ServiceContainer } from './lib/util/service-initializer';
import { logger } from './lib/util/logger';
import diagnosticsRoutes from './routes/maintenance/diagnostics';
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

// Basic JSON parser for all routes
app.use(express.json());
app.use('/api/scheduling', schedulingRoutes);

// Declare scheduler variable but don't initialize yet
let schedulerService: SchedulerService | null = null;
app.locals.scheduler = null; // Will be set later

// Initialize services
const initializePromise = initializeServices({
  enableErrorRecovery: true,
  enableRowMonitoring: false,
  initializeScheduler: false // Don't initialize the scheduler yet
});

// Global services placeholder, will be populated when initializePromise resolves
let services: ServiceContainer;

// Set services in app.locals after they're initialized
initializePromise.then(initializedServices => {
  services = initializedServices;
  app.locals.sheetsService = services.sheetsService;
  app.locals.errorRecovery = services.errorRecovery;
  app.locals.rowMonitor = services.rowMonitor;
  app.locals.appointmentSyncHandler = services.appointmentSyncHandler;
  app.locals.webhookHandler = services.webhookHandler;
  
  // Now create the scheduler with the sheets service
  schedulerService = new SchedulerService(services.sheetsService);
  app.locals.scheduler = schedulerService;
  
  // Connect dependent services to scheduler
  if (services.rowMonitor) {
    schedulerService.setRowMonitorService(services.rowMonitor);
    logger.info('Row monitor service connected to scheduler');
  }
  
  if (services.appointmentSyncHandler) {
    schedulerService.setAppointmentSyncHandler(services.appointmentSyncHandler);
    logger.info('Appointment sync handler connected to scheduler');
  }
  
  // Only after all dependencies are registered, initialize the scheduler
  schedulerService.initialize();
  logger.info('Scheduler service initialized with all dependencies');
  
  logger.info('Services successfully initialized');
}).catch((error: unknown) => {
  // Safely handle error
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error('Failed to initialize services', { message: errorMessage });
});

// Simple health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version: '1.0.0',
    schedulerActive: !!schedulerService,
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
  if (schedulerService) {
    schedulerService.stop();
  }
  
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