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
  getAllAppointments(): Promise<AppointmentRecord[]>; // Add this method to the interface
  getAppointments(startDate: string, endDate: string): Promise<AppointmentRecord[]>;
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
    requiredOffice?: string; // Added requiredOffice field
  }): Promise<void>;
  getClientRequiredOffices(): Promise<any[]>;
  processAccessibilityForm(formData: {
    clientId: string;
    clientName: string;
    clientEmail: string;
    formResponses: Record<string, any>;
  }): Promise<void>;
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
  AUDIT_LOG: 'Audit_Log'
};

export class GoogleSheetsService implements IGoogleSheetsService {
  private readonly sheets;
  private readonly spreadsheetId: string;
  private readonly cache: SheetsCacheService;

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
   * Read data from a Google Sheet
   */
  private async readSheet(range: string) {
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
        60000 // 1 minute cache TTL
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

  async getOffices(): Promise<SheetOffice[]> {
    console.log(`Reading offices from ${SHEET_NAMES.OFFICES}!A2:M`);
    try {
      const values = await this.readSheet(`${SHEET_NAMES.OFFICES}!A2:M`);
      
      console.log(`Retrieved ${values?.length || 0} office records`);
      if (values?.length === 0) {
        console.warn('No office records found in sheet!');
      }
      
      return values?.map((row: SheetRow) => {
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
        
        console.log(`Mapped office: ${office.officeId}, Name: ${office.name}, Status: ${office.inService ? 'Active' : 'Inactive'}`);
        return office;
      }) ?? [];
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

  async addAuditLog(entry: AuditLogEntry): Promise<void> {
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
      console.log('Audit log entry added:', entry);
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
      const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A2:Q`);
      
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
              sessionType: (row[8] || 'in-person') as 'in-person' | 'telehealth' | 'group' | 'family',
              startTime: row[9] || '',
              endTime: row[10] || '',
              status: (row[11] || 'scheduled') as 'scheduled' | 'completed' | 'cancelled' | 'rescheduled',
              lastUpdated: row[13] || new Date().toISOString(),
              source: (row[12] || 'manual') as 'intakeq' | 'manual',
              notes: row[14] || ''
            };
            
            // Handle requirements parsing
            // Handle requirements parsing
            try {
              const requirementsStr = row[12]?.toString().trim();
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
              console.error('Error parsing requirements JSON:', err, {value: row[12]});
              appointment.requirements = { accessibility: false, specialFeatures: [] };
            }
            
            
            
            // Handle office IDs - NEW FIELD NAMES
            // Column 5 (index 5) = currentOfficeId (previously officeId)
            // Column 15 (index 15) = assignedOfficeId (previously suggestedOfficeId)
            // Column 16 (index 16) = assignmentReason

            // Set currentOfficeId (formerly officeId)
            if (row[5]) {
              appointment.currentOfficeId = standardizeOfficeId(row[5]);
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
 * Get appointments for a specific date range - Updated with robust error handling
 * and corrected column indexing
 */
async getAppointments(startDate: string, endDate: string): Promise<AppointmentRecord[]> {
  try {
    const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A2:Q`);
    
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
  
    const appointments = await this.getAppointments(
      startOfDay.toISOString(),
      endOfDay.toISOString()
    );
  
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
 * Add a new appointment - Updated with correct column ordering
 */
async addAppointment(appt: AppointmentRecord): Promise<void> {
  try {
    // Normalize to ensure we have all required fields
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
      normalizedAppointment.source,                            // Column L: source (CORRECTED)
      normalizedAppointment.lastUpdated || new Date().toISOString(), // Column M: lastUpdated (CORRECTED)
      requirementsJson,                                        // Column N: requirements
      normalizedAppointment.notes || '',                       // Column O: notes
      assignedOfficeId,                                        // Column P: assignedOfficeId
      normalizedAppointment.assignmentReason || ''             // Column Q: assignmentReason
    ];

    await this.appendRows(`${SHEET_NAMES.APPOINTMENTS}!A:Q`, [rowData]);

    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.APPOINTMENT_CREATED,
      description: `Added appointment ${appt.appointmentId}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        ...normalizedAppointment,
        currentOfficeId,
        assignedOfficeId
      })
    });

    await this.refreshCache(`${SHEET_NAMES.APPOINTMENTS}!A2:Q`);
  } catch (error) {
    console.error('Error adding appointment:', error);
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: `Failed to add appointment ${appt.appointmentId}`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    throw new Error(`Failed to add appointment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Update an appointment - Updated with correct column ordering and robust JSON handling
 */
async updateAppointment(appointment: AppointmentRecord): Promise<void> {
  try {
    // Normalize to ensure we have all required fields
    const normalizedAppointment = normalizeAppointmentRecord(appointment);
    
    // Find the appointment row
    const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A:A`);
    const appointmentRow = values?.findIndex((row: SheetRow) => row[0] === normalizedAppointment.appointmentId);

    if (!values || appointmentRow === undefined || appointmentRow < 0) {
      throw new Error(`Appointment ${normalizedAppointment.appointmentId} not found`);
    }

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
      normalizedAppointment.source,                            // Column L: source (CORRECTED)
      normalizedAppointment.lastUpdated || new Date().toISOString(), // Column M: lastUpdated (CORRECTED)
      requirementsJson,                                        // Column N: requirements
      normalizedAppointment.notes || '',                       // Column O: notes
      assignedOfficeId,                                        // Column P: assignedOfficeId
      normalizedAppointment.assignmentReason || ''             // Column Q: assignmentReason
    ];

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${SHEET_NAMES.APPOINTMENTS}!A${appointmentRow + 2}:Q${appointmentRow + 2}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [rowData]
      }
    });

    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.APPOINTMENT_UPDATED,
      description: `Updated appointment ${appointment.appointmentId}`,
      user: 'SYSTEM',
      previousValue: JSON.stringify(values[appointmentRow]),
      newValue: JSON.stringify(rowData)
    });

    await this.refreshCache(`${SHEET_NAMES.APPOINTMENTS}!A2:Q`);
  } catch (error) {
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

/**
 * Get a specific appointment by ID - Updated with robust error handling 
 */
async getAppointment(appointmentId: string): Promise<AppointmentRecord | null> {
  try {
    const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A2:Q`);
    if (!values) return null;

    const appointmentRow = values.find((row: SheetRow) => row[0] === appointmentId);
    if (!appointmentRow) return null;

    // Create appointment object with both old and new field names
    const appointment: Partial<AppointmentRecord> = {
      appointmentId: appointmentRow[0] || '',
      clientId: appointmentRow[1] || '',
      clientName: appointmentRow[2] || '',
      clientDateOfBirth: appointmentRow[3] || '',
      clinicianId: appointmentRow[4] || '',
      clinicianName: appointmentRow[5] || '',
      sessionType: appointmentRow[7] as 'in-person' | 'telehealth' | 'group' | 'family',
      startTime: appointmentRow[8] || '',
      endTime: appointmentRow[9] || '',
      status: appointmentRow[10] as 'scheduled' | 'completed' | 'cancelled' | 'rescheduled',
      source: appointmentRow[11] as 'intakeq' | 'manual',
      lastUpdated: appointmentRow[12] || '',
      notes: appointmentRow[14] || ''
    };
    
    // Handle requirements parsing with robust error handling
    try {
      const requirementsStr = appointmentRow[13]?.toString().trim();
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
            console.warn(`Error parsing requirements JSON for appointment ${appointmentId}, defaulting to empty:`, parseError);
            appointment.requirements = { accessibility: false, specialFeatures: [] };
          }
        }
      } else {
        appointment.requirements = { accessibility: false, specialFeatures: [] };
      }
    } catch (requirementsError) {
      console.error(`Error handling requirements for appointment ${appointmentId}:`, requirementsError);
      appointment.requirements = { accessibility: false, specialFeatures: [] };
    }
    
    // Handle office IDs - NEW FIELD NAMES
    // Column 6 (index 6) = currentOfficeId (previously officeId)
    // Column 15 (index 15) = assignedOfficeId (previously suggestedOfficeId)
    // Column 16 (index 16) = assignmentReason

    // Set currentOfficeId (formerly officeId)
    if (appointmentRow[6]) { 
      appointment.currentOfficeId = standardizeOfficeId(appointmentRow[6]);
      appointment.officeId = appointment.currentOfficeId; // For backward compatibility
    }
    
    // Set assignedOfficeId (formerly suggestedOfficeId)
    if (appointmentRow[15]) { 
      appointment.assignedOfficeId = standardizeOfficeId(appointmentRow[15]);
      appointment.suggestedOfficeId = appointment.assignedOfficeId; // For backward compatibility
    }
    
    // Handle assignment reason
    if (appointmentRow[16]) { 
      appointment.assignmentReason = appointmentRow[16];
    }
    
    // Normalize the record to ensure consistent fields
    return normalizeAppointmentRecord(appointment);
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
 * Delete an appointment - FIXED to properly handle sheet IDs and row deletion
 */
async deleteAppointment(appointmentId: string): Promise<void> {
  try {
    console.log(`Starting deletion process for appointment ${appointmentId}`);
    
    // Find the row with this appointment ID
    const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A:A`);
    const rowIndex = values?.findIndex(row => row[0] === appointmentId);
    
    if (rowIndex === undefined || rowIndex < 0) {
      console.error(`Appointment ${appointmentId} not found for deletion`);
      throw new Error(`Appointment ${appointmentId} not found for deletion`);
    }
    
    console.log(`Found appointment ${appointmentId} at row index ${rowIndex} (Row ${rowIndex + 2} in sheet)`);
    
    // Get spreadsheet metadata to find correct sheet ID
    console.log(`Retrieving sheet metadata for spreadsheet ID: ${this.spreadsheetId}`);
    const spreadsheet = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId
    });
    
    // Debug: Log all sheets in the spreadsheet
    console.log('All sheets in spreadsheet:');
    spreadsheet.data.sheets?.forEach((sheet, index) => {
      console.log(`Sheet ${index}: "${sheet.properties?.title}" (ID: ${sheet.properties?.sheetId})`);
    });
    
    // Find the Appointments sheet
    const appointmentsSheet = spreadsheet.data.sheets?.find(
      sheet => sheet.properties?.title === SHEET_NAMES.APPOINTMENTS
    );
    
    if (!appointmentsSheet || appointmentsSheet.properties?.sheetId === undefined) {
      console.error(`Could not find sheet ID for ${SHEET_NAMES.APPOINTMENTS}, attempting fallback method`);
      
      // Attempt to delete by clearing the content instead
      console.log(`Fallback: Clearing row ${rowIndex + 2} content instead of deleting the row`);
      await this.sheets.spreadsheets.values.clear({
        spreadsheetId: this.spreadsheetId,
        range: `${SHEET_NAMES.APPOINTMENTS}!A${rowIndex + 2}:Q${rowIndex + 2}`
      });
      
      console.log(`Row cleared successfully via fallback method`);
    } else {
      // Use the found sheet ID
      const sheetId = appointmentsSheet.properties.sheetId;
      
      console.log(`Found Appointments sheet with ID ${sheetId}, deleting row at index ${rowIndex + 2}`);
      
      // Prepare and log the exact request being sent - FIX: adjusted indices to match actual row
      const deleteRequest = {
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: sheetId,
                dimension: 'ROWS',
                startIndex: rowIndex + 1, // +1 to account for header row (don't add additional +1)
                endIndex: rowIndex + 2    // endIndex is exclusive, so we need row+2 to include current row
              }
            }
          }]
        }
      };
      
      console.log(`Delete request details: ${JSON.stringify(deleteRequest, null, 2)}`);
      
      // Execute the delete request and capture the full response
      const response = await this.sheets.spreadsheets.batchUpdate(deleteRequest);
      
      // Log the full response
      console.log(`Delete response: ${JSON.stringify(response.data, null, 2)}`);
    }
    
    // Clear the cache for appointments
    await this.refreshCache(`${SHEET_NAMES.APPOINTMENTS}!A2:Q`);
    
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
): Promise<boolean> {
  try {
    console.log(`Updating appointment ${appointmentId} status to ${status}`);
    
    // Find the appointment
    const appointment = await this.getAppointment(appointmentId);
    
    if (!appointment) {
      console.error(`Appointment ${appointmentId} not found for status update`);
      return false;
    }
    
    // If we're cancelling, attempt to delete first
    if (status === 'cancelled') {
      try {
        await this.deleteAppointment(appointmentId);
        
        // Log the status change
        await this.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: AuditEventType.APPOINTMENT_CANCELLED,
          description: `Cancelled appointment ${appointmentId}`,
          user: 'SYSTEM',
          systemNotes: JSON.stringify({
            appointmentId,
            reason: additionalInfo?.reason || 'No reason provided',
            method: 'deletion'
          })
        });
        
        return true;
      } catch (deleteError) {
        console.warn(`Deletion failed for cancelled appointment ${appointmentId}, falling back to status update:`, deleteError);
        // Continue to status update as fallback
      }
    }
    
    // Update the appointment with new status
    const updatedAppointment = {
      ...appointment,
      status: status,
      lastUpdated: new Date().toISOString(),
      notes: additionalInfo?.notes 
        ? (appointment.notes || '') + `\n${additionalInfo.notes}`
        : appointment.notes,
    };
    
    // Add cancellation reason if provided
    if (status === 'cancelled' && additionalInfo?.reason) {
      updatedAppointment.notes = (updatedAppointment.notes || '') + 
        `\nCancellation Reason: ${additionalInfo.reason}`;
    }
    
    // Update the appointment
    await this.updateAppointment(updatedAppointment);
    
    // Log the status change
    const eventType = status === 'cancelled' 
      ? AuditEventType.APPOINTMENT_CANCELLED 
      : AuditEventType.APPOINTMENT_UPDATED;
    
    await this.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: eventType,
      description: `Updated appointment ${appointmentId} status to ${status}`,
      user: 'SYSTEM',
      newValue: JSON.stringify(updatedAppointment)
    });
    
    return true;
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
    
    return false;
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

// Add these methods to the GoogleSheetsService class, after the existing extractMobilityNeeds method

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
        requiredOffice: accessibilityInfo.requiredOffice // Added requiredOffice
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

async refreshCache(range: string): Promise<void> {
  this.cache.invalidate(`sheet:${range}`);
}

clearCache(): void {
  this.cache.clearAll();
}
}