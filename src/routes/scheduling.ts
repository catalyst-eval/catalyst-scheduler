// src/routes/scheduling.ts
import { Router, Request, Response } from 'express';
import { SchedulerService } from '../lib/scheduling/scheduler-service';
import { getTodayEST, isValidISODate } from '../lib/util/date-helpers';

const router = Router();

/**
 * Generate and send daily schedule on demand
 * 
 * GET /api/scheduling/generate-daily-schedule/:date?
 * Optional date parameter in YYYY-MM-DD format
 */
router.get('/generate-daily-schedule/:date?', async (req: Request, res: Response) => {
  try {
    // Extract and validate date parameter
    let targetDate = req.params.date;
    if (targetDate && !isValidISODate(targetDate)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format. Please use YYYY-MM-DD format.'
      });
    }
    
    // Use today if no date provided
    targetDate = targetDate || getTodayEST();
    
    // Create scheduler service
    const schedulerService = new SchedulerService();
    
    // Generate and send schedule
    console.log(`API request to generate daily schedule for ${targetDate}`);
    const result = await schedulerService.generateDailyScheduleOnDemand(targetDate);
    
    res.json({
      success: true,
      date: targetDate,
      result
    });
  } catch (error: unknown) {
    console.error('Error generating daily schedule:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Refresh appointments from IntakeQ for a specific date
 * 
 * GET /api/scheduling/refresh-appointments/:date?
 * Optional date parameter in YYYY-MM-DD format
 */
router.get('/refresh-appointments/:date?', async (req: Request, res: Response) => {
  try {
    // Extract and validate date parameter
    let targetDate = req.params.date;
    if (targetDate && !isValidISODate(targetDate)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format. Please use YYYY-MM-DD format.'
      });
    }
    
    // Use today if no date provided
    targetDate = targetDate || getTodayEST();
    
    // Create scheduler service
    const schedulerService = new SchedulerService();
    
    // Refresh appointments
    console.log(`API request to refresh appointments for ${targetDate}`);
    const count = await schedulerService.refreshAppointmentsFromIntakeQ(targetDate);
    
    res.json({
      success: true,
      date: targetDate,
      appointmentsRefreshed: count
    });
  } catch (error: unknown) {
    console.error('Error refreshing appointments:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Process unassigned appointments
 * 
 * GET /api/scheduling/process-unassigned
 */
router.get('/process-unassigned', async (req: Request, res: Response) => {
  try {
    // Create scheduler service
    const schedulerService = new SchedulerService();
    
    // Process unassigned appointments
    console.log('API request to process unassigned appointments');
    const count = await schedulerService.processUnassignedAppointments();
    
    res.json({
      success: true,
      appointmentsProcessed: count
    });
  } catch (error: unknown) {
    console.error('Error processing unassigned appointments:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Generate daily report without sending email
 * 
 * GET /api/scheduling/preview-daily-schedule/:date?
 * Optional date parameter in YYYY-MM-DD format
 */
router.get('/preview-daily-schedule/:date?', async (req: Request, res: Response) => {
  try {
    // Extract and validate date parameter
    let targetDate = req.params.date;
    if (targetDate && !isValidISODate(targetDate)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format. Please use YYYY-MM-DD format.'
      });
    }
    
    // Use today if no date provided
    targetDate = targetDate || getTodayEST();
    
    // Create services
    const schedulerService = new SchedulerService();
    const dailyScheduleService = schedulerService['dailyScheduleService'];
    
    // Generate the daily schedule (without sending email)
    const scheduleData = await dailyScheduleService.generateDailySchedule(targetDate);
    
    res.json({
      success: true,
      date: targetDate,
      displayDate: scheduleData.displayDate,
      data: scheduleData
    });
  } catch (error: unknown) {
    console.error('Error generating daily schedule preview:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Export the router
export default router;