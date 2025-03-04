// src/lib/intakeq/service.ts
import axios from 'axios';
import crypto from 'crypto';
import { GoogleSheetsService, AuditEventType } from '../google/sheets';
import { standardizeOfficeId } from '../util/office-id';

// Define IntakeQ appointment interface
export interface IntakeQAppointment {
  Id: string;
  ClientName: string;
  ClientEmail: string;
  ClientPhone: string;
  ClientDateOfBirth: string;
  ClientId: number;
  Status: string;
  StartDate: number;
  EndDate: number;
  Duration: number;
  ServiceName: string;
  ServiceId: string;
  LocationName: string;
  LocationId: string;
  Price: number;
  PractitionerName: string;
  PractitionerEmail: string;
  PractitionerId: string;
  IntakeId: string | null;
  DateCreated: number;
  CreatedBy: string;
  BookedByClient: boolean;
  ExternalClientId?: string;
  StartDateIso: string;
  EndDateIso: string;
  StartDateLocal: string;
  EndDateLocal: string;
  StartDateLocalFormatted: string;
  CancellationReason?: string;
  RecurrencePattern?: {
    frequency: 'weekly' | 'biweekly' | 'monthly';
    occurrences: number;
    endDate?: string;
  };
  [key: string]: any;
}

// Define IntakeQ API response interfaces
export interface IntakeQApiResponse<T> {
  success: boolean;
  error?: string;
  data?: T;
}

export type WebhookEventType = 
  | 'Form Submitted'
  | 'Intake Submitted'
  | 'AppointmentCreated'
  | 'AppointmentUpdated'
  | 'AppointmentRescheduled'
  | 'AppointmentCancelled'
  | 'Appointment Created'  // Legacy format
  | 'Appointment Updated'
  | 'Appointment Rescheduled'
  | 'Appointment Cancelled'
  | 'AppointmentCanceled'
  | 'Appointment Canceled'
  | 'AppointmentDeleted'
  | 'Appointment Deleted';

export interface IntakeQWebhookPayload {
  IntakeId?: string;
  Type?: WebhookEventType;      // Legacy field
  EventType?: WebhookEventType; // New field
  ClientId: number;
  ClientName?: string;
  ClientEmail?: string;
  ExternalClientId?: string;
  PracticeId?: string;
  ExternalPracticeId?: string | null;
  formId?: string;
  responses?: Record<string, any>;
  Appointment?: IntakeQAppointment;
  ActionPerformedByClient?: boolean;
}

export class IntakeQService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly sheetsService: GoogleSheetsService;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000; // 1 second base delay
  
  constructor(
    sheetsService: GoogleSheetsService,
    baseUrl: string = 'https://intakeq.com/api/v1',
    private readonly useMockData: boolean = false
  ) {
    if (!process.env.INTAKEQ_API_KEY) {
      throw new Error('Missing INTAKEQ_API_KEY environment variable');
    }
    
    this.apiKey = process.env.INTAKEQ_API_KEY;
    this.baseUrl = baseUrl;
    this.sheetsService = sheetsService;
  }
  
  /**
   * Get a single appointment from IntakeQ API
   */
  async getAppointments(
    startDate: string,
    endDate: string,
    status: string = 'Confirmed,WaitingConfirmation,Pending'
  ): Promise<IntakeQAppointment[]> {
    try {
      console.log('Fetching IntakeQ appointments:', { startDate, endDate });
  
      // Use simpler date formatting - avoid URL encoding issues
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      // Format dates in YYYY-MM-DD format which might be more reliable
      const formattedStart = start.toISOString().split('T')[0];
      const formattedEnd = end.toISOString().split('T')[0];
  
      const params = new URLSearchParams({
        StartDate: formattedStart,  // Simplified date format
        EndDate: formattedEnd,      // Simplified date format
        Status: status,
        dateField: 'StartDateIso'
      });
  
      const url = `${this.baseUrl}/appointments?${params}`;
      console.log('IntakeQ Request URL:', url);
  
      // Additional logging for headers
      console.log('Request headers:', {
        'X-Auth-Key': this.apiKey ? '***' : 'MISSING', // Don't log actual key, just presence
        'Accept': 'application/json'
      });
  
      const response = await axios.get(url, {
        headers: {
          'X-Auth-Key': this.apiKey,
          'Accept': 'application/json'
        }
      });
  
      if (response.status === 200) {
        console.log(`Successfully retrieved ${response.data.length} appointments`);
        return response.data;
      } else {
        throw new Error(`Unexpected response status: ${response.status}`);
      }
    } catch (error: unknown) {
      // Enhanced error logging with proper TypeScript typing
      const errorObj: Record<string, any> = {
        error: error instanceof Error ? error.message : 'Unknown error'
      };
      
      // Handle Axios error type specifically
      if (axios.isAxiosError(error) && error.response) {
        errorObj.status = error.response.status;
        errorObj.statusText = error.response.statusText;
        errorObj.data = error.response.data;
        
        if (error.config) {
          errorObj.config = {
            url: error.config.url,
            method: error.config.method,
            headers: {
              ...error.config.headers,
              'X-Auth-Key': '***' // Redact actual key
            }
          };
        }
      }
      
      console.error('IntakeQ API Error Details:', errorObj);
      
      // Rethrow as a typed error
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error('Unknown error when fetching IntakeQ appointments');
      }
    }
  }
  
  /**
   * Get practitioner information from IntakeQ API
   */
  async getPractitioners(): Promise<any[]> {
    try {
      console.log('Fetching IntakeQ practitioners');
      
      const response = await axios.get(
        `${this.baseUrl}/practitioners`,
        {
          headers: {
            'X-Auth-Key': this.apiKey,
            'Accept': 'application/json'
          }
        }
      );
      
      if (response.status !== 200 || !response.data) {
        throw new Error(`IntakeQ API error: ${response.statusText}`);
      }
      
      console.log(`Successfully fetched ${response.data.length} practitioners`);
      return response.data;
    } catch (error) {
      console.error('Error fetching practitioners from IntakeQ:', error);
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Error fetching practitioners from IntakeQ',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }
  
  /**
   * Get client information from IntakeQ API
   */
  async getClient(clientId: number): Promise<any | null> {
    try {
      console.log(`Fetching IntakeQ client: ${clientId}`);
      
      const response = await axios.get(
        `${this.baseUrl}/clients/${clientId}`,
        {
          headers: {
            'X-Auth-Key': this.apiKey,
            'Accept': 'application/json'
          }
        }
      );
      
      if (response.status !== 200 || !response.data) {
        throw new Error(`IntakeQ API error: ${response.statusText}`);
      }
      
      console.log(`Successfully fetched client ${clientId}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching client ${clientId} from IntakeQ:`, error);
      
      // If we get a 404, return null instead of throwing
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        console.log(`Client ${clientId} not found`);
        return null;
      }
      
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: `Error fetching client ${clientId} from IntakeQ`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
 * Get full intake form data from IntakeQ API
 */
async getFullIntakeForm(formId: string): Promise<any> {
  try {
    console.log(`Fetching full intake form data for ID: ${formId}`);
    
    const response = await axios.get(
      `${this.baseUrl}/intakes/${formId}`,
      {
        headers: {
          'X-Auth-Key': this.apiKey,
          'Accept': 'application/json'
        }
      }
    );
    
    if (response.status !== 200 || !response.data) {
      throw new Error(`IntakeQ API error: ${response.statusText}`);
    }
    
    console.log(`Successfully fetched form data for form ID ${formId}`);
    return response.data;
  } catch (error) {
    console.error(`Error fetching form data for form ID ${formId}:`, error);
    
    // If we get a 404, return null instead of throwing
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      console.log(`Form ${formId} not found`);
      return null;
    }
    
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: `Error fetching form data for form ID ${formId} from IntakeQ`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    throw error;
  }
}

  /**
   * Validate IntakeQ webhook signature
   */
  async validateWebhookSignature(payload: string, signature: string): Promise<boolean> {
    try {
      const secret = process.env.INTAKEQ_WEBHOOK_SECRET;
      if (!secret) {
        console.error('Missing INTAKEQ_WEBHOOK_SECRET environment variable');
        return false;
      }

      // Remove any quotes from the secret
      const cleanSecret = secret.replace(/['"]/g, '');

      // Create HMAC
      const hmac = crypto.createHmac('sha256', cleanSecret);
      hmac.update(payload);
      const calculatedSignature = hmac.digest('hex');

      console.log('Webhook Signature Validation:', {
        signatureMatches: calculatedSignature === signature,
        calculatedLength: calculatedSignature.length,
        providedLength: signature.length,
        payloadLength: payload.length,
      });

      return calculatedSignature === signature;
    } catch (error) {
      console.error('Webhook signature validation error:', error);
      return false;
    }
  }

  /**
   * Test connection to IntakeQ API
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/practitioners`, {
        headers: {
          'X-Auth-Key': this.apiKey,
          'Accept': 'application/json'
        }
      });

      console.log('IntakeQ Connection Test:', {
        status: response.status,
        ok: response.status === 200
      });

      return response.status === 200;
    } catch (error) {
      console.error('IntakeQ connection test failed:', error instanceof Error ? error.message : 'Unknown error');
      return false;
    }
  }

  /**
   * Determine the standardized office ID for an appointment
   */
  private async getStandardizedOfficeId(appointment: IntakeQAppointment): Promise<string> {
    try {
      // If appointment already has an office assignment from our system, use that
      if (appointment.Location) {
        return standardizeOfficeId(appointment.Location);
      }

      // Get clinician's default office
      const clinicians = await this.sheetsService.getClinicians();
      const clinician = clinicians.find(c => c.intakeQPractitionerId === appointment.PractitionerId);

      if (clinician?.preferredOffices?.length) {
        return standardizeOfficeId(clinician.preferredOffices[0]);
      }

      // Default to A-a if no other assignment possible
      return standardizeOfficeId('A-a');
    } catch (error) {
      console.error('Error standardizing office ID:', error);
      return standardizeOfficeId('A-a');
    }
  }

  /**
   * Validate office ID format
   */
  private isValidOfficeId(officeId: string): boolean {
    return /^[A-Z]-[a-z]$/.test(officeId);
  }
}

export default IntakeQService;