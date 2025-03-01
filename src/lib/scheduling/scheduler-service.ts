// src/lib/scheduling/scheduler-service.ts

import cron from 'node-cron';
import { DailyScheduleService } from './daily-schedule-service';
import { EmailService } from '../email/service';
import { EmailTemplates } from '../email/templates';
import { GoogleSheetsService, AuditEventType } from '../google/sheets';
import { AppointmentSyncHandler } from '../intakeq/appointment-sync';
import { WebhookEventType } from '../../types/webhooks';
import { AppointmentRecord } from '../../types/scheduling';

export class SchedulerService {
  private dailyScheduleService: DailyScheduleService;
  private emailService: EmailService;
  private sheetsService: GoogleSheetsService;
  private scheduledTasks: cron.ScheduledTask[] = [];
  
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
      
      // Schedule unassigned appointments processing - 5:45 AM EST
      this.scheduleUnassignedAppointmentsTask();
      
      // Schedule daily report - 6:00 AM EST every day
      this.scheduleDailyReportTask();
      
      // Schedule IntakeQ refresh - 5:30 AM EST every day
      this.scheduleIntakeQRefreshTask();
      
      console.log('Scheduler service initialized successfully');
    } catch (error) {
      console.error('Error initializing scheduler service:', error);
    }
  }

  /**
   * Schedule the daily report task
   */
  private scheduleDailyReportTask(): void {
    // Schedule for 6:00 AM EST - handle timezones
    // Node-cron uses server time, so adjust as needed
    // For EST, this would be 6:00 AM if server is in EST
    const task = cron.schedule('0 6 * * *', () => {
      console.log('Executing daily report task');
      this.generateAndSendDailyReport()
        .catch(error => console.error('Error in daily report task:', error));
    });
    
    this.scheduledTasks.push(task);
    console.log('Daily report task scheduled for 6:00 AM');
  }

  /**
   * Schedule the IntakeQ refresh task
   */
  private scheduleIntakeQRefreshTask(): void {
    // Schedule for 5:30 AM EST
    const task = cron.schedule('30 5 * * *', () => {
      console.log('Executing IntakeQ refresh task');
      this.refreshAppointmentsFromIntakeQ()
        .catch(error => console.error('Error in IntakeQ refresh task:', error));
    });
    
    this.scheduledTasks.push(task);
    console.log('IntakeQ refresh task scheduled for 5:30 AM');
  }

  /**
   * Schedule the unassigned appointments processing task
   */
  private scheduleUnassignedAppointmentsTask(): void {
    // Schedule for 5:45 AM EST
    const task = cron.schedule('45 5 * * *', () => {
      console.log('Executing unassigned appointments task');
      this.processUnassignedAppointments()
        .catch(error => console.error('Error in unassigned appointments task:', error));
    });
    
    this.scheduledTasks.push(task);
    console.log('Unassigned appointments task scheduled for 5:45 AM');
  }

  /**
   * Process all appointments that need office assignment
   */
  async processUnassignedAppointments(): Promise<number> {
    try {
      console.log('Processing unassigned appointments');
      
      // 1. Get appointments that need assignment from Google Sheets
      const unassignedAppointments = await this.getAppointmentsNeedingAssignment();
      
      if (unassignedAppointments.length === 0) {
        console.log('No appointments need assignment');
        return 0;
      }
      
      console.log(`Found ${unassignedAppointments.length} appointments needing assignment`);
      
      // 2. Initialize the appointment sync handler
      const appointmentSyncHandler = new AppointmentSyncHandler(this.sheetsService);
      
      // 3. Process each appointment
      let processedCount = 0;
      for (const appointment of unassignedAppointments) {
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
      
      console.log(`Processed ${processedCount} of ${unassignedAppointments.length} appointments`);
      
      // 4. Log success
      await this.sheetsService.addAuditLog({
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
      
      // Log error
      await this.sheetsService.addAuditLog({
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
   * Get appointments that need assignment
   */
  private async getAppointmentsNeedingAssignment(): Promise<AppointmentRecord[]> {
    try {
      // Get all appointments
      const allAppointments = await this.sheetsService.getAllAppointments();
      
      // Filter to just unassigned appointments
      return allAppointments.filter(appt => 
        // Include appointments with no office ID or TBD
        (!appt.officeId || appt.officeId === 'TBD') &&
        // Exclude cancelled or completed appointments
        appt.status !== 'cancelled' && 
        appt.status !== 'completed'
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
   * Generate and send the daily schedule report
   */
  async generateAndSendDailyReport(targetDate?: string): Promise<boolean> {
    try {
      // Use today's date if no target date provided
      const date = targetDate || new Date().toISOString().split('T')[0];
      console.log(`Generating daily report for ${date}`);
      
      // 1. Generate the daily schedule
      const scheduleData = await this.dailyScheduleService.generateDailySchedule(date);
      
      // 2. Create email template
      const emailTemplate = EmailTemplates.dailySchedule(scheduleData);
      
      // 3. Get recipients
      const recipients = await this.emailService.getScheduleRecipients();
      
      if (recipients.length === 0) {
        console.warn('No recipients configured for daily schedule email');
        return false;
      }
      
      // 4. Send email
      const success = await this.emailService.sendEmail(recipients, emailTemplate, {
        category: 'daily_schedule',
        priority: 'normal'
      });
      
      // 5. Log result
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.DAILY_ASSIGNMENTS_UPDATED,
        description: `Daily schedule email for ${date} ${success ? 'sent' : 'failed'}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          date,
          recipients: recipients.map((r: { email: string }) => r.email),
          appointmentCount: scheduleData.appointments.length,
          conflictCount: scheduleData.conflicts.length,
          success
        })
      });
      
      return success;
    } catch (error) {
      console.error('Error generating and sending daily report:', error);
      
      // Log error to audit system
      await this.sheetsService.addAuditLog({
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
   * Refresh appointments from IntakeQ
   */
  async refreshAppointmentsFromIntakeQ(targetDate?: string): Promise<boolean> {
    try {
      // Use today's date if no target date provided
      const date = targetDate || new Date().toISOString().split('T')[0];
      console.log(`Refreshing appointments from IntakeQ for ${date}`);
      
      // Call the refresh function
      const count = await this.dailyScheduleService.refreshAppointmentsFromIntakeQ(date);
      
      // Log result
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.DAILY_ASSIGNMENTS_UPDATED,
        description: `IntakeQ appointment refresh for ${date} completed`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          date,
          appointmentsProcessed: count,
          success: true
        })
      });
      
      return true;
    } catch (error) {
      console.error('Error refreshing appointments from IntakeQ:', error);
      
      // Log error to audit system
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Failed to refresh appointments from IntakeQ',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Try to send error notification
      try {
        const errorTemplate = EmailTemplates.errorNotification(
          error instanceof Error ? error : new Error('Unknown error'),
          'IntakeQ Appointment Refresh',
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
   * Bulk import appointments from IntakeQ for a date range
   */
  async bulkImportAppointments(
    startDate: string = new Date().toISOString().split('T')[0],
    endDate?: string
  ): Promise<{
    success: boolean;
    processed: number;
    errors: number;
    dates: string[];
  }> {
    try {
      // If no end date provided, default to 6 months in the future
      if (!endDate) {
        const futureDate = new Date(startDate);
        futureDate.setMonth(futureDate.getMonth() + 6);
        endDate = futureDate.toISOString().split('T')[0];
      }
      
      console.log(`Starting bulk import from ${startDate} to ${endDate}`);
      
      // Log the start of bulk import
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: `Starting bulk import from ${startDate} to ${endDate}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({ startDate, endDate })
      });
      
      // Generate all dates in the range
      const dates = this.generateDateRange(startDate, endDate);
      console.log(`Processing ${dates.length} days of appointments`);
      
      let totalProcessed = 0;
      let totalErrors = 0;
      const processedDates: string[] = [];
      
      // Process each date
      for (const date of dates) {
        try {
          console.log(`Processing appointments for ${date}`);
          
          // Use the existing refresh function to process each date
          const processed = await this.dailyScheduleService.refreshAppointmentsFromIntakeQ(date);
          
          if (processed > 0) {
            totalProcessed += processed;
            processedDates.push(date);
          }
          
          // Small delay to avoid API rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`Error processing date ${date}:`, error);
          totalErrors++;
          
          // Log error but continue with other dates
          await this.sheetsService.addAuditLog({
            timestamp: new Date().toISOString(),
            eventType: AuditEventType.SYSTEM_ERROR,
            description: `Failed to process appointments for ${date} during bulk import`,
            user: 'SYSTEM',
            systemNotes: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
      
      // Log completion
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: `Completed bulk import from ${startDate} to ${endDate}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          totalProcessed,
          totalErrors,
          processedDates
        })
      });
      
      return {
        success: true,
        processed: totalProcessed,
        errors: totalErrors,
        dates: processedDates
      };
    } catch (error) {
      console.error('Error in bulk import:', error);
      
      // Log overall error
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: `Bulk import failed`,
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
   * Stop all scheduled tasks
   */
  stop(): void {
    console.log('Stopping scheduler service');
    this.scheduledTasks.forEach(task => task.stop());
    this.scheduledTasks = [];
  }
}

export default SchedulerService;