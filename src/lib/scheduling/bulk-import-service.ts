// src/lib/scheduling/bulk-import-service.ts

import { GoogleSheetsService, AuditEventType } from '../google/sheets';
import { IntakeQService } from '../intakeq/service';
import { AppointmentSyncHandler } from '../intakeq/appointment-sync';
import { WebhookEventType } from '../../types/webhooks';
import { getTodayEST, getESTDayRange } from '../util/date-helpers';
import { logger } from '../util/logger';
// Import Papa Parse properly
import Papa from 'papaparse';

/**
 * Helper function to generate a date range
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
 * Safely handle errors for logging
 */
function handleError(error: unknown): { message: string, details?: any } {
  if (error instanceof Error) {
    return {
      message: error.message,
      details: error.stack
    };
  } else if (typeof error === 'string') {
    return {
      message: error
    };
  } else if (error && typeof error === 'object') {
    return {
      message: String(error),
      details: error
    };
  } else {
    return {
      message: 'Unknown error'
    };
  }
}

/**
 * Interface for bulk import results
 */
export interface BulkImportResult {
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
 * Configuration options for bulk import operations
 */
export interface BulkImportConfig {
  startDate?: string;
  endDate?: string;
  keepPastDays?: number;
  keepFutureDays?: number;
  cleanupAfterImport?: boolean;
  processAllDates?: boolean;
  statusFilter?: string;
  source?: string;
}

/**
 * Consolidated service for all bulk import functionality
 * Combines previous implementations from:
 * - enhanced-bulk-import.ts
 * - appointment-window-manager.ts:importAllFutureAppointments
 * - manual-import-appointments.ts
 */
export class BulkImportService {
  private sheetsService: GoogleSheetsService;
  private intakeQService: IntakeQService;
  private appointmentSyncHandler: AppointmentSyncHandler;

  constructor(
    sheetsService?: GoogleSheetsService,
    intakeQService?: IntakeQService,
    appointmentSyncHandler?: AppointmentSyncHandler
  ) {
    this.sheetsService = sheetsService || new GoogleSheetsService();
    this.intakeQService = intakeQService || new IntakeQService(this.sheetsService);
    this.appointmentSyncHandler = appointmentSyncHandler || new AppointmentSyncHandler(this.sheetsService, this.intakeQService);
  }

  /**
   * Main bulk import method with flexible configuration
   * Unified entry point for all import scenarios
   */
  async runBulkImport(config: BulkImportConfig = {}): Promise<BulkImportResult> {
    try {
      // Set default values
      const keepPastDays = config.keepPastDays || 7;
      const keepFutureDays = config.keepFutureDays || 14;
      const cleanupAfterImport = config.cleanupAfterImport !== false;
      const statusFilter = config.statusFilter || 'Confirmed,WaitingConfirmation,Pending';
      
      // Calculate default date range if not provided
      const now = new Date();
      const defaultStart = new Date(now);
      defaultStart.setDate(defaultStart.getDate() - keepPastDays);
      const startDate = config.startDate || defaultStart.toISOString().split('T')[0];
      
      const defaultEnd = new Date(now);
      defaultEnd.setDate(defaultEnd.getDate() + keepFutureDays);
      const endDate = config.endDate || defaultEnd.toISOString().split('T')[0];
      
      logger.info(`Starting bulk import from ${startDate} to ${endDate}`, {
        keepPastDays,
        keepFutureDays,
        cleanupAfterImport,
        source: config.source || 'manual'
      });
      
      // Log the start of bulk import
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'INTEGRATION_UPDATED' as AuditEventType,
        description: `Starting bulk import from ${startDate} to ${endDate}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({ 
          startDate, 
          endDate,
          keepPastDays,
          keepFutureDays,
          source: config.source || 'manual'
        })
      });
      
      // Generate all dates in the range
      const dates = generateDateRange(startDate, endDate);
      logger.info(`Processing ${dates.length} days of appointments`);
      
      let totalProcessed = 0;
      let totalErrors = 0;
      const processedDates: string[] = [];
      
      // Process each date
      for (const date of dates) {
        try {
          logger.info(`Processing appointments for ${date}`);
          
          // Get appointments from IntakeQ for this date
          const appointments = await this.intakeQService.getAppointments(date, date, statusFilter);
          
          logger.info(`Found ${appointments.length} appointments for ${date}`);
          
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
              
              // Check if appointment already exists
              const existingAppointment = await this.sheetsService.getAppointment(appointment.Id);
              
              // Only process if appointment doesn't exist or we're set to process all dates
              if (!existingAppointment || config.processAllDates) {
                // Use existing appointment processing logic
                const result = await this.appointmentSyncHandler.processAppointmentEvent(payload);
                
                if (result.success) {
                  dateProcessed++;
                } else {
                  const errorInfo = handleError(result.error);
                  logger.error(`Error processing appointment ${appointment.Id}:`, errorInfo);
                  dateErrors++;
                }
              } else {
                logger.info(`Skipping existing appointment ${appointment.Id}`);
              }
            } catch (apptError) {
              const errorInfo = handleError(apptError);
              logger.error(`Error processing appointment ${appointment.Id}:`, errorInfo);
              dateErrors++;
            }
          }
          
          logger.info(`Processed ${dateProcessed} appointments with ${dateErrors} errors for ${date}`);
          
          totalProcessed += dateProcessed;
          totalErrors += dateErrors;
          
          if (dateProcessed > 0) {
            processedDates.push(date);
          }
        } catch (dateError) {
          const errorInfo = handleError(dateError);
          logger.error(`Error processing date ${date}:`, errorInfo);
          totalErrors++;
          
          // Log error but continue with next date
          await this.sheetsService.addAuditLog({
            timestamp: new Date().toISOString(),
            eventType: 'SYSTEM_ERROR' as AuditEventType,
            description: `Failed to process appointments for ${date} during bulk import`,
            user: 'SYSTEM',
            systemNotes: errorInfo.message
          });
          
          // Skip to next date rather than failing entire import
          continue;
        }
        
        // Small delay to avoid API rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Perform cleanup to maintain the rolling window if requested
      let cleanupResults;
      if (cleanupAfterImport) {
        logger.info("Performing cleanup to maintain rolling window of appointments");
        cleanupResults = await this.cleanupOutsideWindow(keepPastDays, keepFutureDays);
      }
      
      // Log completion
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'INTEGRATION_UPDATED' as AuditEventType,
        description: `Completed bulk import from ${startDate} to ${endDate}`,
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
      const errorInfo = handleError(error);
      logger.error('Error in bulk import:', errorInfo);
      throw error;
    }
  }

  /**
   * Import a single day of appointments
   */
  async importSingleDay(targetDate: string, statusFilter: string = 'Confirmed,WaitingConfirmation,Pending'): Promise<{
    success: boolean;
    date: string;
    processed: number;
    errors: number;
  }> {
    try {
      logger.info(`Importing appointments for single day: ${targetDate}`);
      
      // Log start of import
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'INTEGRATION_UPDATED' as AuditEventType,
        description: `Starting single-day import for ${targetDate}`,
        user: 'SYSTEM'
      });
      
      // Get appointments for this date from IntakeQ
      const appointments = await this.intakeQService.getAppointments(targetDate, targetDate, statusFilter);
      
      // Track results
      let processed = 0;
      let errors = 0;
      
      // Process appointments if found
      if (appointments.length > 0) {
        logger.info(`Found ${appointments.length} appointments for ${targetDate}`);
        
        // Process each appointment
        for (const appointment of appointments) {
          try {
            // Check if appointment already exists
            const existingAppointment = await this.sheetsService.getAppointment(appointment.Id);
            
            if (!existingAppointment) {
              // Format as webhook payload
              const payload = {
                EventType: 'AppointmentCreated' as WebhookEventType,
                ClientId: appointment.ClientId,
                Appointment: appointment
              };
              
              // Process through appointment sync handler
              const result = await this.appointmentSyncHandler.processAppointmentEvent(payload);
              
              if (result.success) {
                processed++;
                logger.info(`Successfully imported appointment ${appointment.Id} for ${targetDate}`);
              } else {
                const errorInfo = handleError(result.error);
                logger.error(`Failed to process appointment ${appointment.Id}:`, errorInfo);
                errors++;
              }
            } else {
              logger.info(`Appointment ${appointment.Id} already exists, skipping`);
            }
          } catch (apptError) {
            const errorInfo = handleError(apptError);
            logger.error(`Error processing appointment ${appointment.Id}:`, errorInfo);
            errors++;
          }
        }
      } else {
        logger.info(`No appointments found for ${targetDate}`);
      }
      
      // Log completion
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'INTEGRATION_UPDATED' as AuditEventType,
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
      const errorInfo = handleError(error);
      logger.error(`Error importing appointments for day ${targetDate}:`, errorInfo);
      
      // Log error
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'SYSTEM_ERROR' as AuditEventType,
        description: `Error importing appointments for day ${targetDate}`,
        user: 'SYSTEM',
        systemNotes: errorInfo.message
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
   * Import appointments from a CSV file
   */
  async importFromCSV(csvData: string, options: {
    dateColumn?: string;
    clientIdColumn?: string;
    clinicianColumn?: string;
    dryRun?: boolean;
  } = {}): Promise<{
    success: boolean;
    processed: number;
    skipped: number;
    errors: number;
    samples?: any[];
  }> {
    try {
      logger.info('Starting import from CSV data');
      
      // Parse CSV data using properly imported Papa Parse
      const parseResult = Papa.parse(csvData, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true
      });
      
      logger.info(`Parsed ${parseResult.data.length} rows from CSV`);
      
      // Process statistics
      let imported = 0;
      let skipped = 0;
      let errors = 0;
      const samples: any[] = [];
      
      // Process each row - using proper type casting
      for (const rowData of parseResult.data) {
        try {
          // Safely cast row to an object we can work with
          const row = rowData as Record<string, any>;
          
          // Skip rows with no date or obvious placeholders
          if (!row[options.dateColumn || 'Date'] || row.Status === 'Placeholder') {
            skipped++;
            continue;
          }
          
          // Convert CSV row to IntakeQ appointment format
          const appointment = await this.convertRowToAppointment(row);
          
          if (options.dryRun) {
            // Just track the sample data without importing
            if (samples.length < 5) {
              samples.push(appointment);
            }
            imported++;
            continue;
          }
            
          const existingAppointment = await this.sheetsService.getAppointment(appointment.Id);
            
          if (!existingAppointment) {
            // Format as webhook payload with proper typing
            const payload = {
              EventType: 'AppointmentCreated' as WebhookEventType,
              ClientId: appointment.ClientId,
              Appointment: appointment
            };
            
            // Process the appointment
            const result = await this.appointmentSyncHandler.processAppointmentEvent(payload);
            
            if (result.success) {
              imported++;
              logger.info(`Successfully imported appointment ${appointment.Id}`);
            } else {
              const errorInfo = handleError(result.error);
              logger.error(`Error processing appointment ${appointment.Id}:`, errorInfo);
              errors++;
            }
          } else {
            logger.info(`Appointment ${appointment.Id} already exists, skipping`);
            skipped++;
          }
        } catch (error) {
          const errorInfo = handleError(error);
          logger.error(`Error importing row:`, errorInfo);
          errors++;
        }
      }
      
      // Log final results
      logger.info(`Import complete: ${imported} imported, ${skipped} skipped, ${errors} errors`);
      
      // Log import in audit
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'INTEGRATION_UPDATED' as AuditEventType,
        description: `Completed CSV import`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          imported,
          skipped,
          errors,
          totalRows: parseResult.data.length,
          dryRun: options.dryRun
        })
      });
      
      return { 
        success: true,
        processed: imported, 
        skipped, 
        errors,
        samples: options.dryRun ? samples : undefined
      };
    } catch (error) {
      const errorInfo = handleError(error);
      logger.error('CSV import error:', errorInfo);
      throw error;
    }
  }

  /**
   * Convert CSV row to IntakeQ appointment format
   */
  private async convertRowToAppointment(row: Record<string, any>): Promise<any> {
    // This is a simplified version - in actual implementation, this would be
    // a more robust mapping based on the row structure
    
    // 1. Parse the date
    let startDate: Date;
    try {
      startDate = new Date(row.Date);
      if (isNaN(startDate.getTime())) {
        throw new Error('Invalid date format');
      }
    } catch (error) {
      logger.warn(`Invalid date format: ${row.Date}, using current date`);
      startDate = new Date();
    }
    
    // 2. Calculate end time based on duration
    const duration = parseInt(row.Duration?.toString() || '60'); // Default to 60 minutes
    const endDate = new Date(startDate.getTime() + duration * 60000);
    
    // 3. Create a unique ID or use existing
    const appointmentId = row.Id || `csv-import-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    // 4. Extract client ID
    let clientId = 0;
    if (row.ClientId) {
      clientId = typeof row.ClientId === 'number' ? row.ClientId : parseInt(row.ClientId.toString());
    }
    
    // 5. Determine session type from service name
    const serviceName = row.Service || 'Therapy Session';
    let sessionType = 'in-person';
    
    if (serviceName.toLowerCase().includes('family') || serviceName.toLowerCase().includes('couple')) {
      sessionType = 'family';
    } else if (serviceName.toLowerCase().includes('group')) {
      sessionType = 'group';
    } else if (
      serviceName.toLowerCase().includes('tele') || 
      serviceName.toLowerCase().includes('virtual') ||
      serviceName.toLowerCase().includes('online') ||
      serviceName.toLowerCase().includes('remote')
    ) {
      sessionType = 'telehealth';
    }
    
    // 6. Map practitioner name to ID
    let practitionerId = '';
    const practitionerName = row.Practitioner || '';
    
    if (practitionerName) {
      // Look for matching clinician
      const clinicians = await this.sheetsService.getClinicians();
      const matchingClinician = clinicians.find(c => 
        c.name.toLowerCase() === practitionerName.toLowerCase() ||
        practitionerName.toLowerCase().includes(c.name.toLowerCase()) ||
        c.name.toLowerCase().includes(practitionerName.toLowerCase())
      );
      
      if (matchingClinician) {
        practitionerId = matchingClinician.intakeQPractitionerId || matchingClinician.clinicianId;
      } else {
        logger.warn(`No matching clinician found for "${practitionerName}"`);
      }
    }
    
    // 7. Handle client name components
    const clientName = row.ClientName || `${row.FirstName || ''} ${row.LastName || ''}`.trim();
    const clientFirstName = row.FirstName || clientName.split(' ')[0] || '';
    const clientLastName = row.LastName || (clientName.split(' ').length > 1 ? clientName.split(' ').slice(1).join(' ') : '');
    
    // 8. Format dates for display
    const startDateLocal = startDate.toLocaleString();
    const endDateLocal = endDate.toLocaleString();
    
    // 9. Return the formatted appointment object
    return {
      Id: appointmentId,
      ClientName: clientName,
      ClientFirstName: clientFirstName,
      ClientLastName: clientLastName,
      ClientId: clientId,
      ClientEmail: row.Email || '',
      ClientPhone: row.Phone || '',
      ClientDateOfBirth: row.ClientDOB || '',
      Status: row.Status || 'Confirmed',
      StartDate: startDate.getTime(),
      EndDate: endDate.getTime(),
      Duration: duration,
      ServiceName: serviceName,
      ServiceId: '1', // Default ServiceId
      LocationName: row.Location || 'Main Office',
      LocationId: '1', // Default LocationId
      Price: parseFloat(row.Price?.toString() || '0'),
      PractitionerName: practitionerName,
      PractitionerEmail: '', // Not available in CSV
      PractitionerId: practitionerId,
      DateCreated: new Date().getTime(),
      CreatedBy: 'CSV Import',
      BookedByClient: row.BookedByClient === 'Yes',
      StartDateIso: startDate.toISOString(),
      EndDateIso: endDate.toISOString(),
      IntakeId: null,
      StartDateLocal: startDateLocal,
      EndDateLocal: endDateLocal,
      StartDateLocalFormatted: startDateLocal
    };
  }

  /**
   * Run default window import (convenience method)
   */
  async runDefaultWindowImport(): Promise<BulkImportResult> {
    return this.runBulkImport({
      keepPastDays: 7,
      keepFutureDays: 14,
      cleanupAfterImport: true,
      source: 'default_window'
    });
  }

  /**
   * Clean up appointments outside the rolling window
   */
  async cleanupOutsideWindow(
    pastDays: number,
    futureDays: number
  ): Promise<{
    outsideWindow: number;
    archived: number;
    deleted: number;
    errors: number;
  }> {
    try {
      logger.info(`Cleaning up appointments outside window: past ${pastDays} days, future ${futureDays} days`);
      
      // Get all appointments
      const allAppointments = await this.sheetsService.getAllAppointments();
      
      // Calculate window boundaries
      const now = new Date();
      const pastBoundary = new Date(now);
      pastBoundary.setDate(now.getDate() - pastDays);
      pastBoundary.setHours(0, 0, 0, 0); // Start of day
      
      const futureBoundary = new Date(now);
      futureBoundary.setDate(now.getDate() + futureDays);
      futureBoundary.setHours(23, 59, 59, 999); // End of day
      
      logger.info(`Window boundaries: ${pastBoundary.toISOString()} to ${futureBoundary.toISOString()}`);
      
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
      
      logger.info(`Found ${outsideWindow.length} appointments outside the window`);
      
      // Archive and delete appointments
      let archivedCount = 0;
      let deletedCount = 0;
      let errorCount = 0;
      
      for (const appt of outsideWindow) {
        try {
          // Archive in audit log before deleting
          await this.sheetsService.addAuditLog({
            timestamp: new Date().toISOString(),
            eventType: 'APPOINTMENT_DELETED' as AuditEventType,
            description: `Archived appointment ${appt.appointmentId} (window maintenance)`,
            user: 'SYSTEM',
            systemNotes: JSON.stringify(appt)
          });
          archivedCount++;
          
          // Delete from appointments sheet
          await this.sheetsService.deleteAppointment(appt.appointmentId);
          deletedCount++;
          
        } catch (error) {
          errorCount++;
          const errorInfo = handleError(error);
          logger.error(`Error processing appointment ${appt.appointmentId}:`, errorInfo);
        }
      }
      
      logger.info(`Cleanup complete: ${archivedCount} archived, ${deletedCount} deleted, ${errorCount} errors`);
      
      return {
        outsideWindow: outsideWindow.length,
        archived: archivedCount,
        deleted: deletedCount,
        errors: errorCount
      };
    } catch (error) {
      const errorInfo = handleError(error);
      logger.error('Error cleaning up appointments outside window:', errorInfo);
      throw error;
    }
  }
}