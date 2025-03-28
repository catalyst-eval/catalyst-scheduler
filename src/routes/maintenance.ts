// src/routes/maintenance.ts

import express, { Request, Response } from 'express';
import { GoogleSheetsService } from '../lib/google/sheets';
import { SchedulerService } from '../lib/scheduling/scheduler-service';
import { getTodayEST } from '../lib/util/date-helpers';

const router = express.Router();
const sheetsService = new GoogleSheetsService();
const schedulerService = new SchedulerService();

// Initialize scheduler service
schedulerService.initialize();

/**
 * Health check endpoint
 * GET /api/maintenance/health
 */
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

/**
 * Get system status
 * GET /api/maintenance/status
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    // Get recent audit logs
    const recentLogs = await sheetsService.getRecentAuditLogs(10);
    
    // Get scheduled tasks status
    const tasks = schedulerService.getTasksStatus();
    
    res.json({
      status: 'operational',
      timestamp: new Date().toISOString(),
      scheduler: {
        tasks: tasks
      },
      recentActivity: recentLogs,
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    console.error('Error getting system status:', error);
    res.status(500).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Clean up duplicate appointments
 * POST /api/maintenance/clean-duplicates
 */
router.post('/clean-duplicates', async (req: Request, res: Response) => {
  try {
    await schedulerService.cleanupDuplicateAppointments();
    
    res.json({
      success: true,
      message: 'Duplicate appointment cleanup process started',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error cleaning up duplicates:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Run daily office assignment
 * POST /api/maintenance/assign-offices
 */
router.post('/assign-offices', async (req: Request, res: Response) => {
  try {
    const targetDate = req.body.date || getTodayEST();
    
    // Process unassigned appointments
    await schedulerService.processUnassignedAppointments();
    
    res.json({
      success: true,
      message: `Office assignment task initiated for ${targetDate}`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error running office assignment:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Generate and send daily report
 * POST /api/maintenance/send-daily-report
 */
router.post('/send-daily-report', async (req: Request, res: Response) => {
  try {
    const targetDate = req.body.date || getTodayEST();
    
    // Send response immediately as this operation can take time
    res.json({
      success: true,
      message: `Daily report generation initiated for ${targetDate}`,
      timestamp: new Date().toISOString()
    });
    
    // Generate and send report in background
    schedulerService.generateAndSendDailyReport(targetDate)
      .then((result: boolean) => {
        console.log(`Daily report generation completed with result: ${result}`);
      })
      .catch((error: Error) => {
        console.error('Error generating daily report:', error);
      });
    
  } catch (error) {
    console.error('Error initiating daily report:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// Export router
export default router;