// src/scripts/manual-import-appointments.ts
import fs from 'fs';
import { GoogleSheetsService } from '../lib/google/sheets';
import { AppointmentSyncHandler } from '../lib/intakeq/appointment-sync';
import { IntakeQService } from '../lib/intakeq/service';
// You need to install papaparse: npm install --save papaparse @types/papaparse
import { parse } from 'papaparse';
// Import WebhookEventType for type safety
import { WebhookEventType } from '../types/webhooks';

async function importAppointmentsFromCSV(filePath: string) {
  try {
    // 1. Read the CSV file
    const fileContent = fs.readFileSync(filePath, 'utf8');
    
    // 2. Parse the CSV
    const parseResult = parse(fileContent, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true
    });
    
    console.log(`Parsed ${parseResult.data.length} rows from CSV`);
    
    // 3. Set up services
    const sheetsService = new GoogleSheetsService();
    const intakeQService = new IntakeQService(sheetsService);
    const appointmentSyncHandler = new AppointmentSyncHandler(sheetsService, intakeQService);
    
    let imported = 0;
    let errors = 0;
    
    // 4. Process each appointment
    for (const row of parseResult.data) {
      try {
        // Convert CSV row to IntakeQ appointment format
        const appointment = convertRowToAppointment(row);
        
        // Check if appointment already exists
        const existingAppointment = await sheetsService.getAppointment(appointment.Id);
        
        if (!existingAppointment) {
          // Format as webhook payload with proper typing
          const payload = {
            EventType: 'AppointmentCreated' as WebhookEventType,
            ClientId: appointment.ClientId,
            Appointment: appointment
          };
          
          // Process the appointment
          const result = await appointmentSyncHandler.processAppointmentEvent(payload);
          
          if (result.success) {
            imported++;
            console.log(`Successfully imported appointment ${appointment.Id}`);
          } else {
            console.error(`Error processing appointment ${appointment.Id}:`, result.error);
            errors++;
          }
        } else {
          console.log(`Appointment ${appointment.Id} already exists, skipping`);
        }
      } catch (error) {
        console.error(`Error importing row:`, error);
        errors++;
      }
    }
    
    console.log(`Import complete: ${imported} appointments imported, ${errors} errors`);
    return { imported, errors };
  } catch (error) {
    console.error('Import error:', error);
    throw error;
  }
}

// Helper function to convert CSV row to IntakeQ appointment format
function convertRowToAppointment(row: any) {
    // Note: This is a simplified version - will need to be adapted to your CSV format
    const startDate = new Date(row.StartDate || row.start_date || row.startDate);
    const endDate = new Date(row.EndDate || row.end_date || row.endDate);
    
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new Error(`Invalid date format in row: ${JSON.stringify(row)}`);
    }
    
    // Calculate duration in minutes
    const durationMs = endDate.getTime() - startDate.getTime();
    const durationMinutes = Math.round(durationMs / (1000 * 60));
    
    // Format date for local display
    const startDateLocal = startDate.toLocaleString();
    const endDateLocal = endDate.toLocaleString();
    
    return {
      Id: row.Id || row.id || `csv-import-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      ClientName: row.ClientName || row.client_name || `${row.FirstName || ''} ${row.LastName || ''}`,
      ClientId: parseInt(row.ClientId || row.client_id || '0'),
      ClientEmail: row.ClientEmail || row.client_email || '',
      ClientPhone: row.ClientPhone || row.client_phone || '',
      ClientDateOfBirth: row.ClientDateOfBirth || row.client_date_of_birth || '',
      Status: row.Status || row.status || 'Confirmed',
      StartDate: startDate.getTime(),
      EndDate: endDate.getTime(),
      Duration: durationMinutes,
      ServiceName: row.ServiceName || row.service_name || 'Therapy Session',
      ServiceId: row.ServiceId || row.service_id || '1',
      LocationName: row.LocationName || row.location_name || 'Main Office',
      LocationId: row.LocationId || row.location_id || '1',
      Price: parseFloat(row.Price || row.price || '0'),
      PractitionerName: row.PractitionerName || row.practitioner_name || '',
      PractitionerEmail: row.PractitionerEmail || row.practitioner_email || '',
      PractitionerId: row.PractitionerId || row.practitioner_id || '1',
      DateCreated: Date.now(),
      CreatedBy: 'CSV Import',
      BookedByClient: false,
      StartDateIso: startDate.toISOString(),
      EndDateIso: endDate.toISOString(),
      // Add the missing required fields
      IntakeId: null,
      StartDateLocal: startDateLocal,
      EndDateLocal: endDateLocal,
      StartDateLocalFormatted: startDateLocal
    };
  }

// Run the script when executed directly
if (require.main === module) {
  if (process.argv.length < 3) {
    console.error('Please provide the path to the CSV file');
    process.exit(1);
  }
  
  const filePath = process.argv[2];
  
  importAppointmentsFromCSV(filePath)
    .then(result => {
      console.log(`Import complete: ${result.imported} appointments imported, ${result.errors} errors`);
      process.exit(0);
    })
    .catch(err => {
      console.error('Import failed:', err);
      process.exit(1);
    });
}

export default importAppointmentsFromCSV;