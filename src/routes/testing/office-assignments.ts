import { Router } from 'express';
import { DailyScheduleService } from '../../lib/scheduling/daily-schedule-service';

const router = Router();

/**
 * Test an individual appointment's office assignment
 * @route GET /api/testing/office-assignment/:appointmentId
 */
router.get('/office-assignment/:appointmentId', async (req, res) => {
  try {
    const { appointmentId } = req.params;
    
    if (!appointmentId) {
      return res.status(400).json({
        success: false,
        error: 'Appointment ID is required'
      });
    }
    
    console.log(`Starting test of office assignment for appointment ${appointmentId}`);
    
    // Get the necessary services
    const dailyScheduleService = new DailyScheduleService(req.app.locals.sheetsService);
    
    // Run the test
    const result = await dailyScheduleService.testSingleAppointmentAssignment(appointmentId);
    
    return res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error('Error testing appointment assignment:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;