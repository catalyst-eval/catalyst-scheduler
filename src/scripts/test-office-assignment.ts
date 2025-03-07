// src/scripts/test-office-assignment.ts

import { GoogleSheetsService, AuditEventType } from '../lib/google/sheets';
import { AppointmentWindowManager } from '../lib/scheduling/appointment-window-manager';
import { DailyScheduleService } from '../lib/scheduling/daily-schedule-service';
import { formatESTTime, getDisplayDate } from '../lib/util/date-helpers';
import { standardizeOfficeId, isGroundFloorOffice, isAccessibleOffice } from '../lib/util/office-id';

/**
 * Test the office assignment logic with detailed logging
 */
async function testOfficeAssignment(date: string): Promise<void> {
  try {
    console.log(`\n==== TESTING OFFICE ASSIGNMENT FOR ${date} ====\n`);
    
    // Initialize services
    const sheetsService = new GoogleSheetsService();
    const dailyScheduleService = new DailyScheduleService(sheetsService);
    
    // Log the start of the test
    await sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'TEST_STARTED',
      description: `Starting office assignment test for ${date}`,
      user: 'SYSTEM',
      systemNotes: 'Detailed assignment test'
    });
    
    // Load configuration data
    console.log('Loading configuration data...');
    const offices = await sheetsService.getOffices();
    console.log(`Loaded ${offices.length} offices`);
    
    const clinicians = await sheetsService.getClinicians();
    console.log(`Loaded ${clinicians.length} clinicians`);
    
    const rules = await sheetsService.getAssignmentRules();
    console.log(`Loaded ${rules.length} assignment rules`);
    
    const clientPreferences = await sheetsService.getClientPreferences();
    console.log(`Loaded ${clientPreferences.length} client preferences`);
    
    // Log the available ground floor and accessible offices
    const groundFloorOffices = offices.filter(o => isGroundFloorOffice(standardizeOfficeId(o.officeId)));
    console.log(`Ground floor offices: ${groundFloorOffices.map(o => o.officeId).join(', ')}`);
    
    const accessibleOffices = offices.filter(o => isAccessibleOffice(standardizeOfficeId(o.officeId)));
    console.log(`Accessible offices: ${accessibleOffices.map(o => o.officeId).join(', ')}`);
    
    // Log active offices
    const activeOffices = offices.filter(o => o.inService);
    console.log(`Active offices: ${activeOffices.map(o => o.officeId).join(', ')}`);
    
    // Check appointment data
    console.log('\nRetrieving appointments for date...');
    const appointmentData = await dailyScheduleService.generateDailySchedule(date);
    console.log(`Found ${appointmentData.appointments.length} appointments`);
    
    // Create a detailed log of each appointment's assignment
    console.log('\n==== DETAILED APPOINTMENT ASSIGNMENTS ====\n');
    
    // Process and log each appointment
    for (const appt of appointmentData.appointments) {
      console.log(`\nAppointment: ${appt.clientName} with ${appt.clinicianName}`);
      console.log(`  Time: ${appt.formattedTime}`);
      console.log(`  Session Type: ${appt.sessionType}`);
      console.log(`  Assigned Office: ${appt.officeId}`);
      
      // Get client preferences if any
      const clientPreference = clientPreferences.find(p => 
        p.name?.toLowerCase().includes(appt.clientName.toLowerCase()));
      
      if (clientPreference?.assignedOffice) {
        console.log(`  Client has assigned office preference: ${clientPreference.assignedOffice}`);
      }
      
      // Get clinician's preferences
      const clinician = clinicians.find(c => c.name === appt.clinicianName);
      if (clinician) {
        console.log(`  Clinician primary office: ${clinician.preferredOffices?.[0] || 'None'}`);
        console.log(`  Clinician preferred offices: ${clinician.preferredOffices?.join(', ') || 'None'}`);
      }
      
      // Check client accessibility needs
      const clientAccessibility = await sheetsService.getClientAccessibilityInfo(appt.clientName);
      if (clientAccessibility?.hasMobilityNeeds) {
        console.log(`  Client has mobility needs: ${clientAccessibility.mobilityDetails}`);
        console.log(`  Assigned to accessible office: ${isAccessibleOffice(appt.officeId)}`);
      }
      
      // Check for conflicts
      const conflicts = appointmentData.conflicts.filter(c => 
        c.appointmentIds?.includes(appt.appointmentId));
      
      if (conflicts.length > 0) {
        console.log('  CONFLICTS DETECTED:');
        conflicts.forEach(conflict => {
          console.log(`    - ${conflict.description}`);
        });
      }
      
      // Log rule that was applied (based on app logic)
      console.log('  Assignment Rules Applied:');
      
      // Try to determine which rule was likely applied
      if (clientPreference?.assignedOffice) {
        console.log('    - Priority 100: Client Specific Requirement');
      } else if (clientAccessibility?.hasMobilityNeeds && isAccessibleOffice(appt.officeId)) {
        console.log('    - Priority 90: Accessibility Requirements');
      } else if (appt.sessionType === 'family' && ['C-2', 'C-3'].includes(appt.officeId)) {
        console.log('    - Priority 65: Family Sessions');
      } else if (clinician?.preferredOffices?.includes(appt.officeId)) {
        console.log('    - Priority 65/62: Clinician Primary/Preferred Office');
      } else if (appt.officeId === 'A-v' && appt.sessionType === 'telehealth') {
        console.log('    - Priority 10: Default Telehealth');
      } else {
        console.log('    - Other assignment rule or conflict resolution applied');
      }
    }
    
    // Log conflicts detected
    console.log('\n==== SCHEDULING CONFLICTS ====\n');
    if (appointmentData.conflicts.length > 0) {
      appointmentData.conflicts.forEach(conflict => {
        console.log(`Conflict: ${conflict.description}`);
        console.log(`  Type: ${conflict.type}`);
        console.log(`  Severity: ${conflict.severity}`);
        console.log(`  Office: ${conflict.officeId}`);
        console.log(`  Time: ${conflict.timeBlock}`);
        console.log(`  Clinicians: ${conflict.clinicianIds?.join(', ')}`);
        console.log('');
      });
    } else {
      console.log('No conflicts detected.');
    }
    
    // Test conflict resolution
    console.log('\n==== TESTING CONFLICT RESOLUTION ====\n');
    console.log('Attempting to resolve scheduling conflicts...');
    
    const resolvedCount = await dailyScheduleService.resolveSchedulingConflicts(date);
    console.log(`Resolved ${resolvedCount} conflicts`);
    
    // Check the updated schedule after conflict resolution
    if (resolvedCount > 0) {
      console.log('\nGenerating updated schedule after conflict resolution...');
      const updatedData = await dailyScheduleService.generateDailySchedule(date);
      
      console.log(`Remaining conflicts: ${updatedData.conflicts.length}`);
      
      // Log changes made by conflict resolution
      console.log('\n==== CHANGES MADE BY CONFLICT RESOLUTION ====\n');
      
      // Compare original and updated assignments
      updatedData.appointments.forEach(updatedAppt => {
        const originalAppt = appointmentData.appointments.find(a => 
          a.appointmentId === updatedAppt.appointmentId);
          
        if (originalAppt && originalAppt.officeId !== updatedAppt.officeId) {
          console.log(`${updatedAppt.clientName} with ${updatedAppt.clinicianName}:`);
          console.log(`  Changed from ${originalAppt.officeId} to ${updatedAppt.officeId}`);
          console.log('');
        }
      });
    }
    
    // Log the end of the test
    await sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'TEST_COMPLETED',
      description: `Completed office assignment test for ${date}`,
      user: 'SYSTEM',
      systemNotes: JSON.stringify({
        appointmentsProcessed: appointmentData.appointments.length,
        conflictsDetected: appointmentData.conflicts.length,
        conflictsResolved: resolvedCount
      })
    });
    
    console.log('\n==== TEST COMPLETED ====\n');
    console.log('Check the Audit_Log sheet for detailed test records.');
    
  } catch (error) {
    console.error('Error running assignment test:', error);
    
    // Log the error
    const sheetsService = new GoogleSheetsService();
    await sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'TEST_ERROR',
      description: 'Error running office assignment test',
      user: 'SYSTEM',
      systemNotes: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Run the test with a specific date if provided as argument, or use today's date
const testDate = process.argv[2] || new Date().toISOString().split('T')[0];
testOfficeAssignment(testDate)
  .then(() => {
    console.log('Test completed.');
    process.exit(0);
  })
  .catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
  });