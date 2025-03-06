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
  standardizeOfficeId 
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
  CRITICAL_ERROR = 'CRITICAL_ERROR'
}

// Sheet name constants to avoid typos and make updates easier
const SHEET_NAMES = {
  OFFICES: 'Offices_Configuration',
  CLINICIANS: 'Clinicians_Configuration',
  ASSIGNMENT_RULES: 'Assignment_Rules',
  CLIENT_PREFERENCES: 'Client_Preferences',
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
 */
async getClientAccessibilityRecords(): Promise<any[]> {
  try {
    const values = await this.readSheet(`${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A2:O`);
    
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
      formId: row[14] || ''
    }));
  } catch (error) {
    console.error('Error getting client accessibility records:', error);
    return [];
  }
}

  /**
   * Read data from a Google Sheet
   * Improved to handle sheet names with spaces/underscores properly
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
          
          // Make API request with properly constructed range
          try {
            const response = await this.sheets.spreadsheets.values.get({
              spreadsheetId: this.spreadsheetId,
              range: range, // Google's API will handle the encoding
            });
            
            console.log(`Successfully read sheet range: ${range}`);
            return response.data.values || [];
          } catch (apiError: unknown) {
            console.error(`Google Sheets API error for range ${range}:`, apiError);
            
            // If error is due to range parsing, log detailed information
            if (apiError && typeof apiError === 'object' && 'message' in apiError && 
                typeof apiError.message === 'string' && apiError.message.includes('Unable to parse range')) {
              console.error('This may be due to sheet name format mismatch. Check if sheet names have changed.');
              console.error('Attempted to read from sheet name:', sheetName);
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
   * Improved to handle sheet names with spaces/underscores properly
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
    const values = await this.readSheet(`${SHEET_NAMES.OFFICES}!A2:M`);
    
    return values?.map((row: SheetRow) => ({
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
    })) ?? [];
  }

  async getClinicians(): Promise<SheetClinician[]> {
    const values = await this.readSheet(`${SHEET_NAMES.CLINICIANS}!A2:M`);
    
    return values?.map((row: SheetRow) => ({
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
    })) ?? [];
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
    const values = await this.readSheet(`${SHEET_NAMES.CLIENT_PREFERENCES}!A2:L`);
    
    return values?.map((row: SheetRow) => ({
      clientId: row[0],
      name: row[1],
      email: row[2],
      mobilityNeeds: this.safeParseJSON(row[3], []),
      sensoryPreferences: this.safeParseJSON(row[4], []),
      physicalNeeds: this.safeParseJSON(row[5], []),
      roomConsistency: Number(row[6]),
      supportNeeds: this.safeParseJSON(row[7], []),
      specialFeatures: [], // Added required field with default empty array
      additionalNotes: row[8],
      lastUpdated: row[9],
      preferredClinician: row[10],
      assignedOffice: row[11]
    })) ?? [];
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
   */
  async getAllAppointments(): Promise<AppointmentRecord[]> {
    try {
      const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A2:O`);
      
      if (!values || !Array.isArray(values)) {
        console.log('No appointments found in sheet');
        return [];
      }

      console.log(`Processing all appointments from sheet: ${values.length} rows`);

      const mappedAppointments = values
        .map((row: SheetRow) => {
          try {
            const assignedOffice = row[5] || 'A-a';
            const suggestedOffice = row[14] || assignedOffice;
            
            const standardizedOfficeId = standardizeOfficeId(assignedOffice);
            const standardizedSuggestedId = standardizeOfficeId(suggestedOffice);
    
            let requirements = { accessibility: false, specialFeatures: [] };
            try {
              const requirementsStr = row[12]?.toString().trim();
              if (requirementsStr) {
                const cleanJson = requirementsStr
                  .replace(/[\u0000-\u0019]+/g, '')
                  .replace(/\s+/g, ' ')
                  .trim();
                requirements = JSON.parse(cleanJson);
              }
            } catch (err) {
              console.error('Error parsing requirements JSON:', err, {value: row[12]});
            }
            
            return {
              appointmentId: row[0] || '',
              clientId: row[1] || '',
              clientName: row[2] || row[1] || '',
              clinicianId: row[3] || '',
              clinicianName: row[4] || row[3] || '',
              officeId: standardizedOfficeId,
              suggestedOfficeId: standardizedSuggestedId,
              sessionType: (row[6] || 'in-person') as 'in-person' | 'telehealth' | 'group' | 'family',
              startTime: row[7] || '',
              endTime: row[8] || '',
              status: (row[9] || 'scheduled') as 'scheduled' | 'completed' | 'cancelled' | 'rescheduled',
              lastUpdated: row[10] || new Date().toISOString(),
              source: (row[11] || 'manual') as 'intakeq' | 'manual',
              requirements,
              notes: row[13] || ''
            } as AppointmentRecord;
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

  async getOfficeAppointments(officeId: string, date: string): Promise<AppointmentRecord[]> {
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
    return appointments.filter(appt => standardizeOfficeId(appt.officeId) === standardizedTargetId);
  }

  async addAppointment(appt: AppointmentRecord): Promise<void> {
    try {
      const standardizedOfficeId = standardizeOfficeId(appt.officeId);
      const standardizedSuggestedId = appt.suggestedOfficeId ? 
        standardizeOfficeId(appt.suggestedOfficeId) : standardizedOfficeId;
  
      const rowData = [
        appt.appointmentId,
        appt.clientId,
        appt.clientName,
        appt.clinicianId,
        appt.clinicianName,
        standardizedOfficeId,
        appt.sessionType,
        appt.startTime,
        appt.endTime,
        appt.status,
        appt.lastUpdated,
        appt.source,
        JSON.stringify(appt.requirements || {}),
        appt.notes || '',
        standardizedSuggestedId
      ];
  
      await this.appendRows(`${SHEET_NAMES.APPOINTMENTS}!A:O`, [rowData]);
  
      await this.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.APPOINTMENT_CREATED,
        description: `Added appointment ${appt.appointmentId}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          ...appt,
          officeId: standardizedOfficeId,
          suggestedOfficeId: standardizedSuggestedId
        })
      });
  
      await this.refreshCache(`${SHEET_NAMES.APPOINTMENTS}!A2:O`);
    } catch (error) {
      console.error('Error adding appointment:', error);
      throw new Error('Failed to add appointment');
    }
  }

  async getAppointments(startDate: string, endDate: string): Promise<AppointmentRecord[]> {
    try {
      const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A2:O`);
      
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
            // Ensure we properly get the assigned and suggested office IDs
            const assignedOffice = row[5] || 'A-a';
            const suggestedOffice = row[14] || ''; // Column O, suggested office ID
            
            const standardizedOfficeId = standardizeOfficeId(assignedOffice);
            const standardizedSuggestedId = suggestedOffice ? standardizeOfficeId(suggestedOffice) : '';
    
            // Log for debugging
            console.log(`Processing row for appointment ${row[0]}:`, {
              assignedOffice: assignedOffice,
              suggestedOffice: suggestedOffice,
              standardizedOfficeId: standardizedOfficeId,
              standardizedSuggestedId: standardizedSuggestedId
            });
  
            let requirements = { accessibility: false, specialFeatures: [] };
            try {
              const requirementsStr = row[12]?.toString().trim();
              if (requirementsStr) {
                const cleanJson = requirementsStr
                  .replace(/[\u0000-\u0019]+/g, '')
                  .replace(/\s+/g, ' ')
                  .trim();
                requirements = JSON.parse(cleanJson);
              }
            } catch (err) {
              console.error('Error parsing requirements JSON:', err, {value: row[12]});
            }
            
            return {
              appointmentId: row[0] || '',
              clientId: row[1] || '',
              clientName: row[2] || row[1] || '',
              clinicianId: row[3] || '',
              clinicianName: row[4] || row[3] || '',
              officeId: standardizedOfficeId, 
              suggestedOfficeId: standardizedSuggestedId || standardizedOfficeId, // Use suggestedOfficeId or fall back to officeId
              sessionType: (row[6] || 'in-person') as 'in-person' | 'telehealth' | 'group' | 'family',
              startTime: row[7] || '',
              endTime: row[8] || '',
              status: (row[9] || 'scheduled') as 'scheduled' | 'completed' | 'cancelled' | 'rescheduled',
              lastUpdated: row[10] || new Date().toISOString(),
              source: (row[11] || 'manual') as 'intakeq' | 'manual',
              requirements,
              notes: row[13] || ''
            } as AppointmentRecord;
          } catch (error) {
            console.error('Error mapping appointment row:', error, { row });
            return null;
          }
        })
        .filter((appt): appt is AppointmentRecord => appt !== null);
  
      // Improved filtering logic:
      // 1. Extract date in a consistent format (YYYY-MM-DD) 
      // 2. Compare directly with the target date
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
          
          console.log(`Appointment ${appt.appointmentId} date comparison:`, {
            appointmentDate: apptDateStr,
            targetDate: targetDateStr,
            matches: matches,
            officeId: appt.officeId,
            suggestedOfficeId: appt.suggestedOfficeId
          });
          
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
      throw new Error('Failed to read appointments');
    }
  }

  /**
   * Get client accessibility information
   */
  async getClientAccessibilityInfo(clientId: string): Promise<any | null> {
    try {
      console.log(`Getting accessibility info for client ${clientId}`);
      
      const values = await this.readSheet(`${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A2:O`);
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
        formId: clientRow[14] || ''
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
   */
  // Modify in src/lib/google/sheets.ts
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
      accessibilityInfo.formId
    ];
    
    if (clientRowIndex !== undefined && clientRowIndex >= 0) {
      // Update existing row
      console.log(`Updating existing row for client ${accessibilityInfo.clientId}`);
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A${clientRowIndex + 2}:O${clientRowIndex + 2}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [rowData]
        }
      });
    } else {
      // Add new row
      console.log(`Adding new row for client ${accessibilityInfo.clientId}`);
      await this.appendRows(`${SHEET_NAMES.CLIENT_ACCESSIBILITY}!A:O`, [rowData]);
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
        roomConsistency: accessibilityInfo.roomConsistency
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
   */
  async getClientRequiredOffices(): Promise<any[]> {
    try {
      console.log('Getting client required offices from Client_Preferences');
      
      // Get client preferences instead since that contains the required office info
      const clientPreferences = await this.getClientPreferences();
      
      // Filter and map to the expected format
      return clientPreferences
        .filter(pref => pref.assignedOffice) // Only include clients with an assigned office
        .map(pref => ({
          inactive: false,
          requiredOfficeId: pref.assignedOffice || '',
          lastName: pref.name?.split(' ').slice(1).join(' ') || '',
          firstName: pref.name?.split(' ')[0] || '',
          middleName: '',
          dateOfBirth: '',
          dateCreated: '',
          lastActivity: pref.lastUpdated || '',
          practitioner: pref.preferredClinician || ''
        }));
    } catch (error) {
      console.error('Error getting client required offices from preferences:', error);
      
      // Log error but don't throw - just return empty array
      await this.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Failed to get client required offices from preferences',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      return [];
    }
  }

  async updateAppointment(appointment: AppointmentRecord): Promise<void> {
    try {
      const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A:A`);
      const appointmentRow = values?.findIndex((row: SheetRow) => row[0] === appointment.appointmentId);
  
      if (!values || appointmentRow === undefined || appointmentRow < 0) {
        throw new Error(`Appointment ${appointment.appointmentId} not found`);
      }
  
      const standardizedOfficeId = standardizeOfficeId(appointment.officeId);
      const standardizedSuggestedId = appointment.suggestedOfficeId ? 
        standardizeOfficeId(appointment.suggestedOfficeId) : standardizedOfficeId;
  
      const rowData = [
        appointment.appointmentId,
        appointment.clientId,
        appointment.clientName,
        appointment.clinicianId,
        appointment.clinicianName,
        standardizedOfficeId,
        appointment.sessionType,
        appointment.startTime,
        appointment.endTime,
        appointment.status,
        appointment.lastUpdated,
        appointment.source,
        JSON.stringify(appointment.requirements || {}),
        appointment.notes || '',
        standardizedSuggestedId
      ];
  
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${SHEET_NAMES.APPOINTMENTS}!A${appointmentRow + 1}:O${appointmentRow + 1}`,
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
  
      await this.refreshCache(`${SHEET_NAMES.APPOINTMENTS}!A2:O`);
    } catch (error) {
      console.error('Error updating appointment:', error);
      throw new Error('Failed to update appointment');
    }
  }
    
  async getAppointment(appointmentId: string): Promise<AppointmentRecord | null> {
    try {
      const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A2:O`);
      if (!values) return null;
  
      const appointmentRow = values.find((row: SheetRow) => row[0] === appointmentId);
      if (!appointmentRow) return null;
  
      return {
        appointmentId: appointmentRow[0],
        clientId: appointmentRow[1],
        clientName: appointmentRow[2],
        clinicianId: appointmentRow[3],
        clinicianName: appointmentRow[4],
        officeId: appointmentRow[5],
        sessionType: appointmentRow[6] as 'in-person' | 'telehealth' | 'group' | 'family',
        startTime: appointmentRow[7],
        endTime: appointmentRow[8],
        status: appointmentRow[9] as 'scheduled' | 'completed' | 'cancelled' | 'rescheduled',
        lastUpdated: appointmentRow[10],
        source: appointmentRow[11] as 'intakeq' | 'manual',
        requirements: JSON.parse(appointmentRow[12] || '{}'),
        notes: appointmentRow[13],
        suggestedOfficeId: appointmentRow[14] || appointmentRow[5]
      };
    } catch (error) {
      console.error('Error getting appointment:', error);
      return null;
    }
  }

  async deleteAppointment(appointmentId: string): Promise<void> {
    try {
      const values = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A:A`);
      const appointmentRow = values?.findIndex((row: SheetRow) => row[0] === appointmentId);

      if (!values || appointmentRow === undefined || appointmentRow < 0) {
        throw new Error(`Appointment ${appointmentId} not found`);
      }

      await this.sheets.spreadsheets.values.clear({
        spreadsheetId: this.spreadsheetId,
        range: `${SHEET_NAMES.APPOINTMENTS}!A${appointmentRow + 1}:O${appointmentRow + 1}`
      });

      await this.refreshCache(`${SHEET_NAMES.APPOINTMENTS}!A2:O`);
      
      await this.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.APPOINTMENT_DELETED,
        description: `Deleted appointment ${appointmentId}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({ appointmentId })
      });
    } catch (error) {
      console.error('Error deleting appointment:', error);
      throw new Error('Failed to delete appointment');
    }
  }

  async updateClientPreference(preference: ClientPreference): Promise<void> {
    try {
      const values = await this.readSheet(`${SHEET_NAMES.CLIENT_PREFERENCES}!A:A`);
      const clientRow = values?.findIndex((row: SheetRow) => row[0] === preference.clientId);
      
      const rowData = [
        preference.clientId,
        preference.name,
        preference.email,
        JSON.stringify(preference.mobilityNeeds),
        JSON.stringify(preference.sensoryPreferences),
        JSON.stringify(preference.physicalNeeds),
        preference.roomConsistency.toString(),
        JSON.stringify(preference.supportNeeds),
        preference.additionalNotes || '',
        new Date().toISOString(),
        preference.preferredClinician || '',
        preference.assignedOffice || ''
      ];

      if (clientRow !== undefined && clientRow > 0) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${SHEET_NAMES.CLIENT_PREFERENCES}!A${clientRow + 1}:L${clientRow + 1}`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [rowData]
          }
        });
      } else {
        await this.appendRows(`${SHEET_NAMES.CLIENT_PREFERENCES}!A:L`, [rowData]);
      }

      await this.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.CLIENT_PREFERENCES_UPDATED,
        description: `Updated preferences for client ${preference.clientId}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify(preference)
      });

      await this.refreshCache(`${SHEET_NAMES.CLIENT_PREFERENCES}!A2:L`);
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

  private extractSensoryPreferences(responses: Record<string, any>): string[] {
    const preferences: string[] = [];
    
    const sensoryField = responses['Do you experience sensory sensitivities?'] || [];
    if (Array.isArray(sensoryField)) {
      if (sensoryField.includes('Light sensitivity')) preferences.push('light_sensitive');
      if (sensoryField.includes('Preference for only natural light')) preferences.push('natural_light');
      if (sensoryField.includes('Auditory sensitivity')) preferences.push('sound_sensitive');
    }
    
    const otherSensory = responses['Other (Please specify):'];
    if (otherSensory) preferences.push(otherSensory);
    
    return preferences;
  }

  private extractPhysicalNeeds(responses: Record<string, any>): string[] {
    const needs: string[] = [];
    
    const physicalField = responses['Do you experience challenges with physical environment?'] || [];
    if (Array.isArray(physicalField)) {
      if (physicalField.includes('Seating support')) needs.push('seating_support');
      if (physicalField.includes('Difficulty with stairs')) needs.push('no_stairs');
      if (physicalField.includes('Need to see the door')) needs.push('door_visible');
    }
    
    return needs;
  }

  private extractRoomConsistency(responses: Record<string, any>): number {
    const value = responses['Please indicate your comfort level with this possibility:'];
    const consistencyMap: Record<string, number> = {
      '1 - Strong preference for consistency': 5,
      '2 - High preference for consistency': 4,
      '3 - Neutral about room changes': 3,
      '4 - Somewhat comfortable with room changes when needed': 2,
      '5 - Very comfortable with room changes when needed': 1
    };
    
    return consistencyMap[value] || 3;
  }

  private extractSupportNeeds(responses: Record<string, any>): string[] {
    const needs: string[] = [];
    
    const supportField = responses['Do you have support needs that involve any of the following?'] || [];
    if (Array.isArray(supportField)) {
      if (supportField.includes('Space for a service animal')) needs.push('service_animal');
      if (supportField.includes('A support person present')) needs.push('support_person');
      if (supportField.includes('The use of communication aids')) needs.push('communication_aids');
    }
    
    return needs;
  }

  async processAccessibilityForm(formData: {
    clientId: string;
    clientName: string;
    clientEmail: string;
    formResponses: Record<string, any>;
  }): Promise<void> {
    try {
      const preference: ClientPreference = {
        clientId: formData.clientId,
        name: formData.clientName,
        email: formData.clientEmail,
        mobilityNeeds: this.extractMobilityNeeds(formData.formResponses),
        sensoryPreferences: this.extractSensoryPreferences(formData.formResponses),
        physicalNeeds: this.extractPhysicalNeeds(formData.formResponses),
        roomConsistency: this.extractRoomConsistency(formData.formResponses),
        supportNeeds: this.extractSupportNeeds(formData.formResponses),
        specialFeatures: [], // Will be derived from other preferences
        additionalNotes: formData.formResponses['Is there anything else we should know about your space or accessibility needs?'] || '',
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
        systemNotes: JSON.stringify(formData.formResponses)
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

export default GoogleSheetsService;