// src/routes/test-intakeq.ts
import express, { Request, Response } from 'express';
import axios from 'axios';
import { IntakeQService } from '../lib/intakeq/service';
import GoogleSheetsService from '../lib/google/sheets';

const router = express.Router();

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
    const sheetsService = new GoogleSheetsService();
    const intakeQService = new IntakeQService(sheetsService);
    
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
      environment: process.env.NODE_ENV
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
    const signature = req.headers['x-intakeq-signature'] as string;
    
    const sheetsService = new GoogleSheetsService();
    const intakeQService = new IntakeQService(sheetsService);
    
    const isSignatureValid = await intakeQService.validateWebhookSignature(
      JSON.stringify(payload),
      signature
    );
    
    res.json({
      success: true,
      webhookReceived: {
        payload,
        signature: {
          received: !!signature,
          value: signature ? signature.substring(0, 10) + '...' : 'none',
          valid: isSignatureValid
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;