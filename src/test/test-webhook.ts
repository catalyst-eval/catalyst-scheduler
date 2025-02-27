// src/test/test-webhook.ts
import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Configuration
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3001/api/webhooks/intakeq';
const WEBHOOK_SECRET = process.env.INTAKEQ_WEBHOOK_SECRET || 'test-secret';

/**
 * Generate HMAC signature for webhook payload
 */
function generateSignature(payload: any): string {
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  hmac.update(payloadStr);
  return hmac.digest('hex');
}

/**
 * Send test webhook
 */
async function sendTestWebhook(payload: any): Promise<any> {
  // Convert payload to JSON string
  const payloadStr = JSON.stringify(payload);
  
  // Generate signature
  const signature = generateSignature(payloadStr);
  
  console.log('Sending test webhook to:', WEBHOOK_URL);
  console.log('Payload:', payload);
  console.log('Signature:', signature);
  
  try {
    // Send request with signature header
    const response = await axios.post(WEBHOOK_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-IntakeQ-Signature': signature
      }
    });
    
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
 * Generate test appointment created payload
 */
function createAppointmentCreatedPayload(): any {
  const now = new Date();
  const startTime = new Date(now);
  startTime.setHours(startTime.getHours() + 1);
  startTime.setMinutes(0, 0, 0);
  
  const endTime = new Date(startTime);
  endTime.setMinutes(endTime.getMinutes() + 60);
  
  return {
    EventType: 'AppointmentCreated',
    ClientId: 12345,
    Appointment: {
      Id: `test-${Date.now()}`,
      ClientName: 'Test Client',
      ClientEmail: 'test@example.com',
      ClientPhone: '555-123-4567',
      ClientDateOfBirth: '1990-01-01',
      ClientId: 12345,
      Status: 'Confirmed',
      StartDate: startTime.getTime(),
      EndDate: endTime.getTime(),
      Duration: 60,
      ServiceName: 'Therapy Session',
      ServiceId: '1',
      LocationName: 'Main Office',
      LocationId: '1',
      Price: 150,
      PractitionerName: 'Dr. Therapist',
      PractitionerEmail: 'therapist@example.com',
      PractitionerId: '1',
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
 * Run the test
 */
async function runTest(): Promise<void> {
  try {
    // Create test payload
    const payload = createAppointmentCreatedPayload();
    
    // Send test webhook
    await sendTestWebhook(payload);
    
    console.log('Test completed successfully');
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

// Run test if executed directly
if (require.main === module) {
  runTest();
}

export { sendTestWebhook, createAppointmentCreatedPayload, generateSignature };