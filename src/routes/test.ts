// src/routes/test.ts
import { Router } from 'express';
import GoogleSheetsService, { IGoogleSheetsService } from '../lib/google/sheets';

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

export default router;