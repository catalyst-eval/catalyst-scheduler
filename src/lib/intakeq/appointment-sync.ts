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
  score?: number;
  reasons?: string[];
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
      // Get all offices
      const offices = await this.sheetsService.getOffices();
      
      // Get client preferences
      const preferences = await this.sheetsService.getClientPreferences();
      const clientPreference = preferences.find(
        p => p.clientId === appointment.ClientId.toString()
      );
      
      // Check if client has a preferred or previously assigned office
      if (clientPreference?.assignedOffice) {
        const office = offices.find(
          o => standardizeOfficeId(o.officeId) === standardizeOfficeId(clientPreference.assignedOffice as string)
        );
        
        if (office && office.inService) {
          return {
            officeId: standardizeOfficeId(clientPreference.assignedOffice as string),
            reasons: ['Client has preferred office']
          };
        }
      }
      
      // Find all active offices
      const activeOffices = offices.filter(o => o.inService);
      
      if (activeOffices.length === 0) {
        return {
          officeId: 'B-1',
          reasons: ['No active offices found, using default']
        };
      }
      
      // Get clinicians to find office preferences
      const clinicians = await this.sheetsService.getClinicians();
      const clinician = clinicians.find(
        c => c.intakeQPractitionerId === appointment.PractitionerId
      );
      
      // If clinician has preferred offices, use the first available one
      if (clinician && clinician.preferredOffices.length > 0) {
        for (const preferredId of clinician.preferredOffices) {
          const office = activeOffices.find(
            o => standardizeOfficeId(o.officeId) === standardizeOfficeId(preferredId)
          );
          
          if (office) {
            return {
              officeId: standardizeOfficeId(office.officeId),
              reasons: ['Clinician preferred office']
            };
          }
        }
      }
      
      // Check if client has accessibility needs
      const hasAccessibilityNeeds = 
        clientPreference && 
        Array.isArray(clientPreference.mobilityNeeds) && 
        clientPreference.mobilityNeeds.length > 0;
      
      if (hasAccessibilityNeeds) {
        const accessibleOffices = activeOffices.filter(o => o.isAccessible);
        
        if (accessibleOffices.length > 0) {
          return {
            officeId: standardizeOfficeId(accessibleOffices[0].officeId),
            reasons: ['Accessible office for client with mobility needs']
          };
        }
      }
      
      // For telehealth, assign a virtual office
      if (this.determineSessionType(appointment) === 'telehealth') {
        return {
          officeId: 'A-v',
          reasons: ['Telehealth session']
        };
      }
      
      // Default: assign first available office
      return {
        officeId: standardizeOfficeId(activeOffices[0].officeId),
        reasons: ['Default assignment']
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

export default AppointmentSyncHandler;