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

export default router;