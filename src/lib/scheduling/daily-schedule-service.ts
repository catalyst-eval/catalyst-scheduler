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
}

export interface ScheduleConflict {
  type: 'double-booking' | 'capacity' | 'accessibility' | 'requirements';
  description: string;
  severity: 'high' | 'medium' | 'low';
  appointmentIds?: string[];
  officeId?: string;
  timeBlock?: string;
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
    const appointments = await this.sheetsService.getAppointments(start, end);
    console.log(`Found ${appointments.length} appointments for ${date}`);
    
    // 3. Get all offices for reference
    const offices = await this.sheetsService.getOffices();
    console.log(`Found ${offices.length} offices`);
    
    // 4. Process appointments
    const processedAppointments = this.processAppointments(appointments, offices);
    
    // 5. Detect conflicts
    const conflicts = this.detectConflicts(processedAppointments);
    
    // 6. Calculate stats
    const stats = this.calculateStats(processedAppointments);
    
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
        conflictCount: conflicts.length
      })
    });
    
    // 8. Return compiled data
    return {
      date,
      displayDate: getDisplayDate(date),
      appointments: processedAppointments,
      conflicts,
      stats
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
   * Process appointments for display - UPDATED to use suggestedOfficeId
   */
  private processAppointments(
    appointments: AppointmentRecord[],
    offices: any[]
  ): ProcessedAppointment[] {
    return appointments
      .filter(appt => appt.status !== 'cancelled' && appt.status !== 'rescheduled')
      .map(appt => {
        // Use suggestedOfficeId if available, otherwise fall back to officeId
        const displayOfficeId = standardizeOfficeId(appt.suggestedOfficeId || appt.officeId);
        
        // Find office details
        const office = offices.find(o => standardizeOfficeId(o.officeId) === displayOfficeId);
        
        const hasSpecialRequirements = !!(
          appt.requirements?.accessibility || 
          (appt.requirements?.specialFeatures && appt.requirements.specialFeatures.length > 0)
        );
        
        // Add debug logging to trace office ID values
        console.log(`Processing appointment ${appt.appointmentId}:`, {
          originalOfficeId: appt.officeId,
          suggestedOfficeId: appt.suggestedOfficeId,
          finalOfficeId: displayOfficeId
        });
        
        return {
          appointmentId: appt.appointmentId,
          clientName: appt.clientName,
          clinicianName: appt.clinicianName,
          officeId: displayOfficeId, // Use the display office ID
          officeDisplay: office ? `${office.name} (${displayOfficeId})` : displayOfficeId,
          startTime: appt.startTime,
          endTime: appt.endTime,
          formattedTime: `${formatESTTime(appt.startTime)} - ${formatESTTime(appt.endTime)}`,
          sessionType: appt.sessionType,
          hasSpecialRequirements,
          requirements: appt.requirements,
          notes: appt.notes
        };
      })
      .sort((a, b) => {
        // Sort by time, then by office
        const timeCompare = new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
        if (timeCompare !== 0) return timeCompare;
        return a.officeId.localeCompare(b.officeId);
      });
  }

  /**
   * Detect scheduling conflicts
   */
  private detectConflicts(appointments: ProcessedAppointment[]): ScheduleConflict[] {
    const conflicts: ScheduleConflict[] = [];
    
    // Map to track office usage by time blocks
    const officeTimeMap: Record<string, ProcessedAppointment[]> = {};
    
    // Process each appointment to find overlaps
    appointments.forEach(appt => {
      const startTime = new Date(appt.startTime).getTime();
      const endTime = new Date(appt.endTime).getTime();
      
      // Use 15-minute blocks for tracking
      const startBlock = Math.floor(startTime / (15 * 60 * 1000));
      const endBlock = Math.ceil(endTime / (15 * 60 * 1000));
      
      // Check each time block
      for (let block = startBlock; block <= endBlock; block++) {
        const timeBlockKey = `${appt.officeId}-${block}`;
        
        if (!officeTimeMap[timeBlockKey]) {
          officeTimeMap[timeBlockKey] = [];
        }
        
        // If we already have an appointment in this office at this time
        if (officeTimeMap[timeBlockKey].length > 0) {
          const conflictingAppt = officeTimeMap[timeBlockKey][0];
          
          // Create conflict record
          conflicts.push({
            type: 'double-booking',
            description: `Double booking in ${appt.officeDisplay}: ${conflictingAppt.clientName} with ${conflictingAppt.clinicianName} and ${appt.clientName} with ${appt.clinicianName} at ${appt.formattedTime}`,
            severity: 'high',
            appointmentIds: [appt.appointmentId, conflictingAppt.appointmentId],
            officeId: appt.officeId,
            timeBlock: appt.formattedTime
          });
        }
        
        officeTimeMap[timeBlockKey].push(appt);
      }
      
      // Check for accessibility requirements
      if (appt.requirements?.accessibility) {
        // We would check if the assigned office meets the requirements
        // This would need additional logic and data
      }
    });
    
    // Remove duplicates (same conflict may be detected in multiple time blocks)
    const uniqueConflicts = conflicts.filter((conflict, index, self) =>
      index === self.findIndex(c => 
        c.appointmentIds?.join(',') === conflict.appointmentIds?.join(',') &&
        c.type === conflict.type
      )
    );
    
    return uniqueConflicts;
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