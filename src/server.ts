// src/server.ts
import dotenv from 'dotenv';
import path from 'path';

// Load .env file - explicitly set the path
dotenv.config({
  path: path.resolve(process.cwd(), '.env')
});

// Log to verify variables are loaded
console.log('ENV check on startup:');
console.log('- GOOGLE_SHEETS_PRIVATE_KEY exists:', !!process.env.GOOGLE_SHEETS_PRIVATE_KEY);
console.log('- GOOGLE_SHEETS_CLIENT_EMAIL exists:', !!process.env.GOOGLE_SHEETS_CLIENT_EMAIL);

// Import the rest of the modules
import express, { Request, Response } from 'express';
import apiRoutes from './routes/index';
import { validateIntakeQWebhook } from './middleware/verify-signature';

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Basic JSON parser for all routes
app.use(express.json());

// Simple health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version: '1.0.0'
  });
});

// Mount API routes
app.use('/api', apiRoutes);

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  console.log(`Webhook endpoint available at http://localhost:${PORT}/api/webhooks/intakeq`);
});

// Export for testing
export default app;