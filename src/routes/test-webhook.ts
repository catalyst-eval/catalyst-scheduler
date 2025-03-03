// src/routes/test-webhook.ts

import express, { Request, Response } from 'express';
import { WebhookHandler } from '../lib/intakeq/webhook-handler';
import { GoogleSheetsService } from '../lib/google/sheets';
import { IntakeQService } from '../lib/intakeq/service';
import axios from 'axios';

const router = express.Router();

// Initialize services
const sheetsService = new GoogleSheetsService();
const intakeQService = new IntakeQService(sheetsService);
const webhookHandler = new WebhookHandler(sheetsService, null, intakeQService);

/**
 * Test endpoint to process a form submission
 */
router.post('/process-form', async (req: Request, res: Response) => {
  try {
    const formId = req.body.formId;
    const clientId = req.body.clientId;
    
    if (!formId || !clientId) {
      return res.status(400).json({
        success: false,
        error: 'Missing formId or clientId',
        timestamp: new Date().toISOString()
      });
    }
    
    console.log(`Processing test form: ${formId} for client ${clientId}`);
    
    // Create a mock form submission payload
    const mockPayload = {
      Type: 'Form Submitted',
      ClientId: clientId,
      IntakeId: formId
    };
    
    // Process the mock webhook
    const result = await webhookHandler.processWebhook(mockPayload);
    
    res.json({
      success: true,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error processing test form webhook:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Test endpoint to fetch and display form data
 */
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
    
    console.log(`Fetching IntakeQ form data: ${formId}`);
    
    const formData = await intakeQService.getFullIntakeForm(formId);
    
    if (!formData) {
      return res.status(404).json({
        success: false,
        error: 'Form not found',
        timestamp: new Date().toISOString()
      });
    }
    
    // Extract accessibility information
    const accessibilityInfo = (webhookHandler as any).extractAccessibilityInfo(
      formData, 
      formData.ClientId?.toString() || '0'
    );
    
    res.json({
      success: true,
      formData: {
        id: formData.Id,
        clientId: formData.ClientId,
        clientName: formData.ClientName,
        formType: formData.QuestionnaireName,
        dateSubmitted: formData.DateSubmitted
      },
      extractedAccessibilityInfo: accessibilityInfo,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching form data:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Test endpoint to test office assignment for a client
 */
router.post('/test-office-assignment', async (req: Request, res: Response) => {
  try {
    // Required parameters
    const {
      clientId,
      clientName,
      clinicianId,
      startTime,
      endTime,
      sessionType
    } = req.body;
    
    if (!clientId || !clientName || !clinicianId || !startTime || !endTime || !sessionType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters',
        timestamp: new Date().toISOString()
      });
    }
    
    console.log(`Testing office assignment for client ${clientName}`);
    
    // Import dynamically to avoid circular dependencies
    const { AppointmentSyncHandler } = require('../lib/intakeq/appointment-sync');
    const appointmentSyncHandler = new AppointmentSyncHandler(sheetsService, intakeQService);
    
    // Create mock appointment data
    const mockAppointment = {
        Id: `test-${Date.now()}`,
        ClientId: parseInt(clientId),
        ClientName: clientName,
        ClientFirstName: clientName.split(' ')[0],
        ClientLastName: clientName.split(' ').slice(1).join(' '),
        ClientDateOfBirth: req.body.dateOfBirth || '',
        PractitionerId: clinicianId,
        StartDateIso: startTime,
        EndDateIso: endTime,
        SessionType: sessionType,
        Status: 'Confirmed',
        ServiceName: 'Therapy Session' // Add this line
      };
    
    // Determine office assignment
    const officeAssignment = await appointmentSyncHandler.determineOfficeAssignment(mockAppointment);
    
    res.json({
      success: true,
      mockAppointment,
      officeAssignment,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error testing office assignment:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;