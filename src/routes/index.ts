// src/routes/index.ts
import express from 'express';
import bulkImportRoute from './bulk-import-route';
import testIntakeQRoutes from './test-intakeq';
import testRoutes from './test';
import webhookRoutes from './webhooks';
import schedulingRoutes from './scheduling';
import testWebhookRoutes from './test-webhook'; // Add this import

const router = express.Router();

// Mount routes
router.use('/bulk-import', bulkImportRoute);
router.use('/test-intakeq', testIntakeQRoutes);
router.use('/test', testRoutes);
router.use('/webhooks', webhookRoutes);
router.use('/scheduling', schedulingRoutes);
router.use('/test-webhook', testWebhookRoutes); // Add this line

export default router;