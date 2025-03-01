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
   * Convert IntakeQ appointment to our AppointmentRecord format
   */
  private async convertToAppointmentRecord(
    appointment: IntakeQAppointment
  ): Promise<AppointmentRecord> {
    try {
      // Get all clinicians to find the matching one
      const clinicians = await this.sheetsService.getClinicians();
      
      // Find clinician by IntakeQ practitioner ID
      const clinician = clinicians.find(
        c => c.intakeQPractitionerId === appointment.PractitionerId
      );
      
      if (!clinician) {
        console.warn(`No mapping found for IntakeQ practitioner ID: ${appointment.PractitionerId}, using raw data`);
      }

      // Convert the appointment to our format
      return {
        appointmentId: appointment.Id,
        clientId: appointment.ClientId.toString(),
        clientName: appointment.ClientName,
        clinicianId: clinician?.clinicianId || appointment.PractitionerId,
        clinicianName: clinician?.name || appointment.PractitionerName,
        officeId: 'B-1', // Default to be replaced by office assignment
        sessionType: this.determineSessionType(appointment),
        startTime: appointment.StartDateIso,
        endTime: appointment.EndDateIso,
        status: 'scheduled',
        lastUpdated: new Date().toISOString(),
        source: 'intakeq',
        requirements: await this.determineRequirements(appointment),
        notes: `Service: ${appointment.ServiceName}`
      };
    } catch (error) {
      console.error('Error converting appointment:', error);
      throw new Error(`Failed to convert appointment: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
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
  private async determineOfficeAssignment(
  appointment: IntakeQAppointment
): Promise<OfficeAssignmentResult> {
  try {
    console.log(`Determining office assignment for appointment ${appointment.Id}`);
    
    // 1. Get all offices
    const offices = await this.sheetsService.getOffices();
    const activeOffices = offices.filter(o => o.inService);
    
    if (activeOffices.length === 0) {
      console.log('No active offices found, using default B-1');
      return {
        officeId: 'B-1',
        reasons: ['No active offices found, using default']
      };
    }

    // 2. Check appointment type
    const sessionType = this.determineSessionType(appointment);
    if (sessionType === 'telehealth') {
      console.log('Telehealth session, assigning virtual office A-v');
      return {
        officeId: 'A-v',
        reasons: ['Telehealth session']
      };
    }
    
    // 3. Get client preferences
    const preferences = await this.sheetsService.getClientPreferences();
    const clientPreference = preferences.find(
      p => p.clientId === appointment.ClientId.toString()
    );
    
    // 4. Get clinician data
    const clinicians = await this.sheetsService.getClinicians();
    const clinician = clinicians.find(
      c => c.intakeQPractitionerId === appointment.PractitionerId
    );
    
    if (!clinician) {
      console.warn(`No clinician mapping found for IntakeQ practitioner ID: ${appointment.PractitionerId}`);
    }
    
    // 5. Create scored office candidates
    const officeCandidates = activeOffices.map(office => {
      return {
        office,
        score: 0,
        reasons: [] as string[]
      };
    });
    
    // 6. Apply scoring rules to each office
    
    // 6.1 Client has assigned office
    if (clientPreference?.assignedOffice) {
      const preferredOffice = officeCandidates.find(c => 
        standardizeOfficeId(c.office.officeId) === standardizeOfficeId(clientPreference.assignedOffice as string)
      );
      
      if (preferredOffice) {
        preferredOffice.score += 50;
        preferredOffice.reasons.push('Client has assigned office');
        console.log(`Client has assigned office: ${preferredOffice.office.officeId}, adding 50 points`);
      }
    }
    
    // 6.2 Accessibility requirements
    const hasAccessibilityNeeds = clientPreference && 
      Array.isArray(clientPreference.mobilityNeeds) && 
      clientPreference.mobilityNeeds.length > 0;
    
    if (hasAccessibilityNeeds) {
      console.log('Client has accessibility needs');
      
      // Boost accessible offices
      officeCandidates.forEach(candidate => {
        if (candidate.office.isAccessible) {
          candidate.score += 100;
          candidate.reasons.push('Office meets accessibility needs');
          console.log(`Office ${candidate.office.officeId} is accessible, adding 100 points`);
        } else {
          // Penalize non-accessible offices when accessibility is required
          candidate.score -= 200;
          candidate.reasons.push('Office does not meet accessibility needs');
          console.log(`Office ${candidate.office.officeId} is not accessible, deducting 200 points`);
        }
      });
    }
    
    // 6.3 Clinician preferred offices
    if (clinician && clinician.preferredOffices.length > 0) {
      console.log(`Clinician has preferred offices: ${clinician.preferredOffices.join(', ')}`);
      
      officeCandidates.forEach(candidate => {
        if (clinician.preferredOffices.includes(candidate.office.officeId)) {
          candidate.score += 30;
          candidate.reasons.push('Clinician preferred office');
          console.log(`Office ${candidate.office.officeId} is clinician preferred, adding 30 points`);
        }
      });
    }
    
    // 6.4 Primary clinician
    if (clinician) {
      officeCandidates.forEach(candidate => {
        if (candidate.office.primaryClinician === clinician.clinicianId) {
          candidate.score += 40;
          candidate.reasons.push('Clinician is primary for this office');
          console.log(`Office ${candidate.office.officeId} has clinician as primary, adding 40 points`);
        }
      });
    }
    
    // 6.5 Alternative clinicians
    if (clinician) {
      officeCandidates.forEach(candidate => {
        if (Array.isArray(candidate.office.alternativeClinicians) && 
            candidate.office.alternativeClinicians.includes(clinician.clinicianId)) {
          candidate.score += 20;
          candidate.reasons.push('Clinician is alternative for this office');
          console.log(`Office ${candidate.office.officeId} has clinician as alternative, adding 20 points`);
        }
      });
    }
    
    // 6.6 Client special features needed
    if (clientPreference && 
        clientPreference.sensoryPreferences && 
        clientPreference.sensoryPreferences.length > 0) {
      
      console.log(`Client has sensory preferences: ${clientPreference.sensoryPreferences.join(', ')}`);
      
      officeCandidates.forEach(candidate => {
        const matchingFeatures = clientPreference.sensoryPreferences.filter(
          pref => candidate.office.specialFeatures.includes(pref)
        );
        
        if (matchingFeatures.length > 0) {
          const points = 10 * matchingFeatures.length;
          candidate.score += points;
          candidate.reasons.push(`Office has ${matchingFeatures.length} matching special features`);
          console.log(`Office ${candidate.office.officeId} has ${matchingFeatures.length} matching features, adding ${points} points`);
        }
      });
    }
    
    // 7. Sort by score and select best match
    officeCandidates.sort((a, b) => b.score - a.score);
    
    // Log scores for debugging
    console.log('Office scores:');
    officeCandidates.forEach(candidate => {
      console.log(`- ${candidate.office.officeId}: ${candidate.score} points (${candidate.reasons.join(', ')})`);
    });
    
    const bestMatch = officeCandidates[0];
    console.log(`Selected office ${bestMatch.office.officeId} with score ${bestMatch.score}`);
    
    return {
      officeId: standardizeOfficeId(bestMatch.office.officeId),
      reasons: bestMatch.reasons
    };
  } catch (error) {
    console.error('Error determining office assignment:', error);
    
    // Fall back to default office
    return {
      officeId: 'B-1',
      reasons: ['Error in assignment process, using default']
    };
  }
}
}