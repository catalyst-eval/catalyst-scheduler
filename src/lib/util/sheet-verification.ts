// src/lib/util/sheet-verification.ts

import { google } from 'googleapis';
import { JWT } from 'google-auth-library';

// Expected sheet names and their expected positions
const EXPECTED_SHEETS = {
  'Offices_Configuration': 0,
  'Clinicians_Configuration': 1,
  'Assignment_Rules': 2,
  'Client_Accessibility_Info': 3,
  'Schedule_Configuration': 4,
  'Integration_Settings': 5,
  'Appointments': 6,
  'Audit_Log': 7
};

/**
 * Verifies that all required sheets exist with the correct IDs
 * @returns Object with verification results
 */
export async function verifySheetStructure(): Promise<{
  verified: boolean;
  issues: string[];
  sheetInfo: Array<{
    title: string;
    sheetId: number;
    index: number;
    expected: boolean;
    positionCorrect: boolean;
  }>;
}> {
  const issues: string[] = [];
  const sheetInfo: Array<{
    title: string;
    sheetId: number;
    index: number;
    expected: boolean;
    positionCorrect: boolean;
  }> = [];

  try {
    // Initialize the Google Sheets client
    if (!process.env.GOOGLE_SHEETS_PRIVATE_KEY || !process.env.GOOGLE_SHEETS_CLIENT_EMAIL) {
      throw new Error('Missing required Google Sheets credentials');
    }
    
    // Handle different formats of private key
    let privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
    
    // Replace literal \n with actual newlines if needed
    if (privateKey.includes('\\n')) {
      privateKey = privateKey.replace(/\\n/g, '\n');
    }
    
    // If key is enclosed in quotes, remove them
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
      privateKey = privateKey.slice(1, -1);
    }
    
    const client = new JWT({
      email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth: client });
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '';

    // Get spreadsheet information
    const response = await sheets.spreadsheets.get({
      spreadsheetId: spreadsheetId
    });

    // Verify each sheet
    const foundSheets = response.data.sheets || [];
    
    // Check for missing sheets
    const foundSheetTitles = foundSheets.map(sheet => sheet.properties?.title || '');
    const expectedSheetTitles = Object.keys(EXPECTED_SHEETS);
    
    for (const expectedTitle of expectedSheetTitles) {
      if (!foundSheetTitles.includes(expectedTitle)) {
        issues.push(`Missing required sheet: ${expectedTitle}`);
      }
    }

    // Check each found sheet
    foundSheets.forEach((sheet, index) => {
      const title = sheet.properties?.title || '';
      const sheetId = sheet.properties?.sheetId || 0;
      
      const expected = expectedSheetTitles.includes(title);
      const expectedIndex = expected ? EXPECTED_SHEETS[title as keyof typeof EXPECTED_SHEETS] : -1;
      const positionCorrect = expectedIndex === index;
      
      sheetInfo.push({
        title,
        sheetId,
        index,
        expected,
        positionCorrect
      });
      
      if (expected && !positionCorrect) {
        issues.push(`Sheet "${title}" is at position ${index} but should be at position ${expectedIndex}`);
      }
    });

    return {
      verified: issues.length === 0,
      issues,
      sheetInfo
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    issues.push(`Failed to verify sheet structure: ${errorMessage}`);
    return {
      verified: false,
      issues,
      sheetInfo
    };
  }
}

/**
 * Runs sheet verification and logs any issues detected
 */
export async function runSheetVerification(): Promise<void> {
  console.log('Running sheet structure verification...');
  
  try {
    const result = await verifySheetStructure();
    
    if (result.verified) {
      console.log('✅ Sheet structure verification passed');
    } else {
      console.error('❌ Sheet structure verification failed:');
      result.issues.forEach(issue => {
        console.error(`  - ${issue}`);
      });
    }
    
    console.log('Sheet information:');
    result.sheetInfo.forEach(sheet => {
      console.log(`${sheet.expected ? '✓' : '✗'} "${sheet.title}" (ID: ${sheet.sheetId}) at position ${sheet.index}`);
    });
  } catch (error) {
    console.error('Failed to run sheet verification:', error);
  }
}