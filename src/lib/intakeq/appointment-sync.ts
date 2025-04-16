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

  private activeLocks: Map<string, {timestamp: number, operation: string}> = new Map();
  private readonly lockTimeout = 30000; // 30 seconds
  
  private async acquireLock(appointmentId: string, operation: string): Promise<boolean> {
    // Check if appointment is already being processed
    const existingLock = this.activeLocks.get(appointmentId);
    
    if (existingLock) {
      // Check if lock is stale (older than timeout)
      if (Date.now() - existingLock.timestamp > this.lockTimeout) {
        console.warn(`Stale lock detected for appointment ${appointmentId}, operation: ${existingLock.operation}`);
        // Release the stale lock
        this.activeLocks.delete(appointmentId);
      } else {
        console.log(`Appointment ${appointmentId} is already being processed by operation: ${existingLock.operation}`);
        return false;
      }
    }
    
    // Acquire the lock
    this.activeLocks.set(appointmentId, {
      timestamp: Date.now(),
      operation
    });
    
    return true;
  }
  
  private releaseLock(appointmentId: string): void {
    this.activeLocks.delete(appointmentId);
  }

/**
 * Process appointment webhook events
 * Enhanced with robust error handling, payload validation, and locking
 */
async processAppointmentEvent(
  payload: IntakeQWebhookPayload
): Promise<WebhookResponse> {
  // Initial validation of payload
  if (!payload || typeof payload !== 'object') {
    return { 
      success: false, 
      error: 'Invalid payload format: not an object',
      retryable: false 
    };
  }

  if (!payload.Appointment) {
    return { 
      success: false, 
      error: 'Missing appointment data',
      retryable: false 
    };
  }

  const eventType = payload.Type || payload.EventType || 'Unknown';
  const appointmentId = payload.Appointment.Id || 'unknown';
  const processTime = new Date().toISOString();
  
  // Generate a unique webhook ID
  const webhookId = `${eventType}_${appointmentId}_${Date.now()}`;
  
  try {
    // Check if this webhook has already been processed (idempotency check)
    const alreadyProcessed = await this.sheetsService.isWebhookProcessed(webhookId);
    if (alreadyProcessed) {
      console.log(`Webhook ${webhookId} for appointment ${appointmentId} already processed, skipping`);
      return {
        success: true,
        details: {
          appointmentId,
          webhookId,
          status: 'already_processed'
        }
      };
    }
    
    // Log webhook receipt
    console.log(`Processing ${eventType} event for appointment ${appointmentId}`);
    
    // Log start of processing
    await this.sheetsService.logWebhook(webhookId, 'processing', {
      type: eventType,
      entityId: appointmentId,
      processTime
    });
    
    // Create a safe copy without sensitive info for logging
    const safePayload = JSON.parse(JSON.stringify(payload));
    if (safePayload.Appointment) {
      if (safePayload.Appointment.ClientEmail) safePayload.Appointment.ClientEmail = '[REDACTED]';
      if (safePayload.Appointment.ClientPhone) safePayload.Appointment.ClientPhone = '[REDACTED]';
    }
    console.log(`WEBHOOK PAYLOAD STRUCTURE for ${eventType}:`, JSON.stringify(safePayload, null, 2));
    
    // Try to acquire lock for this appointment
    const lockAcquired = await this.acquireLock(appointmentId, eventType);
    if (!lockAcquired) {
      console.log(`Could not acquire lock for appointment ${appointmentId}, will retry later`);
      
      // Update webhook status
      await this.sheetsService.updateWebhookStatus(webhookId, 'failed', {
        error: 'Appointment is currently being processed by another operation',
        retryable: true
      });
      
      return {
        success: false,
        error: `Appointment ${appointmentId} is currently being processed`,
        retryable: true
      };
    }
    
    try {
      // Additional validation of appointment object structure
      if (payload.Appointment) {
        console.log(`Appointment fields: ${Object.keys(payload.Appointment).join(', ')}`);
        console.log(`StartDateIso type: ${typeof payload.Appointment.StartDateIso}, value: ${payload.Appointment.StartDateIso}`);
        console.log(`EndDateIso type: ${typeof payload.Appointment.EndDateIso}, value: ${payload.Appointment.EndDateIso}`);
        console.log(`Status field: ${payload.Appointment.Status}`);
        
        // Check for status value mistakenly in date fields
        if (payload.Appointment.EndDateIso === "scheduled" || 
            payload.Appointment.EndDateIso === "confirmed" || 
            payload.Appointment.EndDateIso === "cancelled" || 
            payload.Appointment.EndDateIso === "canceled") {
          console.warn(`FIELD MISMATCH DETECTED: EndDateIso contains status value "${payload.Appointment.EndDateIso}"`);
          payload.Appointment.EndDateIso = "";  // Clear it so we can recover
        }
        
        if (payload.Appointment.StartDateIso === "scheduled" || 
            payload.Appointment.StartDateIso === "confirmed" || 
            payload.Appointment.StartDateIso === "cancelled" || 
            payload.Appointment.StartDateIso === "canceled") {
          console.warn(`FIELD MISMATCH DETECTED: StartDateIso contains status value "${payload.Appointment.StartDateIso}"`);
          payload.Appointment.StartDateIso = "";  // Clear it so we can recover
        }
      }
      
      // Log webhook receipt with error handling
      try {
        await this.retryWithBackoff(() => this.sheetsService.addAuditLog({
          timestamp: processTime,
          eventType: 'WEBHOOK_RECEIVED',
          description: `Received ${eventType} webhook for appointment ${appointmentId}`,
          user: 'INTAKEQ_WEBHOOK',
          systemNotes: JSON.stringify({
            appointmentId: appointmentId,
            type: eventType,
            clientId: payload.ClientId,
            processTime: processTime
          })
        }), 3);
      } catch (logError) {
        console.warn('Failed to log webhook receipt, continuing processing:', logError);
      }

      // For efficiency and duplicate prevention, check if this is an existing appointment before processing
      let existingAppointment = null;
      try {
        existingAppointment = await this.sheetsService.getAppointment(appointmentId);
        if (existingAppointment) {
          console.log(`Found existing appointment ${appointmentId} in database`);
        }
      } catch (getError) {
        console.warn(`Error checking if appointment ${appointmentId} exists:`, getError);
        // Continue processing - the error handling in the specific handlers will manage this
      }

      // Special case: 'Created' event for an existing appointment
      if (eventType.includes('Created') && existingAppointment) {
        console.log(`Received 'Created' event for existing appointment ${appointmentId}, handling as update instead`);
        const result = await this.handleAppointmentUpdate(payload.Appointment);
        
        // Mark webhook as completed
        await this.sheetsService.updateWebhookStatus(webhookId, 'completed', {
          result: result.success ? 'success' : 'error',
          details: result.details
        });
        
        return result;
      }

      // Handle appointment events based on type
      let result: WebhookResponse;
      if (eventType.includes('Created')) {
        result = await this.handleNewAppointment(payload.Appointment);
      } 
      else if (eventType.includes('Updated') || 
              eventType.includes('Rescheduled') || 
              eventType.includes('Confirmed')) {
        result = await this.handleAppointmentUpdate(payload.Appointment);
      }
      else if (eventType.includes('Cancelled') || eventType.includes('Canceled')) {
        result = await this.handleAppointmentCancellation(payload.Appointment);
      }
      else if (eventType.includes('Deleted')) {
        result = await this.handleAppointmentDeletion(payload.Appointment);
      }
      else {
        // Unsupported event type
        console.warn(`Unsupported webhook event type: ${eventType}`);
        result = {
          success: false,
          error: `Unsupported event type: ${eventType}`,
          retryable: false
        };
      }
      
      // Mark webhook as completed or failed
      if (result.success) {
        await this.sheetsService.updateWebhookStatus(webhookId, 'completed', { details: result.details });
      } else {
        await this.sheetsService.updateWebhookStatus(webhookId, 'failed', { 
          error: result.error,
          retryable: result.retryable,
          details: result.details
        });
      }
      
      return result;
    } finally {
      // Always release the lock when done
      this.releaseLock(appointmentId);
    }
  } catch (error) {
    console.error('Appointment processing error:', error);
    
    // Safe error logging
    try {
      if (payload && payload.Appointment) {
        await this.sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'SYSTEM_ERROR',
          description: `Error processing appointment ${payload.Appointment.Id}`,
          user: 'SYSTEM',
          systemNotes: error instanceof Error ? error.message : 'Unknown error'
        });
      } else {
        await this.sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'SYSTEM_ERROR',
          description: 'Error processing appointment webhook with invalid payload',
          user: 'SYSTEM',
          systemNotes: error instanceof Error ? error.message : 'Unknown error'
        });
      }
      
      // Update webhook status
      await this.sheetsService.updateWebhookStatus(webhookId, 'failed', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    } catch (logError) {
      console.error('Failed to log processing error:', logError);
    }

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
 * Handle appointment cancellation with improved reliability
 * Includes multiple fallback strategies and enhanced error handling
 */
private async handleAppointmentCancellation(
  appointment: IntakeQAppointment
): Promise<WebhookResponse> {
  try {
    console.log('Processing appointment cancellation:', appointment.Id);
    
    // Check if appointment exists
    let existingAppointment;
    let retryCount = 0;
    const maxRetries = 3;
    
    // Retry getting the appointment with backoff
    while (retryCount < maxRetries) {
      try {
        // Clear cache before retrieval to ensure fresh data
        if (retryCount > 0) {
          console.log(`Clearing cache before retry ${retryCount + 1}`);
          this.sheetsService.cache.invalidatePattern(`appointments:${appointment.Id}`);
          this.sheetsService.cache.invalidatePattern(`sheet:Appointments`);
          this.sheetsService.cache.invalidatePattern(`sheet:Active_Appointments`);
          
          // Small delay before retry
          await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, retryCount)));
        }
        
        existingAppointment = await this.retryWithBackoff(() => 
          this.sheetsService.getAppointment(appointment.Id)
        );
        
        if (existingAppointment) {
          console.log(`Found existing appointment ${appointment.Id} in database`);
          break;
        } else {
          console.log(`Appointment ${appointment.Id} not found on attempt ${retryCount + 1}`);
        }
      } catch (getError) {
        console.error(`Error fetching appointment ${appointment.Id} for cancellation (attempt ${retryCount + 1}):`, getError);
      }
      
      retryCount++;
    }
    
    if (!existingAppointment) {
      console.warn(`Appointment ${appointment.Id} not found for cancellation after ${maxRetries} attempts`);
      
      // Try broader search if we have client name and approximate time
      if (appointment.ClientName && appointment.StartDateIso) {
        console.log(`Trying broader search for appointment by client name: ${appointment.ClientName}`);
        
        try {
          // Using getAppointments with filter as a fallback
          const allAppointments = await this.sheetsService.getAllAppointments();
          if (allAppointments && allAppointments.length > 0) {
            // Filter appointments by client name (case insensitive)
            const clientNameLower = appointment.ClientName.toLowerCase();
            let clientAppointments = allAppointments.filter(a => 
              a.clientName.toLowerCase().includes(clientNameLower) || 
              clientNameLower.includes(a.clientName.toLowerCase())
            );
            
            // Further filter by date (if available) - approximately same day
            if (appointment.StartDateIso) {
              const targetDate = new Date(appointment.StartDateIso);
              const targetDay = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD
              
              clientAppointments = clientAppointments.filter(a => {
                const appDay = new Date(a.startTime).toISOString().split('T')[0];
                return appDay === targetDay;
              });
            }
            
            if (clientAppointments.length > 0) {
              console.log(`Found ${clientAppointments.length} possible matches for cancelled appointment by client name`);
              
              // Log potential matches for debugging
              clientAppointments.forEach(app => {
                console.log(`Potential match: ${app.appointmentId}, ${app.startTime}, ${app.status}`);
              });
              
              // Handle the first matching appointment that isn't already cancelled
              const activeAppointment = clientAppointments.find(a => a.status !== 'cancelled');
              if (activeAppointment) {
                console.log(`Found matching active appointment ${activeAppointment.appointmentId} to cancel`);
                
                // Cancel this appointment with cancellation reason from IntakeQ
                await this.sheetsService.updateAppointmentStatus(activeAppointment.appointmentId, 'cancelled', {
                  reason: appointment.CancellationReason || 'Cancelled via IntakeQ',
                  notes: `Cancelled based on client match (original IntakeQ ID: ${appointment.Id})`
                });
                
                // Log the successful alternative cancellation
                await this.sheetsService.addAuditLog({
                  timestamp: new Date().toISOString(),
                  eventType: 'APPOINTMENT_CANCELLED',
                  description: `Cancelled appointment ${activeAppointment.appointmentId} via client name matching`,
                  user: 'SYSTEM',
                  systemNotes: JSON.stringify({
                    originalAppointmentId: appointment.Id,
                    matchedAppointmentId: activeAppointment.appointmentId,
                    reason: appointment.CancellationReason || 'Not specified',
                    clientId: appointment.ClientId,
                    clientName: appointment.ClientName
                  })
                });
                
                return {
                  success: true,
                  details: {
                    appointmentId: activeAppointment.appointmentId,
                    status: 'cancelled',
                    matchMethod: 'client-name-time'
                  }
                };
              }
            }
          }
        } catch (searchError) {
          console.error(`Error searching for appointment by client name:`, searchError);
        }
      }
      
      // Try to check if this is a recurring appointment
      const hasRecurrencePattern = appointment.RecurrencePattern || 
        (appointment.StartDateIso && appointment.EndDateIso);
      
      if (hasRecurrencePattern) {
        console.log('This appears to be part of a recurring series. Proceeding with cancellation anyway.');
        
        // Log the cancellation even though we couldn't find the appointment
        await this.logCancellationEvent(appointment);
        
        return {
          success: true,
          details: {
            appointmentId: appointment.Id,
            action: 'cancelled_recurring_appointment',
            message: 'Appointment not found, but recorded cancellation for recurring series'
          }
        };
      }
            
      return {
        success: false,
        error: `Appointment ${appointment.Id} not found for cancellation after ${maxRetries} attempts`,
        retryable: false,
        details: {
          appointmentId: appointment.Id,
          attempts: maxRetries
        }
      };
    }
    
    // Strategy 1: Try deletion first
    let deletionSuccess = false;
    try {
      console.log(`Attempting to delete appointment ${appointment.Id} from sheet`);
      
      // Before deletion, ensure cache is invalidated
      this.sheetsService.cache.invalidateAppointments();
      
      await this.retryWithBackoff(() => this.sheetsService.deleteAppointment(appointment.Id));
      console.log(`Successfully deleted appointment ${appointment.Id} from sheet`);
      deletionSuccess = true;
    } catch (deleteError) {
      console.error(`Failed to delete appointment ${appointment.Id}, falling back to status update:`, deleteError);
    }
    
    // Strategy 2: If deletion fails, try to update status instead as a fallback
    if (!deletionSuccess) {
      try {
        console.log(`Attempting fallback: Updating status of appointment ${appointment.Id} to cancelled`);
        
        // Create a modified copy of the existing appointment with cancelled status
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
    
    // Log cancellation
    await this.logCancellationEvent(appointment);

    return {
      success: true,
      details: {
        appointmentId: appointment.Id,
        action: 'cancelled_and_processed',
        method: deletionSuccess ? 'row_deletion' : 'status_update'
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
 * Helper method to log cancellation events consistently
 */
private async logCancellationEvent(appointment: IntakeQAppointment): Promise<void> {
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
        deletionMethod: 'row_removal_with_status_fallback',
        cancellationDate: appointment.CancellationDate || new Date().toISOString()
      })
    }), 2);
  } catch (logError) {
    console.warn('Failed to log appointment cancellation:', logError);
  }
}

/**
 * Handle appointment deletion
 * Enhanced with better error recovery and verification
 */
private async handleAppointmentDeletion(
  appointment: IntakeQAppointment
): Promise<WebhookResponse> {
  try {
    console.log('Processing appointment deletion:', appointment.Id);
    
    // Check if appointment exists
    let existingAppointment;
    let retryCount = 0;
    const maxRetries = 3;
    
    // Retry getting the appointment with backoff
    while (retryCount < maxRetries) {
      try {
        // Clear cache before retrieval to ensure fresh data
        if (retryCount > 0) {
          console.log(`Clearing cache before retry ${retryCount + 1}`);
          this.sheetsService.cache.invalidateAppointments();
          
          // Small delay before retry
          await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, retryCount)));
        }
        
        existingAppointment = await this.retryWithBackoff(() => 
          this.sheetsService.getAppointment(appointment.Id)
        );
        
        if (existingAppointment) {
          console.log(`Found existing appointment ${appointment.Id} in database`);
          break;
        } else {
          console.log(`Appointment ${appointment.Id} not found on attempt ${retryCount + 1}`);
        }
      } catch (getError) {
        console.error(`Error fetching appointment ${appointment.Id} for deletion (attempt ${retryCount + 1}):`, getError);
      }
      
      retryCount++;
    }
    
    if (!existingAppointment) {
      console.warn(`Appointment ${appointment.Id} not found for deletion after ${maxRetries} attempts`);
      
      // Check if this is a recurring appointment
      const hasRecurrencePattern = appointment.RecurrencePattern || 
        (appointment.StartDateIso && appointment.EndDateIso);
      
      if (hasRecurrencePattern) {
        console.log('This appears to be part of a recurring series. Proceeding with deletion record anyway.');
        
        // Log the deletion even though we couldn't find the appointment
        await this.logDeletionEvent(appointment);
        
        return {
          success: true,
          details: {
            appointmentId: appointment.Id,
            action: 'deleted_recurring_appointment',
            message: 'Appointment not found, but recorded deletion for recurring series'
          }
        };
      }
      
      return {
        success: false,
        error: `Appointment ${appointment.Id} not found for deletion after ${maxRetries} attempts`,
        retryable: false,
        details: {
          appointmentId: appointment.Id,
          attempts: maxRetries
        }
      };
    }
    
    // Strategy 1: Try deletion with retry logic
    let deletionSuccess = false;
    try {
      console.log(`Attempting to delete appointment ${appointment.Id}`);
      
      // Ensure cache is invalidated before deletion
      this.sheetsService.cache.invalidateAppointments();
      
      await this.retryWithBackoff(() => this.sheetsService.deleteAppointment(appointment.Id), 5);
      console.log(`Successfully deleted appointment ${appointment.Id}`);
      deletionSuccess = true;
    } catch (deleteError) {
      console.error(`Failed to delete appointment ${appointment.Id}, falling back to status update:`, deleteError);
    }
    
    // Strategy 2: If deletion fails, try to update status as a fallback
    if (!deletionSuccess) {
      try {
        console.log(`Attempting fallback: Updating status of appointment ${appointment.Id} to cancelled`);
        
        // Create a modified copy of the existing appointment with cancelled status
        const deletionUpdate: AppointmentRecord = {
          ...existingAppointment,
          status: 'cancelled' as 'cancelled',
          lastUpdated: new Date().toISOString(),
          notes: (existingAppointment.notes || '') + 
                 `\nDeleted: ${new Date().toISOString()}`
        };
        
        // Update with cancelled status
        await this.retryWithBackoff(() => this.sheetsService.updateAppointment(deletionUpdate));
        console.log(`Fallback successful: Updated appointment ${appointment.Id} status for deletion`);
      } catch (updateError) {
        console.error(`Both deletion and status update failed for appointment ${appointment.Id}:`, updateError);
        throw new Error(`Failed to process deletion: ${updateError instanceof Error ? updateError.message : 'Unknown error'}`);
      }
    }
    
    // Log the deletion
    await this.logDeletionEvent(appointment);
    
    return {
      success: true,
      details: {
        appointmentId: appointment.Id,
        action: 'deleted',
        method: deletionSuccess ? 'row_deletion' : 'status_update'
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
 * Helper method to log deletion events consistently
 */
private async logDeletionEvent(appointment: IntakeQAppointment): Promise<void> {
  try {
    await this.retryWithBackoff(() => this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'APPOINTMENT_DELETED' as AuditEventType,
      description: `Deleted appointment ${appointment.Id}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        appointmentId: appointment.Id,
        clientId: appointment.ClientId,
        deletionMethod: 'row_removal_with_status_fallback',
        appointmentDate: appointment.StartDateIso || ''
      })
    }), 2);
  } catch (logError) {
    console.warn('Failed to log appointment deletion:', logError);
  }
}

/**
 * Process recurring appointment series
 * Method to handle recurring appointments consistently
 */
async processRecurringAppointment(
  payload: IntakeQWebhookPayload
): Promise<WebhookResponse> {
  // Keep the implementation the same, just change from private to public
  try {
    console.log('Processing recurring appointment series:', payload.Appointment?.Id);
    
    // Validate appointment data
    if (!payload.Appointment || !payload.Appointment.RecurrencePattern) {
      return {
        success: false,
        error: 'Invalid recurring appointment data',
        retryable: false
      };
    }
    
    const appointment = payload.Appointment;
    const recurrencePattern = appointment.RecurrencePattern;
    
    console.log('Recurrence pattern:', JSON.stringify(recurrencePattern));
    
    // Safety check for frequency and occurrences
    const frequency = recurrencePattern?.frequency || 'unknown';
    const occurrences = recurrencePattern?.occurrences || 0;
    const endDate = recurrencePattern?.endDate || '';
    
    // Log the recurring nature of the appointment
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'WEBHOOK_RECEIVED' as AuditEventType,
      description: `Received recurring appointment data for ${appointment.Id}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        appointmentId: appointment.Id,
        clientId: appointment.ClientId,
        frequency,
        occurrences,
        endDate
      })
    });
    
    // Process the first occurrence (the base appointment)
    const baseResult = await this.handleNewAppointment(appointment);
    if (!baseResult.success) {
      return baseResult;
    }
    
    // For recurring appointments, we rely on IntakeQ to send separate webhooks for each occurrence
    // This is just for logging and tracking purposes
    return {
      success: true,
      details: {
        appointmentId: appointment.Id,
        action: 'created_recurring_base',
        recurrencePattern: {
          frequency,
          occurrences,
          endDate
        }
      }
    };
  } catch (error) {
    console.error('Error processing recurring appointment:', error);
    
    // Log the error
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'SYSTEM_ERROR' as AuditEventType,
      description: `Error processing recurring appointment ${payload.Appointment?.Id}`,
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error processing recurring appointment',
      retryable: true
    };
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

/**
 * Validate and fix appointment date fields to prevent corrupted data
 * Enhanced to handle IntakeQ webhook format changes
 */
private validateAppointmentDates(appointment: IntakeQAppointment): void {
  console.log(`Validating dates for appointment ${appointment.Id}, StartDateIso: ${appointment.StartDateIso}, EndDateIso: ${appointment.EndDateIso}`);
  console.log(`Additional date info - StartDate: ${appointment.StartDate}, EndDate: ${appointment.EndDate}, Duration: ${appointment.Duration}`);
  
  // STEP 1: Clean up invalid values in date fields
  
  // Fix when EndDateIso contains a status value instead of a date
  if (typeof appointment.EndDateIso === 'string' && 
      (appointment.EndDateIso === 'scheduled' || 
       appointment.EndDateIso === 'confirmed' || 
       appointment.EndDateIso === 'cancelled' || 
       appointment.EndDateIso === 'canceled')) {
    console.log(`Detected status value "${appointment.EndDateIso}" in EndDateIso field, clearing it`);
    appointment.EndDateIso = '';
  }
  
  // Same check for StartDateIso
  if (typeof appointment.StartDateIso === 'string' && 
      (appointment.StartDateIso === 'scheduled' || 
       appointment.StartDateIso === 'confirmed' || 
       appointment.StartDateIso === 'cancelled' || 
       appointment.StartDateIso === 'canceled')) {
    console.log(`Detected status value "${appointment.StartDateIso}" in StartDateIso field, clearing it`);
    appointment.StartDateIso = '';
  }
  
  // STEP 2: Use available date information in order of reliability
  
  // Try to use StartDateIso if it's available and valid
  let validStartDate: Date | null = null;
  if (appointment.StartDateIso && typeof appointment.StartDateIso === 'string') {
    try {
      const testDate = new Date(appointment.StartDateIso);
      if (!isNaN(testDate.getTime())) {
        validStartDate = testDate;
        console.log(`Using valid StartDateIso: ${appointment.StartDateIso}`);
      } else {
        console.warn(`StartDateIso exists but is invalid: ${appointment.StartDateIso}`);
      }
    } catch (e) {
      console.warn(`Error parsing StartDateIso: ${appointment.StartDateIso}`, e);
    }
  }
  
  // If StartDateIso is invalid, try Unix timestamp StartDate
  if (!validStartDate && appointment.StartDate) {
    try {
      // Make sure it's a number and convert
      const startTimestamp = Number(appointment.StartDate);
      if (!isNaN(startTimestamp) && startTimestamp > 0) {
        validStartDate = new Date(startTimestamp);
        appointment.StartDateIso = validStartDate.toISOString();
        console.log(`Generated StartDateIso from StartDate timestamp: ${appointment.StartDateIso}`);
      }
    } catch (e) {
      console.warn(`Error converting StartDate timestamp: ${appointment.StartDate}`, e);
    }
  }
  
  // If we still don't have a valid start date, use current time as a fallback
  if (!validStartDate) {
    validStartDate = new Date();
    appointment.StartDateIso = validStartDate.toISOString();
    console.log(`No valid start date found, using current time: ${appointment.StartDateIso}`);
  }
  
  // Now do the same for end date
  let validEndDate: Date | null = null;
  if (appointment.EndDateIso && typeof appointment.EndDateIso === 'string') {
    try {
      const testDate = new Date(appointment.EndDateIso);
      if (!isNaN(testDate.getTime())) {
        validEndDate = testDate;
        console.log(`Using valid EndDateIso: ${appointment.EndDateIso}`);
      } else {
        console.warn(`EndDateIso exists but is invalid: ${appointment.EndDateIso}`);
      }
    } catch (e) {
      console.warn(`Error parsing EndDateIso: ${appointment.EndDateIso}`, e);
    }
  }
  
  // If EndDateIso is invalid, try Unix timestamp EndDate
  if (!validEndDate && appointment.EndDate) {
    try {
      // Make sure it's a number and convert
      const endTimestamp = Number(appointment.EndDate);
      if (!isNaN(endTimestamp) && endTimestamp > 0) {
        validEndDate = new Date(endTimestamp);
        appointment.EndDateIso = validEndDate.toISOString();
        console.log(`Generated EndDateIso from EndDate timestamp: ${appointment.EndDateIso}`);
      }
    } catch (e) {
      console.warn(`Error converting EndDate timestamp: ${appointment.EndDate}`, e);
    }
  }
  
  // Try to calculate from Duration if available
  if (!validEndDate && validStartDate && appointment.Duration && !isNaN(Number(appointment.Duration))) {
    try {
      const durationMinutes = Number(appointment.Duration);
      validEndDate = new Date(validStartDate.getTime() + (durationMinutes * 60000));
      appointment.EndDateIso = validEndDate.toISOString();
      console.log(`Generated EndDateIso from StartDateIso and Duration: ${appointment.EndDateIso}`);
    } catch (e) {
      console.warn(`Error calculating EndDateIso from Duration: ${appointment.Duration}`, e);
    }
  }
  
  // Use hardcoded default duration if we still don't have an end date
  // Most therapy appointments are either 50 minutes or 45 minutes
  if (!validEndDate && validStartDate) {
    const defaultDuration = 50; // 50 minutes
    validEndDate = new Date(validStartDate.getTime() + (defaultDuration * 60000));
    appointment.EndDateIso = validEndDate.toISOString();
    console.log(`No valid end date found, using default 50-minute duration: ${appointment.EndDateIso}`);
  }
  
  // STEP 3: Final validation and fix any remaining issues
  
  // Ensure StartDateIso is a valid string
  if (!appointment.StartDateIso || typeof appointment.StartDateIso !== 'string') {
    console.error(`StartDateIso is still missing or invalid after recovery attempts`);
    throw new Error(`Invalid StartDateIso format for appointment ${appointment.Id}`);
  }
  
  // Ensure EndDateIso is a valid string
  if (!appointment.EndDateIso || typeof appointment.EndDateIso !== 'string') {
    console.error(`EndDateIso is still missing or invalid after recovery attempts`);
    throw new Error(`Invalid EndDateIso format for appointment ${appointment.Id}`);
  }
  
  // Final validation - parse and confirm dates are valid
  const startDate = new Date(appointment.StartDateIso);
  const endDate = new Date(appointment.EndDateIso);
  
  if (isNaN(startDate.getTime())) {
    throw new Error(`Final validation failed: Invalid StartDateIso value: ${appointment.StartDateIso}`);
  }
  
  if (isNaN(endDate.getTime())) {
    throw new Error(`Final validation failed: Invalid EndDateIso value: ${appointment.EndDateIso}`);
  }
  
  // Ensure end date is after start date
  if (endDate <= startDate) {
    console.error(`EndDateIso (${appointment.EndDateIso}) must be after StartDateIso (${appointment.StartDateIso})`);
    
    // Fix end date by adding 50 minutes to start time
    const fixedEndDate = new Date(startDate.getTime() + (50 * 60000));
    appointment.EndDateIso = fixedEndDate.toISOString();
    console.log(`Fixed EndDateIso: ${appointment.EndDateIso}`);
  }
  
  console.log(`Date validation complete for appointment ${appointment.Id}`);
  console.log(`Final dates - StartDateIso: ${appointment.StartDateIso}, EndDateIso: ${appointment.EndDateIso}`);
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