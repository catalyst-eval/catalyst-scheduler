// src/routes/maintenance/diagnostics.ts

import { Router } from 'express';
import { DailyScheduleService } from '../../lib/scheduling/daily-schedule-service';

const router = Router();
const dailyScheduleService = new DailyScheduleService();

// Route to test office assignment rules
router.get('/test-office-assignments', async (req, res) => {
  try {
    const startDate = req.query.startDate as string || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = req.query.endDate as string || new Date().toISOString().split('T')[0];
    
    console.log(`Running office assignment test from ${startDate} to ${endDate}`);
    
    const results = await dailyScheduleService.testOfficeAssignmentRules(startDate, endDate);
    
    res.json({
      success: true,
      startDate,
      endDate,
      results
    });
  } catch (error) {
    console.error('Error in test endpoint:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;