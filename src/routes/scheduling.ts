// src/routes/scheduling.ts
import { Router, Request, Response } from 'express';
import { SchedulerService } from '../lib/scheduling/scheduler-service';
import { DailyScheduleService } from '../lib/scheduling/daily-schedule-service';
import { GoogleSheetsService } from '../lib/google/sheets';
import { IntakeQService } from '../lib/intakeq/service'; // Added this import
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
    const dailyScheduleService = new DailyScheduleService();
    
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

/**
 * Resolve scheduling conflicts for a specific date
 * 
 * GET /api/scheduling/resolve-conflicts/:date?
 * Optional date parameter in YYYY-MM-DD format
 */
router.get('/resolve-conflicts/:date?', async (req: Request, res: Response) => {
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
    const dailyScheduleService = new DailyScheduleService();
    
    // Resolve scheduling conflicts
    console.log(`API request to resolve scheduling conflicts for ${targetDate}`);
    const resolvedCount = await dailyScheduleService.resolveSchedulingConflicts(targetDate);
    
    res.json({
      success: true,
      date: targetDate,
      conflictsResolved: resolvedCount
    });
  } catch (error: unknown) {
    console.error('Error resolving scheduling conflicts:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * System health check endpoint
 * 
 * GET /api/scheduling/health
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    // Basic system health check
    const sheetsService = new GoogleSheetsService();
    
    // Check if we can read basic configuration
    const offices = await sheetsService.getOffices();
    const clinicians = await sheetsService.getClinicians();
    
    res.json({
      success: true,
      status: 'healthy',
      officeCount: offices.length,
      clinicianCount: clinicians.length,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Test IntakeQ API connection with whitelisted IPs
 * 
 * GET /api/scheduling/test-intakeq-connection
 */
router.get('/test-intakeq-connection', async (req: Request, res: Response) => {
  try {
    const sheetsService = new GoogleSheetsService();
    const intakeQService = new IntakeQService(sheetsService);
    
    // Test IntakeQ API connection
    console.log('Testing IntakeQ API connection');
    const connectionResult = await intakeQService.testConnection();
    
    // Attempt to fetch practitioners as a second test
    let practitionersResult = false;
    try {
      const practitioners = await intakeQService.fetchFromIntakeQ('practitioners');
      practitionersResult = Array.isArray(practitioners) && practitioners.length > 0;
    } catch (error) {
      console.error('Error fetching practitioners:', error);
    }
    
    res.json({
      success: connectionResult,
      status: connectionResult ? 'connected' : 'failed',
      practitionersTest: practitionersResult,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      whitelistedIPs: process.env.INTAKEQ_API_IPS ? process.env.INTAKEQ_API_IPS.split(',').length : 0
    });
  } catch (error) {
    console.error('IntakeQ connection test failed:', error);
    res.status(500).json({
      success: false,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// Export the router
export default router;