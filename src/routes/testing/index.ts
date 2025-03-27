// src/routes/testing/index.ts

import express, { Request, Response } from 'express';
import { GoogleSheetsService } from '../../lib/google/sheets';
import { IntakeQService } from '../../lib/intakeq/service';
import { AppointmentSyncHandler } from '../../lib/intakeq/appointment-sync';
import { WebhookHandler } from '../../lib/intakeq/webhook-handler';
import { BulkImportService } from '../../lib/scheduling/bulk-import-service';
import { DailyScheduleService } from '../../lib/scheduling/daily-schedule-service';
import { SchedulerService } from '../../lib/scheduling/scheduler-service';
import { verifyAppointmentDeletion } from '../../lib/util/row-monitor';
import { getTodayEST } from '../../lib/util/date-helpers';
import { logger } from '../../lib/util/logger';
import crypto from 'crypto';
import axios from 'axios';

const router = express.Router();

/**
 * Safely handle errors for logging and response
 */
function handleError(error: unknown): { message: string, details?: any } {
  if (error instanceof Error) {
    return {
      message: error.message,
      details: error.stack
    };
  } else if (typeof error === 'string') {
    return {
      message: error
    };
  } else if (error && typeof error === 'object') {
    return {
      message: String(error),
      details: error
    };
  } else {
    return {
      message: 'Unknown error'
    };
  }
}

// Initialize core services
const sheetsService = new GoogleSheetsService();
const intakeQService = new IntakeQService(sheetsService);
const appointmentSyncHandler = new AppointmentSyncHandler(sheetsService, intakeQService);
const webhookHandler = new WebhookHandler(sheetsService, appointmentSyncHandler, intakeQService);
const bulkImportService = new BulkImportService(sheetsService, intakeQService, appointmentSyncHandler);

/**
 * Test endpoint for IntakeQ API connection
 * GET /api/testing/intakeq/connection
 */
router.get('/intakeq/connection', async (req: Request, res: Response) => {
  try {
    logger.info('Testing IntakeQ API connection');
    
    // Test connection
    const connected = await intakeQService.testConnection();
    
    // Attempt to fetch practitioners as a secondary test
    let practitionersResult = false;
    try {
      const practitioners = await intakeQService.fetchFromIntakeQ('practitioners');
      practitionersResult = Array.isArray(practitioners) && practitioners.length > 0;
    } catch (error) {
      const errorInfo = handleError(error);
      logger.error('Error fetching practitioners:', errorInfo);
    }
    
    res.json({
      success: connected,
      status: connected ? 'connected' : 'failed',
      practitionersTest: practitionersResult,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      whitelistedIPs: process.env.INTAKEQ_API_IPS ? process.env.INTAKEQ_API_IPS.split(',').length : 0
    });
  } catch (error) {
    const errorInfo = handleError(error);
    logger.error('IntakeQ connection test failed:', errorInfo);
    res.status(500).json({
      success: false,
      status: 'failed',
      error: errorInfo.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Test endpoint to fetch and display IntakeQ forms
 * GET /api/testing/intakeq/forms
 */
router.get('/intakeq/forms', async (req: Request, res: Response) => {
  try {
    const startDate = req.query.startDate as string || '2025-02-20';
    const endDate = req.query.endDate as string || '2025-02-28';
    
    logger.info(`Fetching IntakeQ forms from ${startDate} to ${endDate}`);
    
    // Fetch intake forms summary
    const forms = await intakeQService.fetchFromIntakeQ(
      `intakes/summary?startDate=${startDate}&endDate=${endDate}`
    );
    
    // If we have forms, get detailed data for the first one
    let sampleFormData = null;
    if (forms && forms.length > 0) {
      sampleFormData = await intakeQService.getFullIntakeForm(forms[0].Id);
    }
    
    // Return the data
    res.json({
      success: true,
      formCount: forms ? forms.length : 0,
      formSummaries: forms || [],
      sampleFormData: sampleFormData
    });
  } catch (error) {
    const errorInfo = handleError(error);
    logger.error('Error fetching IntakeQ forms:', errorInfo);
    res.status(500).json({
      success: false,
      error: errorInfo.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Test endpoint to fetch a specific form
 * GET /api/testing/intakeq/form/:id
 */
router.get('/intakeq/form/:id', async (req: Request, res: Response) => {
  try {
    const formId = req.params.id;
    
    if (!formId) {
      return res.status(400).json({
        success: false,
        error: 'Form ID is required',
        timestamp: new Date().toISOString()
      });
    }
    
    logger.info(`Fetching IntakeQ form details: ${formId}`);
    
    const formData = await intakeQService.getFullIntakeForm(formId);
    
    if (!formData) {
      return res.status(404).json({
        success: false,
        error: 'Form not found',
        timestamp: new Date().toISOString()
      });
    }
    
    // Process accessibility information
    const accessibilityInfo = webhookHandler.extractAccessibilityInfo(
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
    const errorInfo = handleError(error);
    logger.error('Error fetching form data:', errorInfo);
    res.status(500).json({
      success: false,
      error: errorInfo.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Test IntakeQ webhook handling
 * POST /api/testing/intakeq/webhook
 */
router.post('/intakeq/webhook', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    logger.info('Received test webhook:', {
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
        webhookUrl: req.protocol + '://' + req.get('host') + '/api/webhooks/intakeq'
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
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      const errorInfo = handleError(error);
      logger.error('Error processing test webhook:', errorInfo);
      res.status(500).json({
        success: false,
        error: errorInfo.message,
        signatureInfo,
        testMode: true,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    const errorInfo = handleError(error);
    logger.error('Error in test webhook endpoint:', errorInfo);
    res.status(500).json({
      success: false,
      error: errorInfo.message,
      timestamp: new Date().toISOString()
    });
  }
}); 

/**
 * Test endpoint to simulate a webhook request
 * POST /api/testing/intakeq/simulate-webhook
 */
router.post('/intakeq/simulate-webhook', async (req: Request, res: Response) => {
  try {
    const targetUrl = req.body.webhookUrl || process.env.WEBHOOK_URL || 'http://localhost:3000/api/webhooks/intakeq';
    const webhookSecret = req.body.webhookSecret || process.env.INTAKEQ_WEBHOOK_SECRET || 'test-secret';
    
    // Create a payload based on type
    const eventType = req.body.eventType || 'AppointmentCreated';
    let payload;
    
    if (eventType.includes('Appointment')) {
      payload = createTestAppointmentPayload(eventType);
    } else if (eventType.includes('Form')) {
      payload = createTestFormPayload();
    } else {
      payload = {
        EventType: eventType,
        ClientId: 12345,
        Timestamp: new Date().toISOString()
      };
    }
    
    // Override with custom fields if provided
    if (req.body.clientId) payload.ClientId = req.body.clientId;
    if (req.body.appointmentId && payload.Appointment) payload.Appointment.Id = req.body.appointmentId;
    
    // Generate signature
    const payloadStr = JSON.stringify(payload);
    const signature = generateSignature(payloadStr, webhookSecret);
    
    logger.info(`Sending test webhook to: ${targetUrl}`);
    logger.info('Payload:', { type: eventType, clientId: payload.ClientId });
    
    // Send the webhook
    const response = await axios.post(targetUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-IntakeQ-Signature': signature
      }
    });
    
    res.json({
      success: true,
      webhookResponse: {
        status: response.status,
        data: response.data
      },
      sentPayload: {
        type: eventType,
        clientId: payload.ClientId,
        signature: signature.substring(0, 10) + '...',
        url: targetUrl
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const errorInfo = handleError(error);
    logger.error('Error simulating webhook:', errorInfo);
    
    // Extract response error if available
    let responseError = 'Unknown error';
    let responseStatus = 500;
    
    if (axios.isAxiosError(error) && error.response) {
      responseStatus = error.response.status;
      responseError = error.response.data || error.message;
    } else if (error instanceof Error) {
      responseError = error.message;
    }
    
    res.status(500).json({
      success: false,
      error: responseError,
      status: responseStatus,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Test endpoint for office assignment
 * POST /api/testing/office-assignment
 */
router.post('/office-assignment', async (req: Request, res: Response) => {
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
    
    logger.info(`Testing office assignment for client ${clientName}`);
    
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
      ServiceName: sessionType,
      Status: 'Confirmed',
      SessionType: sessionType
    };
    
    // Determine office assignment
    // Note: This requires DailyScheduleService, which wasn't provided in the codebase
    // We'll simulate a basic test here
    
    // 1. Get client accessibility info
    const accessibilityInfo = await sheetsService.getClientAccessibilityInfo(clientId.toString());
    
    // 2. Get clinician preferences
    const clinicians = await sheetsService.getClinicians();
    const clinician = clinicians.find(c => c.clinicianId === clinicianId || c.intakeQPractitionerId === clinicianId);
    
    // 3. Get offices
    const offices = await sheetsService.getOffices();
    
    // 4. Get assignment rules
    const rules = await sheetsService.getAssignmentRules();
    
    // 5. Simulate office selection based on basic criteria
    let assignedOffice = 'TBD';
    let assignmentReason = 'Test assignment';
    
    // Check for client required office in accessibility info
    if (accessibilityInfo?.requiredOffice) {
      assignedOffice = accessibilityInfo.requiredOffice;
      assignmentReason = 'Client required office';
    }
    // Check for mobility needs
    else if (accessibilityInfo?.hasMobilityNeeds) {
      // Find accessible office
      const accessibleOffice = offices.find(o => o.isAccessible);
      if (accessibleOffice) {
        assignedOffice = accessibleOffice.officeId;
        assignmentReason = 'Accessibility requirement';
      }
    }
    // Use clinician preferred office
    else if (clinician?.preferredOffices && clinician.preferredOffices.length > 0) {
      assignedOffice = clinician.preferredOffices[0];
      assignmentReason = 'Clinician preferred office';
    }
    
    res.json({
      success: true,
      mockAppointment,
      officeAssignment: {
        officeId: assignedOffice,
        reason: assignmentReason,
        clientAccessibility: !!accessibilityInfo,
        clinicianPreferences: clinician?.preferredOffices || [],
        rules: rules.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const errorInfo = handleError(error);
    logger.error('Error testing office assignment:', errorInfo);
    res.status(500).json({
      success: false,
      error: errorInfo.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Test endpoint for bulk import
 * POST /api/testing/bulk-import
 */
router.post('/bulk-import', async (req: Request, res: Response) => {
  try {
    // Extract configuration from request
    const {
      startDate,
      endDate,
      keepPastDays = 7,
      keepFutureDays = 14,
      cleanupAfterImport = true,
      dryRun = false
    } = req.body;
    
    logger.info('Testing bulk import with configuration:', {
      startDate,
      endDate,
      keepPastDays,
      keepFutureDays,
      cleanupAfterImport,
      dryRun
    });
    
    if (dryRun) {
      // Just return the configuration that would be used
      return res.json({
        success: true,
        message: 'Dry run - import would use these parameters',
        configuration: {
          startDate: startDate || `today-${keepPastDays}`,
          endDate: endDate || `today+${keepFutureDays}`,
          keepPastDays,
          keepFutureDays,
          cleanupAfterImport
        },
        timestamp: new Date().toISOString()
      });
    }
    
    // Send an immediate response as this can take time
    res.json({
      success: true,
      message: 'Bulk import process has started. This may take several minutes to complete.',
      timestamp: new Date().toISOString()
    });
    
    // Start the import process asynchronously
    bulkImportService.runBulkImport({
      startDate,
      endDate,
      keepPastDays,
      keepFutureDays,
      cleanupAfterImport,
      source: 'test_api'
    })
      .then(result => {
        logger.info('Bulk import completed successfully:', result);
      })
      .catch(error => {
        const errorInfo = handleError(error);
        logger.error('Error in bulk import process:', errorInfo);
      });
  } catch (error) {
    const errorInfo = handleError(error);
    logger.error('Error initiating bulk import test:', errorInfo);
    
    res.status(500).json({
      success: false,
      error: errorInfo.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Test endpoint for generating a daily schedule
 * GET /api/testing/daily-schedule/:date
 */
router.get('/daily-schedule/:date?', async (req: Request, res: Response) => {
  try {
    const date = req.params.date || getTodayEST();
    logger.info(`Testing daily schedule generation for ${date}`);

    // Create a daily schedule service instance
    const dailyScheduleService = new DailyScheduleService(sheetsService);
    
    // Generate the schedule
    const scheduleData = await dailyScheduleService.generateDailySchedule(date);
    
    // Format response to avoid circular reference issues
    const response = {
      success: true,
      date: scheduleData.date,
      displayDate: scheduleData.displayDate,
      appointmentCount: scheduleData.appointments.length,
      conflictCount: scheduleData.conflicts.length,
      stats: scheduleData.stats,
      // Provide a preview of appointments with limited fields
      appointmentsPreview: scheduleData.appointments.slice(0, 5).map(appt => ({
        appointmentId: appt.appointmentId,
        clientName: appt.clientName,
        clinicianName: appt.clinicianName,
        officeId: appt.officeId,
        formattedTime: appt.formattedTime,
        sessionType: appt.sessionType
      })),
      // Include sample conflicts
      conflictsPreview: scheduleData.conflicts.slice(0, 5)
    };
    
    res.json(response);
  } catch (error) {
    const errorInfo = handleError(error);
    logger.error('Error testing daily schedule:', errorInfo);
    res.status(500).json({
      success: false,
      error: errorInfo.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Test scheduler tasks
 * POST /api/testing/scheduler/:taskType
 */
router.post('/scheduler/:taskType', async (req: Request, res: Response) => {
  try {
    const { taskType } = req.params;
    
    if (!taskType) {
      return res.status(400).json({
        success: false,
        error: 'Task type parameter is required'
      });
    }
    
    logger.info(`Testing scheduler task: ${taskType}`);
    
    const schedulerService = new SchedulerService();
    
    // This is a test, so we need to initialize the service first
    if (taskType === 'initialize') {
      schedulerService.initialize();
      
      res.json({
        success: true,
        message: 'Scheduler service initialized',
        tasks: schedulerService.getTasksStatus(),
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    // For other task types, run the specific task
    let result: any;
    
    switch (taskType) {
      case 'daily-report':
        result = await schedulerService.generateAndSendDailyReport(req.body.date);
        break;
      case 'process-unassigned':
        result = await schedulerService.processUnassignedAppointments();
        break;
      case 'clean-duplicates':
        await schedulerService.cleanupDuplicateAppointments();
        result = 'Duplicate cleanup process started';
        break;
      case 'refresh-window':
        result = await schedulerService.refreshTwoWeekWindow(
          req.body.keepPastDays || 7,
          req.body.keepFutureDays || 14
        );
        break;
      default:
        return res.status(400).json({
          success: false,
          error: `Unknown task type: ${taskType}`
        });
    }
    
    res.json({
      success: true,
      taskType,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const errorInfo = handleError(error);
    logger.error(`Error running scheduler task ${req.params.taskType}:`, errorInfo);
    res.status(500).json({
      success: false,
      error: errorInfo.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Helper function to generate HMAC signature for webhook payload
function generateSignature(payload: string, secret: string): string {
  // Clean the webhook secret (remove quotes, trim)
  const cleanSecret = secret.replace(/^["']|["']$/g, '').trim();
  
  // Create HMAC
  const hmac = crypto.createHmac('sha256', cleanSecret);
  hmac.update(payload);
  return hmac.digest('hex');
}

// Helper function to create a test appointment payload
function createTestAppointmentPayload(eventType: string): any {
  const now = new Date();
  const startTime = new Date(now);
  startTime.setHours(startTime.getHours() + 1);
  startTime.setMinutes(0, 0, 0);
  
  const endTime = new Date(startTime);
  endTime.setMinutes(endTime.getMinutes() + 50);
  
  return {
    EventType: eventType,
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

// Helper function to create a test form submission payload
function createTestFormPayload(): any {
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

export default router;