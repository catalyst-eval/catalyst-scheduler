// src/scripts/manual-import-appointments.ts
import fs from 'fs';
import { GoogleSheetsService, AuditEventType } from '../lib/google/sheets';
import { AppointmentSyncHandler } from '../lib/intakeq/appointment-sync';
import { IntakeQService } from '../lib/intakeq/service';
// You need to install papaparse: npm install --save papaparse @types/papaparse
import { parse } from 'papaparse';
// Import WebhookEventType for type safety
import { WebhookEventType } from '../types/webhooks';

/**
 * Import appointments from a CSV file exported from IntakeQ
 */
async function importAppointmentsFromCSV(filePath: string) {
  try {
    console.log(`Reading CSV file from ${filePath}`);
    // 1. Read the CSV file
    const fileContent = fs.readFileSync(filePath, 'utf8');
    
    // 2. Parse the CSV with complete header mapping
    const parseResult = parse(fileContent, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true
    });
    
    console.log(`Parsed ${parseResult.data.length} appointments from CSV`);
    
    // 3. Set up services
    const sheetsService = new GoogleSheetsService();
    const intakeQService = new IntakeQService(sheetsService);
    const appointmentSyncHandler = new AppointmentSyncHandler(sheetsService, intakeQService);
    
    // 4. Get clinicians for ID mapping
    const clinicians = await sheetsService.getClinicians();
    console.log(`Retrieved ${clinicians.length} clinicians for mapping`);
    
    // 5. Process statistics
    let imported = 0;
    let skipped = 0;
    let errors = 0;
    
    // 6. Process each appointment
for (const rawRow of parseResult.data) {
    try {
      // Type assertion for row
      const row = rawRow as Record<string, any>;
      
      // Skip rows with no date or obvious placeholders
      if (!row.Date || row.Status === 'Placeholder') {
        skipped++;
        continue;
      }
      
      // Convert CSV row to IntakeQ appointment format
      const appointment = await convertRowToAppointment(row, clinicians, sheetsService);
        
      const existingAppointment = await sheetsService.getAppointment(appointment.Id);
        
      if (!existingAppointment) {
        // Format as webhook payload with proper typing
        const payload = {
          EventType: 'AppointmentCreated' as WebhookEventType,
          ClientId: appointment.ClientId,
          Appointment: appointment
        } as any; // Using type assertion to avoid TypeScript errors
        
        // Process the appointment
        const result = await appointmentSyncHandler.processAppointmentEvent(payload);
        
        if (result.success) {
          imported++;
          console.log(`Successfully imported appointment ${appointment.Id}`);
          
          // Add audit log entry
          await sheetsService.addAuditLog({
            timestamp: new Date().toISOString(),
            eventType: AuditEventType.APPOINTMENT_CREATED,
            description: `Imported appointment ${appointment.Id} from CSV`,
            user: 'SYSTEM',
            systemNotes: JSON.stringify({
              clientId: appointment.ClientId,
              clientName: appointment.ClientName,
              startTime: appointment.StartDateIso,
              clinicianName: appointment.PractitionerName
            })
          });
        } else {
          console.error(`Error processing appointment ${appointment.Id}:`, result.error);
          errors++;
        }
      } else {
        console.log(`Appointment ${appointment.Id} already exists, skipping`);
        skipped++;
      }
      } catch (error) {
        console.error(`Error importing row:`, error);
        errors++;
      }
    }
    
    // 7. Log final results
    console.log(`Import complete: ${imported} imported, ${skipped} skipped, ${errors} errors`);
    
    // 8. Add audit log for overall import
    await sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.INTEGRATION_UPDATED,
      description: `Completed CSV import from ${filePath}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        imported,
        skipped,
        errors,
        totalRows: parseResult.data.length
      })
    });
    
    return { imported, skipped, errors };
  } catch (error) {
    console.error('CSV import error:', error);
    throw error;
  }
}

/**
 * Convert CSV row to IntakeQ appointment format
 * Specifically handles the 70-column IntakeQ export format
 */
async function convertRowToAppointment(row: any, clinicians: any[], sheetsService: GoogleSheetsService) {
  // 1. Parse the date - different possible formats
  let startDate: Date;
  try {
    // Try parsing date (could be in multiple formats)
    startDate = new Date(row.Date);
    if (isNaN(startDate.getTime())) {
      throw new Error('Invalid date format');
    }
  } catch (error) {
    console.warn(`Invalid date format: ${row.Date}, using current date`);
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
  
  if (serviceName.toLowerCase().includes('family') || 
      serviceName.toLowerCase().includes('couple')) {
    sessionType = 'family';
  } else if (serviceName.toLowerCase().includes('group')) {
    sessionType = 'group';
  } else if (serviceName.toLowerCase().includes('tele') || 
             serviceName.toLowerCase().includes('virtual') ||
             serviceName.toLowerCase().includes('online') ||
             serviceName.toLowerCase().includes('remote')) {
    sessionType = 'telehealth';
  }
  
  // 6. Map practitioner name to ID
  let practitionerId = '';
  const practitionerName = row.Practitioner || '';
  
  if (practitionerName) {
    // Look for matching clinician
    const matchingClinician = clinicians.find(c => 
      c.name.toLowerCase() === practitionerName.toLowerCase() ||
      practitionerName.toLowerCase().includes(c.name.toLowerCase()) ||
      c.name.toLowerCase().includes(practitionerName.toLowerCase())
    );
    
    if (matchingClinician) {
      practitionerId = matchingClinician.intakeQPractitionerId || matchingClinician.clinicianId;
    } else {
      console.warn(`No matching clinician found for "${practitionerName}"`);
    }
  }
  
  // 7. Handle client name components
  const clientName = row.ClientName || `${row.FirstName || ''} ${row.LastName || ''}`.trim();
  const clientFirstName = row.FirstName || clientName.split(' ')[0] || '';
  const clientLastName = row.LastName || (clientName.split(' ').length > 1 ? clientName.split(' ').slice(1).join(' ') : '');
  
  // 8. Format dates for display
  const startDateLocal = startDate.toLocaleString();
  const endDateLocal = endDate.toLocaleString();
  
  // 9. Process any client accessibility info if client ID exists
  if (clientId) {
    await processClientAccessibilityInfo(clientId, clientName, row, sheetsService);
  }
  
  // 10. Return the formatted appointment object
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
 * Process client accessibility information from notes or other fields
 */
async function processClientAccessibilityInfo(clientId: number, clientName: string, row: any, sheetsService: GoogleSheetsService) {
  try {
    // Check if we already have accessibility info for this client
    const existingAccessibility = await sheetsService.getClientAccessibilityInfo(clientId.toString());
    
    if (existingAccessibility) {
      // Already have info, no need to process
      return;
    }
    
    // Extract notes that might contain accessibility info
    const notes = row.Notes || row.ClientNote || '';
    const practitionerNotes = row.PractitionerNote || '';
    const allNotes = [notes, practitionerNotes].filter(Boolean).join(' ');
    
    // Look for keywords related to accessibility
    const hasMobilityNeeds = checkForKeywords(allNotes, [
      'wheelchair', 'mobility', 'crutches', 'walker', 'cane', 'difficulty walking',
      'mobility aid', 'accessible', 'ground floor'
    ]);
    
    const hasSensoryNeeds = checkForKeywords(allNotes, [
      'sensory', 'light sensitivity', 'noise', 'sound sensitive', 'bright light',
      'sensory processing', 'overstimulation', 'auditory', 'visual'
    ]);
    
    const hasPhysicalNeeds = checkForKeywords(allNotes, [
      'physical', 'stairs', 'elevator', 'chair', 'seating', 'accommodation',
      'physical needs', 'ergonomic', 'special seating'
    ]);
    
    // Check for specific intake forms
    const formType = 
      row.Service?.toLowerCase().includes('minor') || 
      row.ClientDOB ? (new Date().getFullYear() - new Date(row.ClientDOB).getFullYear() < 18) 
        ? 'Minor' 
        : 'Adult' 
      : 'Adult';
    
    // Create accessibility info object
    const accessibilityInfo = {
      clientId: clientId.toString(),
      clientName: clientName,
      lastUpdated: new Date().toISOString(),
      hasMobilityNeeds,
      mobilityDetails: hasMobilityNeeds ? extractRelevantText(allNotes, ['mobility', 'wheelchair', 'walker']) : '',
      hasSensoryNeeds,
      sensoryDetails: hasSensoryNeeds ? extractRelevantText(allNotes, ['sensory', 'light', 'sound', 'noise']) : '',
      hasPhysicalNeeds,
      physicalDetails: hasPhysicalNeeds ? extractRelevantText(allNotes, ['physical', 'stairs', 'seating']) : '',
      roomConsistency: checkForKeywords(allNotes, ['consistency', 'same room', 'familiar']) ? 5 : 3,
      hasSupport: checkForKeywords(allNotes, ['support', 'assistance', 'helper', 'aide', 'service animal']),
      supportDetails: checkForKeywords(allNotes, ['support', 'assistance']) ? extractRelevantText(allNotes, ['support', 'assistance', 'helper']) : '',
      additionalNotes: extractRelevantText(allNotes, ['special', 'need', 'accommodation']),
      formType,
      formId: `csv-import-${Date.now()}`
    };
    
    // Only create entries if we have actual accessibility needs
    if (hasMobilityNeeds || hasSensoryNeeds || hasPhysicalNeeds || 
        accessibilityInfo.roomConsistency > 3 || accessibilityInfo.hasSupport) {
      
      await sheetsService.updateClientAccessibilityInfo(accessibilityInfo);
      console.log(`Created accessibility info for client ${clientId} from notes`);
    }
  } catch (error) {
    console.error(`Error processing accessibility info for client ${clientId}:`, error);
  }
}

/**
 * Check if text contains any of the given keywords
 */
function checkForKeywords(text: string, keywords: string[]): boolean {
  if (!text) return false;
  
  const lowerText = text.toLowerCase();
  return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
}

/**
 * Extract text relevant to specific keywords (sentences containing keywords)
 */
function extractRelevantText(text: string, keywords: string[]): string {
  if (!text) return '';
  
  // Split into sentences and find ones with keywords
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  const relevantSentences = sentences.filter(sentence => 
    keywords.some(keyword => sentence.toLowerCase().includes(keyword.toLowerCase()))
  );
  
  return relevantSentences.join('. ');
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
      console.log(`Import complete: ${result.imported} appointments imported, ${result.skipped} skipped, ${result.errors} errors`);
      process.exit(0);
    })
    .catch(err => {
      console.error('Import failed:', err);
      process.exit(1);
    });
}

export default importAppointmentsFromCSV;