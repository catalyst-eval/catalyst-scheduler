// src/lib/scheduling/scheduler-service.ts

import cron from 'node-cron';
import { DailyScheduleService } from './daily-schedule-service';
import { EmailService } from '../email/service';
import { EmailTemplates } from '../email/templates';  // Added this import
import { GoogleSheetsService, AuditEventType } from '../google/sheets';
import { AppointmentSyncHandler } from '../intakeq/appointment-sync';
import { IntakeQService } from '../intakeq/service';
import { WebhookEventType } from '../../types/webhooks';
import { AppointmentRecord } from '../../types/scheduling';
import { 
  getTodayEST, 
  getESTDayRange,
  getDisplayDate 
} from '../util/date-helpers';

export class SchedulerService {
  private dailyScheduleService: DailyScheduleService;
  private emailService: EmailService;
  private sheetsService: GoogleSheetsService;
  private scheduledTasks: cron.ScheduledTask[] = [];
  private isTaskRunning = false; // Lock to prevent multiple tasks from running simultaneously
  private taskQueue: (() => Promise<void>)[] = []; // Queue for tasks when lock is active
  
  constructor() {
    // Initialize services
    this.sheetsService = new GoogleSheetsService();
    this.dailyScheduleService = new DailyScheduleService(this.sheetsService);
    this.emailService = new EmailService(this.sheetsService);
  }

  /**
   * Initialize scheduled tasks
   */
  initialize(): void {
    try {
      console.log('Initializing scheduler service');
      
      // Schedule daily report - 6:00 AM EST every day
      // This single task now handles all daily processing
      this.scheduleDailyTask();
      
      // Schedule weekly data cleanup - 3:30 AM EST on Sundays only
      this.scheduleWeeklyCleanupTask();
      
      console.log('Scheduler service initialized successfully');
    } catch (error) {
      console.error('Error initializing scheduler service:', error);
    }
  }

  /**
   * Schedule the daily task that handles all daily processing
   */
  private scheduleDailyTask(): void {
    // Schedule for 6:00 AM EST
    const task = cron.schedule('0 6 * * *', () => {
      console.log('Executing daily task');
      this.runWithLock(async () => {
        try {
          await this.combinedDailyTask();
        } catch (error) {
          console.error('Error in daily task:', error);
        }
      });
    });
    
    this.scheduledTasks.push(task);
    console.log('Daily task scheduled for 6:00 AM');
  }

  /**
   * Schedule weekly cleanup task
   */
  private scheduleWeeklyCleanupTask(): void {
    // Schedule for 3:30 AM EST on Sundays
    const task = cron.schedule('30 3 * * 0', () => {
      console.log('Executing weekly cleanup task');
      this.runWithLock(async () => {
        try {
          await this.weeklyCleanupTask();
        } catch (error) {
          console.error('Error in weekly cleanup task:', error);
        }
      });
    });
    
    this.scheduledTasks.push(task);
    console.log('Weekly cleanup task scheduled for 3:30 AM on Sundays');
  }

  /**
 * Modified combinedDailyTask method that skips the appointment refresh
 */
  async combinedDailyTask(): Promise<boolean> {
    try {
      const date = getTodayEST();
      console.log(`Running combined daily task for ${date}`);
      
      // Log task start
      await this.logTaskWithRetry({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: `Starting combined daily task for ${date}`,
        user: 'SYSTEM'
      });
  
      // REMOVED: Status synchronization from IntakeQ
      // Relying on webhooks for real-time updates instead
      console.log('Step 1: Skipping API sync - using webhook-driven updates');
      
      // 3. Process unassigned appointments - Use getActiveAppointments for efficiency
      console.log('Step 2: Processing unassigned appointments');
      const assignedCount = await this.processUnassignedAppointments();
      console.log(`Processed ${assignedCount} unassigned appointments`);
    
      // 4. Resolve any scheduling conflicts
      console.log('Step 3: Resolving scheduling conflicts');
      const resolvedCount = await this.dailyScheduleService.resolveSchedulingConflicts(date);
      console.log(`Resolved ${resolvedCount} scheduling conflicts`);
      
      // Add a delay to ensure Google Sheets updates are reflected
      console.log('Waiting for Google Sheets to update...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 5. Generate and send daily report
      console.log('Step 4: Generating and sending daily report');
      const emailSuccess = await this.generateAndSendDailyReport(date);
      console.log(`Daily report ${emailSuccess ? 'sent successfully' : 'failed to send'}`);
      
      // Log task completion
      await this.logTaskWithRetry({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: `Completed combined daily task for ${date}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          date,
          statusUpdates: 0, // No longer doing status updates via timer
          appointmentsRefreshed: 0, // No longer refreshing via timer
          unassignedProcessed: assignedCount,
          conflictsResolved: resolvedCount,
          emailSent: emailSuccess
        })
      });
      
      return emailSuccess;
    } catch (error) {
      console.error('Error in combined daily task:', error);
      
      // Log error
      try {
        await this.logTaskWithRetry({
          timestamp: new Date().toISOString(),
          eventType: AuditEventType.SYSTEM_ERROR,
          description: 'Error in combined daily task',
          user: 'SYSTEM',
          systemNotes: error instanceof Error ? error.message : 'Unknown error'
        });
      } catch (logError) {
        console.error('Failed to log error:', logError);
      }
      
      return false;
    }
  }

  async generateDailyScheduleOnDemand(date?: string): Promise<any> {
    const targetDate = date || getTodayEST();
    console.log(`Generating daily schedule on-demand for ${targetDate}`);
    
    return new Promise<any>((resolve) => {
      this.runWithLock(async () => {
        try {
          // REMOVED: No automatic refresh of appointment data
          console.log('Step 1: Skipping API sync - using webhook-driven updates');
          
          // 2. Process unassigned appointments
          console.log('Step 2: Processing unassigned appointments');
          const assignedCount = await this.processUnassignedAppointments();
          console.log(`Processed ${assignedCount} unassigned appointments`);
          
          // 3. Resolve any scheduling conflicts
          console.log('Step 3: Resolving scheduling conflicts');
          const resolvedCount = await this.dailyScheduleService.resolveSchedulingConflicts(targetDate);
          console.log(`Resolved ${resolvedCount} scheduling conflicts`);
          
          // Add a delay to ensure Google Sheets updates are reflected
          console.log('Waiting for Google Sheets to update...');
          await new Promise(innerResolve => setTimeout(innerResolve, 2000));
          
          // 4. Generate and send daily report
          console.log('Step 4: Generating and sending daily report');
          const emailSuccess = await this.generateAndSendDailyReport(targetDate);
          console.log(`Daily report ${emailSuccess ? 'sent successfully' : 'failed to send'}`);
          
          resolve({
            success: true,
            date: targetDate,
            appointmentsRefreshed: 0, // No longer refreshing via API call
            appointmentsAssigned: assignedCount,
            conflictsResolved: resolvedCount,
            emailSent: emailSuccess
          });
        } catch (error) {
          console.error('Error generating daily schedule on-demand:', error);
          resolve({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      });
    });
  }

  /**
 * Weekly cleanup task that handles maintenance operations
 * Updated to include client accessibility data cleanup
 */
async weeklyCleanupTask(): Promise<void> {
  try {
    console.log('Running weekly cleanup task');
    
    // Log task start
    await this.logTaskWithRetry({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.INTEGRATION_UPDATED,
      description: 'Starting weekly cleanup task',
      user: 'SYSTEM'
    });
    
    // 1. Clean up old appointments
    console.log('Step 1: Cleaning up old appointments');
    const deletedCount = await this.cleanupOldAppointments();
    console.log(`Cleaned up ${deletedCount} old appointments`);
    
    // 2. Clean up empty rows
    console.log('Step 2: Cleaning up empty rows');
    const { removed, errors } = await this.cleanEmptyRows();
    console.log(`Removed ${removed} empty rows with ${errors} errors`);
    
    // NEW: Clean up default client accessibility records
    console.log('Step 2.5: Cleaning up default client accessibility records');
    let accessibilityRemoved = 0;
    try {
      // Cast to any to access the new method
      accessibilityRemoved = await (this.sheetsService as any).cleanupDefaultClientAccessibility();
      console.log(`Cleaned up ${accessibilityRemoved} default client accessibility records`);
    } catch (cleanupError) {
      console.error('Error cleaning up default client accessibility records:', cleanupError);
    }

    // 2.5. Check and clean up duplicate appointments
    console.log('Step 3: Checking for duplicate appointments');
    const duplicateResult = await this.cleanupDuplicateAppointments();
    console.log(`Found ${duplicateResult.detected} appointments with duplicates, removed ${duplicateResult.removed}`);
    
    // 3. Refresh the two-week window
    console.log('Step 4: Refreshing two-week window');
    const windowResult = await this.refreshTwoWeekWindow();
    console.log(`Two-week window refresh: ${windowResult.removed} removed, ${windowResult.preserved} preserved`);
    
    // Log task completion
    await this.logTaskWithRetry({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.INTEGRATION_UPDATED,
      description: 'Completed weekly cleanup task',
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        appointmentsDeleted: deletedCount,
        emptyRowsRemoved: removed,
        accessibilityRecordsRemoved: accessibilityRemoved,
        duplicatesRemoved: duplicateResult.removed,
        windowRefresh: windowResult
      })
    });
  } catch (error) {
    console.error('Error in weekly cleanup task:', error);
    
    // Log error
    try {
      await this.logTaskWithRetry({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Error in weekly cleanup task',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
    } catch (logError) {
      console.error('Failed to log error:', logError);
    }
  }
}

  /**
 * Detect and remove duplicate appointment entries
 */
async cleanupDuplicateAppointments(): Promise<{
  detected: number;
  removed: number;
}> {
  try {
    console.log('Checking for duplicate appointment entries');
    
    // Get all appointments
    const allAppointments = await this.sheetsService.getAllAppointments();
    
    // Track appointment IDs and which ones are duplicates
    const appointmentIds = new Map<string, number[]>(); // appointmentId -> array of row indices
    const duplicates: {appointmentId: string, indices: number[]}[] = [];
    
    // Find duplicates
    allAppointments.forEach((appt, index) => {
      if (!appt.appointmentId) return; // Skip if no ID
      
      if (!appointmentIds.has(appt.appointmentId)) {
        appointmentIds.set(appt.appointmentId, [index]);
      } else {
        const indices = appointmentIds.get(appt.appointmentId) || [];
        indices.push(index);
        appointmentIds.set(appt.appointmentId, indices);
        
        // If this is the first duplicate found for this ID, add to duplicates list
        if (indices.length === 2) {
          duplicates.push({
            appointmentId: appt.appointmentId,
            indices: [...indices]
          });
        } else if (indices.length > 2) {
          // Update existing duplicate entry
          const dupEntry = duplicates.find(d => d.appointmentId === appt.appointmentId);
          if (dupEntry) {
            dupEntry.indices.push(index);
          }
        }
      }
    });
    
    console.log(`Found ${duplicates.length} appointments with duplicates`);
    
    if (duplicates.length === 0) {
      return { detected: 0, removed: 0 };
    }
    
    // Log the duplicates found
    await this.logTaskWithRetry({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.INTEGRATION_UPDATED,
      description: `Detected ${duplicates.length} duplicate appointments`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        duplicateIds: duplicates.map(d => d.appointmentId)
      })
    });
    
    // Remove duplicates (keeping the most recently updated one)
    let removedCount = 0;
    
    for (const duplicate of duplicates) {
      try {
        // Get full appointment objects for each duplicate
        const duplicateAppointments = duplicate.indices.map(idx => allAppointments[idx]);
        
        // Sort by lastUpdated (most recent first)
        duplicateAppointments.sort((a, b) => {
          const dateA = new Date(a.lastUpdated || '');
          const dateB = new Date(b.lastUpdated || '');
          return dateB.getTime() - dateA.getTime();
        });
        
        // Keep the most recent one, delete the others
        const keepAppointment = duplicateAppointments[0];
        const deleteAppointments = duplicateAppointments.slice(1);
        
        console.log(`Keeping appointment ${keepAppointment.appointmentId} from ${keepAppointment.lastUpdated}`);
        
        // Delete duplicates
        for (const deleteAppt of deleteAppointments) {
          await this.sheetsService.deleteAppointment(deleteAppt.appointmentId);
          removedCount++;
          
          console.log(`Removed duplicate appointment ${deleteAppt.appointmentId} from ${deleteAppt.lastUpdated}`);
        }
      } catch (error) {
        console.error(`Error removing duplicates for appointment ${duplicate.appointmentId}:`, error);
      }
    }
    
    // Log completion
    await this.logTaskWithRetry({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.INTEGRATION_UPDATED,
      description: `Removed ${removedCount} duplicate appointments`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        detected: duplicates.length,
        removed: removedCount
      })
    });
    
    return {
      detected: duplicates.length,
      removed: removedCount
    };
  } catch (error) {
    console.error('Error cleaning up duplicate appointments:', error);
    
    // Log error with retry
    await this.logTaskWithRetry({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: 'Failed to clean up duplicate appointments',
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    return { detected: 0, removed: 0 };
  }
}

  /**
   * Get appointments that need assignment
   */
  private async getAppointmentsNeedingAssignment(): Promise<AppointmentRecord[]> {
    try {
      // Get all appointments
      const allAppointments = await this.sheetsService.getAllAppointments();
      
      // Filter to just unassigned appointments
      return allAppointments.filter(appt => 
        // Include appointments with no office ID or TBD
        (!appt.assignedOfficeId || appt.assignedOfficeId === 'TBD') &&
        // Exclude cancelled or completed appointments
        appt.status !== 'cancelled' && 
        appt.status !== 'completed' &&
        appt.status !== 'rescheduled'
      );
    } catch (error) {
      console.error('Error getting appointments needing assignment:', error);
      return [];
    }
  }

  /**
   * Convert our appointment format to IntakeQ format for processing
   */
  private convertToIntakeQFormat(appointment: AppointmentRecord): any {
    return {
      Id: appointment.appointmentId,
      ClientName: appointment.clientName,
      ClientId: parseInt(appointment.clientId) || 0,
      StartDateIso: appointment.startTime,
      EndDateIso: appointment.endTime,
      PractitionerId: appointment.clinicianId,
      PractitionerName: appointment.clinicianName,
      ServiceName: appointment.notes?.replace('Service: ', '') || 'Therapy Session',
      // Add other required fields with default values
      Status: 'Confirmed',
      StartDate: new Date(appointment.startTime).getTime(),
      EndDate: new Date(appointment.endTime).getTime(),
      Duration: Math.round((new Date(appointment.endTime).getTime() - new Date(appointment.startTime).getTime()) / 60000),
      // Add other fields as needed
      ClientEmail: '',
      ClientPhone: '',
      ClientDateOfBirth: '',
      ServiceId: '',
      LocationName: '',
      LocationId: '',
      Price: 0,
      PractitionerEmail: '',
      IntakeId: null,
      DateCreated: new Date().getTime(),
      CreatedBy: 'SYSTEM',
      BookedByClient: false,
      StartDateLocal: '',
      EndDateLocal: '',
      StartDateLocalFormatted: ''
    };
  }

  /**
 * Process all appointments that need office assignment from Active_Appointments
 * More efficient version that uses Active_Appointments tab
 */
async processUnassignedAppointments(): Promise<number> {
  try {
    console.log('Processing unassigned appointments from Active_Appointments');
    
    // 1. Get all active appointments
    const activeAppointments = await this.sheetsService.getActiveAppointments();
    
    // 2. Filter to just unassigned appointments
    const unassignedAppointments = activeAppointments.filter(appt => 
      // Include appointments with no office ID or TBD
      (!appt.assignedOfficeId || appt.assignedOfficeId === 'TBD') &&
      // Exclude cancelled or completed appointments
      appt.status !== 'cancelled' && 
      appt.status !== 'completed' &&
      appt.status !== 'rescheduled'
    );
    
    if (unassignedAppointments.length === 0) {
      console.log('No appointments need assignment in Active_Appointments');
      return 0;
    }
    
    console.log(`Found ${unassignedAppointments.length} appointments needing assignment`);
    
    // 3. Initialize the appointment sync handler
    const appointmentSyncHandler = new AppointmentSyncHandler(this.sheetsService);
    
    // 4. Process each appointment
    let processedCount = 0;
    const batchSize = 10;
    
    for (let i = 0; i < unassignedAppointments.length; i += batchSize) {
      const batch = unassignedAppointments.slice(i, i + batchSize);
      
      for (const appointment of batch) {
        try {
          // Convert to webhook format for processing
          const webhookPayload = {
            Type: 'AppointmentUpdated' as WebhookEventType,
            ClientId: parseInt(appointment.clientId),
            Appointment: this.convertToIntakeQFormat(appointment)
          };
          
          // Process the appointment
          const result = await appointmentSyncHandler.processAppointmentEvent(webhookPayload);
          
          if (result.success) {
            processedCount++;
            console.log(`Successfully assigned office for appointment ${appointment.appointmentId}`);
          } else {
            console.error(`Failed to assign office for appointment ${appointment.appointmentId}:`, result.error);
          }
        } catch (error) {
          console.error(`Error processing appointment ${appointment.appointmentId}:`, error);
        }
      }
      
      // Add a delay between batches to avoid rate limits
      if (i + batchSize < unassignedAppointments.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`Processed ${processedCount} of ${unassignedAppointments.length} appointments`);
    
    // 5. Log success (with retry)
    await this.logTaskWithRetry({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.DAILY_ASSIGNMENTS_UPDATED,
      description: `Processed ${processedCount} unassigned appointments`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        total: unassignedAppointments.length,
        processed: processedCount
      })
    });
    
    return processedCount;
  } catch (error) {
    console.error('Error processing unassigned appointments:', error);
    
    // Log error with retry
    await this.logTaskWithRetry({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SYSTEM_ERROR,
      description: 'Failed to process unassigned appointments',
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
    
    return 0;
  }
}

  /**
   * Generate and send the daily schedule report
   */
  async generateAndSendDailyReport(targetDate?: string): Promise<boolean> {
    try {
      // Use today's date if no target date provided, ensuring it's in EST
      const date = targetDate || getTodayEST();
      console.log(`Generating daily report for ${date} (EST)`);
      
      // Generate the daily schedule
      const scheduleData = await this.dailyScheduleService.generateDailySchedule(date);
      
      // Create email template
      const emailTemplate = EmailTemplates.dailySchedule(scheduleData);
      
      // Get recipients
      const recipients = await this.emailService.getScheduleRecipients();
      
      if (recipients.length === 0) {
        console.warn('No recipients configured for daily schedule email');
        return false;
      }
      
      // Send email
      const success = await this.emailService.sendEmail(recipients, emailTemplate, {
        category: 'daily_schedule',
        priority: 'normal'
      });
      
      // Log result (with retry)
      await this.logTaskWithRetry({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.DAILY_ASSIGNMENTS_UPDATED,
        description: `Daily schedule email for ${date} ${success ? 'sent' : 'failed'}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          date,
          displayDate: getDisplayDate(date),
          recipients: recipients.map((r: { email: string }) => r.email),
          appointmentCount: scheduleData.appointments.length,
          conflictCount: scheduleData.conflicts.length,
          success
        })
      });
      
      return success;
    } catch (error) {
      console.error('Error generating and sending daily report:', error);
      
      // Log error with retry
      await this.logTaskWithRetry({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Failed to generate and send daily report',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Try to send error notification
      try {
        const errorTemplate = EmailTemplates.errorNotification(
          error instanceof Error ? error : new Error('Unknown error'),
          'Daily Schedule Generation',
          { targetDate }
        );
        
        // Just use the same recipients for errors
        const errorRecipients = await this.emailService.getScheduleRecipients();
        
        await this.emailService.sendEmail(errorRecipients, errorTemplate, {
          priority: 'high',
          category: 'error_notification'
        });
      } catch (emailError) {
        console.error('Failed to send error notification:', emailError);
      }
      
      return false;
    }
  }

  /**
   * Clean up old appointments
   */
  async cleanupOldAppointments(): Promise<number> {
    try {
      console.log('Cleaning up old appointment data');
      
      // Get all appointments
      const allAppointments = await this.sheetsService.getAllAppointments();
      
      // Set cutoff date (appointments older than 3 months)
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - 3);
      
      // Filter appointments older than cutoff date
      const oldAppointments = allAppointments.filter(appt => {
        const apptDate = new Date(appt.startTime);
        return apptDate < cutoffDate;
      });
      
      console.log(`Found ${oldAppointments.length} appointments older than ${cutoffDate.toISOString()}`);
      
      // Process in batches
      const batchSize = 10;
      let deletedCount = 0;
      
      for (let i = 0; i < oldAppointments.length; i += batchSize) {
        const batch = oldAppointments.slice(i, i + batchSize);
        
        for (const appointment of batch) {
          try {
            // Log to audit as archived (with retry)
            await this.logTaskWithRetry({
              timestamp: new Date().toISOString(),
              eventType: AuditEventType.APPOINTMENT_DELETED,
              description: `Archived old appointment ${appointment.appointmentId}`,
              user: 'SYSTEM',
              systemNotes: JSON.stringify({
                appointmentId: appointment.appointmentId,
                clientId: appointment.clientId,
                startTime: appointment.startTime
              })
            });
            
            // Delete from appointments sheet
            await this.sheetsService.deleteAppointment(appointment.appointmentId);
            deletedCount++;
          } catch (error) {
            console.error(`Error deleting appointment ${appointment.appointmentId}:`, error);
          }
        }
        
        // Add delay between batches
        if (i + batchSize < oldAppointments.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      console.log(`Successfully archived and deleted ${deletedCount} old appointments`);
      
      return deletedCount;
    } catch (error) {
      console.error('Error cleaning up old appointments:', error);
      throw error;
    }
  }

  /**
   * Refresh the two-week appointment window
   */
  async refreshTwoWeekWindow(
    keepPastDays: number = 7,
    keepFutureDays: number = 14
  ): Promise<{
    removed: number;
    preserved: number;
    errors: number;
  }> {
    try {
      console.log(`Refreshing appointment window: keeping past ${keepPastDays} days and future ${keepFutureDays} days`);
      
      // Log start of maintenance
      await this.logTaskWithRetry({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: 'Starting two-week appointment window refresh',
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          keepPastDays,
          keepFutureDays
        })
      });
      
      // 1. Get all appointments
      const allAppointments = await this.sheetsService.getAllAppointments();
      
      // 2. Calculate window boundaries
      const today = getTodayEST();
      const todayDate = new Date(today);
      
      const pastBoundary = new Date(todayDate);
      pastBoundary.setDate(pastBoundary.getDate() - keepPastDays);
      pastBoundary.setHours(0, 0, 0, 0); // Start of day
      
      const futureBoundary = new Date(todayDate);
      futureBoundary.setDate(futureBoundary.getDate() + keepFutureDays);
      futureBoundary.setHours(23, 59, 59, 999); // End of day
      
      console.log(`Window: ${pastBoundary.toISOString()} to ${futureBoundary.toISOString()}`);
      
      // 3. Filter appointments outside the window
      const outsideWindow: { appointment: any; reason: string }[] = [];
      const withinWindow: any[] = [];
      
      for (const appt of allAppointments) {
        try {
          if (!appt.startTime) {
            outsideWindow.push({ appointment: appt, reason: 'missing start time' });
            continue;
          }
          
          const apptDate = new Date(appt.startTime);
          
          if (apptDate < pastBoundary) {
            outsideWindow.push({ appointment: appt, reason: 'before window' });
          } else if (apptDate > futureBoundary) {
            outsideWindow.push({ appointment: appt, reason: 'after window' });
          } else {
            withinWindow.push(appt);
          }
        } catch (error) {
          console.error(`Error processing appointment ${appt.appointmentId}:`, error);
          outsideWindow.push({ appointment: appt, reason: 'date parsing error' });
        }
      }
      
      console.log(`Found ${outsideWindow.length} appointments outside window and ${withinWindow.length} within window`);
      
      // 4. Process in batches
      const batchSize = 10;
      let removedCount = 0;
      let errorCount = 0;
      
      for (let i = 0; i < outsideWindow.length; i += batchSize) {
        const batch = outsideWindow.slice(i, i + batchSize);
        
        for (const { appointment, reason } of batch) {
          try {
            // Archive in audit log (with retry)
            await this.logTaskWithRetry({
              timestamp: new Date().toISOString(),
              eventType: AuditEventType.APPOINTMENT_DELETED,
              description: `Removed appointment ${appointment.appointmentId} (window maintenance: ${reason})`,
              user: 'SYSTEM',
              systemNotes: JSON.stringify({
                appointmentId: appointment.appointmentId,
                clientId: appointment.clientId,
                reason: reason
              })
            });
            
            // Delete from sheet
            await this.sheetsService.deleteAppointment(appointment.appointmentId);
            removedCount++;
          } catch (error) {
            console.error(`Error removing appointment ${appointment.appointmentId}:`, error);
            errorCount++;
          }
        }
        
        // Add delay between batches
        if (i + batchSize < outsideWindow.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      // 5. Log completion (with retry)
      await this.logTaskWithRetry({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: 'Completed two-week appointment window refresh',
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          removed: removedCount,
          preserved: withinWindow.length,
          errors: errorCount,
          windowStart: pastBoundary.toISOString().split('T')[0],
          windowEnd: futureBoundary.toISOString().split('T')[0]
        })
      });
      
      return {
        removed: removedCount,
        preserved: withinWindow.length,
        errors: errorCount
      };
    } catch (error) {
      console.error('Error refreshing two-week appointment window:', error);
      
      // Log error (with retry)
      await this.logTaskWithRetry({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Error refreshing two-week appointment window',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      throw error;
    }
  }

  /**
   * Clean up empty rows in the appointments sheet
   */
  async cleanEmptyRows(): Promise<{
    removed: number;
    errors: number;
  }> {
    try {
      console.log('Cleaning empty rows in appointments sheet');
      
      // Log start of cleanup
      await this.logTaskWithRetry({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: 'Starting empty row cleanup in appointments sheet',
        user: 'SYSTEM'
      });
      
      // 1. Get all rows including empty ones
      // Need to access the private sheets instance directly for this operation
      const sheetsService = this.sheetsService as any;
      const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      
      // Get the sheets client
      const sheetsClient = sheetsService.sheets;
      
      // Get all values including empty rows
      const response = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: 'Appointments!A:A', // Just get first column to find empty rows
        valueRenderOption: 'UNFORMATTED_VALUE'
      });
      
      const allValues = response.data.values || [];
      
      // Find empty rows (rows with no appointmentId)
      const emptyRowIndices: number[] = [];
      
      for (let i = 0; i < allValues.length; i++) {
        // Skip header row
        if (i === 0) continue;
        
        // Check if cell is empty
        if (!allValues[i] || !allValues[i][0]) {
          emptyRowIndices.push(i + 1); // +1 because sheet rows are 1-indexed
        }
      }
      
      console.log(`Found ${emptyRowIndices.length} empty rows to clean up`);
      
      if (emptyRowIndices.length === 0) {
        return { removed: 0, errors: 0 };
      }
      
      // Sort in descending order to delete from bottom to top (prevents shifting issues)
      emptyRowIndices.sort((a, b) => b - a);
      
      // Process in batches
      const batchSize = 10;
      let removed = 0;
      let errors = 0;
      
      for (let i = 0; i < emptyRowIndices.length; i += batchSize) {
        const batch = emptyRowIndices.slice(i, i + batchSize);
        
        for (const rowIndex of batch) {
          try {
            // Delete the row
            await sheetsClient.spreadsheets.batchUpdate({
              spreadsheetId,
              requestBody: {
                requests: [
                  {
                    deleteDimension: {
                      range: {
                        sheetId: 0, // First sheet in the spreadsheet
                        dimension: 'ROWS',
                        startIndex: rowIndex - 1, // 0-indexed
                        endIndex: rowIndex // exclusive
                      }
                    }
                  }
                ]
              }
            });
            
            removed++;
          } catch (error) {
            console.error(`Error removing row ${rowIndex}:`, error);
            errors++;
          }
        }
        
        // Add delay between batches
        if (i + batchSize < emptyRowIndices.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      // Log completion (with retry)
      await this.logTaskWithRetry({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: 'Completed empty row cleanup in appointments sheet',
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          found: emptyRowIndices.length,
          removed,
          errors
        })
      });
      
      return { removed, errors };
    } catch (error) {
      console.error('Error cleaning empty rows:', error);
      
      // Log error (with retry)
      await this.logTaskWithRetry({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Error cleaning empty rows in appointments sheet',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      throw error;
    }
  }

  /**
   * Generate an array of dates between startDate and endDate (inclusive)
   */
  private generateDateRange(startDate: string, endDate: string): string[] {
    const dates: string[] = [];
    const currentDate = new Date(startDate);
    const endDateObj = new Date(endDate);
    
    // Set times to midnight to avoid time issues
    currentDate.setHours(0, 0, 0, 0);
    endDateObj.setHours(0, 0, 0, 0);
    
    // Add each date until we reach the end date
    while (currentDate <= endDateObj) {
      dates.push(currentDate.toISOString().split('T')[0]);
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    return dates;
  }

  /**
   * Run a task with a lock to prevent multiple tasks from running at once
   */
  private async runWithLock(task: () => Promise<void>): Promise<void> {
    if (this.isTaskRunning) {
      console.log('Task already running, queueing this task');
      return new Promise<void>((resolve) => {
        this.taskQueue.push(async () => {
          await task();
          resolve();
        });
      });
    }
    
    try {
      this.isTaskRunning = true;
      await task();
    } finally {
      this.isTaskRunning = false;
      
      // Run next task in queue if any
      if (this.taskQueue.length > 0) {
        const nextTask = this.taskQueue.shift();
        if (nextTask) {
          console.log('Running next task from queue');
          this.runWithLock(nextTask);
        }
      }
    }
  }

  /**
   * Log task with retry mechanism and exponential backoff
   */
  private async logTaskWithRetry(entry: any, maxRetries = 3): Promise<void> {
    // Counter for log failures to avoid infinite retry loops
    let retryCount = 0;
    let success = false;
    
    while (!success && retryCount < maxRetries) {
      try {
        await this.sheetsService.addAuditLog(entry);
        success = true;
      } catch (error) {
        retryCount++;
        // Exponential backoff - wait longer after each failure
        const delay = Math.pow(2, retryCount) * 500; // 1s, 2s, 4s
        console.warn(`Log failed (attempt ${retryCount}), retrying in ${delay}ms`);
        
        // Truncate system notes if it might be contributing to the error
        if (entry.systemNotes && entry.systemNotes.length > 1000) {
          entry.systemNotes = entry.systemNotes.substring(0, 1000) + '... [truncated]';
        }
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    if (!success) {
      // If all retries failed, log to console but don't throw
      console.error(`Failed to log entry after ${maxRetries} attempts:`, {
        timestamp: entry.timestamp,
        eventType: entry.eventType,
        description: entry.description
      });
    }
  }

  /**
   * Stop all scheduled tasks
   */
  stop(): void {
    console.log('Stopping scheduler service');
    this.scheduledTasks.forEach(task => task.stop());
    this.scheduledTasks = [];
  }
}