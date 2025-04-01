// src/lib/email/templates.ts

import { DailyScheduleData, ScheduleConflict, ProcessedAppointment } from '../scheduling/daily-schedule-service';
import { formatESTTime } from '../util/date-helpers'; // Import the date formatter

export interface EmailTemplate {
  subject: string;
  htmlBody: string;
  textBody: string;
}

export class EmailTemplates {
  /**
   * Generate daily schedule email with improved office assignment info
   */
  static dailySchedule(data: DailyScheduleData): EmailTemplate {
    const { displayDate, appointments, conflicts, stats } = data;
    
    // Process appointments to ensure formatted dates
    const processedAppointments = this.ensureFormattedDates(appointments);
    
    // Sort clinicians by last name and normalize clinician names
    const clinicianGroups = this.groupAppointmentsByClinicianLastName(processedAppointments);
    
    // Define clinician colors
    const clinicianColors = {
      'Bailey': '#4C9AFF', // Light Blue
      'Bailey Serrano': '#4C9AFF', // Light Blue
      'Tyler': '#57D9A3',  // Light Green
      'Tyler Seabolt': '#57D9A3',  // Light Green
      'Samantha': '#FF8F73', // Light Red
      'Samantha Barnhart': '#FF8F73', // Light Red
      'Julia': '#E774BB',   // Fuschia
      'Julia Warren': '#E774BB',   // Fuschia
      'Mikah': '#B8ACF6',    // Light Purple
      'Mikah Jones': '#B8ACF6',    // Light Purple
      'Carlisle': '#FFC2D1',       // Light Pink
      'Carlisle Bading': '#FFC2D1',       // Light Pink
      'Cullen': '#79E2F2',         // Seafoam Green
      'Cullen MacDonald': '#79E2F2',         // Seafoam Green
      'Jessica': '#F5CD47',         // Light Yellow
      'Jessica Cox': '#F5CD47'         // Light Yellow
    };
    
    // Generate the HTML email
    const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { 
      font-family: Arial, sans-serif; 
      line-height: 1.5;
      color: #333;
      max-width: 800px;
      margin: 0 auto;
    }
    .header { 
      background-color: #4b6cb7; 
      color: white; 
      padding: 10px;
      border-radius: 5px 5px 0 0;
    }
    .header h1 {
      font-size: 1.5em;
      margin: 0;
    }
    .content { 
      padding: 20px; 
      background-color: #f9f9f9;
    }
    h2 {
      margin-top: 8px;
      margin-bottom: 8px;
    }
    .appointment-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 15px;
    }
    .appointment-table td {
      padding: 8px;
      border-bottom: 1px solid #ddd;
    }
    .appointment-table tr:nth-child(even) {
      background-color: #f2f2f2;
    }
    .clinician-section {
      margin-bottom: 20px;
    }
    .clinician-name {
      font-size: 1.1em;
      font-weight: bold;
      margin-bottom: 8px;
      padding: 6px;
      background-color: #f0f8ff;
      border-left: 4px solid #4b6cb7;
    }
    .office-change-client {
      color: #e74c3c;
      font-weight: bold;
    }
    .office-change-conflict {
      color: #f39c12;
      font-weight: bold;
    }
    .telehealth {
      color: #3498db;
    }
    .summary {
      background-color: #e9f7ef;
      padding: 12px;
      margin-bottom: 15px;
      border-left: 4px solid #27ae60;
      font-size: 0.85em;
    }
    .priority-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 15px;
      font-size: 0.75em;
    }
    .priority-table th, .priority-table td {
      border: 1px solid #ddd;
      padding: 6px;
      text-align: left;
    }
    .priority-table th {
      background-color: #e6e6e6;
    }
    .legend {
      margin-top: 15px;
      padding: 10px;
      background-color: #f8f9fa;
      border: 1px solid #eaeaea;
      font-size: 0.85em;
    }
    .legend ul {
      margin: 5px 0;
      padding-left: 20px;
    }
    .footer { 
      font-size: 12px; 
      color: #666; 
      padding: 15px; 
      text-align: center;
      border-top: 1px solid #ddd;
    }
    .request-form {
      margin: 20px 0; 
      padding: 15px; 
      background-color: #f0f7ff; 
      border-left: 5px solid #0066cc; 
      border-radius: 4px;
    }
    .collapsible {
      background-color: #f1f1f1;
      color: #444;
      cursor: pointer;
      padding: 12px;
      width: 100%;
      border: none;
      text-align: left;
      outline: none;
      font-size: 15px;
      border-radius: 4px;
      margin-bottom: 5px;
    }
    .active, .collapsible:hover {
      background-color: #e6e6e6;
    }
    .collapsible:after {
      content: '\\002B'; /* Unicode character for "plus" sign (+) */
      font-weight: bold;
      float: right;
      margin-left: 5px;
    }
    .active:after {
      content: "\\2212"; /* Unicode character for "minus" sign (-) */
    }
    .collapsible-content {
      padding: 0 18px;
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.2s ease-out;
      background-color: #f9f9f9;
    }
    
    /* Ensure collapsible sections appear open in email clients that don't support JavaScript */
    .email-safe-collapsible {
      display: block;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Daily Schedule: ${displayDate}</h1>
  </div>
  <div class="content">
    
    ${this.renderClinicianGroups(clinicianGroups, clinicianColors)}
    
    <div class="request-form">
      <h3 style="margin-top: 0; color: #0066cc;">Office Update Request Form 📋</h3>
      <p>Need to specify an office requirement or register accessibility needs for a client?</p>
      <div style="margin: 15px 0;">
        <a href="${this.getFormUrl()}" 
           style="display: inline-block; padding: 10px 20px; background-color: #0066cc; color: white; 
                  text-decoration: none; font-weight: bold; border-radius: 4px;">
          Submit Office Update Request
        </a>
      </div>
      <p style="margin-bottom: 0; font-size: 0.9em; color: #555;">
        Requests are processed hourly and will be applied to future appointments.
      </p>
    </div>
    
    <div class="summary">
      <strong>Summary - ${stats.totalAppointments} Total Appointments</strong>
    </div>
    
    <div class="legend">
      <strong>Legend:</strong>
      <ul>
        <li><span style="color: #e74c3c;">❗</span> <span style="color: #e74c3c; font-weight: bold;">Red text and exclamation point</span> - Office move due to client needs</li>
        <li><span style="color: #f39c12;">⚠️</span> <span style="color: #f39c12; font-weight: bold;">Orange text and warning triangle</span> - Office move due to scheduling conflict</li>
      </ul>
    </div>
    
    <!-- Collapsible Priority Table Section -->
    <button type="button" class="collapsible">Priority Level Reference Table ▼</button>
    <div class="collapsible-content email-safe-collapsible">
      <table class="priority-table">
  <thead>
    <tr>
      <th>Priority</th>
      <th>Description</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>100</td><td>Client-Specific Requirements</td></tr>
    <tr><td>90</td><td>Accessibility Requirements</td></tr>
    <tr><td>80</td><td>Young Children (≤10 years)</td></tr>
    <tr><td>78</td><td>Yoga Swing Assignment</td></tr>
    <tr><td>75</td><td>Older Children and Teens (11-17 years) to C-1</td></tr>
    <tr><td>74</td><td>B-5 Secondary for Older Children (11-15)</td></tr>
    <tr><td>73</td><td>C-1 Secondary for Young Children (≤10)</td></tr>
    <tr><td>72</td><td>B-2 Tertiary for All Children (≤15)</td></tr>
    <tr><td>70</td><td>Adult Client Assignments</td></tr>
    <tr><td>65</td><td>Clinician's Primary Office</td></tr>
    <tr><td>62</td><td>Clinician's Preferred Office</td></tr>
    <tr><td>55</td><td>In-Person Priority</td></tr>
    <tr><td>40</td><td>Telehealth to Preferred Office</td></tr>
    <tr><td>35</td><td>Special Features Match</td></tr>
    <tr><td>30</td><td>Alternative Clinician Office</td></tr>
    <tr><td>20</td><td>Available Office</td></tr>
    <tr><td>15</td><td>Break Room Last Resort</td></tr>
    <tr><td>10</td><td>Default Telehealth</td></tr>
  </tbody>
</table>
    </div>
    
    <!-- JavaScript to handle collapsible sections -->
    <script>
      var coll = document.getElementsByClassName("collapsible");
      var i;
      
      for (i = 0; i < coll.length; i++) {
        coll[i].addEventListener("click", function() {
          this.classList.toggle("active");
          var content = this.nextElementSibling;
          if (content.style.maxHeight){
            content.style.maxHeight = null;
            content.style.padding = "0 18px";
          } else {
            content.style.maxHeight = content.scrollHeight + "px";
            content.style.padding = "18px";
          }
        });
      }
    </script>
  </div>
  <div class="footer">
    <p>This report was automatically generated by Catalyst Scheduler on ${new Date().toLocaleString()}</p>
    <p>For questions or issues, please contact your administrator.</p>
  </div>
</body>
</html>
    `;
    
    // Generate plain text version
    const textBody = this.generateTextVersion(data, clinicianGroups);
    
    return {
      subject: `Daily Schedule: ${displayDate}`,
      htmlBody,
      textBody
    };
  }
  
  /**
   * Ensure all appointments have properly formatted date strings
   */
  private static ensureFormattedDates(appointments: ProcessedAppointment[]): ProcessedAppointment[] {
    return appointments.map(appt => {
      // If formattedTime is not already set, create it from start and end times
      if (!appt.formattedTime || appt.formattedTime.includes('Invalid Date') || appt.formattedTime.includes('undefined')) {
        const startFormatted = this.formatTimeString(appt.startTime);
        const endFormatted = this.formatTimeString(appt.endTime);
        return {
          ...appt,
          formattedTime: `${startFormatted} - ${endFormatted}`
        };
      }
      return appt;
    });
  }
  
  /**
   * Format time string with proper error handling
   */
  private static formatTimeString(dateString: string): string {
    try {
      if (!dateString) return 'TBD';
      
      // Try to format using the formatESTTime utility
      const formatted = formatESTTime(dateString);
      if (formatted === 'Invalid Date') {
        // Fallback to basic formatting
        const date = new Date(dateString);
        if (isNaN(date.getTime())) {
          console.warn(`Unable to parse date: ${dateString}`);
          return 'TBD';
        }
        
        return date.toLocaleTimeString('en-US', { 
          hour: 'numeric', 
          minute: '2-digit', 
          hour12: true 
        });
      }
      return formatted;
    } catch (error) {
      console.error('Error formatting time string:', error, { input: dateString });
      return 'TBD';
    }
  }
  
  /**
   * Group appointments by clinician's normalized name
   * Handles cases where the same clinician might appear with full name and first name only
   * Filters out duplicate appointments
   */
  private static groupAppointmentsByClinicianLastName(
    appointments: ProcessedAppointment[]
  ): { clinicianName: string; appointments: ProcessedAppointment[]; lastName: string }[] {
    // Create a map of clinician first names to full names
    const clinicianFirstNames = new Map<string, string>();
    appointments.forEach(appt => {
      const nameParts = appt.clinicianName.split(' ');
      if (nameParts.length > 1) {
        clinicianFirstNames.set(nameParts[0], appt.clinicianName);
      }
    });
    
    // Normalize clinician names (use full name when available)
    const normalizedAppointments = appointments.map(appt => {
      const nameParts = appt.clinicianName.split(' ');
      if (nameParts.length === 1 && clinicianFirstNames.has(nameParts[0])) {
        return { ...appt, normalizedClinicianName: clinicianFirstNames.get(nameParts[0]) };
      }
      return { ...appt, normalizedClinicianName: appt.clinicianName };
    });
    
    // Group appointments by normalized clinician name
    const appointmentsByClinicianMap = new Map<string, ProcessedAppointment[]>();
    
    // Create a Set to track unique appointment identifiers to detect duplicates
    const processedAppointments = new Set<string>();
    
    normalizedAppointments.forEach(appt => {
      const clinicianName = appt.normalizedClinicianName || appt.clinicianName;
      if (!appointmentsByClinicianMap.has(clinicianName)) {
        appointmentsByClinicianMap.set(clinicianName, []);
      }
      
      // Create a unique identifier for this appointment
      // Use appointmentId if available, otherwise use a combination of client, clinician, and time
      const uniqueId = appt.appointmentId || 
        `${appt.clientName}_${appt.clinicianName}_${appt.startTime}_${appt.endTime}`;
      
      // Only add this appointment if we haven't seen it before
      if (!processedAppointments.has(uniqueId)) {
        processedAppointments.add(uniqueId);
        appointmentsByClinicianMap.get(clinicianName)?.push(appt);
      }
    });
    
    // Convert to array with last name for sorting
    const clinicianGroups = Array.from(appointmentsByClinicianMap.entries())
      .map(([clinicianName, appointments]) => {
        // Extract last name for sorting (assumes format "First Last")
        const nameParts = clinicianName.split(' ');
        const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : clinicianName;
        
        return {
          clinicianName,
          appointments: appointments.sort((a, b) => {
            // Safely sort by time, handling potential invalid dates
            try {
              const timeA = new Date(a.startTime).getTime();
              const timeB = new Date(b.startTime).getTime();
              if (isNaN(timeA) || isNaN(timeB)) return 0;
              return timeA - timeB;
            } catch (error) {
              console.error('Error sorting appointments by time:', error);
              return 0;
            }
          }),
          lastName
        };
      });
    
    // Sort by last name
    return clinicianGroups.sort((a, b) => a.lastName.localeCompare(b.lastName));
  }
  
  /**
   * Render clinician groups with their appointments
   */
  private static renderClinicianGroups(
    clinicianGroups: { clinicianName: string; appointments: ProcessedAppointment[]; lastName: string }[],
    clinicianColors: {[key: string]: string}
  ): string {
    if (clinicianGroups.length === 0) {
      return '<p>No appointments scheduled for today.</p>';
    }
    
    return clinicianGroups.map(group => {
      // Get color for this clinician
      const color = clinicianColors[group.clinicianName] || '#4b6cb7';
      
      return `
        <div class="clinician-section">
          <div class="clinician-name" style="border-left-color: ${color}">
            <span style="color: ${color}">${group.clinicianName}</span>
          </div>
          
          <table class="appointment-table">
            ${group.appointments.map(appt => this.renderAppointmentRow(appt)).join('')}
          </table>
        </div>
      `;
    }).join('');
  }
  
  /**
   * Generate HTML for an appointment row with columns
   */
  private static renderAppointmentRow(appt: ProcessedAppointment): string {
    // Ensure formatted time is valid
    const formattedTime = appt.formattedTime && !appt.formattedTime.includes('Invalid Date') ? 
      appt.formattedTime : 
      this.formatTimeString(appt.startTime) + ' - ' + this.formatTimeString(appt.endTime);
    
    // Format time to remove duplicate AM/PM
    const cleanFormattedTime = this.cleanupTimeFormat(formattedTime);
    
    // Get priority number from assignment reason
    const priorityMatch = appt.assignmentReason?.match(/\(Priority (\d+)\)/);
    const priorityNumber = priorityMatch ? priorityMatch[1] : '';
    
    // Determine if office change is due to conflict
    const isConflictChange = appt.requiresOfficeChange && appt.assignmentReason?.includes('conflict');
    
    // Handle office display with priority in parentheses (fix duplicate "Office")
    // Make sure we only display "Office B-X" not "Office Office B-X"
    const officeId = appt.officeDisplay.replace(/^Office\s+/, '');
    const officeDisplay = `${officeId} (${priorityNumber})`;
    
    // Handle office change warning with different symbols based on reason
    let officeChangeWarning = officeDisplay;
    if (appt.requiresOfficeChange) {
      if (isConflictChange) {
        officeChangeWarning = `<span class="office-change-conflict">⚠️ ${officeDisplay}</span>`;
      } else {
        officeChangeWarning = `<span class="office-change-client">❗ ${officeDisplay}</span>`;
      }
    }
    
    // Determine session type class
    const sessionTypeClass = appt.sessionType === 'telehealth' ? 'class="telehealth"' : '';
    
    return `
      <tr>
        <td>${cleanFormattedTime}</td>
        <td>${appt.clientName}</td>
        <td>${officeChangeWarning}</td>
        <td><span ${sessionTypeClass}>${this.formatSessionType(appt.sessionType)}</span></td>
      </tr>
    `;
  }
  
  /**
   * Clean up time format to only show AM/PM once
   */
  private static cleanupTimeFormat(timeString: string): string {
    // Expected format: "8:00 AM - 8:50 AM" or similar
    const parts = timeString.split(' - ');
    if (parts.length !== 2) return timeString;
    
    const startTime = parts[0].trim();
    const endTime = parts[1].trim();
    
    // Check if both have AM or both have PM
    if ((startTime.endsWith('AM') && endTime.endsWith('AM')) || 
        (startTime.endsWith('PM') && endTime.endsWith('PM'))) {
      // Remove AM/PM from first part
      const startWithoutAmPm = startTime.replace(/(AM|PM)$/, '').trim();
      return `${startWithoutAmPm} - ${endTime}`;
    }
    
    return timeString;
  }
  
  /**
   * Format session type for display
   */
  private static formatSessionType(type: string): string {
    switch (type) {
      case 'in-person':
        return 'In-Person';
      case 'telehealth':
        return 'Telehealth';
      case 'group':
        return 'Group Therapy';
      case 'family':
        return 'Family Session';
      default:
        return type.charAt(0).toUpperCase() + type.slice(1);
    }
  }
  
  /**
   * Generate a plain text version of the email for clients without HTML
   */
  private static generateTextVersion(
    data: DailyScheduleData,
    clinicianGroups: { clinicianName: string; appointments: ProcessedAppointment[]; lastName: string }[]
  ): string {
    const { displayDate, stats } = data;
    
    let text = `DAILY SCHEDULE: ${displayDate}\n\n`;
    
    // Appointments section
    if (clinicianGroups.length === 0) {
      text += `No appointments scheduled for today.\n\n`;
    } else {
      clinicianGroups.forEach(group => {
        text += `${group.clinicianName}\n${'-'.repeat(group.clinicianName.length)}\n`;
        
        group.appointments.forEach(appt => {
          // Ensure formatted time is valid
          const formattedTime = appt.formattedTime && !appt.formattedTime.includes('Invalid Date') ? 
            appt.formattedTime : 
            this.formatTimeString(appt.startTime) + ' - ' + this.formatTimeString(appt.endTime);
          
          // Clean up time format
          const cleanFormattedTime = this.cleanupTimeFormat(formattedTime);
          
          // Get priority number from assignment reason
          const priorityMatch = appt.assignmentReason?.match(/\(Priority (\d+)\)/);
          const priorityNumber = priorityMatch ? priorityMatch[1] : '';
          
          // Handle office display
          const officeId = appt.officeDisplay.replace(/^Office\s+/, '');
          
          text += `${cleanFormattedTime}  ${appt.clientName}  ${officeId} (${priorityNumber})`;
          
          if (appt.requiresOfficeChange) {
            if (appt.assignmentReason?.includes('conflict')) {
              text += ` ⚠️ OFFICE CHANGE (CONFLICT)`;
            } else {
              text += ` ❗ OFFICE CHANGE (CLIENT NEED)`;
            }
          }
          
          text += `  ${this.formatSessionType(appt.sessionType)}\n`;
        });
        
        text += `\n`;
      });
    }
    
    // Form section moved below appointments
    text += `OFFICE UPDATE REQUEST FORM\n`;
    text += `Need to specify accessibility needs or office requirements?\n`;
    text += `Visit: ${this.getFormUrl()}\n\n`;
    text += `Requests are processed hourly and will be applied to future appointments.\n\n`;
    
    // Summary section
    text += `Summary - ${stats.totalAppointments} Total Appointments\n\n`;
    
    // Legend
    text += `Legend:\n`;
    text += `❗ - Office move due to client needs\n`;
    text += `⚠️ - Office move due to scheduling conflict\n\n`;
    
    // Priority Levels Reference (shortened, no explainer text)
    text += `PRIORITY LEVELS REFERENCE\n`;
text += `100 - Client-Specific Requirements\n`;
text += `90 - Accessibility Requirements\n`;
text += `80 - Young Children (≤10 years)\n`;
text += `78 - Yoga Swing Assignment\n`;
text += `75 - Older Children and Teens (11-17 years) to C-1\n`;
text += `74 - B-5 Secondary for Older Children (11-15)\n`;
text += `73 - C-1 Secondary for Young Children (≤10)\n`;
text += `72 - B-2 Tertiary for All Children (≤15)\n`;
text += `70 - Adult Client Assignments\n`;
text += `65 - Clinician's Primary Office\n`;
text += `62 - Clinician's Preferred Office\n`;
text += `55 - In-Person Priority\n`;
text += `40 - Telehealth to Preferred Office\n`;
text += `35 - Special Features Match\n`;
text += `30 - Alternative Clinician Office\n`;
text += `20 - Available Office\n`;
text += `15 - Break Room Last Resort\n`;
text += `10 - Default Telehealth\n`;
    
    return text;
  }
  
  /**
   * Generate error notification email
   */
  static errorNotification(
    errorOrMessage: Error | string,
    context: string,
    details?: any
  ): EmailTemplate {
    const error = errorOrMessage instanceof Error ? errorOrMessage : new Error(errorOrMessage);
    
    const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { 
      font-family: Arial, sans-serif; 
      line-height: 1.5;
      color: #333;
    }
    .header { 
      background-color: #e74c3c; 
      color: white; 
      padding: 20px;
      border-radius: 5px 5px 0 0;
    }
    .content { 
      padding: 20px; 
      background-color: #f9f9f9;
    }
    .code {
      font-family: monospace;
      background-color: #f5f5f5;
      padding: 15px;
      border-radius: 4px;
      overflow-x: auto;
    }
    .footer { 
      font-size: 12px; 
      color: #666; 
      padding: 20px; 
      text-align: center;
      border-top: 1px solid #ddd;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Catalyst Scheduler Error Alert</h1>
  </div>
  <div class="content">
    <h2>An error occurred during: ${context}</h2>
    <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
    <p><strong>Error:</strong> ${error.message}</p>
    
    <h3>Error Details</h3>
    <div class="code">
      ${error.stack ? error.stack.replace(/\n/g, '<br>') : 'No stack trace available'}
    </div>
    
    ${details ? `
      <h3>Additional Context</h3>
      <div class="code">
        ${JSON.stringify(details, null, 2).replace(/\n/g, '<br>')}
      </div>
    ` : ''}
    
    <p>This error may require attention to ensure proper system operation.</p>
  </div>
  <div class="footer">
    <p>This is an automated message from Catalyst Scheduler</p>
  </div>
</body>
</html>
    `;
    
    const textBody = `
CATALYST SCHEDULER ERROR ALERT

An error occurred during: ${context}
Timestamp: ${new Date().toLocaleString()}
Error: ${error.message}

Error Details:
${error.stack || 'No stack trace available'}

${details ? `Additional Context:
${JSON.stringify(details, null, 2)}` : ''}

This error may require attention to ensure proper system operation.

This is an automated message from Catalyst Scheduler
    `;
    
    return {
      subject: `Error Alert: Catalyst Scheduler - ${context}`,
      htmlBody,
      textBody
    };
  }
  
  /**
   * Get the form URL from settings
   */
  private static getFormUrl(): string {
    // Return the actual Google Form URL
    return 'https://docs.google.com/forms/d/e/1FAIpQLSeb_jWT5fexL9PE434ItIpQQcnF5v-a3w0_sIdQIgndCIU-rw/viewform?usp=sharing';
  }
}