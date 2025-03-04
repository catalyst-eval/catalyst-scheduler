// src/lib/scheduling/enhanced-bulk-import.ts

import { GoogleSheetsService, AuditEventType } from '../google/sheets';
import { IntakeQService } from '../intakeq/service';
import { AppointmentSyncHandler } from '../intakeq/appointment-sync';
import { WebhookEventType } from '../../types/webhooks';

interface BulkImportResult {
  success: boolean;
  processed: number;
  errors: number;
  dates: string[];
  cleanupResults?: {
    outsideWindow: number;
    archived: number;
    deleted: number;
    errors: number;
  };
}

/**
 * Enhanced bulk import that maintains a rolling window of appointments
 */
export async function enhancedBulkImport(
  dateRangeConfig: {
    startDate?: string,  // If undefined, uses today
    endDate?: string,    // If undefined, uses startDate + futureDays
    keepPastDays?: number, // Default 7
    keepFutureDays?: number, // Default 14
  } = {}
): Promise<BulkImportResult> {
  try {
    // Initialize services
    const sheetsService = new GoogleSheetsService();
    const intakeQService = new IntakeQService(sheetsService);
    const syncHandler = new AppointmentSyncHandler(sheetsService, intakeQService);
    
    // Set default values
    const keepPastDays = dateRangeConfig.keepPastDays || 7;
    const keepFutureDays = dateRangeConfig.keepFutureDays || 14;
    
    // Calculate start date (default: today - keepPastDays)
    const now = new Date();
    const defaultStart = new Date(now);
    defaultStart.setDate(defaultStart.getDate() - keepPastDays);
    const startDate = dateRangeConfig.startDate || defaultStart.toISOString().split('T')[0];
    
    // Calculate end date (default: today + keepFutureDays)
    const defaultEnd = new Date(now);
    defaultEnd.setDate(defaultEnd.getDate() + keepFutureDays);
    const endDate = dateRangeConfig.endDate || defaultEnd.toISOString().split('T')[0];
    
    console.log(`Enhanced bulk import from ${startDate} to ${endDate}`);
    console.log(`Maintaining window: past ${keepPastDays} days, future ${keepFutureDays} days`);
    
    // Log the start of bulk import
    await sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'INTEGRATION_UPDATED' as AuditEventType,
      description: `Starting enhanced bulk import from ${startDate} to ${endDate}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({ 
        startDate, 
        endDate,
        keepPastDays,
        keepFutureDays
      })
    });
    
    // Generate all dates in the range
    const dates = generateDateRange(startDate, endDate);
    console.log(`Processing ${dates.length} days of appointments`);
    
    let totalProcessed = 0;
    let totalErrors = 0;
    const processedDates: string[] = [];
    
    // Process each date
    // Process each date
for (const date of dates) {
    try {
      console.log(`Processing appointments for ${date}`);
      
      // Get appointments from IntakeQ for this date
      try {
        const appointments = await intakeQService.getAppointments(
          date, 
          date, 
          'Confirmed,WaitingConfirmation,Pending'
        );
        
        console.log(`Found ${appointments.length} appointments for ${date}`);
        
        // Process each appointment
        let dateProcessed = 0;
        let dateErrors = 0;
        
        for (const appointment of appointments) {
          try {
            // Convert to webhook payload format for processing with existing logic
            const payload = {
              EventType: 'AppointmentCreated' as WebhookEventType,
              ClientId: appointment.ClientId,
              Appointment: appointment
            };
            
            // Use existing appointment processing logic
            const result = await syncHandler.processAppointmentEvent(payload);
            
            if (result.success) {
              dateProcessed++;
            } else {
              console.error(`Error processing appointment ${appointment.Id}:`, result.error);
              dateErrors++;
            }
          } catch (apptError: unknown) {
            const errorMessage = apptError instanceof Error ? apptError.message : 'Unknown error';
            console.error(`Error processing appointment ${appointment.Id}:`, errorMessage);
            dateErrors++;
          }
        }
        
        console.log(`Processed ${dateProcessed} appointments with ${dateErrors} errors for ${date}`);
        
        totalProcessed += dateProcessed;
        totalErrors += dateErrors;
        
        if (dateProcessed > 0) {
          processedDates.push(date);
        }
      } catch (dateError: unknown) {
        const errorMessage = dateError instanceof Error ? dateError.message : 'Unknown error';
        console.error(`Error fetching appointments for ${date}:`, errorMessage);
        totalErrors++;
        
        // Log error but continue with next date
        await sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'SYSTEM_ERROR' as AuditEventType,
          description: `Failed to fetch appointments for ${date} during bulk import`,
          user: 'SYSTEM',
          systemNotes: errorMessage
        });
        
        // Skip to next date rather than failing entire import
        continue;
      }
      
      // Small delay to avoid API rate limits
      await new Promise(resolve => setTimeout(resolve, 1000)); // Increased delay
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error processing date ${date}:`, errorMessage);
      totalErrors++;
      
      // Log error but continue with other dates
      await sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'SYSTEM_ERROR' as AuditEventType,
        description: `Failed to process appointments for ${date} during bulk import`,
        user: 'SYSTEM',
        systemNotes: errorMessage
      });
    }
  }
    
    // Now perform cleanup to maintain the rolling window
    console.log("Performing cleanup to maintain rolling window of appointments");
    const cleanupResults = await cleanupOutsideWindow(sheetsService, keepPastDays, keepFutureDays);
    
    // Log completion
    await sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'INTEGRATION_UPDATED' as AuditEventType,
      description: `Completed enhanced bulk import from ${startDate} to ${endDate}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        totalProcessed,
        totalErrors,
        processedDates,
        cleanupResults
      })
    });
    
    return {
      success: true,
      processed: totalProcessed,
      errors: totalErrors,
      dates: processedDates,
      cleanupResults
    };
  } catch (error) {
    console.error('Error in enhanced bulk import:', error);
    throw error;
  }
}

/**
 * Clean up appointments outside the rolling window
 */
async function cleanupOutsideWindow(
  sheetsService: GoogleSheetsService,
  pastDays: number,
  futureDays: number
): Promise<{
  outsideWindow: number;
  archived: number;
  deleted: number;
  errors: number;
}> {
  try {
    console.log(`Cleaning up appointments outside window: past ${pastDays} days, future ${futureDays} days`);
    
    // Get all appointments
    const allAppointments = await sheetsService.getAllAppointments();
    
    // Calculate window boundaries
    const now = new Date();
    const pastBoundary = new Date(now);
    pastBoundary.setDate(now.getDate() - pastDays);
    pastBoundary.setHours(0, 0, 0, 0); // Start of day
    
    const futureBoundary = new Date(now);
    futureBoundary.setDate(now.getDate() + futureDays);
    futureBoundary.setHours(23, 59, 59, 999); // End of day
    
    console.log(`Window boundaries: ${pastBoundary.toISOString()} to ${futureBoundary.toISOString()}`);
    
    // Find appointments outside the window
    const outsideWindow = allAppointments.filter(appt => {
      try {
        const apptDate = new Date(appt.startTime);
        return apptDate < pastBoundary || apptDate > futureBoundary;
      } catch (e) {
        // If date parsing fails, include it for review
        return true;
      }
    });
    
    console.log(`Found ${outsideWindow.length} appointments outside the window`);
    
    // Archive and delete appointments
    let archivedCount = 0;
    let deletedCount = 0;
    let errorCount = 0;
    
    for (const appt of outsideWindow) {
      try {
        // Archive in audit log before deleting
        await sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'APPOINTMENT_DELETED' as AuditEventType,
          description: `Archived appointment ${appt.appointmentId} (window maintenance)`,
          user: 'SYSTEM',
          systemNotes: JSON.stringify(appt)
        });
        archivedCount++;
        
        // Delete from appointments sheet
        await sheetsService.deleteAppointment(appt.appointmentId);
        deletedCount++;
        
      } catch (error) {
        errorCount++;
        console.error(`Error processing appointment ${appt.appointmentId}:`, error);
      }
    }
    
    console.log(`Cleanup complete: ${archivedCount} archived, ${deletedCount} deleted, ${errorCount} errors`);
    
    return {
      outsideWindow: outsideWindow.length,
      archived: archivedCount,
      deleted: deletedCount,
      errors: errorCount
    };
  } catch (error) {
    console.error('Error cleaning up appointments outside window:', error);
    throw error;
  }
}

/**
 * Generate an array of dates between startDate and endDate (inclusive)
 */
function generateDateRange(startDate: string, endDate: string): string[] {
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
 * Run enhanced bulk import for the default window (today +/- 14 days)
 */
export async function runDefaultWindowImport(): Promise<BulkImportResult> {
  return enhancedBulkImport({
    keepPastDays: 7,
    keepFutureDays: 14
  });
}