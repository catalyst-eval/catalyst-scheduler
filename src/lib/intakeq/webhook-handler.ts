import type {
  WebhookEventType,
  IntakeQAppointment,
  IntakeQWebhookPayload,
  WebhookResponse
} from '../../types/webhooks';

import type { IGoogleSheetsService, AuditEventType } from '../google/sheets';
import { IntakeQService } from './service';

// Interface for accessibility information extracted from forms
export interface AccessibilityInfo {
  clientId: string;
  clientName: string;
  hasMobilityNeeds: boolean;
  mobilityDetails: string;
  hasSensoryNeeds: boolean;
  sensoryDetails: string;
  hasPhysicalNeeds: boolean;
  physicalDetails: string;
  roomConsistency: number;
  hasSupport: boolean;
  supportDetails: string;
  additionalNotes: string;
  formType: 'Adult' | 'Minor' | 'Unknown';
  formId: string;
}

// Add this new interface for form questions
interface FormQuestion {
  Id: string;
  Text?: string;
  Answer?: string;
  [key: string]: any;
}

// Interface for webhook processing results (kept for backward compatibility)
export interface WebhookProcessingResult {
  success: boolean;
  error?: string;
  retryable?: boolean;
  details?: any;
}

export class WebhookHandler {
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAYS = [1000, 5000, 15000]; // Delays in milliseconds
  private readonly appointmentSyncHandler: any; // Add this property
  private readonly intakeQService: any; // Add this property

  constructor(
    private readonly sheetsService: IGoogleSheetsService,
    appointmentSyncHandler?: any,
    intakeQService?: any
  ) {
    this.appointmentSyncHandler = appointmentSyncHandler;
    this.intakeQService = intakeQService || new IntakeQService(sheetsService as any);
  }

  /**
   * Get event type from payload, handling both field names
   */
  private getEventType(payload: Partial<IntakeQWebhookPayload>): WebhookEventType | undefined {
    // Use EventType if available, fall back to Type
    return payload.EventType || payload.Type;
  }

/**
 * Process incoming webhook with validation and retries
 * Enhanced with improved error handling and recurring appointment detection
 */
async processWebhook(
  payload: unknown,
  signature?: string
): Promise<WebhookResponse> {
  // Add timestamp to measure processing time
  const startTime = Date.now();

  // Create safe copy of payload for logging
  const payloadCopy = this.createSafePayloadCopy(payload);
  console.log('Complete webhook payload structure:', JSON.stringify(payloadCopy, null, 2));  

  try {
    // Validate webhook payload
    const validationResult = this.validateWebhook(payload);
    if (!validationResult.isValid) {
      await this.logWebhookError('VALIDATION_ERROR', validationResult.error || 'Unknown validation error', payload);
      return {
        success: false,
        error: validationResult.error,
        retryable: false
      };
    }

    const typedPayload = payload as IntakeQWebhookPayload;
    const eventType = this.getEventType(typedPayload);
    
    // Generate a unique idempotency key for this webhook
    const idempotencyKey = this.generateIdempotencyKey(typedPayload);
    
    // Check if this webhook has already been processed
    const alreadyProcessed = await this.sheetsService.isWebhookProcessed(idempotencyKey);
    if (alreadyProcessed) {
      console.log(`Webhook ${idempotencyKey} already processed, skipping`);
      return {
        success: true,
        details: {
          idempotencyKey,
          status: 'already_processed',
          eventType
        }
      };
    }
    
    // Log webhook receipt
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'WEBHOOK_RECEIVED' as AuditEventType,
      description: `Received ${eventType} webhook`,
      user: 'INTAKEQ_WEBHOOK',
      systemNotes: JSON.stringify({
        type: eventType,
        clientId: typedPayload.ClientId,
        // Log tags if present in appointment
        tags: typedPayload.Appointment?.Tags || 'none',
        apiDisabled: process.env.DISABLE_API_CALLS === 'true' ? true : false,
        idempotencyKey
      })
    });

    // Check for recurring appointment pattern
    const isRecurringAppointment = this.isRecurringAppointment(typedPayload);
    
    // Record webhook as being processed
    await this.sheetsService.logWebhook(idempotencyKey, 'processing', {
      type: eventType,
      entityId: typedPayload.Appointment?.Id || typedPayload.IntakeId || '',
      isRecurring: isRecurringAppointment
    });

    // Check if API calls are disabled
    if (process.env.DISABLE_API_CALLS === 'true') {
      console.log(`API DISABLED: Acknowledging webhook but not processing: ${eventType}`);
      return {
        success: true,
        details: {
          message: 'Webhook acknowledged but not processed (API calls disabled)',
          webhookType: eventType
        }
      };
    }

    // Process the webhook based on its type and contents
    let result: WebhookResponse;
    
    if (isRecurringAppointment && this.appointmentSyncHandler) {
      console.log('Detected recurring appointment, using specialized handler');
      result = await this.appointmentSyncHandler.processRecurringAppointment(typedPayload);
    } else if (eventType === "Form Submitted" || eventType === "Intake Submitted") {
      result = await this.processIntakeFormSubmission(typedPayload);
    } else if (typedPayload.Appointment && this.appointmentSyncHandler) {
      // Process appointment event using the appointment sync handler
      result = await this.appointmentSyncHandler.processAppointmentEvent(typedPayload);
    } else {
      // Process with retry logic for other events
      result = await this.processWithRetry(typedPayload);
    }

    // Update webhook status
    await this.sheetsService.updateWebhookStatus(idempotencyKey, 
      result.success ? 'completed' : 'failed', 
      { 
        details: result.details,
        error: result.error,
        retryable: result.retryable,
        processingTime: Date.now() - startTime
      }
    );

    // Log successful webhook handling
    if (result.success) {
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'WEBHOOK_RECEIVED' as AuditEventType,
        description: `Successfully processed ${eventType} webhook`,
        user: 'INTAKEQ_WEBHOOK',
        systemNotes: JSON.stringify({
          type: eventType,
          clientId: typedPayload.ClientId,
          processingTime: Date.now() - startTime,
          details: result.details
        })
      });
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await this.logWebhookError('PROCESSING_ERROR', errorMessage, payload);
    
    return {
      success: false,
      error: errorMessage,
      retryable: this.isRetryableError(error)
    };
  }
}

/**
 * Create a safe copy of the payload for logging (without sensitive data)
 */
private createSafePayloadCopy(payload: any): any {
  try {
    const payloadCopy = JSON.parse(JSON.stringify(payload));
    if (payloadCopy.Appointment?.ClientEmail) {
      payloadCopy.Appointment.ClientEmail = '[REDACTED]';
    }
    if (payloadCopy.Appointment?.ClientPhone) {
      payloadCopy.Appointment.ClientPhone = '[REDACTED]';
    }
    return payloadCopy;
  } catch (error) {
    console.warn('Error creating safe payload copy:', error);
    return { error: 'Could not create safe copy' };
  }
}

/**
 * Generate a unique idempotency key based on payload content
 */
private generateIdempotencyKey(payload: any): string {
  // Create a unique identifier based on payload content
  const type = payload.Type || payload.EventType || 'Unknown';
  let entityId = '';
  
  if (payload.Appointment?.Id) {
    entityId = `appointment-${payload.Appointment.Id}`;
    
    // For appointment updates, include a hash of critical fields
    // to distinguish between multiple updates to the same appointment
    if (type.includes('Updated') || type.includes('Rescheduled')) {
      const fieldsHash = this.hashAppointmentFields(payload.Appointment);
      return `${type}-${entityId}-${fieldsHash}`;
    }
    
    // For creation and cancellation, just use the ID as these should be processed only once
    if (type.includes('Created') || type.includes('Cancelled') || type.includes('Canceled')) {
      const timestamp = payload.DateCreated || payload.Appointment.DateCreated || new Date().toISOString();
      return `${type}-${entityId}-${timestamp}`;
    }
  } else if (payload.IntakeId || payload.formId) {
    entityId = `form-${payload.IntakeId || payload.formId}`;
  }
  
  // Add timestamp from payload if available
  const timestamp = payload.DateCreated || payload.Appointment?.DateCreated || '';
  
  // Create a more reliable hash of the content
  // Use critical fields that would differentiate this webhook from others
  const criticalFields = {
    type,
    entityId,
    timestamp,
    clientId: payload.ClientId,
    startDate: payload.Appointment?.StartDateIso || '',
    endDate: payload.Appointment?.EndDateIso || '',
    status: payload.Appointment?.Status || ''
  };
  
  const contentString = JSON.stringify(criticalFields);
  
  const contentHash = require('crypto')
    .createHash('sha256')
    .update(contentString)
    .digest('hex')
    .substring(0, 12); // Use more characters for better uniqueness
  
  return `${type}-${entityId}-${contentHash}`;
}

/**
 * Hash critical appointment fields for more reliable idempotency
 */
private hashAppointmentFields(appointment: any): string {
  // Extract the fields that constitute a meaningful change
  const criticalFields = {
    startDate: appointment.StartDateIso || '',
    endTime: appointment.EndDateIso || '',
    status: appointment.Status || '',
    location: appointment.Location || '',
    serviceType: appointment.ServiceType || '',
    practitionerId: appointment.PractitionerId || ''
  };
  
  return require('crypto')
    .createHash('md5')
    .update(JSON.stringify(criticalFields))
    .digest('hex')
    .substring(0, 8);
}

/**
 * Check if a payload is for a recurring appointment
 */
private isRecurringAppointment(payload: IntakeQWebhookPayload): boolean {
  // Check if the appointment has a RecurrencePattern property
  if (payload.Appointment?.RecurrencePattern) {
    return true;
  }
  
  // Check for other indicators of recurring appointments
  if (payload.Appointment) {
    // Look for frequency or recurrence information in notes or tags
    const hasRecurrenceTags = 
      payload.Appointment.Tags?.includes('recurring') || 
      payload.Appointment.Tags?.includes('weekly') ||
      payload.Appointment.Tags?.includes('biweekly');
    
    const hasRecurrenceNotes =
      payload.Appointment.Notes?.includes('recurring') ||
      payload.Appointment.Notes?.includes('series') ||
      payload.Appointment.Notes?.includes('weekly') ||
      payload.Appointment.Notes?.includes('biweekly');
    
    if (hasRecurrenceTags || hasRecurrenceNotes) {
      return true;
    }
  }
  
  return false;
}

  /**
 * Process intake form submission webhooks
 */
private async processIntakeFormSubmission(
  payload: IntakeQWebhookPayload
): Promise<WebhookResponse> {
  try {
    const formId = payload.IntakeId || payload.formId;
    const clientId = payload.ClientId?.toString();
    
    if (!formId || !clientId) {
      return {
        success: false,
        error: 'Missing form ID or client ID in form submission webhook',
        retryable: false
      };
    }
    
    // Log initial receipt of form
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'WEBHOOK_RECEIVED' as AuditEventType,
      description: `Processing intake form ${formId}`,
      user: 'INTAKEQ_WEBHOOK',
      systemNotes: JSON.stringify({
        formId: formId,
        clientId: clientId,
        isFullIntake: !!payload.IntakeId
      })
    });

    // Fetch the full form data from IntakeQ API
    console.log(`Fetching full intake form data for form ID: ${formId}`);
    const formData = await this.intakeQService.getFullIntakeForm(formId);
    
    if (!formData) {
      return {
        success: false,
        error: 'Unable to fetch form data from IntakeQ',
        retryable: true
      };
    }
    
    // Extract accessibility information from the form
    const accessibilityInfo = this.extractAccessibilityInfo(formData, clientId);
    
    // Store the accessibility info in the Google Sheet
    await this.sheetsService.updateClientAccessibilityInfo(accessibilityInfo);
    
    // Log successful processing
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'CLIENT_PREFERENCES_UPDATED' as AuditEventType,
      description: `Updated accessibility info for client ${clientId} from form ${formId}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        clientId: clientId,
        formId: formId,
        hasMobilityNeeds: accessibilityInfo.hasMobilityNeeds,
        hasSensoryNeeds: accessibilityInfo.hasSensoryNeeds,
        hasPhysicalNeeds: accessibilityInfo.hasPhysicalNeeds,
        roomConsistency: accessibilityInfo.roomConsistency
      })
    });

    // Return success response
    return {
      success: true,
      details: {
        formId: formId,
        clientId: clientId,
        formType: accessibilityInfo.formType,
        accessibilityInfoExtracted: true
      }
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await this.logWebhookError('FORM_PROCESSING_ERROR', errorMessage, payload);
    
    return {
      success: false,
      error: "Unexpected execution path",
      retryable: false
    };
  }
}

/**
 * Extract accessibility information from form data
 */
// Enhanced form data extraction
extractAccessibilityInfo(formData: any, clientId: string): AccessibilityInfo {
  console.log('Extracting accessibility information from form:', {
    formId: formData.Id,
    formName: formData.QuestionnaireName,
    questionCount: formData.Questions?.length || 0
  });
  
  // Print all question IDs and text for debugging
  if (formData.Questions) {
    console.log('Form questions:', formData.Questions.map((q: any) => ({
      id: q.Id,
      text: q.Text?.substring(0, 30) + (q.Text?.length > 30 ? '...' : ''),
      hasAnswer: !!q.Answer
    })));
  }
  
  // Determine the form type
  const formType = this.determineFormType(formData);
  console.log(`Form type determined: ${formType}`);
  
  // Initialize with default values
  const accessibilityInfo: AccessibilityInfo = {
    clientId,
    clientName: formData.ClientName || '',
    hasMobilityNeeds: false,
    mobilityDetails: '',
    hasSensoryNeeds: false,
    sensoryDetails: '',
    hasPhysicalNeeds: false,
    physicalDetails: '',
    roomConsistency: 3, // Default to neutral
    hasSupport: false,
    supportDetails: '',
    additionalNotes: '',
    formType: formType as 'Adult' | 'Minor' | 'Unknown',
    formId: formData.Id || ''
  };
  
  // Get all questions from the form - add type annotation here
  const questions = formData.Questions || [] as FormQuestion[];
  
  // Find relevant questions using the FormQuestion type
  
  // 1. Mobility Needs Question
  const mobilityQuestion = questions.find((q: FormQuestion) => 
    q.Id === '70sl-1' || // Adult form
    q.Id === '12' ||     // Minor form
    (q.Text && (
      q.Text.includes('mobility devices') || 
      q.Text.includes('ground floor access')
    ))
  );
  
  if (mobilityQuestion && mobilityQuestion.Answer && mobilityQuestion.Answer !== '') {
    accessibilityInfo.hasMobilityNeeds = true;
    accessibilityInfo.mobilityDetails = mobilityQuestion.Answer;
  }
  
  // 2. Sensory Sensitivity Question
  const sensoryQuestion = questions.find((q: FormQuestion) => 
    q.Id === 'wkfi-1' || // Adult form
    q.Id === '13' ||     // Minor form
    (q.Text && (
      q.Text.includes('sensory sensitivities') || 
      q.Text.includes('light sensitivity') ||
      q.Text.includes('auditory sensitivity')
    ))
  );
  
  if (sensoryQuestion && sensoryQuestion.Answer && sensoryQuestion.Answer !== '') {
    accessibilityInfo.hasSensoryNeeds = true;
    accessibilityInfo.sensoryDetails = sensoryQuestion.Answer;
  }
  
  // 3. Physical Environment Question
  const physicalQuestion = questions.find((q: FormQuestion) => 
    q.Id === '1zfd-1' || // Adult form
    q.Id === '14' ||     // Minor form
    (q.Text && (
      q.Text.includes('physical environment') ||
      q.Text.includes('challenges with physical environment')
    ))
  );
  
  if (physicalQuestion && physicalQuestion.Answer && physicalQuestion.Answer !== '') {
    accessibilityInfo.hasPhysicalNeeds = true;
    accessibilityInfo.physicalDetails = physicalQuestion.Answer;
  }
  
  // 4. Room Consistency Question
  const consistencyQuestion = questions.find((q: FormQuestion) => 
    q.Id === 'j3rq-1' || // Adult form
    q.Id === '15' ||     // Minor form
    (q.Text && (
      q.Text.includes('room consistency') ||
      q.Text.includes('comfort level') ||
      q.Text.includes('different therapy room')
    ))
  );
  
  if (consistencyQuestion && consistencyQuestion.Answer) {
    // Parse the 1-5 value from the answer
    if (consistencyQuestion.Answer.includes('1')) {
      accessibilityInfo.roomConsistency = 1;
    } else if (consistencyQuestion.Answer.includes('2')) {
      accessibilityInfo.roomConsistency = 2;
    } else if (consistencyQuestion.Answer.includes('3')) {
      accessibilityInfo.roomConsistency = 3;
    } else if (consistencyQuestion.Answer.includes('4')) {
      accessibilityInfo.roomConsistency = 4;
    } else if (consistencyQuestion.Answer.includes('5')) {
      accessibilityInfo.roomConsistency = 5;
    }
  }
  
  // 5. Support Needs Question
  const supportQuestion = questions.find((q: FormQuestion) => 
    q.Id === '6gz6-1' || // Adult form
    q.Id === '16' ||     // Minor form
    (q.Text && (
      q.Text.includes('support needs') ||
      q.Text.includes('service animal') ||
      q.Text.includes('support person')
    ))
  );
  
  if (supportQuestion && supportQuestion.Answer && supportQuestion.Answer !== '') {
    accessibilityInfo.hasSupport = true;
    accessibilityInfo.supportDetails = supportQuestion.Answer;
  }
  
  // 6. Additional Notes Question
  const notesQuestion = questions.find((q: FormQuestion) => 
    q.Id === 'i820-1' || // Adult form
    (q.Text && (
      q.Text.includes('anything else we should know') ||
      q.Text.includes('space or accessibility needs')
    ))
  );
  
  if (notesQuestion && notesQuestion.Answer) {
    accessibilityInfo.additionalNotes = notesQuestion.Answer;
  }
  
  console.log('Extracted accessibility info:', {
    clientId: accessibilityInfo.clientId,
    hasMobilityNeeds: accessibilityInfo.hasMobilityNeeds,
    hasSensoryNeeds: accessibilityInfo.hasSensoryNeeds,
    hasPhysicalNeeds: accessibilityInfo.hasPhysicalNeeds,
    roomConsistency: accessibilityInfo.roomConsistency
  });
  
  return accessibilityInfo;
}

/**
 * Determine the form type more accurately from its name and questions
 */
private determineFormType(formData: any): 'Adult' | 'Minor' | 'Unknown' {
  const name = formData.QuestionnaireName || '';
  
  if (name.match(/Minor|Child|Youth|Teen|Adolescent/i)) {
    return 'Minor';
  } else if (name.match(/Adult|Individual|Personal/i)) {
    return 'Adult';
  }
  
  // Check for specific question IDs that are present in adult forms
  const questions = formData.Questions || [];
  const adultQuestionIds = ['70sl-1', 'wkfi-1', '1zfd-1'];
  const minorQuestionIds = ['12', '13', '14'];
  
  const hasAdultQuestions = adultQuestionIds.some(id => 
    questions.some((q: any) => q.Id === id)
  );
  
  const hasMinorQuestions = minorQuestionIds.some(id => 
    questions.some((q: any) => q.Id === id)
  );
  
  if (hasAdultQuestions) return 'Adult';
  if (hasMinorQuestions) return 'Minor';
  
  return 'Unknown';
}

  /**
   * Validate webhook payload and signature
   */
  private validateWebhook(
    payload: unknown
  ): { isValid: boolean; error?: string } {
    // Basic payload validation
    if (!payload || typeof payload !== 'object') {
      return { isValid: false, error: 'Invalid payload format: not an object' };
    }
  
    // Stringify and re-parse to ensure any nested values are properly processed
    try {
      const safePayload = JSON.parse(JSON.stringify(payload));
      const typedPayload = safePayload as Partial<IntakeQWebhookPayload>;
      
      // Required fields validation - check both Type and EventType
      const eventType = this.getEventType(typedPayload);
      if (!eventType) {
        return { isValid: false, error: 'Missing event type field (Type or EventType)' };
      }
      if (!typedPayload.ClientId) {
        return { isValid: false, error: 'Missing ClientId field' };
      }
  
      return { isValid: true };
    } catch (error: unknown) {
      console.error('Webhook payload parsing error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown parsing error';
      
      // Add more detailed error info but avoid complex type manipulations
      let detailedError = `Payload parsing error: ${errorMessage}`;
  
      // Add a very basic type indication without trying to preview the content
      detailedError += ` | Payload type: ${payload === null ? 'null' : typeof payload}`;
      
      return { isValid: false, error: detailedError };
    }
  }

  /**
   * Process webhook with retry logic
   */
  private async processWithRetry(
    payload: IntakeQWebhookPayload,
    attempt: number = 0
  ): Promise<WebhookResponse> {
    try {
      let result: WebhookResponse;
  
      const eventType = this.getEventType(payload);
      console.log('Processing event type:', eventType);

      if (!eventType) {
        return {
          success: false,
          error: 'Missing event type',
          retryable: false
        };
      }

      // Handle non-appointment events (appointment events should be handled by AppointmentSyncHandler)
      if (eventType.includes('Form Submitted') || eventType.includes('Intake Submitted')) {
        result = await this.handleIntakeSubmission(payload);
      } else if (!eventType.includes('Appointment') && !eventType.includes('appointment')) {
        console.log('Unhandled event type:', {
          receivedType: eventType,
          payloadType: payload.Type,
          expectedTypes: [
            'Form Submitted',
            'Intake Submitted'
          ]
        });
        return {
          success: false,
          error: `Unsupported webhook type: ${eventType}`,
          retryable: false
        };
      } else {
        // Return a message indicating this should be handled by AppointmentSyncHandler
        return {
          success: false,
          error: 'Appointment events should be handled by AppointmentSyncHandler',
          retryable: false
        };
      }

      if (!result.success && result.retryable && attempt < this.MAX_RETRIES) {
        // Log retry attempt
        await this.sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'WEBHOOK_RECEIVED' as AuditEventType,
          description: `Retry attempt ${attempt + 1} for ${eventType}`,
          user: 'SYSTEM',
          systemNotes: JSON.stringify({
            attempt: attempt + 1,
            type: eventType,
            clientId: payload.ClientId
          })
        });
        
        // Wait for delay
        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAYS[attempt]));
        
        // Retry processing
        return this.processWithRetry(payload, attempt + 1);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Log error
      await this.logWebhookError(
        'RETRY_ERROR',
        `Error on attempt ${attempt + 1}: ${errorMessage}`,
        payload
      );

      // Determine if another retry should be attempted
      if (this.isRetryableError(error) && attempt < this.MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAYS[attempt]));
        return this.processWithRetry(payload, attempt + 1);
      }

      return {
        success: false,
        error: errorMessage,
        retryable: false
      };
    }
  }

  /**
   * Handle intake form submission
   */
  private async handleIntakeSubmission(
    payload: IntakeQWebhookPayload
  ): Promise<WebhookResponse> {
    try {
      const formId = payload.IntakeId || payload.formId;
      const clientId = payload.ClientId?.toString();
      
      if (!formId || !clientId) {
        return {
          success: false,
          error: 'Missing form ID or client ID in form submission webhook',
          retryable: false
        };
      }
      
      // Log initial receipt of form
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'WEBHOOK_RECEIVED' as AuditEventType,
        description: `Processing intake form ${formId}`,
        user: 'INTAKEQ_WEBHOOK',
        systemNotes: JSON.stringify({
          formId: formId,
          clientId: clientId,
          isFullIntake: !!payload.IntakeId
        })
      });
  
      // Fetch the full form data from IntakeQ API if available
      let formData;
      if (this.intakeQService) {
        console.log(`Fetching full intake form data for form ID: ${formId}`);
        formData = await this.intakeQService.getFullIntakeForm(formId);
      }
      
      if (!formData && !payload.responses) {
        return {
          success: false,
          error: 'No form responses provided and unable to fetch from API',
          retryable: true
        };
      }
      
      // If we have form data, extract accessibility info directly
      if (formData) {
        const accessibilityInfo = this.extractAccessibilityInfo(formData, clientId);
        
        // Store the accessibility info in the Google Sheet
        await (this.sheetsService as any).updateClientAccessibilityInfo(accessibilityInfo);
        
        // Log successful processing
        await this.sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'CLIENT_PREFERENCES_UPDATED' as AuditEventType,
          description: `Updated accessibility info for client ${clientId} from form ${formId}`,
          user: 'SYSTEM',
          systemNotes: JSON.stringify({
            clientId: clientId,
            formId: formId,
            accessibilityInfoExtracted: true
          })
        });
        
        return {
          success: true,
          details: {
            formId: formId,
            clientId: clientId,
            formType: accessibilityInfo.formType,
            accessibilityInfoExtracted: true
          }
        };
      }
      
      // Fallback to using payload.responses if API fetch failed
      // Process responses based on form type
      const formResponses: Record<string, any> = payload.IntakeId ? 
  this.extractAccessibilitySection(payload.responses || {}) : 
  (payload.responses || {});
    
      // Validate processed responses
      if (Object.keys(formResponses).length === 0) {
        return {
          success: false,
          error: 'No valid accessibility responses found',
          retryable: false
        };
      }
    
      // Process form data using legacy method
      await (this.sheetsService as any).processAccessibilityForm({
        clientId: payload.ClientId.toString(),
        clientName: payload.ClientName || 'Unknown Client',
        clientEmail: payload.ClientEmail || 'unknown@example.com',
        formResponses: formResponses
      });
    
      // Return success response
      return {
        success: true,
        details: {
          formId: formId,
          clientId: payload.ClientId,
          type: payload.IntakeId ? 'full-intake' : 'accessibility-form',
          source: payload.IntakeId ? 'embedded' : 'standalone'
        }
      };
    
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.logWebhookError('FORM_PROCESSING_ERROR', errorMessage, payload);
      
      return {
        success: false,
        error: errorMessage,
        retryable: this.isRetryableError(error)
      };
    }
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
      // Network errors are typically retryable
      if (error.message.includes('network') || error.message.includes('timeout')) {
        return true;
      }

      // API rate limiting errors are retryable
      if (error.message.includes('rate limit') || error.message.includes('429')) {
        return true;
      }

      // Temporary service errors are retryable
      if (error.message.includes('503') || error.message.includes('temporary')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Log webhook error
   */
  private async logWebhookError(
    errorType: string,
    message: string,
    payload: unknown
  ): Promise<void> {
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'SYSTEM_ERROR' as AuditEventType,
      description: `Webhook ${errorType}: ${message}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        errorType,
        payload,
        timestamp: new Date().toISOString()
      })
    });
  }

  /**
   * Extract accessibility section from responses
   */
  private extractAccessibilitySection(responses: Record<string, any>): Record<string, any> {
    // Map the accessibility questions from the full intake form
    const accessibilityResponses: Record<string, any> = {};
    
    // Define accessibility question mappings
    const questionMappings = {
      'Do you use any mobility devices?': 'mobility_devices',
      'Access needs related to mobility/disability (Please specify)': 'mobility_other',
      'Do you experience sensory sensitivities?': 'sensory_sensitivities',
      'Other (Please specify):': 'sensory_other',
      'Do you experience challenges with physical environment?': 'physical_environment',
      'Please indicate your comfort level with this possibility:': 'room_consistency',
      'Do you have support needs that involve any of the following?': 'support_needs',
      'Is there anything else we should know about your space or accessibility needs?': 'additional_notes'
    };
  
    // Extract relevant responses
    for (const [question, key] of Object.entries(questionMappings)) {
      if (responses[question] !== undefined) {
        accessibilityResponses[question] = responses[question];
      }
    }
  
    console.log('Extracted accessibility responses:', accessibilityResponses);
    
    return accessibilityResponses;
  }
}

export default WebhookHandler;