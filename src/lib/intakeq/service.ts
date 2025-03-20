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
  private readonly DISABLE_API_CALLS = process.env.DISABLE_API_CALLS === 'true' || false;
  
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
   * Get a list of whitelisted IPs from environment variable
   */
  private getWhitelistedIPs(): string[] {
    const ipsString = process.env.INTAKEQ_API_IPS || '';
    return ipsString.split(',').map(ip => ip.trim()).filter(ip => ip !== '');
  }

  /**
   * Get a random IP from the whitelisted IPs list
   */
  private getRandomWhitelistedIP(): string {
    const ips = this.getWhitelistedIPs();
    if (ips.length === 0) return '';
    
    // Get a random IP from the list
    const randomIndex = Math.floor(Math.random() * ips.length);
    return ips[randomIndex];
  }

  // Updated implementation for src/lib/intakeq/service.ts
  // Update this method in src/lib/intakeq/service.ts
  async getAppointments(
    startDate: string,
    endDate: string,
    status: string = 'Confirmed,WaitingConfirmation,Pending'
  ): Promise<IntakeQAppointment[]> {
    try {
      // Check if API calls are disabled
      if (this.DISABLE_API_CALLS) {
        console.log(`API DISABLED: Using local appointment data for date range ${startDate} to ${endDate}`);
        return []; // Return empty array when API calls are disabled
      }
      
      // Rest of the original implementation...
      console.log('Fetching IntakeQ appointments:', { startDate, endDate });
  
      // Convert dates to proper format and ensure full day ranges
      const requestedStart = new Date(startDate);
      const requestedEnd = new Date(endDate);
  
      // Create start of day in UTC
      const startOfDay = new Date(requestedStart);
      startOfDay.setHours(0, 0, 0, 0);
      
      // Create end of day in UTC
      const endOfDay = new Date(requestedEnd);
      endOfDay.setHours(23, 59, 59, 999);

      console.log('Date ranges:', {
        start: startOfDay.toISOString(),
        end: endOfDay.toISOString()
      });

      // Use URLSearchParams for proper parameter encoding
      const params = new URLSearchParams({
        startDate: startOfDay.toISOString().split('T')[0],
        endDate: endOfDay.toISOString().split('T')[0],
        status: status,
        dateField: 'StartDateIso'
      });

      const url = `${this.baseUrl}/appointments?${params}`;
      console.log('IntakeQ Request URL:', url);

      // Get a whitelisted IP
      const whitelistedIP = this.getRandomWhitelistedIP();
      console.log(`Using whitelisted IP: ${whitelistedIP || 'None available'}`);

      // Switch to native fetch API with correct TypeScript types
      let attempt = 0;
      let response: Response | null = null;
      let lastError: string = '';

      while (attempt < this.MAX_RETRIES) {
        try {
          console.log(`Attempt ${attempt + 1} - Fetching from: ${url}`);
          
          // Configure headers with API key and whitelisted IP
          const headers: Record<string, string> = {
            'X-Auth-Key': this.apiKey,
            'Accept': 'application/json'
          };
          
          // Add the whitelisted IP to the X-Forwarded-For header if available
          if (whitelistedIP) {
            headers['X-Forwarded-For'] = whitelistedIP;
          }
          
          // Use fetch with properly typed headers
          response = await fetch(url, {
            method: 'GET',
            headers: headers
          });

          if (response.ok) break;

          const errorText = await response.text();
          lastError = `HTTP ${response.status}: ${errorText}`;
          
          console.log(`Attempt ${attempt + 1} failed:`, {
            status: response.status,
            error: lastError
          });

          attempt++;
          if (attempt < this.MAX_RETRIES) {
            const delay = this.RETRY_DELAY * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : 'Unknown error';
          console.log(`Attempt ${attempt + 1} error:`, lastError);
          
          attempt++;
          if (attempt < this.MAX_RETRIES) {
            const delay = this.RETRY_DELAY * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      if (!response || !response.ok) {
        const errorMessage = `IntakeQ API error after ${this.MAX_RETRIES} attempts: ${lastError}`;
        console.error('Final error details:', {
          attempts: attempt,
          lastError
        });
        
        // Log the error through sheets
        await this.logApiError('getAppointments', new Error(errorMessage), { 
          startDate, 
          endDate, 
          status 
        });
        
        // Return empty array instead of throwing
        return [];
      }

      // Parse response
      const responseText = await response.text();
      console.log('Received response text length:', responseText.length);
      
      let appointments: IntakeQAppointment[] = [];
      try {
        appointments = JSON.parse(responseText);
      } catch (parseError) {
        console.error('Error parsing JSON response:', parseError);
        console.log('Response text preview:', responseText.substring(0, 200));
        
        // Return empty array instead of throwing
        return [];
      }

      console.log(`Retrieved ${appointments.length} appointments`);
      return appointments;
    } catch (error) {
      console.error('Error fetching IntakeQ appointments:', error);
      
      // Log error but don't throw - return empty array
      this.logApiError('getAppointments', error, { startDate, endDate, status });
      
      // Return empty array to prevent system failure
      return [];
    }
  }
  
/**
 * Get client information from IntakeQ API
 */
async getClient(clientId: number): Promise<any | null> {
  try {
    // Check if API calls are disabled
    if (this.DISABLE_API_CALLS) {
      console.log(`API DISABLED: Skipping client data retrieval for client ${clientId}`);
      return null;
    }
    console.log(`Fetching IntakeQ client: ${clientId}`);
    
    // Get a whitelisted IP
    const whitelistedIP = this.getRandomWhitelistedIP();
    
    // Create headers with API key and whitelisted IP
    const headers: Record<string, string> = {
      'X-Auth-Key': this.apiKey,
      'Accept': 'application/json'
    };
    
    // Add the whitelisted IP to the X-Forwarded-For header if available
    if (whitelistedIP) {
      headers['X-Forwarded-For'] = whitelistedIP;
    }
    
    const response = await axios.get(
      `${this.baseUrl}/clients/${clientId}`,
      {
        headers: headers
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
      // Check if API calls are disabled
      if (this.DISABLE_API_CALLS) {
        console.log(`API DISABLED: Skipping form retrieval for form ${formId}`);
        return null;
      }
      console.log(`Fetching full intake form data for ID: ${formId}`);
      
      // Get a whitelisted IP
      const whitelistedIP = this.getRandomWhitelistedIP();
      
      // Create headers with API key and whitelisted IP
      const headers: Record<string, string> = {
        'X-Auth-Key': this.apiKey,
        'Accept': 'application/json'
      };
      
      // Add the whitelisted IP to the X-Forwarded-For header if available
      if (whitelistedIP) {
        headers['X-Forwarded-For'] = whitelistedIP;
      }
      
      const response = await axios.get(
        `${this.baseUrl}/intakes/${formId}`,
        {
          headers: headers
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
      // Check if API calls are disabled
      if (this.DISABLE_API_CALLS) {
        console.log('API DISABLED: Skipping connection test');
        return false;
      }
      // Get a whitelisted IP
      const whitelistedIP = this.getRandomWhitelistedIP();
      
      // Create headers with API key and whitelisted IP
      const headers: Record<string, string> = {
        'X-Auth-Key': this.apiKey,
        'Accept': 'application/json'
      };
      
      // Add the whitelisted IP to the X-Forwarded-For header if available
      if (whitelistedIP) {
        headers['X-Forwarded-For'] = whitelistedIP;
      }
      
      const response = await axios.get(`${this.baseUrl}/practitioners`, {
        headers: headers
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
   * Generic method to fetch data from the IntakeQ API
   */
  async fetchFromIntakeQ(endpoint: string): Promise<any> {
    try {
      // Check if API calls are disabled
      if (this.DISABLE_API_CALLS) {
        console.log(`API DISABLED: Skipping API request to ${endpoint}`);
        return null;
      }
      console.log(`Fetching from IntakeQ API: ${endpoint}`);
      
      // Get a whitelisted IP
      const whitelistedIP = this.getRandomWhitelistedIP();
      
      // Create headers with API key and whitelisted IP
      const headers: Record<string, string> = {
        'X-Auth-Key': this.apiKey,
        'Accept': 'application/json'
      };
      
      // Add the whitelisted IP to the X-Forwarded-For header if available
      if (whitelistedIP) {
        headers['X-Forwarded-For'] = whitelistedIP;
      }
      
      const response = await axios.get(
        `${this.baseUrl}/${endpoint}`,
        {
          headers: headers
        }
      );
      
      if (response.status !== 200 || !response.data) {
        throw new Error(`IntakeQ API error: ${response.statusText}`);
      }
      
      return response.data;
    } catch (error) {
      this.logApiError('fetchFromIntakeQ', error, { endpoint });
      throw error;
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