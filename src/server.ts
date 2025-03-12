// src/server.ts
import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import apiRoutes from './routes/index';
import { validateIntakeQWebhook } from './middleware/verify-signature';
import { SchedulerService } from './lib/scheduling/scheduler-service';
import schedulingRoutes from './routes/scheduling';

// Load environment variables
dotenv.config();

// Log environment variable status for debugging
console.log('ENV check on startup:');
console.log('- GOOGLE_SHEETS_PRIVATE_KEY exists:', !!process.env.GOOGLE_SHEETS_PRIVATE_KEY);
console.log('- GOOGLE_SHEETS_CLIENT_EMAIL exists:', !!process.env.GOOGLE_SHEETS_CLIENT_EMAIL);
console.log('- SENDGRID_API_KEY exists:', !!process.env.SENDGRID_API_KEY);

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize scheduler service
const schedulerService = new SchedulerService();

// Basic JSON parser for all routes
app.use(express.json());
app.use('/api/scheduling', schedulingRoutes);

// Simple health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version: '1.0.0',
    schedulerActive: true
  });
});

// Mount API routes
app.use('/api', apiRoutes);

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  console.log(`Webhook endpoint available at http://localhost:${PORT}/api/webhooks/intakeq`);
  
  // Initialize scheduler after server starts
  schedulerService.initialize();
  console.log('Scheduler service initialized');
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  
  // Stop scheduler
  schedulerService.stop();
  
  // Close server
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  
  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
});

// Export for testing
export default app;