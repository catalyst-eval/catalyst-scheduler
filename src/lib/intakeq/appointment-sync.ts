// src/lib/intakeq/appointment-sync.ts

// Import types from appropriate source (webhooks.ts)
import type { 
  WebhookEventType, 
  IntakeQAppointment, 
  IntakeQWebhookPayload 
} from '../../types/webhooks';

import type { IGoogleSheetsService, AuditEventType } from '../google/sheets';
import { 
  AppointmentRecord, 
  standardizeOfficeId,
  normalizeAppointmentRecord,
  RulePriority
} from '../../types/scheduling';

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
        // Handle deletion events
        return await this.handleAppointmentDeletion(payload.Appointment);
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
      appointmentRecord.assignedOfficeId = assignedOffice.officeId;
      appointmentRecord.assignmentReason = assignedOffice.reasons[0];
      
      // Also set currentOfficeId to the same value for new appointments
      appointmentRecord.currentOfficeId = assignedOffice.officeId;
      
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
      const currentOfficeId = existingAppointment.currentOfficeId || existingAppointment.officeId || 'TBD';
      
      // Keep track of the current office ID (for tracking changes)
      appointmentRecord.currentOfficeId = currentOfficeId;
      
      // Check if time or clinician changed, which would require reassignment
      const timeChanged = 
        appointmentRecord.startTime !== existingAppointment.startTime ||
        appointmentRecord.endTime !== existingAppointment.endTime;
      
      const clinicianChanged = 
        appointmentRecord.clinicianId !== existingAppointment.clinicianId;
      
      if (timeChanged || clinicianChanged) {
        // Determine new office assignment
        const assignedOffice = await this.determineOfficeAssignment(appointment);
        
        // Set new assignedOfficeId and reason
        appointmentRecord.assignedOfficeId = assignedOffice.officeId;
        appointmentRecord.assignmentReason = assignedOffice.reasons[0];
      } else {
        // Keep the existing assignedOfficeId and reason if no changes
        appointmentRecord.assignedOfficeId = existingAppointment.assignedOfficeId || existingAppointment.currentOfficeId || existingAppointment.officeId;
        appointmentRecord.assignmentReason = existingAppointment.assignmentReason || '';
      }
      
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
          currentOfficeId: appointmentRecord.currentOfficeId,
          assignedOfficeId: appointmentRecord.assignedOfficeId,
          action: 'updated',
          officeReassigned: appointmentRecord.assignedOfficeId !== currentOfficeId
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
      const updatedAppointment: AppointmentRecord = normalizeAppointmentRecord({
        ...existingAppointment,
        status: 'cancelled',
        lastUpdated: new Date().toISOString()
      });
      
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
      
      // Convert the appointment to our format with updated field names
      const appointmentRecord: AppointmentRecord = normalizeAppointmentRecord({
        appointmentId: appointment.Id,
        clientId: appointment.ClientId.toString(),
        clientName: safeClientName,
        clinicianId: clinician?.clinicianId || appointment.PractitionerId,
        clinicianName: clinician?.name || safePractitionerName,
        currentOfficeId: 'TBD', // Will be set by office assignment
        assignedOfficeId: 'TBD', // Will be set by office assignment
        assignmentReason: '',    // Will be set by office assignment
        sessionType: this.determineSessionType(appointment),
        startTime: appointment.StartDateIso,
        endTime: appointment.EndDateIso,
        status: this.mapIntakeQStatus(appointment.Status || ''),
        lastUpdated: new Date().toISOString(),
        source: 'intakeq',
        requirements: await this.determineRequirements(appointment),
        notes: `Service: ${safeServiceName}`
      });
      
      return appointmentRecord;
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
    // Try to get client accessibility info first (new schema)
    try {
      const accessibilityInfo = await this.sheetsService.getClientAccessibilityInfo(appointment.ClientId.toString());
      
      if (accessibilityInfo) {
        // Process accessibility requirements from the new schema
        const specialFeatures: string[] = [];
        
        // Add sensory features if any
        if (accessibilityInfo.hasSensoryNeeds && accessibilityInfo.sensoryDetails) {
          specialFeatures.push(accessibilityInfo.sensoryDetails);
        }
        
        // Add physical features if any
        if (accessibilityInfo.hasPhysicalNeeds && accessibilityInfo.physicalDetails) {
          specialFeatures.push(accessibilityInfo.physicalDetails);
        }
        
        // Return formatted accessibility requirements
        return {
          accessibility: accessibilityInfo.hasMobilityNeeds,
          specialFeatures: specialFeatures.filter(f => f.trim() !== '')
        };
      }
    } catch (error) {
      console.warn('Error getting client accessibility info, falling back to preferences:', error);
    }
    
    // Fall back to client preferences (old schema)
    try {
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
    } catch (error) {
      console.error('Error determining client requirements:', error);
      return { accessibility: false, specialFeatures: [] };
    }
  }

  /**
   * Check if client has any special requirements
   */
  private async hasSpecialRequirements(appointment: IntakeQAppointment): Promise<boolean> {
    // Check client accessibility info first (new schema)
    try {
      const accessibilityInfo = await this.sheetsService.getClientAccessibilityInfo(appointment.ClientId.toString());
      
      if (accessibilityInfo) {
        return (
          accessibilityInfo.hasMobilityNeeds ||
          accessibilityInfo.hasSensoryNeeds ||
          accessibilityInfo.hasPhysicalNeeds ||
          accessibilityInfo.hasSupport
        );
      }
    } catch (error) {
      console.warn('Error checking client accessibility info, falling back to preferences:', error);
    }
    
    // Fall back to client preferences (old schema)
    try {
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
    } catch (error) {
      console.error('Error checking for special requirements:', error);
      return false;
    }
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
 * Updated to match the priority-based logic in daily-schedule-service.ts
 */
async determineOfficeAssignment(appointment: IntakeQAppointment): Promise<OfficeAssignmentResult> {
  try {
    console.log(`Determining office assignment for appointment ${appointment.Id}`);
    
    // 1. Get all configuration data
    const assignmentRules = await this.sheetsService.getAssignmentRules();
    const offices = await this.sheetsService.getOffices();
    const clinicians = await this.sheetsService.getClinicians();
    const appointments = await this.sheetsService.getAllAppointments();
    
    // Filter for active offices
    const activeOffices = offices.filter(o => o.inService);
    if (activeOffices.length === 0) {
      console.warn('No active offices found, using default');
      return {
        officeId: 'A-v',
        reasons: ['No active offices found, using default']
      };
    }
    
    // Determine session type for rule evaluation
    const sessionType = this.determineSessionType(appointment);
    
    // Find matching clinician
    const clinician = clinicians.find(c => c.intakeQPractitionerId === appointment.PractitionerId);
    if (!clinician) {
      console.warn(`No matching clinician found for practitioner ID ${appointment.PractitionerId}`);
    } else {
      console.log(`Found matching clinician: ${clinician.name}`);
    }
    
    // Convert to AppointmentRecord for office availability checks
    const appointmentRecord = await this.convertToAppointmentRecord(appointment);
    
    // RULE PRIORITY 100: Client Specific Requirement
    // From Client_Preferences tab
    console.log("Checking PRIORITY 100: Client Specific Requirement");
    try {
      const clientPreferences = await this.sheetsService.getClientPreferences();
      const clientPreference = clientPreferences.find(p => p.clientId === appointment.ClientId.toString());
      
      if (clientPreference?.assignedOffice) {
        console.log(`Client ${appointment.ClientName} has assigned office: ${clientPreference.assignedOffice}`);
        return {
          officeId: standardizeOfficeId(clientPreference.assignedOffice),
          reasons: [`Client has specific office requirement (Priority ${RulePriority.CLIENT_SPECIFIC_REQUIREMENT})`]
        };
      }
    } catch (error) {
      console.error('Error checking client required offices:', error);
    }
    
    // RULE PRIORITY 90: Accessibility Requirements
    // From Client_Accessibility_Info tab
    console.log("Checking PRIORITY 90: Accessibility Requirements");
    try {
      const clientAccessibilityInfo = await this.sheetsService.getClientAccessibilityInfo(appointment.ClientId.toString());
      
      if (clientAccessibilityInfo?.hasMobilityNeeds) {
        console.log(`Client ${appointment.ClientName} has mobility needs, finding accessible office`);
        
        // Prioritize B-4, C-3 as specified in rule
        const prioritizedOffices = ['B-4', 'C-3'];
        
        for (const officeId of prioritizedOffices) {
          const matchingOffice = activeOffices.find(o => 
            standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId)
          );
          
          if (matchingOffice) {
            const isAvailable = await this.isOfficeAvailable(matchingOffice.officeId, appointmentRecord, appointments);
            if (isAvailable) {
              return {
                officeId: standardizeOfficeId(matchingOffice.officeId),
                reasons: [`Client requires accessible office (Priority ${RulePriority.ACCESSIBILITY_REQUIREMENT})`]
              };
            }
          }
        }
      }
    } catch (error) {
      console.error('Error checking accessibility needs:', error);
    }
    
    // RULE PRIORITY 80: Young Children
    console.log("Checking PRIORITY 80: Young Children");
    try {
      // Try to determine age from client date of birth
      let clientAge = null;
      if (appointment.ClientDateOfBirth) {
        const birthDate = new Date(appointment.ClientDateOfBirth);
        const today = new Date();
        clientAge = today.getFullYear() - birthDate.getFullYear();
        
        // Adjust for birth date not yet occurred this year
        const monthDiff = today.getMonth() - birthDate.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
          clientAge--;
        }
      }
      
      console.log(`Client age determined as: ${clientAge}`);
      
      if (clientAge !== null && clientAge <= 10) {
        console.log(`Client is 10 or under, checking B-5 availability`);
        
        const b5Office = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'B-5');
        if (b5Office) {
          const isAvailable = await this.isOfficeAvailable('B-5', appointmentRecord, appointments);
          if (isAvailable) {
            return {
              officeId: 'B-5',
              reasons: [`Young child (${clientAge} years old) assigned to B-5 (Priority ${RulePriority.YOUNG_CHILDREN})`]
            };
          }
        }
      }
    } catch (error) {
      console.error('Error processing age-based rule:', error);
    }
    
    // RULE PRIORITY 75: Older Children and Teens
    console.log("Checking PRIORITY 75: Older Children and Teens");
    try {
      // Try to determine age from client date of birth
      let clientAge = null;
      if (appointment.ClientDateOfBirth) {
        const birthDate = new Date(appointment.ClientDateOfBirth);
        const today = new Date();
        clientAge = today.getFullYear() - birthDate.getFullYear();
        
        // Adjust for birth date not yet occurred this year
        const monthDiff = today.getMonth() - birthDate.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
          clientAge--;
        }
      }
      
      if (clientAge !== null && clientAge >= 11 && clientAge <= 17) {
        console.log(`Client is 11-17, checking C-1 availability`);
        
        const c1Office = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'C-1');
        if (c1Office) {
          const isAvailable = await this.isOfficeAvailable('C-1', appointmentRecord, appointments);
          if (isAvailable) {
            return {
              officeId: 'C-1',
              reasons: [`Older child/teen (${clientAge} years old) assigned to C-1 (Priority ${RulePriority.OLDER_CHILDREN_TEENS})`]
            };
          }
        }
      }
    } catch (error) {
      console.error('Error processing age-based rule:', error);
    }
    
    // RULE PRIORITY 70: Adults
    console.log("Checking PRIORITY 70: Adults");
    try {
      // Try to determine age from client date of birth
      let clientAge = null;
      if (appointment.ClientDateOfBirth) {
        const birthDate = new Date(appointment.ClientDateOfBirth);
        const today = new Date();
        clientAge = today.getFullYear() - birthDate.getFullYear();
        
        // Adjust for birth date not yet occurred this year
        const monthDiff = today.getMonth() - birthDate.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
          clientAge--;
        }
      }
      
      if (clientAge !== null && clientAge >= 18) {
        console.log(`Client is adult (18+), checking adult offices`);
        
        // Try B-4, C-2, C-3 in order
        const adultOffices = ['B-4', 'C-2', 'C-3'];
        
        for (const officeId of adultOffices) {
          const office = activeOffices.find(o => standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId));
          if (office) {
            const isAvailable = await this.isOfficeAvailable(officeId, appointmentRecord, appointments);
            if (isAvailable) {
              return {
                officeId: standardizeOfficeId(officeId),
                reasons: [`Adult client assigned to ${officeId} (Priority ${RulePriority.ADULTS})`]
              };
            }
          }
        }
      }
    } catch (error) {
      console.error('Error processing adult rule:', error);
    }
    
    // RULE PRIORITY 65: Family Sessions
    console.log("Checking PRIORITY 65: Family Sessions");
    if (sessionType === 'family') {
      console.log('Family session detected, checking C-2, C-3');
      
      // Try C-2, C-3 in order for family sessions
      const familyOffices = ['C-2', 'C-3'];
      
      for (const officeId of familyOffices) {
        const office = activeOffices.find(o => standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId));
        if (office) {
          const isAvailable = await this.isOfficeAvailable(officeId, appointmentRecord, appointments);
          if (isAvailable) {
            return {
              officeId: standardizeOfficeId(officeId),
              reasons: [`Family session assigned to larger room ${officeId} (Priority ${RulePriority.FAMILY_SESSIONS})`]
            };
          }
        }
      }
    }
    
    // RULE PRIORITY 62: Clinician Primary Office
    console.log("Checking PRIORITY 62: Clinician Primary Office");
    if (clinician && clinician.preferredOffices && clinician.preferredOffices.length > 0) {
      // First preferred office is considered the primary
      const primaryOfficeId = clinician.preferredOffices[0];
      console.log(`Checking clinician primary office: ${primaryOfficeId}`);
      
      const isAvailable = await this.isOfficeAvailable(primaryOfficeId, appointmentRecord, appointments);
      if (isAvailable) {
        return {
          officeId: standardizeOfficeId(primaryOfficeId),
          reasons: [`Assigned to clinician's primary office (Priority ${RulePriority.CLINICIAN_PRIMARY_OFFICE})`]
        };
      }
    }
    
    // RULE PRIORITY 60: Clinician Preferred Office
    console.log("Checking PRIORITY 60: Clinician Preferred Office");
    if (clinician && clinician.preferredOffices?.length > 1) {
      console.log(`Checking clinician preferred offices: ${clinician.preferredOffices.slice(1).join(', ')}`);
      
      // Start from the second preferred office (first one was checked in previous rule)
      for (let i = 1; i < clinician.preferredOffices.length; i++) {
        const officeId = clinician.preferredOffices[i];
        const isAvailable = await this.isOfficeAvailable(officeId, appointmentRecord, appointments);
        
        if (isAvailable) {
          return {
            officeId: standardizeOfficeId(officeId),
            reasons: [`Assigned to clinician's preferred office (Priority ${RulePriority.CLINICIAN_PREFERRED_OFFICE})`]
          };
        }
      }
    }
    
    // RULE PRIORITY 55: In-Person Priority
    console.log("Checking PRIORITY 55: In-Person Priority");
    if (sessionType === 'in-person') {
      console.log('In-person session, checking all physical offices');
      
      // Try all physical offices in order: B-1, B-4, B-5, C-1, C-2, C-3
      const physicalOffices = ['B-1', 'B-4', 'B-5', 'C-1', 'C-2', 'C-3'];
      
      for (const officeId of physicalOffices) {
        const office = activeOffices.find(o => standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId));
        if (office) {
          const isAvailable = await this.isOfficeAvailable(officeId, appointmentRecord, appointments);
          if (isAvailable) {
            return {
              officeId: standardizeOfficeId(officeId),
              reasons: [`In-person session assigned to ${officeId} (Priority ${RulePriority.IN_PERSON_PRIORITY})`]
            };
          }
        }
      }
    }
    
    // RULE PRIORITY 40: Telehealth to Preferred Office
    console.log("Checking PRIORITY 40: Telehealth to Preferred Office");
    if (sessionType === 'telehealth' && clinician && clinician.preferredOffices) {
      console.log(`Checking telehealth assignment to clinician's preferred office`);
      
      for (const officeId of clinician.preferredOffices) {
        const office = activeOffices.find(o => 
          standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId)
        );
        
        if (office) {
          const isAvailable = await this.isOfficeAvailable(officeId, appointmentRecord, appointments);
          
          if (isAvailable) {
            return {
              officeId: standardizeOfficeId(officeId),
              reasons: [`Telehealth assigned to clinician's preferred office (Priority ${RulePriority.TELEHEALTH_PREFERRED})`]
            };
          }
        }
      }
    }
    
    // RULE PRIORITY 35: Special Features Match
    console.log("Checking PRIORITY 35: Special Features Match");
    try {
      // Get client requirements
      const requirements = await this.determineRequirements(appointment);
      
      if (requirements.specialFeatures && requirements.specialFeatures.length > 0) {
        console.log(`Client has special features requirements`);
        
        // Check each office for matching features
        for (const office of activeOffices) {
          if (office.specialFeatures && office.specialFeatures.length > 0) {
            // Check if any client features match office features
            const hasMatch = requirements.specialFeatures.some(feature => 
              office.specialFeatures.includes(feature)
            );
            
            if (hasMatch) {
              const isAvailable = await this.isOfficeAvailable(office.officeId, appointmentRecord, appointments);
              
              if (isAvailable) {
                return {
                  officeId: standardizeOfficeId(office.officeId),
                  reasons: [`Office has matching special features (Priority ${RulePriority.SPECIAL_FEATURES_MATCH})`]
                };
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Error checking special features match:', error);
    }
    
    // RULE PRIORITY 30: Alternative Clinician Office
    console.log("Checking PRIORITY 30: Alternative Clinician Office");
    if (clinician) {
      // Find offices where this clinician is listed as an alternative
      const alternativeOffices = activeOffices.filter(o => 
        o.alternativeClinicians && 
        o.alternativeClinicians.includes(clinician.clinicianId)
      );
      
      for (const office of alternativeOffices) {
        console.log(`Checking alternative clinician office: ${office.officeId}`);
        const isAvailable = await this.isOfficeAvailable(office.officeId, appointmentRecord, appointments);
        
        if (isAvailable) {
          return {
            officeId: standardizeOfficeId(office.officeId),
            reasons: [`Assigned to alternative clinician office (Priority ${RulePriority.ALTERNATIVE_CLINICIAN})`]
          };
        }
      }
    }
    
    // RULE PRIORITY 20: Available Office
    console.log("Checking PRIORITY 20: Available Office");
    // Check all offices for availability, exclude break room (B-1)
    for (const office of activeOffices) {
      if (office.officeId !== 'B-1') {
        const isAvailable = await this.isOfficeAvailable(office.officeId, appointmentRecord, appointments);
        
        if (isAvailable) {
          return {
            officeId: standardizeOfficeId(office.officeId),
            reasons: [`Assigned to available office ${office.officeId} (Priority ${RulePriority.AVAILABLE_OFFICE})`]
          };
        }
      }
    }
    
    // RULE PRIORITY 15: Break Room Last Resort
    console.log("Checking PRIORITY 15: Break Room Last Resort");
    if (sessionType !== 'telehealth') {
      const breakRoom = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'B-1');
      if (breakRoom) {
        const isAvailable = await this.isOfficeAvailable('B-1', appointmentRecord, appointments);
        
        if (isAvailable) {
          return {
            officeId: 'B-1',
            reasons: [`Break room used as last resort for physical session (Priority ${RulePriority.BREAK_ROOM_LAST_RESORT})`]
          };
        }
      }
    }
    
    // RULE PRIORITY 10: Default Telehealth
    console.log("Checking PRIORITY 10: Default Telehealth");
    if (sessionType === 'telehealth') {
      return {
        officeId: 'A-v',
        reasons: [`Virtual office (A-v) for telehealth as last resort (Priority ${RulePriority.DEFAULT_TELEHEALTH})`]
      };
    }
    
    // If we've gone through all rules and still don't have an office,
    // default to A-v as an absolute last resort
    console.warn('No suitable office found after applying all rules');
    return {
      officeId: 'A-v',
      reasons: ['No suitable office found after trying all rules']
    };
  } catch (error) {
    console.error('Error determining office assignment:', error);
    return {
      officeId: 'A-v',
      reasons: ['Error in office assignment process']
    };
  }
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
    // Standardize the office ID
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
      // IMPORTANT: We check assignedOfficeId first, then currentOfficeId
      const apptOfficeId = standardizeOfficeId(
        appt.assignedOfficeId || appt.currentOfficeId || 
        // For backward compatibility, access officeId with bracket notation
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