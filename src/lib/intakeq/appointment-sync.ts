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

// Enhanced processAppointmentEvent method with better error handling
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
    // Log webhook receipt with more details
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'WEBHOOK_RECEIVED', // Use string directly instead of AuditEventType
      description: `Received ${payload.Type || payload.EventType} webhook`,
      user: 'INTAKEQ_WEBHOOK',
      systemNotes: JSON.stringify({
        appointmentId: payload.Appointment.Id,
        type: payload.Type || payload.EventType,
        clientId: payload.ClientId,
        hasStartDate: !!payload.Appointment.StartDateIso,
        hasEndDate: !!payload.Appointment.EndDateIso
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
    
    // Enhanced error logging
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'SYSTEM_ERROR', // Use string directly
      description: `Error processing appointment ${payload.Appointment.Id}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
        appointmentData: {
          id: payload.Appointment.Id,
          clientId: payload.Appointment.ClientId,
          startDate: payload.Appointment.StartDateIso,
          endDate: payload.Appointment.EndDateIso,
          status: payload.Appointment.Status
        }
      })
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      retryable: true
    };
  }
}

/**
 * Fetch client tags from IntakeQ API
 * NEW method to get tags when they're not in the webhook
 */
private async fetchClientTagsFromIntakeQ(clientId: string | number): Promise<string[]> {
  try {
    console.log(`Attempting to fetch tags for client ${clientId} from IntakeQ API`);
    
    // Check if API calls are disabled
    if (process.env.DISABLE_API_CALLS === 'true') {
      console.log(`API DISABLED: Cannot fetch client tags for client ${clientId}`);
      return [];
    }
    
    // Ensure we have the IntakeQ service
    if (!this.intakeQService) {
      console.log(`IntakeQ service not available, cannot fetch client tags`);
      return [];
    }
    
    // Use the existing IntakeQ service to get client data
    const clientData = await this.intakeQService.getClient(clientId);
    
    // Check if client data contains tags
    if (clientData && clientData.Tags) {
      console.log(`Found tags for client ${clientId}:`, clientData.Tags);
      
      // Handle tags array or string
      if (Array.isArray(clientData.Tags)) {
        return clientData.Tags.map((tag: any) => String(tag).trim()).filter((tag: string) => tag.length > 0);
      } else if (typeof clientData.Tags === 'string') {
        return clientData.Tags.split(',').map((tag: string) => tag.trim()).filter((tag: string) => tag.length > 0);
      }
    }
    
    console.log(`No tags found for client ${clientId}`);
    return [];
  } catch (error) {
    console.error(`Error fetching client tags from IntakeQ for client ${clientId}:`, error);
    return [];
  }
}

// Add method to extract office IDs from tags - new functionality mentioned in transition doc
private extractOfficeIdFromTags(tags: string[]): string | null {
  if (!tags || !Array.isArray(tags) || tags.length === 0) {
    return null;
  }
  
  // Look for tags that match office ID patterns
  const officeTags = tags.filter(tag => {
    // Normalize the tag for comparison
    const normalizedTag = tag.toLowerCase().trim().replace(/\s+/g, '');
    
    // Check for standard office ID patterns
    // B-4, B4, b4, b-4, etc.
    return /^[a-c][-]?\d+$/.test(normalizedTag) || 
           // Special case for virtual office
           normalizedTag === 'a-v' || 
           normalizedTag === 'av';
  });
  
  if (officeTags.length > 0) {
    // Use the first matching tag (highest priority)
    const officeTag = officeTags[0].toLowerCase().trim();
    
    // Standardize the office ID format
    let officeId = officeTag;
    
    // Check if we need to add a hyphen
    if (officeTag.length === 2 && !officeTag.includes('-')) {
      // Format like 'b4' to 'B-4'
      officeId = `${officeTag[0].toUpperCase()}-${officeTag[1]}`;
    } else {
      // Format like 'b-4' to 'B-4'
      officeId = officeTag.toUpperCase();
    }
    
    console.log(`Extracted office ID ${officeId} from tags: ${JSON.stringify(officeTags)}`);
    return officeId;
  }
  
  // Check for mobility tag which requires accessible office
  const hasMobilityTag = tags.some(tag => 
    tag.toLowerCase().trim() === 'mobility' || 
    tag.toLowerCase().trim() === 'accessible'
  );
  
  if (hasMobilityTag) {
    console.log(`Found mobility tag in tags: ${JSON.stringify(tags)}`);
    // Return null, but the mobility tag will be processed elsewhere
    // to assign an accessible office
  }
  
  return null;
}

// Update handleNewAppointment to support tag-based office assignment
private async handleNewAppointment(
  appointment: IntakeQAppointment
): Promise<WebhookResponse> {
  try {
    console.log('Processing new appointment:', appointment.Id);
    console.log('Appointment data:', JSON.stringify({
      id: appointment.Id,
      clientId: appointment.ClientId,
      clientName: appointment.ClientName,
      tags: appointment.Tags || 'none'
    }));
    
    // 1. Convert IntakeQ appointment to our AppointmentRecord format
    const appointmentRecord = await this.convertToAppointmentRecord(appointment);
    
    // 2. If no tags were found in the webhook, try to fetch them from the API
    if ((!appointmentRecord.tags || appointmentRecord.tags.length === 0) && 
        process.env.ENABLE_CLIENT_TAG_FETCH === 'true') {
      try {
        const clientTags = await this.fetchClientTagsFromIntakeQ(appointment.ClientId);
        if (clientTags && clientTags.length > 0) {
          console.log(`Successfully fetched tags for client ${appointment.ClientId}:`, clientTags);
          appointmentRecord.tags = clientTags;
        }
      } catch (tagError) {
        console.error('Error fetching client tags, continuing without tags:', tagError);
      }
    }
    
    // 3. Check for office assignment in tags (new functionality)
    let officeId = 'TBD';
    let assignmentReason = 'To be determined during daily schedule generation';
    
    if (appointmentRecord.tags && appointmentRecord.tags.length > 0) {
      const tagOfficeId = this.extractOfficeIdFromTags(appointmentRecord.tags);
      if (tagOfficeId) {
        officeId = tagOfficeId;
        assignmentReason = `Assigned based on client tag: ${tagOfficeId} (Priority 100)`;
        console.log(`Appointment ${appointment.Id} assigned to ${tagOfficeId} based on tag`);
      } else if (appointmentRecord.tags.some(tag => 
                 tag.toLowerCase().trim() === 'mobility' || 
                 tag.toLowerCase().trim() === 'accessible')) {
        // Set to TBD but add indication of accessibility needs
        assignmentReason = 'To be determined during daily schedule generation (has mobility tag)';
        console.log(`Appointment ${appointment.Id} has mobility tag, will prioritize accessible office`);
      }
    }
    
    // 4. Set office assignment
    appointmentRecord.assignedOfficeId = officeId;
    appointmentRecord.currentOfficeId = officeId;
    appointmentRecord.assignmentReason = assignmentReason;
    
    // Tags before saving - for debugging
    console.log(`Tags before saving: ${JSON.stringify(appointmentRecord.tags)}`);
    
    // 5. Save appointment to Google Sheets
    await this.sheetsService.addAppointment(appointmentRecord);
    
    // 6. Log success
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'APPOINTMENT_CREATED' as AuditEventType,
      description: `Added appointment ${appointment.Id}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        appointmentId: appointment.Id,
        officeId: officeId,
        clientId: appointment.ClientId,
        deferredAssignment: officeId === 'TBD',
        tags: appointmentRecord.tags,
        tagBasedAssignment: officeId !== 'TBD'
      })
    });

    return {
      success: true,
      details: {
        appointmentId: appointment.Id,
        officeId: officeId,
        action: 'created',
        deferredAssignment: officeId === 'TBD',
        tags: appointmentRecord.tags
      }
    };
  } catch (error) {
    console.error('Error handling new appointment:', error);
    throw error;
  }
}

/**
 * Handle appointment update - UPDATED to only trigger reassignment when details change
 */
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
    
    // 3. Handle office assignment appropriately
    
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
        needsReassignment: timeChanged || clinicianChanged || sessionTypeChanged
      }
    };
  } catch (error) {
    console.error('Error handling appointment update:', error);
    throw error;
  }
}

/**
 * Handle appointment cancellation - Enhanced with fallback mechanism
 */
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
    
    try {
      // 2. First try to delete appointment from Google Sheets
      console.log(`Attempting to delete appointment ${appointment.Id} from sheet`);
      await this.sheetsService.deleteAppointment(appointment.Id);
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
        await this.sheetsService.updateAppointment(cancellationUpdate);
        console.log(`Fallback successful: Updated appointment ${appointment.Id} status to cancelled`);
      } catch (updateError) {
        console.error(`Both deletion and status update failed for appointment ${appointment.Id}:`, updateError);
        throw new Error(`Failed to process cancellation: ${updateError instanceof Error ? updateError.message : 'Unknown error'}`);
      }
    }
    
    // 3. Log cancellation
    await this.sheetsService.addAuditLog({
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
    });

    return {
      success: true,
      details: {
        appointmentId: appointment.Id,
        action: 'cancelled_and_processed'
      }
    };
  } catch (error) {
    console.error('Error handling appointment cancellation:', error);
    
    // Add detailed error logging
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'SYSTEM_ERROR' as AuditEventType,
      description: `Error cancelling appointment ${appointment.Id}`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    throw error;
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
          clientId: appointment.ClientId,
          deletionMethod: 'row_removal'
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
      
      // Add detailed error logging
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'SYSTEM_ERROR' as AuditEventType,
        description: `Error deleting appointment ${appointment.Id}`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
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

  // Enhanced convertToAppointmentRecord method with improved tag handling
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
    
    // Determine session type
    const sessionType = this.determineSessionType(appointment);
    
    // Get requirements - ensure it's a proper object with defined fields
    const requirements = await this.determineRequirements(appointment) || 
                          { accessibility: false, specialFeatures: [] };
    
    // Validate and correct appointment dates if needed
    try {
      this.validateAppointmentDates(appointment);
    } catch (dateError) {
      console.error('Date validation failed, using fallback dates:', dateError);
      
      // Create fallback dates if validation completely fails
      const now = new Date();
      appointment.StartDateIso = now.toISOString();
      appointment.EndDateIso = new Date(now.getTime() + 3600000).toISOString(); // 1 hour later
    }
    
    // Process tags from IntakeQ with improved handling
    console.log(`Processing tags for appointment ${appointment.Id}`);
    console.log(`Raw Tags field: ${JSON.stringify(appointment.Tags)}`);

    // Process tags, handling different possible formats with better error handling
    let tags: string[] = [];
    try {
      if (appointment.Tags) {
        if (typeof appointment.Tags === 'string') {
          // If Tags is a string, split by commas
          tags = appointment.Tags.split(',')
            .map((tag: string) => tag.trim())
            .filter((tag: string) => tag.length > 0);
        } else if (Array.isArray(appointment.Tags)) {
          // If Tags is already an array, map each element to string
          tags = appointment.Tags
            .map((tag: any) => String(tag).trim())
            .filter((tag: string) => tag.length > 0);
        } else if (typeof appointment.Tags === 'object') {
          // Handle case where Tags might be an object (seen in some webhooks)
          console.warn(`Tags is an object instead of string/array for appointment ${appointment.Id}:`, appointment.Tags);
          // Attempt to extract values from object if possible
          tags = Object.values(appointment.Tags)
            .map((tag: any) => String(tag).trim())
            .filter((tag: string) => tag.length > 0);
        }
      }
    } catch (tagError) {
      console.error(`Error processing tags for appointment ${appointment.Id}:`, tagError);
      // Don't let tag processing failure break the entire conversion
      tags = [];
    }
    
    console.log(`Processed tags: ${JSON.stringify(tags)}`);
    
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
      notes: `Service: ${safeServiceName}`,
      tags: tags
    });
    
    console.log(`Converted appointment record with tags: ${JSON.stringify(appointmentRecord.tags)}`);
    
    return appointmentRecord;
  } catch (error: unknown) {
    console.error('Error converting appointment:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to convert appointment: ${errorMessage}`);
  }
}

/**
 * Process tags from IntakeQ
 * Updated with proper type annotations to fix TypeScript errors
 */
private processTags(tagString?: string | string[]): string[] {
  if (!tagString) {
    return [];
  }
  
  if (typeof tagString === 'string') {
    // Split by commas and trim each tag
    return tagString.split(',')
      .map((tag: string) => tag.trim())
      .filter((tag: string) => tag.length > 0);
  } else if (Array.isArray(tagString)) {
    // If it's already an array, just make sure all elements are strings
    return tagString
      .map((tag: any) => String(tag).trim())
      .filter((tag: string) => tag.length > 0);
  }
  
  // Default return for any other case
  return [];
}

// Improved standardizeDateFormat method with better error handling
private standardizeDateFormat(dateStr: string): string {
  if (!dateStr) return '';
  
  try {
    // First check if the date string is already in ISO format
    if (dateStr.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)) {
      // Parse ISO date to our standard format
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        console.warn(`Invalid ISO date format: "${dateStr}", returning as-is`);
        return dateStr;
      }
      
      // Format as YYYY-MM-DD HH:MM
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      
      return `${year}-${month}-${day} ${hours}:${minutes}`;
    }
    
    // Handle MM/DD/YYYY format (common in US systems)
    const usDateMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(\s+(\d{1,2}):(\d{2}))?/);
    if (usDateMatch) {
      const month = String(parseInt(usDateMatch[1])).padStart(2, '0');
      const day = String(parseInt(usDateMatch[2])).padStart(2, '0');
      const year = usDateMatch[3];
      
      // Check if time component exists
      if (usDateMatch[4]) {
        const hours = String(parseInt(usDateMatch[5])).padStart(2, '0');
        const minutes = String(parseInt(usDateMatch[6])).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}`;
      } else {
        return `${year}-${month}-${day}`;
      }
    }
    
    // Handle DD/MM/YYYY format (common in Europe)
    const euDateMatch = dateStr.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})(\s+(\d{1,2}):(\d{2}))?/);
    if (euDateMatch) {
      const day = String(parseInt(euDateMatch[1])).padStart(2, '0');
      const month = String(parseInt(euDateMatch[2])).padStart(2, '0');
      const year = euDateMatch[3];
      
      // Check if time component exists
      if (euDateMatch[4]) {
        const hours = String(parseInt(euDateMatch[5])).padStart(2, '0');
        const minutes = String(parseInt(euDateMatch[6])).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}`;
      } else {
        return `${year}-${month}-${day}`;
      }
    }
    
    // Last resort: treat as general date string and convert
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      console.warn(`Unable to parse date: "${dateStr}", returning as-is`);
      return dateStr;
    }
    
    // Format as YYYY-MM-DD
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    // If the original string contains time information, add formatted time
    if (dateStr.includes(':')) {
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}`;
    }
    
    return `${year}-${month}-${day}`;
  } catch (error) {
    console.error(`Error standardizing date format for "${dateStr}":`, error);
    return dateStr; // Return original on error
  }
}


// Enhanced validateAppointmentDates method with robust fallback mechanism
private validateAppointmentDates(appointment: IntakeQAppointment): void {
  // Check if StartDateIso exists and is valid
  if (!appointment.StartDateIso || typeof appointment.StartDateIso !== 'string') {
    console.warn(`Appointment ${appointment.Id} missing or invalid StartDateIso, using current date`);
    appointment.StartDateIso = new Date().toISOString();
  } else {
    try {
      // Verify the date can be parsed correctly
      const startDate = new Date(appointment.StartDateIso);
      if (isNaN(startDate.getTime())) {
        console.warn(`Appointment ${appointment.Id} has invalid StartDateIso format, using current date`);
        appointment.StartDateIso = new Date().toISOString();
      }
    } catch (error) {
      console.warn(`Error parsing StartDateIso for appointment ${appointment.Id}, using current date:`, error);
      appointment.StartDateIso = new Date().toISOString();
    }
  }
  
  // Check if EndDateIso exists and is valid
  if (!appointment.EndDateIso || typeof appointment.EndDateIso !== 'string') {
    console.warn(`Appointment ${appointment.Id} missing or invalid EndDateIso, calculating from start time`);
    // Default to 50 minute appointments if duration not specified
    const durationMinutes = appointment.Duration || 50;
    const startDate = new Date(appointment.StartDateIso);
    const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
    appointment.EndDateIso = endDate.toISOString();
  } else {
    try {
      // Verify the date can be parsed correctly
      const endDate = new Date(appointment.EndDateIso);
      if (isNaN(endDate.getTime())) {
        console.warn(`Appointment ${appointment.Id} has invalid EndDateIso format, calculating from start time`);
        const durationMinutes = appointment.Duration || 50;
        const startDate = new Date(appointment.StartDateIso);
        const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
        appointment.EndDateIso = endDate.toISOString();
      }
    } catch (error) {
      console.warn(`Error parsing EndDateIso for appointment ${appointment.Id}, calculating from start time:`, error);
      const durationMinutes = appointment.Duration || 50;
      const startDate = new Date(appointment.StartDateIso);
      const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
      appointment.EndDateIso = endDate.toISOString();
    }
  }
  
  // Ensure both dates are valid and EndDateIso is after StartDateIso
  try {
    const startDate = new Date(appointment.StartDateIso);
    const endDate = new Date(appointment.EndDateIso);
    
    if (endDate <= startDate) {
      console.warn(`EndDateIso (${appointment.EndDateIso}) is not after StartDateIso (${appointment.StartDateIso}) for appointment ${appointment.Id}, adjusting end time`);
      // Add default duration if end time is not after start time
      const durationMinutes = appointment.Duration || 50;
      const correctedEndDate = new Date(startDate.getTime() + durationMinutes * 60000);
      appointment.EndDateIso = correctedEndDate.toISOString();
    }
    
    // Log the final times for debugging
    console.log(`Validated appointment dates - ID: ${appointment.Id}, Start: ${appointment.StartDateIso}, End: ${appointment.EndDateIso}`);
  } catch (error) {
    console.error(`Failed to validate appointment dates after corrections for ${appointment.Id}:`, error);
    throw new Error(`Failed to validate appointment dates for ${appointment.Id} even after applying corrections`);
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
      // Check if API calls are disabled
      if (process.env.DISABLE_API_CALLS === 'true') {
        console.log(`API DISABLED: Using simplified office assignment for appointment ${appointment.Id}`);
        // Return a simplified assignment based on session type
        if (this.determineSessionType(appointment) === 'telehealth') {
          return {
            officeId: 'A-v',
            reasons: ['API DISABLED: Default virtual office for telehealth']
          };
        } else {
          return {
            officeId: 'TBD',
            reasons: ['API DISABLED: Office to be determined during scheduling']
          };
        }
      }
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
      
      // Enhanced age determination logic - use the ClientDateOfBirth directly from the appointment
      let clientAge = null;
      try {
        if (appointment.ClientDateOfBirth) {
          const birthDate = new Date(appointment.ClientDateOfBirth);
          const today = new Date();
          clientAge = today.getFullYear() - birthDate.getFullYear();
          
          // Adjust for birth date not yet occurred this year
          const monthDiff = today.getMonth() - birthDate.getMonth();
          if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
            clientAge--;
          }
          
          console.log(`Client age determined from birth date (${appointment.ClientDateOfBirth}): ${clientAge} years old`);
        } else {
          console.log('No client birth date available, age-based rules will be skipped');
        }
      } catch (error) {
        console.error('Error calculating client age:', error);
        console.log('Age-based rules will be skipped due to calculation error');
      }
      
      // RULE PRIORITY 100: Client Specific Requirement
      // From Client_Accessibility_Info tab accessibilityNotes field or requiredOffice
      console.log("Checking PRIORITY 100: Client Specific Requirement");
      try {
        // Get from accessibility info
        const clientAccessibilityInfo = await this.sheetsService.getClientAccessibilityInfo(appointment.ClientId.toString());
        
        if (clientAccessibilityInfo) {
          // Check both requiredOffice field and notes
          const assignedOffice = this.extractAssignedOfficeFromNotes(
            clientAccessibilityInfo.additionalNotes || '',
            clientAccessibilityInfo.requiredOffice  // New field
          );
          
          if (assignedOffice) {
            console.log(`Client ${appointment.ClientName} has assigned office: ${assignedOffice}`);
            return {
              officeId: standardizeOfficeId(assignedOffice),
              reasons: [`Client has specific office requirement (Priority ${RulePriority.CLIENT_SPECIFIC_REQUIREMENT})`]
            };
          }
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
          
          // Updated: Prioritize B-4, B-5 as accessible offices
          const prioritizedOffices = ['B-4', 'B-5'];
          
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
        console.log(`Checking young children rule with client age: ${clientAge}`);
        
        console.log(`Client age determined as: ${clientAge}`);
        
        if (clientAge !== null && clientAge <= 10) {
          console.log(`Client is 10 or under, checking B-5 availability first`);
          
          // First try B-5 (primary for young children)
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
          
          // If B-5 not available, check if C-1 can be used as fallback
          console.log(`B-5 not available, checking if C-1 can be used as fallback for young child`);
          const c1Office = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'C-1');
          
          if (c1Office) {
            // Check if C-1 is available
            const isAvailable = await this.isOfficeAvailable('C-1', appointmentRecord, appointments);
            
            if (isAvailable) {
              // In a real implementation, we would check if C-1 has older children scheduled
              // For simplicity, we'll just check if it's available
              return {
                officeId: 'C-1',
                reasons: [`Young child (${clientAge} years old) assigned to C-1 as fallback (Priority ${RulePriority.YOUNG_CHILDREN})`]
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
        console.log(`Checking young children rule with client age: ${clientAge}`);
        
        if (clientAge !== null && clientAge >= 11 && clientAge <= 17) {
          console.log(`Client is 11-17, checking C-1 availability first`);
          
          // First try C-1 (primary for older children/teens)
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
          
          // If C-1 not available, check if B-5 can be used as fallback
          console.log(`C-1 not available, checking if B-5 can be used as fallback for older child/teen`);
          const b5Office = activeOffices.find(o => standardizeOfficeId(o.officeId) === 'B-5');
          
          if (b5Office) {
            // Check if B-5 is available
            const isAvailable = await this.isOfficeAvailable('B-5', appointmentRecord, appointments);
            
            if (isAvailable) {
              // In a real implementation, we would check if B-5 has younger children scheduled
              // For simplicity, we'll just check if it's available
              return {
                officeId: 'B-5',
                reasons: [`Older child/teen (${clientAge} years old) assigned to B-5 as fallback (Priority ${RulePriority.OLDER_CHILDREN_TEENS})`]
              };
            }
          }
        }
      } catch (error) {
        console.error('Error processing age-based rule:', error);
      }
      
      // RULE PRIORITY 65: Clinician Primary Office
      console.log("Checking PRIORITY 65: Clinician Primary Office");
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

      // RULE PRIORITY 62: Clinician Preferred Office
      console.log("Checking PRIORITY 62: Clinician Preferred Office");
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
      
      // RULE PRIORITY 55: Adult Client Assignments (moved down from 70)
      console.log("Checking PRIORITY 55: Adult Client Assignments");
      try {
        // Try to determine age from client date of birth
        console.log(`Checking young children rule with client age: ${clientAge}`);
        
        if (clientAge !== null && clientAge >= 18) {
          console.log(`Client is adult (${clientAge} years old), checking primary adult offices`);
          
          // Try B-4, C-2, C-3 in order for primary adult offices
          const primaryAdultOffices = ['B-4', 'C-2', 'C-3'];
          
          for (const officeId of primaryAdultOffices) {
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
          
          // If primary offices not available, try secondary options (B-5, C-1)
          console.log(`Primary adult offices not available, checking secondary options`);
          const secondaryAdultOffices = ['B-5', 'C-1'];
          
          for (const officeId of secondaryAdultOffices) {
            const office = activeOffices.find(o => standardizeOfficeId(o.officeId) === standardizeOfficeId(officeId));
            if (office) {
              const isAvailable = await this.isOfficeAvailable(officeId, appointmentRecord, appointments);
              if (isAvailable) {
                return {
                  officeId: standardizeOfficeId(officeId),
                  reasons: [`Adult client assigned to ${officeId} as secondary option (Priority ${RulePriority.ADULTS})`]
                };
              }
            }
          }
        }
      } catch (error) {
        console.error('Error processing adult rule:', error);
      }
      
      // RULE PRIORITY 50: In-Person Priority (moved down from 55)
      console.log("Checking PRIORITY 50: In-Person Priority");
      if (sessionType === 'in-person') {
        console.log('In-person session, checking all physical offices');
        
        // Try all physical offices in order: B-4, B-5, C-1, C-2, C-3
        const physicalOffices = ['B-4', 'B-5', 'C-1', 'C-2', 'C-3'];
        
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