// src/lib/scheduling/daily-schedule-service.ts

import { GoogleSheetsService, AuditEventType } from '../google/sheets';
import { 
  formatESTTime, 
  getESTDayRange, 
  getDisplayDate, 
  isValidISODate,
  getTodayEST
} from '../util/date-helpers';
import { standardizeOfficeId } from '../util/office-id';
import { IntakeQService } from '../intakeq/service';
import { AppointmentSyncHandler } from '../intakeq/appointment-sync';
import type { IntakeQWebhookPayload } from '../../types/webhooks';
import { WebhookEventType } from '../../types/webhooks';

// Define the AppointmentRecord interface locally since we can't import it
interface AppointmentRecord {
  appointmentId: string;
  clientId: string;
  clientName: string;
  clinicianId: string;
  clinicianName: string;
  officeId: string;
  suggestedOfficeId?: string;
  sessionType: 'in-person' | 'telehealth' | 'group' | 'family';
  startTime: string;
  endTime: string;
  status: 'scheduled' | 'completed' | 'cancelled' | 'rescheduled';
  lastUpdated: string;
  source: 'intakeq' | 'manual';
  requirements?: {
    accessibility?: boolean;
    specialFeatures?: string[];
  };
  notes?: string;
}

export interface DailyScheduleData {
  date: string;
  displayDate: string;
  appointments: ProcessedAppointment[];
  conflicts: ScheduleConflict[];
  conflictsByClinicianMap?: Record<string, ScheduleConflict[]>; // Add this for clinician-specific conflicts
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
  requiresOfficeChange?: boolean; // New property to flag office changes
  previousOffice?: string; // New property to track previous office
}

export interface ScheduleConflict {
  type: 'double-booking' | 'capacity' | 'accessibility' | 'requirements';
  description: string;
  severity: 'high' | 'medium' | 'low';
  appointmentIds?: string[];
  officeId?: string;
  timeBlock?: string;
  clinicianIds?: string[]; // New property to track clinicians involved
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
      
      // 2. Get all appointments for the date
      let appointments = await this.sheetsService.getAppointments(start, end);
      console.log(`Found ${appointments.length} appointments for ${date}`);
      
      // 3. Get all offices for reference
      const offices = await this.sheetsService.getOffices();
      console.log(`Found ${offices.length} offices`);
      
      // NEW STEP: Resolve TBD office assignments
      appointments = await this.resolveOfficeAssignments(appointments);
      
      // 4. Process appointments
      const processedAppointments = this.processAppointments(appointments, offices);
      
      // 5. Detect conflicts
      let conflicts = this.detectConflicts(processedAppointments);
      
      // 6. Group conflicts by clinician
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
      
      // 7. Log audit entry for schedule generation
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.DAILY_ASSIGNMENTS_UPDATED,
        description: `Generated daily schedule for ${date}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          date,
          displayDate: getDisplayDate(date),
          appointmentCount: appointments.length,
          assignedCount: appointments.filter(a => a.suggestedOfficeId && a.suggestedOfficeId !== 'TBD').length,
          conflictCount: conflicts.length
        })
      });
      
      // 8. Return compiled data with clinician-specific conflicts
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
        eventType: 'SYSTEM_ERROR', // Use string directly
        description: `Failed to generate daily schedule for ${date}`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      throw error;
    }
  }

/**
 * Resolve TBD office assignments using strict rule priority
 */
private async resolveOfficeAssignments(appointments: AppointmentRecord[]): Promise<AppointmentRecord[]> {
  try {
    console.log('Resolving office assignments using priority rules');
    
    // Get necessary configuration data for rule application
    const offices = await this.sheetsService.getOffices();
    const activeOffices = offices.filter(o => o.inService === true);
    const clinicians = await this.sheetsService.getClinicians();
    const rules = await this.sheetsService.getAssignmentRules();
    const clientPreferences = await this.sheetsService.getClientPreferences();
    
    console.log(`Loaded ${activeOffices.length} active offices, ${rules.length} rules`);
    
    // Sort rules by priority (highest first)
    const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);
    
    // Track office assignments for logging
    const assignmentLog: Record<string, string> = {};
    
    // Process each appointment that needs office assignment
    const updatedAppointments = await Promise.all(
      appointments.map(async (appt) => {
        // Skip if appointment is cancelled or already has a non-TBD office
        if (appt.status === 'cancelled' || appt.status === 'rescheduled') {
          return appt;
        }
        
        // Check if we need to resolve office assignment
        const needsAssignment = 
          !appt.suggestedOfficeId || 
          appt.suggestedOfficeId === 'TBD' || 
          appt.suggestedOfficeId === '';
        
        if (!needsAssignment) {
          // Standardize the existing suggestedOfficeId
          return {
            ...appt,
            suggestedOfficeId: standardizeOfficeId(appt.suggestedOfficeId)
          };
        }
        
        // Log the appointment we're processing
        const apptKey = `${appt.appointmentId} (${appt.clientName})`;
        console.log(`Resolving office for appointment ${apptKey}: ${appt.clientName} with ${appt.clinicianName}`);
        
        // Get data needed for rule application
        const clinician = clinicians.find(c => c.name === appt.clinicianName);
        const clientPreference = clientPreferences.find(p => p.name === appt.clientName);
        const clientAccessibility = await this.sheetsService.getClientAccessibilityInfo(appt.clientId);
        
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
          console.log(`  Clinician ${clinician.name} primary office: ${clinician.preferredOffices?.[0] || 'None'}`);
          console.log(`  Clinician preferred offices: ${clinician.preferredOffices?.join(', ') || 'None'}`);
        }
        
        // Iterate through each rule in priority order
        for (const rule of sortedRules) {
          // Skip inactive rules
          if (!rule.active) continue;
          
          console.log(`  Checking rule: ${rule.ruleName} (Priority ${rule.priority})`);
          
          switch (rule.ruleType) {
            case 'client': // Priority 100: Client Specific Requirement
              if (rule.priority === 100 && clientPreference?.assignedOffice) {
                assignedOffice = clientPreference.assignedOffice;
                assignmentReason = `Priority ${rule.priority}: Client specific requirement`;
                console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                break;
              }
              continue;
              
            case 'accessibility': // Priority 90: Accessibility Requirements
              if (rule.priority === 90 && clientAccessibility?.hasMobilityNeeds) {
                const accessibleOffices = rule.officeIds
                  .map(id => standardizeOfficeId(id))
                  .filter(id => activeOffices.some(o => standardizeOfficeId(o.officeId) === id));
                
                if (accessibleOffices.length > 0) {
                  assignedOffice = accessibleOffices[0];
                  assignmentReason = `Priority ${rule.priority}: Client requires accessible office`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  break;
                }
              }
              continue;
              
            case 'age': // Priorities 80/75/70: Age-based rules
              // For testing purposes, implement basic age handling
              // In production, you'd need client DOB from IntakeQ
              continue;
              
            case 'session': // Session type rules (Family sessions, In-person)
              if (rule.priority === 65 && rule.condition.includes('session_type') && appt.sessionType === 'family') {
                const familyOffices = rule.officeIds
                  .map(id => standardizeOfficeId(id))
                  .filter(id => activeOffices.some(o => standardizeOfficeId(o.officeId) === id));
                  
                if (familyOffices.length > 0) {
                  assignedOffice = familyOffices[0];
                  assignmentReason = `Priority ${rule.priority}: Family session requires larger office`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  break;
                }
              }
              
              if (rule.priority === 55 && rule.condition.includes('in-person') && appt.sessionType === 'in-person') {
                const inPersonOffices = rule.officeIds
                  .map(id => standardizeOfficeId(id))
                  .filter(id => activeOffices.some(o => standardizeOfficeId(o.officeId) === id));
                  
                if (inPersonOffices.length > 0) {
                  assignedOffice = inPersonOffices[0];
                  assignmentReason = `Priority ${rule.priority}: In-person session assignment`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  break;
                }
              }
              
              if ((rule.priority === 40 || rule.priority === 10) && 
                  rule.condition.includes('telehealth') && 
                  appt.sessionType === 'telehealth') {
                
                if (rule.priority === 40 && clinician?.preferredOffices?.length) {
                  // Telehealth to preferred office
                  const preferredOffices = clinician.preferredOffices
                    .map(id => standardizeOfficeId(id))
                    .filter(id => activeOffices.some(o => standardizeOfficeId(o.officeId) === id));
                    
                  if (preferredOffices.length > 0) {
                    assignedOffice = preferredOffices[0];
                    assignmentReason = `Priority ${rule.priority}: Telehealth to clinician's preferred office`;
                    console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                    break;
                  }
                } else if (rule.priority === 10) {
                  // Default telehealth assignment
                  assignedOffice = 'A-v';
                  assignmentReason = `Priority ${rule.priority}: Default virtual office for telehealth`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  break;
                }
              }
              continue;
              
            case 'clinician': // Clinician office preferences
              if (!clinician) continue;
              
              // Priority 65: Clinician Primary Office
              if (rule.priority === 65 && rule.condition.includes('is_primary_office') && 
                  clinician.preferredOffices && clinician.preferredOffices.length > 0) {
                
                // Assuming first preferred office is primary
                const primaryOffice = standardizeOfficeId(clinician.preferredOffices[0]);
                if (activeOffices.some(o => standardizeOfficeId(o.officeId) === primaryOffice)) {
                  assignedOffice = primaryOffice;
                  assignmentReason = `Priority ${rule.priority}: Clinician's primary office`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  break;
                }
              }
              
              // Priority 62: Clinician Preferred Office
              if (rule.priority === 62 && rule.condition.includes('is_preferred_office') && 
                  clinician.preferredOffices && clinician.preferredOffices.length > 0) {
                
                const preferredOffices = clinician.preferredOffices
                  .map(id => standardizeOfficeId(id))
                  .filter(id => activeOffices.some(o => standardizeOfficeId(o.officeId) === id));
                  
                if (preferredOffices.length > 0) {
                  assignedOffice = preferredOffices[0];
                  assignmentReason = `Priority ${rule.priority}: Clinician's preferred office`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  break;
                }
              }
              continue;
              
            case 'features': // Priority 35: Special Features Match
              // Feature matching logic would go here
              continue;
              
            case 'availability': // Priority 20: Any Available Office
              if (rule.priority === 20 && activeOffices.length > 0) {
                // Assign first available active office
                assignedOffice = standardizeOfficeId(activeOffices[0].officeId);
                assignmentReason = `Priority ${rule.priority}: Available office`;
                console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                break;
              }
              continue;
              
            case 'office': // Priority 15: Break Room Last Resort
              if (rule.priority === 15 && rule.condition.includes('office_id')) {
                const breakRoomId = standardizeOfficeId(rule.officeIds[0]);
                const breakRoom = activeOffices.find(o => standardizeOfficeId(o.officeId) === breakRoomId);
                
                if (breakRoom) {
                  assignedOffice = breakRoomId;
                  assignmentReason = `Priority ${rule.priority}: Break room as last resort`;
                  console.log(`  MATCH: ${assignmentReason} - Office ${assignedOffice}`);
                  break;
                }
              }
              continue;
              
            default:
              continue;
          }
          
          // If we've assigned an office, break the rule loop
          if (assignedOffice) break;
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
        
        // Return updated appointment with assigned office
        return {
          ...appt,
          suggestedOfficeId: assignedOffice
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
    
    // Update the appointments in the sheet
    for (const appt of updatedAppointments) {
      if (appt.suggestedOfficeId && appt.suggestedOfficeId !== 'TBD' && 
          (!appt.officeId || appt.officeId === 'TBD')) {
        await this.sheetsService.updateAppointment({
          ...appt,
          officeId: appt.suggestedOfficeId,
          lastUpdated: new Date().toISOString()
        });
      }
    }
    
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
          Type: 'AppointmentCreated',
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
      // IMPORTANT: Prioritize suggestedOfficeId, but only if it's not TBD
      const displayOfficeId = appt.suggestedOfficeId && appt.suggestedOfficeId !== 'TBD' ? 
        standardizeOfficeId(appt.suggestedOfficeId) : 
        appt.officeId && appt.officeId !== 'TBD' ?
          standardizeOfficeId(appt.officeId) :
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
        originalOfficeId: appt.officeId,
        suggestedOfficeId: appt.suggestedOfficeId,
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
        // Fix the display format to eliminate the duplicate "Office"
        officeDisplay: `Office ${displayOfficeId}`,
        startTime: appt.startTime,
        endTime: appt.endTime,
        formattedTime: `${formatESTTime(appt.startTime)} - ${formatESTTime(appt.endTime)}`,
        sessionType: appt.sessionType,
        hasSpecialRequirements,
        requirements: appt.requirements,
        notes: appt.notes,
        requiresOfficeChange,
        previousOffice
      };
    });
  }

  // In src/lib/scheduling/daily-schedule-service.ts

/**
 * Detect scheduling conflicts with improved accuracy
 */
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
        
        if (!existingConflict) {
          conflicts.push({
            type: 'double-booking',
            description,
            severity: 'high',
            appointmentIds: [appt.appointmentId, otherAppt.appointmentId],
            officeId: appt.officeId,
            clinicianIds: [appt.clinicianName, otherAppt.clinicianName], // Track BOTH clinicians involved
            timeBlock: timeDisplay
          });
        }
      }
    });
  });
  
  return conflicts;
}

  /**
   * Calculate schedule statistics - UPDATED to use the corrected office IDs
   */
  private calculateStats(appointments: ProcessedAppointment[]): DailyScheduleData['stats'] {
    // Count by session type
    const inPersonCount = appointments.filter(a => a.sessionType === 'in-person').length;
    const telehealthCount = appointments.filter(a => a.sessionType === 'telehealth').length;
    const groupCount = appointments.filter(a => a.sessionType === 'group').length;
    const familyCount = appointments.filter(a => a.sessionType === 'family').length;
    
    // Calculate office utilization using the updated officeId (which should be suggestedOfficeId if available)
    const officeUtilization: Record<string, number> = {};
    appointments.forEach(appt => {
      if (appt.sessionType === 'in-person') {
        // Use the officeId which is now the suggested/display office ID
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
            officeId: 'A-v',
            suggestedOfficeId: 'A-v',
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
            if (standardizeOfficeId(existingAppt.officeId) !== standardizeOfficeId(office.officeId)) return false;
            
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
            officeId: standardizeOfficeId(newOffice.officeId),
            suggestedOfficeId: standardizeOfficeId(newOffice.officeId),
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

}

export default DailyScheduleService;