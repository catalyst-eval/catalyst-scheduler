// src/google-auth-test.ts
import dotenv from 'dotenv';
import path from 'path';

// Log the current directory
console.log('Current directory:', process.cwd());

// Load environment variables with explicit path
const result = dotenv.config({ 
  path: path.resolve(process.cwd(), '.env') 
});

// Log the dotenv result
console.log('Dotenv result:', result);

// Check for environment variables
console.log('GOOGLE_SHEETS_PRIVATE_KEY exists:', !!process.env.GOOGLE_SHEETS_PRIVATE_KEY);
console.log('GOOGLE_SHEETS_CLIENT_EMAIL exists:', !!process.env.GOOGLE_SHEETS_CLIENT_EMAIL);
console.log('GOOGLE_SHEETS_PRIVATE_KEY first 10 chars:', 
  process.env.GOOGLE_SHEETS_PRIVATE_KEY ? 
  process.env.GOOGLE_SHEETS_PRIVATE_KEY.substring(0, 10) : 'not found');