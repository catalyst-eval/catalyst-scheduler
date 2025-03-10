// src/routes/test-intakeq.ts
import express, { Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { WebhookHandler } from '../lib/intakeq/webhook-handler';
import { AppointmentSyncHandler } from '../lib/intakeq/appointment-sync';
import { IntakeQService } from '../lib/intakeq/service';
import { GoogleSheetsService } from '../lib/google/sheets';

const router = express.Router();

// Create service instances
const sheetsService = new GoogleSheetsService();
const intakeQService = new IntakeQService(sheetsService);
const appointmentSyncHandler = new AppointmentSyncHandler(sheetsService, intakeQService);
const webhookHandler = new WebhookHandler(sheetsService, appointmentSyncHandler, intakeQService);

router.get('/fetch-intakes', async (req: Request, res: Response) => {
  try {
    const startDate = req.query.startDate || '2025-02-20';
    const endDate = req.query.endDate || '2025-02-28';
    
    console.log(`Fetching IntakeQ forms from ${startDate} to ${endDate}`);
    
    // Fetch intake forms summary
    const intakeResponse = await axios.get(
      `https://intakeq.com/api/v1/intakes/summary?startDate=${startDate}&endDate=${endDate}`,
      {
        headers: {
          'X-Auth-Key': process.env.INTAKEQ_API_KEY,
          'Accept': 'application/json'
        }
      }
    );
    
    // Extract form IDs
    const formIds = intakeResponse.data.map((intake: any) => intake.Id);
    console.log(`Found ${formIds.length} forms`);
    
    // If we have forms, get detailed data for the first one
    let sampleFormData = null;
    if (formIds.length > 0) {
      const formDetailResponse = await axios.get(
        `https://intakeq.com/api/v1/intakes/${formIds[0]}`,
        {
          headers: {
            'X-Auth-Key': process.env.INTAKEQ_API_KEY,
            'Accept': 'application/json'
          }
        }
      );
      sampleFormData = formDetailResponse.data;
    }
    
    // Return the data
    res.json({
      success: true,
      formCount: formIds.length,
      formSummaries: intakeResponse.data,
      sampleFormData: sampleFormData
    });
  } catch (error) {
    console.error('Error fetching IntakeQ forms:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/fetch-form', async (req: Request, res: Response) => {
    try {
      const formId = req.query.id as string;
      
      if (!formId) {
        return res.status(400).json({
          success: false,
          error: 'Form ID is required',
          timestamp: new Date().toISOString()
        });
      }
      
      console.log(`Fetching IntakeQ form details: ${formId}`);
      
      const formDetailResponse = await axios.get(
        `https://intakeq.com/api/v1/intakes/${formId}`,
        {
          headers: {
            'X-Auth-Key': process.env.INTAKEQ_API_KEY,
            'Accept': 'application/json'
          }
        }
      );
      
      res.json({
        success: true,
        formData: formDetailResponse.data
      });
    } catch (error) {
      console.error('Error fetching IntakeQ form details:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
});

// API diagnostic endpoint
router.get('/api-test', async (req: Request, res: Response) => {
  try {
    // Test connection
    const testConnection = await intakeQService.testConnection();
    
    // Try to fetch a small date range
    const today = new Date().toISOString().split('T')[0];
    let appointmentsResult: { success: boolean; error: string | null; data: any } = { 
      success: false, 
      error: 'Not attempted', 
      data: null 
    };
    
    if (testConnection) {
      try {
        const appointments = await intakeQService.getAppointments(today, today);
        appointmentsResult = { 
          success: true, 
          error: null, 
          data: {
            count: appointments.length,
            sample: appointments.length > 0 ? appointments[0] : null
          }
        };
      } catch (error) {
        appointmentsResult = { 
          success: false, 
          error: error instanceof Error ? error.message : 'Unknown error',
          data: null
        };
      }
    }
    
    res.json({
      timestamp: new Date().toISOString(),
      apiKey: {
        present: !!process.env.INTAKEQ_API_KEY,
        length: process.env.INTAKEQ_API_KEY?.length || 0
      },
      webhookSecret: {
        present: !!process.env.INTAKEQ_WEBHOOK_SECRET,
        length: process.env.INTAKEQ_WEBHOOK_SECRET?.length || 0
      },
      connectionTest: testConnection,
      appointmentsTest: appointmentsResult,
      environment: process.env.NODE_ENV,
      renderUrl: 'https://catalyst-scheduler.onrender.com'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// Webhook test route
router.post('/test-webhook', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    
    console.log('Received test webhook:', {
      payloadType: payload.Type || payload.EventType,
      clientId: payload.ClientId,
      hasAppointment: !!payload.Appointment
    });
    
    if (!payload || !payload.ClientId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payload format. Must include ClientId field.'
      });
    }
    
     // Generate a test signature for testing purposes
     let signatureInfo = {};
     if (process.env.INTAKEQ_WEBHOOK_SECRET) {
       const payloadStr = JSON.stringify(payload);
       const secret = process.env.INTAKEQ_WEBHOOK_SECRET;
       // Clean the secret
       const cleanSecret = secret.trim().replace(/^["']|["']$/g, '');
       
       const hmac = crypto.createHmac('sha256', cleanSecret);
       hmac.update(payloadStr);
       const signature = hmac.digest('hex');
       
       signatureInfo = {
         signature: signature.substring(0, 10) + '...',
         webhookUrl: 'https://catalyst-scheduler.onrender.com/api/webhooks/intakeq'
       };
     }
     
     // Process webhook with bypassing signature verification
     const eventType = payload.Type || payload.EventType;
     const isAppointmentEvent = eventType && (
       eventType.includes('Appointment') || eventType.includes('appointment')
     );
     
     let result;
     try {
       if (isAppointmentEvent && payload.Appointment) {
         result = await appointmentSyncHandler.processAppointmentEvent(payload);
       } else {
         result = await webhookHandler.processWebhook(payload);
       }
       
       res.json({
         success: result.success,
         data: result.details,
         error: result.error,
         signatureInfo,
         testMode: true,
         renderUrl: 'https://catalyst-scheduler.onrender.com',
         timestamp: new Date().toISOString()
       });
     } catch (error) {
       console.error('Error processing test webhook:', error);
       res.status(500).json({
         success: false,
         error: error instanceof Error ? error.message : 'Unknown error',
         signatureInfo,
         testMode: true,
         renderUrl: 'https://catalyst-scheduler.onrender.com',
         timestamp: new Date().toISOString()
       });
     }
   } catch (error) {
     console.error('Error in test webhook endpoint:', error);
     res.status(500).json({
       success: false,
       error: error instanceof Error ? error.message : 'Unknown error',
       timestamp: new Date().toISOString()
     });
   }
 });
 
 export default router;