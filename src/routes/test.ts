// src/routes/test.ts
import { Router, Request, Response } from 'express';
import GoogleSheetsService, { IGoogleSheetsService } from '../lib/google/sheets';
import { DailyScheduleService } from '../lib/scheduling/daily-schedule-service';
import { getTodayEST, getESTDayRange } from '../lib/util/date-helpers';

const router = Router();

// Cast to the interface to ensure TypeScript recognizes the methods
const sheetsService: IGoogleSheetsService = new GoogleSheetsService();

router.get('/test-sheets', async (req, res) => {
  try {
    // Now TypeScript knows this method exists
    const data = await sheetsService.getOffices();
    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Test sheets error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.get('/test-sheets-meta', async (req, res) => {
  try {
    // Access the private sheets instance directly for this test
    const sheetsService: any = new GoogleSheetsService();
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const response = await sheetsService.sheets.spreadsheets.get({
      spreadsheetId
    });
    
    res.json({
      success: true,
      sheets: response.data.sheets.map((sheet: any) => sheet.properties.title)
    });
  } catch (error) {
    console.error('Test sheets error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.get('/sheet-metadata', async (req, res) => {
  try {
    // Access the sheets API directly to get all sheet names
    const sheetsService = new GoogleSheetsService();
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    
    // Cast to any to access private property for diagnostics
    const sheetsClient = (sheetsService as any).sheets;
    
    const response = await sheetsClient.spreadsheets.get({
      spreadsheetId
    });
    
    // Extract sheet names
    const sheetNames = response.data.sheets.map((sheet: { properties: { title: string } }) => sheet.properties.title);
    
    res.json({
      success: true,
      sheets: sheetNames
    });
  } catch (error) {
    console.error('Failed to get sheet metadata:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Test endpoint for webhook-only appointment processing
 * This demonstrates fetching appointments without IntakeQ API calls
 */
router.get('/webhook-only-appointments', async (req: Request, res: Response) => {
  try {
    // Get the target date from query param or use today
    const targetDate = req.query.date as string || getTodayEST();
    
    console.log(`Testing webhook-only appointment fetching for ${targetDate}`);
    
    // Calculate date range for the day
    const { start, end } = getESTDayRange(targetDate);
    
    // Initialize the services
    const sheetsService = new GoogleSheetsService();
    const dailyScheduleService = new DailyScheduleService(sheetsService);
    
    // Log the test being performed
    await sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'TEST' as any,
      description: `Testing webhook-only appointment processing for ${targetDate}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({ targetDate, start, end })
    });
    
    // STEP 1: Get appointments directly from Google Sheets without API calls
    console.log(`Fetching appointments from Sheets for ${start} to ${end}`);
    const appointments = await sheetsService.getAppointments(start, end);
    
    // Add diagnostic information to check what we're getting from Sheets
    let diagnostics = {
      appointmentDetails: appointments.map(appt => ({
        id: appt.appointmentId,
        client: appt.clientName,
        clinician: appt.clinicianName,
        time: appt.startTime,
        officeId: appt.officeId,
        status: appt.status,
        source: appt.source,
        lastUpdated: appt.lastUpdated
      }))
    };
    
    // STEP 2: Check webhook audit logs to see what webhooks we've received
    const recentLogs = await sheetsService.getRecentAuditLogs(100);
    const webhookLogs = recentLogs.filter(log => 
      (log.eventType === 'WEBHOOK_RECEIVED' || 
       log.eventType.includes('APPOINTMENT_')) &&
      new Date(log.timestamp) > new Date(new Date().getTime() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
    );
    
    // STEP 3: Process any appointment assignments/conflicts
    let resolvedCount = 0;
    try {
      resolvedCount = await dailyScheduleService.resolveSchedulingConflicts(targetDate);
      console.log(`Resolved ${resolvedCount} scheduling conflicts using webhook data`);
    } catch (error) {
      console.warn('Error resolving conflicts:', error);
    }
    
    // STEP 4: Generate a summary of what would go in the email
    const scheduleData = await dailyScheduleService.generateDailySchedule(targetDate);
    
    // Return the results with comprehensive diagnostics
    res.json({
      success: true,
      message: 'Webhook-only appointment processing test successful',
      data: {
        date: targetDate,
        dateRange: { start, end },
        appointmentsFound: appointments.length,
        inEmailData: scheduleData.appointments.length,
        conflicts: scheduleData.conflicts.length,
        officeCounts: scheduleData.stats.officeUtilization
      },
      diagnostics: {
        appointmentDetails: diagnostics.appointmentDetails,
        recentWebhooks: webhookLogs.length,
        webhookSample: webhookLogs.slice(0, 5).map(log => ({
          timestamp: log.timestamp,
          type: log.eventType,
          description: log.description
        }))
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in webhook-only test:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Check appointment history for multiple days
 * This helps diagnose whether webhooks have been received consistently
 */
router.get('/appointment-history', async (req: Request, res: Response) => {
  try {
    // Get the number of days to check
    const daysToCheck = parseInt(req.query.days as string || '7');
    
    console.log(`Checking appointment history for the last ${daysToCheck} days`);
    
    // Initialize services
    const sheetsService = new GoogleSheetsService();
    
    // Get all appointments (which will let us check across multiple days)
    const allAppointments = await sheetsService.getAllAppointments();
    
    // Create a map to store appointments by date
    const appointmentsByDate: Record<string, any[]> = {};
    
    // Get dates to check
    const today = new Date();
    const dates = [];
    for (let i = 0; i < daysToCheck; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      dates.push(date.toISOString().split('T')[0]);
    }
    
    // Initialize results for each date
    dates.forEach(date => {
      appointmentsByDate[date] = [];
    });
    
    // Filter appointments by date
    allAppointments.forEach(appt => {
      const apptDate = new Date(appt.startTime).toISOString().split('T')[0];
      if (appointmentsByDate[apptDate]) {
        appointmentsByDate[apptDate].push({
          id: appt.appointmentId,
          client: appt.clientName,
          clinician: appt.clinicianName,
          time: appt.startTime,
          officeId: appt.officeId,
          status: appt.status,
          source: appt.source,
          lastUpdated: appt.lastUpdated
        });
      }
    });
    
    // Get webhook logs for the same period
    const recentLogs = await sheetsService.getRecentAuditLogs(200);
    const webhookLogs = recentLogs.filter(log => 
      (log.eventType === 'WEBHOOK_RECEIVED' || 
       log.eventType.includes('APPOINTMENT_'))
    );
    
    // Count webhooks by date
    const webhooksByDate: Record<string, number> = {};
    webhookLogs.forEach(log => {
      const logDate = new Date(log.timestamp).toISOString().split('T')[0];
      webhooksByDate[logDate] = (webhooksByDate[logDate] || 0) + 1;
    });
    
    // Return the results
    res.json({
      success: true,
      message: `Appointment history for the last ${daysToCheck} days`,
      data: {
        dates,
        appointmentCounts: dates.map(date => ({
          date,
          count: appointmentsByDate[date].length,
          dayOfWeek: new Date(date).toLocaleDateString('en-US', { weekday: 'long' })
        })),
        appointmentsByDate,
        webhookCounts: dates.map(date => ({
          date,
          webhooks: webhooksByDate[date] || 0
        }))
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in appointment history test:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;