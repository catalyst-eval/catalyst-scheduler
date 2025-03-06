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
   * Maintain appointment window
   */
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
   * Import all future appointments from IntakeQ
   * This is useful for initial setup or full refreshes
   */
  async importAllFutureAppointments(
    startDate?: string,
    endDate?: string
  ): Promise<{
    success: boolean;
    processed: number;
    errors: number;
  }> {
    try {
      // Default to today if no start date provided
      const today = getTodayEST();
      const useStartDate = startDate || today;
      
      // Default to 3 months in the future if no end date provided
      const threeMonthsLater = new Date(today);
      threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3);
      const useEndDate = endDate || threeMonthsLater.toISOString().split('T')[0];
      
      console.log(`Importing all future appointments from ${useStartDate} to ${useEndDate}`);
      
      // Log start of import
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: `Starting import of all future appointments from ${useStartDate} to ${useEndDate}`,
        user: 'SYSTEM'
      });
      
      // Generate all dates in the range
      const allDates = this.generateDateRange(useStartDate, useEndDate);
      console.log(`Processing ${allDates.length} days`);
      
      let totalProcessed = 0;
      let totalErrors = 0;
      
      // Process each date (one at a time to avoid rate limiting)
      for (const date of allDates) {
        try {
          console.log(`Processing appointments for ${date}`);
          
          // Get appointments for this date from IntakeQ
          const appointments = await this.intakeQService.getAppointments(date, date);
          
          if (appointments.length > 0) {
            console.log(`Found ${appointments.length} appointments for ${date}`);
            
            // Process each appointment
            for (const appt of appointments) {
              try {
                // Check if appointment already exists
                const existingAppointment = await this.sheetsService.getAppointment(appt.Id);
                
                if (!existingAppointment) {
                  // Format as webhook payload
                  const payload = {
                    Type: 'AppointmentCreated' as WebhookEventType,
                    ClientId: appt.ClientId,
                    Appointment: appt
                  };
                  
                  // Process through appointment sync handler
                  const result = await this.appointmentSyncHandler.processAppointmentEvent(payload);
                  
                  if (result.success) {
                    totalProcessed++;
                    console.log(`Successfully imported appointment ${appt.Id} for ${date}`);
                  } else {
                    console.error(`Failed to process appointment ${appt.Id}: ${result.error}`);
                    totalErrors++;
                  }
                } else {
                  console.log(`Appointment ${appt.Id} already exists, skipping`);
                }
              } catch (apptError) {
                console.error(`Error processing appointment ${appt.Id}:`, apptError);
                totalErrors++;
              }
            }
          } else {
            console.log(`No appointments found for ${date}`);
          }
        } catch (dateError) {
          console.error(`Error processing date ${date}:`, dateError);
          totalErrors++;
        }
        
        // Add delay between date processing to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Log completion
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: `Completed import of all future appointments`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          processed: totalProcessed,
          errors: totalErrors,
          dateRange: `${useStartDate} to ${useEndDate}`
        })
      });
      
      return {
        success: true,
        processed: totalProcessed,
        errors: totalErrors
      };
    } catch (error) {
      console.error('Error importing all future appointments:', error);
      
      // Log error
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Error importing all future appointments',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      return {
        success: false,
        processed: 0,
        errors: 1
      };
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
  
  async importSingleDay(
    targetDate: string
  ): Promise<{
    success: boolean;
    date: string;
    processed: number;
    errors: number;
  }> {
    try {
      console.log(`Importing appointments for single day: ${targetDate}`);
      
      // Log start of import
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: `Starting single-day import for ${targetDate}`,
        user: 'SYSTEM'
      });
      
      // Get appointments for this date from IntakeQ
      const appointments = await this.intakeQService.getAppointments(targetDate, targetDate);
      
      // Track results
      let processed = 0;
      let errors = 0;
      
      // Process appointments if found
      if (appointments.length > 0) {
        console.log(`Found ${appointments.length} appointments for ${targetDate}`);
        
        // Process each appointment
        for (const appt of appointments) {
          try {
            // Check if appointment already exists
            const existingAppointment = await this.sheetsService.getAppointment(appt.Id);
            
            if (!existingAppointment) {
              // Format as webhook payload
              const payload = {
                Type: 'AppointmentCreated' as WebhookEventType,
                ClientId: appt.ClientId,
                Appointment: appt
              };
              
              // Process through appointment sync handler
              const result = await this.appointmentSyncHandler.processAppointmentEvent(payload);
              
              if (result.success) {
                processed++;
                console.log(`Successfully imported appointment ${appt.Id} for ${targetDate}`);
              } else {
                console.error(`Failed to process appointment ${appt.Id}: ${result.error}`);
                errors++;
              }
            } else {
              console.log(`Appointment ${appt.Id} already exists, skipping`);
            }
          } catch (apptError) {
            console.error(`Error processing appointment ${appt.Id}:`, apptError);
            errors++;
          }
        }
      } else {
        console.log(`No appointments found for ${targetDate}`);
      }
      
      // Log completion
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: `Completed single-day import for ${targetDate}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          date: targetDate,
          processed,
          errors,
          appointmentsFound: appointments.length
        })
      });
      
      return {
        success: true,
        date: targetDate,
        processed,
        errors
      };
    } catch (error) {
      console.error(`Error importing appointments for day ${targetDate}:`, error);
      
      // Log error
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: `Error importing appointments for day ${targetDate}`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      return {
        success: false,
        date: targetDate,
        processed: 0,
        errors: 1
      };
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
      await this.sheetsService.addAuditLog({
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
      
      // Delete empty rows
      let removed = 0;
      let errors = 0;
      
      for (const rowIndex of emptyRowIndices) {
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
      
      // Log completion
      await this.sheetsService.addAuditLog({
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
      
      // Log error
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Error cleaning empty rows in appointments sheet',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      throw error;
    }
  }
}