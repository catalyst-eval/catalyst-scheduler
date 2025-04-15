# Catalyst Scheduler: Comprehensive Architecture

## System Architecture Overview

The Catalyst Scheduler is a specialized system designed to intelligently assign therapy office spaces based on client needs, clinician preferences, and office availability. The architecture has evolved to prioritize reliability, efficiency, and Google Sheets API quota management.

### Core Components

1. **Node.js Express Backend**
   - Handles API endpoints and webhook processing
   - Implements business logic for office assignment
   - Manages scheduled tasks
   - Interacts with external systems

2. **Google Sheets Database**
   - Acts as primary data store
   - Contains configuration, client data, and appointments
   - Provides audit logging
   - Enables easy manual data adjustments

3. **Apps Script Integration**
   - Refreshes the Active_Appointments tab
   - Cleans up past appointments
   - Synchronizes data between tabs
   - Reduces API calls from Node.js

4. **IntakeQ Integration**
   - Receives appointments via webhooks
   - Fetches additional data via API
   - Provides client information
   - Sources form submissions for accessibility needs

5. **Email Notification System**
   - Sends daily schedule reports
   - Delivers error notifications
   - Provides system status updates
   - Uses SendGrid for reliable delivery

### Deployment Architecture

The system employs a hybrid deployment approach:

```
┌─────────────────┐                      ┌─────────────────┐
│                 │  Webhooks/API Calls  │                 │
│     IntakeQ     │◄────────────────────┤    Catalyst     │
│  (Appointment   │                     │    Scheduler    │
│     System)     │                     │  (Render.com)   │
└─────────────────┘                     └────────┬────────┘
                                                 │
                                                 │ Google Sheets API
                                                 ▼
┌─────────────────────────────────────────────────────────┐
│                Google Sheets Database                   │
│                       ┌─────────┐                       │
│                       │ Apps    │                       │
│                       │ Script  │                       │
│                       └─────────┘                       │
└─────────────────────────────────────────────────────────┘
                             │
                             │ Email Notifications
                             ▼
                     ┌──────────────────┐
                     │     SendGrid     │
                     └──────────────────┘
```

## Data Architecture

### Google Sheets Structure

The system uses a structured Google Sheets database with the following tabs:

#### 1. Configuration Sheets
- **Offices_Configuration**: Office details and capabilities
- **Clinicians_Configuration**: Provider profiles and preferences
- **Assignment_Rules**: Prioritized assignment logic
- **Schedule_Configuration**: System-wide settings
- **Integration_Settings**: External system configurations

#### 2. Client Data
- **Client_Accessibility_Info**: Client accessibility needs and preferences

#### 3. Operational Data
- **Appointments**: Appointment records with office assignments
- **Active_Appointments**: Mirror of today's appointments for performance
- **Audit_Log**: System activity tracking

### Data Flow

The primary data flow follows this pattern:

1. **Webhook-Driven Appointment Updates**:
   ```
   IntakeQ Webhook → Catalyst Scheduler → Office Assignment Algorithm → Google Sheets
                                                                      (Appointments and Active_Appointments)
   ```

2. **Daily Schedule Generation**:
   ```
   Scheduled Task → Retrieve Appointments from Active_Appointments → Office Assignment → 
   Email Generation → SendGrid
   ```

3. **Client Data Updates**:
   ```
   IntakeQ Form Submission → Webhook → Client_Accessibility_Info Update
   ```

## Application Architecture

### Component Organization

The code is organized in a modular structure:

```
src/
├── lib/                # Core library code
│   ├── google/         # Google Sheets integration
│   ├── intakeq/        # IntakeQ integration
│   ├── scheduling/     # Scheduling logic
│   ├── email/          # Email generation
│   └── util/           # Utility functions
├── routes/             # API routes
├── middleware/         # Express middleware
├── types/              # TypeScript type definitions
└── server.ts           # Main server entry point
```

### Key Components and Responsibilities

#### 1. Google Sheets Integration (`src/lib/google/sheets.ts`)

This component manages all interactions with the Google Sheets API:

- **`SheetsService` class**: Core integration with Google Sheets API
  - `updateAppointment(appointment)`: Updates appointments with retry logic and transaction-like semantics
  - `addAppointment(appointment)`: Adds new appointments to both Appointments and Active_Appointments when relevant
  - `getAppointments(filter)`: Retrieves appointments matching specific criteria
  - `addAuditLog(entry)`: Records system activity with batching to reduce API calls
  - `flushAuditLogs()`: Processes pending audit logs in batch

- **`SheetsCache` class**: Caching layer to reduce API calls
  - `getOrFetch(key, fetchFn, ttl)`: Retrieves from cache or fetches if not available
  - `refreshCache(key)`: Invalidates cache entries
  - `preloadCommonData()`: Loads frequently accessed configuration data

#### 2. Office Assignment Engine (`src/lib/scheduling/daily-schedule-service.ts`)

This component handles the core business logic of office assignment:

- **`DailyScheduleService` class**: Office assignment algorithm
  - `generateDailySchedule(date)`: Creates daily schedule for a specific date
  - `resolveOfficeAssignments(appointments)`: Applies rule-based algorithm to assign offices
  - `detectConflicts(appointments)`: Identifies scheduling conflicts
  - `isOfficeAvailable(officeId, appointment, allAppointments)`: Checks availability for a time slot

- **`getRuleMatch(rule, appointment, offices, clinicians, clientPreferences)`: Rule evaluation logic
  - Evaluates each rule against appointment data
  - Determines if rule conditions are met
  - Returns matching offices based on rule criteria

#### 3. IntakeQ Integration (`src/lib/intakeq/*`)

This component handles all interactions with the IntakeQ system:

- **`IntakeQService` class**: API client for IntakeQ
  - `getAppointments(startDate, endDate, status)`: Fetches appointments from IntakeQ API
  - `getClient(clientId)`: Retrieves client information
  - `validateWebhookSignature(payload, signature)`: Verifies webhook authenticity

- **`WebhookHandler` class**: Processes webhooks from IntakeQ
  - `processWebhook(payload, signature)`: Main webhook handling with idempotency checks
  - `processAppointmentEvent(payload)`: Handles appointment-related events
  - `processIntakeFormSubmission(payload)`: Processes form submissions

- **`AppointmentSyncHandler` class**: Synchronizes appointment data
  - `handleNewAppointment(appointment)`: Creates new appointment records
  - `handleAppointmentUpdate(appointment)`: Updates existing appointments
  - `handleAppointmentCancellation(appointment)`: Processes cancellations
  - `withLock(appointmentId, operation)`: Prevents concurrent processing of the same appointment

#### 4. Email System (`src/lib/email/*`)

This component handles email generation and delivery:

- **`EmailService` class**: Email delivery via SendGrid
  - `sendEmail(recipients, template, options)`: Sends emails with retry logic
  - `getScheduleRecipients()`: Retrieves configured recipients for daily schedules

- **`EmailTemplates` class**: Template generation
  - `dailySchedule(data)`: Creates enhanced daily schedule email
  - `generatePriorityReferenceTable()`: Creates assignment rule explanation
  - `filterDuplicates(appointments)`: Removes duplicate appointments during rendering
  - `getOfficeChangeStyle(appointment)`: Determines visual styling for office changes

#### 5. Scheduled Tasks (`src/lib/scheduling/scheduler-service.ts`)

This component manages recurring system tasks:

- **`SchedulerService` class**: Task scheduling and execution
  - `initialize()`: Sets up scheduled tasks using node-cron
  - `combinedDailyTask()`: Executes daily schedule generation
  - `runWithLock(taskName, task)`: Prevents concurrent execution
  - `generateDailyScheduleOnDemand(date)`: Creates and sends daily schedule email

#### 6. API Layer (`src/routes/*`)

This component exposes the system's functionality via HTTP:

- **Webhook Routes**: Process incoming webhooks
  - `processIntakeQWebhook(req, res)`: Handles IntakeQ webhooks
  - `validateWebhookSignature(req, res, next)`: Middleware for signature verification

- **Scheduling Routes**: Provide scheduling operations
  - `generateDailySchedule(req, res)`: API for manual schedule generation
  - `resolveConflicts(req, res)`: API for conflict resolution

#### 7. Utility Functions (`src/lib/util/*`)

Various utilities that support the system:

- **Date Utilities**: Handle date manipulations
  - `toEST(date)`: Converts dates to Eastern Time
  - `doTimeRangesOverlap(range1, range2)`: Checks for scheduling conflicts

- **Office ID Utilities**: Standardize office identifiers
  - `standardizeOfficeId(id)`: Normalizes office ID format
  - `isValidOfficeId(id)`: Validates office ID format

- **Error Recovery**: Handles operation retries
  - `recordFailedOperation(type, data, error)`: Records operation for later recovery
  - `attemptRecovery()`: Tries to recover failed operations

#### 8. Apps Script Integration

Google Apps Script code running within Google Sheets:

- **`refreshActiveAppointments()`**: Primary function that:
  - Clears and rebuilds the Active_Appointments tab with today's appointments
  - Removes past appointments from the main Appointments tab
  - Adds timestamp and appointment count

- **`setupDailyTrigger()`**: Configures the daily refresh to run at 5:45 AM EST
- **`onEdit(e)`**: Keeps Active_Appointments in sync when manual edits occur

## Module Interaction Flow

### 1. Webhook Processing Flow

The system primarily operates through webhook events that trigger updates:

```
┌───────────────────┐
│ IntakeQ Webhook   │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ webhook.ts Routes │  Validates signature, returns immediate 200 OK response
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ WebhookHandler    │  Determines event type, validates payload
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ AppointmentSync   │  Processes appointment events with locking
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ SheetsService     │  Updates Google Sheets with retry logic
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Audit Log Batch   │  Records activity in batches
└───────────────────┘
```

### 2. Daily Schedule Generation Flow

The scheduled task for daily office assignment follows this flow:

```
┌───────────────────┐
│ SchedulerService  │  Initiates daily schedule task at 6:00 AM EST
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ SheetsService     │  Retrieves appointments from Active_Appointments
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ DailySchedule     │  Assigns offices based on priority rules
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ EmailTemplates    │  Generates enhanced email with color coding
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ EmailService      │  Sends email via SendGrid with retry logic
└───────────────────┘
```

### 3. Apps Script Daily Refresh Flow

The Apps Script handles cleanup and synchronization:

```
┌───────────────────┐
│ setupDailyTrigger │  Sets up trigger for 5:45 AM EST
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ refreshActive-    │  
│ Appointments      │  Triggered daily at 5:45 AM EST
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Clear Active_     │  Removes all data from Active_Appointments
│ Appointments      │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Filter Today's    │  Gets today's non-cancelled appointments
│ Appointments      │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Populate Active_  │  Copies today's appointments to Active_Appointments
│ Appointments      │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Clean Past        │  Removes past appointments from main Appointments tab
│ Appointments      │
└───────────────────┘
```

## Office Assignment Architecture

### Core Assignment Algorithm Flow

The office assignment algorithm follows this sequence:

```
┌───────────────────┐
│ Appointment Data  │  Appointment from IntakeQ with client, time, type
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Client Info       │  Accessibility needs, age, office preferences
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Clinician Info    │  Preferred offices, specialties
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Rule Evaluation   │  Evaluates rules in strict priority order
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Office Assignment │  Assigns best matching office
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Conflict Detection│  Checks for scheduling conflicts
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Updates Google    │  Records final assignment in both sheets
│ Sheets            │
└───────────────────┘
```

### Priority Rule Evaluation

Rules are processed in strict priority order:

1. **Priority 100**: Client-Specific Requirements
   - Checks `accessibilityNotes` field in Client_Accessibility_Info for explicit office assignments

2. **Priority 90**: Accessibility Requirements
   - For clients with mobility needs from Client_Accessibility_Info
   - Assigns accessible offices (typically B-4, C-3)

3. **Priority 80**: Young Children
   - For children age ≤ 10
   - Assigns child-friendly offices (typically B-5)

4. **Priority 75**: Older Children and Teens
   - For clients age 11-17
   - Assigns teen-appropriate offices (typically C-1)

5. **Priority 70**: Adult Client Assignments
   - For adult clients (≥18)
   - Assigns appropriate adult offices (typically B-4, C-2, C-3)

6. **Priority 65**: Clinician Primary Office
   - Uses clinician's primary office if available

7. **Priority 62**: Clinician Preferred Office
   - Uses one of clinician's preferred offices if available

8. **Priority 55-10**: Lower Priority Rules
   - Various additional criteria like in-person priority, telehealth handling, etc.

## Google Sheets API Management

To handle Google Sheets API quotas effectively, the system employs several strategies:

### 1. Audit Log Batching

Instead of individual writes for each audit log entry:

```javascript
// Batched audit logging
async addAuditLog(entry: AuditLogEntry): Promise<void> {
  // Add to pending batch
  this.pendingAuditLogs.push(entry);
  
  // Process batch if limit reached or on timer
  if (this.pendingAuditLogs.length >= this.MAX_BATCH_SIZE) {
    await this.flushAuditLogs();
  } else if (!this.auditLogTimer) {
    this.auditLogTimer = setTimeout(() => this.flushAuditLogs(), 5000);
  }
}

// Process batched logs
async flushAuditLogs(): Promise<void> {
  if (this.pendingAuditLogs.length === 0) return;
  
  const logs = [...this.pendingAuditLogs];
  this.pendingAuditLogs = [];
  
  try {
    await this.appendRows(`${SHEET_NAMES.AUDIT_LOG}!A:G`, 
      logs.map(log => this.auditLogToRow(log)));
      
    if (this.auditLogTimer) {
      clearTimeout(this.auditLogTimer);
      this.auditLogTimer = null;
    }
  } catch (error) {
    // On error, put logs back in queue
    this.pendingAuditLogs = [...logs, ...this.pendingAuditLogs];
    throw error;
  }
}
```

### 2. Retry Logic with Exponential Backoff

For handling rate limits and transient errors:

```javascript
async updateAppointment(appointment: AppointmentRecord, retryCount: number = 0): Promise<void> {
  const maxRetries = 5;
  
  try {
    // Attempt to update appointment
    await this.updateRow(
      `${SHEET_NAMES.APPOINTMENTS}!A:R`,
      appointment.appointmentId,
      this.appointmentToRow(appointment)
    );
    
    // Update Active_Appointments if for today
    if (this.isAppointmentForToday(appointment)) {
      await this.updateActiveAppointment(appointment);
    }
  } catch (error) {
    const isRateLimit = error.message?.includes('RATE_LIMIT') || 
                      error.message?.includes('Quota exceeded');
    
    // Retry with exponential backoff for rate limit errors
    if (isRateLimit && retryCount < maxRetries) {
      const delay = Math.pow(2, retryCount) * 1000;
      console.warn(`Rate limit hit. Retrying in ${delay}ms (${retryCount+1}/${maxRetries})`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return this.updateAppointment(appointment, retryCount + 1);
    }
    
    // Rethrow other errors or after max retries
    throw error;
  }
}
```

### 3. Apps Script for Bulk Operations

Using Apps Script to handle bulk operations instead of API calls:

```javascript
// In Apps Script
function refreshActiveAppointments() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Get the Appointments sheet
  const appointmentsSheet = ss.getSheetByName('Appointments');
  
  // Get or create the Active_Appointments sheet
  let activeSheet = ss.getSheetByName('Active_Appointments');
  
  // Clear existing data
  activeSheet.clear();
  
  // Get all data from Appointments sheet
  const data = appointmentsSheet.getDataRange().getValues();
  const headers = data[0];
  
  // Copy headers
  activeSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  
  // Filter for today's appointments
  const todayAppointments = data.slice(1).filter(row => {
    // Filter logic for today's non-cancelled appointments
  });
  
  // Add today's appointments to Active_Appointments in one batch
  if (todayAppointments.length > 0) {
    activeSheet.getRange(2, 1, todayAppointments.length, headers.length)
      .setValues(todayAppointments);
  }
  
  // Clean up past appointments from main Appointments sheet
  const keepRows = [1]; // Always keep header row
  
  // Keep only today and future appointments
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    // Logic to determine if row should be kept
    if (shouldKeepRow(row)) {
      keepRows.push(i + 1);
    }
  }
  
  // Rewrite the sheet with only kept rows
  appointmentsSheet.clearContents();
  appointmentsSheet.getRange(1, 1, keepRows.length, headers.length)
    .setValues(keepRows.map(rowIndex => data[rowIndex - 1]));
}
```

### 4. Caching for Frequently Accessed Data

Using memory caching to reduce API calls:

```javascript
class SheetsCache {
  private cache: Map<string, { data: any, expires: number }> = new Map();
  
  async getOrFetch<T>(key: string, fetchFn: () => Promise<T>, ttl = 300000): Promise<T> {
    const cached = this.cache.get(key);
    
    // Return from cache if valid
    if (cached && cached.expires > Date.now()) {
      return cached.data as T;
    }
    
    // Fetch fresh data
    const data = await fetchFn();
    
    // Cache with expiration
    this.cache.set(key, {
      data,
      expires: Date.now() + ttl
    });
    
    return data;
  }
  
  // Preload common configuration data
  async preloadCommonData(): Promise<void> {
    await this.getOrFetch('offices', () => this.sheetsService.getOffices());
    await this.getOrFetch('clinicians', () => this.sheetsService.getClinicians());
    await this.getOrFetch('assignmentRules', () => this.sheetsService.getAssignmentRules());
  }
}
```

## Error Handling Architecture

The system employs a comprehensive approach to error handling:

### 1. Structured Error Classes

Custom error classes for different error types:

```typescript
// Base application error
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'UNKNOWN_ERROR',
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Google Sheets specific errors
export class SheetError extends AppError {
  constructor(
    message: string,
    code: string = 'SHEET_ERROR',
    retryable: boolean = true
  ) {
    super(message, code, retryable);
  }
}
```

### 2. Idempotent Operations

Ensures operations can be safely repeated:

```typescript
// Idempotent appointment creation
async handleNewAppointment(appointment: IntakeQAppointment): Promise<WebhookResponse> {
  try {
    // Check if appointment already exists
    const existingAppointment = await this.sheetsService.getAppointment(appointment.Id);
    
    if (existingAppointment) {
      console.log(`Appointment ${appointment.Id} already exists, updating instead`);
      return await this.handleAppointmentUpdate(appointment);
    }
    
    // Convert format and add appointment
    const newAppointment = this.convertToAppointmentRecord(appointment);
    await this.sheetsService.addAppointment(newAppointment);
    
    return { success: true };
  } catch (error) {
    // Handle errors
    console.error(`Error creating appointment ${appointment.Id}:`, error);
    return { success: false, error: error.message };
  }
}
```

### 3. Error Recovery System

Tracks and recovers from failed operations:

```typescript
export class ErrorRecoveryService {
  private pendingRecovery: FailedOperation[] = [];
  
  // Record failed operation
  async recordFailedOperation(type: OperationType, data: any, error: Error): Promise<void> {
    this.pendingRecovery.push({
      type,
      data,
      error: error.message,
      timestamp: new Date().toISOString(),
      attempts: 0
    });
    
    // Write to error log
    await this.logFailedOperation(type, data, error);
  }
  
  // Attempt recovery of all pending operations
  async attemptRecovery(): Promise<RecoveryResult> {
    if (this.pendingRecovery.length === 0) {
      return { recovered: 0, failed: 0 };
    }
    
    const operations = [...this.pendingRecovery];
    this.pendingRecovery = [];
    
    let recovered = 0;
    let failed = 0;
    
    for (const op of operations) {
      try {
        await this.processFailedOperation(op);
        recovered++;
      } catch (error) {
        op.attempts++;
        op.lastError = error.message;
        
        // Keep for retry if under max attempts
        if (op.attempts < this.MAX_RECOVERY_ATTEMPTS) {
          this.pendingRecovery.push(op);
        }
        failed++;
      }
    }
    
    return { recovered, failed };
  }
}
```

## Security Architecture

### 1. Authentication & Authorization

1. **API Authentication**
   - IntakeQ API key authentication
   - Google service account for Sheets access
   - SendGrid API key for email delivery

2. **Webhook Security**
   - HMAC signature verification:
   ```typescript
   function validateWebhookSignature(payload: any, signature: string): boolean {
     const secret = process.env.INTAKEQ_WEBHOOK_SECRET;
     if (!secret) throw new Error('Webhook secret not configured');
     
     const hmac = crypto.createHmac('sha256', secret);
     const digest = hmac.update(JSON.stringify(payload)).digest('hex');
     
     return crypto.timingSafeEqual(
       Buffer.from(digest, 'hex'),
       Buffer.from(signature, 'hex')
     );
   }
   ```

3. **Environment Security**
   - Environment variables for secrets
   - No client-side secret exposure

### 2. Data Protection

1. **Access Controls**
   - Least privilege principle for service accounts
   - Role-based access for Google Sheets

2. **Data Transmission**
   - HTTPS for all communications
   - TLS for email transmission

## Conclusion

The Catalyst Scheduler architecture has evolved to prioritize reliability, efficiency, and Google Sheets API quota management. The system employs a webhook-driven approach with complementary Apps Script integration to optimize the handling of appointment data and office assignments.

By leveraging batched operations, caching, and idempotent design, the system efficiently manages the constraints of the Google Sheets API while providing reliable office assignment services. The combination of Node.js for business logic and Apps Script for bulk operations creates a hybrid architecture that maximizes performance and reliability.
