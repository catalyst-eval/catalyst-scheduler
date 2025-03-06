// src/lib/scheduling/appointment-window-manager.ts

import { GoogleSheetsService, AuditEventType } from '../google/sheets';
import { IntakeQService } from '../intakeq/service';
import { AppointmentSyncHandler } from '../intakeq/appointment-sync';
import { getTodayEST, getESTDayRange } from '../util/date-helpers';
import { WebhookEventType } from '../../types/webhooks';

export class AppointmentWindowManager {
  private intakeQService: IntakeQService;
  private appointmentSyncHandler: AppointmentSyncHandler;

  constructor(
    private readonly sheetsService: GoogleSheetsService
  ) {
    this.intakeQService = new IntakeQService(this.sheetsService);
    this.appointmentSyncHandler = new AppointmentSyncHandler(
      this.sheetsService, 
      this.intakeQService
    );
  }

  /**
   * Maintain a rolling two-week appointment window
   */
  // Modify src/lib/scheduling/appointment-window-manager.ts
async maintainAppointmentWindow(pastDays: number = 0): Promise<{
    removed: number;
    errors: number;
  }> {
    try {
      console.log(`Maintaining appointment window: removing appointments older than ${pastDays} days`);
      
      // Log start of maintenance
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: 'Starting appointment window maintenance',
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          pastDays
        })
      });
      
      // Clear appointments older than pastDays
      const removedCount = await this.removeOldAppointments(pastDays);
      
      // Log completion
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: 'Completed appointment window maintenance',
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          removed: removedCount,
          errors: 0
        })
      });
      
      return { 
        removed: removedCount, 
        errors: 0 
      };
    } catch (error) {
      console.error('Error maintaining appointment window:', error);
      
      // Log error
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Error maintaining appointment window',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      throw error;
    }
  }

  /**
   * Refresh the two-week appointment window
   * Maintains appointments within a specific window: past X days to future Y days
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
      await this.sheetsService.addAuditLog({
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
      
      // 4. Archive and remove appointments outside the window
      let removedCount = 0;
      let errorCount = 0;
      
      for (const { appointment, reason } of outsideWindow) {
        try {
          // Archive in audit log
          await this.sheetsService.addAuditLog({
            timestamp: new Date().toISOString(),
            eventType: AuditEventType.APPOINTMENT_DELETED,
            description: `Removed appointment ${appointment.appointmentId} (window maintenance: ${reason})`,
            user: 'SYSTEM',
            systemNotes: JSON.stringify(appointment)
          });
          
          // Delete from sheet
          await this.sheetsService.deleteAppointment(appointment.appointmentId);
          removedCount++;
        } catch (error) {
          console.error(`Error removing appointment ${appointment.appointmentId}:`, error);
          errorCount++;
        }
      }
      
      // 5. Log completion
      await this.sheetsService.addAuditLog({
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
      
      // Log error
      await this.sheetsService.addAuditLog({
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
   * Remove appointments older than specified days
   */
  private async removeOldAppointments(pastDays: number): Promise<number> {
    try {
      // Get current date
      const today = getTodayEST();
      
      // Calculate cutoff date
      const cutoffDate = new Date(today);
      cutoffDate.setDate(cutoffDate.getDate() - pastDays);
      const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
      
      console.log(`Removing appointments before ${cutoffDateStr}`);
      
      // Get all appointments
      const appointments = await this.sheetsService.getAllAppointments();
      
      // Find appointments older than cutoff
      const oldAppointments = appointments.filter(appt => {
        const apptDate = new Date(appt.startTime).toISOString().split('T')[0];
        return apptDate < cutoffDateStr;
      });
      
      console.log(`Found ${oldAppointments.length} appointments to remove`);
      
      // Archive and delete each appointment
      let removedCount = 0;
      
      for (const appt of oldAppointments) {
        try {
          // Archive in audit log
          await this.sheetsService.addAuditLog({
            timestamp: new Date().toISOString(),
            eventType: AuditEventType.APPOINTMENT_DELETED,
            description: `Removed old appointment ${appt.appointmentId} (window maintenance)`,
            user: 'SYSTEM',
            systemNotes: JSON.stringify(appt)
          });
          
          // Delete from sheet
          await this.sheetsService.deleteAppointment(appt.appointmentId);
          removedCount++;
        } catch (deleteError) {
          console.error(`Error deleting appointment ${appt.appointmentId}:`, deleteError);
        }
      }
      
      return removedCount;
    } catch (error) {
      console.error('Error removing old appointments:', error);
      throw error;
    }
  }

  /**
   * Populate appointments for the future window
   */
  private async populateFutureAppointments(futureDays: number): Promise<{
    added: number;
    errors: number;
  }> {
    try {
      // Get current date and end date for window
      const today = getTodayEST();
      const todayDate = new Date(today);
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + futureDays);
      const endDateStr = endDate.toISOString().split('T')[0];
      
      console.log(`Populating appointments from ${today} to ${endDateStr}`);
      
      let added = 0;
      let errors = 0;
      
      // Iterate one day at a time to avoid API issues
      const currentDate = new Date(todayDate);
      
      while (currentDate <= endDate) {
        try {
          const dateStr = currentDate.toISOString().split('T')[0];
          console.log(`Processing appointments for ${dateStr}`);
          
          // Fetch appointments for this day
          const appointments = await this.intakeQService.getAppointments(
            dateStr,
            dateStr,
            'Confirmed,WaitingConfirmation,Pending'
          );
          
          if (appointments.length > 0) {
            console.log(`Found ${appointments.length} appointments for ${dateStr}`);
            
            // Process each appointment
            for (const appt of appointments) {
              try {
                // Check if appointment already exists
                const existingAppointment = await this.sheetsService.getAppointment(appt.Id);
                
                if (!existingAppointment) {
                  // Create webhook-like payload
                  const payload = {
                    EventType: 'AppointmentCreated' as WebhookEventType,
                    ClientId: appt.ClientId,
                    Appointment: appt
                  };
                  
                  // Process the appointment
                  const result = await this.appointmentSyncHandler.processAppointmentEvent(payload);
                  
                  if (result.success) {
                    added++;
                  } else {
                    console.error(`Error processing appointment ${appt.Id}:`, result.error);
                    errors++;
                  }
                }
              } catch (apptError) {
                console.error(`Error processing appointment ${appt.Id}:`, apptError);
                errors++;
              }
            }
          } else {
            console.log(`No appointments found for ${dateStr}`);
          }
        } catch (dayError) {
          console.error(`Error processing appointments for ${currentDate.toISOString().split('T')[0]}:`, dayError);
          errors++;
        }
        
        // Move to next day
        currentDate.setDate(currentDate.getDate() + 1);
        
        // Add small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      return { added, errors };
    } catch (error) {
      console.error('Error populating future appointments:', error);
      throw error;
    }
  }
}