// src/lib/intakeq/appointment-sync.ts

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

export class AppointmentSyncHandler {
  constructor(
    private readonly sheetsService: IGoogleSheetsService,
    private readonly intakeQService?: any // Optional service for API calls
  ) {}

// Modified processAppointmentEvent for better event tracking
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
    const eventType = payload.Type || payload.EventType || 'Unknown';
    console.log(`Processing ${eventType} event for appointment ${payload.Appointment.Id} for client ${payload.Appointment.ClientName || payload.ClientId}`);
    
    // Log complete payload structure for debugging duplicates
    const cleanPayload = { ...payload };
    if (cleanPayload.Appointment?.ClientEmail) cleanPayload.Appointment.ClientEmail = '[REDACTED]';
    if (cleanPayload.Appointment?.ClientPhone) cleanPayload.Appointment.ClientPhone = '[REDACTED]';
    console.log(`Event payload: ${JSON.stringify(cleanPayload)}`);
    
    // Add timestamp tracking for webhooks
    const processTime = new Date().toISOString();
    
    // Log webhook receipt
    try {
      await this.sheetsService.addAuditLog({
        timestamp: processTime,
        eventType: 'WEBHOOK_RECEIVED',
        description: `Received ${eventType} webhook for appointment ${payload.Appointment.Id}`,
        user: 'INTAKEQ_WEBHOOK',
        systemNotes: JSON.stringify({
          appointmentId: payload.Appointment.Id,
          type: eventType,
          clientId: payload.ClientId,
          processTime: processTime
        })
      });
    } catch (logError) {
      console.warn('Failed to log webhook receipt, continuing:', logError);
    }

    // Handle appointment events based on type
    if (eventType.includes('Created')) {
      // Check if the appointment already exists first to prevent duplicates
      const existingAppointment = await this.checkIfAppointmentExists(payload.Appointment.Id);
      if (existingAppointment) {
        console.log(`Appointment ${payload.Appointment.Id} already exists, handling as update instead of create`);
        return await this.handleAppointmentUpdate(payload.Appointment);
      }
      
      // For truly new appointments
      return await this.handleNewAppointment(payload.Appointment);
    } 
    else if (
      eventType.includes('Updated') || 
      eventType.includes('Rescheduled') || 
      eventType.includes('Confirmed')
    ) {
      // For update, reschedule, and confirm events
      return await this.handleAppointmentUpdate(payload.Appointment);
    }
    else if (eventType.includes('Cancelled') || eventType.includes('Canceled')) {
      // For cancellation events
      return await this.handleAppointmentCancellation(payload.Appointment);
    }
    else if (eventType.includes('Deleted')) {
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
      eventType: 'SYSTEM_ERROR',
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

// New helper method to check if an appointment already exists
private async checkIfAppointmentExists(appointmentId: string): Promise<boolean> {
  try {
    const appointment = await this.sheetsService.getAppointment(appointmentId);
    return !!appointment;
  } catch (error) {
    console.warn(`Error checking if appointment ${appointmentId} exists:`, error);
    return false;
  }
}

  // Modified handleNewAppointment to prevent duplicates
private async handleNewAppointment(
  appointment: IntakeQAppointment
): Promise<WebhookResponse> {
  try {
    console.log(`Processing new appointment: ${appointment.Id}, client: ${appointment.ClientName}`);
    
    // Double check if appointment already exists to prevent duplicates
    try {
      const existingAppointment = await this.sheetsService.getAppointment(appointment.Id);
      if (existingAppointment) {
        console.log(`Appointment ${appointment.Id} already exists, handling as update instead`);
        return await this.handleAppointmentUpdate(appointment);
      }
    } catch (getError) {
      // If there's an error checking, we'll continue with creating a new appointment
      console.warn(`Error checking for existing appointment ${appointment.Id}:`, getError);
    }
    
    // Validate dates early to catch issues
    this.validateAppointmentDates(appointment);
    
    // Convert IntakeQ appointment to our AppointmentRecord format
    const appointmentRecord = await this.convertToAppointmentRecord(appointment);
    
    // Always set office to TBD - DEFERRED ASSIGNMENT
    appointmentRecord.assignedOfficeId = 'TBD';
    appointmentRecord.currentOfficeId = 'TBD';
    appointmentRecord.assignmentReason = 'To be determined during daily schedule generation';
    
    // Save appointment to Google Sheets
    await this.sheetsService.addAppointment(appointmentRecord);
    
    // Log success
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'APPOINTMENT_CREATED',
      description: `Added appointment ${appointment.Id}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        appointmentId: appointment.Id,
        officeId: 'TBD',
        clientId: appointment.ClientId,
        deferredAssignment: true
      })
    });

    return {
      success: true,
      details: {
        appointmentId: appointment.Id,
        officeId: 'TBD',
        action: 'created',
        deferredAssignment: true
      }
    };
  } catch (error) {
    console.error(`Error handling new appointment ${appointment.Id}:`, error);
    throw error;
  }
}

  /**
   * Handle an appointment update
   */
  private async handleAppointmentUpdate(
    appointment: IntakeQAppointment
  ): Promise<WebhookResponse> {
    try {
      console.log('Processing appointment update:', appointment.Id);
      
      // Validate dates early
      this.validateAppointmentDates(appointment);
      
      // Check if appointment exists with retry logic
      let existingAppointment;
      try {
        existingAppointment = await this.retryWithBackoff(() => 
          this.sheetsService.getAppointment(appointment.Id)
        );
      } catch (getError) {
        console.error(`Error fetching existing appointment ${appointment.Id}:`, getError);
        // If we can't get the existing appointment, treat it as a new one
        return this.handleNewAppointment(appointment);
      }
      
      if (!existingAppointment) {
        // If appointment doesn't exist, treat it as a new appointment
        return this.handleNewAppointment(appointment);
      }
      
      // Convert IntakeQ appointment to our AppointmentRecord format
      const appointmentRecord = await this.convertToAppointmentRecord(appointment);
      
      // Handle office assignment appropriately
      
      // Check if time or clinician changed, which would require reassignment
      const timeChanged = 
        appointmentRecord.startTime !== existingAppointment.startTime ||
        appointmentRecord.endTime !== existingAppointment.endTime;
      
      const clinicianChanged = 
        appointmentRecord.clinicianId !== existingAppointment.clinicianId;
      
      const sessionTypeChanged =
        appointmentRecord.sessionType !== existingAppointment.sessionType;
      
      // If key appointment details changed, mark for reassignment
      if (timeChanged || clinicianChanged || sessionTypeChanged) {
        appointmentRecord.assignedOfficeId = 'TBD';
        appointmentRecord.assignmentReason = 'To be reassigned due to appointment changes';
        
        // Keep track of the current office ID (for tracking changes)
        appointmentRecord.currentOfficeId = existingAppointment.currentOfficeId || 
                                           existingAppointment.officeId || 
                                           'TBD';
      } else {
        // No reassignment needed, keep existing assignments
        appointmentRecord.assignedOfficeId = existingAppointment.assignedOfficeId || 
                                            existingAppointment.currentOfficeId || 
                                            existingAppointment.officeId || 
                                            'TBD';
        appointmentRecord.currentOfficeId = existingAppointment.currentOfficeId || 
                                           existingAppointment.officeId || 
                                           'TBD';
        appointmentRecord.assignmentReason = existingAppointment.assignmentReason || '';
      }
      
      // Update appointment in Google Sheets with retry
      await this.retryWithBackoff(() => this.sheetsService.updateAppointment(appointmentRecord));
      
      // Log success with safe error handling
      try {
        await this.retryWithBackoff(() => this.sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'APPOINTMENT_UPDATED' as AuditEventType,
          description: `Updated appointment ${appointment.Id}`,
          user: 'SYSTEM',
          previousValue: JSON.stringify(existingAppointment),
          newValue: JSON.stringify(appointmentRecord)
        }), 2);
      } catch (logError) {
        console.warn('Failed to log appointment update:', logError);
      }

      return {
        success: true,
        details: {
          appointmentId: appointment.Id,
          currentOfficeId: appointmentRecord.currentOfficeId,
          assignedOfficeId: appointmentRecord.assignedOfficeId,
          action: 'updated',
          needsReassignment: timeChanged || clinicianChanged || sessionTypeChanged
        }
      };
    } catch (error) {
      console.error('Error handling appointment update:', error);
      throw error;
    }
  }

  /**
   * Handle appointment cancellation
   */
  private async handleAppointmentCancellation(
    appointment: IntakeQAppointment
  ): Promise<WebhookResponse> {
    try {
      console.log('Processing appointment cancellation:', appointment.Id);
      
      // Check if appointment exists
      let existingAppointment;
      try {
        existingAppointment = await this.retryWithBackoff(() => 
          this.sheetsService.getAppointment(appointment.Id)
        );
      } catch (getError) {
        console.error(`Error fetching appointment ${appointment.Id} for cancellation:`, getError);
        return {
          success: false,
          error: `Error fetching appointment ${appointment.Id} for cancellation`,
          retryable: true
        };
      }
      
      if (!existingAppointment) {
        return {
          success: false,
          error: `Appointment ${appointment.Id} not found for cancellation`,
          retryable: false
        };
      }
      
      try {
        // First try to delete appointment from Google Sheets
        console.log(`Attempting to delete appointment ${appointment.Id} from sheet`);
        await this.retryWithBackoff(() => this.sheetsService.deleteAppointment(appointment.Id));
        console.log(`Successfully deleted appointment ${appointment.Id} from sheet`);
      } catch (deleteError) {
        // If deletion fails, try to update status instead as a fallback
        console.error(`Failed to delete appointment ${appointment.Id}, falling back to status update:`, deleteError);
        
        try {
          // Create a modified copy of the existing appointment
          const cancellationUpdate: AppointmentRecord = {
            ...existingAppointment,
            status: 'cancelled' as 'cancelled', // Type assertion to match the union type
            lastUpdated: new Date().toISOString(),
            notes: (existingAppointment.notes || '') + 
                   `\nCancelled: ${new Date().toISOString()}` + 
                   (appointment.CancellationReason ? `\nReason: ${appointment.CancellationReason}` : '')
          };
          
          // Update the appointment with cancelled status
          await this.retryWithBackoff(() => this.sheetsService.updateAppointment(cancellationUpdate));
          console.log(`Fallback successful: Updated appointment ${appointment.Id} status to cancelled`);
        } catch (updateError) {
          console.error(`Both deletion and status update failed for appointment ${appointment.Id}:`, updateError);
          throw new Error(`Failed to process cancellation: ${updateError instanceof Error ? updateError.message : 'Unknown error'}`);
        }
      }
      
      // Log cancellation (with safe error handling)
      try {
        await this.retryWithBackoff(() => this.sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'APPOINTMENT_CANCELLED' as AuditEventType,
          description: `Cancelled appointment ${appointment.Id}`,
          user: 'SYSTEM',
          systemNotes: JSON.stringify({
            appointmentId: appointment.Id,
            clientId: appointment.ClientId,
            reason: appointment.CancellationReason || 'No reason provided',
            deletionMethod: 'row_removal_with_status_fallback'
          })
        }), 2);
      } catch (logError) {
        console.warn('Failed to log appointment cancellation:', logError);
      }

      return {
        success: true,
        details: {
          appointmentId: appointment.Id,
          action: 'cancelled_and_processed'
        }
      };
    } catch (error) {
      console.error('Error handling appointment cancellation:', error);
      
      // Add detailed error logging (with safe error handling)
      try {
        await this.sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'SYSTEM_ERROR' as AuditEventType,
          description: `Error cancelling appointment ${appointment.Id}`,
          user: 'SYSTEM',
          systemNotes: error instanceof Error ? error.message : 'Unknown error'
        });
      } catch (logError) {
        console.error('Failed to log cancellation error:', logError);
      }
      
      throw error;
    }
  }

  /**
   * Handle appointment deletion
   */
  private async handleAppointmentDeletion(
    appointment: IntakeQAppointment
  ): Promise<WebhookResponse> {
    try {
      console.log('Processing appointment deletion:', appointment.Id);
      
      // Check if appointment exists
      let existingAppointment;
      try {
        existingAppointment = await this.retryWithBackoff(() => 
          this.sheetsService.getAppointment(appointment.Id)
        );
      } catch (getError) {
        console.error(`Error fetching appointment ${appointment.Id} for deletion:`, getError);
        return {
          success: false,
          error: `Error fetching appointment ${appointment.Id} for deletion`,
          retryable: true
        };
      }
      
      if (!existingAppointment) {
        return {
          success: false,
          error: `Appointment ${appointment.Id} not found for deletion`,
          retryable: false
        };
      }
      
      // Delete appointment from Google Sheets with retry
      await this.retryWithBackoff(() => this.sheetsService.deleteAppointment(appointment.Id));
      
      // Log deletion (with safe error handling)
      try {
        await this.retryWithBackoff(() => this.sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'APPOINTMENT_DELETED' as AuditEventType,
          description: `Deleted appointment ${appointment.Id}`,
          user: 'SYSTEM',
          systemNotes: JSON.stringify({
            appointmentId: appointment.Id,
            clientId: appointment.ClientId,
            deletionMethod: 'row_removal'
          })
        }), 2);
      } catch (logError) {
        console.warn('Failed to log appointment deletion:', logError);
      }
  
      return {
        success: true,
        details: {
          appointmentId: appointment.Id,
          action: 'deleted'
        }
      };
    } catch (error) {
      console.error('Error handling appointment deletion:', error);
      
      // Add detailed error logging (with safe error handling)
      try {
        await this.sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'SYSTEM_ERROR' as AuditEventType,
          description: `Error deleting appointment ${appointment.Id}`,
          user: 'SYSTEM',
          systemNotes: error instanceof Error ? error.message : 'Unknown error'
        });
      } catch (logError) {
        console.error('Failed to log deletion error:', logError);
      }
      
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
      
      // Get clinician information with safe error handling
      let clinician = null;
      try {
        const clinicians = await this.retryWithBackoff(() => this.sheetsService.getClinicians());
        clinician = clinicians.find(c => c.intakeQPractitionerId === appointment.PractitionerId);
      } catch (error) {
        console.warn(`Error getting clinician data for practitioner ID ${appointment.PractitionerId}:`, error);
        // Continue with null clinician - we'll use practitionerId and name directly
      }
      
      // Determine session type
      const sessionType = this.determineSessionType(appointment);
      
      // Get requirements - with safe error handling
      let requirements = { accessibility: false, specialFeatures: [] as string[] };  // Fixed: Specify empty array type
      try {
        const determinedRequirements = await this.determineRequirements(appointment);
        if (determinedRequirements) {
          // Make sure we have the required properties with correct types
          requirements = {
            accessibility: determinedRequirements.accessibility === true, // Fixed: Ensure boolean
            specialFeatures: Array.isArray(determinedRequirements.specialFeatures) 
              ? determinedRequirements.specialFeatures 
              : []
          };
        }
      } catch (error) {
        console.warn('Error determining client requirements, using defaults:', error);
      }
      
      // Standardize date formats with better error handling
      let standardizedStartTime = '';
      let standardizedEndTime = '';
      let standardizedDOB = '';
      
      try {
        standardizedStartTime = this.standardizeDateFormat(appointment.StartDateIso);
        standardizedEndTime = this.standardizeDateFormat(appointment.EndDateIso);
        standardizedDOB = appointment.ClientDateOfBirth ? 
                        this.standardizeDateFormat(appointment.ClientDateOfBirth) : '';
      } catch (dateError) {
        console.error('Error standardizing dates, using original values:', dateError);
        standardizedStartTime = appointment.StartDateIso;
        standardizedEndTime = appointment.EndDateIso;
        standardizedDOB = appointment.ClientDateOfBirth || '';
      }
      
      // Convert the appointment to our format
      const appointmentRecord: AppointmentRecord = normalizeAppointmentRecord({
        appointmentId: appointment.Id,
        clientId: appointment.ClientId.toString(),
        clientName: safeClientName,
        clientDateOfBirth: standardizedDOB,
        clinicianId: clinician?.clinicianId || appointment.PractitionerId,
        clinicianName: clinician?.name || safePractitionerName,
        sessionType: sessionType,
        startTime: standardizedStartTime,
        endTime: standardizedEndTime,
        status: this.mapIntakeQStatus(appointment.Status || ''),
        lastUpdated: new Date().toISOString(),
        source: 'intakeq',
        requirements: requirements,
        notes: `Service: ${safeServiceName}`
      });
      
      return appointmentRecord;
    } catch (error) {
      console.error('Error converting appointment:', error);
      // Fixed: Type narrowing for error
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to convert appointment: ${errorMessage}`);
    }
  }

  /**
   * Extract assigned office from notes and/or requiredOffice field
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
   * Helper method to sanitize text
   */
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
  ): Promise<{ accessibility: boolean; specialFeatures: string[] }> {
    // Try to get client accessibility info first (new schema)
    try {
      const accessibilityInfo = await this.retryWithBackoff(() => 
        this.sheetsService.getClientAccessibilityInfo(appointment.ClientId.toString())
      );
      
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
          accessibility: accessibilityInfo.hasMobilityNeeds === true,  // Fixed: Ensure boolean
          specialFeatures: specialFeatures.filter(f => f.trim() !== '')
        };
      }
    } catch (error) {
      console.warn('Error getting client accessibility info, falling back to preferences:', error);
    }
    
    // Fall back to client preferences (old schema)
    try {
      const preferences = await this.retryWithBackoff(() => this.sheetsService.getClientPreferences());
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
      const accessibilityInfo = await this.retryWithBackoff(() => 
        this.sheetsService.getClientAccessibilityInfo(appointment.ClientId.toString())
      );
      
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
      const preferences = await this.retryWithBackoff(() => this.sheetsService.getClientPreferences());
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
    const serviceName = (appointment.ServiceName || '').toLowerCase();
    
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

  private validateAppointmentDates(appointment: IntakeQAppointment): void {
    console.log(`Validating dates for appointment ${appointment.Id}, StartDateIso: ${appointment.StartDateIso}, EndDateIso: ${appointment.EndDateIso}`);
    
    // Some IntakeQ webhooks might provide StartDate/EndDate (Unix timestamp) instead of StartDateIso/EndDateIso
    // Handle this case by checking and converting if needed
    if (!appointment.StartDateIso && appointment.StartDate) {
      console.log(`Converting StartDate timestamp ${appointment.StartDate} to ISO string`);
      try {
        appointment.StartDateIso = new Date(Number(appointment.StartDate)).toISOString();
      } catch (error) {
        console.error(`Failed to convert StartDate timestamp ${appointment.StartDate} to ISO string:`, error);
      }
    }
    
    if (!appointment.EndDateIso && appointment.EndDate) {
      console.log(`Converting EndDate timestamp ${appointment.EndDate} to ISO string`);
      try {
        appointment.EndDateIso = new Date(Number(appointment.EndDate)).toISOString();
      } catch (error) {
        console.error(`Failed to convert EndDate timestamp ${appointment.EndDate} to ISO string:`, error);
      }
    }
  
    // Now validate StartDateIso
    if (!appointment.StartDateIso || typeof appointment.StartDateIso !== 'string') {
      console.error(`Invalid StartDateIso for appointment ${appointment.Id}: "${appointment.StartDateIso}"`);
      throw new Error(`Invalid StartDateIso format for appointment ${appointment.Id}`);
    }
    
    // Now validate EndDateIso
    if (!appointment.EndDateIso || typeof appointment.EndDateIso !== 'string') {
      console.error(`Invalid EndDateIso for appointment ${appointment.Id}: "${appointment.EndDateIso}"`);
      
      // Use appointment Duration if available
      if (appointment.Duration && !isNaN(Number(appointment.Duration))) {
        try {
          // Parse StartDateIso carefully
          const startDate = new Date(appointment.StartDateIso);
          if (!isNaN(startDate.getTime())) {
            const durationMinutes = Number(appointment.Duration);
            const endDate = new Date(startDate.getTime() + (durationMinutes * 60000));
            appointment.EndDateIso = endDate.toISOString();
            console.log(`Generated EndDateIso for appointment ${appointment.Id} using Duration ${durationMinutes} minutes: ${appointment.EndDateIso}`);
          } else {
            throw new Error(`Cannot calculate EndDateIso: invalid StartDateIso for appointment ${appointment.Id}`);
          }
        } catch (error) {
          console.error(`Failed to generate EndDateIso for appointment ${appointment.Id}:`, error);
          throw new Error(`Failed to generate EndDateIso: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        throw new Error(`Missing EndDateIso and no Duration available for appointment ${appointment.Id}`);
      }
    }
    
    // Final validation - parse and check dates
    try {
      const startDate = new Date(appointment.StartDateIso);
      const endDate = new Date(appointment.EndDateIso);
      
      if (isNaN(startDate.getTime())) {
        throw new Error(`Invalid StartDateIso value: ${appointment.StartDateIso}`);
      }
      
      if (isNaN(endDate.getTime())) {
        throw new Error(`Invalid EndDateIso value: ${appointment.EndDateIso}`);
      }
      
      if (endDate <= startDate) {
        console.error(`EndDateIso (${appointment.EndDateIso}) must be after StartDateIso (${appointment.StartDateIso}) for appointment ${appointment.Id}`);
        
        // Fix end date by adding default duration (50 minutes if not specified)
        const durationMinutes = appointment.Duration ? Number(appointment.Duration) : 50;
        const fixedEndDate = new Date(startDate.getTime() + (durationMinutes * 60000));
        appointment.EndDateIso = fixedEndDate.toISOString();
        console.log(`Fixed EndDateIso for appointment ${appointment.Id}: ${appointment.EndDateIso}`);
      }
    } catch (error) {
      console.error(`Date validation failed for appointment ${appointment.Id}:`, error);
      throw new Error(`Date parsing failed for appointment ${appointment.Id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  

  private standardizeDateFormat(dateStr: string | number): string {
    if (!dateStr) return '';
    
    try {
      // Handle Unix timestamp (number or numeric string)
      let dateObj: Date;
      if (typeof dateStr === 'number' || !isNaN(Number(dateStr))) {
        const timestamp = Number(dateStr);
        if (timestamp > 0) {
          dateObj = new Date(timestamp);
        } else {
          throw new Error(`Invalid timestamp: ${dateStr}`);
        }
      } else {
        // Handle date string
        dateObj = new Date(dateStr);
      }
      
      // Validate we got a valid date
      if (isNaN(dateObj.getTime())) {
        console.warn(`Invalid date format: "${dateStr}", returning as-is`);
        return String(dateStr); // Return original if parsing fails
      }
      
      // Format as YYYY-MM-DD
      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getDate()).padStart(2, '0');
      
      // If the original string contains time information, add formatted time
      if (
        (typeof dateStr === 'string' && (dateStr.includes('T') || dateStr.includes(':'))) ||
        typeof dateStr === 'number'
      ) {
        const hours = String(dateObj.getHours()).padStart(2, '0');
        const minutes = String(dateObj.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}`;
      }
      
      return `${year}-${month}-${day}`;
    } catch (error) {
      console.error(`Error standardizing date format for "${dateStr}":`, error);
      return String(dateStr); // Return original on error
    }
  }

  /**
   * Retry an operation with exponential backoff when quota errors occur
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>, 
    maxRetries: number = 5
  ): Promise<T> {
    let retries = 0;
    
    while (true) {
      try {
        return await operation();
      } catch (error: any) { // Fixed: Type annotation for error
        retries++;
        
        // Check if we've reached max retries
        if (retries >= maxRetries) {
          throw error;
        }
        
        // Check if it's a quota error
        const isQuotaError = error.message && 
          (error.message.includes('Quota exceeded') || 
           error.message.includes('rate limit') ||
           error.status === 429);
        
        if (!isQuotaError) {
          throw error; // Don't retry other types of errors
        }
        
        // Calculate delay with exponential backoff (100ms, 200ms, 400ms, 800ms, ...)
        const delay = Math.min(100 * Math.pow(2, retries - 1), 10000);
        console.log(`API quota exceeded, retrying in ${delay}ms (attempt ${retries}/${maxRetries})`);
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}