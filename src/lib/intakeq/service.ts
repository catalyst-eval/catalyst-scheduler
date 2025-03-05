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
      
      // Try multiple formats if first one fails
      const formattedStart = this.formatDateForApi(startDate);
      const formattedEnd = this.formatDateForApi(endDate);
      
      // First format attempt (MM/dd/yyyy)
      let url = `${this.baseUrl}/appointments?StartDate=${formattedStart}&EndDate=${formattedEnd}&Status=${status}&dateField=StartDateIso`;
      console.log('IntakeQ Request URL:', url);
      
      try {
        const response = await axios.get(url, {
          headers: {
            'X-Auth-Key': this.apiKey,
            'Accept': 'application/json'
          }
        });
        
        console.log(`API response status: ${response.status}`);
        console.log(`Retrieved ${response.data.length} appointments`);
        return response.data;
      } catch (error) {
        // Try second format (yyyy-MM-dd) if first fails
        console.log('First format failed, trying alternative format...');
        url = `${this.baseUrl}/appointments?StartDate=${startDate}&EndDate=${endDate}&Status=${status}&dateField=StartDateIso`;
        
        const response = await axios.get(url, {
          headers: {
            'X-Auth-Key': this.apiKey,
            'Accept': 'application/json'
          }
        });
        
        console.log(`API response status with alternative format: ${response.status}`);
        console.log(`Retrieved ${response.data.length} appointments`);
        return response.data;
      }
    } catch (error) {
      this.logApiError('getAppointments', error, { startDate, endDate, status });
      throw error;
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
  // In src/lib/intakeq/service.ts
async validateWebhookSignature(payload: string, signature: string): Promise<boolean> {
  try {
    const secret = process.env.INTAKEQ_WEBHOOK_SECRET;
    if (!secret) {
      console.warn('Missing INTAKEQ_WEBHOOK_SECRET environment variable');
      // Return true in development even without secret
      return process.env.NODE_ENV !== 'production';
    }

    // Clean the webhook secret (remove quotes, trim)
    const cleanSecret = secret
      .replace(/^["']/, '') // Remove leading quotes
      .replace(/["']$/, '') // Remove trailing quotes
      .trim();              // Remove any whitespace

    // Create HMAC
    const hmac = crypto.createHmac('sha256', cleanSecret);
    
    // Ensure payload is a string
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    
    // Update HMAC with payload and get hex digest
    hmac.update(payloadStr);
    const calculatedSignature = hmac.digest('hex');

    // Log validation attempt with limited information (avoids logging full data)
    console.log('IntakeQ Webhook Signature Validation:', {
      signatureMatches: calculatedSignature === signature,
      calculatedSignaturePrefix: calculatedSignature.substring(0, 8) + '...',
      providedSignaturePrefix: signature ? signature.substring(0, 8) + '...' : 'none',
      renderURL: 'https://catalyst-scheduler.onrender.com',
      environment: process.env.NODE_ENV
    });

    const isValid = calculatedSignature === signature;
    
    // In development mode, log warning but don't fail on invalid signatures
    if (!isValid && process.env.NODE_ENV !== 'production') {
      console.warn('IntakeQ signature validation failed, but proceeding in development mode');
      // In development, we could return true to always proceed
      return process.env.NODE_ENV !== 'production';
    }

    return isValid;
  } catch (error) {
    console.error('Webhook signature validation error:', error);
    // In development mode, proceed even if validation throws an error
    return process.env.NODE_ENV !== 'production';
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

  /**
   * Helper method for consistent date formatting 
   */
  private formatDateForApi(dateString: string): string {
    try {
      // Try different date format - MM/dd/yyyy instead of yyyy-MM-dd
      const date = new Date(dateString);
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const year = date.getFullYear();
      
      // Log the formatted date for debugging
      console.log(`Formatting date ${dateString} as ${month}/${day}/${year}`);
      
      return `${month}/${day}/${year}`;
    } catch (e) {
      console.error('Date formatting error:', e);
      return dateString; // Fall back to original if parsing fails
    }
  }
  

  /**
   * Helper for detailed API error logging
   */
  private logApiError(method: string, error: unknown, context: any): void {
    const errorDetails: any = {
      method,
      context,
      message: error instanceof Error ? error.message : 'Unknown error',
      time: new Date().toISOString()
    };
    
    if (axios.isAxiosError(error)) {
      errorDetails.status = error.response?.status;
      errorDetails.statusText = error.response?.statusText;
      errorDetails.responseData = error.response?.data;
      errorDetails.requestConfig = {
        url: error.config?.url,
        method: error.config?.method,
        params: error.config?.params
      };
    }
    
    console.error('IntakeQ API Error:', JSON.stringify(errorDetails, null, 2));
    
    // Log to audit log if available
    if (this.sheetsService) {
      this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'SYSTEM_ERROR' as AuditEventType,
        description: `IntakeQ API error in ${method}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify(errorDetails)
      }).catch(e => console.error('Failed to log API error to audit log:', e));
    }
  }
}

export default IntakeQService;