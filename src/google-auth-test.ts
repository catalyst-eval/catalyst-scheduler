// src/google-auth-test.ts
import dotenv from 'dotenv';
import { JWT } from 'google-auth-library';

dotenv.config();

async function testAuth() {
  try {
    console.log('Testing Google Auth...');
    console.log('Private key exists:', !!process.env.GOOGLE_SHEETS_PRIVATE_KEY);
    console.log('Client email exists:', !!process.env.GOOGLE_SHEETS_CLIENT_EMAIL);
    
    // Handle different formats of private key
    let privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY || '';
    
    // Replace literal \n with actual newlines
    privateKey = privateKey.replace(/\\n/g, '\n');
    
    // If key is enclosed in quotes, remove them
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
      privateKey = privateKey.slice(1, -1);
    }
    
    console.log('Private key length:', privateKey.length);
    console.log('Private key starts with:', privateKey.substring(0, 20) + '...');
    
    // Create a client with the credentials
    const client = new JWT({
      email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    
    // Attempt to get an access token
    console.log('Attempting to get access token...');
    const token = await client.getAccessToken();
    console.log('Successfully obtained access token:', !!token);
    
    return true;
  } catch (error) {
    console.error('Authentication error:', error);
    return false;
  }
}

testAuth().then(success => {
  console.log('Authentication test completed, success:', success);
  process.exit(success ? 0 : 1);
});