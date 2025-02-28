// src/routes/scheduling.ts
import { Router, Request, Response } from 'express';
import { DailyScheduleService } from '../lib/scheduling/daily-schedule-service';
import { SchedulerService } from '../lib/scheduling/scheduler-service';
import { GoogleSheetsService } from '../lib/google/sheets';

const router = Router();
const schedulerService = new SchedulerService();
const dailyScheduleService = new DailyScheduleService();
const sheetsService = new GoogleSheetsService();

/**
 * Get daily schedule data (doesn't send email)
 */
router.get('/daily-schedule', async (req: Request, res: Response) => {
  try {
    const date = req.query.date as string || new Date().toISOString().split('T')[0];
    
    console.log(`API request for daily schedule: ${date}`);
    const scheduleData = await dailyScheduleService.generateDailySchedule(date);
    
    res.json({
      success: true,
      data: scheduleData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error generating daily schedule:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Trigger daily schedule email
 */
router.post('/send-daily-schedule', async (req: Request, res: Response) => {
  try {
    const date = req.body.date as string || new Date().toISOString().split('T')[0];
    
    console.log(`API request to send daily schedule email: ${date}`);
    
    // Track processing for async response
    res.json({
      success: true,
      message: `Processing daily schedule email for ${date}`,
      timestamp: new Date().toISOString()
    });
    
    // Process in background
    schedulerService.generateAndSendDailyReport(date)
      .then(success => {
        console.log(`Daily schedule email for ${date} ${success ? 'sent' : 'failed'}`);
      })
      .catch(error => {
        console.error(`Error sending daily schedule email: ${error.message}`);
      });
  } catch (error) {
    console.error('Error triggering daily schedule email:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Trigger IntakeQ refresh for a single day
 */
router.post('/refresh-intakeq', async (req: Request, res: Response) => {
  try {
    const date = req.body.date as string || new Date().toISOString().split('T')[0];
    
    console.log(`API request to refresh IntakeQ appointments: ${date}`);
    
    // Track processing for async response
    res.json({
      success: true,
      message: `Processing IntakeQ appointment refresh for ${date}`,
      timestamp: new Date().toISOString()
    });
    
    // Process in background
    schedulerService.refreshAppointmentsFromIntakeQ(date)
      .then(success => {
        console.log(`IntakeQ refresh for ${date} ${success ? 'completed' : 'failed'}`);
      })
      .catch(error => {
        console.error(`Error refreshing IntakeQ appointments: ${error.message}`);
      });
  } catch (error) {
    console.error('Error triggering IntakeQ refresh:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Trigger bulk import of appointments from IntakeQ
 */
router.post('/bulk-import', async (req: Request, res: Response) => {
  try {
    const startDate = req.body.startDate as string || new Date().toISOString().split('T')[0];
    const endDate = req.body.endDate as string; // Optional
    
    console.log(`API request for bulk import from ${startDate} to ${endDate || 'future'}`);
    
    // Respond immediately as this is a long-running process
    res.json({
      success: true,
      message: `Started bulk import from ${startDate} to ${endDate || 'future (6 months)'}`,
      details: {
        startDate,
        endDate: endDate || 'auto-calculated (6 months from now)',
        status: 'processing'
      },
      timestamp: new Date().toISOString()
    });
    
    // Process in background
    schedulerService.bulkImportAppointments(startDate, endDate)
      .then(result => {
        console.log('Bulk import completed:', result);
      })
      .catch(error => {
        console.error('Error in bulk import process:', error);
      });
  } catch (error) {
    console.error('Error starting bulk import:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Check bulk import status
 */
router.get('/bulk-import/status', async (req: Request, res: Response) => {
  try {
    // Get recent logs related to bulk import
    const logs = await sheetsService.getRecentAuditLogs(50);
    
    // Filter for bulk import related logs
    const bulkImportLogs = logs.filter(log => 
      log.description.includes('bulk import')
    );
    
    // Get most recent bulk import operation
    const latestStartLog = bulkImportLogs.find(log => 
      log.description.includes('Starting bulk import')
    );
    
    const latestCompleteLog = bulkImportLogs.find(log => 
      log.description.includes('Completed bulk import')
    );
    
    // Determine if a bulk import is in progress
    const inProgress = latestStartLog && (!latestCompleteLog || 
      new Date(latestStartLog.timestamp) > new Date(latestCompleteLog.timestamp));
    
    // Parse details if available
    let details = null;
    if (latestCompleteLog?.systemNotes) {
      try {
        details = JSON.parse(latestCompleteLog.systemNotes);
      } catch (e) {
        console.error('Error parsing system notes:', e);
      }
    }
    
    res.json({
      success: true,
      data: {
        inProgress,
        latestImport: {
          started: latestStartLog ? {
            timestamp: latestStartLog.timestamp,
            details: latestStartLog.systemNotes ? JSON.parse(latestStartLog.systemNotes) : null
          } : null,
          completed: latestCompleteLog ? {
            timestamp: latestCompleteLog.timestamp,
            details
          } : null
        },
        recentLogs: bulkImportLogs.slice(0, 10)
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error retrieving bulk import status:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Get recent audit logs
 */
router.get('/logs', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    
    const logs = await sheetsService.getRecentAuditLogs(limit);
    
    res.json({
      success: true,
      data: logs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error retrieving audit logs:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;