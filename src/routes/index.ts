// src/routes/index.ts
import express from 'express';
import webhookRoutes from './webhooks';
import schedulingRoutes from './scheduling';
import maintenanceRoutes from './maintenance';  // Add this import

const router = express.Router();

// Mount routes
router.use('/webhooks', webhookRoutes);
router.use('/scheduling', schedulingRoutes);
router.use('/maintenance', maintenanceRoutes);  // Add this line

export default router;