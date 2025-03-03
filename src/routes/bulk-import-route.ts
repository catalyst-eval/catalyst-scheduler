// src/routes/bulk-import-route.ts

import express, { Request, Response } from 'express';
import { enhancedBulkImport } from '../lib/scheduling/enhanced-bulk-import';
import { AppointmentRecord } from '../types/scheduling';

const router = express.Router();

/**
 * Run the enhanced bulk import with window management
 */
router.post('/run', async (req: Request, res: Response) => {
  try {
    // Extract configuration from request or use defaults
    const {
      startDate,
      endDate,
      keepPastDays = 7,
      keepFutureDays = 14,
    } = req.body;
    
    console.log('Starting bulk import with window management', {
      startDate: startDate || 'default (-7 days)',
      endDate: endDate || 'default (+14 days)',
      keepPastDays,
      keepFutureDays
    });
    
    // Send an immediate response as this can take time
    res.json({
      success: true,
      message: 'Bulk import process has started. This may take several minutes to complete.',
      timestamp: new Date().toISOString()
    });
    
    // Start the import process asynchronously
    enhancedBulkImport({
      startDate,
      endDate,
      keepPastDays,
      keepFutureDays
    })
      .then(result => {
        console.log('Bulk import completed successfully:', result);
      })
      .catch(error => {
        console.error('Error in bulk import process:', error);
      });
    
  } catch (error) {
    console.error('Error initiating bulk import:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Get status of current appointments window
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    // This is a lightweight endpoint that can be used to check
    // the current state of appointments
    
    // Get the Google Sheets service
    const { GoogleSheetsService } = require('../lib/google/sheets');
    const sheetsService = new GoogleSheetsService();
    
    // Get all appointments
    const allAppointments = await sheetsService.getAllAppointments();
    
    // Calculate date range statistics
    const dates: string[] = [];
    allAppointments.forEach((appt: AppointmentRecord) => {
      const dateStr = new Date(appt.startTime).toISOString().split('T')[0];
      dates.push(dateStr);
    });
    
    const uniqueDates = [...new Set(dates)].sort();
    
    // Count appointments by date
    const appointmentsByDate: Record<string, number> = {};
    dates.forEach((date: string) => {
      appointmentsByDate[date] = (appointmentsByDate[date] || 0) + 1;
    });
    
    // Get earliest and latest dates
    const earliestDate = uniqueDates.length > 0 ? uniqueDates[0] : null;
    const latestDate = uniqueDates.length > 0 ? uniqueDates[uniqueDates.length - 1] : null;
    
    // Calculate window size in days
    let windowSize = 0;
    if (earliestDate && latestDate) {
      const earliest = new Date(earliestDate);
      const latest = new Date(latestDate);
      windowSize = Math.floor((latest.getTime() - earliest.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    }
    
    res.json({
      success: true,
      data: {
        totalAppointments: allAppointments.length,
        uniqueDates: uniqueDates.length,
        earliestDate,
        latestDate,
        windowSize,
        appointmentsByDate
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error getting appointment status:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;