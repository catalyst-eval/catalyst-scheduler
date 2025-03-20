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

// Create application services
const sheetsService = new GoogleSheetsService();

// Initialize scheduler service
const schedulerService = new SchedulerService();

// Basic JSON parser for all routes
app.use(express.json());
app.use('/api/scheduling', schedulingRoutes);
app.use('/api/testing', testingRoutes);

// Initialize enhanced services
initializeServices(sheetsService)
  .then((services: EnhancedServices) => {
    // Make services available application-wide
    app.locals.sheetsService = sheetsService;
    app.locals.errorRecovery = services.errorRecovery;
    app.locals.rowMonitor = services.rowMonitor;
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
      rowMonitor: !!app.locals.rowMonitor
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
  
  // Initialize scheduler after server starts
  schedulerService.initialize();
  logger.info('Scheduler service initialized');
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