// src/routes/maintenance.ts

import express, { Request, Response } from 'express';
import { GoogleSheetsService } from '../lib/google/sheets';
import { AccessibilityScanner } from '../lib/intakeq/accessibility-scanner';
import { AppointmentWindowManager } from '../lib/scheduling/appointment-window-manager';

const router = express.Router();
const sheetsService = new GoogleSheetsService();
const accessibilityScanner = new AccessibilityScanner(sheetsService);
const windowManager = new AppointmentWindowManager(sheetsService);

/**
 * Scan intake forms for accessibility information
 */
router.post('/scan-accessibility-forms', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.body;
    
    res.json({
      success: true,
      message: 'Accessibility form scan started',
      timestamp: new Date().toISOString()
    });
    
    // Process in background
    accessibilityScanner.scanIntakeFormsForAccessibility(startDate, endDate)
      .then(count => {
        console.log(`Processed ${count} forms for accessibility information`);
      })
      .catch(error => {
        console.error('Error scanning forms:', error);
      });
  } catch (error) {
    console.error('Error starting form scan:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Maintain appointment window
 */
router.post('/maintain-appointment-window', async (req: Request, res: Response) => {
  try {
    const { pastDays = 0, futureDays = 14 } = req.body;
    
    res.json({
      success: true,
      message: 'Appointment window maintenance started',
      timestamp: new Date().toISOString()
    });
    
    // Process in background
    windowManager.maintainAppointmentWindow(pastDays, futureDays)
      .then(result => {
        console.log(`Appointment window maintenance complete: removed ${result.removed}, added ${result.added}, errors ${result.errors}`);
      })
      .catch(error => {
        console.error('Error maintaining appointment window:', error);
      });
  } catch (error) {
    console.error('Error starting window maintenance:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;