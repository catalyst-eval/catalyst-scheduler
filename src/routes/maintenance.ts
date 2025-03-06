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
 * Import appointments from CSV
 */
router.post('/import-appointments-csv', upload.single('file'), async (req: Request, res: Response) => {
  try {
    // TypeScript doesn't recognize multer's additions to req
    const file = (req as any).file;
    
    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No CSV file uploaded',
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      message: 'CSV import started',
      timestamp: new Date().toISOString()
    });
    
    // Process in background
    importAppointmentsFromCSV(file.path)
      .then((result: {imported: number, errors: number}) => {
        console.log(`Import complete: ${result.imported} appointments imported, ${result.errors} errors`);
        
        // Clean up the temporary file
        fs.unlink(file.path, (err: NodeJS.ErrnoException | null) => {
          if (err) console.error('Error removing temp file:', err);
        });
      })
      .catch((error: Error) => {
        console.error('Error importing CSV:', error);
      });
  } catch (error) {
    console.error('Error starting CSV import:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;