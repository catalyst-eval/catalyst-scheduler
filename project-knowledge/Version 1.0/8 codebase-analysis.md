# Catalyst Scheduler Codebase Analysis

## Table of Contents
- [Email Module](#email-module)
- [Google Module](#google-module) 
- [IntakeQ Module](#intakeq-module)
- [Scheduling Module](#scheduling-module)
- [Routes and API](#routes-and-api)
- [Utility Functions](#utility-functions)
- [Type Definitions](#type-definitions)
- [Scripts](#scripts)
- [Redundancies and Deprecated Code](#redundancies-and-deprecated-code)

## Email Module

### src/lib/email/service.ts
**Role**: Handles email delivery using SendGrid API.

**Key Functions**:
- `sendEmail(recipients, template, options)`: Sends an email with retry logic for failures.
- `getScheduleRecipients()`: Retrieves recipients for daily schedule emails from settings.
- `getErrorNotificationRecipients()`: Gets recipients for error notifications.

### src/lib/email/templates.ts
**Role**: Generates HTML and plain text email templates.

**Key Functions**:
- `dailySchedule(data)`: Creates daily schedule email with color-coded clinician sections and office change indicators.
- `errorNotification(error, context, details)`: Generates error notification emails.
- `groupAppointmentsByClinicianLastName(appointments)`: Organizes appointments by clinician and filters duplicates.

## Google Module

### src/lib/google/sheets.ts
**Role**: Core integration with Google Sheets API, manages all database operations.

**Key Functions**:
- `updateAppointment(appointment)`: Updates an appointment with transaction-like semantics and retry logic. Handles concurrent updates with optimistic locking, applies changes to both Appointments and Active_Appointments tabs when appropriate, and implements exponential backoff for Google Sheets API rate limits.
- `addAppointment(appt)`: Adds a new appointment to both sheets with validation.
- `deleteAppointment(appointmentId)`: Removes appointments with fallback mechanisms.
- `addAuditLog(entry)`: Implements log batching to reduce API calls and handles critical errors immediately.
- `getActiveAppointments()`: Retrieves appointments from Active_Appointments tab (today's appointments).
- `executeTransaction(operations, rollback, description)`: Implements transaction-like semantics with rollback capabilities.

### src/lib/google/sheets-cache.ts
**Role**: Caching layer to reduce Google Sheets API calls.

**Key Functions**:
- `getOrFetch(key, fetchFn, ttl)`: Retrieves data from cache or fetches it if not available.
- `setInMemory(key, value)`: Stores data in memory cache for fast access.
- `preloadCommonData()`: Preloads frequently accessed configuration data.

## IntakeQ Module

### src/lib/intakeq/service.ts
**Role**: Handles interaction with the IntakeQ API.

**Key Functions**:
- `getAppointments(startDate, endDate, status)`: Fetches appointments with robust error handling and rate limit handling.
- `validateWebhookSignature(payload, signature)`: Validates webhook authenticity.
- `getFullIntakeForm(formId)`: Retrieves complete intake form data.
- `testConnection()`: Verifies connectivity to IntakeQ API.

### src/lib/intakeq/webhook-handler.ts
**Role**: Processes webhooks from IntakeQ.

**Key Functions**:
- `processWebhook(payload, signature)`: Main webhook handling with validation and error handling.
- `extractAccessibilityInfo(formData, clientId)`: Extracts client accessibility needs from form submissions.
- `processIntakeFormSubmission(payload)`: Processes intake form webhooks.

### src/lib/intakeq/accessibility-scanner.ts
**Role**: Processes intake forms for accessibility information.

**Key Functions**:
- `scanIntakeFormsForAccessibility(startDate, endDate)`: Scans historical intake forms to extract accessibility data.
- `getIntakeForms(startDate, endDate)`: Retrieves intake forms from IntakeQ API.

### src/lib/intakeq/appointment-sync.ts
**Role**: Synchronizes appointment data from IntakeQ to Google Sheets.

**Key Functions**:
- `processAppointmentEvent(payload)`: Processes appointment-related webhook events.
- `handleNewAppointment(appointment)`: Creates new appointments with date validation.
- `handleAppointmentUpdate(appointment)`: Updates existing appointments.
- `validateAppointmentDates(appointment)`: Ensures appointment dates are valid and fixes issues.

## Scheduling Module

### src/lib/scheduling/daily-schedule-service.ts
**Role**: Implements office assignment algorithm and daily schedule generation.

**Key Functions**:
- `generateDailySchedule(date)`: Creates schedule data for a specific date.
- `resolveOfficeAssignments(appointments)`: Applies rule-based office assignment algorithm.
- `detectConflicts(appointments)`: Identifies scheduling conflicts.
- `isOfficeAvailable(officeId, appointment, allAppointments)`: Checks if an office is available for a specific time slot.

### src/lib/scheduling/scheduler-service.ts
**Role**: Manages scheduled tasks for the system.

**Key Functions**:
- `initialize()`: Sets up scheduled tasks using node-cron.
- `combinedDailyTask()`: Executes daily schedule generation and email distribution.
- `runWithLock(task)`: Prevents concurrent execution of tasks.
- `cleanupDuplicateAppointments()`: Identifies and resolves duplicate appointment entries.

## Routes and API

### src/routes/webhooks.ts
**Role**: Defines API routes for webhook handling.

**Key Functions**:
- `handleWebhook(req, res)`: Main webhook processing endpoint.
- `validateWebhookSignature(req, res, next)`: Middleware for signature verification.
- `getHealth(req, res)`: Health check endpoint for webhook service.

### src/routes/webhooks/intakeq.ts
**Role**: Specialized handlers for IntakeQ webhooks.

**Key Functions**:
- `processIntakeQWebhook(req, res)`: Processes IntakeQ webhook events asynchronously.
- `validateWebhookSignature(req, res, next)`: Specialized signature validation for IntakeQ.
- `processWebhookAsync(payload, errorRecovery, attempt)`: Handles webhook processing with retry logic.

### src/routes/scheduling.ts
**Role**: Defines API endpoints for scheduling operations.

**Key Functions**:
- `generateDailySchedule(req, res)`: Endpoint to generate daily schedule on demand.
- `previewDailySchedule(req, res)`: Preview schedule without sending email.
- `resolveConflicts(req, res)`: Endpoint to resolve scheduling conflicts.

### src/middleware/verify-signature.ts
**Role**: Contains middleware for webhook signature verification.

**Key Functions**:
- `validateIntakeQWebhook(req, res, next)`: Verifies webhook signatures and basic payload validation.
- `verifySignature(payload, signature)`: Helper function for HMAC signature verification.

## Utility Functions

### src/lib/util/date-helpers.ts
**Role**: Utilities for date manipulation and formatting.

**Key Functions**:
- `toEST(date)`: Converts a date to Eastern Time.
- `getESTDayRange(dateString)`: Gets start and end of day in EST.
- `doTimeRangesOverlap(start1, end1, start2, end2)`: Checks for time range overlaps.
- `formatESTTime(isoDateString)`: Formats a date for display in EST.

### src/lib/util/date-utils.ts
**Role**: Consolidated date utilities (newer implementation).

**Key Functions**:
- Contains all functionality from date-helpers plus additional methods.
- `convertToTimezone(date, timezone)`: Converts dates between time zones.
- `formatYYYYMMDD(date)`: Standard date formatting function.
- `generateDateRange(startDate, endDate)`: Creates an array of dates in a range.

### src/lib/util/office-id.ts
**Role**: Standardizes office IDs across the system.

**Key Functions**:
- `standardizeOfficeId(id)`: Normalizes office ID format.
- `isValidOfficeId(id)`: Validates office ID format.
- `isGroundFloorOffice(id)`: Determines if an office is on the ground floor.
- `formatOfficeId(id)`: Formats office ID for display.

### src/lib/util/logger.ts
**Role**: Structured logging for the application.

**Key Functions**:
- `debug/info/warn/error/fatal(message, context)`: Logging at different severity levels.
- `child(options)`: Creates component-specific loggers.
- `setRequestId(requestId)`: Sets request context for tracing.

### src/lib/util/row-monitor.ts
**Role**: Monitors row counts in Google Sheets to detect anomalies.

**Key Functions**:
- `takeSnapshot()`: Records current row counts.
- `checkRowCounts()`: Detects changes in row counts.
- `verifyAppointmentDeletion(sheetsService, appointmentId)`: Verifies deletions were completed.

### src/lib/util/error-recovery.ts
**Role**: Recovery service for failed operations.

**Key Functions**:
- `recordFailedOperation(type, data, error)`: Records operation for later recovery.
- `attemptRecovery()`: Tries to recover failed operations.
- `processFailedOperation(operation)`: Processes a single failed operation.

### src/lib/util/service-initializer.ts
**Role**: Centralizes service initialization with dependency injection.

**Key Functions**:
- `initializeServices(options)`: Creates and connects all services with proper dependencies.
- `shutdownServices(container)`: Gracefully shuts down all services.
- `enhancedDeleteAppointment(sheetsService, errorRecovery, appointmentId)`: Robust appointment deletion.

### src/lib/util/sheet-verification.ts
**Role**: Verifies Google Sheets structure to detect issues.

**Key Functions**:
- `verifySheetStructure()`: Checks that all required sheets exist with correct IDs.
- `runSheetVerification()`: Logs any issues detected with sheet structure.

## Type Definitions

### src/types/sheets.ts
**Role**: Defines interfaces for Google Sheets data structures.

**Key Types**:
- `SheetOffice`: Office configuration data structure.
- `SheetClinician`: Clinician information structure.
- `AssignmentRule`: Office assignment rule structure.
- `ClientPreference`: Client office preference structure.
- `AuditLogEntry`: Structure for audit log entries.

### src/types/scheduling.ts
**Role**: Defines interfaces for scheduling operations.

**Key Types**:
- `AppointmentRecord`: Appointment data structure.
- `ClientAccessibilityInfo`: Client accessibility requirements.
- `OfficeAssignment`: Result of office assignment algorithm.
- `ScheduleConflict`: Structure for scheduling conflicts.
- `RulePriority`: Enum for office assignment rule priorities.
- `standardizeOfficeId(id)`: Function for normalizing office IDs (duplicated from util).

### src/types/webhooks.ts
**Role**: Defines interfaces for webhook payloads and responses.

**Key Types**:
- `WebhookEventType`: Union type of possible webhook event types.
- `IntakeQAppointment`: Structure for IntakeQ appointment data.
- `IntakeQWebhookPayload`: Webhook payload structure.
- `WebhookResponse`: Response structure for webhook processing.

### src/types/api.ts
**Role**: Defines interfaces for API requests and responses.

**Key Types**:
- `ApiResponse<T>`: Generic API response structure.
- `ValidationResponse`: Response for validation operations.
- `AppointmentConflict`: Structure for appointment conflicts.
- `ScheduleResponse`: Response structure for schedule endpoints.

### src/types/offices.ts
**Role**: Defines interfaces for office locations and details.

**Key Types**:
- `OfficeLocation`: Basic office location information.
- `OfficeDetails`: Detailed office information.

## Scripts

### src/bulk-import.ts
**Role**: Utility for importing IntakeQ appointments in bulk.

**Key Functions**:
- `bulkImportIntakeQAppointments()`: Imports appointments from IntakeQ API.

### src/scripts/test-intakeq-webhook.ts
**Role**: Script for testing IntakeQ webhook integration.

**Key Functions**:
- `sendTestWebhook(payload, includeSignature)`: Sends test webhook requests.
- `generateSignature(payload)`: Generates webhook signatures for testing.
- `testIntakeQConnection()`: Tests connection to IntakeQ API.

### src/scripts/deduplicate-accessibility.ts
**Role**: Utility for removing duplicate client accessibility records.

**Key Functions**:
- `deduplicateAccessibilityInfo()`: Finds and resolves duplicate records.

### src/scripts/manual-import-appointments.ts
**Role**: Tool for importing appointments from CSV files.

**Key Functions**:
- `importAppointmentsFromCSV(filePath)`: Parses and imports appointments from CSV.
- `convertRowToAppointment(row, clinicians, sheetsService)`: Converts CSV row to appointment.

### src/scripts/run-code-consolidation.ts
**Role**: Migration script for code consolidation.

**Key Functions**:
- `runCodeConsolidation()`: Orchestrates code consolidation migration.
- `createBulkImportService()`: Creates consolidated bulk import service.
- `createServiceInitializer()`: Creates standard service initializer.

### src/scripts/audit-standalone-scripts.ts
**Role**: Tool to audit standalone scripts and integrate them.

**Key Functions**:
- `auditStandaloneScripts()`: Analyzes standalone scripts in the codebase.
- `findPotentialStandaloneScripts(dir)`: Locates potential standalone scripts.
- `analyzeScript(scriptPath)`: Analyzes a script's status and usage.

## Redundancies and Deprecated Code

Based on the updated approach described in the project update and code analysis, the following redundancies and deprecated code have been identified:

### 1. Appointment Window Management
**Status**: Removed/Deprecated

The entire appointment window management approach has been replaced with Apps Script-based cleaning. These files/components are now redundant:

- `src/lib/scheduling/appointment-window-manager.ts` - Entire file is redundant
- `src/lib/scheduling/enhanced-bulk-import.ts` - Enhanced bulk import functionality no longer needed

**Redundant Methods**:
- `weeklyCleanupTask()` in scheduler-service.ts
- `cleanupOldAppointments()` in scheduler-service.ts
- `refreshTwoWeekWindow()` in scheduler-service.ts

### 2. Date Utilities Duplication
**Status**: Redundant

There are two implementations of date utilities:
- `src/lib/util/date-helpers.ts` - Original implementation
- `src/lib/util/date-utils.ts` - Newer, more comprehensive implementation

The older `date-helpers.ts` could be deprecated in favor of the more comprehensive `date-utils.ts`.

### 3. Office ID Standardization
**Status**: Duplicated

The `standardizeOfficeId()` function appears in two places:
- `src/lib/util/office-id.ts` - Original implementation
- `src/types/scheduling.ts` - Duplicated implementation

This creates potential inconsistencies if one implementation is updated but not the other.

### 4. Test/Development Routes
**Status**: Redundant

Multiple overlapping test route files:
- `src/routes/test-intakeq.ts`
- `src/routes/test-webhook.ts`
- `src/test/test-webhook.ts`
- `src/routes/testing/office-assignments.ts`

These have been consolidated into `src/routes/testing/index.ts` but the old files still exist.

### 5. Bulk Import Functionality
**Status**: Multiple Implementations

Multiple implementations of bulk import functionality:
- `src/bulk-import.ts` (root level)
- `src/lib/scheduling/bulk-import-service.ts` (consolidated version)
- `src/lib/scheduling/enhanced-bulk-import.ts` (deprecated)
- `src/scripts/manual-import-appointments.ts` (standalone script)

The consolidated `bulk-import-service.ts` should replace the others.

### 6. Google Sheets API Approach
**Status**: Simplified

The previous approach with individual writes and excessive audit logging has been replaced with:
- Batched audit logs to reduce API calls
- Retry logic with exponential backoff for rate limits
- Simplified daily refresh through Apps Script
