// debug-env.ts
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

// Check if .env file exists
const envPath = path.resolve('.env');
console.log('.env file exists:', fs.existsSync(envPath));

// Log all environment variables (only existence, not values)
console.log('\nEnvironment Variables:');
const relevantVars = [
  'GOOGLE_SHEETS_PRIVATE_KEY',
  'GOOGLE_SHEETS_CLIENT_EMAIL',
  'GOOGLE_SHEETS_SPREADSHEET_ID',
  'INTAKEQ_API_KEY',
  'INTAKEQ_WEBHOOK_SECRET',
  'SENDGRID_API_KEY',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_FROM_NAME'
];

relevantVars.forEach(varName => {
  console.log(`- ${varName}: ${process.env[varName] ? 'Set' : 'NOT SET'}`);
});

// Check the format of the private key
if (process.env.GOOGLE_SHEETS_PRIVATE_KEY) {
  const privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  console.log('\nPrivate key analysis:');
  console.log('- Length:', privateKey.length);
  console.log('- Contains BEGIN marker:', privateKey.includes('BEGIN PRIVATE KEY'));
  console.log('- Contains END marker:', privateKey.includes('END PRIVATE KEY'));
  console.log('- Contains escaped newlines (\\n):', privateKey.includes('\\n'));
  console.log('- First 20 chars:', privateKey.substring(0, 20) + '...');
}