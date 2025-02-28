// src/bulk-import.ts

import { GoogleSheetsService } from './lib/google/sheets';
import { IntakeQService } from './lib/intakeq/service';
import { AppointmentSyncHandler } from './lib/intakeq/appointment-sync';
import { WebhookEventType } from './types/webhooks';

async function bulkImportIntakeQAppointments() {
  try {
    // Initialize services
    const sheetsService = new GoogleSheetsService();
    const intakeQService = new IntakeQService(sheetsService);
    const syncHandler = new AppointmentSyncHandler(sheetsService, intakeQService);
    
    // Set date range (e.g., from today to 6 months ahead)
    const startDate = new Date().toISOString();
    const endDate = new Date(Date.now() + 6 * 30 * 24 * 60 * 60 * 1000).toISOString();
    
    console.log(`Fetching appointments from ${startDate} to ${endDate}`);
    
    // Get appointments from IntakeQ
    const appointments = await intakeQService.getAppointments(startDate, endDate, 'Confirmed,WaitingConfirmation');
    
    console.log(`Found ${appointments.length} appointments in IntakeQ`);
    
    // Process each appointment
    let processedCount = 0;
    for (const appointment of appointments) {
      try {
        // Convert to webhook payload format for processing with existing logic
        const payload = {
          EventType: 'AppointmentCreated' as WebhookEventType,
          ClientId: appointment.ClientId,
          Appointment: appointment
        };
        
        // Use existing appointment processing logic
        await syncHandler.processAppointmentEvent(payload);
        processedCount++;
        
        // Log progress
        if (processedCount % 10 === 0) {
          console.log(`Processed ${processedCount} of ${appointments.length} appointments`);
        }
      } catch (apptError) {
        console.error(`Error processing appointment ${appointment.Id}:`, apptError);
      }
    }
    
    console.log(`Successfully processed ${processedCount} of ${appointments.length} appointments`);
    
    return processedCount;
  } catch (error) {
    console.error('Error during bulk import:', error);
    throw error;
  }
}

// Export the function for use in API routes
export { bulkImportIntakeQAppointments };

// If this script is run directly, execute the bulk import
if (require.main === module) {
  bulkImportIntakeQAppointments()
    .then(count => console.log(`Bulk import completed: ${count} appointments processed`))
    .catch(err => console.error('Bulk import failed:', err));
}