// src/routes/maintenance.ts
import express, { Request, Response } from 'express';
import { GoogleSheetsService } from '../lib/google/sheets';
import { AccessibilityScanner } from '../lib/intakeq/accessibility-scanner';
import { AppointmentWindowManager } from '../lib/scheduling/appointment-window-manager';
// You need to install multer: npm install --save multer @types/multer
import multer from 'multer';
import fs from 'fs';
// Import directly from the module
import importAppointmentsFromCSV from '../scripts/manual-import-appointments';
import deduplicateAccessibilityInfo from '../scripts/deduplicate-accessibility';

// Create the router
const router = express.Router();
const sheetsService = new GoogleSheetsService();
const accessibilityScanner = new AccessibilityScanner(sheetsService);
const windowManager = new AppointmentWindowManager(sheetsService);

// Set up multer for file uploads
const upload = multer({ dest: 'uploads/' });

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
      .then((count: number) => {
        console.log(`Processed ${count} forms for accessibility information`);
      })
      .catch((error: Error) => {
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
 * Deduplicate client accessibility info
 */
router.post('/deduplicate-accessibility', async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      message: 'Accessibility deduplication started',
      timestamp: new Date().toISOString()
    });
    
    // Process in background
    deduplicateAccessibilityInfo()
      .then((result: {processed: number, duplicates: number}) => {
        console.log(`Deduplication complete: ${result.processed} clients processed, ${result.duplicates} duplicates removed`);
      })
      .catch((error: Error) => {
        console.error('Error in accessibility deduplication:', error);
      });
  } catch (error) {
    console.error('Error starting deduplication:', error);
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
    const { pastDays = 0 } = req.body;
    
    res.json({
      success: true,
      message: 'Appointment window maintenance started',
      timestamp: new Date().toISOString()
    });
    
    // Process in background
    windowManager.maintainAppointmentWindow(pastDays)
      .then((result: {removed: number, errors: number}) => {
        console.log(`Appointment window maintenance complete: removed ${result.removed}, errors ${result.errors}`);
      })
      .catch((error: Error) => {
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

/**
 * Refresh the two-week appointment window
 */
router.post('/refresh-two-week-window', async (req: Request, res: Response) => {
  try {
    const { keepPastDays = 7, keepFutureDays = 14 } = req.body;
    
    console.log(`Starting two-week window refresh: past ${keepPastDays} days, future ${keepFutureDays} days`);
    
    res.json({
      success: true,
      message: 'Two-week appointment window refresh started',
      settings: {
        keepPastDays,
        keepFutureDays
      },
      timestamp: new Date().toISOString()
    });
    
    // Process in background to allow immediate response
    windowManager.refreshTwoWeekWindow(keepPastDays, keepFutureDays)
      .then((result: {removed: number, preserved: number, errors: number}) => {
        console.log(`Two-week window refresh complete: removed ${result.removed}, preserved ${result.preserved}, errors ${result.errors}`);
      })
      .catch((error: Error) => {
        console.error('Error refreshing two-week window:', error);
      });
  } catch (error) {
    console.error('Error starting two-week window refresh:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

router.post('/deduplicate-accessibility', async (req: Request, res: Response) => {
 try {
   res.json({
     success: true,
     message: 'Accessibility deduplication started',
     timestamp: new Date().toISOString()
   });
   
   // Process in background
   deduplicateAccessibilityInfo()
     .then((result: {processed: number, duplicates: number}) => {
       console.log(`Deduplication complete: ${result.processed} clients processed, ${result.duplicates} duplicates found`);
     })
     .catch((error: Error) => {
       console.error('Error in accessibility deduplication:', error);
     });
 } catch (error) {
   console.error('Error starting deduplication:', error);
   res.status(500).json({
     success: false,
     error: error instanceof Error ? error.message : 'Unknown error',
     timestamp: new Date().toISOString()
   });
 }
});

// Add to src/routes/maintenance.ts - after other routes
/**
 * Clean up empty rows in appointments sheet
 */
router.post('/clean-empty-rows', async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      message: 'Empty row cleanup started',
      timestamp: new Date().toISOString()
    });
    
    // Process in background
    windowManager.cleanEmptyRows()
      .then((result: {removed: number, errors: number}) => {
        console.log(`Empty row cleanup complete: removed ${result.removed}, errors ${result.errors}`);
      })
      .catch((error: Error) => {
        console.error('Error cleaning empty rows:', error);
      });
  } catch (error) {
    console.error('Error starting empty row cleanup:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Import all future appointments from IntakeQ
 */
router.post('/import-all-future', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.body;
    
    res.json({
      success: true,
      message: 'Future appointment import started',
      settings: {
        startDate: startDate || 'today',
        endDate: endDate || '3 months from now'
      },
      timestamp: new Date().toISOString()
    });
    
    // Process in background
    const windowManager = new AppointmentWindowManager(sheetsService);
    windowManager.importAllFutureAppointments(startDate, endDate)
      .then((result: {success: boolean; processed: number; errors: number}) => {
        console.log(`Future appointment import complete: processed ${result.processed}, errors ${result.errors}`);
      })
      .catch((error: Error) => {
        console.error('Error importing future appointments:', error);
      });
  } catch (error) {
    console.error('Error starting future appointment import:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Refresh two-week appointment window
 */
router.post('/refresh-two-week-window', async (req: Request, res: Response) => {
  try {
    const { keepPastDays = 7, keepFutureDays = 14 } = req.body;
    
    console.log(`Starting two-week window refresh: past ${keepPastDays} days, future ${keepFutureDays} days`);
    
    res.json({
      success: true,
      message: 'Two-week appointment window refresh started',
      settings: {
        keepPastDays,
        keepFutureDays
      },
      timestamp: new Date().toISOString()
    });
    
    // Process in background to allow immediate response
    const windowManager = new AppointmentWindowManager(sheetsService);
    windowManager.refreshTwoWeekWindow(keepPastDays, keepFutureDays)
      .then((result: {removed: number; preserved: number; errors: number}) => {
        console.log(`Two-week window refresh complete: removed ${result.removed}, preserved ${result.preserved}, errors ${result.errors}`);
      })
      .catch((error: Error) => {
        console.error('Error refreshing two-week window:', error);
      });
  } catch (error) {
    console.error('Error starting two-week window refresh:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;