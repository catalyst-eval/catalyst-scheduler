// src/routes/index.ts
import express from 'express';
import testIntakeQRoutes from './test-intakeq';
import testRoutes from './test';
import webhookRoutes from './webhooks';
import schedulingRoutes from './scheduling';

const router = express.Router();

// Mount routes
router.use('/test-intakeq', testIntakeQRoutes);
router.use('/test', testRoutes);
router.use('/webhooks', webhookRoutes);
router.use('/scheduling', schedulingRoutes);

export default router;