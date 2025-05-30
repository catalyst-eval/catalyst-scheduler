// src/lib/google/sheets.ts

import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { 
  SheetOffice, 
  SheetClinician, 
  AssignmentRule, 
  ClientPreference,
  ScheduleConfig,
  IntegrationSetting,
  AuditLogEntry,
  SheetRow
} from '../../types/sheets';
import { 
  AppointmentRecord, 
  standardizeOfficeId,
  normalizeAppointmentRecord 
} from '../../types/scheduling';
import { SheetsCacheService } from './sheets-cache';
import { 
  getTodayEST, 
  getESTDayRange
} from '../util/date-helpers';

export interface IGoogleSheetsService {
  getOffices(): Promise<SheetOffice[]>;
  getClinicians(): Promise<SheetClinician[]>;
  getAssignmentRules(): Promise<AssignmentRule[]>;
  getClientPreferences(): Promise<ClientPreference[]>;
  getScheduleConfig(): Promise<ScheduleConfig[]>;
  getIntegrationSettings(): Promise<IntegrationSetting[]>;
  addAuditLog(entry: AuditLogEntry): Promise<void>;
  getRecentAuditLogs(limit?: number): Promise<AuditLogEntry[]>;
  getOfficeAppointments(officeId: string, date: string): Promise<AppointmentRecord[]>;
  addAppointment(appt: AppointmentRecord): Promise<void>;
  getAllAppointments(): Promise<AppointmentRecord[]>;
  getAppointments(startDate: string, endDate: string): Promise<AppointmentRecord[]>;
  getActiveAppointments(): Promise<AppointmentRecord[]>; 
  updateAppointment(appointment: AppointmentRecord): Promise<void>;
  getAppointment(appointmentId: string): Promise<AppointmentRecord | null>;
  deleteAppointment(appointmentId: string): Promise<void>;
  updateClientPreference(preference: ClientPreference): Promise<void>;
  getClientAccessibilityInfo(clientId: string): Promise<any | null>;
  updateClientAccessibilityInfo(accessibilityInfo: {
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
    formType: string;
    formId: string;
    requiredOffice?: string;
  }): Promise<void>;
  getClientRequiredOffices(): Promise<any[]>;
  processAccessibilityForm(formData: {
    clientId: string;
    clientName: string;
    clientEmail: string;
    formResponses: Record<string, any>;
  }): Promise<void>;
  isWebhookProcessed(webhookId: string): Promise<boolean>;
  logWebhook(webhookId: string, status: 'processing' | 'completed' | 'failed', details?: any): Promise<void>;
  updateWebhookStatus(webhookId: string, status: 'processing' | 'completed' | 'failed', details?: any): Promise<void>;
  updateAppointmentStatus(appointmentId: string, status: 'scheduled' | 'completed' | 'cancelled' | 'rescheduled', additionalInfo?: { reason?: string; notes?: string; }): Promise<void>;
  
  // Add cache property with methods
  cache: {
    invalidate(key: string): void;
    invalidatePattern(pattern: string): void;
    invalidateAppointments(): void;
    clearAll(): void;
  };
}

export enum AuditEventType {
  CONFIG_UPDATED = 'CONFIG_UPDATED',
  RULE_CREATED = 'RULE_CREATED',
  RULE_UPDATED = 'RULE_UPDATED',
  CLIENT_PREFERENCES_UPDATED = 'CLIENT_PREFERENCES_UPDATED',
  CLIENT_OFFICE_ASSIGNED = 'CLIENT_OFFICE_ASSIGNED',
  APPOINTMENT_CREATED = 'APPOINTMENT_CREATED',
  APPOINTMENT_UPDATED = 'APPOINTMENT_UPDATED',
  APPOINTMENT_CANCELLED = 'APPOINTMENT_CANCELLED',
  APPOINTMENT_DELETED = 'APPOINTMENT_DELETED',
  SYSTEM_ERROR = 'SYSTEM_ERROR',
  WEBHOOK_RECEIVED = 'WEBHOOK_RECEIVED',
  INTEGRATION_UPDATED = 'INTEGRATION_UPDATED',
  DAILY_ASSIGNMENTS_UPDATED = 'DAILY_ASSIGNMENTS_UPDATED',
  CRITICAL_ERROR = 'CRITICAL_ERROR',
  OFFICE_ASSIGNMENTS_RESOLVED = 'OFFICE_ASSIGNMENTS_RESOLVED'
}

// Sheet name constants to avoid typos and make updates easier
const SHEET_NAMES = {
  OFFICES: 'Offices_Configuration',
  CLINICIANS: 'Clinicians_Configuration',
  ASSIGNMENT_RULES: 'Assignment_Rules',
  CLIENT_ACCESSIBILITY: 'Client_Accessibility_Info',
  SCHEDULE_CONFIG: 'Schedule_Configuration',
  INTEGRATION_SETTINGS: 'Integration_Settings',
  APPOINTMENTS: 'Appointments',
  ACTIVE_APPOINTMENTS: 'Active_Appointments', // New tab for today's appointments
  AUDIT_LOG: 'Audit_Log',
  WEBHOOK_LOG: 'Webhook_Log'
};

export class GoogleSheetsService implements IGoogleSheetsService {
  private readonly sheets;
  private readonly spreadsheetId: string;
  public readonly cache: SheetsCacheService;
  
  /**
   * Helper method to verify an appointment exists in a sheet
   * Added to support enhanced appointment verification
   */
  private async verifyAppointmentExists(appointmentId: string, sheetName: string): Promise<boolean> {
    try {
      const values = await this.readSheet(`${sheetName}!A:A`);
      return values?.some(row => row[0] === appointmentId) || false;
    } catch (error) {
      console.error(`Error verifying appointment ${appointmentId} in ${sheetName}:`, error);
      return false;
    }
  }
  
  /**
   * Enhanced appointment creation with verification
   */
  async addAppointmentWithVerification(appt: AppointmentRecord): Promise<{
    success: boolean;
    verification?: 'full' | 'partial' | 'none';
    error?: string;
  }> {
    try {
      // Normalize the appointment
      const normalizedAppointment = normalizeAppointmentRecord(appt);
      
      // Ensure both old and new field values are set
      const currentOfficeId = standardizeOfficeId(
        normalizedAppointment.currentOfficeId || normalizedAppointment.officeId || 'TBD'
      );
      
      const assignedOfficeId = standardizeOfficeId(
        normalizedAppointment.assignedOfficeId || normalizedAppointment.suggestedOfficeId || currentOfficeId || 'TBD'
      );
  
      // Prepare requirements JSON with error handling
      let requirementsJson = '{"accessibility":false,"specialFeatures":[]}';
      try {
        if (normalizedAppointment.requirements) {
          requirementsJson = JSON.stringify(normalizedAppointment.requirements);
        }
      } catch (jsonError) {
        console.error('Error stringifying requirements, using default:', jsonError);
      }
  
      // Format tags as comma-separated string
      const tagsString = normalizedAppointment.tags && normalizedAppointment.tags.length > 0 ? 
        normalizedAppointment.tags.join(',') : '';
  
      // Prepare row data
      const rowData = [
        normalizedAppointment.appointmentId,                     // Column A: appointmentId
        normalizedAppointment.clientId,                          // Column B: clientId
        normalizedAppointment.clientName,                        // Column C: clientName
        normalizedAppointment.clientDateOfBirth || '',           // Column D: clientDateOfBirth
        normalizedAppointment.clinicianId,                       // Column E: clinicianId
        normalizedAppointment.clinicianName,                     // Column F: clinicianName
        currentOfficeId,                                         // Column G: currentOfficeId
        normalizedAppointment.sessionType,                       // Column H: sessionType
        normalizedAppointment.startTime,                         // Column I: startTime
        normalizedAppointment.endTime,                           // Column J: endTime
        normalizedAppointment.status,                            // Column K: status
        normalizedAppointment.source,                            // Column L: source
        normalizedAppointment.lastUpdated || new Date().toISOString(), // Column M: lastUpdated
        requirementsJson,                                        // Column N: requirements
        normalizedAppointment.notes || '',                       // Column O: notes
        assignedOfficeId,                                        // Column P: assignedOfficeId
        normalizedAppointment.assignmentReason || '',            // Column Q: assignmentReason
        tagsString                                               // Column R: tags (NEW)
      ];
      
      // Step 1: Add to main Appointments tab
      await this.appendRows(`${SHEET_NAMES.APPOINTMENTS}!A:R`, [rowData]);
      
      // Step 2: Check if it's for today and add to Active_Appointments if needed
      const isForToday = this.isAppointmentForToday(normalizedAppointment);
      
      if (isForToday) {
        try {
          // Check if Active_Appointments exists
          let activeSheetExists = true;
          try {
            await this.readSheet(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A1`);
          } catch (error) {
            activeSheetExists = false;
          }
          
          if (activeSheetExists) {
            await this.appendRows(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A:R`, [rowData]);
            console.log(`Added appointment ${normalizedAppointment.appointmentId} to Active_Appointments`);
          }
        } catch (activeError) {
          console.warn(`Could not add to Active_Appointments:`, activeError);
        }
      }
      
      // Step 3: Verify the appointment was actually added
      // Wait a short time for Google Sheets to process
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Check if appointment exists in main tab
      const mainVerification = await this.verifyAppointmentExists(normalizedAppointment.appointmentId, SHEET_NAMES.APPOINTMENTS);
      
      // If for today, also verify in Active_Appointments
      let activeVerification = true;
      if (isForToday) {
        activeVerification = await this.verifyAppointmentExists(normalizedAppointment.appointmentId, SHEET_NAMES.ACTIVE_APPOINTMENTS);
      }
      
      // Determine verification level
      let verification: 'full' | 'partial' | 'none' = 'none';
      if (mainVerification && (!isForToday || activeVerification)) {
        verification = 'full';
      } else if (mainVerification || activeVerification) {
        verification = 'partial';
      }
      
      // Log verification results
      console.log(`Appointment ${normalizedAppointment.appointmentId} verification: ${verification} (main=${mainVerification}, active=${activeVerification})`);
      
      if (verification === 'none') {
        // Log the failure for diagnostics
        await this.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: AuditEventType.SYSTEM_ERROR,
          description: `Failed to verify appointment ${normalizedAppointment.appointmentId} in sheets after adding`,
          user: 'SYSTEM',
          systemNotes: JSON.stringify({
            appointmentId: normalizedAppointment.appointmentId,
            clientName: normalizedAppointment.clientName,
            mainVerification,
            activeVerification,
            isForToday
          })
        });
        
        return {
          success: false,
          verification,
          error: 'Appointment was not found in sheets after adding'
        };
      }
      
      if (verification === 'partial') {
        // Log partial success for diagnostics
        console.warn(`Partial verification for appointment ${normalizedAppointment.appointmentId}: main=${mainVerification}, active=${activeVerification}`);
        
        // Try to fix the inconsistency
        if (mainVerification && !activeVerification && isForToday) {
          try {
            await this.appendRows(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A:R`, [rowData]);
            console.log(`Repaired Active_Appointments for ${normalizedAppointment.appointmentId}`);
          } catch (repairError) {
            console.warn(`Failed to repair Active_Appointments for ${normalizedAppointment.appointmentId}:`, repairError);
          }
        }
        
        await this.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: AuditEventType.SYSTEM_ERROR, // Using SYSTEM_ERROR as SYSTEM_WARNING doesn't exist
          description: `Partial verification for appointment ${normalizedAppointment.appointmentId}`,
          user: 'SYSTEM',
          systemNotes: JSON.stringify({
            appointmentId: normalizedAppointment.appointmentId,
            clientName: normalizedAppointment.clientName,
            mainVerification,
            activeVerification,
            isForToday
          })
        });
      }
      
      // Add audit log entry for successful creation
      await this.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.APPOINTMENT_CREATED,
        description: `Added appointment for ${normalizedAppointment.clientName}`,
        user: 'SYSTEM',
        newValue: JSON.stringify(normalizedAppointment)
      });
      
      // Invalidate caches
      this.cache.invalidatePattern(`appointments:${normalizedAppointment.appointmentId}`);
      
      return {
        success: true,
        verification
      };
    } catch (error) {
      console.error('Error adding appointment:', error);
      await this.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: `Failed to add appointment ${appt.appointmentId}`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      return {
        success: false,
        verification: 'none',
        error: error instanceof Error ? error.message : 'Unknown error adding appointment'
      };
    }
  }
  
  /**
   * Get the spreadsheet ID used by this service
   */
  public getSpreadsheetId(): string {
    return this.spreadsheetId;
  }
  
  /**
   * Get the Google Sheets API interface
   */
  public getSheetsApi(): any {
    return this.sheets;
  }

  constructor() {
    console.log('Google Sheets Service initializing...');
    
    if (!process.env.GOOGLE_SHEETS_PRIVATE_KEY || !process.env.GOOGLE_SHEETS_CLIENT_EMAIL) {
      throw new Error('Missing required Google Sheets credentials');
    }
    
    // Handle different formats of private key
    let privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
    
    // Replace literal \n with actual newlines if needed
    if (privateKey.includes('\\n')) {
      privateKey = privateKey.replace(/\\n/g, '\n');
      console.log('Replaced escaped newlines in private key');
    } else {
      console.log('Private key already has proper newlines, no replacement needed');
    }
    
    // If key is enclosed in quotes, remove them
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
      privateKey = privateKey.slice(1, -1);
    }
    
    console.log('Private key length:', privateKey.length);
    console.log('Private key starts with:', privateKey.substring(0, 20) + '...');
    
    try {
      const client = new JWT({
        email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
        key: privateKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      this.sheets = google.sheets({ version: 'v4', auth: client });
      this.spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '';
      this.cache = new SheetsCacheService();
      
      console.log('GoogleSheetsService initialized successfully');
    } catch (error) {
      console.error('Error initializing Google Sheets client:', error);
      throw error;
    }
  }

  /**
 * Executes a series of operations in a transaction-like manner
 * If any operation fails, attempts to revert changes
 */
async executeTransaction<T>(
  operations: () => Promise<T>,
  rollback: () => Promise<void>,
  description: string
): Promise<T> {
  let result: T;
  let success = false;
  
  try {
    // Log transaction start
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'TRANSACTION_STARTED',
      description: `Starting transaction: ${description}`,
      user: 'SYSTEM'
    });
    
    // Execute the operations
    result = await operations();
    success = true;
    
    // Log transaction success
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'TRANSACTION_COMPLETED',
      description: `Completed transaction: ${description}`,
      user: 'SYSTEM'
    });
    
    return result;
  } catch (error) {
    // Log transaction failure
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'TRANSACTION_FAILED',
      description: `Failed transaction: ${description}`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    // Attempt rollback
    try {
      await rollback();
      
      await this.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'TRANSACTION_ROLLED_BACK',
        description: `Rolled back transaction: ${description}`,
        user: 'SYSTEM'
      });
    } catch (rollbackError) {
      await this.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'CRITICAL_ERROR',
        description: `Failed to rollback transaction: ${description}`,
        user: 'SYSTEM',
        systemNotes: rollbackError instanceof Error ? rollbackError.message : 'Unknown rollback error'
      });
    }
    
    throw error;
  }
}

  /**
   * Get all client accessibility records
   * UPDATED: Now includes the requiredOffice field (column P)
   */
  async getClientAccessibilityRecords(): Promise<any[]> {
    try {
      // Updated range to include column P (requiredOffice)
      const values = await this.readSheet(`${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A2:P`);
      
      if (!values || values.length === 0) {
        return [];
      }
      
      return values.map(row => ({
        clientId: row[0] || '',
        clientName: row[1] || '',
        lastUpdated: row[2] || '',
        hasMobilityNeeds: row[3] === 'TRUE',
        mobilityDetails: row[4] || '',
        hasSensoryNeeds: row[5] === 'TRUE',
        sensoryDetails: row[6] || '',
        hasPhysicalNeeds: row[7] === 'TRUE',
        physicalDetails: row[8] || '',
        roomConsistency: parseInt(row[9] || '3'),
        hasSupport: row[10] === 'TRUE',
        supportDetails: row[11] || '',
        additionalNotes: row[12] || '',
        formType: row[13] || '',
        formId: row[14] || '',
        requiredOffice: row[15] || '' // Added requiredOffice field
      }));
    } catch (error) {
      console.error('Error getting client accessibility records:', error);
      return [];
    }
  }

  /**
 * Check if a webhook has already been processed
 */
async isWebhookProcessed(webhookId: string): Promise<boolean> {
  try {
    const values = await this.readSheet(`${SHEET_NAMES.WEBHOOK_LOG}!A:E`);
    if (!values) return false;
    
    // Check if webhook ID exists and is marked as completed
    const matchingRow = values.find(row => row[0] === webhookId && row[4] === 'completed');
    return !!matchingRow;
  } catch (error) {
    console.error(`Error checking webhook ${webhookId} status:`, error);
    // In case of error, assume not processed to ensure it gets handled
    return false;
  }
}

/**
 * Log a new webhook entry
 */
async logWebhook(webhookId: string, status: 'processing' | 'completed' | 'failed', details: any = {}): Promise<void> {
  try {
    const rowData = [
      webhookId,
      new Date().toISOString(),
      details.type || '',
      details.entityId || '',
      status,
      details.retryCount || 0,
      status === 'completed' ? new Date().toISOString() : '',
      status === 'failed' ? JSON.stringify(details.error || '') : ''
    ];

    await this.appendRows(`${SHEET_NAMES.WEBHOOK_LOG}!A:H`, [rowData]);
  } catch (error) {
    console.error(`Error logging webhook ${webhookId}:`, error);
    // Not throwing to avoid disrupting main flow
  }
}

/**
 * Update the status of an existing webhook entry
 */
async updateWebhookStatus(webhookId: string, status: 'processing' | 'completed' | 'failed', details: any = {}): Promise<void> {
  try {
    // Find the webhook row
    const values = await this.readSheet(`${SHEET_NAMES.WEBHOOK_LOG}!A:A`);
    if (!values) return;
    
    const rowIndex = values.findIndex(row => row[0] === webhookId);
    if (rowIndex === -1) {
      // If not found, log it as a new entry
      return this.logWebhook(webhookId, status, details);
    }
    
    // Update status and related fields
    const updateData = [
      status,
      details.retryCount || 0,
      status === 'completed' ? new Date().toISOString() : '',
      status === 'failed' ? JSON.stringify(details.error || '') : ''
    ];
    
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${SHEET_NAMES.WEBHOOK_LOG}!E${rowIndex + 2}:H${rowIndex + 2}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [updateData]
      }
    });
  } catch (error) {
    console.error(`Error updating webhook ${webhookId} status:`, error);
    // Not throwing to avoid disrupting main flow
  }
}

  /**
 * Read data from a Google Sheet
 * Now accepts an optional TTL parameter
 */
private async readSheet(range: string, ttl: number = 60000): Promise<any[]> {
  const cacheKey = `sheet:${range}`;
  
  try {
    return await this.cache.getOrFetch(
      cacheKey,
      async () => {
        console.log(`Reading sheet range: ${range}`);
        
        // Parse the range into sheet name and cell range
        const exclamationIndex = range.indexOf('!');
        
        if (exclamationIndex === -1) {
          throw new Error(`Invalid range format: ${range}`);
        }
        
        const sheetName = range.substring(0, exclamationIndex);
        const cellRange = range.substring(exclamationIndex + 1);
        
        // Check if the sheet name matches our constants
        const matchesConstants = Object.values(SHEET_NAMES).includes(sheetName);
        if (!matchesConstants) {
          console.warn(`Sheet name ${sheetName} doesn't match any constant in SHEET_NAMES. This may cause issues.`);
        }
        
        // Make API request with proper error handling
        try {
          const response = await this.sheets.spreadsheets.values.get({
            spreadsheetId: this.spreadsheetId,
            range: range, // Google's API will handle the encoding
          });
          
          console.log(`Successfully read sheet range: ${range} - Retrieved ${response.data.values?.length || 0} rows`);
          return response.data.values || [];
        } catch (apiError: unknown) {
          console.error(`Google Sheets API error for range ${range}:`, apiError);
          
          // If missing sheet, provide helpful error
          if (apiError && typeof apiError === 'object' && 'message' in apiError && 
              typeof apiError.message === 'string' && apiError.message.includes('Unable to parse range')) {
            console.error('This may be due to missing sheet or name format mismatch.');
            console.error('Attempted to read from sheet name:', sheetName);
            
            // Try to get all sheet names for debugging
            try {
              const metaResponse = await this.sheets.spreadsheets.get({
                spreadsheetId: this.spreadsheetId
              });
              
              const availableSheets = metaResponse.data.sheets
                ? metaResponse.data.sheets.map((s: any) => s.properties.title)
                : [];
              
              console.error('Available sheets:', availableSheets);
              console.error('Check for naming mismatches - expected sheet names with underscores.');
            } catch (metaError) {
              console.error('Failed to get sheet metadata:', metaError);
            }
          }
          
          throw apiError;
        }
      },
      ttl // Use the provided TTL
    );
  } catch (error) {
    console.error(`Error reading sheet ${range}:`, error);
    
    try {
      // Attempt to log the error, but don't throw if logging fails
      await this.logErrorDirectly({
        timestamp: new Date().toISOString(),
        eventType: 'SYSTEM_ERROR',
        description: `Failed to read sheet ${range}`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : JSON.stringify(error)
      });
    } catch (logError) {
      console.error('Failed to log error to audit log:', logError);
    }
    
    throw new Error(`Failed to read sheet ${range}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

  /**
   * Append rows to a Google Sheet
   */
  private async appendRows(range: string, values: any[][]) {
    try {
      console.log(`Appending rows to range: ${range}`);
      
      const response = await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: range, // Google's API will handle the encoding
        valueInputOption: 'RAW',
        requestBody: {
          values
        }
      });
      
      console.log(`Successfully appended rows to range: ${range}`);
      return response;
    } catch (error) {
      console.error(`Error appending to sheet ${range}:`, error);
      
      // If error is due to range parsing, log detailed information
      if (error && typeof error === 'object' && 'message' in error && 
          typeof error.message === 'string' && error.message.includes('Unable to parse range')) {
        console.error('This may be due to sheet name format mismatch. Check if sheet names have changed.');
        
        // Parse the range to extract sheet name for better error reporting
        const exclamationIndex = range.indexOf('!');
        if (exclamationIndex !== -1) {
          const sheetName = range.substring(0, exclamationIndex);
          console.error('Attempted to append to sheet name:', sheetName);
        }
      }
      
      throw error;
    }
  }

  /**
   * Direct error logging method as a fallback when addAuditLog fails
   * This bypasses the standard audit log mechanism which might be failing
   */
  private async logErrorDirectly(entry: AuditLogEntry): Promise<void> {
    try {
      const errorLogData = [
        [
          entry.timestamp,
          entry.eventType,
          entry.description,
          entry.user || 'SYSTEM',
          '', // previousValue
          '', // newValue
          entry.systemNotes || ''
        ]
      ];
      
      // Use direct API call instead of our appendRows method
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${SHEET_NAMES.AUDIT_LOG}!A:G`,
        valueInputOption: 'RAW',
        requestBody: {
          values: errorLogData
        }
      });
      
      console.log('Successfully logged error directly to audit log');
    } catch (directLogError) {
      // At this point we can't do much more than console log
      console.error('CRITICAL: Failed to log error directly to audit log:', directLogError);
      console.error('Original error entry:', entry);
    }
  }

  /**
   * Check if an appointment is scheduled for today
   */
  private isAppointmentForToday(appointment: AppointmentRecord): boolean {
    try {
      if (!appointment.startTime) return false;
      
      // Get today's date in EST
      const today = getTodayEST();
      const todayDate = new Date(today);
      todayDate.setHours(0, 0, 0, 0);
      
      // Get tomorrow's date (for comparison)
      const tomorrow = new Date(todayDate);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      // Parse appointment start time
      const appointmentDate = new Date(appointment.startTime);
      
      // Check if appointment is today
      return appointmentDate >= todayDate && appointmentDate < tomorrow;
    } catch (error) {
      console.warn(`Error checking if appointment is for today:`, error);
      return false;
    }
  }

  async getOffices(): Promise<SheetOffice[]> {
    const cacheKey = 'config:offices';
    
    // Check memory cache first for faster access
    const memoryCache = this.cache.getFromMemory<SheetOffice[]>(cacheKey);
    if (memoryCache) {
      console.log(`Retrieved ${memoryCache.length} offices from memory cache`);
      return memoryCache;
    }
    
    console.log(`Reading offices from ${SHEET_NAMES.OFFICES}!A2:M`);
    try {
      // Use longer TTL for configuration data (5 minutes)
      const values = await this.readSheet(`${SHEET_NAMES.OFFICES}!A2:M`, 300000);
      
      console.log(`Retrieved ${values?.length || 0} office records from sheet`);
      if (values?.length === 0) {
        console.warn('No office records found in sheet!');
      }
      
      const offices = values?.map((row: SheetRow) => {
        const office = {
          officeId: row[0],
          name: row[1],
          unit: row[2],
          inService: row[3] === 'TRUE',
          floor: row[4] as 'upstairs' | 'downstairs',
          isAccessible: row[5] === 'TRUE',
          size: row[6] as 'small' | 'medium' | 'large',
          ageGroups: row[7]?.split(',').map((s: string) => s.trim()) || [],
          specialFeatures: row[8]?.split(',').map((s: string) => s.trim()) || [],
          primaryClinician: row[9] || undefined,
          alternativeClinicians: row[10]?.split(',').map((s: string) => s.trim()) || [],
          isFlexSpace: row[11] === 'TRUE',
          notes: row[12]
        };
        
        return office;
      }) ?? [];
      
      // Store in memory cache for faster future access
      this.cache.setInMemory(cacheKey, offices);
      
      return offices;
    } catch (error) {
      console.error(`Error retrieving offices:`, error);
      return [];
    }
  }

  async getClinicians(): Promise<SheetClinician[]> {
    console.log(`Reading clinicians from ${SHEET_NAMES.CLINICIANS}!A2:M`);
    try {
      const values = await this.readSheet(`${SHEET_NAMES.CLINICIANS}!A2:M`);
      
      console.log(`Retrieved ${values?.length || 0} clinician records`);
      if (values?.length === 0) {
        console.warn('No clinician records found in sheet!');
      }
      
      return values?.map((row: SheetRow) => {
        const clinician = {
          clinicianId: row[0],
          name: row[1],
          email: row[2],
          role: row[3] as 'owner' | 'admin' | 'clinician' | 'intern',
          ageRangeMin: Number(row[4]),
          ageRangeMax: Number(row[5]),
          specialties: row[6]?.split(',').map((s: string) => s.trim()) || [],
          caseloadLimit: Number(row[7]),
          currentCaseload: Number(row[8]),
          preferredOffices: row[9]?.split(',').map((s: string) => s.trim()) || [],
          allowsRelationship: row[10] === 'TRUE',
          certifications: row[11]?.split(',').map((s: string) => s.trim()) || [],
          intakeQPractitionerId: row[12]
        };
        
        console.log(`Mapped clinician: ${clinician.clinicianId}, Name: ${clinician.name}, IntakeQ ID: ${clinician.intakeQPractitionerId}`);
        return clinician;
      }) ?? [];
    } catch (error) {
      console.error(`Error retrieving clinicians:`, error);
      return [];
    }
  }

  async getAssignmentRules(): Promise<AssignmentRule[]> {
    const values = await this.readSheet(`${SHEET_NAMES.ASSIGNMENT_RULES}!A2:H`);
    
    return values?.map((row: SheetRow) => ({
      priority: Number(row[0]),
      ruleName: row[1],
      ruleType: row[2],
      condition: row[3],
      officeIds: row[4]?.split(',').map((s: string) => s.trim()) || [],
      overrideLevel: row[5] as 'hard' | 'soft' | 'none',
      active: row[6] === 'TRUE',
      notes: row[7]
    })) ?? [];
  }

  async getClientPreferences(): Promise<ClientPreference[]> {
    try {
      console.log('Getting client preferences from Client_Accessibility_Info');
      
      // Get data from Client_Accessibility_Info sheet instead
      const accessibilityRecords = await this.getClientAccessibilityRecords();
      
      // Map to the expected ClientPreference format
      return accessibilityRecords.map(record => ({
        clientId: record.clientId,
        name: record.clientName,
        email: '', // Not available in accessibility info
        mobilityNeeds: record.hasMobilityNeeds ? [record.mobilityDetails] : [],
        sensoryPreferences: record.hasSensoryNeeds ? [record.sensoryDetails] : [],
        physicalNeeds: record.hasPhysicalNeeds ? [record.physicalDetails] : [],
        roomConsistency: record.roomConsistency || 3,
        supportNeeds: record.hasSupport ? [record.supportDetails] : [],
        specialFeatures: [], 
        additionalNotes: record.additionalNotes || '',
        lastUpdated: record.lastUpdated,
        preferredClinician: '', // Not available in accessibility info
        // Extract assigned office from additionalNotes or requiredOffice if present
        assignedOffice: this.extractAssignedOfficeFromNotes(record.additionalNotes, record.requiredOffice)
      }));
    } catch (error) {
      console.error('Error getting client preferences from accessibility info:', error);
      await this.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'SYSTEM_ERROR',
        description: 'Failed to get client preferences from accessibility info',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      return [];
    }
  }
  
  /**
   * Extract assigned office from notes and/or requiredOffice field
   * UPDATED: Now first checks requiredOffice before parsing notes
   */
  private extractAssignedOfficeFromNotes(notes: string, requiredOffice?: string): string {
    // First check for explicit requiredOffice field
    if (requiredOffice && requiredOffice.trim() !== '') {
      return requiredOffice.trim();
    }
    
    // Fall back to parsing from notes if field is not set
    if (!notes) return '';
    
    // Check for patterns like "Assigned Office: B-4" in notes
    const officeMatch = notes.match(/assigned\s+office:?\s*([A-C]-\d+|A-v)/i);
    if (officeMatch && officeMatch[1]) {
      return officeMatch[1];
    }
    
    return '';
  }
  

  async getScheduleConfig(): Promise<ScheduleConfig[]> {
    const values = await this.readSheet(`${SHEET_NAMES.SCHEDULE_CONFIG}!A2:E`);
    
    return values?.map((row: SheetRow) => ({
      settingName: row[0],
      value: row[1],
      description: row[2],
      lastUpdated: row[3],
      updatedBy: row[4]
    })) ?? [];
  }

  async getIntegrationSettings(): Promise<IntegrationSetting[]> {
    const values = await this.readSheet(`${SHEET_NAMES.INTEGRATION_SETTINGS}!A2:E`);
    
    return values?.map((row: SheetRow) => ({
      serviceName: row[0],
      settingType: row[1],
      value: row[2],
      description: row[3],
      lastUpdated: row[4]
    })) ?? [];
  }

  // Keep track of pending log entries to batch
private pendingAuditLogs: AuditLogEntry[] = [];
private readonly MAX_BATCH_SIZE = 10;
private auditLogTimer: NodeJS.Timeout | null = null;

/**
 * Add an audit log entry with batching to reduce API calls
 */
async addAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    // Add entry to pending logs
    this.pendingAuditLogs.push(entry);
    
    // If this is a critical error, process immediately
    if (entry.eventType === AuditEventType.CRITICAL_ERROR || 
        entry.eventType === AuditEventType.SYSTEM_ERROR) {
      await this.flushAuditLogs();
      return;
    }
    
    // If we have enough entries or timer isn't set, process the batch
    if (this.pendingAuditLogs.length >= this.MAX_BATCH_SIZE) {
      await this.flushAuditLogs();
    } else if (!this.auditLogTimer) {
      // Set timer to flush logs after a delay (5 seconds)
      this.auditLogTimer = setTimeout(() => this.flushAuditLogs(), 5000);
    }
  } catch (error) {
    console.error('Error adding audit log:', error);
    console.error('Failed audit log entry:', entry);
    
    // Try direct logging as a fallback
    try {
      await this.logErrorDirectly(entry);
    } catch (directLogError) {
      console.error('CRITICAL: Failed to log directly to audit log:', directLogError);
    }
  }
}

/**
 * Flush pending audit logs to the sheet
 */
private async flushAuditLogs(): Promise<void> {
  if (this.auditLogTimer) {
    clearTimeout(this.auditLogTimer);
    this.auditLogTimer = null;
  }
  
  if (this.pendingAuditLogs.length === 0) return;
  
  try {
    const logEntries = [...this.pendingAuditLogs];
    this.pendingAuditLogs = [];
    
    const rowsData = logEntries.map(entry => [
      entry.timestamp,
      entry.eventType,
      entry.description,
      entry.user,
      entry.previousValue || '',
      entry.newValue || '',
      entry.systemNotes || ''
    ]);

    await this.appendRows(`${SHEET_NAMES.AUDIT_LOG}!A:G`, rowsData);
    console.log(`Flushed ${logEntries.length} audit log entries`);
  } catch (error) {
    console.error('Error flushing audit logs:', error);
    
    // Retry with individual entries as fallback if batch fails
    for (const entry of this.pendingAuditLogs) {
      try {
        const rowData = [
          entry.timestamp,
          entry.eventType,
          entry.description,
          entry.user,
          entry.previousValue || '',
          entry.newValue || '',
          entry.systemNotes || ''
        ];
        
        await this.appendRows(`${SHEET_NAMES.AUDIT_LOG}!A:G`, [rowData]);
      } catch (individualError) {
        console.error('Failed to log individual entry:', individualError);
      }
    }
    
    // Clear pending logs regardless of success
    this.pendingAuditLogs = [];
  }
}

  private safeParseJSON(value: string | null | undefined, defaultValue: any = []): any {
    if (!value) return defaultValue;
    try {
      return JSON.parse(value);
    } catch (e) {
      console.warn(`Invalid JSON value: ${value}`);
      return defaultValue;
    }
  }

  async getRecentAuditLogs(limit: number = 5): Promise<AuditLogEntry[]> {
    try {
      const values = await this.readSheet(`${SHEET_NAMES.AUDIT_LOG}!A2:G`);
      
      if (!values) return [];
      
      return values
        .map((row: SheetRow) => ({
          timestamp: row[0],
          eventType: row[1],
          description: row[2],
          user: row[3],
          previousValue: row[4] || undefined,
          newValue: row[5] || undefined,
          systemNotes: row[6] || undefined
        }))
        .sort((a: AuditLogEntry, b: AuditLogEntry) => 
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )
        .slice(0, limit);
        
    } catch (error) {
      console.error('Error reading audit logs:', error);
      return [];
    }
  }
  
  /**
   * Get all appointments regardless of date range
   * Updated to handle both old and new field names
   */
  async getAllAppointments(): Promise<AppointmentRecord[]> {
    try {
      const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A2:R`);
      
      if (!values || !Array.isArray(values)) {
        console.log('No appointments found in sheet');
        return [];
      }

      console.log(`Processing all appointments from sheet: ${values.length} rows`);

      const mappedAppointments = values
        .map((row: SheetRow) => {
          try {
            // Map all base fields
            const appointment: Partial<AppointmentRecord> = {
              appointmentId: row[0] || '',
              clientId: row[1] || '',
              clientName: row[2] || row[1] || '',
              clientDateOfBirth: row[3] || '', // Add this line to capture DOB from column D
              clinicianId: row[4] || '',       // Update index: was 3, now 4
              clinicianName: row[5] || row[4] || '', // Update index: was 4, now 5
              sessionType: (row[7] || 'in-person') as 'in-person' | 'telehealth' | 'group' | 'family',
              startTime: row[8] || '',
              endTime: row[9] || '',
              status: (row[10] || 'scheduled') as 'scheduled' | 'completed' | 'cancelled' | 'rescheduled',
              source: (row[11] || 'manual') as 'intakeq' | 'manual',
              lastUpdated: row[12] || new Date().toISOString(),
              notes: row[14] || '',
              tags: row[17] ? row[17].split(',').map((tag: string) => tag.trim()) : []
            };
            
            // Handle requirements parsing
            try {
              const requirementsStr = row[13]?.toString().trim();
              if (requirementsStr) {
                // Check if the string starts with "Service:" - if so, it's not JSON
                if (requirementsStr.startsWith('Service:')) {
                  appointment.requirements = { accessibility: false, specialFeatures: [] };
                  // Move the service info to notes if it's in the wrong column
                  appointment.notes = requirementsStr;
                } else {
                  // Try to parse as JSON with error handling
                  try {
                    const cleanJson = requirementsStr
                      .replace(/[\u0000-\u0019]+/g, '')
                      .replace(/\s+/g, ' ')
                      .trim();
                    appointment.requirements = JSON.parse(cleanJson);
                  } catch (error) {
                    // Properly handle unknown error type
                    const jsonError = error instanceof Error ? error.message : 'Unknown JSON parsing error';
                    console.warn(`Error parsing requirements JSON, defaulting to empty: ${jsonError}`);
                    appointment.requirements = { accessibility: false, specialFeatures: [] };
                  }
                }
              } else {
                appointment.requirements = { accessibility: false, specialFeatures: [] };
              }
            } catch (err) {
              console.error('Error parsing requirements JSON:', err, {value: row[13]});
              appointment.requirements = { accessibility: false, specialFeatures: [] };
            }
            
            // Handle office IDs - NEW FIELD NAMES
            // Column 6 (index 6) = currentOfficeId (previously officeId)
            // Column 15 (index 15) = assignedOfficeId (previously suggestedOfficeId)
            // Column 16 (index 16) = assignmentReason

            // Set currentOfficeId (formerly officeId)
            if (row[6]) {
              appointment.currentOfficeId = standardizeOfficeId(row[6]);
              // Set officeId too for backward compatibility
              appointment.officeId = appointment.currentOfficeId;
            }
            
            // Set assignedOfficeId (formerly suggestedOfficeId)
            if (row[15]) {
              appointment.assignedOfficeId = standardizeOfficeId(row[15]);
              // Set suggestedOfficeId too for backward compatibility
              appointment.suggestedOfficeId = appointment.assignedOfficeId;
            }
            
            // Set assignmentReason if available
            if (row[16]) {
              appointment.assignmentReason = row[16];
            }
            
            // Normalize the record to ensure consistent fields
            return normalizeAppointmentRecord(appointment);
          } catch (error) {
            console.error('Error mapping appointment row:', error, { row });
            return null;
          }
        })
        .filter((appt): appt is AppointmentRecord => appt !== null);

      console.log(`Successfully mapped ${mappedAppointments.length} appointments`);
      return mappedAppointments;
      
    } catch (error) {
      console.error('Error reading all appointments:', error);
      throw new Error('Failed to read all appointments');
    }
  }

  /**
  * Get active appointments for today from the Active_Appointments tab
  */
  async getActiveAppointments(): Promise<AppointmentRecord[]> {
    try {
      console.log('Reading active appointments from Active_Appointments sheet');
      
      // Check if the Active_Appointments sheet exists
      let sheetExists = true;
      try {
        // Try to read one cell to check if sheet exists
        await this.readSheet(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A1`);
      } catch (error) {
        console.warn('Active_Appointments sheet not found, falling back to Appointments sheet');
        sheetExists = false;
      }
      
      // If sheet doesn't exist, fall back to appointments for today
      if (!sheetExists) {
        const today = getTodayEST();
        console.log(`Falling back to appointments for today (${today})`);
        const { start, end } = getESTDayRange(today);
        return this.getAppointments(start, end);
      }
      
      // Read from Active_Appointments sheet
      const values = await this.readSheet(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A2:R`);
      
      if (!values || !Array.isArray(values)) {
        console.log('No active appointments found in sheet');
        return [];
      }

      console.log(`Retrieved ${values.length} active appointments`);

      const mappedAppointments = values
        .map((row: SheetRow) => {
          try {
            // Map all base fields - uses the same mapping logic as getAllAppointments
            const appointment: Partial<AppointmentRecord> = {
              appointmentId: row[0] || '',
              clientId: row[1] || '',
              clientName: row[2] || row[1] || '',
              clientDateOfBirth: row[3] || '',
              clinicianId: row[4] || '',
              clinicianName: row[5] || row[4] || '',
              sessionType: (row[7] || 'in-person') as 'in-person' | 'telehealth' | 'group' | 'family',
              startTime: row[8] || '',
              endTime: row[9] || '',
              status: (row[10] || 'scheduled') as 'scheduled' | 'completed' | 'cancelled' | 'rescheduled',
              source: (row[11] || 'manual') as 'intakeq' | 'manual',
              lastUpdated: row[12] || new Date().toISOString(),
              notes: row[14] || ''
            };
            
            // Handle requirements parsing with the same logic as other appointment methods
            try {
              const requirementsStr = row[13]?.toString().trim();
              if (requirementsStr) {
                if (requirementsStr.startsWith('Service:')) {
                  appointment.requirements = { accessibility: false, specialFeatures: [] };
                  appointment.notes = (appointment.notes ? appointment.notes + ' ' : '') + requirementsStr;
                } else {
                  try {
                    const cleanJson = requirementsStr
                      .replace(/[\u0000-\u0019]+/g, '')
                      .replace(/\s+/g, ' ')
                      .trim();
                    appointment.requirements = JSON.parse(cleanJson);
                  } catch (parseError) {
                    console.warn(`Error parsing requirements JSON, defaulting to empty:`, parseError);
                    appointment.requirements = { accessibility: false, specialFeatures: [] };
                  }
                }
              } else {
                appointment.requirements = { accessibility: false, specialFeatures: [] };
              }
            } catch (requirementsError) {
              console.error('Error processing requirements JSON:', requirementsError, {value: row[13]});
              appointment.requirements = { accessibility: false, specialFeatures: [] };
            }
            
            // Handle office IDs with the same logic as other appointment methods
            if (row[6]) {
              appointment.currentOfficeId = standardizeOfficeId(row[6]);
              appointment.officeId = appointment.currentOfficeId; // For backward compatibility
            }
            
            if (row[15]) {
              appointment.assignedOfficeId = standardizeOfficeId(row[15]);
              appointment.suggestedOfficeId = appointment.assignedOfficeId; // For backward compatibility
            }
            
            if (row[16]) {
              appointment.assignmentReason = row[16];
            }
            
            // Handle tags (column R)
            if (row[17]) {
              appointment.tags = row[17].split(',').map((tag: string) => tag.trim());
            }
            
            // Normalize the record to ensure consistent fields
            return normalizeAppointmentRecord(appointment);
          } catch (error) {
            console.error('Error mapping active appointment row:', error, { row });
            return null;
          }
        })
        .filter((appt): appt is AppointmentRecord => appt !== null);

      console.log(`Successfully mapped ${mappedAppointments.length} active appointments`);
      return mappedAppointments;
      
    } catch (error) {
      console.error('Error reading active appointments:', error);
      
      await this.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Failed to read active appointments',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Fall back to appointments for today
      const today = getTodayEST();
      console.log(`Falling back to appointments for today (${today}) after error`);
      const { start, end } = getESTDayRange(today);
      return this.getAppointments(start, end);
    }
  }

/**
 * Get appointments for a specific date range - Updated with robust error handling
 * and corrected column indexing
 */
async getAppointments(startDate: string, endDate: string): Promise<AppointmentRecord[]> {
  try {
    const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A2:R`);
    
    if (!values || !Array.isArray(values)) {
      console.log('No appointments found in sheet');
      return [];
    }

    // Parse the target date for better comparison
    const startDateObj = new Date(startDate);
    const targetDateStr = startDateObj.toISOString().split('T')[0];
    
    console.log('Processing appointments from sheet:', {
      rowCount: values.length,
      targetDate: targetDateStr,
      dateRange: { startDate, endDate }
    });

    const initialAppointments = values
      .map((row: SheetRow) => {
        try {
          // Map all base fields - CORRECTED column indexing
          const appointment: Partial<AppointmentRecord> = {
            appointmentId: row[0] || '',                                   // Column A: appointmentId
            clientId: row[1] || '',                                        // Column B: clientId
            clientName: row[2] || row[1] || '',                            // Column C: clientName
            clientDateOfBirth: row[3] || '',                               // Column D: clientDateOfBirth
            clinicianId: row[4] || '',                                     // Column E: clinicianId
            clinicianName: row[5] || row[4] || '',                         // Column F: clinicianName
            sessionType: (row[7] || 'in-person') as 'in-person' | 'telehealth' | 'group' | 'family', // Column H: sessionType
            startTime: row[8] || '',                                       // Column I: startTime
            endTime: row[9] || '',                                         // Column J: endTime
            status: (row[10] || 'scheduled') as 'scheduled' | 'completed' | 'cancelled' | 'rescheduled', // Column K: status
            source: (row[11] || 'manual') as 'intakeq' | 'manual',         // Column L: source (CORRECTED)
            lastUpdated: row[12] || new Date().toISOString(),              // Column M: lastUpdated (CORRECTED)
            notes: row[14] || ''                                           // Column O: notes
          };
          
          // Handle requirements parsing with robust error handling
          try {
            const requirementsStr = row[13]?.toString().trim();
            if (requirementsStr) {
              // Check if the string starts with "Service:" - if so, it's not JSON
              if (requirementsStr.startsWith('Service:')) {
                appointment.requirements = { accessibility: false, specialFeatures: [] };
                // Move the service info to notes if it's in the wrong column
                appointment.notes = (appointment.notes ? appointment.notes + ' ' : '') + requirementsStr;
              } else {
                // Try to parse as JSON with error handling
                try {
                  const cleanJson = requirementsStr
                    .replace(/[\u0000-\u0019]+/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                  appointment.requirements = JSON.parse(cleanJson);
                } catch (parseError) {
                  console.warn(`Error parsing requirements JSON, defaulting to empty:`, parseError);
                  appointment.requirements = { accessibility: false, specialFeatures: [] };
                }
              }
            } else {
              appointment.requirements = { accessibility: false, specialFeatures: [] };
            }
          } catch (requirementsError) {
            console.error('Error processing requirements JSON:', requirementsError, {value: row[13]});
            appointment.requirements = { accessibility: false, specialFeatures: [] };
          }
          
          // Handle office IDs with CORRECTED indexing
          // Column 6 (index 6) = currentOfficeId
          // Column 15 (index 15) = assignedOfficeId
          // Column 16 (index 16) = assignmentReason

          // Set currentOfficeId (formerly officeId)
          if (row[6]) {
            appointment.currentOfficeId = standardizeOfficeId(row[6]);
            appointment.officeId = appointment.currentOfficeId; // For backward compatibility
          }
          
          // Set assignedOfficeId (formerly suggestedOfficeId)
          if (row[15]) {
            appointment.assignedOfficeId = standardizeOfficeId(row[15]);
            appointment.suggestedOfficeId = appointment.assignedOfficeId; // For backward compatibility
          }
          
          // Set assignmentReason if available
          if (row[16]) {
            appointment.assignmentReason = row[16];
          }

          // Set tags if available (Column R)
          if (row[17]) {
            appointment.tags = row[17].split(',').map((tag: string) => tag.trim());
          }
          
          // Normalize the record to ensure consistent fields
          return normalizeAppointmentRecord(appointment);
        } catch (error) {
          console.error('Error mapping appointment row:', error, { row });
          return null;
        }
      })
      .filter((appt): appt is AppointmentRecord => appt !== null);

    // Filter by the target date
    const mappedAppointments = initialAppointments.filter(appt => {
      try {
        if (!appt.startTime) {
          console.warn(`Appointment ${appt.appointmentId} has no start time, skipping`);
          return false;
        }
        
        // Extract just the date part (YYYY-MM-DD) for comparison
        const apptDate = new Date(appt.startTime);
        const apptDateStr = apptDate.toISOString().split('T')[0];
        const matches = apptDateStr === targetDateStr;
        
        return matches;
      } catch (error) {
        console.error(`Error filtering appointment ${appt.appointmentId}:`, error);
        return false;
      }
    });

    console.log('Appointment processing complete:', {
      totalFound: mappedAppointments.length,
      targetDate: targetDateStr
    });

    return mappedAppointments;
  } catch (error) {
    console.error('Error reading appointments:', error);
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: 'Failed to read appointments',
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    throw new Error('Failed to read appointments');
  }
}

/**
 * Get appointments for a specific office and date
 */
async getOfficeAppointments(officeId: string, date: string): Promise<AppointmentRecord[]> {
  try {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
  
    // Check if it's today's date - use Active_Appointments if possible
    const isToday = date === getTodayEST();
    let appointments;
    
    if (isToday) {
      console.log(`Getting today's office appointments from Active_Appointments`);
      appointments = await this.getActiveAppointments();
    } else {
      appointments = await this.getAppointments(
        startOfDay.toISOString(),
        endOfDay.toISOString()
      );
    }
  
    if (officeId === 'all') {
      return appointments;
    }
  
    const standardizedTargetId = standardizeOfficeId(officeId);
    
    // Updated to check both currentOfficeId and assignedOfficeId
    return appointments.filter(appt => {
      const appointmentOfficeId = standardizeOfficeId(
        appt.assignedOfficeId || appt.currentOfficeId || appt.officeId || 'TBD'
      );
      return appointmentOfficeId === standardizedTargetId;
    });
  } catch (error) {
    console.error(`Error getting office appointments for ${officeId} on ${date}:`, error);
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: `Failed to get appointments for office ${officeId} on ${date}`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    return [];
  }
}

/**
 * Add an appointment to both Appointments and Active_Appointments tabs if for today
 */
async addAppointment(appt: AppointmentRecord): Promise<void> {
  // Call enhanced method and throw error if it fails
  const result = await this.addAppointmentWithVerification(appt);
  
  if (!result.success) {
    throw new Error(`Failed to add appointment: ${result.error}`);
  }
}

/**
 * Update an appointment in both Appointments and Active_Appointments tabs
 * Enhanced with transaction-like semantics and retry logic for rate limits
 */
async updateAppointment(appointment: AppointmentRecord): Promise<void> {
  // Keep a copy of the original appointment for potential rollback
  let originalAppointment: AppointmentRecord | null = null;
  
  // Add retry logic variables
  const maxRetries = 5;
  let retryCount = 0;
  let success = false;
  
  while (!success && retryCount <= maxRetries) {
    try {
      // Normalize to ensure we have all required fields
      const normalizedAppointment = normalizeAppointmentRecord(appointment);
      
      // Fetch the original appointment for potential rollback
      if (!originalAppointment) {
        try {
          originalAppointment = await this.getAppointment(normalizedAppointment.appointmentId);
        } catch (fetchError) {
          console.warn(`Could not fetch original appointment for potential rollback: ${fetchError}`);
          // Continue without rollback capability
        }
      }
      
      // Execute as transaction
      await this.executeTransaction(
        async () => {
          // Ensure both old and new field values are set
          const currentOfficeId = standardizeOfficeId(
            normalizedAppointment.currentOfficeId || normalizedAppointment.officeId || 'TBD'
          );
          
          const assignedOfficeId = standardizeOfficeId(
            normalizedAppointment.assignedOfficeId || normalizedAppointment.suggestedOfficeId || currentOfficeId || 'TBD'
          );

          // Prepare requirements JSON with error handling
          let requirementsJson = '{"accessibility":false,"specialFeatures":[]}';
          try {
            if (normalizedAppointment.requirements) {
              requirementsJson = JSON.stringify(normalizedAppointment.requirements);
            }
          } catch (jsonError) {
            console.error('Error stringifying requirements, using default:', jsonError);
          }

          // Format tags as comma-separated string
          const tagsString = normalizedAppointment.tags && normalizedAppointment.tags.length > 0 ? 
            normalizedAppointment.tags.join(',') : '';

          // Prepare row data - CORRECTED column ordering matching sheet structure
          const rowData = [
            normalizedAppointment.appointmentId,                     // Column A: appointmentId
            normalizedAppointment.clientId,                          // Column B: clientId
            normalizedAppointment.clientName,                        // Column C: clientName
            normalizedAppointment.clientDateOfBirth || '',           // Column D: clientDateOfBirth
            normalizedAppointment.clinicianId,                       // Column E: clinicianId
            normalizedAppointment.clinicianName,                     // Column F: clinicianName
            currentOfficeId,                                         // Column G: currentOfficeId
            normalizedAppointment.sessionType,                       // Column H: sessionType
            normalizedAppointment.startTime,                         // Column I: startTime
            normalizedAppointment.endTime,                           // Column J: endTime
            normalizedAppointment.status,                            // Column K: status
            normalizedAppointment.source,                            // Column L: source
            normalizedAppointment.lastUpdated || new Date().toISOString(), // Column M: lastUpdated
            requirementsJson,                                        // Column N: requirements
            normalizedAppointment.notes || '',                       // Column O: notes
            assignedOfficeId,                                        // Column P: assignedOfficeId
            normalizedAppointment.assignmentReason || '',            // Column Q: assignmentReason
            tagsString                                               // Column R: tags
          ];

          // 1. First update in the main Appointments sheet
          // Find the appointment row
          const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A:A`);
          const appointmentRow = values?.findIndex((row: SheetRow) => row[0] === normalizedAppointment.appointmentId);

          if (!values || appointmentRow === undefined || appointmentRow < 0) {
            throw new Error(`Appointment ${normalizedAppointment.appointmentId} not found in main Appointments sheet`);
          }

          await this.sheets.spreadsheets.values.update({
            spreadsheetId: this.spreadsheetId,
            range: `${SHEET_NAMES.APPOINTMENTS}!A${appointmentRow + 2}:R${appointmentRow + 2}`,
            valueInputOption: 'RAW',
            requestBody: {
              values: [rowData]
            }
          });

          // 2. Try to update in Active_Appointments sheet if it exists and if the appointment is for today
          try {
            // Check if Active_Appointments sheet exists
            const activeValues = await this.readSheet(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A:A`);
            const activeAppointmentRow = activeValues?.findIndex((row: SheetRow) => row[0] === normalizedAppointment.appointmentId);
            
            // Check if the appointment is for today
            const isForToday = this.isAppointmentForToday(normalizedAppointment);
            
            if (isForToday) {
              if (activeValues && activeAppointmentRow !== undefined && activeAppointmentRow >= 0) {
                // Update existing row in Active_Appointments
                await this.sheets.spreadsheets.values.update({
                  spreadsheetId: this.spreadsheetId,
                  range: `${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A${activeAppointmentRow + 2}:R${activeAppointmentRow + 2}`,
                  valueInputOption: 'RAW',
                  requestBody: {
                    values: [rowData]
                  }
                });
                console.log(`Updated appointment ${normalizedAppointment.appointmentId} in Active_Appointments at row ${activeAppointmentRow + 2}`);
              } else if (activeValues) {
                // Add new row to Active_Appointments
                await this.appendRows(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A:R`, [rowData]);
                console.log(`Added appointment ${normalizedAppointment.appointmentId} to Active_Appointments`);
              }
            } else if (activeValues && activeAppointmentRow !== undefined && activeAppointmentRow >= 0) {
              // Remove from Active_Appointments if it's not for today and is present
              try {
                // Get spreadsheet metadata to find correct sheet ID
                const spreadsheet = await this.sheets.spreadsheets.get({
                  spreadsheetId: this.spreadsheetId
                });
                
                // Find the Active_Appointments sheet
                const activeSheet = spreadsheet.data.sheets?.find(
                  sheet => sheet.properties?.title === SHEET_NAMES.ACTIVE_APPOINTMENTS
                );
                
                if (activeSheet && activeSheet.properties?.sheetId !== undefined) {
                  // Delete the row
                  await this.sheets.spreadsheets.batchUpdate({
                    spreadsheetId: this.spreadsheetId,
                    requestBody: {
                      requests: [{
                        deleteDimension: {
                          range: {
                            sheetId: activeSheet.properties.sheetId,
                            dimension: 'ROWS',
                            startIndex: activeAppointmentRow + 1, // +1 for header
                            endIndex: activeAppointmentRow + 2    // +1 for exclusive range
                          }
                        }
                      }]
                    }
                  });
                  console.log(`Removed appointment ${normalizedAppointment.appointmentId} from Active_Appointments as it's not for today`);
                }
              } catch (deleteError) {
                console.warn(`Could not delete row from Active_Appointments:`, deleteError);
              }
            }
          } catch (activeSheetError) {
            // Active_Appointments sheet might not exist yet, or other error occurred
            console.warn(`Error working with Active_Appointments sheet:`, activeSheetError);
          }
          
          // Return true for successful operation (for transaction)
          return true;
        },
        async () => {
          // Rollback logic - restore original appointment if available
          if (originalAppointment) {
            console.log(`Rolling back appointment update for ${appointment.appointmentId}`);
            
            // Ensure original appointment has all required fields
            const normalizedOriginal = normalizeAppointmentRecord(originalAppointment);
            
            // Prepare row data from original appointment
            const currentOfficeId = standardizeOfficeId(
              normalizedOriginal.currentOfficeId || normalizedOriginal.officeId || 'TBD'
            );
            
            const assignedOfficeId = standardizeOfficeId(
              normalizedOriginal.assignedOfficeId || normalizedOriginal.suggestedOfficeId || currentOfficeId || 'TBD'
            );
            
            // Prepare requirements JSON
            let requirementsJson = '{"accessibility":false,"specialFeatures":[]}';
            try {
              if (normalizedOriginal.requirements) {
                requirementsJson = JSON.stringify(normalizedOriginal.requirements);
              }
            } catch (jsonError) {
              console.error('Error stringifying requirements during rollback, using default:', jsonError);
            }
            
            // Format tags
            const tagsString = normalizedOriginal.tags && normalizedOriginal.tags.length > 0 ? 
              normalizedOriginal.tags.join(',') : '';
            
            // Create row data for rollback
            const rollbackRowData = [
              normalizedOriginal.appointmentId,
              normalizedOriginal.clientId,
              normalizedOriginal.clientName,
              normalizedOriginal.clientDateOfBirth || '',
              normalizedOriginal.clinicianId,
              normalizedOriginal.clinicianName,
              currentOfficeId,
              normalizedOriginal.sessionType,
              normalizedOriginal.startTime,
              normalizedOriginal.endTime,
              normalizedOriginal.status,
              normalizedOriginal.source,
              new Date().toISOString(), // Updated timestamp for rollback
              requirementsJson,
              (normalizedOriginal.notes || '') + '\n[ROLLBACK: Transaction failed]',
              assignedOfficeId,
              normalizedOriginal.assignmentReason || '',
              tagsString
            ];
            
            // Find the appointment row
            const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A:A`);
            const appointmentRow = values?.findIndex((row: SheetRow) => row[0] === normalizedOriginal.appointmentId);
            
            if (values && appointmentRow !== undefined && appointmentRow >= 0) {
              // Update with original data
              await this.sheets.spreadsheets.values.update({
                spreadsheetId: this.spreadsheetId,
                range: `${SHEET_NAMES.APPOINTMENTS}!A${appointmentRow + 2}:R${appointmentRow + 2}`,
                valueInputOption: 'RAW',
                requestBody: {
                  values: [rollbackRowData]
                }
              });
              
              console.log(`Successfully rolled back appointment ${normalizedOriginal.appointmentId}`);
            }
          }
        },
        `Update appointment ${normalizedAppointment.appointmentId}`
      );

      await this.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.APPOINTMENT_UPDATED,
        description: `Updated appointment ${appointment.appointmentId}`,
        user: 'SYSTEM',
        previousValue: originalAppointment ? JSON.stringify(originalAppointment) : '',
        newValue: JSON.stringify(normalizedAppointment)
      });

      // Clear cache for both sheets
      await this.refreshCache(`${SHEET_NAMES.APPOINTMENTS}!A2:R`);
      await this.refreshCache(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A2:R`);
      
      // Mark success to exit the retry loop
      success = true;
      
    } catch (error) {
      // Check if it's a rate limit error
      const isRateLimit = error && 
        typeof error === 'object' && 
        'message' in error && 
        typeof error.message === 'string' && 
        error.message.includes('Quota exceeded');
      
      retryCount++;
      
      if (isRateLimit && retryCount <= maxRetries) {
        // Calculate exponential backoff delay with increasing base time
        // Starting with 2 seconds, then 4, 8, 16, 32 seconds
        const delay = Math.pow(2, retryCount) * 1000;
        console.warn(`Rate limit hit when updating appointment ${appointment.appointmentId}. Retrying in ${delay}ms (attempt ${retryCount}/${maxRetries})`);
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // For non-rate limit errors or if we've exceeded retries, log and throw
        console.error(`Error updating appointment ${appointment.appointmentId}:`, error);
        await this.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: AuditEventType.SYSTEM_ERROR,
          description: `Failed to update appointment ${appointment.appointmentId}`,
          user: 'SYSTEM',
          systemNotes: error instanceof Error ? error.message : 'Unknown error'
        });
        throw new Error(`Failed to update appointment: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }
}

/**
 * Update appointment in Active_Appointments tab only, leaving the main Appointments tab untouched
 * Used specifically for daily schedule generation
 */
async updateActiveAppointmentOnly(appointment: AppointmentRecord): Promise<void> {
  try {
    // Normalize to ensure we have all required fields
    const normalizedAppointment = normalizeAppointmentRecord(appointment);
    
    // Ensure both old and new field values are set
    const currentOfficeId = standardizeOfficeId(
      normalizedAppointment.currentOfficeId || normalizedAppointment.officeId || 'TBD'
    );
    
    const assignedOfficeId = standardizeOfficeId(
      normalizedAppointment.assignedOfficeId || normalizedAppointment.suggestedOfficeId || currentOfficeId || 'TBD'
    );

    // Prepare requirements JSON with error handling
    let requirementsJson = '{"accessibility":false,"specialFeatures":[]}';
    try {
      if (normalizedAppointment.requirements) {
        requirementsJson = JSON.stringify(normalizedAppointment.requirements);
      }
    } catch (jsonError) {
      console.error('Error stringifying requirements, using default:', jsonError);
    }

    // Format tags as comma-separated string
    const tagsString = normalizedAppointment.tags && normalizedAppointment.tags.length > 0 ? 
      normalizedAppointment.tags.join(',') : '';

    // Prepare row data
    const rowData = [
      normalizedAppointment.appointmentId,
      normalizedAppointment.clientId,
      normalizedAppointment.clientName,
      normalizedAppointment.clientDateOfBirth || '',
      normalizedAppointment.clinicianId,
      normalizedAppointment.clinicianName,
      currentOfficeId,
      normalizedAppointment.sessionType,
      normalizedAppointment.startTime,
      normalizedAppointment.endTime,
      normalizedAppointment.status,
      normalizedAppointment.source,
      normalizedAppointment.lastUpdated || new Date().toISOString(),
      requirementsJson,
      normalizedAppointment.notes || '',
      assignedOfficeId,
      normalizedAppointment.assignmentReason || '',
      tagsString
    ];

    // Check if Active_Appointments sheet exists
    let activeSheetExists = true;
    try {
      await this.readSheet(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A1`);
    } catch (error) {
      activeSheetExists = false;
      console.warn('Active_Appointments sheet not found, skipping update');
      return;
    }
    
    if (!activeSheetExists) return;
    
    // Check if appointment exists in Active_Appointments and get its row index
    console.log(`Looking for appointment ${normalizedAppointment.appointmentId} in Active_Appointments`);
    const activeValues = await this.readSheet(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A:A`);
    
    if (!activeValues) {
      console.warn('Failed to read Active_Appointments sheet');
      return;
    }
    
    console.log(`Found ${activeValues.length} rows in Active_Appointments`);
    let foundMatch = false;
    let activeAppointmentRow = -1;
    
    // Log all appointment IDs for debugging
    activeValues.forEach((row, index) => {
      if (row && row[0] === normalizedAppointment.appointmentId) {
        console.log(`Match found at row ${index + 2}`);
        foundMatch = true;
        activeAppointmentRow = index;
      }
    });
    
    if (foundMatch && activeAppointmentRow >= 0) {
      // Update existing row in Active_Appointments
      console.log(`Updating existing row ${activeAppointmentRow + 2} in Active_Appointments`);
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A${activeAppointmentRow + 2}:R${activeAppointmentRow + 2}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [rowData]
        }
      });
    } else {
      // Add new row to Active_Appointments
      console.log(`Adding new row for appointment ${normalizedAppointment.appointmentId} to Active_Appointments`);
      await this.appendRows(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A:R`, [rowData]);
    }

    // Log audit entry
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.APPOINTMENT_UPDATED,
      description: `Updated appointment ${appointment.appointmentId} in Active_Appointments only`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        appointmentId: normalizedAppointment.appointmentId,
        operation: 'update_active_only'
      })
    });
  } catch (error) {
    console.error(`Error updating appointment ${appointment.appointmentId} in Active_Appointments:`, error);
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: `Failed to update appointment ${appointment.appointmentId} in Active_Appointments`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    throw error;
  }
}

/**
 * Delete an appointment by ID with enhanced reliability
 * Includes multiple lookup strategies, retries, and fallbacks
 */
async deleteAppointment(appointmentId: string): Promise<void> {
  try {
    console.log(`Starting deletion process for appointment ${appointmentId}`);
    
    // Strategy 1: Try finding the appointment row with cache refresh (up to 3 attempts)
    let rowIndex = -1;
    let existingAppointment = null;
    
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Forcefully refresh the cache before searching
        this.cache.invalidate(`sheet:${SHEET_NAMES.APPOINTMENTS}!A:A`);
        
        // Read the full sheet data to get appointment details if found
        const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A2:R`, 0); // TTL=0 forces fresh read
        
        // Look for the appointment in the full data
        const appointmentRow = values.findIndex(row => row[0] === appointmentId);
        if (appointmentRow >= 0) {
          rowIndex = appointmentRow;
          existingAppointment = this.mapAppointmentRow(values[appointmentRow]);
          console.log(`Found appointment ${appointmentId} at row index ${rowIndex} (Row ${rowIndex + 2} in sheet)`);
          break;
        }
        
        if (attempt < 2) {
          console.log(`Appointment ${appointmentId} not found on attempt ${attempt + 1}, retrying after delay...`);
          await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt))); // Exponential backoff
        }
      } catch (searchError) {
        console.warn(`Error searching for appointment ${appointmentId} on attempt ${attempt + 1}:`, searchError);
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt))); // Exponential backoff
        }
      }
    }
    
    // If we still haven't found the appointment, try one last lookup by ID only
    if (rowIndex < 0) {
      try {
        const idOnlyValues = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A:A`, 0); // TTL=0 forces fresh read
        const idOnlyRowIndex = idOnlyValues.findIndex(row => row[0] === appointmentId);
        
        if (idOnlyRowIndex >= 0) {
          rowIndex = idOnlyRowIndex;
          console.log(`Found appointment ${appointmentId} using ID-only lookup at row ${rowIndex + 2}`);
        } else {
          console.error(`Appointment ${appointmentId} not found for deletion after multiple attempts`);
          
          // Strategy 2: If we still can't find it, try to get the appointment first to update if possible
          if (!existingAppointment) {
            try {
              existingAppointment = await this.getAppointment(appointmentId);
            } catch (getError) {
              console.warn(`Error getting appointment ${appointmentId} details:`, getError);
            }
          }
          
          // If we found appointment details but couldn't find the row, try status update fallback
          if (existingAppointment) {
            await this.updateAppointmentStatus(appointmentId, 'cancelled', {
              reason: 'Deletion failed, marked as cancelled instead',
              notes: `\nCancelled via fallback method: ${new Date().toISOString()}`
            });
            return; // Return void as required by method signature
          }
          
          throw new Error(`Appointment ${appointmentId} not found for deletion`);
        }
      } catch (finalSearchError) {
        console.error(`Final ID-only search failed for appointment ${appointmentId}:`, finalSearchError);
        throw new Error(`Appointment ${appointmentId} not found for deletion`);
      }
    }
    
    // Get spreadsheet metadata to find correct sheet ID
    console.log(`Retrieving sheet metadata for spreadsheet ID: ${this.spreadsheetId}`);
    const spreadsheet = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId
    });
    
    // Find the Appointments sheet
    const appointmentsSheet = spreadsheet.data.sheets?.find(
      sheet => sheet.properties?.title === SHEET_NAMES.APPOINTMENTS
    );
    
    if (!appointmentsSheet || appointmentsSheet.properties?.sheetId === undefined) {
      console.error(`Could not find sheet ID for ${SHEET_NAMES.APPOINTMENTS}, attempting fallback method`);
      
      // Fallback: try to update appointment status to cancelled instead
      if (existingAppointment) {
        await this.updateAppointmentStatus(appointmentId, 'cancelled', {
          reason: 'Deletion failed, marked as cancelled instead',
          notes: `\nCancelled via fallback method: ${new Date().toISOString()}`
        });
        return; // Return void as required by method signature
      }
      
      // Try clearing the cell content as last resort
      try {
        console.log(`Fallback: Clearing row ${rowIndex + 2} content instead of deleting the row`);
        await this.sheets.spreadsheets.values.clear({
          spreadsheetId: this.spreadsheetId,
          range: `${SHEET_NAMES.APPOINTMENTS}!A${rowIndex + 2}:R${rowIndex + 2}`
        });
        
        console.log(`Row cleared successfully via fallback method`);
      } catch (clearError) {
        console.error(`Even clearing row content failed:`, clearError);
        throw new Error(`Failed to delete appointment: Could not find sheet ID and all fallbacks failed`);
      }
    } else {
      // Use the found sheet ID
      const sheetId = appointmentsSheet.properties.sheetId;
      
      console.log(`Found Appointments sheet with ID ${sheetId}, deleting row at index ${rowIndex + 2}`);
      
      // Delete from main Appointments sheet
      try {
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: [{
              deleteDimension: {
                range: {
                  sheetId: sheetId,
                  dimension: 'ROWS',
                  startIndex: rowIndex + 1, // +1 for header
                  endIndex: rowIndex + 2    // +1 for exclusive range
                }
              }
            }]
          }
        });
        
        console.log(`Successfully deleted appointment ${appointmentId} from main Appointments tab`);
      } catch (deleteError) {
        console.error(`Error deleting row for appointment ${appointmentId}:`, deleteError);
        
        // If row deletion fails, try clearing the content instead
        try {
          console.log(`Fallback after delete error: Clearing row ${rowIndex + 2} content`);
          await this.sheets.spreadsheets.values.clear({
            spreadsheetId: this.spreadsheetId,
            range: `${SHEET_NAMES.APPOINTMENTS}!A${rowIndex + 2}:R${rowIndex + 2}`
          });
          
          console.log(`Row cleared successfully via fallback method`);
        } catch (clearError) {
          console.error(`Even clearing row content failed:`, clearError);
          
          // Last resort: If we have the appointment details, update status to cancelled
          if (existingAppointment) {
            await this.updateAppointmentStatus(appointmentId, 'cancelled', {
              reason: 'Deletion failed, marked as cancelled instead',
              notes: `\nCancelled via fallback method: ${new Date().toISOString()}`
            });
            return; // Return void as required by method signature
          }
          
          throw new Error(`Failed to delete appointment: All deletion methods failed`);
        }
      }
    }
    
    // 2. Also try to delete from Active_Appointments if it exists
    try {
      // Check if Active_Appointments exists
      let activeSheetExists = true;
      try {
        await this.readSheet(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A1`);
      } catch (error) {
        activeSheetExists = false;
      }
      
      if (activeSheetExists) {
        // Find row in Active_Appointments tab
        const activeValues = await this.readSheet(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A:A`, 0); // TTL=0 forces fresh read
        const activeRowIndex = activeValues?.findIndex(row => row[0] === appointmentId);
        
        if (activeRowIndex !== undefined && activeRowIndex >= 0) {
          console.log(`Found appointment ${appointmentId} in Active_Appointments at row ${activeRowIndex + 2}`);
          
          // Find the Active_Appointments sheet ID
          const activeSheet = spreadsheet.data.sheets?.find(
            sheet => sheet.properties?.title === SHEET_NAMES.ACTIVE_APPOINTMENTS
          );
          
          if (activeSheet && activeSheet.properties?.sheetId !== undefined) {
            // Delete from Active_Appointments sheet
            try {
              await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId: this.spreadsheetId,
                requestBody: {
                  requests: [{
                    deleteDimension: {
                      range: {
                        sheetId: activeSheet.properties.sheetId,
                        dimension: 'ROWS',
                        startIndex: activeRowIndex + 1, // +1 for header
                        endIndex: activeRowIndex + 2    // +1 for exclusive range
                      }
                    }
                  }]
                }
              });
              
              console.log(`Successfully deleted appointment ${appointmentId} from Active_Appointments tab`);
            } catch (deleteActiveError) {
              console.warn(`Error deleting from Active_Appointments, trying content clearing:`, deleteActiveError);
              
              // If deletion fails, try clearing cell content
              await this.sheets.spreadsheets.values.clear({
                spreadsheetId: this.spreadsheetId,
                range: `${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A${activeRowIndex + 2}:R${activeRowIndex + 2}`
              });
              
              console.log(`Cleared Active_Appointments row ${activeRowIndex + 2} as fallback`);
            }
          } else {
            // Fallback: Clear the cell content instead
            console.log(`Could not find Active_Appointments sheet ID, clearing row content instead`);
            await this.sheets.spreadsheets.values.clear({
              spreadsheetId: this.spreadsheetId,
              range: `${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A${activeRowIndex + 2}:R${activeRowIndex + 2}`
            });
            
            console.log(`Row cleared successfully via fallback method from Active_Appointments`);
          }
        }
      }
    } catch (activeSheetError) {
      // Active_Appointments sheet might not exist, or other error occurred
      console.warn(`Error working with Active_Appointments sheet:`, activeSheetError);
      // Continue despite error with Active_Appointments - don't fail the whole operation
    }
    
    // Clear the cache for both sheets
    this.cache.invalidate(`sheet:${SHEET_NAMES.APPOINTMENTS}!A2:R`);
    this.cache.invalidate(`sheet:${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A2:R`);
    
    // Log deletion
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.APPOINTMENT_DELETED,
      description: `Deleted appointment ${appointmentId}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        appointmentId,
        rowIndex: rowIndex + 2, // +2 because Google Sheets is 1-indexed and we have a header
        deletionMethod: appointmentsSheet ? 'row_removal' : 'content_clearing'
      })
    });
    
    console.log(`Successfully deleted appointment ${appointmentId} from row ${rowIndex + 2}`);
  } catch (error) {
    console.error(`Error deleting appointment ${appointmentId}:`, error);
    
    // Add detailed error logging
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: `Failed to delete appointment ${appointmentId}`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    throw new Error(`Failed to delete appointment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
   * Get a specific appointment by ID - Updated with robust error handling 
   */
async getAppointment(appointmentId: string): Promise<AppointmentRecord | null> {
  try {
    // Try to get from Active_Appointments first if it exists (faster for today's appointments)
    try {
      const activeValues = await this.readSheet(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A2:R`);
      if (activeValues && Array.isArray(activeValues)) {
        const appointmentRow = activeValues.find((row: SheetRow) => row[0] === appointmentId);
        if (appointmentRow) {
          console.log(`Found appointment ${appointmentId} in Active_Appointments`);
          return this.mapAppointmentRow(appointmentRow);
        }
      }
    } catch (activeError) {
      // Active_Appointments sheet might not exist, continue to main sheet
      console.log(`No match in Active_Appointments (or sheet doesn't exist), checking main Appointments`);
    }
    
    // If not found in Active_Appointments, check the main Appointments sheet
    const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A2:R`);
    if (!values) return null;

    const appointmentRow = values.find((row: SheetRow) => row[0] === appointmentId);
    if (!appointmentRow) return null;

    return this.mapAppointmentRow(appointmentRow);
  } catch (error) {
    console.error(`Error getting appointment ${appointmentId}:`, error);
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: `Failed to get appointment ${appointmentId}`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    return null;
  }
}

/**
 * Helper method to map a sheet row to an AppointmentRecord
 * DRY approach to ensure consistent mapping
 */
private mapAppointmentRow(row: SheetRow): AppointmentRecord {
  try {
    // Map all base fields
    const appointment: Partial<AppointmentRecord> = {
      appointmentId: row[0] || '',
      clientId: row[1] || '',
      clientName: row[2] || row[1] || '',
      clientDateOfBirth: row[3] || '',
      clinicianId: row[4] || '',
      clinicianName: row[5] || row[4] || '',
      sessionType: (row[7] || 'in-person') as 'in-person' | 'telehealth' | 'group' | 'family',
      startTime: row[8] || '',
      endTime: row[9] || '',
      status: (row[10] || 'scheduled') as 'scheduled' | 'completed' | 'cancelled' | 'rescheduled',
      source: (row[11] || 'manual') as 'intakeq' | 'manual',
      lastUpdated: row[12] || new Date().toISOString(),
      notes: row[14] || ''
    };
    
    // Handle requirements parsing with robust error handling
    try {
      const requirementsStr = row[13]?.toString().trim();
      if (requirementsStr) {
        if (requirementsStr.startsWith('Service:')) {
          appointment.requirements = { accessibility: false, specialFeatures: [] };
          appointment.notes = (appointment.notes ? appointment.notes + ' ' : '') + requirementsStr;
        } else {
          try {
            const cleanJson = requirementsStr
              .replace(/[\u0000-\u0019]+/g, '')
              .replace(/\s+/g, ' ')
              .trim();
            appointment.requirements = JSON.parse(cleanJson);
          } catch (parseError) {
            console.warn(`Error parsing requirements JSON for appointment ${appointment.appointmentId}, defaulting to empty:`, parseError);
            appointment.requirements = { accessibility: false, specialFeatures: [] };
          }
        }
      } else {
        appointment.requirements = { accessibility: false, specialFeatures: [] };
      }
    } catch (requirementsError) {
      console.error(`Error handling requirements for appointment ${appointment.appointmentId}:`, requirementsError);
      appointment.requirements = { accessibility: false, specialFeatures: [] };
    }
    
    // Handle office IDs
    if (row[6]) { 
      appointment.currentOfficeId = standardizeOfficeId(row[6]);
      appointment.officeId = appointment.currentOfficeId; // For backward compatibility
    }
    
    if (row[15]) { 
      appointment.assignedOfficeId = standardizeOfficeId(row[15]);
      appointment.suggestedOfficeId = appointment.assignedOfficeId; // For backward compatibility
    }
    
    // Handle assignment reason
    if (row[16]) { 
      appointment.assignmentReason = row[16];
    }
    
    // Handle tags (column R)
    if (row[17]) {
      appointment.tags = row[17].split(',').map((tag: string) => tag.trim());
    }
    
    // Normalize the record to ensure consistent fields
    return normalizeAppointmentRecord(appointment);
  } catch (error) {
    console.error('Error mapping appointment row:', error, { row });
    // Return a minimal valid appointment to avoid null
    return normalizeAppointmentRecord({
      appointmentId: row[0] || 'unknown',
      clientId: row[1] || 'unknown',
      clientName: row[2] || 'Unknown Client',
      startTime: row[8] || new Date().toISOString(),
      endTime: row[9] || new Date().toISOString(),
      sessionType: 'in-person',
      status: 'scheduled',
      source: 'manual'
    });
  }
}

/**
 * Update an appointment's status
 * This provides a consistent way to handle status changes, including cancellations
 */
async updateAppointmentStatus(
  appointmentId: string, 
  status: 'scheduled' | 'completed' | 'cancelled' | 'rescheduled',
  additionalInfo?: { 
    reason?: string;
    notes?: string;
  }
): Promise<void> {
  try {
    console.log(`Updating appointment ${appointmentId} status to ${status}`);
    
    // Find the appointment with cache invalidation
    this.cache.invalidate(`sheet:${SHEET_NAMES.APPOINTMENTS}!A2:R`);
    
    // Find the appointment
    const appointment = await this.getAppointment(appointmentId);
    
    if (!appointment) {
      console.error(`Appointment ${appointmentId} not found for status update`);
      return; // Return void as required
    }
    
    // Create a modified copy of the existing appointment
    const statusUpdate: AppointmentRecord = {
      ...appointment,
      status: status as 'scheduled' | 'completed' | 'cancelled' | 'rescheduled',
      lastUpdated: new Date().toISOString(),
      notes: additionalInfo?.notes 
        ? (appointment.notes || '') + `\n${additionalInfo.notes}`
        : appointment.notes,
    };
    
    // Add cancellation reason if provided
    if (status === 'cancelled' && additionalInfo?.reason) {
      statusUpdate.notes = (statusUpdate.notes || '') + 
        `\nCancellation Reason: ${additionalInfo.reason}`;
    }
    
    // Update the appointment
    await this.updateAppointment(statusUpdate);
    
    // Log the status change
    const eventType = status === 'cancelled' 
      ? AuditEventType.APPOINTMENT_CANCELLED 
      : AuditEventType.APPOINTMENT_UPDATED;
    
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: eventType,
      description: `Updated appointment ${appointmentId} status to ${status}`,
      user: 'SYSTEM',
      newValue: JSON.stringify(statusUpdate)
    });
  } catch (error) {
    console.error(`Error updating appointment ${appointmentId} status:`, error);
    
    // Log the error
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: `Failed to update appointment ${appointmentId} status to ${status}`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    // Rethrow the error or handle silently depending on your needs
    throw new Error(`Failed to update appointment status: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async updateClientPreference(preference: ClientPreference): Promise<void> {
  try {
    // Update to use CLIENT_ACCESSIBILITY instead of CLIENT_PREFERENCES
    const values = await this.readSheet(`${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A:A`);
    const clientRow = values?.findIndex((row: SheetRow) => row[0] === preference.clientId);
    
    // Map to the format expected by Client_Accessibility_Info
    const rowData = [
      preference.clientId, // clientId
      preference.name,     // clientName
      new Date().toISOString(), // lastUpdated
      preference.mobilityNeeds && preference.mobilityNeeds.length > 0 ? 'TRUE' : 'FALSE', // hasMobilityNeeds
      preference.mobilityNeeds?.join(', ') || '', // mobilityDetails
      preference.sensoryPreferences && preference.sensoryPreferences.length > 0 ? 'TRUE' : 'FALSE', // hasSensoryNeeds
      preference.sensoryPreferences?.join(', ') || '', // sensoryDetails
      preference.physicalNeeds && preference.physicalNeeds.length > 0 ? 'TRUE' : 'FALSE', // hasPhysicalNeeds
      preference.physicalNeeds?.join(', ') || '', // physicalDetails
      preference.roomConsistency.toString(), // roomConsistency
      preference.supportNeeds && preference.supportNeeds.length > 0 ? 'TRUE' : 'FALSE', // hasSupport
      preference.supportNeeds?.join(', ') || '', // supportDetails
      // Include assigned office in additionalNotes if present
      (preference.additionalNotes || '') + 
      (preference.assignedOffice ? `\nAssigned Office: ${preference.assignedOffice}` : ''), // additionalNotes
      'migrated', // formType
      '', // formId
      preference.assignedOffice || '' // Added requiredOffice field
    ];

    if (clientRow !== undefined && clientRow >= 0) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A${clientRow + 2}:P${clientRow + 2}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [rowData]
        }
      });
    } else {
      await this.appendRows(`${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A:P`, [rowData]);
    }

    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.CLIENT_PREFERENCES_UPDATED,
      description: `Updated preferences for client ${preference.clientId}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify(preference)
    });

    await this.refreshCache(`${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A2:P`);
  } catch (error) {
    console.error('Error updating client preference:', error);
    throw error;
  }
}

private extractMobilityNeeds(responses: Record<string, any>): string[] {
  const needs: string[] = [];
  
  const mobilityField = responses['Do you use any mobility devices?'] || [];
  if (Array.isArray(mobilityField)) {
    if (mobilityField.includes('Wheelchair')) needs.push('wheelchair_access');
    if (mobilityField.includes('Crutches')) needs.push('mobility_aid_crutches');
    if (mobilityField.includes('Walking boot')) needs.push('mobility_aid_boot');
  }
  
  const otherMobility = responses['Access needs related to mobility/disability (Please specify)'];
  if (otherMobility) needs.push(otherMobility);
  
  return needs;
}

/**
 * Safely extract sensory preferences from form responses
 */
private safeExtractSensoryPreferences(responses: Record<string, any>): string[] {
  try {
    const preferences: string[] = [];
    
    const sensoryField = responses['Do you experience sensory sensitivities?'] || [];
    if (Array.isArray(sensoryField)) {
      if (sensoryField.includes('Light sensitivity')) preferences.push('light_sensitive');
      if (sensoryField.includes('Preference for only natural light')) preferences.push('natural_light');
      if (sensoryField.includes('Auditory sensitivity')) preferences.push('sound_sensitive');
    }
    
    const otherSensory = responses['Other (Please specify):'];
    if (otherSensory && typeof otherSensory === 'string') preferences.push(otherSensory);
    
    return preferences;
  } catch (error) {
    console.warn('Error extracting sensory preferences:', error);
    return [];
  }
}

/**
 * Safely extract physical needs from form responses
 */
private safeExtractPhysicalNeeds(responses: Record<string, any>): string[] {
  try {
    const needs: string[] = [];
    
    const physicalField = responses['Do you experience challenges with physical environment?'] || [];
    if (Array.isArray(physicalField)) {
      if (physicalField.includes('Seating support')) needs.push('seating_support');
      if (physicalField.includes('Difficulty with stairs')) needs.push('no_stairs');
      if (physicalField.includes('Need to see the door')) needs.push('door_visible');
    }
    
    // Check for additional physical environment details
    const physicalDetails = responses['Physical environment details:'];
    if (physicalDetails && typeof physicalDetails === 'string' && physicalDetails.trim() !== '') {
      needs.push(physicalDetails.trim());
    }
    
    return needs;
  } catch (error) {
    console.warn('Error extracting physical needs:', error);
    return [];
  }
}

/**
 * Safely extract mobility needs from form responses
 */
private safeExtractMobilityNeeds(responses: Record<string, any>): string[] {
  try {
    const needs: string[] = [];
    
    const mobilityField = responses['Do you use any mobility devices?'] || [];
    if (Array.isArray(mobilityField)) {
      if (mobilityField.includes('Wheelchair')) needs.push('wheelchair_access');
      if (mobilityField.includes('Crutches')) needs.push('mobility_aid_crutches');
      if (mobilityField.includes('Walking boot')) needs.push('mobility_aid_boot');
    }
    
    const otherMobility = responses['Access needs related to mobility/disability (Please specify)'];
    if (otherMobility && typeof otherMobility === 'string') needs.push(otherMobility);
    
    return needs;
  } catch (error) {
    console.warn('Error extracting mobility needs:', error);
    return [];
  }
}

/**
 * Safely extract room consistency preference from form responses
 */
private safeExtractRoomConsistency(responses: Record<string, any>): number {
  try {
    const value = responses['Please indicate your comfort level with this possibility:'];
    const consistencyMap: Record<string, number> = {
      '1 - Strong preference for consistency': 5,
      '2 - High preference for consistency': 4,
      '3 - Neutral about room changes': 3,
      '4 - Somewhat comfortable with room changes when needed': 2,
      '5 - Very comfortable with room changes when needed': 1
    };
    
    return typeof value === 'string' && consistencyMap[value] ? consistencyMap[value] : 3;
  } catch (error) {
    console.warn('Error extracting room consistency:', error);
    return 3; // Default to neutral
  }
}

/**
 * Safely extract support needs from form responses
 */
private safeExtractSupportNeeds(responses: Record<string, any>): string[] {
  try {
    const needs: string[] = [];
    
    const supportField = responses['Do you have support needs that involve any of the following?'] || [];
    if (Array.isArray(supportField)) {
      if (supportField.includes('Space for a service animal')) needs.push('service_animal');
      if (supportField.includes('A support person present')) needs.push('support_person');
      if (supportField.includes('The use of communication aids')) needs.push('communication_aids');
    }
    
    // Check for additional support details
    const supportDetails = responses['Support needs details:'];
    if (supportDetails && typeof supportDetails === 'string' && supportDetails.trim() !== '') {
      needs.push(supportDetails.trim());
    }
    
    return needs;
  } catch (error) {
    console.warn('Error extracting support needs:', error);
    return [];
  }
}

/**
 * Safely extract value from form responses
 */
private safeExtractValue(responses: Record<string, any>, key: string, defaultValue: any): any {
  try {
    return responses[key] !== undefined ? responses[key] : defaultValue;
  } catch (error) {
    console.warn(`Error extracting value for ${key}:`, error);
    return defaultValue;
  }
}

/**
 * Get client accessibility information
 * UPDATED: Now includes the requiredOffice field
 */
async getClientAccessibilityInfo(clientId: string): Promise<any | null> {
  try {
    console.log(`Getting accessibility info for client ${clientId}`);
    
    // Updated range to include column P (requiredOffice)
    const values = await this.readSheet(`${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A2:P`);
    if (!values || values.length === 0) {
      console.log(`No accessibility info found for any clients`);
      return null;
    }
  
    const clientRow = values.find(row => row[0] === clientId);
    if (!clientRow) {
      console.log(`No accessibility info found for client ${clientId}`);
      return null;
    }
    
    return {
      clientId: clientRow[0],
      clientName: clientRow[1] || '',
      lastUpdated: clientRow[2] || '',
      hasMobilityNeeds: clientRow[3] === 'TRUE',
      mobilityDetails: clientRow[4] || '',
      hasSensoryNeeds: clientRow[5] === 'TRUE',
      sensoryDetails: clientRow[6] || '',
      hasPhysicalNeeds: clientRow[7] === 'TRUE',
      physicalDetails: clientRow[8] || '',
      roomConsistency: parseInt(clientRow[9] || '3'),
      hasSupport: clientRow[10] === 'TRUE',
      supportDetails: clientRow[11] || '',
      additionalNotes: clientRow[12] || '',
      formType: clientRow[13] || '',
      formId: clientRow[14] || '',
      requiredOffice: clientRow[15] || '' // Added requiredOffice field
    };
  } catch (error) {
    console.error(`Error getting client accessibility info for ${clientId}:`, error);
    
    // Log error but don't throw - just return null
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: `Failed to get accessibility info for client ${clientId}`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    return null;
  }
}

/**
 * Update client accessibility information
 * UPDATED: Now supports the requiredOffice field
 */
async updateClientAccessibilityInfo(accessibilityInfo: {
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
  formType: string;
  formId: string;
  requiredOffice?: string; // New field
}): Promise<void> {
  try {
    console.log(`Updating accessibility info for client ${accessibilityInfo.clientId}`);
    
    // Check if client already exists in the sheet
    const values = await this.readSheet(`${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A:A`);
    const clientRowIndex = values?.findIndex(row => row[0] === accessibilityInfo.clientId);
    
    // Format data for sheet
    const rowData = [
      accessibilityInfo.clientId,
      accessibilityInfo.clientName,
      new Date().toISOString(), // Last updated timestamp
      accessibilityInfo.hasMobilityNeeds ? 'TRUE' : 'FALSE',
      accessibilityInfo.mobilityDetails,
      accessibilityInfo.hasSensoryNeeds ? 'TRUE' : 'FALSE',
      accessibilityInfo.sensoryDetails,
      accessibilityInfo.hasPhysicalNeeds ? 'TRUE' : 'FALSE',
      accessibilityInfo.physicalDetails,
      accessibilityInfo.roomConsistency.toString(),
      accessibilityInfo.hasSupport ? 'TRUE' : 'FALSE',
      accessibilityInfo.supportDetails,
      accessibilityInfo.additionalNotes,
      accessibilityInfo.formType,
      accessibilityInfo.formId,
      accessibilityInfo.requiredOffice || '' // Added requiredOffice field
    ];
    
    if (clientRowIndex !== undefined && clientRowIndex >= 0) {
      // Update existing row
      console.log(`Updating existing row for client ${accessibilityInfo.clientId}`);
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A${clientRowIndex + 2}:P${clientRowIndex + 2}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [rowData]
        }
      });
    } else {
      // Add new row
      console.log(`Adding new row for client ${accessibilityInfo.clientId}`);
      await this.appendRows(`${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A:P`, [rowData]);
    }
    
    // Log the update
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.CLIENT_PREFERENCES_UPDATED,
      description: `Updated accessibility info for client ${accessibilityInfo.clientId}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        clientId: accessibilityInfo.clientId,
        hasMobilityNeeds: accessibilityInfo.hasMobilityNeeds,
        hasSensoryNeeds: accessibilityInfo.hasSensoryNeeds,
        hasPhysicalNeeds: accessibilityInfo.hasPhysicalNeeds,
        roomConsistency: accessibilityInfo.roomConsistency,
        requiredOffice: accessibilityInfo.requiredOffice // Added requiredOffice to log
      })
    });
    
    console.log(`Successfully updated accessibility info for client ${accessibilityInfo.clientId}`);
  } catch (error) {
    console.error(`Error updating client accessibility info for ${accessibilityInfo.clientId}:`, error);
    
    // Log error and throw
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: `Failed to update accessibility info for client ${accessibilityInfo.clientId}`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    throw error;
  }
}

/**
 * Get client required offices
 * UPDATED: Now checks both additionalNotes and requiredOffice fields
 */
async getClientRequiredOffices(): Promise<any[]> {
  try {
    console.log('Getting client required offices from Client_Accessibility_Info');
    
    // Get client accessibility info
    const accessibilityRecords = await this.getClientAccessibilityRecords();
    
    // Filter for clients with assigned offices in their notes or requiredOffice field
    return accessibilityRecords
      .filter(record => {
        // Check both requiredOffice field and notes
        const assignedOffice = this.extractAssignedOfficeFromNotes(
          record.additionalNotes,
          record.requiredOffice
        );
        return !!assignedOffice;
      })
      .map(record => {
        const nameParts = record.clientName.split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
        
        // Extract office from requiredOffice field or notes
        const requiredOfficeId = this.extractAssignedOfficeFromNotes(
          record.additionalNotes,
          record.requiredOffice
        );
        
        return {
          inactive: false,
          requiredOfficeId,
          lastName,
          firstName,
          middleName: '',
          dateOfBirth: '',
          dateCreated: '',
          lastActivity: record.lastUpdated || '',
          practitioner: ''  // Not available in accessibility info
        };
      });
  } catch (error) {
    console.error('Error getting client required offices from accessibility info:', error);
    
    // Log error but don't throw - just return empty array
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: 'Failed to get client required offices from accessibility info',
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    return [];
  }
}

async processAccessibilityForm(formData: {
  clientId: string;
  clientName: string;
  clientEmail: string;
  formResponses: Record<string, any>;
}): Promise<void> {
  try {
    // Validate and sanitize inputs
    if (!formData.clientId || !formData.clientName) {
      throw new Error('Missing required client information');
    }
    
    // Ensure formResponses is an object
    const safeResponses = typeof formData.formResponses === 'object' && formData.formResponses !== null 
      ? formData.formResponses 
      : {};
    
    // Create client preference with safer extraction methods
    const preference: ClientPreference = {
      clientId: formData.clientId,
      name: formData.clientName,
      email: formData.clientEmail || '',
      mobilityNeeds: this.safeExtractMobilityNeeds(safeResponses),
      sensoryPreferences: this.safeExtractSensoryPreferences(safeResponses),
      physicalNeeds: this.safeExtractPhysicalNeeds(safeResponses),
      roomConsistency: this.safeExtractRoomConsistency(safeResponses),
      supportNeeds: this.safeExtractSupportNeeds(safeResponses),
      specialFeatures: [], // Will be derived from other preferences
      additionalNotes: this.safeExtractValue(safeResponses, 'Is there anything else we should know about your space or accessibility needs?', ''),
      lastUpdated: new Date().toISOString(),
      preferredClinician: '',
      assignedOffice: ''
    };

    await this.updateClientPreference(preference);

    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.CLIENT_PREFERENCES_UPDATED,
      description: `Processed accessibility form for client ${formData.clientId}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        clientId: formData.clientId,
        fieldsProcessed: Object.keys(safeResponses).length,
        processingTime: new Date().toISOString()
      })
    });
  } catch (error) {
    console.error('Error processing accessibility form:', error);
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: `Failed to process accessibility form for client ${formData.clientId}`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    throw error;
  }
}

/**
 * Clean up default client accessibility data by removing default/baseline entries
 * NEW method to address data quality issues
 */
async cleanupDefaultClientAccessibility(): Promise<number> {
  try {
    console.log('Cleaning up default client accessibility records');
    
    // Get all client accessibility records
    const records = await this.getClientAccessibilityRecords();
    if (!records || records.length === 0) {
      return 0;
    }
    
    // Identify default records with all FALSE and default values
    const defaultRecords = records.filter(record => 
      !record.hasMobilityNeeds && 
      !record.hasSensoryNeeds && 
      !record.hasPhysicalNeeds && 
      record.roomConsistency === 3 &&
      !record.hasSupport && 
      !record.additionalNotes &&
      !record.requiredOffice
    );
    
    console.log(`Found ${defaultRecords.length} default client accessibility records to clean up`);
    
    let removedCount = 0;
    
    // Delete default records from the sheet
    for (const record of defaultRecords) {
      try {
        // Find the row for this record
        const values = await this.readSheet(`${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A:A`);
        const rowIndex = values?.findIndex(row => row[0] === record.clientId);
        
        if (rowIndex !== undefined && rowIndex >= 0) {
          // Delete the row using spreadsheets.batchUpdate
          const spreadsheet = await this.sheets.spreadsheets.get({
            spreadsheetId: this.spreadsheetId
          });
          
          const accessibilitySheet = spreadsheet.data.sheets?.find(
            sheet => sheet.properties?.title === SHEET_NAMES.CLIENT_ACCESSIBILITY
          );
          
          if (accessibilitySheet && accessibilitySheet.properties?.sheetId !== undefined) {
            await this.sheets.spreadsheets.batchUpdate({
              spreadsheetId: this.spreadsheetId,
              requestBody: {
                requests: [{
                  deleteDimension: {
                    range: {
                      sheetId: accessibilitySheet.properties.sheetId,
                      dimension: 'ROWS',
                      startIndex: rowIndex + 1, // +1 for header row
                      endIndex: rowIndex + 2 // +1 for exclusive range
                    }
                  }
                }]
              }
            });
            
            removedCount++;
            console.log(`Removed default record for client ${record.clientId}`);
          }
        }
      } catch (error) {
        console.error(`Error removing default record for client ${record.clientId}:`, error);
      }
    }
    
    // Refresh cache after cleanup
    await this.refreshCache(`${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A2:P`);
    
    return removedCount;
  } catch (error) {
    console.error('Error cleaning up default client accessibility records:', error);
    throw error;
  }
}

/**
 * Standardize date format to YYYY-MM-DD or YYYY-MM-DD HH:MM
 * NEW helper method to standardize dates
 */
private standardizeDate(dateStr: string): string {
  if (!dateStr) return '';
  
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return dateStr; // Return original if parsing fails
    }
    
    // Check if the string contains time information
    if (dateStr.includes('T') && dateStr.includes(':')) {
      // Format with time YYYY-MM-DD HH:MM
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      
      return `${year}-${month}-${day} ${hours}:${minutes}`;
    } else {
      // Format date only YYYY-MM-DD
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      
      return `${year}-${month}-${day}`;
    }
  } catch (error) {
    console.error('Error standardizing date:', error);
    return dateStr; // Return original on error
  }
}

async refreshCache(range: string): Promise<void> {
  this.cache.invalidate(`sheet:${range}`);
}

clearCache(): void {
  this.cache.clearAll();
}

// Add these public methods to your GoogleSheetsService class

/**
 * Get data from a specific sheet and range
 */
async getSheetData(sheetName: string, range: string): Promise<any[][]> {
  try {
    // Use the existing private readSheet method
    return await this.readSheet(`${sheetName}!${range}`);
  } catch (error) {
    console.error(`Error getting sheet data for ${sheetName}!${range}:`, error);
    throw error;
  }
}

/**
 * Add a row to a sheet
 */
async addRow(sheetName: string, values: any[]): Promise<void> {
  try {
    // Use the existing private appendRows method
    await this.appendRows(`${sheetName}!A:${this.columnIndexToLetter(values.length)}`, [values]);
  } catch (error) {
    console.error(`Error adding row to ${sheetName}:`, error);
    throw error;
  }
}

/**
 * Update an existing row in a sheet
 */
async addOrUpdateRow(sheetName: string, rowIndex: number, values: any[]): Promise<void> {
  try {
    // Use the Google Sheets API directly
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!A${rowIndex}:${this.columnIndexToLetter(values.length)}${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [values]
      }
    });
  } catch (error) {
    console.error(`Error updating row ${rowIndex} in ${sheetName}:`, error);
    throw error;
  }
}

/**
 * Clear a range in a sheet
 */
async clearRange(sheetName: string, range: string): Promise<void> {
  try {
    // Use the Google Sheets API directly
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!${range}`
    });
  } catch (error) {
    console.error(`Error clearing range ${range} in ${sheetName}:`, error);
    throw error;
  }
}

/**
 * Create a new sheet in the spreadsheet
 */
async createSheet(sheetName: string): Promise<void> {
  try {
    // Use the Google Sheets API directly
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: sheetName
            }
          }
        }]
      }
    });
  } catch (error) {
    console.error(`Error creating sheet ${sheetName}:`, error);
    throw error;
  }
}

/**
 * Convert column index to letter (e.g., 1 -> A, 26 -> Z, 27 -> AA)
 */
private columnIndexToLetter(index: number): string {
  let letter = '';
  let temp = index;
  
  while (temp > 0) {
    temp--;
    letter = String.fromCharCode(65 + (temp % 26)) + letter;
    temp = Math.floor(temp / 26);
  }
  
  return letter || 'A';
}
}