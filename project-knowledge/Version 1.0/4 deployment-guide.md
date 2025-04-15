# Catalyst Scheduler Deployment Guide

## Hybrid Deployment Strategy

The Catalyst Scheduler employs a hybrid deployment approach:
1. **Initial Phase**: Render-based deployment for simplicity and cost-effectiveness
2. **Scale Phase**: Google Cloud Platform (GCP) for improved reliability and scalability

## Render Deployment (Initial Phase)

### Configuration

```yaml
# render.yaml
services:
  - type: web
    name: catalyst-scheduler
    env: node
    plan: starter # $7/month, eliminates cold starts
    buildCommand: npm install && npm run build
    startCommand: node dist/server.js
    healthCheckPath: /api/webhooks/health
    envVars:
      - key: NODE_ENV
        value: production
      - key: INTAKEQ_API_KEY
        sync: false  # Marks as secret
      - key: INTAKEQ_WEBHOOK_SECRET
        sync: false  # Marks as secret
      - key: GOOGLE_SHEETS_PRIVATE_KEY
        sync: false  # Marks as secret
      - key: GOOGLE_SHEETS_CLIENT_EMAIL
        sync: false
      - key: GOOGLE_SHEETS_SPREADSHEET_ID
        sync: false
      - key: SENDGRID_API_KEY
        sync: false
      - key: EMAIL_FROM_ADDRESS
        value: "scheduler@catalysthealth.care"
      - key: EMAIL_FROM_NAME
        value: "Catalyst Scheduler"
      - key: MAX_AUDIT_LOG_BATCH_SIZE
        value: "10"
      - key: GOOGLE_SHEETS_MAX_RETRIES
        value: "5"
```

### Environment Variable Setup

For Google Sheets integration:
- GOOGLE_SHEETS_PRIVATE_KEY: Must include actual newlines, not escape sequences
- GOOGLE_SHEETS_CLIENT_EMAIL: Service account email
- GOOGLE_SHEETS_SPREADSHEET_ID: ID of target Google Sheet
- GOOGLE_SHEETS_MAX_RETRIES: Maximum retry attempts for rate limits (default: 5)
- MAX_AUDIT_LOG_BATCH_SIZE: Number of audit logs to batch (default: 10)

For IntakeQ integration:
- INTAKEQ_API_KEY: API key from IntakeQ
- INTAKEQ_WEBHOOK_SECRET: Secret for webhook signatures

For email service:
- SENDGRID_API_KEY: API key from SendGrid
- EMAIL_FROM_ADDRESS: Sender email address
- EMAIL_FROM_NAME: Sender display name

### IntakeQ Webhook Configuration

In IntakeQ administration panel:
1. Navigate to Settings > Integrations > Webhooks
2. Set webhook URL to `https://catalyst-scheduler.onrender.com/api/webhooks/intakeq`
3. Select relevant events:
   - Appointment Created
   - Appointment Updated
   - Appointment Rescheduled
   - Appointment Cancelled
   - Appointment Deleted
   - Form Submitted (for client accessibility forms)
4. Configure secret key (must match INTAKEQ_WEBHOOK_SECRET)
5. Verify webhook transmission

### Google Sheets Setup

Service account requirements:
1. Create a service account in Google Cloud Console
2. Grant it editor access to the target Google Sheet
3. Generate and download private key in JSON format
4. Extract client_email and private_key for environment variables

### Apps Script Setup for Active_Appointments

1. Open the Google Sheet containing Appointments
2. Select Extensions > Apps Script
3. Create a new script with the following code:

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

/**
 * Refreshes the Active_Appointments tab with today's appointments
 * This runs automatically at 5:45 AM and can be run manually as needed
 */
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
    
    // Set formatting to match Appointments sheet
    try {
      const sourceFormat = appointmentsSheet.getRange(1, 1, 1, headers.length);
      const targetFormat = activeSheet.getRange(1, 1, 1, headers.length);
      sourceFormat.copyFormatToRange(activeSheet, 1, headers.length, 1, 1);
    } catch (e) {
      Logger.log('Warning: Could not copy formatting - ' + e.toString());
    }
  }
  
  // Add timestamp and count
  activeSheet.getRange(1, headers.length + 2).setValue('Last Updated:');
  activeSheet.getRange(1, headers.length + 3).setValue(new Date());
  activeSheet.getRange(2, headers.length + 2).setValue('Appointment Count:');
  activeSheet.getRange(2, headers.length + 3).setValue(todayAppointments.length);
  
  // Clean up previous days' appointments from the main Appointments sheet
  // We keep header row (index 1) and filter remaining rows to keep only today's appointments
  // and appointments that haven't happened yet (future appointments)
  
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

/**
 * Updates Active_Appointments when the Appointments sheet is edited
 * This keeps the Active_Appointments tab in sync throughout the day
 */
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

/**
 * Creates a custom menu for manual refresh
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Scheduler Tools')
    .addItem('Refresh Active Appointments', 'refreshActiveAppointments')
    .addItem('Setup Daily Refresh', 'setupDailyTrigger')
    .addToUi();
}
```

4. Run `setupDailyTrigger()` function once to create the daily schedule
5. Test `refreshActiveAppointments()` manually to verify it works

## GCP Deployment (Scale Phase)

### Service Architecture

```
[Cloud Run] → [Cloud Tasks] → [Cloud Run Workers]
     ↓              ↑
[Secret Manager]    ↓
     ↓         [Retry Queue]
[Google Sheets API]
```

### Migration Steps

#### 1. Containerize Application

```dockerfile
# Dockerfile
FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY dist/ ./dist/

# Set environment variables
ENV PORT=8080
ENV NODE_ENV=production

# Start the application
CMD ["node", "dist/server.js"]
```

#### 2. Set Up Google Cloud Project

```bash
# Create new project
gcloud projects create catalyst-scheduler --name="Catalyst Scheduler"

# Set as current project
gcloud config set project catalyst-scheduler

# Enable required APIs
gcloud services enable run.googleapis.com cloudtasks.googleapis.com secretmanager.googleapis.com sheets.googleapis.com
```

#### 3. Set Up Secret Manager

```bash
# Create secrets
echo -n "$INTAKEQ_API_KEY" | gcloud secrets create intakeq-api-key --data-file=-
echo -n "$INTAKEQ_WEBHOOK_SECRET" | gcloud secrets create intakeq-webhook-secret --data-file=-
echo -n "$GOOGLE_SHEETS_PRIVATE_KEY" | gcloud secrets create google-sheets-private-key --data-file=-
echo -n "$GOOGLE_SHEETS_CLIENT_EMAIL" | gcloud secrets create google-sheets-client-email --data-file=-
echo -n "$GOOGLE_SHEETS_SPREADSHEET_ID" | gcloud secrets create google-sheets-spreadsheet-id --data-file=-
echo -n "$SENDGRID_API_KEY" | gcloud secrets create sendgrid-api-key --data-file=-
```

#### 4. Deploy to Cloud Run

```bash
# Build and push Docker image
gcloud builds submit --tag gcr.io/catalyst-scheduler/scheduler

# Deploy to Cloud Run
gcloud run deploy catalyst-scheduler \
  --image gcr.io/catalyst-scheduler/scheduler \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 1 \
  --timeout 300s \
  --set-secrets="INTAKEQ_API_KEY=intakeq-api-key:latest" \
  --set-secrets="INTAKEQ_WEBHOOK_SECRET=intakeq-webhook-secret:latest" \
  --set-secrets="GOOGLE_SHEETS_PRIVATE_KEY=google-sheets-private-key:latest" \
  --set-secrets="GOOGLE_SHEETS_CLIENT_EMAIL=google-sheets-client-email:latest" \
  --set-secrets="GOOGLE_SHEETS_SPREADSHEET_ID=google-sheets-spreadsheet-id:latest" \
  --set-secrets="SENDGRID_API_KEY=sendgrid-api-key:latest" \
  --set-env-vars="EMAIL_FROM_ADDRESS=scheduler@catalysthealth.care,EMAIL_FROM_NAME=Catalyst Scheduler,MAX_AUDIT_LOG_BATCH_SIZE=10,GOOGLE_SHEETS_MAX_RETRIES=5"
```

#### 5. Set Up Cloud Tasks Queue

```bash
# Create Cloud Tasks queue for webhook processing
gcloud tasks queues create webhook-processing-queue \
  --location=us-central1 \
  --max-attempts=5 \
  --min-backoff=10s \
  --max-backoff=300s \
  --max-doublings=5

# Create retry queue
gcloud tasks queues create webhook-retry-queue \
  --location=us-central1 \
  --max-attempts=5 \
  --min-backoff=60s \
  --max-backoff=300s \
  --max-doublings=3

# Set up IAM permissions for Cloud Tasks
gcloud run services add-iam-policy-binding catalyst-scheduler \
  --member="serviceAccount:service-PROJECT_NUMBER@gcp-sa-cloudtasks.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

## Migration Triggers

Consider migrating from Render to GCP when:

### Volume-Based Triggers
- Webhook volume exceeds 1,000 per day consistently
- API requests exceed 10,000 per day
- Response times exceed 2 seconds consistently

### Reliability Triggers
- Webhook processing errors > 1%
- Google Sheets connectivity errors > 0.5%
- Email delivery failures > 1%
- Google Sheets API rate limit errors persist despite optimizations

### Business Requirement Triggers
- Need for SOC 2 compliance or enhanced security
- SLA commitments required
- Advanced monitoring and alerting needed

## Performance Comparison

### Webhook Processing

| Metric | Render (Starter) | GCP (Cloud Run) |
|--------|-----------------|----------------|
| Cold Start | None (paid plan) | ~0-2s (0s with min instances) |
| Max Processing Time | 30 minutes | 60 minutes |
| Concurrent Requests | Limited (10) | Unlimited (auto-scales) |
| Memory Limits | 512 MB | Up to 32 GB |
| CPU Limits | 0.5-1 vCPU | Up to 8 vCPU |

### Cost Analysis

| Usage Level | Render | GCP (Cloud Run + Services) |
|-------------|--------|----------------------------|
| Low (500 webhooks/day) | $7/month fixed | ~$1-5/month |
| Medium (5,000 webhooks/day) | $7/month fixed | ~$5-15/month |
| High (20,000+ webhooks/day) | $29/month | ~$40-60/month |

## Deployment Checklist

### Common Pre-Deployment Tasks

1. **Validate Environment Variables**:
   - GOOGLE_SHEETS_PRIVATE_KEY (with proper newlines)
   - GOOGLE_SHEETS_CLIENT_EMAIL
   - GOOGLE_SHEETS_SPREADSHEET_ID
   - INTAKEQ_API_KEY
   - INTAKEQ_WEBHOOK_SECRET
   - SENDGRID_API_KEY
   - EMAIL settings
   - Google Sheets optimization parameters (MAX_AUDIT_LOG_BATCH_SIZE, GOOGLE_SHEETS_MAX_RETRIES)

2. **Run Integration Tests**:
   - Test IntakeQ webhook processing
   - Test Google Sheets operations
   - Test office assignment algorithm
   - Test email notifications

3. **Build Production Assets**:
   ```bash
   npm run build
   ```

### Render Deployment

1. **Push Code to GitHub**
2. **Create New Web Service in Render Dashboard**
3. **Configure Environment Variables**
4. **Set Resource Allocation** (Starter plan recommended)
5. **Configure Health Check** (Path: `/api/webhooks/health`)
6. **Verify Deployment**
7. **Update IntakeQ Webhook URL**
8. **Monitor Initial Webhook Processing**

### GCP Deployment

1. **Containerize Application**
2. **Set Up Google Cloud Project**
3. **Configure Secret Manager**
4. **Deploy to Cloud Run**
5. **Set Up Cloud Tasks Queue**
6. **Test Deployment**
7. **Update IntakeQ Configuration**
8. **Monitor Webhook Processing and Performance**

## Webhook Monitoring

After deployment, monitor webhook processing to ensure reliability:

1. **Webhook Health Endpoint**:
   - `/api/webhooks/health` should return status 200
   - Contains webhook processing statistics
   - Shows success/failure rates
   - Displays average processing time

2. **Recent Webhooks Endpoint**:
   - `/api/webhooks/recent` shows recently processed webhooks
   - Use for debugging webhook issues
   - Check for duplicate processing

3. **Audit Log**:
   - Check Audit_Log sheet for webhook-related entries
   - Filter by eventType containing "WEBHOOK"
   - Monitor for batch processing entries

4. **Daily Schedule Emails**:
   - Monitor for mentions of duplicate appointments
   - Check for office assignment issues

## Google Sheets API Quota Management

To monitor and adjust Google Sheets API usage:

1. **Check Rate Limit Logs**:
   - Look for "Rate limit hit" entries in the logs
   - Monitor exponential backoff patterns
   - Adjust GOOGLE_SHEETS_MAX_RETRIES if needed

2. **Audit Log Batch Size**:
   - Default batch size is 10 entries
   - Can be increased to reduce API calls
   - Monitor for batch processing in logs

3. **Sheet Usage Dashboard**:
   - Create a simple dashboard sheet to track API usage
   - Record daily API call counts
   - Monitor for trends over time

4. **Apps Script Performance**:
   - Monitor Apps Script execution logs
   - Verify daily cleanup is working properly
   - Check execution time trends