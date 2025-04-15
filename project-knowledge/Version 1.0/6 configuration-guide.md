# Catalyst Scheduler Configuration Guide

This guide outlines the configuration requirements for the Catalyst Scheduler system, focusing on the Google Sheets structure, environment setup, and system configuration.

## Google Sheets Structure

### Required Tabs and Standardized Headers

The system requires a Google Sheet with the following tabs and standardized camelCase headers:

#### 1. Appointments

```
appointmentId,clientId,clientName,clinicianId,clinicianName,currentOfficeId,sessionType,startTime,endTime,status,source,lastUpdated,requirementsJson,notes,assignedOfficeId,assignmentReason,accessibilityNeeded,requiredFeatures,clientPreferences,clinicianPreferences,conflicts,needsAssignment
```

Key fields:
- `appointmentId`: Unique identifier from IntakeQ
- `currentOfficeId`: Current/historical office assignment
- `assignedOfficeId`: Office assigned by the algorithm
- `assignmentReason`: Text explanation of assignment decision

#### 2. Active_Appointments

```
appointmentId,clientId,clientName,clinicianId,clinicianName,currentOfficeId,sessionType,startTime,endTime,status,source,lastUpdated,requirementsJson,notes,assignedOfficeId,assignmentReason,accessibilityNeeded,requiredFeatures,clientPreferences,clinicianPreferences,conflicts,needsAssignment
```

This tab mirrors the structure of Appointments but only contains appointments for the current day. It's maintained through:
- Node.js operations during webhook processing
- Daily refresh via Apps Script at 5:45 AM EST

#### 3. Offices_Configuration

```
officeId,name,unit,inService,floor,isAccessible,size,ageGroups,specialFeatures,primaryClinician,alternativeClinicians,isFlexSpace,notes
```

Key fields:
- `officeId`: Standard format identifier (e.g., "B-4")
- `inService`: Boolean (TRUE/FALSE) whether office is available
- `isAccessible`: Boolean whether office has accessibility features
- `specialFeatures`: Comma-separated list of features

#### 4. Clinicians_Configuration

```
clinicianId,name,email,role,ageRangeMin,ageRangeMax,specialties,caseloadLimit,currentCaseload,preferredOffices,allowsRelationship,certifications,intakeQPractitionerId
```

Key fields:
- `clinicianId`: Internal identifier
- `preferredOffices`: Comma-separated list of preferred office IDs
- `intakeQPractitionerId`: ID in IntakeQ system

#### 5. Assignment_Rules

```
priority,ruleName,ruleType,condition,officeIds,overrideLevel,active,notes
```

Key fields:
- `priority`: Numeric priority (100 highest, 10 lowest)
- `condition`: Condition expression for rule
- `officeIds`: Target offices (can use special syntax)
- `active`: Boolean (TRUE/FALSE) whether rule is active

#### 6. Client_Accessibility_Info

```
clientId,clientName,lastUpdated,hasMobilityNeeds,mobilityDetails,hasSensoryNeeds,sensoryDetails,hasPhysicalNeeds,physicalDetails,roomConsistency,hasSupportNeeds,supportDetails,accessibilityNotes,formType,formId
```

Key fields:
- `clientId`: Client ID matching IntakeQ
- `hasMobilityNeeds`: Boolean for mobility requirements
- `accessibilityNotes`: Additional notes, may include office assignment

#### 7. Schedule_Configuration

```
settingName,value,description,lastUpdated,updatedBy
```

#### 8. Integration_Settings

```
serviceName,settingType,value,description,lastUpdated
```

#### 9. Audit_Log

```
timestamp,eventType,description,user,previousValue,newValue,systemNotes
```

#### 10. Webhook_Log (Recommended Addition)

```
idempotencyKey,timestamp,webhookType,entityId,status,retryCount,error
```

Key fields:
- `idempotencyKey`: Unique identifier for webhook event
- `webhookType`: Type of webhook (e.g., "AppointmentCreated")
- `entityId`: ID of affected entity (appointmentId, formId)
- `status`: Processing status (received, processing, completed, failed)

### Office ID Standardization

Office IDs must follow the standardized format:

- Format: `{Floor}-{Unit}`
- Examples: `B-4`, `C-3`, `A-v`
- Floor designations: A, B, C
- Floor A units: lowercase letters (a, b, c, etc.) or 'v' for virtual
- Floor B/C units: numbers (1, 2, 3, etc.)

All office IDs in the system should be standardized using the `standardizeOfficeId()` utility function.

## Assignment Rules Configuration

### Priority Hierarchy

Rules are processed in strict priority order (highest to lowest):

1. **Priority 100**: Client Specific Requirement
   - Condition: `has_required_office == true`
   - OfficeIds: `[client.required_office_id]`
   - OverrideLevel: `hard`

2. **Priority 90**: Accessibility Requirements
   - Condition: `client.mobility_needs.length > 0`
   - OfficeIds: `B-4 C-3`
   - OverrideLevel: `hard`

3. **Priority 80**: Young Children
   - Condition: `age <= 10`
   - OfficeIds: `B-5`
   - OverrideLevel: `hard`

4. **Priority 75**: Older Children and Teens
   - Condition: `age >= 11 && age <= 17`
   - OfficeIds: `C-1`
   - OverrideLevel: `hard`

5. **Priority 70**: Adults
   - Condition: `age >= 18`
   - OfficeIds: `B-4,C-2,C-3`
   - OverrideLevel: `medium`

6. **Priority 65**: Clinician Primary Office
   - Condition: `is_primary_office == true`
   - OfficeIds: `[clinician.primary_office]`
   - OverrideLevel: `medium`

7. **Priority 62**: Clinician Preferred Office
   - Condition: `is_preferred_office == true`
   - OfficeIds: `[clinician.preferred_offices]`
   - OverrideLevel: `medium`

8. **Priority 55**: In-Person Priority
   - Condition: `session_type == in-person`
   - OfficeIds: `B-4,B-5,C-1,C-2,C-3`
   - OverrideLevel: `medium`

9. **Priority 40**: Telehealth to Preferred Office
   - Condition: `session_type == telehealth`
   - OfficeIds: `[clinician.preferred_offices]`
   - OverrideLevel: `soft`

10. **Priority 35**: Special Features Match
    - Condition: `has_matching_features == true`
    - OfficeIds: `[matching_offices]`
    - OverrideLevel: `soft`

11. **Priority 30**: Alternative Clinician Office
    - Condition: `is_alternative_clinician == true`
    - OfficeIds: `[matching_offices]`
    - OverrideLevel: `soft`

12. **Priority 20**: Available Office
    - Condition: `is_available == true`
    - OfficeIds: `[available_offices]`
    - OverrideLevel: `soft`

13. **Priority 15**: Break Room Last Resort
    - Condition: `office_id == "B-1"`
    - OfficeIds: `B-1`
    - OverrideLevel: `soft`

14. **Priority 10**: Default Telehealth
    - Condition: `session_type == telehealth`
    - OfficeIds: `A-v`
    - OverrideLevel: `soft`

### Special Syntax in Office IDs

- `[client.required_office_id]`: Use client's required office from Client_Accessibility_Info
- `[clinician.primary_office]`: Use clinician's primary office
- `[clinician.preferred_offices]`: Use clinician's preferred offices
- `[matching_offices]`: Use offices with matching features
- `[available_offices]`: Use any available office during appointment time

## Environment Configuration

### Required Environment Variables

```
# Google Sheets Integration
GOOGLE_SHEETS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEETS_CLIENT_EMAIL="service-account@project-id.iam.gserviceaccount.com"
GOOGLE_SHEETS_SPREADSHEET_ID="your-spreadsheet-id"
GOOGLE_SHEETS_MAX_RETRIES="5"

# Google Sheets API Optimization
MAX_AUDIT_LOG_BATCH_SIZE="10"
CACHE_TTL_MS="300000"
CONFIGURATION_CACHE_TTL_MS="900000"

# IntakeQ Integration
INTAKEQ_API_KEY="your-intakeq-api-key"
INTAKEQ_WEBHOOK_SECRET="your-webhook-secret"

# Email Configuration
SENDGRID_API_KEY="your-sendgrid-api-key"
EMAIL_FROM_ADDRESS="scheduler@catalysthealth.care"
EMAIL_FROM_NAME="Catalyst Scheduler"
SCHEDULE_EMAIL_RECIPIENTS="admin@example.com,manager@example.com"

# Webhook Configuration
ENABLE_WEBHOOK_DEDUPLICATION="true"
WEBHOOK_DEDUPLICATION_WINDOW_MINUTES="10"
```

### Important Notes on Environment Variables

1. **GOOGLE_SHEETS_PRIVATE_KEY**:
   - Must include actual newlines, not `\\n` escape sequences
   - If pasting into .env file, use double quotes and include actual line breaks

2. **GOOGLE_SHEETS_CLIENT_EMAIL**:
   - Must have editor access to the Google Sheet

3. **GOOGLE_SHEETS_MAX_RETRIES**:
   - Controls maximum retry attempts for rate limit errors
   - Default: 5

4. **MAX_AUDIT_LOG_BATCH_SIZE**:
   - Number of audit log entries to batch before writing to Google Sheets
   - Default: 10
   - Increasing this value reduces API calls but may delay log entries

5. **INTAKEQ_WEBHOOK_SECRET**:
   - Must match the secret configured in IntakeQ webhook settings

## Webhook Configuration

### IntakeQ Webhook Setup

In IntakeQ administration panel:
1. Navigate to Settings > Integrations > Webhooks
2. Set webhook URL to your deployed application URL + `/api/webhooks/intakeq`
3. Select events to trigger webhooks:
   - Appointment Created
   - Appointment Updated/Rescheduled
   - Appointment Cancelled
   - Appointment Deleted
   - Form Submitted (for accessibility forms)
4. Add webhook secret (must match INTAKEQ_WEBHOOK_SECRET)
5. Verify webhook transmission works correctly

### Webhook Processing Options

The system configuration can adjust webhook processing behavior:

1. **Duplicate Prevention**:
   - Add `ENABLE_WEBHOOK_DEDUPLICATION=true` to enable webhook deduplication
   - Configure `WEBHOOK_DEDUPLICATION_WINDOW_MINUTES=10` to set time window for deduplication

2. **Retry Configuration**:
   - Set `WEBHOOK_MAX_RETRIES=5` to control maximum retry attempts
   - Configure `WEBHOOK_INITIAL_RETRY_DELAY_MS=1000` for initial retry delay
   - Set `WEBHOOK_MAX_RETRY_DELAY_MS=30000` for maximum retry delay

## Apps Script Configuration

### Active_Appointments Synchronization

Configure the Apps Script to maintain the Active_Appointments tab:

1. Open Google Sheets and select Extensions > Apps Script
2. Create a new script with the following code:

```javascript
function setupDailyTrigger() {
  // Delete any existing triggers to avoid duplicates
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'refreshActiveAppointments') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  
  ScriptApp.newTrigger('refreshActiveAppointments')
    .timeBased()
    .atHour(5) // 5 AM
    .nearMinute(45) // at :45 minutes
    .everyDays(1)
    .inTimezone("America/New_York") // Explicitly set EST/EDT timezone
    .create();
  
  Logger.log('Daily trigger for refreshActiveAppointments has been set up');
}

function refreshActiveAppointments() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Get the Appointments sheet
  const appointmentsSheet = ss.getSheetByName('Appointments');
  if (!appointmentsSheet) {
    Logger.log('Error: Appointments sheet not found');
    return;
  }
  
  // Get or create the Active_Appointments sheet
  let activeSheet = ss.getSheetByName('Active_Appointments');
  if (!activeSheet) {
    Logger.log('Creating new Active_Appointments sheet');
    activeSheet = ss.insertSheet('Active_Appointments');
  }
  
  // Get all data from Appointments sheet
  const data = appointmentsSheet.getDataRange().getValues();
  const headers = data[0];
  
  // Copy headers to Active_Appointments
  activeSheet.clear();
  activeSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  
  // Find column indices
  const startTimeCol = headers.indexOf('startTime');
  const endTimeCol = headers.indexOf('endTime');
  const statusCol = headers.indexOf('status');
  
  if (startTimeCol === -1 || statusCol === -1) {
    Logger.log('Error: Required columns not found in Appointments sheet');
    return;
  }
  
  // Get today's date (in EST/EDT timezone)
  const today = new Date();
  const timeZone = ss.getSpreadsheetTimeZone() || 'America/New_York';
  const todayStr = Utilities.formatDate(today, timeZone, 'yyyy-MM-dd');
  
  Logger.log(`Refreshing Active_Appointments for ${todayStr}`);
  
  // Filter for today's appointments that aren't cancelled or rescheduled
  const todayAppointments = data.slice(1).filter(row => {
    if (!row[startTimeCol]) return false;
    
    let startTime = row[startTimeCol];
    let startDateStr = '';
    
    // Handle different date formats
    if (typeof startTime === 'string') {
      // Format: "2023-03-20 14:30" or "2023-03-20T14:30:00Z"
      startDateStr = startTime.split('T')[0].split(' ')[0]; // Get the date part
    } else if (startTime instanceof Date) {
      startDateStr = Utilities.formatDate(startTime, timeZone, 'yyyy-MM-dd');
    } else {
      return false;
    }
    
    // Check status - exclude cancelled and rescheduled
    const status = row[statusCol];
    const validStatus = status !== 'cancelled' && 
                       status !== 'rescheduled' && 
                       status !== 'deleted';
    
    return startDateStr === todayStr && validStatus;
  });
  
  // Add today's appointments to Active_Appointments
  if (todayAppointments.length > 0) {
    activeSheet.getRange(2, 1, todayAppointments.length, headers.length)
      .setValues(todayAppointments);
  }
  
  // Add timestamp and count
  activeSheet.getRange(1, headers.length + 2).setValue('Last Updated:');
  activeSheet.getRange(1, headers.length + 3).setValue(new Date());
  activeSheet.getRange(2, headers.length + 2).setValue('Appointment Count:');
  activeSheet.getRange(2, headers.length + 3).setValue(todayAppointments.length);
  
  // Clean up previous days' appointments from the main Appointments sheet
  Logger.log('Cleaning up past appointments from main Appointments sheet');
  
  // Build list of rows to keep (today and future)
  let keepRows = [1]; // Always keep header row (row 1)
  
  // Track which rows to keep (today and future appointments)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    
    // Skip rows without valid start time
    if (!row[startTimeCol]) continue;
    
    // Get appointment date
    let startTime = row[startTimeCol];
    let appointmentDate;
    
    // Parse the date from different formats
    if (typeof startTime === 'string') {
      appointmentDate = startTime.split('T')[0].split(' ')[0]; // Get date part
    } else if (startTime instanceof Date) {
      appointmentDate = Utilities.formatDate(startTime, timeZone, 'yyyy-MM-dd');
    } else {
      continue; // Skip invalid dates
    }
    
    // Compare with today
    if (appointmentDate >= todayStr) {
      // Keep this row (today or future date)
      keepRows.push(i + 1); // Add 1 because sheets are 1-indexed
    }
  }
  
  // If we found rows to remove
  if (keepRows.length < data.length) {
    // Create new data array with only the rows we want to keep
    const newData = keepRows.map(rowIndex => data[rowIndex - 1]);
    
    // Clear the Appointments sheet and rewrite with only the rows we're keeping
    appointmentsSheet.clearContents();
    appointmentsSheet.getRange(1, 1, newData.length, headers.length).setValues(newData);
    
    Logger.log(`Cleaned up ${data.length - keepRows.length} past appointments from Appointments sheet`);
  } else {
    Logger.log('No past appointments to clean up from Appointments sheet');
  }
  
  Logger.log(`Refreshed Active_Appointments with ${todayAppointments.length} appointments for today (${todayStr})`);
}

function onEdit(e) {
  // Only run if the edit was on the Appointments sheet
  const sheet = e.source.getActiveSheet();
  if (sheet.getName() !== 'Appointments') return;
  
  // Check if we need to update
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  const startTimeCol = headers.indexOf('startTime') + 1; // 1-indexed
  const statusCol = headers.indexOf('status') + 1; // 1-indexed
  
  // Only run if the edited cell is in a relevant column or if we don't know the edited range
  if (e.range && 
     (e.range.getColumn() === startTimeCol || 
      e.range.getColumn() === statusCol || 
      e.range.getColumn() === 0)) { // 0 means we don't know
    
    Logger.log('Relevant edit detected in Appointments sheet, refreshing Active_Appointments');
    refreshActiveAppointments();
  }
}

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Scheduler Tools')
    .addItem('Refresh Active Appointments', 'refreshActiveAppointments')
    .addItem('Setup Daily Refresh', 'setupDailyTrigger')
    .addToUi();
}
```

3. Run `setupDailyTrigger()` function once to create the daily schedule
4. Test `refreshActiveAppointments()` manually to verify it works

## Operational Configuration

### Scheduled Tasks

The system runs these scheduled tasks:

1. **5:45 AM EST**: Active_Appointments refresh (via Apps Script)
   - Clears and rebuilds Active_Appointments tab
   - Removes past appointments from main Appointments tab
   - Preserves today's and future appointments

2. **6:00 AM EST**: Daily schedule email
   - Generates and sends daily schedule
   - Configured in `scheduler-service.ts`

Configure task timing in the `scheduler-service.ts` file:

```typescript
// In scheduler-service.ts

private initializeScheduledTasks(): void {
  // Generate daily schedule at 6:00 AM EST
  cron.schedule('0 6 * * *', async () => {
    await this.runWithLock('daily-schedule', async () => {
      console.log('Running daily schedule generation task');
      await this.generateDailyScheduleOnDemand();
    });
  });
}
```

### Email Configuration

1. **Daily Schedule Email**:
   - Recipients configured via `SCHEDULE_EMAIL_RECIPIENTS` env variable
   - Can also be configured in Integration_Settings sheet
   - Setting: `email/daily_schedule_recipients`

2. **Error Notifications**:
   - Recipients configured via `ERROR_EMAIL_RECIPIENTS` env variable
   - Can also be configured in Integration_Settings sheet
   - Setting: `email/error_notification_recipients`

## Google Sheets API Optimization

The system includes several optimizations to reduce Google Sheets API usage:

### 1. Audit Log Batching

Groups multiple audit log entries into batched writes:

```
MAX_AUDIT_LOG_BATCH_SIZE=10 # Default batch size
```

### 2. Memory Caching

Caches frequently accessed data:

```
CACHE_TTL_MS=300000              # 5 minutes for general data
CONFIGURATION_CACHE_TTL_MS=900000 # 15 minutes for configuration
```

### 3. Rate Limit Handling

Implements exponential backoff for rate limit errors:

```
GOOGLE_SHEETS_MAX_RETRIES=5 # Default max retries
```

### 4. Apps Script Cleanup

Uses Apps Script to handle bulk operations instead of API calls:
- Runs daily at 5:45 AM EST
- Removes past appointments from main Appointments tab
- Rebuilds Active_Appointments tab

## IntakeQ Integration

### Required IntakeQ Permissions

The API key needs these permissions:
- Read Appointments
- Read Clients
- Read Forms/Questionnaires
- Read Practitioners

### Rate Limiting Considerations

- The IntakeQ API has a limit of 120 requests per minute
- The system implements exponential backoff for API failures
- Configure rate limits in the IntakeQ service:

```typescript
// In lib/intakeq/service.ts

// Rate limiting configuration
private readonly MAX_REQUESTS_PER_MINUTE = 120;
private readonly REQUEST_TRACKING_WINDOW_MS = 60000; // 1 minute
private requestTimestamps: number[] = [];
```

## Google Sheets Access

### Service Account Setup

1. Create a service account in Google Cloud Console
2. Grant it editor access to the target Google Sheet
3. Download the JSON key file
4. Extract client_email and private_key for environment variables

### Sharing the Spreadsheet

1. Share the Google Sheet with the service account email
2. Grant Editor permission
3. Disable "Notify people" option when sharing

## Troubleshooting

### Common Issues

1. **Office Assignment Not Working**:
   - Check Client_Accessibility_Info for correct clientId
   - Verify Assignment_Rules have correct syntax
   - Check if office is marked as inService

2. **IntakeQ Webhook Failures**:
   - Verify INTAKEQ_WEBHOOK_SECRET matches IntakeQ setting
   - Check webhook URL is correctly configured
   - Examine error logs for rate limiting issues

3. **Google Sheets API Errors**:
   - Check for "Rate limit hit" entries in logs
   - Verify service account has correct permissions
   - Check GOOGLE_SHEETS_PRIVATE_KEY format (newlines)
   - Consider increasing MAX_AUDIT_LOG_BATCH_SIZE

4. **Duplicate Appointments**:
   - Enable webhook deduplication with ENABLE_WEBHOOK_DEDUPLICATION=true
   - Check for race conditions with appointment locking
   - Verify Active_Appointments synchronization
   - Run `cleanupDuplicateAppointments()` manually

### Error Logging

All errors are logged to:
1. Console logs
2. Audit_Log sheet with eventType = "SYSTEM_ERROR"
3. Error notification emails (if configured)

### Health Check Endpoints

Use these endpoints to verify system health:

1. **Webhook Health**: `/api/webhooks/health`
2. **Scheduling Health**: `/api/scheduling/health`
3. **API Rate Limits**: `/api/maintenance/diagnostics/api-usage`