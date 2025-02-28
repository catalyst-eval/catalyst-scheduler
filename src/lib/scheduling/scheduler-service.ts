// src/lib/scheduling/scheduler-service.ts

import cron from 'node-cron';
import { DailyScheduleService } from './daily-schedule-service';
import { EmailService } from '../email/service';
import { EmailTemplates } from '../email/templates';
import { GoogleSheetsService, AuditEventType } from '../google/sheets';

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