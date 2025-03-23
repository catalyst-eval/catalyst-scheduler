// src/lib/scheduling/scheduler-service.ts

import cron from 'node-cron';
import { DailyScheduleService } from './daily-schedule-service';
import { EmailService } from '../email/service';
import { EmailTemplates } from '../email/templates';
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
import { RowMonitorService } from '../util/row-monitor';

// Task types enum for centralized scheduling
export enum ScheduledTaskType {
  DAILY_REPORT = 'DAILY_REPORT',
  WEEKLY_CLEANUP = 'WEEKLY_CLEANUP',
  ROW_MONITORING = 'ROW_MONITORING',
  DUPLICATE_CLEANUP = 'DUPLICATE_CLEANUP',
  OFFICE_ASSIGNMENT = 'OFFICE_ASSIGNMENT'
}

// Task definition interface
interface ScheduledTask {
  type: ScheduledTaskType;
  schedule: string; // cron expression
  description: string;
  lastRun?: Date;
  enabled: boolean;
  handler: () => Promise<void>;
}

export class SchedulerService {
  // Core services
  private dailyScheduleService: DailyScheduleService;
  private emailService: EmailService;
  private sheetsService: GoogleSheetsService;
  
  // Task management
  private scheduledTasks: Map<ScheduledTaskType, {
    task: ScheduledTask,
    cronJob: cron.ScheduledTask
  }> = new Map();
  private isTaskRunning = false; // Lock to prevent multiple tasks from running simultaneously
  private taskQueue: (() => Promise<void>)[] = []; // Queue for tasks when lock is active
  
  // Dependent services
  private rowMonitorService: RowMonitorService | null = null;
  private appointmentSyncHandler: AppointmentSyncHandler | null = null;
  
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
      
      // Register all scheduled tasks
      this.registerScheduledTask({
        type: ScheduledTaskType.DAILY_REPORT,
        schedule: '0 6 * * *', // 6:00 AM daily
        description: 'Generate and send daily schedule report',
        enabled: true,
        handler: async () => {
          await this.combinedDailyTask();
          // Void return, ignores the boolean
        }
      });
      
      this.registerScheduledTask({
        type: ScheduledTaskType.WEEKLY_CLEANUP,
        schedule: '30 3 * * 0', // 3:30 AM on Sundays
        description: 'Perform weekly data cleanup',
        enabled: true,
        handler: () => this.weeklyCleanupTask()
      });
      
      this.registerScheduledTask({
        type: ScheduledTaskType.ROW_MONITORING,
        schedule: '15 5 * * *', // 5:15 AM daily
        description: 'Monitor row counts for changes',
        enabled: true,
        handler: () => this.rowMonitorService ? this.rowMonitorService.runScheduledMonitoring() : Promise.resolve()
      });
      
      this.registerScheduledTask({
        type: ScheduledTaskType.DUPLICATE_CLEANUP,
        schedule: '45 5 * * *', // 5:45 AM daily
        description: 'Clean up duplicate appointments',
        enabled: true,
        handler: async () => {
          await this.cleanupDuplicateAppointments();
          // Return void, not the result object
        }
      });
      
      
      this.registerScheduledTask({
        type: ScheduledTaskType.OFFICE_ASSIGNMENT,
        schedule: '30 5 * * *', // 5:30 AM daily
        description: 'Process unassigned appointments',
        enabled: true,
        handler: async () => {
          await this.processUnassignedAppointments();
          // Return void, not number
        }
      });
      
      console.log('Scheduler service initialized successfully');
    } catch (error) {
      console.error('Error initializing scheduler service:', error);
    }
  }

  /**
   * Register a scheduled task and set up its cron job
   */
  private registerScheduledTask(task: ScheduledTask): void {
    try {
      console.log(`Registering scheduled task: ${task.type} (${task.description})`);
      
      const cronJob = cron.schedule(task.schedule, () => {
        console.log(`Executing scheduled task: ${task.type}`);
        task.lastRun = new Date();
        
        this.runWithLock(async () => {
          try {
            await task.handler();
          } catch (error) {
            console.error(`Error in scheduled task ${task.type}:`, error);
          }
        });
      });
      
      this.scheduledTasks.set(task.type, { task, cronJob });
      console.log(`Scheduled task ${task.type} registered for "${task.schedule}"`);
    } catch (error) {
      console.error(`Error registering scheduled task ${task.type}:`, error);
    }
  }

  /**
   * Manual trigger for a specific task type
   */
  async runTaskManually(taskType: ScheduledTaskType): Promise<any> {
    const taskEntry = this.scheduledTasks.get(taskType);
    
    if (!taskEntry) {
      throw new Error(`Task ${taskType} not found`);
    }
    
    return new Promise<any>((resolve) => {
      this.runWithLock(async () => {
        try {
          taskEntry.task.lastRun = new Date();
          await taskEntry.task.handler();
          resolve({ success: true, taskType });
        } catch (error) {
          console.error(`Error in manual task execution ${taskType}:`, error);
          resolve({ 
            success: false, 
            taskType,
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
        }
      });
    });
  }

  /**
   * Set appointment sync handler for webhook processing
   */
  public setAppointmentSyncHandler(appointmentSyncHandler: AppointmentSyncHandler): void {
    this.appointmentSyncHandler = appointmentSyncHandler;
    console.log('Appointment sync handler has been set in scheduler');
  }

  /**
   * Set row monitor service
   */
  public setRowMonitorService(rowMonitorService: RowMonitorService): void {
    this.rowMonitorService = rowMonitorService;
    console.log('Row monitor service has been set in scheduler');
  }

  /**
   * List all registered tasks with their status
   */
  getTasksStatus(): any[] {
    const taskList = [];
    
    for (const [type, entry] of this.scheduledTasks.entries()) {
      taskList.push({
        type: entry.task.type,
        description: entry.task.description,
        schedule: entry.task.schedule,
        enabled: entry.task.enabled,
        lastRun: entry.task.lastRun ? entry.task.lastRun.toISOString() : null
      });
    }
    
    return taskList;
  }

  /**
   * Combined daily task for all daily processing
   */
  async combinedDailyTask(): Promise<void> {
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
      const assignedCount = await this.processAppointmentAssignments();
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
      
      // NEW STEP: Run row monitoring check
      console.log('Step 5: Running row monitoring check');
      if (this.rowMonitorService) {
        await this.rowMonitorService.runScheduledMonitoring();
        console.log('Row monitoring check completed');
      } else {
        console.log('Row monitoring service not set, skipping check');
      }
      
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
          emailSent: emailSuccess,
          rowMonitoringRun: !!this.rowMonitorService
        })
      });
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
    }
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
      const duplicateResult = await this.performDuplicateCleanup();
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
   * This is the internal implementation that returns result data
   */
  private async performDuplicateCleanup(): Promise<{
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
   * Public method for cleaning up duplicates that returns void
   */
  async cleanupDuplicateAppointments(): Promise<void> {
    try {
      const result = await this.performDuplicateCleanup();
      console.log(`Duplicate cleanup complete: ${result.detected} detected, ${result.removed} removed`);
    } catch (error) {
      console.error('Error in cleanupDuplicateAppointments:', error);
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
          const assignedCount = await this.processAppointmentAssignments();
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
   * Process unassigned appointments
   */
  async processUnassignedAppointments(): Promise<void> {
    try {
      const count = await this.processAppointmentAssignments();
      console.log(`Processed ${count} unassigned appointments`);
    } catch (error) {
      console.error('Error processing unassigned appointments:', error);
    }
  }

  private async processAppointmentAssignments(): Promise<number> {
    try {
      // Get the appointments that need assignment
      const unassignedAppointments = await this.getAppointmentsNeedingAssignment();
      
      if (unassignedAppointments.length === 0) {
        console.log('No appointments need assignment');
        return 0;
      }
      
      console.log(`Found ${unassignedAppointments.length} appointments that need assignment`);
      
      // Since resolveOfficeAssignments is private, we'll use the public generateDailySchedule method
      // This will run the office assignment logic as part of generating the schedule
      const today = getTodayEST();
      await this.dailyScheduleService.generateDailySchedule(today);
      
      // After generating the schedule, the assignments should be updated in the database
      // Count how many appointments were successfully assigned
      let assignedCount = 0;
      
      // Check which appointments now have assignments
      for (const appointment of unassignedAppointments) {
        try {
          // Fetch the current state of the appointment from the database
          const updatedAppointment = await this.sheetsService.getAppointment(appointment.appointmentId);
          
          // Check if it now has an office assignment
          if (updatedAppointment && 
              updatedAppointment.assignedOfficeId && 
              updatedAppointment.assignedOfficeId !== 'TBD') {
            assignedCount++;
          }
        } catch (error) {
          console.error(`Error checking assignment for appointment ${appointment.appointmentId}:`, error);
        }
      }
      
      console.log(`Successfully assigned ${assignedCount} appointments`);
      return assignedCount;
    } catch (error) {
      console.error('Error in processAppointmentAssignments:', error);
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
    
    // Iterate through the Map and stop each cronJob
    for (const [type, entry] of this.scheduledTasks.entries()) {
      if (entry.cronJob && typeof entry.cronJob.stop === 'function') {
        entry.cronJob.stop();
        console.log(`Stopped task: ${type}`);
      }
    }
    
    // Clear the Map (don't reassign it)
    this.scheduledTasks.clear();
  }
}