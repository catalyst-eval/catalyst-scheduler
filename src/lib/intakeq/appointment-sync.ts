// src/lib/intakeq/appointment-sync.ts

// Import types from appropriate source (webhooks.ts)
import type { 
  WebhookEventType, 
  IntakeQAppointment, 
  IntakeQWebhookPayload 
} from '../../types/webhooks';

import type { IGoogleSheetsService, AuditEventType } from '../google/sheets';
import type { AppointmentRecord } from '../../types/scheduling';
import { standardizeOfficeId } from '../../types/scheduling';

// Interface for webhook processing results
export interface WebhookResponse {
  success: boolean;
  error?: string;
  details?: any;
  retryable?: boolean;
}

// Interface for office assignment result
interface OfficeAssignmentResult {
  officeId: string;
  reasons: string[];
}

export class AppointmentSyncHandler {
  constructor(
    private readonly sheetsService: IGoogleSheetsService,
    private readonly intakeQService?: any // Optional service for API calls
  ) {}

  /**
   * Process appointment webhook events
   */
  async processAppointmentEvent(
    payload: IntakeQWebhookPayload
  ): Promise<WebhookResponse> {
    if (!payload.Appointment) {
      return { 
        success: false, 
        error: 'Missing appointment data',
        retryable: false
      };
    }

    try {
      // Log webhook receipt
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'WEBHOOK_RECEIVED' as AuditEventType,
        description: `Received ${payload.Type || payload.EventType} webhook`,
        user: 'INTAKEQ_WEBHOOK',
        systemNotes: JSON.stringify({
          appointmentId: payload.Appointment.Id,
          type: payload.Type || payload.EventType,
          clientId: payload.ClientId
        })
      });

      const eventType = payload.Type || payload.EventType;
      
      if (!eventType) {
        return {
          success: false,
          error: 'Missing event type',
          retryable: false
        };
      }

      switch (eventType) {
        case 'AppointmentCreated':
        case 'Appointment Created':
          return await this.handleNewAppointment(payload.Appointment);
        
        case 'AppointmentUpdated':
        case 'Appointment Updated':
        case 'AppointmentRescheduled':
        case 'Appointment Rescheduled':
          return await this.handleAppointmentUpdate(payload.Appointment);
          
        case 'AppointmentCancelled':
        case 'Appointment Cancelled':
        case 'AppointmentCanceled':
        case 'Appointment Canceled':
          return await this.handleAppointmentCancellation(payload.Appointment);
        
        case 'AppointmentDeleted':
        case 'Appointment Deleted':
          return await this.handleAppointmentDeletion(payload.Appointment);
          
        default:
          return {
            success: false,
            error: `Unsupported event type: ${eventType}`,
            retryable: false
          };
      }
    } catch (error) {
      console.error('Appointment processing error:', error);
      
      // Log the error
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'SYSTEM_ERROR' as AuditEventType,
        description: `Error processing appointment ${payload.Appointment.Id}`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        retryable: true // Allow retry for unexpected errors
      };
    }
  }

  private async handleNewAppointment(
    appointment: IntakeQAppointment
  ): Promise<WebhookResponse> {
    try {
      console.log('Processing new appointment:', appointment.Id);
      
      // 1. Convert IntakeQ appointment to our AppointmentRecord format
      const appointmentRecord = await this.convertToAppointmentRecord(appointment);
      
      // 2. Find optimal office assignment
      const assignedOffice = await this.determineOfficeAssignment(appointment);
      appointmentRecord.officeId = assignedOffice.officeId;
      
      // 3. Save appointment to Google Sheets
      await this.sheetsService.addAppointment(appointmentRecord);
      
      // 4. Log success
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'APPOINTMENT_CREATED' as AuditEventType,
        description: `Added appointment ${appointment.Id}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          appointmentId: appointment.Id,
          officeId: assignedOffice.officeId,
          clientId: appointment.ClientId
        })
      });

      return {
        success: true,
        details: {
          appointmentId: appointment.Id,
          officeId: assignedOffice.officeId,
          action: 'created'
        }
      };
    } catch (error) {
      console.error('Error handling new appointment:', error);
      throw error;
    }
  }

  private async handleAppointmentUpdate(
    appointment: IntakeQAppointment
  ): Promise<WebhookResponse> {
    try {
      console.log('Processing appointment update:', appointment.Id);
      
      // 1. Check if appointment exists
      const existingAppointment = await this.sheetsService.getAppointment(appointment.Id);
      
      if (!existingAppointment) {
        // If appointment doesn't exist, treat it as a new appointment
        return this.handleNewAppointment(appointment);
      }
      
      // 2. Convert IntakeQ appointment to our AppointmentRecord format
      const appointmentRecord = await this.convertToAppointmentRecord(appointment);
      
      // 3. Determine if office reassignment is needed
      const currentOfficeId = existingAppointment.officeId;
      let newOfficeId = currentOfficeId;
      
      // Check if time or clinician changed, which would require reassignment
      const timeChanged = 
        appointmentRecord.startTime !== existingAppointment.startTime ||
        appointmentRecord.endTime !== existingAppointment.endTime;
      
      const clinicianChanged = 
        appointmentRecord.clinicianId !== existingAppointment.clinicianId;
      
      if (timeChanged || clinicianChanged) {
        const assignedOffice = await this.determineOfficeAssignment(appointment);
        newOfficeId = assignedOffice.officeId;
      }
      
      appointmentRecord.officeId = newOfficeId;
      
      // 4. Update appointment in Google Sheets
      await this.sheetsService.updateAppointment(appointmentRecord);
      
      // 5. Log success
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'APPOINTMENT_UPDATED' as AuditEventType,
        description: `Updated appointment ${appointment.Id}`,
        user: 'SYSTEM',
        previousValue: JSON.stringify(existingAppointment),
        newValue: JSON.stringify(appointmentRecord)
      });

      return {
        success: true,
        details: {
          appointmentId: appointment.Id,
          officeId: newOfficeId,
          action: 'updated',
          officeReassigned: newOfficeId !== currentOfficeId
        }
      };
    } catch (error) {
      console.error('Error handling appointment update:', error);
      throw error;
    }
  }

  private async handleAppointmentCancellation(
    appointment: IntakeQAppointment
  ): Promise<WebhookResponse> {
    try {
      console.log('Processing appointment cancellation:', appointment.Id);
      
      // 1. Check if appointment exists
      const existingAppointment = await this.sheetsService.getAppointment(appointment.Id);
      
      if (!existingAppointment) {
        return {
          success: false,
          error: `Appointment ${appointment.Id} not found for cancellation`,
          retryable: false
        };
      }
      
      // 2. Update appointment status to cancelled
      const updatedAppointment: AppointmentRecord = {
        ...existingAppointment,
        status: 'cancelled',
        lastUpdated: new Date().toISOString()
      };
      
      // 3. Update appointment in Google Sheets
      await this.sheetsService.updateAppointment(updatedAppointment);
      
      // 4. Log cancellation
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'APPOINTMENT_CANCELLED' as AuditEventType,
        description: `Cancelled appointment ${appointment.Id}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          appointmentId: appointment.Id,
          clientId: appointment.ClientId,
          reason: appointment.CancellationReason || 'No reason provided'
        })
      });

      return {
        success: true,
        details: {
          appointmentId: appointment.Id,
          action: 'cancelled'
        }
      };
    } catch (error) {
      console.error('Error handling appointment cancellation:', error);
      throw error;
    }
  }

  private async handleAppointmentDeletion(
    appointment: IntakeQAppointment
  ): Promise<WebhookResponse> {
    try {
      console.log('Processing appointment deletion:', appointment.Id);
      
      // 1. Check if appointment exists
      const existingAppointment = await this.sheetsService.getAppointment(appointment.Id);
      
      if (!existingAppointment) {
        return {
          success: false,
          error: `Appointment ${appointment.Id} not found for deletion`,
          retryable: false
        };
      }
      
      // 2. Delete appointment from Google Sheets
      await this.sheetsService.deleteAppointment(appointment.Id);
      
      // 3. Log deletion
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'APPOINTMENT_DELETED' as AuditEventType,
        description: `Deleted appointment ${appointment.Id}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          appointmentId: appointment.Id,
          clientId: appointment.ClientId
        })
      });

      return {
        success: true,
        details: {
          appointmentId: appointment.Id,
          action: 'deleted'
        }
      };
    } catch (error) {
      console.error('Error handling appointment deletion:', error);
      throw error;
    }
  }

  /**
   * Map IntakeQ status to our internal status format
   */
  private mapIntakeQStatus(intakeQStatus: string): 'scheduled' | 'completed' | 'cancelled' | 'rescheduled' {
    const status = intakeQStatus.toLowerCase();
    
    if (status.includes('cancel') || status.includes('declined')) {
      return 'cancelled';
    } else if (status.includes('complet') || status.includes('attended')) {
      return 'completed';
    } else if (status.includes('reschedul')) {
      return 'rescheduled';
    }
    
    // Default to scheduled for any other status
    return 'scheduled';
  }

  /**
   * Convert IntakeQ appointment to our AppointmentRecord format
   */
  private async convertToAppointmentRecord(
    appointment: IntakeQAppointment
  ): Promise<AppointmentRecord> {
    try {
      // Sanitize client name and other text fields
      const safeClientName = this.sanitizeText(appointment.ClientName || '');
      const safePractitionerName = this.sanitizeText(appointment.PractitionerName || '');
      const safeServiceName = this.sanitizeText(appointment.ServiceName || '');
      
      // Get all clinicians to find the matching one
      const clinicians = await this.sheetsService.getClinicians();
      
      // Find clinician by IntakeQ practitioner ID
      const clinician = clinicians.find(
        c => c.intakeQPractitionerId === appointment.PractitionerId
      );
      
      // Convert the appointment to our format
      return {
        appointmentId: appointment.Id,
        clientId: appointment.ClientId.toString(),
        clientName: safeClientName,
        clinicianId: clinician?.clinicianId || appointment.PractitionerId,
        clinicianName: clinician?.name || safePractitionerName,
        officeId: 'A-v', // Default to virtual until office assignment
        sessionType: this.determineSessionType(appointment),
        startTime: appointment.StartDateIso,
        endTime: appointment.EndDateIso,
        status: 'scheduled',
        lastUpdated: new Date().toISOString(),
        source: 'intakeq',
        requirements: await this.determineRequirements(appointment),
        notes: `Service: ${safeServiceName}`
      };
    } catch (error: unknown) {
      console.error('Error converting appointment:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to convert appointment: ${errorMessage}`);
    }
  }
  
  // Add this helper method after the convertToAppointmentRecord method
  private sanitizeText(text: string): string {
    // Remove any non-printable characters
    return text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      // Strip any characters that might cause JSON issues
      .replace(/[\\"]/g, ' ');
  }

  /**
   * Determine any special requirements for the appointment
   */
  private async determineRequirements(
    appointment: IntakeQAppointment
  ): Promise<{ accessibility?: boolean; specialFeatures?: string[] }> {
    // Try to find client preferences
    const preferences = await this.sheetsService.getClientPreferences();
    const clientPreference = preferences.find(
      p => p.clientId === appointment.ClientId.toString()
    );
    
    if (!clientPreference) {
      return { accessibility: false, specialFeatures: [] };
    }
    
    // Process accessibility requirements
    return {
      accessibility: Array.isArray(clientPreference.mobilityNeeds) && 
                    clientPreference.mobilityNeeds.length > 0,
      specialFeatures: [
        ...(Array.isArray(clientPreference.sensoryPreferences) ? clientPreference.sensoryPreferences : []),
        ...(Array.isArray(clientPreference.physicalNeeds) ? clientPreference.physicalNeeds : [])
      ]
    };
  }

  /**
   * Check if client has any special requirements
   */
  private async hasSpecialRequirements(appointment: IntakeQAppointment): Promise<boolean> {
    // Get client preferences
    const preferences = await this.sheetsService.getClientPreferences();
    const clientPreference = preferences.find(
      p => p.clientId === appointment.ClientId.toString()
    );
    
    if (!clientPreference) return false;
    
    // Check for special requirements
    const hasAccessibilityNeeds = Array.isArray(clientPreference.mobilityNeeds) && 
                                 clientPreference.mobilityNeeds.length > 0;
    
    const hasSensoryPreferences = Array.isArray(clientPreference.sensoryPreferences) && 
                                 clientPreference.sensoryPreferences.length > 0;
    
    const hasPhysicalNeeds = Array.isArray(clientPreference.physicalNeeds) && 
                            clientPreference.physicalNeeds.length > 0;
    
    return hasAccessibilityNeeds || hasSensoryPreferences || hasPhysicalNeeds;
  }

  /**
   * Determine the session type based on appointment details
   */
  private determineSessionType(
    appointment: IntakeQAppointment
  ): 'in-person' | 'telehealth' | 'group' | 'family' {
    const serviceName = appointment.ServiceName.toLowerCase();
    
    // Map commonly used telehealth terms
    if (serviceName.match(/tele(health|therapy|med|session)|virtual|remote|video/)) {
      return 'telehealth';
    }
  
    // Map group therapy variations
    if (serviceName.match(/group|workshop|class|seminar/)) {
      return 'group';
    }
  
    // Map family therapy variations
    if (serviceName.match(/family|couples|relationship|parental|parent-child/)) {
      return 'family';
    }
  
    // Default to in-person if no other matches
    return 'in-person';
  }

  /**
   * Determine best office assignment for an appointment
   * This is a simplified version until we implement the full office assignment logic
   */
  /**
 * Determine best office assignment for an appointment
 * Uses the priority-based rule system from the Assignment Rules sheet
 */
async determineOfficeAssignment(appointment: IntakeQAppointment): Promise<OfficeAssignmentResult> {
  try {
    console.log(`Determining office assignment for appointment ${appointment.Id}`);
    
    // 1. Get all configuration data
    const assignmentRules = await this.sheetsService.getAssignmentRules();
    const offices = await this.sheetsService.getOffices();
    const clinicians = await this.sheetsService.getClinicians();
    
    // Filter for active offices
    const activeOffices = offices.filter(o => o.inService);
    if (activeOffices.length === 0) {
      console.warn('No active offices found, using default');
      return {
        officeId: 'B-1',
        reasons: ['No active offices found, using default']
      };
    }
    
    // Get active rules sorted by priority (highest first)
    const activeRules = assignmentRules
      .filter(rule => rule.active)
      .sort((a, b) => b.priority - a.priority);
    
    console.log(`Processing ${activeRules.length} active assignment rules`);
    
    // 2. RULE PRIORITY 100: Client Specific Requirement
    // Check if client has a required office in the Required Offices tab
    try {
      const clientRequirements = await this.sheetsService.getClientRequiredOffices();
      
      // Match by name since ID might not be available
      let clientRequirement = null;
      
      if (appointment.ClientLastName && appointment.ClientFirstName) {
        clientRequirement = clientRequirements.find(
          (r: any) => !r.inactive && 
             r.lastName === appointment.ClientLastName &&
             r.firstName === appointment.ClientFirstName &&
             r.requiredOfficeId
        );
      }
      
      // If client has a specific required office, use it
      if (clientRequirement && clientRequirement.requiredOfficeId) {
        console.log(`Client ${appointment.ClientName} has required office: ${clientRequirement.requiredOfficeId}`);
        return {
          officeId: standardizeOfficeId(clientRequirement.requiredOfficeId),
          reasons: ['Client has specific office requirement noted by clinician']
        };
      }
    } catch (error) {
      console.error('Error checking client required offices, continuing with other rules:', error);
      // Continue to next rule if this fails
    }
    
    // 3. RULE PRIORITY 90: Accessibility Requirements
    // Check if client has accessibility needs from Client Accessibility Info tab
    const clientAccessibilityInfo = await this.sheetsService.getClientAccessibilityInfo(appointment.ClientId.toString());
    
    if (clientAccessibilityInfo && clientAccessibilityInfo.hasMobilityNeeds) {
      console.log(`Client ${appointment.ClientName} has mobility needs, finding accessible office`);
      
      // Get accessible offices
      const accessibleOffices = activeOffices.filter(o => o.isAccessible);
      
      if (accessibleOffices.length > 0) {
        // Prioritize B-4 first, then C-3 as specified in rule
        const prioritizedOffices = ['B-4', 'C-3'];
        
        for (const officeId of prioritizedOffices) {
          const matchingOffice = accessibleOffices.find(o => 
            standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId)
          );
          
          if (matchingOffice) {
            return {
              officeId: standardizeOfficeId(matchingOffice.officeId),
              reasons: ['Client requires accessible office space']
            };
          }
        }
        
        // If specific accessible offices not found, use any accessible office
        return {
          officeId: standardizeOfficeId(accessibleOffices[0].officeId),
          reasons: ['Client requires accessible office space']
        };
      }
    }
    
    // 4. RULE PRIORITY 80/75: Age-based assignments
    // Calculate client age if DOB is available
    let clientAge: number | undefined;
    if (appointment.ClientDateOfBirth) {
      const dob = new Date(appointment.ClientDateOfBirth);
      const today = new Date();
      clientAge = today.getFullYear() - dob.getFullYear();
      
      // Adjust age if birthday hasn't occurred yet this year
      const monthDiff = today.getMonth() - dob.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
        clientAge--;
      }
      
      console.log(`Client ${appointment.ClientName} age calculated as: ${clientAge}`);
      
      // Apply age-based rules
      if (clientAge <= 10) {
        // Young Children rule (priority 80)
        const youngChildrenOffice = activeOffices.find(o => 
          standardizeOfficeId(o.officeId) === 'B-5'
        );
        
        if (youngChildrenOffice) {
          return {
            officeId: 'B-5',
            reasons: [`Age-based rule: client age ${clientAge} ≤ 10`]
          };
        }
      } else if (clientAge >= 11 && clientAge <= 17) {
        // Older Children and Teens rule (priority 75)
        const teenOffice = activeOffices.find(o => 
          standardizeOfficeId(o.officeId) === 'C-1'
        );
        
        if (teenOffice) {
          return {
            officeId: 'C-1',
            reasons: [`Age-based rule: client age ${clientAge} (11-17)`]
          };
        }
      }
    }
    
    // 5. RULE PRIORITY 70: Adults
    if (clientAge !== undefined && clientAge >= 18) {
      // Adult-appropriate offices
      const adultOffices = ['B-4', 'C-2', 'C-3'];
      
      // Check each office in priority order
      for (const officeId of adultOffices) {
        const availableOffice = await this.isOfficeAvailable(officeId, appointment);
        if (availableOffice) {
          return {
            officeId: standardizeOfficeId(officeId),
            reasons: [`Adult client (age ${clientAge}) assigned to appropriate office`]
          };
        }
      }
    }
    
    // 6. RULE PRIORITY 65: Family Sessions
    const sessionType = this.determineSessionType(appointment);
    
    if (sessionType === 'family') {
      console.log(`Family session, looking for larger room`);
      
      // Family session offices (larger rooms)
      const familyOffices = ['C-2', 'C-3'];
      
      for (const officeId of familyOffices) {
        const availableOffice = await this.isOfficeAvailable(officeId, appointment);
        if (availableOffice) {
          return {
            officeId: standardizeOfficeId(officeId),
            reasons: ['Family session requires larger space']
          };
        }
      }
    }
    
    // 7. RULE PRIORITY 60: In-Person Priority
    if (sessionType === 'in-person') {
      console.log(`In-person session, prioritizing physical offices`);
      
      // All physical offices except break room
      const physicalOffices = ['B-4', 'B-5', 'C-1', 'C-2', 'C-3'];
      
      for (const officeId of physicalOffices) {
        const availableOffice = await this.isOfficeAvailable(officeId, appointment);
        if (availableOffice) {
          return {
            officeId: standardizeOfficeId(officeId),
            reasons: ['In-person session assigned to physical office']
          };
        }
      }
    }
    
    // 8. RULE PRIORITY 50: Clinician Primary Office
    const clinician = clinicians.find(c => c.intakeQPractitionerId === appointment.PractitionerId);
    
    if (clinician) {
      const primaryOffice = activeOffices.find(o => o.primaryClinician === clinician.clinicianId);
      
      if (primaryOffice) {
        const availableOffice = await this.isOfficeAvailable(primaryOffice.officeId, appointment);
        
        if (availableOffice) {
          return {
            officeId: standardizeOfficeId(primaryOffice.officeId),
            reasons: ['Clinician primary office']
          };
        }
      }
    }
    
    // 9. RULE PRIORITY 45: Clinician Preferred Office
    if (clinician && clinician.preferredOffices && clinician.preferredOffices.length > 0) {
      for (const officeId of clinician.preferredOffices) {
        const availableOffice = await this.isOfficeAvailable(officeId, appointment);
        
        if (availableOffice) {
          return {
            officeId: standardizeOfficeId(officeId),
            reasons: ['Clinician preferred office']
          };
        }
      }
    }
    
    // 10. RULE PRIORITY 40: Telehealth to Preferred Office
    if (sessionType === 'telehealth' && clinician && clinician.preferredOffices && clinician.preferredOffices.length > 0) {
      for (const officeId of clinician.preferredOffices) {
        const availableOffice = await this.isOfficeAvailable(officeId, appointment);
        
        if (availableOffice) {
          return {
            officeId: standardizeOfficeId(officeId),
            reasons: ['Telehealth session using clinician preferred office']
          };
        }
      }
    }
    
    // 11. RULE PRIORITY 35: Special Features Match
    if (clientAccessibilityInfo && 
        (clientAccessibilityInfo.hasSensoryNeeds || 
         clientAccessibilityInfo.hasPhysicalNeeds ||
         clientAccessibilityInfo.hasSupport)) {
      
      // Find offices with matching features
      for (const office of activeOffices) {
        // If office has special features that match client needs
        if (office.specialFeatures && office.specialFeatures.length > 0) {
          const hasMatchingFeatures = true; // Simplified for now
          
          if (hasMatchingFeatures) {
            const availableOffice = await this.isOfficeAvailable(office.officeId, appointment);
            
            if (availableOffice) {
              return {
                officeId: standardizeOfficeId(office.officeId),
                reasons: ['Office has matching special features']
              };
            }
          }
        }
      }
    }
    
    // 12. RULE PRIORITY 30: Alternative Clinician Office
    if (clinician) {
      for (const office of activeOffices) {
        if (office.alternativeClinicians && 
            office.alternativeClinicians.includes(clinician.clinicianId)) {
          
          const availableOffice = await this.isOfficeAvailable(office.officeId, appointment);
          
          if (availableOffice) {
            return {
              officeId: standardizeOfficeId(office.officeId),
              reasons: ['Office lists this clinician as alternative']
            };
          }
        }
      }
    }
    
    // 13. RULE PRIORITY 20: Available Office (any except break room)
    for (const office of activeOffices) {
      if (office.officeId !== 'B-1') {
        const availableOffice = await this.isOfficeAvailable(office.officeId, appointment);
        
        if (availableOffice) {
          return {
            officeId: standardizeOfficeId(office.officeId),
            reasons: ['Office is available during appointment time']
          };
        }
      }
    }
    
    // 14. RULE PRIORITY 15: Break Room Last Resort
    const breakRoomAvailable = await this.isOfficeAvailable('B-1', appointment);
    
    if (breakRoomAvailable) {
      return {
        officeId: 'B-1',
        reasons: ['Break room used as last resort for physical office']
      };
    }
    
    // 15. RULE PRIORITY 10: Default Telehealth
    if (sessionType === 'telehealth') {
      return {
        officeId: 'A-v',
        reasons: ['Default telehealth virtual office (last resort)']
      };
    }
    
    // If we get here, something went wrong - default to A-v
    console.warn('No suitable office found, defaulting to A-v');
    return {
      officeId: 'A-v',
      reasons: ['No suitable office found, using default virtual office']
    };
  } catch (error) {
    console.error('Error determining office assignment:', error);
    
    // Fall back to default office
    return {
      officeId: 'A-v',
      reasons: ['Error in assignment process, using default virtual office']
    };
  }
}

/**
 * Helper method to check if an office is available during the appointment time
 */
/**
 * Helper method to check if an office is available during the appointment time
 */
private async isOfficeAvailable(officeId: string, appointment: IntakeQAppointment): Promise<boolean> {
  try {
    // Get the appointment date from the ISO string
    const appointmentDate = appointment.StartDateIso.split('T')[0];
    
    // Get all appointments for the day
    const appointments = await this.sheetsService.getAppointments(
      appointmentDate, 
      appointmentDate
    );
    
    // Skip appointments with the same ID (for updates)
    const existingAppointments = appointments.filter(appt => 
      appt.appointmentId !== appointment.Id &&
      appt.status !== 'cancelled' &&
      appt.status !== 'rescheduled'
    );
    
    // Check for time conflicts with the target office
    const targetOfficeId = standardizeOfficeId(officeId);
    const startTime = new Date(appointment.StartDateIso).getTime();
    const endTime = new Date(appointment.EndDateIso).getTime();
    
    const conflictingAppt = existingAppointments.find(appt => {
      // Skip if different office
      if (standardizeOfficeId(appt.officeId) !== targetOfficeId) return false;
      
      // Parse times
      const apptStart = new Date(appt.startTime).getTime();
      const apptEnd = new Date(appt.endTime).getTime();
      
      // Check for overlap
      return (
        (startTime >= apptStart && startTime < apptEnd) ||
        (endTime > apptStart && endTime <= apptEnd) ||
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