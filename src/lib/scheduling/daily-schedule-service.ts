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
   * Helper method to extract assigned office from notes and/or requiredOffice field
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

  /**
   * Resolve office assignments using strict rule priority
   * This is the most critical method - it applies assignment rules in strict priority order
   * and disregards existing office assignments completely
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
          console.log(`Resolving office for appointment ${apptKey}: ${appt.clientName} with ${appt.clinicianName}`);
          
          // IMPORTANT: We are disregarding existing assignments and starting fresh
          
          // Get data needed for rule application
          const clinician = clinicians.find(c => c.clinicianId === appt.clinicianId || c.name === appt.clinicianName);
          
          // Get client accessibility info - critical for several rules
          const clientAccessibility = await this.sheetsService.getClientAccessibilityInfo(appt.clientId);
          
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
            // We'll use client preferences as that's already available
            const clientPreference = clientPreferences.find(p => p.clientId === appt.clientId);
            
            // If we have a date of birth from elsewhere (not shown here), we could use it
            // For now, we'll rely on age information that might be passed in from IntakeQ
            
            // This is where we would determine age if we had DOB info
            // Since we don't have direct access to client DOB, we'll use the value that was
            // determined earlier (possibly from IntakeQ data)
            
            console.log(`Client age determined as: ${clientAge !== null ? clientAge : 'unknown'}`);
          } catch (error) {
            console.log(`Could not determine age for client ${appt.clientName}`);
          }
          
          // ===============================================
          // RULE PRIORITY 100: Client Specific Requirement
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
                assignedOffice = standardizeOfficeId(clientSpecificOffice);
                assignmentReason = `Client has specific office requirement (Priority ${RulePriority.CLIENT_SPECIFIC_REQUIREMENT})`;
                console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
              }
            } else if (clientPreference?.assignedOffice) {
              // Fallback to old client preferences data if available
              assignedOffice = standardizeOfficeId(clientPreference.assignedOffice);
              assignmentReason = `Client has specific office requirement (Priority ${RulePriority.CLIENT_SPECIFIC_REQUIREMENT})`;
              console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
            }
          }
          
          // ==========================================
          // RULE PRIORITY 90: Accessibility Requirement
          // ==========================================
          if (!assignedOffice && clientAccessibility?.hasMobilityNeeds) {
            // Prioritize B-4, B-5 as specified in rule
            const accessibleOffices = ['B-4', 'B-5'];
            
            for (const officeId of accessibleOffices) {
              const matchingOffice = activeOffices.find(o => 
                standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId)
              );
              
              if (matchingOffice) {
                const available = await this.isOfficeAvailable(matchingOffice.officeId, appt, appointments);
                if (available) {
                  assignedOffice = standardizeOfficeId(matchingOffice.officeId);
                  assignmentReason = `Client requires accessible office (Priority ${RulePriority.ACCESSIBILITY_REQUIREMENT})`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  break;
                }
              }
            }
          }

          // ===============================
          // RULE PRIORITY 80: Young Children
          // ===============================
          if (!assignedOffice && clientAge !== null && clientAge <= 10) {
            console.log(`  Client is ${clientAge} years old, checking B-5 availability first`);
            
            // First try B-5 (primary for young children)
            const b5Office = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'B-5');
            if (b5Office) {
              const available = await this.isOfficeAvailable('B-5', appt, appointments);
              if (available) {
                assignedOffice = 'B-5';
                assignmentReason = `Young child (${clientAge} years old) assigned to B-5 (Priority ${RulePriority.YOUNG_CHILDREN})`;
                console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
              }
            }
            
            // If B-5 not available, check if C-1 can be used as fallback
            if (!assignedOffice) {
              console.log(`  B-5 not available, checking if C-1 can be used as fallback for young child`);
              const c1Office = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'C-1');
              
              if (c1Office) {
                // Check if C-1 is available
                const available = await this.isOfficeAvailable('C-1', appt, appointments);
                
                if (available) {
                  assignedOffice = 'C-1';
                  assignmentReason = `Young child (${clientAge} years old) assigned to C-1 as fallback (Priority ${RulePriority.YOUNG_CHILDREN})`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                }
              }
            }
          }

          // =======================================
          // RULE PRIORITY 75: Older Children and Teens
          // =======================================
          if (!assignedOffice && clientAge !== null && clientAge >= 11 && clientAge <= 17) {
            console.log(`  Client is ${clientAge} years old, checking C-1 availability first`);
            
            // First try C-1 (primary for older children/teens)
            const c1Office = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'C-1');
            if (c1Office) {
              const available = await this.isOfficeAvailable('C-1', appt, appointments);
              if (available) {
                assignedOffice = 'C-1';
                assignmentReason = `Older child/teen (${clientAge} years old) assigned to C-1 (Priority ${RulePriority.OLDER_CHILDREN_TEENS})`;
                console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
              }
            }
            
            // If C-1 not available, check if B-5 can be used as fallback
            if (!assignedOffice) {
              console.log(`  C-1 not available, checking if B-5 can be used as fallback for older child/teen`);
              const b5Office = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'B-5');
              
              if (b5Office) {
                // Check if B-5 is available
                const available = await this.isOfficeAvailable('B-5', appt, appointments);
                
                if (available) {
                  assignedOffice = 'B-5';
                  assignmentReason = `Older child/teen (${clientAge} years old) assigned to B-5 as fallback (Priority ${RulePriority.OLDER_CHILDREN_TEENS})`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                }
              }
            }
          }

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
          
          // Return updated appointment with assigned office and reason
          return {
            ...appt,
            assignedOfficeId: assignedOffice,
            assignmentReason: assignmentReason
          };
        })
      );
      
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
}