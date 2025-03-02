// src/lib/email/templates.ts

import { DailyScheduleData, ScheduleConflict, ProcessedAppointment } from '../scheduling/daily-schedule-service';

export interface EmailTemplate {
  subject: string;
  htmlBody: string;
  textBody: string;
}

export class EmailTemplates {
  /**
   * Generate daily schedule email
   */
  static dailySchedule(data: DailyScheduleData): EmailTemplate {
    const { displayDate, appointments, conflicts, stats } = data;
    
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
      padding: 20px;
      border-radius: 5px 5px 0 0;
    }
    .content { 
      padding: 20px; 
      background-color: #f9f9f9;
    }
    table { 
      width: 100%; 
      border-collapse: collapse; 
      margin-bottom: 20px;
    }
    th { 
      background-color: #e6e6e6; 
      padding: 10px; 
      text-align: left;
      border-bottom: 2px solid #ddd;
    }
    td { 
      padding: 10px; 
      border-bottom: 1px solid #ddd; 
    }
    tr:nth-child(even) { 
      background-color: #f2f2f2; 
    }
    .conflicts { 
      background-color: #fff0f0; 
      border-left: 4px solid #ff6b6b; 
      padding: 15px;
      margin-bottom: 20px;
    }
    .high { 
      color: #d63031; 
      font-weight: bold;
    }
    .medium { 
      color: #e17055; 
    }
    .low { 
      color: #fdcb6e; 
    }
    .stats { 
      background-color: #e9f7ef; 
      padding: 15px;
      margin-bottom: 20px;
      border-left: 4px solid #27ae60;
    }
    .special-requirements {
      background-color: #f5f6fa;
      border-left: 4px solid #3498db;
      padding: 8px;
      margin-top: 5px;
      font-size: 0.9em;
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
    <h1>Daily Schedule: ${displayDate}</h1>
  </div>
  <div class="content">
    <h2>Schedule Overview</h2>
    <div class="stats">
      <h3>Summary</h3>
      <p>Total appointments: <strong>${stats.totalAppointments}</strong></p>
      <ul>
        <li>In-person sessions: ${stats.inPersonCount}</li>
        <li>Telehealth sessions: ${stats.telehealthCount}</li>
        <li>Group sessions: ${stats.groupCount}</li>
        <li>Family sessions: ${stats.familyCount}</li>
      </ul>
      
      <h3>Office Utilization</h3>
      <ul>
        ${Object.entries(stats.officeUtilization)
          .map(([officeId, count]) => `<li>Office ${officeId}: ${count} appointment(s)</li>`)
          .join('')}
      </ul>
    </div>
    
    ${this.renderConflictsSection(conflicts)}
    
    <h2>Appointments</h2>
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Client</th>
          <th>Clinician</th>
          <th>Office</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
        ${appointments.map(appt => this.renderAppointmentRow(appt)).join('')}
      </tbody>
    </table>
  </div>
  <div class="footer">
    <p>This report was automatically generated by Catalyst Scheduler on ${new Date().toLocaleString()}</p>
    <p>For questions or issues, please contact your administrator.</p>
  </div>
</body>
</html>
    `;
    
    // Generate plain text version
    const textBody = this.generateTextVersion(data);
    
    return {
      subject: `Daily Schedule: ${displayDate}`,
      htmlBody,
      textBody
    };
  }
  
  /**
 * Generate HTML for an appointment row
 */
private static renderAppointmentRow(appt: ProcessedAppointment): string {
  const requirementsHtml = appt.hasSpecialRequirements 
    ? `<div class="special-requirements">
         ${appt.requirements?.accessibility ? '<div>♿ Accessibility needed</div>' : ''}
         ${appt.requirements?.specialFeatures?.length 
           ? `<div>🔍 Special features: ${appt.requirements.specialFeatures.join(', ')}</div>` 
           : ''}
         ${appt.notes ? `<div>📝 ${appt.notes}</div>` : ''}
       </div>`
    : '';
  
  // Log for debugging
  console.log(`Rendering appointment row for ${appt.appointmentId}:`, {
    officeId: appt.officeId,
    officeDisplay: appt.officeDisplay
  });
  
  return `
    <tr>
      <td>${appt.formattedTime}</td>
      <td>${appt.clientName}${requirementsHtml}</td>
      <td>${appt.clinicianName}</td>
      <td>${appt.officeDisplay}</td>
      <td>${this.formatSessionType(appt.sessionType)}</td>
    </tr>
  `;
}
  
  /**
   * Generate HTML for conflicts section
   */
  private static renderConflictsSection(conflicts: ScheduleConflict[]): string {
    if (conflicts.length === 0) {
      return `
        <div class="stats">
          <h3>Conflicts</h3>
          <p>✅ No scheduling conflicts detected for today.</p>
        </div>
      `;
    }
    
    return `
      <div class="conflicts">
        <h3>⚠️ Scheduling Conflicts (${conflicts.length})</h3>
        <ul>
          ${conflicts.map(conflict => `
            <li class="${conflict.severity}">
              ${conflict.description}
            </li>
          `).join('')}
        </ul>
      </div>
    `;
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
  private static generateTextVersion(data: DailyScheduleData): string {
    const { displayDate, appointments, conflicts, stats } = data;
    
    let text = `DAILY SCHEDULE: ${displayDate}\n\n`;
    
    // Summary section
    text += `SUMMARY\n`;
    text += `Total appointments: ${stats.totalAppointments}\n`;
    text += `In-person sessions: ${stats.inPersonCount}\n`;
    text += `Telehealth sessions: ${stats.telehealthCount}\n`;
    text += `Group sessions: ${stats.groupCount}\n`;
    text += `Family sessions: ${stats.familyCount}\n\n`;
    
    // Office utilization
    text += `OFFICE UTILIZATION\n`;
    Object.entries(stats.officeUtilization).forEach(([officeId, count]) => {
      text += `Office ${officeId}: ${count} appointment(s)\n`;
    });
    text += `\n`;
    
    // Conflicts section
    text += `CONFLICTS\n`;
    if (conflicts.length === 0) {
      text += `No scheduling conflicts detected for today.\n`;
    } else {
      text += `${conflicts.length} scheduling conflicts found:\n`;
      conflicts.forEach(conflict => {
        text += `- ${conflict.description}\n`;
      });
    }
    text += `\n`;
    
    // Appointments section
    text += `APPOINTMENTS\n`;
    text += `Time | Client | Clinician | Office | Type\n`;
    text += `${'-'.repeat(75)}\n`;
    
    appointments.forEach(appt => {
      let appText = `${appt.formattedTime} | ${appt.clientName} | ${appt.clinicianName} | ${appt.officeDisplay} | ${this.formatSessionType(appt.sessionType)}\n`;
      
      if (appt.hasSpecialRequirements) {
        if (appt.requirements?.accessibility) {
          appText += `  * Accessibility needed\n`;
        }
        if (appt.requirements?.specialFeatures?.length) {
          appText += `  * Special features: ${appt.requirements.specialFeatures.join(', ')}\n`;
        }
        if (appt.notes) {
          appText += `  * Notes: ${appt.notes}\n`;
        }
      }
      
      text += appText;
    });
    
    // Footer
    text += `\nThis report was automatically generated by Catalyst Scheduler on ${new Date().toLocaleString()}\n`;
    text += `For questions or issues, please contact your administrator.\n`;
    
    return text;
  }
  
  /**
   * Generate error notification email
   */
  static errorNotification(
    error: Error,
    context: string,
    details?: any
  ): EmailTemplate {
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
}

export default EmailTemplates;