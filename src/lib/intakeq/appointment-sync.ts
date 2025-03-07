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
  // Update in src/lib/intakeq/appointment-sync.ts - processAppointmentEvent method:

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
        eventType: 'WEBHOOK_RECEIVED', // Use string directly instead of AuditEventType
        description: `Received ${payload.Type || payload.EventType} webhook`,
        user: 'INTAKEQ_WEBHOOK',
        systemNotes: JSON.stringify({
          appointmentId: payload.Appointment.Id,
          type: payload.Type || payload.EventType,
          clientId: payload.ClientId
        })
      });
  
      const eventType = payload.Type || payload.EventType;
        
      // Handle appointment events based on type
      if (eventType?.includes('Created')) {
        // For created events
        return await this.handleNewAppointment(payload.Appointment);
      } 
      else if (eventType?.includes('Updated') || 
               eventType?.includes('Rescheduled') || 
               eventType?.includes('Confirmed')) {
        // For update, reschedule, and confirm events
        return await this.handleAppointmentUpdate(payload.Appointment);
      }
      else if (eventType?.includes('Cancelled') || eventType?.includes('Canceled')) {
        // For cancellation events
        return await this.handleAppointmentCancellation(payload.Appointment);
      }
      else if (eventType?.includes('Deleted')) {
        // Handle deletion events if you have a method for it
        // return await this.handleAppointmentDeletion(payload.Appointment);
        return {
          success: false,
          error: `Deletion events not yet supported: ${eventType}`,
          retryable: false
        };
      }
      else {
        // Unsupported event type
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
        eventType: 'SYSTEM_ERROR', // Use string directly
        description: `Error processing appointment ${payload.Appointment.Id}`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
  
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        retryable: true
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
    // Check if client has a required office from Client_Preferences
    try {
      const clientPreferences = await this.sheetsService.getClientPreferences();
      
      // Look for client by ID
      const clientPreference = clientPreferences.find(p => p.clientId === appointment.ClientId.toString());
      
      // If client has a specific assigned office, use it (highest priority)
      if (clientPreference?.assignedOffice) {
        console.log(`Client ${appointment.ClientName} has assigned office: ${clientPreference.assignedOffice}`);
        return {
          officeId: standardizeOfficeId(clientPreference.assignedOffice),
          reasons: ['Client has specific office requirement from preferences']
        };
      }
      
      // Also check Required Offices (legacy method)
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
            const availableOffice = await this.isOfficeAvailable(matchingOffice.officeId, appointment);
            if (availableOffice) {
              return {
                officeId: standardizeOfficeId(matchingOffice.officeId),
                reasons: ['Client requires accessible office space']
              };
            }
          }
        }
        
        // If specific accessible offices not found or not available, try any accessible office
        for (const office of accessibleOffices) {
          const availableOffice = await this.isOfficeAvailable(office.officeId, appointment);
          if (availableOffice) {
            return {
              officeId: standardizeOfficeId(office.officeId),
              reasons: ['Client requires accessible office space']
            };
          }
        }
      }
    }
    
    // Determine session type early for use in later rules
    const sessionType = this.determineSessionType(appointment);
    
    // Find the matching clinician
    const clinician = clinicians.find(c => c.intakeQPractitionerId === appointment.PractitionerId);
    if (!clinician) {
      console.warn(`No matching clinician found for practitioner ID ${appointment.PractitionerId}`);
    } else {
      console.log(`Found matching clinician: ${clinician.name}`);
    }
    
    // 8. RULE PRIORITY 50: Clinician Primary Office - IMPROVED IMPLEMENTATION
    if (clinician) {
      // Check if clinician has a primary office defined
      const primaryOffices = activeOffices.filter(o => o.primaryClinician === clinician.clinicianId);
      
      for (const primaryOffice of primaryOffices) {
        console.log(`Checking clinician primary office: ${primaryOffice.officeId}`);
        const availableOffice = await this.isOfficeAvailable(primaryOffice.officeId, appointment);
        
        if (availableOffice) {
          return {
            officeId: standardizeOfficeId(primaryOffice.officeId),
            reasons: [`Clinician primary office (priority 50): ${primaryOffice.name}`]
          };
        } else {
          console.log(`Primary office ${primaryOffice.officeId} not available during appointment time`);
        }
      }
    }
    
    // 9. RULE PRIORITY 45: Clinician Preferred Office - IMPROVED IMPLEMENTATION
    if (clinician && clinician.preferredOffices && clinician.preferredOffices.length > 0) {
      console.log(`Checking clinician preferred offices: ${clinician.preferredOffices.join(', ')}`);
      
      for (const officeId of clinician.preferredOffices) {
        // Verify the office exists and is active
        const preferredOffice = activeOffices.find(o => 
          standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId)
        );
        
        if (preferredOffice) {
          const availableOffice = await this.isOfficeAvailable(officeId, appointment);
          
          if (availableOffice) {
            return {
              officeId: standardizeOfficeId(officeId),
              reasons: [`Clinician preferred office (priority 45): ${preferredOffice.name}`]
            };
          } else {
            console.log(`Preferred office ${officeId} not available during appointment time`);
          }
        }
      }
    }
    
    // 10. RULE PRIORITY 40: Telehealth to Preferred Office - IMPROVED IMPLEMENTATION
    if (sessionType === 'telehealth' && clinician) {
      console.log('Telehealth session, applying rule priority 40');
      
      // For telehealth, try to use a clinician's preferred office if available
      if (clinician.preferredOffices && clinician.preferredOffices.length > 0) {
        for (const officeId of clinician.preferredOffices) {
          const preferredOffice = activeOffices.find(o => 
            standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId)
          );
          
          if (preferredOffice) {
            const availableOffice = await this.isOfficeAvailable(officeId, appointment);
            
            if (availableOffice) {
              return {
                officeId: standardizeOfficeId(officeId),
                reasons: [`Telehealth assigned to clinician preferred office (priority 40): ${preferredOffice.name}`]
              };
            }
          }
        }
      }
      
      // For telehealth, also try to use the clinician's primary office if it exists
      const primaryOffices = activeOffices.filter(o => o.primaryClinician === clinician.clinicianId);
      
      for (const primaryOffice of primaryOffices) {
        const availableOffice = await this.isOfficeAvailable(primaryOffice.officeId, appointment);
        
        if (availableOffice) {
          return {
            officeId: standardizeOfficeId(primaryOffice.officeId),
            reasons: [`Telehealth assigned to clinician primary office: ${primaryOffice.name}`]
          };
        }
      }
    }
    
    // Continue with the rest of the rules...
    
    // If we get to the end and it's a telehealth session, only then use A-v as a last resort
    if (sessionType === 'telehealth') {
      return {
        officeId: 'A-v',
        reasons: ['Last resort for telehealth: virtual office assignment']
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
      
      // Check for ACTUAL overlap - ensuring we don't flag back-to-back appointments
      return (
        // Appointment starts during existing appointment
        (startTime >= apptStart && startTime < apptEnd) ||
        // Appointment ends during existing appointment
        (endTime > apptStart && endTime <= apptEnd) ||
        // Appointment completely contains existing appointment
        (startTime < apptStart && endTime > apptEnd)
      );
    });
    
    return !conflictingAppt;
  } catch (error) {
    console.error(`Error checking office availability for ${officeId}:`, error);
    return false; // Assume not available on error
  }
}
}