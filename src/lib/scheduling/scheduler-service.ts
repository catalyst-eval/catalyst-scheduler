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
import { getLockService } from '../util/distributed-lock';
import { logger } from '../util/logger';

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

  private lockService = getLockService();
  
  constructor(sheetsService?: GoogleSheetsService) {
    // Initialize services
    this.sheetsService = sheetsService || new GoogleSheetsService();
    this.dailyScheduleService = new DailyScheduleService(this.sheetsService);
    this.emailService = new EmailService(this.sheetsService);
    
    // Initialize the lock service with the same sheets service
    this.lockService = getLockService(this.sheetsService);
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
    
    // Create a specific task identifier for this task type
    const taskIdentifier = `SCHEDULED_TASK_${task.type}`;
    
    // Modify how the cron job is created to include timezone
    const cronJob = cron.schedule(task.schedule, () => {
      console.log(`Executing scheduled task: ${task.type}`);
      logger.info(`Executing scheduled task: ${task.type}`);
      task.lastRun = new Date();
      
      // Use the task identifier for locking
      this.runWithLock(async () => {
        try {
          await task.handler();
        } catch (error) {
          console.error(`Error in scheduled task ${task.type}:`, error);
          const errorObj = {
            message: error instanceof Error ? error.message : String(error)
          };
          logger.error(`Error in scheduled task ${task.type}:`, errorObj);
        }
      });
    }, {
      scheduled: true,
      timezone: "America/New_York"  // Set timezone here
    });
    
    this.scheduledTasks.set(task.type, { task, cronJob });
    console.log(`Scheduled task ${task.type} registered for "${task.schedule}"`);
    logger.info(`Scheduled task ${task.type} registered for "${task.schedule}"`);
  } catch (error) {
    console.error(`Error registering scheduled task ${task.type}:`, error);
    const errorObj = {
      message: error instanceof Error ? error.message : String(error)
    };
    logger.error(`Error registering scheduled task ${task.type}:`, errorObj);
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
    
      // Process unassigned appointments
      console.log('Step 1: Processing unassigned appointments');
      const assignedCount = await this.processAppointmentAssignments();
      console.log(`Processed ${assignedCount} unassigned appointments`);
      
      // Resolve any scheduling conflicts
      console.log('Step 2: Resolving scheduling conflicts');
      const resolvedCount = await this.dailyScheduleService.resolveSchedulingConflicts(date);
      console.log(`Resolved ${resolvedCount} scheduling conflicts`);
      
      // Add a delay to ensure Google Sheets updates are reflected
      console.log('Waiting for Google Sheets to update...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Generate and send daily report
      console.log('Step 3: Generating and sending daily report');
      const emailSuccess = await this.generateAndSendDailyReport(date);
      console.log(`Daily report ${emailSuccess ? 'sent successfully' : 'failed to send'}`);
      
      // Run row monitoring check
      console.log('Step 4: Running row monitoring check');
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

  private async runWithLock(task: () => Promise<void>): Promise<void> {
    // Generate a task name based on the current stack trace
    const taskName = new Error().stack?.split('\n')[2]?.trim() || 'unknown_task';
    
    try {
      // Try to acquire a distributed lock
      const lockAcquired = await this.lockService.acquireLock(taskName);
      
      if (!lockAcquired) {
        logger.info(`Task ${taskName} is already running in another instance, skipping`);
        return;
      }
      
      try {
        // If we get here, we have the lock
        this.isTaskRunning = true;
        await task();
      } finally {
        this.isTaskRunning = false;
        
        // Release the distributed lock
        await this.lockService.releaseLock(taskName);
        
        // Run next task in queue if any
        if (this.taskQueue.length > 0) {
          const nextTask = this.taskQueue.shift();
          if (nextTask) {
            logger.info('Running next task from queue');
            this.runWithLock(nextTask);
          }
        }
      }
    } catch (error) {
      const errorObj = {
        message: error instanceof Error ? error.message : String(error)
      };
      logger.error(`Error running task with lock:`, errorObj);
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