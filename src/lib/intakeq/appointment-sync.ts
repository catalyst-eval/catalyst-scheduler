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
        officeId: 'A-v',
        reasons: ['No active offices found, using default']
      };
    }
    
    // Get active rules sorted by priority (highest first)
    const activeRules = assignmentRules
      .filter(rule => rule.active)
      .sort((a, b) => b.priority - a.priority);
    
    // Log all rules we're about to process
    console.log(`Processing ${activeRules.length} active assignment rules:`);
    activeRules.forEach(rule => {
      console.log(`Rule: ${rule.ruleName} (Priority ${rule.priority})`);
    });
    
    // Determine session type and client age for rule evaluation
    const sessionType = this.determineSessionType(appointment);
    
    // Find matching clinician
    const clinician = clinicians.find(c => c.intakeQPractitionerId === appointment.PractitionerId);
    if (!clinician) {
      console.warn(`No matching clinician found for practitioner ID ${appointment.PractitionerId}`);
    } else {
      console.log(`Found matching clinician: ${clinician.name}`);
    }
    
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
          reasons: ['Priority 100: Client has specific office requirement']
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
            const availableOffice = await this.isOfficeAvailable(matchingOffice.officeId, appointment);
            if (availableOffice) {
              return {
                officeId: standardizeOfficeId(matchingOffice.officeId),
                reasons: ['Priority 90: Client requires accessible office space']
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
          const available = await this.isOfficeAvailable('B-5', appointment);
          if (available) {
            return {
              officeId: 'B-5',
              reasons: ['Priority 80: Young children (10 and under) assigned to B-5']
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
          const available = await this.isOfficeAvailable('C-1', appointment);
          if (available) {
            return {
              officeId: 'C-1',
              reasons: ['Priority 75: Older children and teens (11-17) assigned to C-1']
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
            const available = await this.isOfficeAvailable(officeId, appointment);
            if (available) {
              return {
                officeId: standardizeOfficeId(officeId),
                reasons: [`Priority 70: Adult client assigned to ${officeId}`]
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
          const available = await this.isOfficeAvailable(officeId, appointment);
          if (available) {
            return {
              officeId: standardizeOfficeId(officeId),
              reasons: [`Priority 65: Family session assigned to larger room ${officeId}`]
            };
          }
        }
      }
    }
    
    // RULE PRIORITY 60: In-Person Priority
    console.log("Checking PRIORITY 60: In-Person Priority");
    if (sessionType === 'in-person') {
      console.log('In-person session, checking all physical offices');
      
      // Try all physical offices in order: B-1, B-4, B-5, C-1, C-2, C-3
      const physicalOffices = ['B-1', 'B-4', 'B-5', 'C-1', 'C-2', 'C-3'];
      
      for (const officeId of physicalOffices) {
        const office = activeOffices.find(o => standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId));
        if (office) {
          const available = await this.isOfficeAvailable(officeId, appointment);
          if (available) {
            return {
              officeId: standardizeOfficeId(officeId),
              reasons: [`Priority 60: In-person session assigned to ${officeId}`]
            };
          }
        }
      }
    }
    
    // RULE PRIORITY 50: Clinician Primary Office
    console.log("Checking PRIORITY 50: Clinician Primary Office");
    if (clinician) {
      // Find offices where this clinician is the primary
      const primaryOffices = activeOffices.filter(o => o.primaryClinician === clinician.clinicianId);
      
      for (const office of primaryOffices) {
        console.log(`Checking clinician primary office: ${office.officeId}`);
        const available = await this.isOfficeAvailable(office.officeId, appointment);
        
        if (available) {
          return {
            officeId: standardizeOfficeId(office.officeId),
            reasons: [`Priority 50: Assigned to clinician's primary office`]
          };
        }
      }
    }
    
    // RULE PRIORITY 45: Clinician Preferred Office
    console.log("Checking PRIORITY 45: Clinician Preferred Office");
    if (clinician && clinician.preferredOffices && clinician.preferredOffices.length > 0) {
      console.log(`Clinician preferred offices: ${clinician.preferredOffices.join(', ')}`);
      
      for (const officeId of clinician.preferredOffices) {
        // Verify the office exists and is active
        const office = activeOffices.find(o => 
          standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId)
        );
        
        if (office) {
          const available = await this.isOfficeAvailable(officeId, appointment);
          
          if (available) {
            return {
              officeId: standardizeOfficeId(officeId),
              reasons: [`Priority 45: Assigned to clinician's preferred office`]
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
          const available = await this.isOfficeAvailable(officeId, appointment);
          
          if (available) {
            return {
              officeId: standardizeOfficeId(officeId),
              reasons: [`Priority 40: Telehealth assigned to clinician's preferred office`]
            };
          }
        }
      }
    }
    
    // RULE PRIORITY 35: Special Features Match
    console.log("Checking PRIORITY 35: Special Features Match");
    try {
      // Get client requirements
      const clientPreferences = await this.sheetsService.getClientPreferences();
      const clientPreference = clientPreferences.find(p => p.clientId === appointment.ClientId.toString());
      
      if (clientPreference && 
          (clientPreference.specialFeatures || 
           clientPreference.sensoryPreferences || 
           clientPreference.physicalNeeds)) {
        
        console.log(`Client has special features requirements`);
        
        // Collect all client requirements
        const clientFeatures = [
          ...(clientPreference.specialFeatures || []),
          ...(clientPreference.sensoryPreferences || []),
          ...(clientPreference.physicalNeeds || [])
        ];
        
        // Find offices with matching features
        for (const office of activeOffices) {
          if (office.specialFeatures && office.specialFeatures.length > 0) {
            // Check if any client features match office features
            const hasMatch = clientFeatures.some(feature => 
              office.specialFeatures.includes(feature)
            );
            
            if (hasMatch) {
              const available = await this.isOfficeAvailable(office.officeId, appointment);
              
              if (available) {
                return {
                  officeId: standardizeOfficeId(office.officeId),
                  reasons: [`Priority 35: Office has matching special features`]
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
        const available = await this.isOfficeAvailable(office.officeId, appointment);
        
        if (available) {
          return {
            officeId: standardizeOfficeId(office.officeId),
            reasons: [`Priority 30: Assigned to alternative clinician office`]
          };
        }
      }
    }
    
    // RULE PRIORITY 20: Available Office
    console.log("Checking PRIORITY 20: Available Office");
    // Check all offices for availability
    for (const office of activeOffices) {
      if (office.officeId !== 'B-1') { // Skip the break room for this rule
        const available = await this.isOfficeAvailable(office.officeId, appointment);
        
        if (available) {
          return {
            officeId: standardizeOfficeId(office.officeId),
            reasons: [`Priority 20: Assigned to available office ${office.officeId}`]
          };
        }
      }
    }
    
    // RULE PRIORITY 15: Break Room Last Resort
    console.log("Checking PRIORITY 15: Break Room Last Resort");
    if (sessionType !== 'telehealth') {
      const breakRoom = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'B-1');
      if (breakRoom) {
        const available = await this.isOfficeAvailable('B-1', appointment);
        
        if (available) {
          return {
            officeId: 'B-1',
            reasons: ['Priority 15: Break room used as last resort for physical session']
          };
        }
      }
    }
    
    // RULE PRIORITY 10: Default Telehealth
    console.log("Checking PRIORITY 10: Default Telehealth");
    if (sessionType === 'telehealth') {
      return {
        officeId: 'A-v',
        reasons: ['Priority 10: Virtual office (A-v) for telehealth as last resort']
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