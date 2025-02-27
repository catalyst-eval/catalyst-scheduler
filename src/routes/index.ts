// src/routes/index.ts
import express from 'express';
import testRoutes from './test';
import webhookRoutes from './webhooks';

const router = express.Router();

// Mount routes
router.use('/test', testRoutes);
router.use('/webhooks', webhookRoutes);

export default router;