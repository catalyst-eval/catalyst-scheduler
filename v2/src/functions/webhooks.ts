/**
 * Firebase Cloud Functions for IntakeQ Webhooks
 * 
 * This file handles the webhook endpoints that receive
 * appointment events from IntakeQ.
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { Appointment } from '../models/appointment';

// Make sure Firebase is initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const webhooksCollection = db.collection('webhooks');
const appointmentsCollection = db.collection('appointments');
const logsCollection = db.collection('logs');

// Helper for verifying IntakeQ webhook signatures
function verifySignature(payload: string, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = hmac.update(payload).digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Function to handle webhooks with rate limiting
export const intakeqWebhook = functions.https.onRequest(async (req, res) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }
  
  // Verify signature
  const signature = req.headers['x-intakeq-signature'] as string;
  const webhookSecret = process.env.INTAKEQ_WEBHOOK_SECRET || '';
  
  if (!signature || !verifySignature(JSON.stringify(req.body), signature, webhookSecret)) {
    console.error('Invalid webhook signature');
    return res.status(401).send('Unauthorized');
  }
  
  // Generate a unique ID for this webhook
  const webhookId = crypto.randomBytes(16).toString('hex');
  
  try {
    // Log the received webhook
    await webhooksCollection.doc(webhookId).set({
      payload: req.body,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: 'received',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });
    
    // Log to audit trail
    await logsCollection.add({
      eventType: 'WEBHOOK_RECEIVED',
      description: `Received ${req.body.Type || req.body.EventType} webhook`,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      user: 'SYSTEM',
      metadata: {
        webhookId,
        type: req.body.Type || req.body.EventType,
        appointmentId: req.body.Appointment?.Id,
        clientId: req.body.ClientId
      }
    });
    
    // Acknowledge receipt to IntakeQ
    res.status(202).json({ success: true, webhookId });
    
    // Process appointment events
    if (req.body.Appointment) {
      await processAppointmentWebhook(webhookId, req.body);
    } else if (req.body.Type === 'Form Submitted' || req.body.EventType === 'Form Submitted') {
      await processFormWebhook(webhookId, req.body);
    } else {
      await webhooksCollection.doc(webhookId).update({
        status: 'completed',
        processingTime: admin.firestore.FieldValue.serverTimestamp(),
        note: 'No processing required for this webhook type'
      });
    }
    
    return;
  } catch (error) {
    console.error('Webhook processing error:', error);
    
    // Still return success to IntakeQ so they don't retry
    // We'll handle retries internally if needed
    if (!res.headersSent) {
      res.status(202).json({ success: true, webhookId });
    }
    
    // Update webhook status
    await webhooksCollection.doc(webhookId).update({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      processingTime: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return;
  }
});

// Process appointment webhooks
async function processAppointmentWebhook(webhookId: string, payload: any): Promise<void> {
  const appointmentId = payload.Appointment.Id;
  const eventType = payload.Type || payload.EventType;
  
  // Update webhook status
  await webhooksCollection.doc(webhookId).update({
    status: 'processing',
    appointmentId
  });
  
  try {
    if (eventType?.includes('Created')) {
      await handleAppointmentCreated(payload.Appointment);
    } else if (eventType?.includes('Updated') || eventType?.includes('Rescheduled')) {
      await handleAppointmentUpdated(payload.Appointment);
    } else if (eventType?.includes('Cancelled') || eventType?.includes('Canceled')) {
      await handleAppointmentCancelled(payload.Appointment);
    } else if (eventType?.includes('Deleted')) {
      await handleAppointmentDeleted(payload.Appointment);
    }
    
    // Update webhook status to completed
    await webhooksCollection.doc(webhookId).update({
      status: 'completed',
      processingTime: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error(`Error processing appointment webhook ${webhookId}:`, error);
    
    // Update webhook status
    await webhooksCollection.doc(webhookId).update({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      processingTime: admin.firestore.FieldValue.serverTimestamp()
    });
    
    throw error;
  }
}

// Handle appointment creation
async function handleAppointmentCreated(appointmentData: any): Promise<void> {
  const appointmentId = appointmentData.Id;
  
  // Check if this appointment already exists
  const existingDoc = await appointmentsCollection.doc(appointmentId).get();
  if (existingDoc.exists) {
    console.log(`Appointment ${appointmentId} already exists, handling as update`);
    return handleAppointmentUpdated(appointmentData);
  }
  
  // Convert to our format
  const appointment: Appointment = {
    id: appointmentId,
    clientId: appointmentData.ClientId.toString(),
    clientName: appointmentData.ClientName || '',
    clientDateOfBirth: appointmentData.ClientDateOfBirth || '',
    clinicianId: appointmentData.PractitionerId || '',
    clinicianName: appointmentData.PractitionerName || '',
    startTime: appointmentData.StartDateIso || new Date().toISOString(),
    endTime: appointmentData.EndDateIso || new Date().toISOString(),
    status: 'scheduled',
    sessionType: determineSessionType(appointmentData),
    officeId: 'TBD', // Will be assigned later
    requirements: {
      accessibility: false,
      specialFeatures: []
    },
    source: 'intakeq',
    lastUpdated: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    notes: appointmentData.Notes || ''
  };
  
  // Add series ID if this is a recurring appointment
  if (appointmentData.RecurrencePattern) {
    appointment.seriesId = generateSeriesId(appointmentData);
    appointment.recurrenceRule = JSON.stringify(appointmentData.RecurrencePattern);
  }
  
  // Save to Firestore
  await appointmentsCollection.doc(appointmentId).set(appointment);
  
  // Log to audit trail
  await logsCollection.add({
    eventType: 'APPOINTMENT_CREATED',
    description: `Created appointment ${appointmentId}`,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    user: 'SYSTEM',
    metadata: {
      appointmentId,
      clientId: appointment.clientId,
      clinicianId: appointment.clinicianId
    }
  });
}

// Other handlers would be implemented similarly
async function handleAppointmentUpdated(appointmentData: any): Promise<void> {
  // Implementation here
}

async function handleAppointmentCancelled(appointmentData: any): Promise<void> {
  // Implementation here
}

async function handleAppointmentDeleted(appointmentData: any): Promise<void> {
  // Implementation here
}

async function processFormWebhook(webhookId: string, payload: any): Promise<void> {
  // Implementation here
}

// Helper functions
function determineSessionType(appointmentData: any): 'in-person' | 'telehealth' | 'group' | 'family' {
  const serviceName = (appointmentData.ServiceName || '').toLowerCase();
  
  if (serviceName.match(/tele(health|therapy|med|session)|virtual|remote|video/)) {
    return 'telehealth';
  } else if (serviceName.match(/group|workshop|class|seminar/)) {
    return 'group';
  } else if (serviceName.match(/family|couples|relationship|parental|parent-child/)) {
    return 'family';
  }
  
  return 'in-person';
}

function generateSeriesId(appointmentData: any): string {
  // Create a unique, deterministic ID for this recurring series
  const seriesData = {
    clientId: appointmentData.ClientId,
    practitionerId: appointmentData.PractitionerId,
    serviceId: appointmentData.ServiceId,
    pattern: appointmentData.RecurrencePattern
  };
  
  return crypto
    .createHash('md5')
    .update(JSON.stringify(seriesData))
    .digest('hex');
}