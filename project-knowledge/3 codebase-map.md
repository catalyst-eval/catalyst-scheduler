# Catalyst Scheduler: Codebase Map

## Repository Structure

The Catalyst Scheduler codebase follows a modular organization with clear separation of concerns:

```
catalyst-scheduler/
├── src/
│   ├── lib/               # Core business logic
│   │   ├── google/        # Google Sheets integration
│   │   ├── intakeq/       # IntakeQ integration
│   │   ├── scheduling/    # Scheduling logic
│   │   ├── email/         # Email system
│   │   └── util/          # Utility functions
│   ├── routes/            # API endpoint handlers
│   │   ├── webhooks/      # Webhook endpoints
│   │   ├── scheduling/    # Scheduling endpoints
│   │   └── maintenance/   # Maintenance endpoints
│   ├── middleware/        # Express middleware
│   ├── types/             # TypeScript type definitions
│   ├── scripts/           # Utility scripts
│   └── server.ts          # Application entry point
├── dist/                  # Compiled JavaScript output
├── tests/                 # Test files
├── .env                   # Local environment variables
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript configuration
└── render.yaml            # Render deployment config
```

## Key Modules and Files

### Core Business Logic (`src/lib/`)

#### Google Sheets Integration (`src/lib/google/`)

- **`sheets.ts`** - Primary interaction with Google Sheets API
  - Handles CRUD operations for all sheets
  - Implements batch operations and retry logic for API rate limits
  - Updates both Appointments and Active_Appointments tabs
  - Manages batched audit logging for operations

- **`sheets-cache.ts`** - Caching layer for Google Sheets
  - Reduces API calls through TTL-based caching
  - Preloads commonly accessed configuration
  - Handles cache invalidation and refresh

#### IntakeQ Integration (`src/lib/intakeq/`)

- **`service.ts`** - IntakeQ API client
  - Fetches appointments and client data
  - Implements rate limiting and error handling
  - Handles API authentication
  - Provides testConnection method

- **`webhook-handler.ts`** - Webhook event processing
  - Validates webhook signatures
  - Routes events to appropriate handlers
  - Processes events asynchronously
  - Implements idempotency checking to prevent duplicates

- **`appointment-sync.ts`** - Appointment synchronization
  - Processes appointment events from webhooks
  - Creates/updates/cancels appointments in Google Sheets
  - Implements appointment locking to prevent race conditions
  - Handles status changes and cancellations

- **`accessibility-scanner.ts`** - Client accessibility processing
  - Scans IntakeQ forms for accessibility information
  - Extracts and normalizes accessibility requirements
  - Updates Client_Accessibility_Info sheet

#### Scheduling Logic (`src/lib/scheduling/`)

- **`daily-schedule-service.ts`** - Core scheduling logic
  - Implements office assignment algorithm
  - Resolves scheduling conflicts
  - Processes appointments for display in email
  - Filters duplicate appointments during rendering

- **`scheduler-service.ts`** - Scheduled tasks
  - Manages daily report generation
  - Relies on webhook-driven updates instead of API refresh
  - Implements duplicate appointment cleanup
  - Contains locking mechanism to prevent concurrent execution

- **`bulk-import-service.ts`** - Consolidated bulk import
  - Handles importing appointments in bulk
  - Replaces previous fragmented import functionality

#### Email System (`src/lib/email/`)

- **`service.ts`** - Email delivery using SendGrid
  - Handles authentication with SendGrid
  - Implements retry logic for failed emails
  - Provides delivery tracking
  - Gets recipient lists from configuration

- **`templates.ts`** - Enhanced email template generation
  - Creates HTML and plain text email content
  - Implements color-coding for clinician sections
  - Adds visual indicators for office changes (red/orange)
  - Includes comprehensive priority level reference table
  - Filters duplicate appointments during rendering

#### Utility Functions (`src/lib/util/`)

- **`date-utils.ts`** - Consolidated date utilities
  - Handles timezone conversions
  - Provides date formatting functions
  - Implements date range operations
  - Checks for overlapping time ranges

- **`office-id.ts`** - Office ID standardization
  - Validates office ID formats
  - Normalizes different office ID representations
  - Provides office ID parsing utilities
  - Identifies special office types

- **`error-recovery.ts`** - Operation recovery system
  - Tracks and retries failed operations
  - Implements different recovery strategies
  - Handles partial failures gracefully
  - Provides status reporting

- **`service-initializer.ts`** - Service initialization
  - Creates and connects service components
  - Manages dependency injection
  - Provides clean shutdown capability
  - Centralizes service configuration

- **`logger.ts`** - Structured logging
  - Provides level-based logging methods
  - Creates component-specific child loggers
  - Formats logs for readability
  - Handles both development and production environments

### API Routes (`src/routes/`)

#### Webhook Endpoints (`src/routes/webhooks/`)

- **`intakeq.ts`** - IntakeQ webhook handler
  - Processes incoming webhook events
  - Validates request signatures
  - Sends immediate acknowledgment to IntakeQ
  - Delegates to background processing

- **`health.ts`** - Webhook system health checks
  - Provides webhook processing statistics
  - Reports on recent webhook activity
  - Shows success/failure metrics

#### Scheduling Endpoints (`src/routes/scheduling/`)

- **`daily-schedule.ts`** - Daily schedule generation
  - Handles GET and POST requests for daily schedules
  - Implements date validation and parsing
  - Returns formatted schedule data
  - Provides preview capabilities

- **`office-assignments.ts`** - Office assignment endpoints
  - Provides endpoints for manual office assignments
  - Implements conflict resolution APIs
  - Handles batch updates
  - Validates office assignments

#### Maintenance Endpoints (`src/routes/maintenance/`)

- **`data-cleanup.ts`** - Data maintenance operations
  - Handles duplicate detection and removal
  - Provides system health checks
  - Manages database integrity

- **`diagnostics.ts`** - System diagnostics
  - Tests office assignment rules
  - Verifies sheet structure
  - Validates configuration
  - Reports system health

### Type Definitions (`src/types/`)

- **`sheets.ts`** - Google Sheets data structures
  - Defines interfaces for all sheet data
  - Implements type mappings for sheet operations
  - Contains enums for sheet-specific values

- **`scheduling.ts`** - Scheduling-related types
  - Defines appointment and scheduling interfaces
  - Implements conflict detection types
  - Contains office assignment result types
  - Includes standardizeOfficeId utility

- **`webhooks.ts`** - Webhook payload types
  - Defines IntakeQ webhook payloads
  - Implements signature verification interfaces
  - Contains event type enums

- **`api.ts`** - API request/response types
  - Defines structure of API payloads
  - Implements error response formats
  - Contains type guards for request validation

### Middleware (`src/middleware/`)

- **`verify-signature.ts`** - Webhook signature verification
  - Validates webhook authenticity
  - Checks signature format and value
  - Implements timing-safe comparison
  - Rejects invalid requests

### Apps Script Integration

- **`refreshActiveAppointments.js`** - Active_Appointments management
  - Clears and rebuilds Active_Appointments tab daily
  - Removes past appointments from main Appointments tab
  - Preserves today's and future appointments
  - Runs daily at 5:45 AM EST

- **`onEdit.js`** - Real-time synchronization
  - Detects edits to Appointments sheet
  - Updates Active_Appointments when relevant changes occur
  - Maintains consistency between tabs

## Webhook Processing Flow

The webhook processing flow follows this sequence:

```
1. routes/webhooks/intakeq.ts
   └── processIntakeQWebhook()
       ├── Validates request signature
       ├── Sends 200 response immediately
       └── Calls processWebhookAsync()

2. processWebhookAsync()
   └── Creates webhookHandler with error recovery
       └── Calls webhookHandler.processWebhook()

3. lib/intakeq/webhook-handler.ts
   └── processWebhook()
       ├── Validates payload format
       ├── Checks for duplicate processing (idempotency)
       ├── Logs webhook receipt
       ├── For appointment events:
       │   └── Calls appointmentSyncHandler.processAppointmentEvent()
       └── For form submissions:
           └── Calls processIntakeFormSubmission()

4. lib/intakeq/appointment-sync.ts
   └── processAppointmentEvent()
       ├── Acquires lock for appointmentId
       ├── Validates appointment data
       ├── Checks if appointment exists
       ├── For "Created" events:
       │   └── Calls handleNewAppointment()
       ├── For "Updated/Rescheduled" events:
       │   └── Calls handleAppointmentUpdate()
       ├── For "Cancelled" events:
       │   └── Calls handleAppointmentCancellation()
       └── For "Deleted" events:
           └── Calls handleAppointmentDeletion()

5. lib/google/sheets.ts
   └── addAppointment() or updateAppointment()
       ├── Attempts operation with retry logic
       ├── Updates main Appointments tab
       ├── Updates Active_Appointments tab if for today
       ├── Logs audit entry (batched)
       └── Refreshes cache
```

## Daily Schedule Generation Flow

```
1. scheduler-service.ts
   └── combinedDailyTask()
       └── Runs at 6:00 AM EST with locking

2. daily-schedule-service.ts
   └── generateDailySchedule()
       ├── Gets today's appointments from Active_Appointments
       ├── Loads configuration data (offices, clinicians, rules)
       ├── For each appointment:
       │   └── resolveOfficeAssignments()
       └── Updates appointments with assignments

3. email/templates.ts
   └── dailySchedule()
       ├── Filter duplicates
       ├── Group by clinician
       ├── Format with color coding
       ├── Highlight office changes
       └── Generate statistics

4. email/service.ts
   └── sendEmail()
       ├── Gets configured recipients
       ├── Sends via SendGrid with retry logic
       └── Logs delivery status
```

## Office Assignment Logic

The office assignment process is central to the system and follows this sequence:

```
1. daily-schedule-service.ts
   └── resolveOfficeAssignments()
       ├── For each appointment:
       │   ├── Load client data
       │   ├── Load clinician data
       │   ├── Get configured rules in priority order
       │   └── For each rule (highest to lowest priority):
       │       ├── Evaluate rule conditions
       │       ├── Check if office is available
       │       └── If match, assign office and exit loop
       └── Return assignments with reasons

2. detectConflicts()
   ├── Find overlapping appointments
   ├── Identify appointments in same office with overlapping times
   └── Return conflict information
```

## Removed or Deprecated Components

The following components have been removed or consolidated:

1. **Appointment Window Management**
   - `src/lib/scheduling/appointment-window-manager.ts` - Replaced by Apps Script cleanup
   - Weekly cleanup tasks in `scheduler-service.ts` - Removed in favor of Apps Script

2. **Bulk Import Functionality**
   - `src/lib/scheduling/enhanced-bulk-import.ts` - Consolidated into `bulk-import-service.ts`
   - Various standalone import scripts - Consolidated and simplified

3. **Date Helpers Duplication**
   - `src/lib/util/date-helpers.ts` - Being replaced by consolidated `date-utils.ts`

4. **Testing Routes Duplication**
   - Multiple test route files have been consolidated

## Key Improvements

1. **Rate Limit Handling**
   - Added retry logic with exponential backoff
   - Implemented batch operations for audit logs
   - Reduced API calls through caching

2. **Appointment Management**
   - Simplified to rely on Apps Script for cleanup
   - Removed complex appointment window management
   - Streamlined scheduler service

3. **Error Resilience**
   - Added error recovery service
   - Implemented idempotency for webhook processing
   - Added locking mechanism for concurrent operations