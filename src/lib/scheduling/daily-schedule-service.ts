// src/lib/scheduling/daily-schedule-service.ts

import { GoogleSheetsService, AuditEventType } from '../google/sheets';
import { 
  formatESTTime, 
  getESTDayRange, 
  getDisplayDate, 
  isValidISODate,
  getTodayEST
} from '../util/date-helpers';
import { 
  AppointmentRecord, 
  standardizeOfficeId,
  normalizeAppointmentRecord,
  RulePriority
} from '../../types/scheduling';
import { isAccessibleOffice } from '../util/office-id'; // Only import isAccessibleOffice, not standardizeOfficeId
import { IntakeQService } from '../intakeq/service';
import { AppointmentSyncHandler } from '../intakeq/appointment-sync';
import type { IntakeQWebhookPayload } from '../../types/webhooks';
import { WebhookEventType } from '../../types/webhooks';

export interface DailyScheduleData {
  date: string;
  displayDate: string;
  appointments: ProcessedAppointment[];
  conflicts: ScheduleConflict[];
  conflictsByClinicianMap?: Record<string, ScheduleConflict[]>;
  stats: {
    totalAppointments: number;
    inPersonCount: number;
    telehealthCount: number;
    groupCount: number;
    familyCount: number;
    officeUtilization: Record<string, number>;
  };
}

export interface ProcessedAppointment {
  appointmentId: string;
  clientName: string;
  clinicianName: string;
  officeId: string;
  officeDisplay: string;
  startTime: string;
  endTime: string;
  formattedTime: string;
  sessionType: string;
  hasSpecialRequirements: boolean;
  requirements?: {
    accessibility?: boolean;
    specialFeatures?: string[];
  };
  notes?: string;
  assignmentReason?: string;      // Added to display assignment reason
  requiresOfficeChange?: boolean; // Flag for office changes
  previousOffice?: string;        // Track previous office
  ageGroup?: string;              // Added to track client age group if available
}

export interface ScheduleConflict {
  type: 'double-booking' | 'capacity' | 'accessibility' | 'requirements';
  description: string;
  severity: 'high' | 'medium' | 'low';
  appointmentIds?: string[];
  officeId?: string;
  timeBlock?: string;
  clinicianIds?: string[];
  resolutionSuggestion?: string;  // Added to suggest potential resolution
}

export class DailyScheduleService {
  private sheetsService: GoogleSheetsService;
  
  constructor(sheetsService?: GoogleSheetsService) {
    this.sheetsService = sheetsService || new GoogleSheetsService();
  }

  /**
   * Fetch and process schedule data for a specific date
   */
  async generateDailySchedule(date: string): Promise<DailyScheduleData> {
    try {
      console.log(`Generating daily schedule for ${date}`);
      
      // Validate the date parameter
      if (!isValidISODate(date)) {
        const today = getTodayEST();
        console.warn(`Invalid date provided: ${date}, using today's date (${today}) instead`);
        date = today;
      }
      
      // 1. Get the date range for the target day
      const { start, end } = getESTDayRange(date);
      console.log(`Date range in EST: ${start} to ${end}`);
      
      // For debugging, explicitly log how we're querying for appointments
      console.log(`Searching for appointments between ${new Date(start).toISOString()} and ${new Date(end).toISOString()}`);
      
      // 2. Get all appointments for the date with extra debug logging
      let appointments = await this.sheetsService.getAppointments(start, end);
      console.log(`Found ${appointments.length} appointments for ${date}`);
      
      // Log each appointment found to help debug
      appointments.forEach(appt => {
        console.log(`Found appointment: ${appt.appointmentId}, time: ${appt.startTime}, client: ${appt.clientName}`);
      });
      
      // 3. Get all offices for reference
      const offices = await this.sheetsService.getOffices();
      console.log(`Found ${offices.length} offices`);
      
      // 4. Resolve office assignments from scratch, regardless of existing assignments
      appointments = await this.resolveOfficeAssignments(appointments);
      
      // 5. Process appointments for display with improved office change tracking
      const processedAppointments = this.processAppointments(appointments, offices);
      
      // 6. Detect conflicts using updated logic with assignedOfficeId
      let conflicts = this.detectConflicts(processedAppointments);
      
      // 7. Group conflicts by clinician
      const conflictsByClinicianMap = new Map<string, ScheduleConflict[]>();
      
      conflicts.forEach(conflict => {
        if (conflict.clinicianIds) {
          conflict.clinicianIds.forEach(clinicianName => {
            if (!conflictsByClinicianMap.has(clinicianName)) {
              conflictsByClinicianMap.set(clinicianName, []);
            }
            conflictsByClinicianMap.get(clinicianName)?.push(conflict);
          });
        }
      });
      
      // 8. Log audit entry for schedule generation
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.DAILY_ASSIGNMENTS_UPDATED,
        description: `Generated daily schedule for ${date}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          date,
          displayDate: getDisplayDate(date),
          appointmentCount: appointments.length,
          assignedCount: appointments.filter(a => a.assignedOfficeId && a.assignedOfficeId !== 'TBD').length,
          conflictCount: conflicts.length
        })
      });
      
      // 9. Return compiled data with clinician-specific conflicts
      return {
        date,
        displayDate: getDisplayDate(date),
        appointments: processedAppointments,
        conflicts,
        conflictsByClinicianMap: Object.fromEntries(conflictsByClinicianMap),
        stats: this.calculateStats(processedAppointments)
      };
    } catch (error) {
      console.error('Error generating daily schedule:', error);
      
      // Log error to audit system
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: `Failed to generate daily schedule for ${date}`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      throw error;
    }
  }

  /**
 * Extract assigned office from notes and/or requiredOffice field
 * Updated to handle various office ID formats including non-hyphenated ones
 */
private extractAssignedOfficeFromNotes(notes: string, requiredOffice?: string): string {
  // First check for explicit requiredOffice field
  if (requiredOffice && requiredOffice.trim() !== '') {
    console.log(`  Found explicit requiredOffice: ${requiredOffice.trim()}`);
    
    const cleanedOfficeId = requiredOffice.trim();
    
    // Check if the office ID matches standard pattern
    if (/^[A-C]-[0-9v]$/.test(cleanedOfficeId)) {
      return cleanedOfficeId; // Already in standard format
    }
    
    // Check if it's a non-hyphenated format (e.g., "C1" instead of "C-1")
    if (/^[A-C][0-9v]$/.test(cleanedOfficeId)) {
      const floor = cleanedOfficeId.charAt(0);
      const unit = cleanedOfficeId.charAt(1);
      const standardFormat = `${floor}-${unit}`;
      console.log(`  Standardizing office format from ${cleanedOfficeId} to ${standardFormat}`);
      return standardFormat;
    }
    
    // For other formats, just return as is
    return cleanedOfficeId;
  }
  
  // Fall back to parsing from notes if field is not set
  if (!notes) return '';
  
  // Check for patterns like "Assigned Office: B-4" in notes
  const officeMatch = notes.match(/assigned\s+office:?\s*([A-C]-?\d+|A-?v)/i);
  if (officeMatch && officeMatch[1]) {
    console.log(`  Found office ID in notes text: ${officeMatch[1]}`);
    
    // Standardize format if needed
    const extractedId = officeMatch[1];
    if (/^[A-C][0-9v]$/.test(extractedId)) {
      const floor = extractedId.charAt(0);
      const unit = extractedId.charAt(1);
      return `${floor}-${unit}`;
    }
    
    return extractedId;
  }
  
  return '';
}

  /**
 * Resolve office assignments using strict rule priority
 * This is the most critical method - it applies assignment rules in strict priority order
 * and disregards existing office assignments completely
 */
/**
 * Resolve office assignments using strict rule priority
 * This is the most critical method - it applies assignment rules in strict priority order
 * and disregards existing office assignments completely
 * Updated to consider tags for priority 100 (specific office) and 90 (mobility)
 */
private async resolveOfficeAssignments(appointments: AppointmentRecord[]): Promise<AppointmentRecord[]> {
  try {
    console.log('Resolving office assignments using strict priority rules');
    
    // Get necessary configuration data for rule application
    const offices = await this.sheetsService.getOffices();
    const activeOffices = offices.filter(o => o.inService === true);
    const clinicians = await this.sheetsService.getClinicians();
    const rules = await this.sheetsService.getAssignmentRules();
    // Get client preferences from the accessibility info instead
    const clientPreferences = await this.sheetsService.getClientPreferences();
    
    console.log(`Loaded ${activeOffices.length} active offices, ${rules.length} rules`);
    console.log('Active Offices:', activeOffices.map(o => `${o.officeId} (${o.name || 'unnamed'})`).join(', '));
    if (clinicians.length > 0) {
      console.log('Clinician preferred offices by name:');
      clinicians.forEach(c => {
        console.log(`  ${c.name}: ${c.preferredOffices?.join(', ') || 'None'}`);
      });
    }  

    // Sort rules by priority (highest first)
    const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);
    
    // Track office assignments for logging
    const assignmentLog: Record<string, string> = {};
    
    // Process each appointment that needs office assignment
    const updatedAppointments = await Promise.all(
      appointments.map(async (appt) => {
        // Skip if appointment is cancelled or rescheduled
        if (appt.status === 'cancelled' || appt.status === 'rescheduled') {
          return appt;
        }
        
        // Log the appointment we're processing
        const apptKey = `${appt.appointmentId} (${appt.clientName})`;
        console.log(`\n------------------------------------------------`);
        console.log(`Resolving office for appointment ${apptKey}: ${appt.clientName} with ${appt.clinicianName}`);
        console.log(`Session type: ${appt.sessionType}, Time: ${new Date(appt.startTime).toLocaleString()}`);
        
        // NEW: Log tags if present
        if (appt.tags && appt.tags.length > 0) {
          console.log(`Appointment has tags: ${appt.tags.join(', ')}`);
        }
        
        console.log(`------------------------------------------------`);
        
        // IMPORTANT: We are disregarding existing assignments and starting fresh
        
        // Get data needed for rule application
        const clinician = clinicians.find(c => c.clinicianId === appt.clinicianId || c.name === appt.clinicianName);
        
        // Get client accessibility info - critical for several rules
        const clientAccessibility = await this.sheetsService.getClientAccessibilityInfo(appt.clientId);

        // Debug logging for client accessibility info
        if (clientAccessibility) {
          console.log(`Found accessibility info for client ${appt.clientName} (ID: ${appt.clientId})`);
          console.log(`  Has mobility needs: ${clientAccessibility.hasMobilityNeeds}`);
          console.log(`  Has required office: ${clientAccessibility.requiredOffice ? 'Yes - ' + clientAccessibility.requiredOffice : 'No'}`);
        } else {
          console.log(`No accessibility info found for client ${appt.clientName} (ID: ${appt.clientId})`);
          
          // Check client ID format to help with debugging
          console.log(`  Client ID format check: Type=${typeof appt.clientId}, Length=${appt.clientId.length}`);
          
          // Try alternative formats of client ID
          try {
            // Try with a numeric ID if the current ID is a string
            if (typeof appt.clientId === 'string' && !isNaN(Number(appt.clientId))) {
              const numericId = Number(appt.clientId).toString();
              if (numericId !== appt.clientId) {
                console.log(`  Trying alternative numeric format: ${numericId}`);
                const altCheck = await this.sheetsService.getClientAccessibilityInfo(numericId);
                if (altCheck) {
                  console.log(`  Found record with numeric ID format!`);
                  console.log(`  Has mobility needs: ${altCheck.hasMobilityNeeds}`);
                  console.log(`  Has required office: ${altCheck.requiredOffice ? 'Yes - ' + altCheck.requiredOffice : 'No'}`);
                } else {
                  console.log(`  No record found with numeric ID format`);
                }
              }
            }
          } catch (e) {
            console.log(`  Error checking alternative ID formats: ${e}`);
          }
        }
        
        // Get client preferences
        const clientPreference = clientPreferences.find(p => p.clientId === appt.clientId);
        
        // Apply rules in priority order
        let assignedOffice = null;
        let assignmentReason = '';
        
        // First, log what we found for this appointment
        if (clientPreference?.assignedOffice) {
          console.log(`  Client ${appt.clientName} has assigned office: ${clientPreference.assignedOffice}`);
        }
        
        if (clientAccessibility?.hasMobilityNeeds) {
          console.log(`  Client ${appt.clientName} has mobility needs`);
        }
        
        if (clinician) {
          console.log(`  Clinician ${clinician.name} preferred offices: ${clinician.preferredOffices?.join(', ') || 'None'}`);
        }
        
        // Try to determine client age if available (for age-based rules)
        let clientAge: number | null = null;
        try {
          // Direct access to DOB from appointment record
          if (appt.clientDateOfBirth && appt.clientDateOfBirth.trim() !== '') {
            const dobDate = new Date(appt.clientDateOfBirth);
            
            // Ensure we have a valid date
            if (!isNaN(dobDate.getTime())) {
              // Calculate age based on appointment date, not current date
              const appointmentDate = new Date(appt.startTime);
              let age = appointmentDate.getFullYear() - dobDate.getFullYear();
              
              // Adjust age if birthday hasn't occurred yet this year
              const monthDiff = appointmentDate.getMonth() - dobDate.getMonth();
              if (monthDiff < 0 || (monthDiff === 0 && appointmentDate.getDate() < dobDate.getDate())) {
                age--;
              }
              
              clientAge = age;
              console.log(`Client age determined as: ${clientAge} from DOB: ${appt.clientDateOfBirth}`);
            } else {
              console.log(`Invalid DOB format for client ${appt.clientName}: ${appt.clientDateOfBirth}`);
            }
          } else {
            console.log(`No DOB found for client ${appt.clientName}, age-based rules will be skipped`);
          }
        } catch (error) {
          console.log(`Error determining age for client ${appt.clientName}: ${error}`);
        }

        // Add a summary of key client factors for rule application
        console.log(`---------------------------------------------`);
        console.log(`RULE APPLICATION SUMMARY FOR: ${appt.clientName}`);
        console.log(`Session Type: ${appt.sessionType}`);
        console.log(`Age: ${clientAge !== null ? clientAge : 'unknown'}`);
        console.log(`Has Accessibility Info: ${clientAccessibility !== null}`);
        if (clientAccessibility) {
          console.log(`Mobility Needs: ${clientAccessibility.hasMobilityNeeds}`);
          console.log(`Required Office: ${clientAccessibility.requiredOffice || 'None'}`);
        }
        console.log(`Clinician: ${appt.clinicianName} (${appt.clinicianId})`);
        if (clinician) {
          console.log(`Clinician Preferred Offices: ${clinician.preferredOffices?.join(', ') || 'None'}`);
        }
        // NEW: Show tags information in summary
        if (appt.tags && appt.tags.length > 0) {
          console.log(`Tags: ${appt.tags.join(', ')}`);
        } else {
          console.log(`Tags: None`);
        }
        console.log(`---------------------------------------------`);
        
        // NEW: RULE PRIORITY 100 (TAG-BASED): Check for specific office tag
        if (!assignedOffice && appt.tags && appt.tags.length > 0) {
          console.log("Checking PRIORITY 100 (TAG-BASED): Office Tag");
          // Look for tags matching office IDs (case-insensitive)
          const officeTags = appt.tags.filter(tag => 
            /^[a-c]-[0-9v]$/i.test(tag) || // Match format like "b-4", "c-1", "a-v"
            /^[a-c][0-9v]$/i.test(tag)     // Also match format like "b4", "c1", "av"
          );
          
          if (officeTags.length > 0) {
            // Take the first matching office tag
            let officeTag = officeTags[0].toLowerCase();
            
            // Normalize format if needed (convert b4 to b-4)
            if (/^[a-c][0-9v]$/.test(officeTag)) {
              officeTag = `${officeTag[0]}-${officeTag[1]}`;
            }
            
            assignedOffice = standardizeOfficeId(officeTag);
            assignmentReason = `Client has specific office tag ${officeTag} (Priority ${RulePriority.CLIENT_SPECIFIC_REQUIREMENT} TAG)`;
            console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
          } else {
            console.log("  No office tag found, continuing to next rule");
          }
        }
        
        // ===============================================
        // RULE PRIORITY 100: Client Specific Requirement from accessibility info
        // ===============================================
        if (!assignedOffice) {
          console.log("Checking PRIORITY 100: Client Specific Requirement");
          if (clientAccessibility) {
            // Check both requiredOffice field and notes
            let clientSpecificOffice = this.extractAssignedOfficeFromNotes(
              clientAccessibility.additionalNotes || '',
              clientAccessibility.requiredOffice  // New field
            );
            
            if (clientSpecificOffice) {
              console.log(`  Found client specific office: "${clientSpecificOffice}"`);
              
              // Handle different formats of office IDs
              if (/^[A-C]-[0-9v]/.test(clientSpecificOffice)) {
                // Standard format (e.g., "B-4", "C-3", "A-v")
                assignedOffice = standardizeOfficeId(clientSpecificOffice);
                console.log(`  Using standard office ID: ${assignedOffice}`);
              } else if (clientSpecificOffice.includes('-')) {
                // Might be a UUID format
                console.log(`  Legacy office ID (UUID format): ${clientSpecificOffice}`);
                // Try to map this UUID to a standard office ID
                // For now, use it as is or set a fallback
                assignedOffice = clientSpecificOffice;
              } else {
                // Could be a simple name without hyphen (e.g., "C1" instead of "C-1")
                // Try to standardize it
                if (/^[A-C][0-9v]$/.test(clientSpecificOffice)) {
                  // Format like "C1", "B4", "Av"
                  const floor = clientSpecificOffice.charAt(0);
                  const unit = clientSpecificOffice.charAt(1);
                  assignedOffice = standardizeOfficeId(`${floor}-${unit}`);
                  console.log(`  Converted simple format ${clientSpecificOffice} to ${assignedOffice}`);
                } else {
                  // Unknown format, use as is
                  console.log(`  Unknown office ID format: ${clientSpecificOffice}`);
                  assignedOffice = clientSpecificOffice;
                }
              }
              
              assignmentReason = `Client has specific office requirement (Priority ${RulePriority.CLIENT_SPECIFIC_REQUIREMENT})`;
              console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
            }
          }
        }
        
        // NEW: RULE PRIORITY 90 (TAG-BASED): Check for mobility tag
        if (!assignedOffice && appt.tags && appt.tags.includes('mobility')) {
          console.log("Checking PRIORITY 90 (TAG-BASED): Mobility Tag");
          // Prioritize B-4, B-5 as specified in rule
          const accessibleOffices = ['B-4', 'B-5'];
          
          console.log(`  Client has mobility tag, checking accessible offices: ${accessibleOffices.join(', ')}`);
          
          for (const officeId of accessibleOffices) {
            console.log(`  Checking accessible office: ${officeId}`);
            const matchingOffice = activeOffices.find(o => 
              standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId)
            );
            
            if (matchingOffice) {
              const available = await this.isOfficeAvailable(matchingOffice.officeId, appt, appointments);
              console.log(`  Office ${officeId} availability: ${available ? 'Available' : 'NOT Available'}`);
              if (available) {
                assignedOffice = standardizeOfficeId(matchingOffice.officeId);
                assignmentReason = `Client has mobility tag (Priority ${RulePriority.ACCESSIBILITY_REQUIREMENT} TAG)`;
                console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                break;
              }
            } else {
              console.log(`  Office ${officeId} not found in active offices list`);
            }
          }
        }
        
        // ==========================================
        // RULE PRIORITY 90: Accessibility Requirement from accessibility info
        // ==========================================
        if (!assignedOffice) {
          console.log("Checking PRIORITY 90: Accessibility Requirement");
          if (clientAccessibility?.hasMobilityNeeds) {
            console.log(`  Client has mobility needs, checking accessible offices`);
            
            // Prioritize B-4, B-5 as specified in rule
            const accessibleOffices = ['B-4', 'B-5'];
            
            for (const officeId of accessibleOffices) {
              console.log(`  Checking accessible office: ${officeId}`);
              const matchingOffice = activeOffices.find(o => 
                standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId)
              );
              
              if (matchingOffice) {
                const available = await this.isOfficeAvailable(matchingOffice.officeId, appt, appointments);
                console.log(`  Office ${officeId} availability: ${available ? 'Available' : 'NOT Available'}`);
                if (available) {
                  assignedOffice = standardizeOfficeId(matchingOffice.officeId);
                  assignmentReason = `Client requires accessible office (Priority ${RulePriority.ACCESSIBILITY_REQUIREMENT})`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  break;
                }
              } else {
                console.log(`  Office ${officeId} not found in active offices list`);
              }
            }
          } else {
            console.log(`  Client does not have mobility needs, skipping accessibility rule`);
          }
        }

        // ===============================
        // RULE PRIORITY 80: Young Children
        // ===============================
        if (!assignedOffice) {
          console.log("Checking PRIORITY 80: Young Children rule");
          if (clientAge !== null) {
            console.log(`  Client age is ${clientAge} years old`);
            if (clientAge <= 10) {
              console.log(`  MATCH! Client is ${clientAge} years old (≤10), should use Young Children rule`);
              console.log(`  Checking B-5 availability first`);
              
              // First try B-5 (primary for young children)
              const b5Office = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'B-5');
              if (b5Office) {
                // Check if B-5 is available
                const available = await this.isOfficeAvailable('B-5', appt, appointments);
                console.log(`  B-5 availability check result: ${available ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
                
                if (available) {
                  assignedOffice = 'B-5';
                  assignmentReason = `Young child (${clientAge} years old) assigned to B-5 (Priority ${RulePriority.YOUNG_CHILDREN})`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                } else {
                  console.log(`  B-5 not available, will try fallback options`);
                }
              } else {
                console.log(`  B-5 office not found in active offices list`);
              }
              
              // If B-5 not available, check if C-1 can be used as fallback
              if (!assignedOffice) {
                console.log(`  Checking if C-1 can be used as fallback for young child`);
                const c1Office = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'C-1');
                
                if (c1Office) {
                  // Check if C-1 is available
                  const available = await this.isOfficeAvailable('C-1', appt, appointments);
                  console.log(`  C-1 availability check result: ${available ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
                  
                  if (available) {
                    assignedOffice = 'C-1';
                    assignmentReason = `Young child (${clientAge} years old) assigned to C-1 as fallback (Priority ${RulePriority.YOUNG_CHILDREN})`;
                    console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  } else {
                    console.log(`  C-1 not available either, will continue to next priority rule`);
                  }
                } else {
                  console.log(`  C-1 office not found in active offices list`);
                }
              }
            } else {
              console.log(`  Client age ${clientAge} is > 10, skipping Young Children rule`);
            }
          } else {
            console.log(`  Client age is unknown, skipping Young Children rule`);
          }
        }

        // =======================================
        // RULE PRIORITY 75: Older Children and Teens
        // =======================================
        if (!assignedOffice) {
          console.log("Checking PRIORITY 75: Older Children and Teens rule");
          if (clientAge !== null) {
            console.log(`  Client age is ${clientAge} years old`);
            if (clientAge >= 11 && clientAge <= 17) {
              console.log(`  MATCH! Client is ${clientAge} years old (11-17), should use Older Children/Teens rule`);
              console.log(`  Checking C-1 availability first`);
              
              // First try C-1 (primary for older children/teens)
              const c1Office = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'C-1');
              if (c1Office) {
                // Check if C-1 is available
                const available = await this.isOfficeAvailable('C-1', appt, appointments);
                console.log(`  C-1 availability check result: ${available ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
                
                if (available) {
                  assignedOffice = 'C-1';
                  assignmentReason = `Older child/teen (${clientAge} years old) assigned to C-1 (Priority ${RulePriority.OLDER_CHILDREN_TEENS})`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                } else {
                  console.log(`  C-1 not available, will try fallback options`);
                }
              } else {
                console.log(`  C-1 office not found in active offices list`);
              }
              
              // If C-1 not available, check if B-5 can be used as fallback
              if (!assignedOffice) {
                console.log(`  Checking if B-5 can be used as fallback for older child/teen`);
                const b5Office = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'B-5');
                
                if (b5Office) {
                  // Check if B-5 is available
                  const available = await this.isOfficeAvailable('B-5', appt, appointments);
                  console.log(`  B-5 availability check result: ${available ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
                  
                  if (available) {
                    assignedOffice = 'B-5';
                    assignmentReason = `Older child/teen (${clientAge} years old) assigned to B-5 as fallback (Priority ${RulePriority.OLDER_CHILDREN_TEENS})`;
                    console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  } else {
                    console.log(`  B-5 not available either, will continue to next priority rule`);
                  }
                } else {
                  console.log(`  B-5 office not found in active offices list`);
                }
              }
            } else {
              console.log(`  Client age ${clientAge} is not 11-17, skipping Older Children/Teens rule`);
            }
          } else {
            console.log(`  Client age is unknown, skipping Older Children/Teens rule`);
          }
        }

        // Rest of the rules (65 through 10) remain unchanged...
        // ===============================
        // RULE PRIORITY 65: Clinician Primary Office
        // ===============================
        if (!assignedOffice && clinician) {
          // Check if clinician has a primary/preferred office
          if (clinician.preferredOffices && clinician.preferredOffices.length > 0) {
            // First preferred office is considered the primary
            const primaryOfficeId = clinician.preferredOffices[0];
            const available = await this.isOfficeAvailable(primaryOfficeId, appt, appointments);
            
            if (available) {
              assignedOffice = standardizeOfficeId(primaryOfficeId);
              assignmentReason = `Assigned to clinician's primary office (Priority ${RulePriority.CLINICIAN_PRIMARY_OFFICE})`;
              console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
            }
          }
        }

        // ===============================
        // RULE PRIORITY 62: Clinician Preferred Office
        // ===============================
        if (!assignedOffice && clinician && clinician.preferredOffices?.length > 1) {
          console.log(`  Checking clinician preferred offices: ${clinician.preferredOffices.slice(1).join(', ')}`);
          
          // Start from the second preferred office (first one was checked in previous rule)
          for (let i = 1; i < clinician.preferredOffices.length; i++) {
            const officeId = clinician.preferredOffices[i];
            const available = await this.isOfficeAvailable(officeId, appt, appointments);
            
            if (available) {
              assignedOffice = standardizeOfficeId(officeId);
              assignmentReason = `Assigned to clinician's preferred office (Priority ${RulePriority.CLINICIAN_PREFERRED_OFFICE})`;
              console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
              break;
            }
          }
        }

        // ===============================
        // RULE PRIORITY 55: Adult Client Assignments (moved down from 70)
        // ===============================
        if (!assignedOffice && clientAge !== null && clientAge >= 18) {
          console.log(`  Client is an adult (${clientAge} years old), checking primary adult offices`);
          
          // Try B-4, C-2, C-3 in order (primary adult offices)
          const primaryAdultOffices = ['B-4', 'C-2', 'C-3'];
          
          for (const officeId of primaryAdultOffices) {
            const office = activeOffices.find(o => standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId));
            if (office) {
              const available = await this.isOfficeAvailable(officeId, appt, appointments);
              if (available) {
                assignedOffice = standardizeOfficeId(officeId);
                assignmentReason = `Adult client assigned to ${officeId} (Priority ${RulePriority.ADULTS})`;
                console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                break;
              }
            }
          }
          
          // If no primary adult office is available, try B-5 and C-1
          if (!assignedOffice) {
            const secondaryAdultOffices = ['B-5', 'C-1'];
            
            for (const officeId of secondaryAdultOffices) {
              const office = activeOffices.find(o => standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId));
              if (office) {
                const available = await this.isOfficeAvailable(officeId, appt, appointments);
                if (available) {
                  assignedOffice = standardizeOfficeId(officeId);
                  assignmentReason = `Adult client assigned to ${officeId} as secondary option (Priority ${RulePriority.ADULTS})`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  break;
                }
              }
            }
          }
        }

        // ===============================
        // RULE PRIORITY 50: In-Person Priority (moved down from 55)
        // ===============================
        if (!assignedOffice && appt.sessionType === 'in-person') {
          console.log('  In-person session, checking all physical offices');
          
          // Try all physical offices in order: B-4, B-5, C-1, C-2, C-3
          const physicalOffices = ['B-4', 'B-5', 'C-1', 'C-2', 'C-3'];
          
          for (const officeId of physicalOffices) {
            const office = activeOffices.find(o => standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId));
            if (office) {
              const available = await this.isOfficeAvailable(officeId, appt, appointments);
              if (available) {
                assignedOffice = standardizeOfficeId(officeId);
                assignmentReason = `In-person session assigned to ${officeId} (Priority ${RulePriority.IN_PERSON_PRIORITY})`;
                console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                break;
              }
            }
          }
        }

        // ===============================
        // RULE PRIORITY 40: Telehealth to Preferred Office
        // ===============================
        if (!assignedOffice && appt.sessionType === 'telehealth' && clinician && clinician.preferredOffices) {
          console.log(`  Checking telehealth assignment to clinician's preferred office`);
          
          for (const officeId of clinician.preferredOffices) {
            const office = activeOffices.find(o => 
              standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId)
            );
            
            if (office) {
              const available = await this.isOfficeAvailable(officeId, appt, appointments);
              
              if (available) {
                assignedOffice = standardizeOfficeId(officeId);
                assignmentReason = `Telehealth assigned to clinician's preferred office (Priority ${RulePriority.TELEHEALTH_PREFERRED})`;
                console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                break;
              }
            }
          }
        }
        
        // ===============================
        // RULE PRIORITY 35: Special Features Match
        // ===============================
        if (!assignedOffice && appt.requirements?.specialFeatures?.length) {
          console.log(`  Client has special features requirements`);
          
          // Check each office for matching features
          for (const office of activeOffices) {
            if (office.specialFeatures && office.specialFeatures.length > 0) {
              // Check if any client features match office features
              const hasMatch = appt.requirements.specialFeatures.some(feature => 
                office.specialFeatures.includes(feature)
              );
              
              if (hasMatch) {
                const available = await this.isOfficeAvailable(office.officeId, appt, appointments);
                
                if (available) {
                  assignedOffice = standardizeOfficeId(office.officeId);
                  assignmentReason = `Office has matching special features (Priority ${RulePriority.SPECIAL_FEATURES_MATCH})`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  break;
                }
              }
            }
          }
        }
        
        // ===============================
        // RULE PRIORITY 30: Alternative Clinician Office
        // ===============================
        if (!assignedOffice && clinician) {
          // Find offices where this clinician is listed as an alternative
          const alternativeOffices = activeOffices.filter(o => 
            o.alternativeClinicians && 
            o.alternativeClinicians.includes(clinician.clinicianId)
          );
          
          for (const office of alternativeOffices) {
            console.log(`  Checking alternative clinician office: ${office.officeId}`);
            const available = await this.isOfficeAvailable(office.officeId, appt, appointments);
            
            if (available) {
              assignedOffice = standardizeOfficeId(office.officeId);
              assignmentReason = `Assigned to alternative clinician office (Priority ${RulePriority.ALTERNATIVE_CLINICIAN})`;
              console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
              break;
            }
          }
        }
        
        // ===============================
        // RULE PRIORITY 20: Available Office
        // ===============================
        if (!assignedOffice) {
          console.log("  Checking any available office");
          // Check all offices for availability, exclude break room (B-1)
          for (const office of activeOffices) {
            if (office.officeId !== 'B-1') {
              const available = await this.isOfficeAvailable(office.officeId, appt, appointments);
              
              if (available) {
                assignedOffice = standardizeOfficeId(office.officeId);
                assignmentReason = `Assigned to available office ${office.officeId} (Priority ${RulePriority.AVAILABLE_OFFICE})`;
                console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                break;
              }
            }
          }
        }
        
        // ===============================
        // RULE PRIORITY 15: Break Room Last Resort
        // ===============================
        if (!assignedOffice && appt.sessionType !== 'telehealth') {
          const breakRoom = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'B-1');
          if (breakRoom) {
            const available = await this.isOfficeAvailable('B-1', appt, appointments);
            
            if (available) {
              assignedOffice = 'B-1';
              assignmentReason = `Break room used as last resort for physical session (Priority ${RulePriority.BREAK_ROOM_LAST_RESORT})`;
              console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
            }
          }
        }
        
        // ===============================
        // RULE PRIORITY 10: Default Telehealth
        // ===============================
        if (!assignedOffice && appt.sessionType === 'telehealth') {
          assignedOffice = 'A-v';
          assignmentReason = `Virtual office (A-v) for telehealth as last resort (Priority ${RulePriority.DEFAULT_TELEHEALTH})`;
          console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
        }
        
        // Final fallback - if nothing else worked
        if (!assignedOffice) {
          if (appt.sessionType === 'telehealth') {
            assignedOffice = 'A-v';
            assignmentReason = 'Default: Virtual office for telehealth as final fallback';
          } else {
            // Only assign B-1 if it's active, otherwise use first active office
            const breakRoom = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'B-1');
            if (breakRoom) {
              assignedOffice = 'B-1';
              assignmentReason = 'Default: Break room as final fallback';
            } else if (activeOffices.length > 0) {
              assignedOffice = standardizeOfficeId(activeOffices[0].officeId);
              assignmentReason = 'Default: First available office as final fallback';
            } else {
              assignedOffice = 'TBD';
              assignmentReason = 'Error: No active offices available';
            }
          }
          console.log(`  FALLBACK: ${assignmentReason} - Office ${assignedOffice}`);
        }
        
        // Store assignment reason for logging
        assignmentLog[apptKey] = assignmentReason;
        
        // Log final decision
        console.log(`\nFINAL ASSIGNMENT for ${appt.clientName}:`);
        console.log(`  Office: ${assignedOffice}`);
        console.log(`  Reason: ${assignmentReason}`);
        console.log(`------------------------------------------------\n`);
        
        // Return updated appointment (without adding clientAge property)
        return {
          ...appt,
          assignedOfficeId: assignedOffice,
          assignmentReason: assignmentReason
        };
      })
    );
    
    // Add a summary of rule application results
    console.log(`\n=== OFFICE ASSIGNMENT SUMMARY ===`);
    console.log(`Total appointments: ${updatedAppointments.length}`);

    // Count by rule priority
    const ruleCounts: Record<string, number> = {};
    updatedAppointments.forEach(appt => {
      if (appt.assignmentReason) {
        // Extract priority number from reason string
        const priorityMatch = appt.assignmentReason.match(/Priority\s+(\d+)/);
        const priority = priorityMatch ? priorityMatch[1] : 'Unknown';
        ruleCounts[priority] = (ruleCounts[priority] || 0) + 1;
      }
    });

    // Log the counts
    console.log(`Appointments by priority rule:`);
    Object.entries(ruleCounts)
      .sort((a, b) => Number(b[0]) - Number(a[0])) // Sort by priority (highest first)
      .forEach(([priority, count]) => {
        console.log(`  Priority ${priority}: ${count} appointments`);
      });

    // Show assignments for high priority clients (children and mobility needs) without relying on clientAge property
    console.log(`\nHigh priority client assignments:`);
    updatedAppointments.forEach(appt => {
      // Calculate age again for logging purposes only
      let displayAge = "unknown";
      if (appt.clientDateOfBirth && appt.clientDateOfBirth.trim() !== '') {
        try {
          const dobDate = new Date(appt.clientDateOfBirth);
          if (!isNaN(dobDate.getTime())) {
            const appointmentDate = new Date(appt.startTime);
            let age = appointmentDate.getFullYear() - dobDate.getFullYear();
            
            const monthDiff = appointmentDate.getMonth() - dobDate.getMonth();
            if (monthDiff < 0 || (monthDiff === 0 && appointmentDate.getDate() < dobDate.getDate())) {
              age--;
            }
            
            displayAge = age.toString();
          }
        } catch (e) {
          // keep displayAge as "unknown"
        }
      }
      
      // Check if appointment matches high priority rules based on reason
      const isHighPriority = appt.assignmentReason && (
        appt.assignmentReason.includes("Priority 100") || 
        appt.assignmentReason.includes("Priority 90") || 
        appt.assignmentReason.includes("Priority 80") || 
        appt.assignmentReason.includes("Priority 75")
      );
      
      if (isHighPriority) {
        console.log(`  ${appt.clientName} (Age: ${displayAge}, SessionType: ${appt.sessionType})`);
        console.log(`    Assigned to: ${appt.assignedOfficeId}, Reason: ${appt.assignmentReason}`);
      }
    });
    
    // Log audit entry with assignment details
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'OFFICE_ASSIGNMENTS_RESOLVED',
      description: `Resolved office assignments for ${updatedAppointments.length} appointments`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        assignmentReasons: assignmentLog
      })
    });
    
    // Update the appointments in the sheet if needed
    let updatesApplied = 0;
    for (const appt of updatedAppointments) {
      // Only update if assignedOfficeId changed or was not set
      if (appt.assignedOfficeId && 
          appt.assignedOfficeId !== 'TBD' && 
          (!appt.currentOfficeId || 
           appt.currentOfficeId === 'TBD' || 
           appt.assignedOfficeId !== appt.currentOfficeId)) {
        
        try {
          await this.sheetsService.updateAppointment({
            ...appt,
            lastUpdated: new Date().toISOString()
          });
          updatesApplied++;
        } catch (error) {
          console.error(`Error updating appointment ${appt.appointmentId}:`, error);
        }
      }
    }

    console.log(`Updated ${updatesApplied} appointments with new office assignments`);
    
    return updatedAppointments;
  } catch (error) {
    console.error('Error resolving office assignments:', error);
    
    // Log error
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'SYSTEM_ERROR',
      description: 'Error resolving office assignments',
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    return appointments; // Return original appointments on error
  }
}

  /**
   * Refresh IntakeQ appointments for a given date
   */
  async refreshAppointmentsFromIntakeQ(date: string): Promise<number> {
    try {
      // Validate date parameter
      if (!isValidISODate(date)) {
        const today = getTodayEST();
        console.warn(`Invalid date provided: ${date}, using today's date (${today}) instead`);
        date = today;
      }
      
      // Check for API disable flag
      if (process.env.DISABLE_API_CALLS === 'true') {
        console.log(`API DISABLED: Skipping IntakeQ refresh for date ${date}`);
        return 0;
      }
      
      console.log(`Refreshing appointments from IntakeQ for ${date}`);
      
      // 1. Initialize the IntakeQ service
      const intakeQService = new IntakeQService(this.sheetsService);
      
      // 2. Get the date range for the target day
      const { start, end } = getESTDayRange(date);
      console.log(`Date range in EST: ${start} to ${end}`);
      
      // 3. Fetch appointments from IntakeQ
      const appointments = await intakeQService.getAppointments(start, end);
      console.log(`Found ${appointments.length} appointments for ${date}`);
      
      if (appointments.length === 0) {
        return 0;
      }
      
      // 4. Initialize the AppointmentSyncHandler
      const appointmentSyncHandler = new AppointmentSyncHandler(this.sheetsService);
      
      let processed = 0;
      let errors = 0;
      
      // 5. Process each appointment
      for (const appointment of appointments) {
        try {
          // Ensure appointment has valid dates
          if (!appointment.StartDateIso || !isValidISODate(appointment.StartDateIso) ||
              !appointment.EndDateIso || !isValidISODate(appointment.EndDateIso)) {
            console.warn(`Skipping appointment ${appointment.Id} with invalid date format`);
            errors++;
            continue;
          }
          
          // Format appointment for webhook processing
          const webhookPayload: IntakeQWebhookPayload = {
            Type: 'AppointmentCreated' as WebhookEventType,
            ClientId: appointment.ClientId,
            Appointment: appointment
          };
          
          // Process as if it came from a webhook
          const result = await appointmentSyncHandler.processAppointmentEvent(webhookPayload);
          
          if (result.success) {
            processed++;
          } else {
            console.error(`Error processing appointment ${appointment.Id}:`, result.error);
            errors++;
          }
        } catch (error) {
          console.error(`Error processing appointment ${appointment.Id}:`, error);
          errors++;
        }
      }
      
      // 6. Log completion
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.DAILY_ASSIGNMENTS_UPDATED,
        description: `IntakeQ appointment refresh for ${date} completed`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          date,
          displayDate: getDisplayDate(date),
          total: appointments.length,
          processed,
          errors
        })
      });
      
      return processed;
    } catch (error) {
      console.error('Error refreshing appointments from IntakeQ:', error);
      
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: `Failed to refresh appointments from IntakeQ for ${date}`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      throw error;
    }
  }

  /**
   * Resolve scheduling conflicts by reassigning offices
   */
  async resolveSchedulingConflicts(date: string): Promise<number> {
    try {
      console.log(`Attempting to resolve scheduling conflicts for ${date}`);
      
      // 1. Get appointments for the day
      const { start, end } = getESTDayRange(date);
      const appointments = await this.sheetsService.getAppointments(start, end);
      
      // Only process active appointments
      const activeAppointments = appointments.filter(appt => 
        appt.status !== 'cancelled' && appt.status !== 'rescheduled'
      );
      
      console.log(`Found ${activeAppointments.length} active appointments to process`);
      
      // Get offices and detect conflicts - use existing conflict detection logic
      const offices = await this.sheetsService.getOffices();
      const processedAppointments = this.processAppointments(activeAppointments, offices);
      const conflicts = this.detectConflicts(processedAppointments);
      
      if (conflicts.length === 0) {
        console.log('No conflicts detected, nothing to resolve');
        return 0;
      }
      
      console.log(`Found ${conflicts.length} conflicts to resolve`);
      
      // Resolve each conflict
      let resolvedCount = 0;
      
      for (const conflict of conflicts) {
        if (!conflict.appointmentIds || conflict.appointmentIds.length < 2) {
          continue;
        }
        
        console.log(`Resolving conflict in ${conflict.officeId}: ${conflict.description}`);
        
        // Get the involved appointments
        const conflictAppointments = activeAppointments.filter(
          appt => conflict.appointmentIds?.includes(appt.appointmentId)
        );
        
        // Keep one appointment in place (preferably non-telehealth)
        conflictAppointments.sort((a, b) => {
          // Prioritize non-telehealth
          if (a.sessionType === 'telehealth' && b.sessionType !== 'telehealth') return 1;
          if (a.sessionType !== 'telehealth' && b.sessionType === 'telehealth') return -1;
          return 0;
        });
        
        // Appointment to keep
        const keepAppointment = conflictAppointments[0];
        // Appointments to relocate
        const moveAppointments = conflictAppointments.slice(1);
        
        console.log(`Keeping ${keepAppointment.clientName} with ${keepAppointment.clinicianName} in ${conflict.officeId}`);
        
        // Relocate other appointments
        for (const apptToMove of moveAppointments) {
          if (apptToMove.sessionType === 'telehealth') {
            // For telehealth, just move to A-v
            console.log(`Moving telehealth appointment to A-v: ${apptToMove.clientName}`);
            const updatedAppointment = {
              ...apptToMove,
              currentOfficeId: 'A-v',
              assignedOfficeId: 'A-v',
              assignmentReason: 'Conflict resolution: telehealth moved to virtual office',
              lastUpdated: new Date().toISOString()
            };
            
            await this.sheetsService.updateAppointment(updatedAppointment);
            resolvedCount++;
            continue;
          }
          
          // For in-person, find an alternative office
          const activeOffices = offices.filter(o => o.inService);
          const availableOffices = activeOffices.filter(office => {
            // Skip current office
            if (standardizeOfficeId(office.officeId) === standardizeOfficeId(conflict.officeId)) return false;
            
            // Check if office is available during this time
            const overlappingAppts = activeAppointments.filter(existingAppt => {
              if (existingAppt.appointmentId === apptToMove.appointmentId) return false;
              if (standardizeOfficeId(existingAppt.assignedOfficeId || existingAppt.currentOfficeId || '') !== standardizeOfficeId(office.officeId)) return false;
              
              // Check for time overlap
              const moveStart = new Date(apptToMove.startTime).getTime();
              const moveEnd = new Date(apptToMove.endTime).getTime();
              const existingStart = new Date(existingAppt.startTime).getTime();
              const existingEnd = new Date(existingAppt.endTime).getTime();
              
              return (
                (moveStart >= existingStart && moveStart < existingEnd) ||
                (moveEnd > existingStart && moveEnd <= existingEnd) ||
                (moveStart <= existingStart && moveEnd >= existingEnd)
              );
            });
            
            return overlappingAppts.length === 0;
          });
          
          if (availableOffices.length > 0) {
            // Select first available office
            const newOffice = availableOffices[0];
            console.log(`Moving ${apptToMove.clientName} to ${newOffice.officeId}`);
            
            const updatedAppointment = {
              ...apptToMove,
              assignedOfficeId: standardizeOfficeId(newOffice.officeId),
              assignmentReason: `Conflict resolution: moved from ${conflict.officeId} to resolve double-booking`,
              lastUpdated: new Date().toISOString()
            };
            
            await this.sheetsService.updateAppointment(updatedAppointment);
            resolvedCount++;
          } else {
            console.log(`No alternative office available for ${apptToMove.clientName}`);
          }
        }
      }
      
      console.log(`Successfully resolved ${resolvedCount} conflicts`);
      
      // Log audit entry
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.DAILY_ASSIGNMENTS_UPDATED,
        description: `Resolved scheduling conflicts for ${date}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          date,
          conflictsFound: conflicts.length,
          conflictsResolved: resolvedCount
        })
      });
      
      return resolvedCount;
    } catch (error) {
      console.error('Error resolving scheduling conflicts:', error);
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: `Failed to resolve scheduling conflicts for ${date}`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }
  
  /**
   * Process appointments for display with improved office change tracking
   */
  private processAppointments(
    appointments: AppointmentRecord[],
    offices: any[]
  ): ProcessedAppointment[] {
    // Sort appointments by clinician and time to detect office changes
    const sortedAppointments = [...appointments]
      .filter(appt => appt.status !== 'cancelled' && appt.status !== 'rescheduled')
      .sort((a, b) => {
        // First sort by clinician
        const clinicianCompare = a.clinicianName.localeCompare(b.clinicianName);
        if (clinicianCompare !== 0) return clinicianCompare;
        
        // Then by start time
        return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
      });
    
    // Track the last office used by each clinician
    const clinicianLastOffice: Record<string, string> = {};
    
    return sortedAppointments.map(appt => {
      // IMPORTANT: Prioritize assignedOfficeId as the new algorithm-determined assignment
      const displayOfficeId = appt.assignedOfficeId && appt.assignedOfficeId !== 'TBD' ? 
        standardizeOfficeId(appt.assignedOfficeId) : 
        appt.currentOfficeId && appt.currentOfficeId !== 'TBD' ?
          standardizeOfficeId(appt.currentOfficeId) :
          appt.sessionType === 'telehealth' ? 'A-v' : 'TBD';
      
      // Find office details
      const office = offices.find(o => standardizeOfficeId(o.officeId) === displayOfficeId);
      
      const hasSpecialRequirements = !!(
        appt.requirements?.accessibility || 
        (appt.requirements?.specialFeatures && appt.requirements.specialFeatures.length > 0)
      );
      
      // Check if this appointment requires an office change for the clinician
      const previousOffice = clinicianLastOffice[appt.clinicianName];
      let requiresOfficeChange: boolean | undefined = undefined;
      
      // Only set requiresOfficeChange if:
      // 1. We have a previous office
      // 2. Previous office is different from current office
      // 3. Not a virtual-to-virtual change (A-v to A-v)
      // 4. If current is telehealth (A-v), don't show change from physical office
      if (previousOffice) {
        if (displayOfficeId === 'A-v') {
          // For telehealth appointments, don't show office changes
          requiresOfficeChange = false;
        } else if (previousOffice === 'A-v') {
          // Coming from telehealth to physical is not a "change"
          requiresOfficeChange = false;
        } else {
          // For physical offices, show changes
          requiresOfficeChange = previousOffice !== displayOfficeId;
        }
      }
      
      // Update last office for this clinician
      clinicianLastOffice[appt.clinicianName] = displayOfficeId;
      
      // Add debug logging to trace office ID values
      console.log(`Processing appointment ${appt.appointmentId}:`, {
        originalOfficeId: appt.currentOfficeId,
        assignedOfficeId: appt.assignedOfficeId,
        displayOfficeId: displayOfficeId,
        requiresOfficeChange,
        previousOffice,
        isVirtual: displayOfficeId === 'A-v',
        sessionType: appt.sessionType
      });
      
      return {
        appointmentId: appt.appointmentId,
        clientName: appt.clientName,
        clinicianName: appt.clinicianName,
        officeId: displayOfficeId,
        officeDisplay: displayOfficeId === 'A-v' ? 'Virtual Office' : `Office ${displayOfficeId}`,
        startTime: appt.startTime,
        endTime: appt.endTime,
        formattedTime: `${formatESTTime(appt.startTime)} - ${formatESTTime(appt.endTime)}`,
        sessionType: appt.sessionType,
        hasSpecialRequirements,
        requirements: appt.requirements,
        notes: appt.notes,
        // IMPORTANT: Include assignment reason in processed appointments
        assignmentReason: appt.assignmentReason,
        requiresOfficeChange,
        previousOffice
      };
    });
  }

  /**
   * Detect scheduling conflicts with improved accuracy
   */
  private detectConflicts(appointments: ProcessedAppointment[]): ScheduleConflict[] {
    const conflicts: ScheduleConflict[] = [];
    
    // Process each appointment to find overlaps
    appointments.forEach(appt => {
      // Skip telehealth/virtual appointments for conflict detection
      if (appt.officeId === 'A-v' || appt.sessionType === 'telehealth') {
        return;
      }
      
      const startTime = new Date(appt.startTime).getTime();
      const endTime = new Date(appt.endTime).getTime();
      
      // Check each appointment against all others for the same office
      appointments.forEach(otherAppt => {
        // Skip comparing with itself or with telehealth appointments
        if (appt.appointmentId === otherAppt.appointmentId || 
            otherAppt.officeId === 'A-v' || 
            otherAppt.sessionType === 'telehealth') {
          return;
        }
        
        // Only check appointments in the same office
        if (appt.officeId !== otherAppt.officeId) {
          return;
        }
        
        // Get times for other appointment
        const otherStartTime = new Date(otherAppt.startTime).getTime();
        const otherEndTime = new Date(otherAppt.endTime).getTime();
        
        // Check for ACTUAL time overlap (not just consecutive appointments)
        const hasOverlap = (
          // This appointment starts during other appointment
          (startTime >= otherStartTime && startTime < otherEndTime) || 
          // This appointment ends during other appointment
          (endTime > otherStartTime && endTime <= otherEndTime) ||
          // This appointment completely contains other appointment 
          (startTime <= otherStartTime && endTime >= otherEndTime)
        );
        
        // If there's a true overlap, record the conflict
        if (hasOverlap) {
          // Create a unique key for this conflict to avoid duplicates
          const conflictKey = [appt.appointmentId, otherAppt.appointmentId].sort().join('-');
          
          // Use the formatted time string that spans both appointments
          const startDisplay = new Date(Math.min(startTime, otherStartTime));
          const endDisplay = new Date(Math.max(endTime, otherEndTime));
          
          // Format start/end times for display
          const formattedStart = formatESTTime(startDisplay.toISOString());
          const formattedEnd = formatESTTime(endDisplay.toISOString());
          const timeDisplay = `${formattedStart} - ${formattedEnd}`;
          
          // Create detailed conflict description
          const description = `Double booking in ${appt.officeDisplay}: ${appt.clientName} with ${appt.clinicianName} and ${otherAppt.clientName} with ${otherAppt.clinicianName} at ${timeDisplay}`;
          
          // Check if this conflict has already been recorded
          const existingConflict = conflicts.find(c => 
            c.appointmentIds?.includes(appt.appointmentId) && 
            c.appointmentIds?.includes(otherAppt.appointmentId)
          );
          
          // Add suggested resolution
          const resolutionSuggestion = `Consider moving one appointment to a different office or time.`;
          
          if (!existingConflict) {
            conflicts.push({
              type: 'double-booking',
              description,
              severity: 'high',
              appointmentIds: [appt.appointmentId, otherAppt.appointmentId],
              officeId: appt.officeId,
              clinicianIds: [appt.clinicianName, otherAppt.clinicianName], // Track BOTH clinicians involved
              timeBlock: timeDisplay,
              resolutionSuggestion
            });
          }
        }
      });
    });
    
    return conflicts;
  }

  /**
   * Calculate schedule statistics - UPDATED to use the assigned office IDs
   */
  private calculateStats(appointments: ProcessedAppointment[]): DailyScheduleData['stats'] {
    // Count by session type
    const inPersonCount = appointments.filter(a => a.sessionType === 'in-person').length;
    const telehealthCount = appointments.filter(a => a.sessionType === 'telehealth').length;
    const groupCount = appointments.filter(a => a.sessionType === 'group').length;
    const familyCount = appointments.filter(a => a.sessionType === 'family').length;
    
    // Calculate office utilization using the updated officeId
    const officeUtilization: Record<string, number> = {};
    appointments.forEach(appt => {
      if (appt.sessionType === 'in-person' || appt.officeId !== 'A-v') {
        // Use the officeId which is now the assigned office ID
        officeUtilization[appt.officeId] = (officeUtilization[appt.officeId] || 0) + 1;
      }
    });
    
    // Debug logging for office utilization
    console.log('Office utilization stats:', officeUtilization);
    
    return {
      totalAppointments: appointments.length,
      inPersonCount,
      telehealthCount,
      groupCount,
      familyCount,
      officeUtilization
    };
  }

  /**
   * Helper method to check if an office is available during the appointment time
   */
  private async isOfficeAvailable(
    officeId: string, 
    appointment: AppointmentRecord, 
    allAppointments: AppointmentRecord[]
  ): Promise<boolean> {
    try {
      // Verify and standardize the office ID
      if (!officeId || officeId === 'TBD') {
        console.log(`Invalid office ID: ${officeId}, treating as unavailable`);
        return false;
      }
      const targetOfficeId = standardizeOfficeId(officeId);
      
      // Parse appointment times
      const startTime = new Date(appointment.startTime).getTime();
      const endTime = new Date(appointment.endTime).getTime();
      
      // Check for conflicts with other appointments in the same office
      const conflictingAppt = allAppointments.find(appt => {
        // Skip the appointment being checked
        if (appt.appointmentId === appointment.appointmentId) return false;
        
        // Skip cancelled or rescheduled appointments
        if (appt.status === 'cancelled' || appt.status === 'rescheduled') return false;
        
        // Check if this appointment is in the target office
        // IMPORTANT: We check assignedOfficeId first, then currentOfficeId, then officeId for backward compatibility
        const apptOfficeId = standardizeOfficeId(
          appt.assignedOfficeId || appt.currentOfficeId || 
          // For backward compatibility, access officeId with bracket notation to avoid TypeScript errors
          (appt as any)['officeId'] || 'TBD'
        );
        
        // If not the same office, there's no conflict
        if (apptOfficeId !== targetOfficeId) return false;
        
        // Parse appointment times
        const apptStart = new Date(appt.startTime).getTime();
        const apptEnd = new Date(appt.endTime).getTime();
        
        // Check for time overlap - ensuring we correctly detect overlapping appointments
        return (
          // This appointment starts during existing appointment
          (startTime >= apptStart && startTime < apptEnd) ||
          // This appointment ends during existing appointment
          (endTime > apptStart && endTime <= apptEnd) ||
          // This appointment completely contains existing appointment
          (startTime <= apptStart && endTime >= apptEnd)
        );
      });
      
      return !conflictingAppt;
    } catch (error) {
      console.error(`Error checking office availability for ${officeId}:`, error);
      return false; // Assume not available on error
    }
  }

  /**
 * Test office assignment rules on a week of appointments
 * Used for debugging and validation only
 */
async testOfficeAssignmentRules(startDate: string, endDate: string): Promise<any> {
  try {
    console.log(`Testing office assignment rules from ${startDate} to ${endDate}`);
    
    // Get date range
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // Get all appointments in range
    const startStr = new Date(start).toISOString();
const endOfDay = new Date(end);
endOfDay.setHours(23, 59, 59, 999);
const endStr = endOfDay.toISOString();
console.log(`Getting appointments from ${startStr} to ${endStr}`);
const appointments = await this.sheetsService.getAppointments(startStr, endStr);
    console.log(`Found ${appointments.length} appointments for testing`);
    
    // Statistics to track
    const stats = {
      totalAppointments: appointments.length,
      ruleMatches: {} as Record<string, number>,
      ageGroups: {
        unknown: 0,
        under10: 0,
        age11to17: 0,
        adult: 0
      },
      mobilityNeeds: 0,
      requiredOffices: 0,
      testResults: [] as any[]
    };
    
    // Process each appointment
    for (const appt of appointments) {
      console.log(`\n--- Testing appointment ${appt.appointmentId} for ${appt.clientName} ---`);
      
      // Get client accessibility info
      const clientAccessibility = await this.sheetsService.getClientAccessibilityInfo(appt.clientId);
      
      // Log client accessibility info
      if (clientAccessibility) {
        console.log(`Client accessibility: Mobility=${clientAccessibility.hasMobilityNeeds}, RequiredOffice=${clientAccessibility.requiredOffice || 'None'}`);
        if (clientAccessibility.hasMobilityNeeds) stats.mobilityNeeds++;
        if (clientAccessibility.requiredOffice) stats.requiredOffices++;
      } else {
        console.log('No client accessibility info found');
      }
      
      // Try to determine client age if available (for age-based rules)
let clientAge: number | null = null;
try {
  // Check if we have DOB in the appointment record
  if (appt.clientDateOfBirth && appt.clientDateOfBirth.trim() !== '') {
    const dobDate = new Date(appt.clientDateOfBirth);
    
    // Ensure we have a valid date
    if (!isNaN(dobDate.getTime())) {
      const appointmentDate = new Date(appt.startTime);
      let age = appointmentDate.getFullYear() - dobDate.getFullYear();
      
      // Adjust age if birthday hasn't occurred yet this year
      const monthDiff = appointmentDate.getMonth() - dobDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && appointmentDate.getDate() < dobDate.getDate())) {
        age--;
      }
      
      clientAge = age;
      console.log(`Client age determined as: ${clientAge} from DOB: ${appt.clientDateOfBirth}`);
    } else {
      console.log(`Invalid DOB format for client ${appt.clientName}: ${appt.clientDateOfBirth}`);
    }
  } else {
    console.log(`No DOB found for client ${appt.clientName}, age-based rules will be skipped`);
  }
} catch (error) {
  console.log(`Error determining age for client ${appt.clientName}: ${error}`);
}
      
      if (clientAge === null) stats.ageGroups.unknown++;
      console.log(`Client age: ${clientAge !== null ? clientAge : 'unknown'}`);
      
      // Apply rules in order
      let assignedOffice = null;
      let assignmentReason = '';
      
      // RULE PRIORITY 100: Client Specific Requirement
      if (!assignedOffice && clientAccessibility) {
        // Extract from required office or notes
        const specificOffice = this.extractAssignedOfficeFromNotes(
          clientAccessibility.additionalNotes || '',
          clientAccessibility.requiredOffice
        );
        
        if (specificOffice) {
          assignedOffice = specificOffice;
          assignmentReason = `Client has specific office requirement (Priority 100)`;
          stats.ruleMatches['100'] = (stats.ruleMatches['100'] || 0) + 1;
        }
      }
      
      // RULE PRIORITY 90: Accessibility Requirement
      if (!assignedOffice && clientAccessibility?.hasMobilityNeeds) {
        assignedOffice = 'B-4'; // Simplified for testing
        assignmentReason = `Client requires accessible office (Priority 90)`;
        stats.ruleMatches['90'] = (stats.ruleMatches['90'] || 0) + 1;
      }
      
      // RULE PRIORITY 80: Young Children
      if (!assignedOffice && clientAge !== null && clientAge <= 10) {
        assignedOffice = 'B-5';
        assignmentReason = `Young child assigned to B-5 (Priority 80)`;
        stats.ruleMatches['80'] = (stats.ruleMatches['80'] || 0) + 1;
      }
      
      // RULE PRIORITY 75: Older Children and Teens
      if (!assignedOffice && clientAge !== null && clientAge >= 11 && clientAge <= 17) {
        assignedOffice = 'C-1';
        assignmentReason = `Older child/teen assigned to C-1 (Priority 75)`;
        stats.ruleMatches['75'] = (stats.ruleMatches['75'] || 0) + 1;
      }
      
      // Log result
      console.log(`Test assignment: ${assignedOffice || 'None'} - ${assignmentReason || 'No matching high-priority rule'}`);
      
      // Save result for analysis
      stats.testResults.push({
        appointmentId: appt.appointmentId,
        clientName: appt.clientName,
        clientId: appt.clientId,
        clientAge: clientAge,
        hasMobilityNeeds: clientAccessibility?.hasMobilityNeeds || false,
        requiredOffice: clientAccessibility?.requiredOffice || null,
        assignedOffice: assignedOffice,
        assignmentReason: assignmentReason,
        currentAssignment: appt.assignedOfficeId || appt.currentOfficeId || null
      });
    }

    
    // Log summary statistics
    console.log('\n--- Office Assignment Test Summary ---');
    console.log(`Total appointments tested: ${stats.totalAppointments}`);
    console.log('Age groups:');
    console.log(`  Unknown age: ${stats.ageGroups.unknown}`);
    console.log(`  Children ≤10: ${stats.ageGroups.under10}`);
    console.log(`  Children/Teens 11-17: ${stats.ageGroups.age11to17}`);
    console.log(`  Adults: ${stats.ageGroups.adult}`);
    console.log(`Clients with mobility needs: ${stats.mobilityNeeds}`);
    console.log(`Clients with required offices: ${stats.requiredOffices}`);
    console.log('Rule matches:');
    Object.entries(stats.ruleMatches).forEach(([priority, count]) => {
      console.log(`  Priority ${priority}: ${count} appointments`);
    });
    
    return stats;
  } catch (error) {
    console.error('Error testing office assignment rules:', error);
    throw error;
  }
}

/**
 * Test the office assignment for a single appointment
 * This allows testing the rule application for a specific appointment
 */
async testSingleAppointmentAssignment(appointmentId: string): Promise<any> {
  try {
    console.log(`Testing office assignment for appointment: ${appointmentId}`);
    
    // Get the appointment
    const appointment = await this.sheetsService.getAppointment(appointmentId);
    
    if (!appointment) {
      throw new Error(`Appointment ${appointmentId} not found`);
    }
    
    console.log(`Found appointment for ${appointment.clientName} (Client ID: ${appointment.clientId})`);
    
    // Get necessary configuration data
    const offices = await this.sheetsService.getOffices();
    const activeOffices = offices.filter(o => o.inService === true);
    const clinicians = await this.sheetsService.getClinicians();
    const clientPreferences = await this.sheetsService.getClientPreferences();
    
    console.log(`Loaded configuration: ${activeOffices.length} active offices, ${clinicians.length} clinicians`);
    
    // Get client accessibility info - critical for several rules
    const clientAccessibility = await this.sheetsService.getClientAccessibilityInfo(appointment.clientId);
    
    // Log client accessibility info for debugging
    console.log('Client Accessibility Info:');
    if (clientAccessibility) {
      console.log(`  ClientId: ${clientAccessibility.clientId}`);
      console.log(`  ClientName: ${clientAccessibility.clientName}`);
      console.log(`  Has mobility needs: ${clientAccessibility.hasMobilityNeeds}`);
      console.log(`  Has sensory needs: ${clientAccessibility.hasSensoryNeeds}`);
      console.log(`  Has physical needs: ${clientAccessibility.hasPhysicalNeeds}`);
      console.log(`  Room consistency: ${clientAccessibility.roomConsistency}`);
      console.log(`  Has support needs: ${clientAccessibility.hasSupport}`);
      console.log(`  Additional notes: ${clientAccessibility.additionalNotes || 'None'}`);
      console.log(`  Required office: ${clientAccessibility.requiredOffice || 'None'}`);
      
      // Test extracting assigned office
      const extractedOffice = this.extractAssignedOfficeFromNotes(
        clientAccessibility.additionalNotes || '',
        clientAccessibility.requiredOffice
      );
      console.log(`  Extracted office from notes/requiredOffice: ${extractedOffice || 'None'}`);
    } else {
      console.log('  No accessibility info found');
      
      // Try with integer ID if the client ID is a string with numbers
      if (typeof appointment.clientId === 'string' && !isNaN(Number(appointment.clientId))) {
        const numericId = Number(appointment.clientId).toString();
        if (numericId !== appointment.clientId) {
          console.log(`  Trying with numeric ID format: ${numericId}`);
          const altCheck = await this.sheetsService.getClientAccessibilityInfo(numericId);
          if (altCheck) {
            console.log(`  Found accessibility info with numeric ID`);
            console.log(`  Has mobility needs: ${altCheck.hasMobilityNeeds}`);
            console.log(`  Required office: ${altCheck.requiredOffice || 'None'}`);
          }
        }
      }
    }
    
    // Get client preferences
    const clientPreference = clientPreferences.find(p => p.clientId === appointment.clientId);
    if (clientPreference?.assignedOffice) {
      console.log(`Client ${appointment.clientName} has assigned office from preferences: ${clientPreference.assignedOffice}`);
    }
    
    // Try to determine client age
    let clientAge: number | null = null;
    try {
      if (appointment.clientDateOfBirth && appointment.clientDateOfBirth.trim() !== '') {
        const dobDate = new Date(appointment.clientDateOfBirth);
        if (!isNaN(dobDate.getTime())) {
          const appointmentDate = new Date(appointment.startTime);
          let age = appointmentDate.getFullYear() - dobDate.getFullYear();
          const monthDiff = appointmentDate.getMonth() - dobDate.getMonth();
          if (monthDiff < 0 || (monthDiff === 0 && appointmentDate.getDate() < dobDate.getDate())) {
            age--;
          }
          clientAge = age;
          console.log(`Client age determined as: ${clientAge} from DOB: ${appointment.clientDateOfBirth}`);
        }
      }
    } catch (error) {
      console.log(`Error determining age: ${error}`);
    }
    
    // Now let's run through each rule in priority order
    console.log('\nApplying office assignment rules:');
    let assignedOffice = null;
    let assignmentReason = '';
    
    // Create a function to log rule application
    const logRuleCheck = (priority: number, ruleName: string) => {
      console.log(`\nChecking PRIORITY ${priority}: ${ruleName}`);
    };
    
    const logRuleApplied = (priority: number, ruleName: string, office: string) => {
      console.log(`RULE APPLIED: Priority ${priority} - ${ruleName}`);
      console.log(`Assigned office: ${office}`);
    };
    
    // ---------- PRIORITY 100 - TAG-BASED ----------
    if (!assignedOffice && appointment.tags && appointment.tags.length > 0) {
      logRuleCheck(100, "Office Tag (tag-based)");
      
      // Look for tags matching office IDs (case-insensitive)
      const officeTags = appointment.tags.filter(tag => 
        /^[a-c]-[0-9v]$/i.test(tag) || // Match format like "b-4", "c-1", "a-v"
        /^[a-c][0-9v]$/i.test(tag)     // Also match format like "b4", "c1", "av"
      );
      
      if (officeTags.length > 0) {
        // Take the first matching office tag
        let officeTag = officeTags[0].toLowerCase();
        
        // Normalize format if needed (convert b4 to b-4)
        if (/^[a-c][0-9v]$/.test(officeTag)) {
          officeTag = `${officeTag[0]}-${officeTag[1]}`;
        }
        
        assignedOffice = standardizeOfficeId(officeTag);
        assignmentReason = `Client has specific office tag ${officeTag} (Priority 100 TAG)`;
        logRuleApplied(100, "Office Tag", assignedOffice);
      }
    }
    
    // ---------- PRIORITY 100 - CLIENT-SPECIFIC ----------
    if (!assignedOffice) {
      logRuleCheck(100, "Client Specific Requirement");
      if (clientAccessibility) {
        // Check both requiredOffice field and notes
        let clientSpecificOffice = this.extractAssignedOfficeFromNotes(
          clientAccessibility.additionalNotes || '',
          clientAccessibility.requiredOffice  // New field
        );
        
        if (clientSpecificOffice) {
          console.log(`  Found client specific office: "${clientSpecificOffice}"`);
          
          // Handle different formats of office IDs
          if (/^[A-C]-[0-9v]/.test(clientSpecificOffice)) {
            // Standard format (e.g., "B-4", "C-3", "A-v")
            assignedOffice = standardizeOfficeId(clientSpecificOffice);
            console.log(`  Using standard office ID: ${assignedOffice}`);
          } else if (clientSpecificOffice.includes('-')) {
            // Might be a UUID format
            console.log(`  Legacy office ID (UUID format): ${clientSpecificOffice}`);
            assignedOffice = clientSpecificOffice;
          } else {
            // Could be a simple name without hyphen (e.g., "C1" instead of "C-1")
            if (/^[A-C][0-9v]$/.test(clientSpecificOffice)) {
              // Format like "C1", "B4", "Av"
              const floor = clientSpecificOffice.charAt(0);
              const unit = clientSpecificOffice.charAt(1);
              assignedOffice = standardizeOfficeId(`${floor}-${unit}`);
              console.log(`  Converted simple format ${clientSpecificOffice} to ${assignedOffice}`);
            } else {
              // Unknown format, use as is
              console.log(`  Unknown office ID format: ${clientSpecificOffice}`);
              assignedOffice = clientSpecificOffice;
            }
          }
          
          assignmentReason = `Client has specific office requirement (Priority 100)`;
          logRuleApplied(100, "Client Specific Requirement", assignedOffice);
        }
      }
    }
    
    // ---------- PRIORITY 90 - TAG-BASED ----------
    if (!assignedOffice && appointment.tags && appointment.tags.includes('mobility')) {
      logRuleCheck(90, "Mobility Tag (tag-based)");
      
      // Prioritize B-4, B-5 as specified in rule
      const accessibleOffices = ['B-4', 'B-5'];
      
      console.log(`  Client has mobility tag, checking accessible offices: ${accessibleOffices.join(', ')}`);
      
      for (const officeId of accessibleOffices) {
        console.log(`  Checking accessible office: ${officeId}`);
        const matchingOffice = activeOffices.find(o => 
          standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId)
        );
        
        if (matchingOffice) {
          const available = await this.isOfficeAvailable(matchingOffice.officeId, appointment, [appointment]);
          console.log(`  Office ${officeId} availability: ${available ? 'Available' : 'NOT Available'}`);
          if (available) {
            assignedOffice = standardizeOfficeId(matchingOffice.officeId);
            assignmentReason = `Client has mobility tag (Priority 90 TAG)`;
            logRuleApplied(90, "Mobility Tag", assignedOffice);
            break;
          }
        } else {
          console.log(`  Office ${officeId} not found in active offices list`);
        }
      }
    }
    
    // ---------- PRIORITY 90 - ACCESSIBILITY ----------
    if (!assignedOffice) {
      logRuleCheck(90, "Accessibility Requirement");
      if (clientAccessibility?.hasMobilityNeeds) {
        console.log(`  Client has mobility needs, checking accessible offices`);
        
        // Prioritize B-4, B-5 as specified in rule
        const accessibleOffices = ['B-4', 'B-5'];
        
        for (const officeId of accessibleOffices) {
          console.log(`  Checking accessible office: ${officeId}`);
          const matchingOffice = activeOffices.find(o => 
            standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId)
          );
          
          if (matchingOffice) {
            const available = await this.isOfficeAvailable(matchingOffice.officeId, appointment, [appointment]);
            console.log(`  Office ${officeId} availability: ${available ? 'Available' : 'NOT Available'}`);
            if (available) {
              assignedOffice = standardizeOfficeId(matchingOffice.officeId);
              assignmentReason = `Client requires accessible office (Priority 90)`;
              logRuleApplied(90, "Accessibility Requirement", assignedOffice);
              break;
            }
          } else {
            console.log(`  Office ${officeId} not found in active offices list`);
          }
        }
      } else {
        console.log(`  Client does not have mobility needs, skipping accessibility rule`);
      }
    }
    
    // Provide the final result
    if (assignedOffice) {
      console.log(`\nFINAL RESULT: Office ${assignedOffice} assigned because: ${assignmentReason}`);
    } else {
      console.log('\nNo specific office could be assigned based on priority rules');
    }
    
    return {
      appointmentId: appointment.appointmentId,
      clientId: appointment.clientId,
      clientName: appointment.clientName,
      sessionType: appointment.sessionType,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
      originalOfficeId: appointment.currentOfficeId || appointment.officeId,
      assignedOfficeId: assignedOffice || 'TBD',
      assignmentReason: assignmentReason || 'No rule applied',
      clientAge: clientAge,
      mobilityNeeds: clientAccessibility?.hasMobilityNeeds || false,
      requiredOffice: clientAccessibility?.requiredOffice || null,
      hasTags: appointment.tags && appointment.tags.length > 0
    };
  } catch (error) {
    console.error('Error testing office assignment:', error);
    
    // Log error
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'SYSTEM_ERROR',
      description: 'Error testing office assignment',
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    throw error;
  }
}

}