// src/routes/index.ts
import express from 'express';
import testIntakeQRoutes from './test-intakeq';
import webhookRoutes from './webhooks';
import schedulingRoutes from './scheduling';
import testWebhookRoutes from './test-webhook'; // Add this import
import maintenanceRoutes from './maintenance';  // Add this import

const router = express.Router();

// Mount routes
router.use('/test-intakeq', testIntakeQRoutes);
router.use('/webhooks', webhookRoutes);
router.use('/scheduling', schedulingRoutes);
router.use('/test-webhook', testWebhookRoutes); // Add this line
router.use('/maintenance', maintenanceRoutes);  // Add this line

export default router;