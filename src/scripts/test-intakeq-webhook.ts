// src/scripts/test-intakeq-webhook.ts
/**
 * This script tests the IntakeQ webhook integration
 * It can be run directly with: npx ts-node src/scripts/test-intakeq-webhook.ts
 */

import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { IntakeQService } from '../lib/intakeq/service';
import { GoogleSheetsService } from '../lib/google/sheets';

// Load environment variables
dotenv.config();

// Configuration - can be overridden with environment variables
const WEBHOOK_URL = process.env.TEST_WEBHOOK_URL || 'http://localhost:3000/api/webhooks/intakeq';
const INTAKEQ_WEBHOOK_SECRET = process.env.INTAKEQ_WEBHOOK_SECRET || 'test-secret';
const TEST_MODE = process.env.TEST_MODE || 'local'; // 'local' or 'remote'

// Test modes
const TEST_APPOINTMENT_CREATED = process.env.TEST_APPOINTMENT_CREATED !== 'false';
const TEST_FORM_SUBMITTED = process.env.TEST_FORM_SUBMITTED !== 'false';
const TEST_SIGNATURE_VALIDATION = process.env.TEST_SIGNATURE_VALIDATION !== 'false';

/**
 * Generate HMAC signature for webhook payload
 */
function generateSignature(payload: any): string {
  // Clean the webhook secret (remove quotes, trim)
  const cleanSecret = INTAKEQ_WEBHOOK_SECRET.replace(/^["']|["']$/g, '').trim();
  
  // Create HMAC
  const hmac = crypto.createHmac('sha256', cleanSecret);
  
  // Ensure payload is stringified
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  
  // Update HMAC with payload and get hex digest
  hmac.update(payloadStr);
  return hmac.digest('hex');
}

/**
 * Send test webhook to endpoint
 */
async function sendTestWebhook(payload: any, includeSignature: boolean = true): Promise<any> {
  // Convert payload to JSON string
  const payloadStr = JSON.stringify(payload);
  
  // Generate signature
  const signature = generateSignature(payloadStr);
  
  console.log('Sending test webhook to:', WEBHOOK_URL);
  console.log('Payload type:', payload.Type || payload.EventType);
  
  if (includeSignature) {
    console.log('Signature included:', signature.substring(0, 10) + '...');
  } else {
    console.log('Signature excluded for testing');
  }
  
  try {
    // Prepare headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    
    if (includeSignature) {
      headers['X-IntakeQ-Signature'] = signature;
    }
    
    // Send request
    const response = await axios.post(WEBHOOK_URL, payload, { headers });
    
    console.log('Response status:', response.status);
    console.log('Response data:', response.data);
    
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      console.error('Error response:', {
        status: error.response.status,
        data: error.response.data
      });
    } else {
      console.error('Error sending webhook:', error);
    }
    throw error;
  }
}

/**
 * Create test appointment created payload
 */
function createAppointmentCreatedPayload(): any {
  const now = new Date();
  const startTime = new Date(now);
  startTime.setHours(startTime.getHours() + 1);
  startTime.setMinutes(0, 0, 0);
  
  const endTime = new Date(startTime);
  endTime.setMinutes(endTime.getMinutes() + 50);
  
  return {
    EventType: 'AppointmentCreated',
    ClientId: 12345,
    Appointment: {
      Id: `test-${Date.now()}`,
      ClientName: 'Test Client',
      ClientFirstName: 'Test',
      ClientLastName: 'Client',
      ClientEmail: 'test@example.com',
      ClientPhone: '555-123-4567',
      ClientDateOfBirth: '1990-01-01',
      ClientId: 12345,
      Status: 'Confirmed',
      StartDate: startTime.getTime(),
      EndDate: endTime.getTime(),
      Duration: 50,
      ServiceName: 'Therapy Session',
      ServiceId: '1',
      LocationName: 'Main Office',
      LocationId: 'A-1',
      Price: 150,
      PractitionerName: 'Dr. Therapist',
      PractitionerEmail: 'therapist@example.com',
      PractitionerId: '1', // Should match intakeQPractitionerId in Clinicians_Configuration
      IntakeId: null,
      DateCreated: now.getTime(),
      CreatedBy: 'Test Script',
      BookedByClient: false,
      StartDateIso: startTime.toISOString(),
      EndDateIso: endTime.toISOString(),
      StartDateLocal: startTime.toLocaleString(),
      EndDateLocal: endTime.toLocaleString(),
      StartDateLocalFormatted: startTime.toLocaleString()
    }
  };
}

/**
 * Create test form submitted payload
 */
function createFormSubmittedPayload(): any {
  return {
    EventType: 'Form Submitted',
    ClientId: 12345,
    ClientName: 'Test Client',
    ClientEmail: 'test@example.com',
    formId: `test-form-${Date.now()}`,
    responses: {
      'Do you use any mobility devices?': ['Wheelchair'],
      'Access needs related to mobility/disability (Please specify)': 'Need ground floor access',
      'Do you experience sensory sensitivities?': ['Light sensitivity', 'Auditory sensitivity'],
      'Other (Please specify):': 'Prefer quiet spaces',
      'Do you experience challenges with physical environment?': ['Difficulty with stairs'],
      'Please indicate your comfort level with this possibility:': '2 - High preference for consistency',
      'Do you have support needs that involve any of the following?': ['Space for a service animal'],
      'Is there anything else we should know about your space or accessibility needs?': 'Additional test notes'
    }
  };
}

/**
 * Test IntakeQ connection
 */
async function testIntakeQConnection(): Promise<boolean> {
  try {
    console.log('Testing IntakeQ API connection...');
    
    const sheetsService = new GoogleSheetsService();
    const intakeQService = new IntakeQService(sheetsService);
    
    const connected = await intakeQService.testConnection();
    
    console.log('IntakeQ API connection test result:', connected ? 'SUCCESS' : 'FAILED');
    return connected;
  } catch (error) {
    console.error('Error testing IntakeQ connection:', error);
    return false;
  }
}

/**
 * Test Google Sheets connection
 */
async function testGoogleSheetsConnection(): Promise<boolean> {
  try {
    console.log('Testing Google Sheets connection...');
    
    const sheetsService = new GoogleSheetsService();
    const offices = await sheetsService.getOffices();
    
    console.log('Google Sheets connection test result: SUCCESS');
    console.log(`Found ${offices.length} offices in sheet`);
    
    // Log some office IDs to verify sheet structure
    if (offices.length > 0) {
      console.log('Sample office IDs:', offices.slice(0, 3).map(o => o.officeId));
    }
    
    return true;
  } catch (error) {
    console.error('Error testing Google Sheets connection:', error);
    return false;
  }
}

/**
 * Test webhook endpoint health
 */
async function testWebhookHealth(): Promise<boolean> {
  try {
    console.log('Testing webhook health endpoint...');
    
    const healthUrl = WEBHOOK_URL.replace(/\/intakeq$/, '/health');
    const response = await axios.get(healthUrl);
    
    console.log('Webhook health test result:', 
      response.data.status === 'healthy' ? 'SUCCESS' : 'WARNING');
    
    console.log('Health check response:', response.data);
    
    return response.data.status === 'healthy';
  } catch (error) {
    console.error('Error testing webhook health:', error);
    return false;
  }
}

/**
 * Run a sequence of tests
 */
async function runTests() {
  console.log('IntakeQ Webhook Integration Test');
  console.log('===============================');
  console.log('Test mode:', TEST_MODE);
  console.log('Webhook URL:', WEBHOOK_URL);
  console.log('');
  
  // Test connections first
  let connectionsFailed = false;
  
  if (TEST_MODE === 'remote') {
    // Test webhook health endpoint
    if (!await testWebhookHealth()) {
      console.warn('⚠️ Webhook health check failed, tests may not work correctly');
      connectionsFailed = true;
    }
  } else {
    // Test direct connections to services
    if (!await testIntakeQConnection()) {
      console.warn('⚠️ IntakeQ connection test failed, tests may not work correctly');
      connectionsFailed = true;
    }
    
    if (!await testGoogleSheetsConnection()) {
      console.warn('⚠️ Google Sheets connection test failed, tests may not work correctly');
      connectionsFailed = true;
    }
  }
  
  // Proceed with tests even if connections failed (unless user aborts)
  if (connectionsFailed) {
    console.log('');
    console.log('⚠️ Some connection tests failed. Press Ctrl+C to abort or wait 5 seconds to continue...');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  console.log('');
  console.log('Starting webhook tests...');
  
  // Test 1: Appointment Created webhook
  if (TEST_APPOINTMENT_CREATED) {
    console.log('');
    console.log('Test 1: Appointment Created Webhook');
    console.log('----------------------------------');
    
    try {
      const payload = createAppointmentCreatedPayload();
      await sendTestWebhook(payload);
      console.log('✅ Appointment Created test completed');
    } catch (error) {
      console.error('❌ Appointment Created test failed:', error);
    }
  }
  
  // Test 2: Form Submitted webhook
  if (TEST_FORM_SUBMITTED) {
    console.log('');
    console.log('Test 2: Form Submitted Webhook');
    console.log('-----------------------------');
    
    try {
      const payload = createFormSubmittedPayload();
      await sendTestWebhook(payload);
      console.log('✅ Form Submitted test completed');
    } catch (error) {
      console.error('❌ Form Submitted test failed:', error);
    }
  }
  
  // Test 3: Signature Validation
  if (TEST_SIGNATURE_VALIDATION) {
    console.log('');
    console.log('Test 3: Signature Validation');
    console.log('--------------------------');
    
    try {
      const payload = createAppointmentCreatedPayload();
      
      // Send without signature - should be rejected
      console.log('Testing without signature (should be rejected):');
      try {
        await sendTestWebhook(payload, false);
        console.error('❌ Signature validation test failed - accepted request without signature');
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          console.log('✅ Correctly rejected request without valid signature');
        } else {
          throw error;
        }
      }
      
      // Send with invalid signature - corrupt the payload after signature is generated
      console.log('');
      console.log('Testing with invalid signature (should be rejected):');
      try {
        const payloadStr = JSON.stringify(payload);
        const signature = generateSignature(payloadStr);
        
        // Modify payload slightly to invalidate signature
        payload.Appointment.ClientName = 'Modified Client Name';
        
        const headers = {
          'Content-Type': 'application/json',
          'X-IntakeQ-Signature': signature
        };
        
        await axios.post(WEBHOOK_URL, payload, { headers });
        console.error('❌ Signature validation test failed - accepted request with invalid signature');
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          console.log('✅ Correctly rejected request with invalid signature');
        } else {
          throw error;
        }
      }
      
      console.log('✅ Signature validation tests completed');
    } catch (error) {
      console.error('❌ Signature validation test error:', error);
    }
  }
  
  console.log('');
  console.log('All tests completed!');
}

// Run tests if executed directly
if (require.main === module) {
  runTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
  });
}

export { sendTestWebhook, createAppointmentCreatedPayload, createFormSubmittedPayload, generateSignature };