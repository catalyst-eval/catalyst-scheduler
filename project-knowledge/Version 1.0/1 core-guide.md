# Catalyst Scheduler Core Guide

## System Overview

The Catalyst Scheduler is a specialized system that intelligently assigns office spaces for therapy appointments based on client needs, clinician preferences, and office availability. It integrates with IntakeQ for appointment management and uses Google Sheets as its primary database.

## Core Components

1. **Node.js Express Backend**: Processes webhooks and implements business logic
2. **Google Sheets Database**: Stores configuration and appointment data
3. **Apps Script Integration**: Manages Active_Appointments tab and cleans past appointments
4. **IntakeQ Integration**: Sources appointment data through webhooks and API calls
5. **Email Notification System**: Sends daily schedules using SendGrid

## Google Sheets Database Structure

The system uses a structured Google Sheets database with the following tabs:

### Configuration Sheets

1. **Offices_Configuration** - Tab with office details:
   ```typescript
   interface SheetOffice {
     officeId: string;          // Unique identifier (e.g., "B-4")
     name: string;              // Display name
     unit: string;              // Location unit
     inService: boolean;        // Whether office is currently available
     floor: string;             // "upstairs" or "downstairs"
     isAccessible: boolean;     // Accessibility status
     size: string;              // "small", "medium", or "large"
     ageGroups: string[];       // Target age groups (comma-separated)
     specialFeatures: string[]; // Special accommodations (comma-separated)
     primaryClinician: string;  // Primary clinician assigned to office
     alternativeClinicians: string[]; // Other approved clinicians (comma-separated)
     isFlexSpace: boolean;      // Whether space is flexible use
     notes: string;             // Additional notes
   }
   ```

2. **Clinicians_Configuration** - Tab with provider information:
   ```typescript
   interface SheetClinician {
     clinicianId: string;        // Internal identifier
     name: string;               // Full name
     email: string;              // Email address
     role: string;               // "owner", "admin", "clinician", "intern"
     ageRangeMin: number;        // Minimum client age
     ageRangeMax: number;        // Maximum client age
     specialties: string[];      // Areas of expertise (comma-separated)
     caseloadLimit: number;      // Maximum client count
     currentCaseload: number;    // Current client count
     preferredOffices: string[]; // Preferred office IDs (comma-separated)
     allowsRelationship: boolean; // Works with couples/families
     certifications: string[];   // Professional certifications (comma-separated)
     intakeQPractitionerId: string; // ID in IntakeQ system
   }
   ```

3. **Assignment_Rules** - Tab with prioritized assignment logic:
   ```typescript
   interface AssignmentRule {
     priority: number;         // Rule priority (100=highest, 10=lowest)
     ruleName: string;         // Descriptive name
     ruleType: string;         // "client", "accessibility", "age", etc.
     condition: string;        // Rule condition
     officeIds: string;        // Target offices (may use special syntax)
     overrideLevel: string;    // "hard", "medium", "soft", "none"
     active: boolean;          // Whether rule is active
     notes: string;            // Additional notes
   }
   ```

### Client Data Sheets

1. **Client_Accessibility_Info** - Tab with client needs:
   ```typescript
   interface ClientAccessibilityInfo {
     clientId: string;            // Client ID from IntakeQ
     clientName: string;          // Full name
     lastUpdated: string;         // Last updated timestamp
     hasMobilityNeeds: boolean;   // Mobility assistance needed
     mobilityDetails: string;     // Mobility details
     hasSensoryNeeds: boolean;    // Sensory sensitivities
     sensoryDetails: string;      // Sensory details
     hasPhysicalNeeds: boolean;   // Physical environment needs
     physicalDetails: string;     // Physical needs details
     roomConsistency: number;     // Preference for consistent room (1-5)
     hasSupportNeeds: boolean;    // Support person/animal
     supportDetails: string;      // Support details
     accessibilityNotes: string;  // Additional notes - includes assigned office
     formType: string;            // Form type used
     formId: string;              // Original form ID
   }
   ```

### Operational Sheets

1. **Appointments** - Main appointment ledger:
   ```typescript
   interface AppointmentRecord {
     appointmentId: string;       // Unique ID from IntakeQ
     clientId: string;            // Client ID
     clientName: string;          // Client full name
     clinicianId: string;         // Clinician ID
     clinicianName: string;       // Clinician full name
     currentOfficeId: string;     // Current/historical office assignment
     sessionType: string;         // "in-person", "telehealth", "group", "family"
     startTime: string;           // Start time (ISO format)
     endTime: string;             // End time (ISO format)
     status: string;              // "scheduled", "completed", "cancelled", etc.
     source: string;              // "intakeq", "manual"
     lastUpdated: string;         // Last updated timestamp
     requirementsJson: string;    // JSON string of requirements
     notes: string;               // Additional notes
     assignedOfficeId: string;    // Assigned office from algorithm
     // Additional columns for tracking assignment details
     assignmentReason: string;    // Reason for assignment
     accessibilityNeeded: boolean; // Whether accessibility needed
     requiredFeatures: string;    // Required features
     clientPreferences: string;   // Client preferences
     clinicianPreferences: string; // Clinician preferences
     conflicts: string;           // Conflicts detected
     needsAssignment: boolean;    // Whether assignment needed
   }
   ```

2. **Active_Appointments** - Mirror of today's appointments:
   - Identical structure to the main Appointments tab
   - Contains only appointments for the current day
   - Updated by both the Node.js application and Apps Script synchronization
   - Used to improve performance for daily schedule generation

3. **Audit_Log** - System activity logging:
   ```typescript
   interface AuditLogEntry {
     timestamp: string;        // Event timestamp
     eventType: string;        // Type of event
     description: string;      // Description of event
     user: string;             // User or system component
     previousValue: string;    // Previous value (if applicable)
     newValue: string;         // New value (if applicable)
     systemNotes: string;      // Additional system notes
   }
   ```

4. **Schedule_Configuration** and **Integration_Settings** - System settings:
   ```typescript
   interface SystemSettings {
     settingName: string;      // Setting identifier
     value: string;            // Setting value
     description: string;      // Description
     lastUpdated: string;      // Last updated timestamp
     updatedBy: string;        // Updated by user
   }
   ```

## Webhook-Driven System Implementation

The Catalyst Scheduler is a webhook-driven system that processes appointment updates in real-time.

### Webhook Processing Flow

1. **Webhook Reception**:
   - IntakeQ sends webhook events for appointment changes
   - Events include: Creation, Updates, Rescheduling, Cancellation, Deletion
   - Webhooks are received at `/api/webhooks/intakeq` endpoint

2. **Signature Verification**:
   - HMAC signature validation ensures authenticity
   - Middleware compares provided signature with calculated one
   - Immediate HTTP 200 response acknowledges receipt

3. **Asynchronous Processing**:
   - Event processing occurs in background threads
   - Allows immediate response to IntakeQ to prevent retries
   - Includes retry logic for failed operations

4. **Idempotent Processing**:
   - Checks for duplicate webhook processing
   - Safely handles potential redelivery of webhooks
   - Prevents creation of duplicate appointments

5. **Event-Specific Handling**:
   - Different handlers for each event type
   - Appointment creation adds new records
   - Updates modify existing appointments
   - Cancellations update status without removing data
   - Deletions mark appointments as deleted

6. **Google Sheets Updates**:
   - Updates both Appointments and Active_Appointments tabs
   - Implements retry logic for API rate limits
   - Uses batched audit logging to reduce API calls

### Active_Appointments Synchronization

The system maintains an Active_Appointments tab for improved performance:

1. **Apps Script Updates**:
   - Daily refresh at 5:45 AM EST via Apps Script
   - Clears and rebuilds Active_Appointments with today's appointments
   - Removes past appointments from main Appointments tab
   - Preserves today's and future appointments in main Appointments tab

2. **Node.js Updates**:
   - Updates both tabs during webhook processing
   - Maintains consistency between tabs
   - Uses caching to reduce API calls

3. **Performance Benefits**:
   - Reduces data processing for daily operations
   - Minimizes Google Sheets API calls
   - Improves response time for daily schedules

## Office Assignment Logic

The office assignment follows a strict priority hierarchy defined by the Assignment_Rules sheet:

1. **Priority 100**: Client-Specific Requirements
   - Reads from accessibilityNotes field in Client_Accessibility_Info
   - Highest precedence - overrides all other rules

2. **Priority 90**: Accessibility Requirements
   - Based on hasMobilityNeeds in Client_Accessibility_Info
   - Assigns accessible offices (B-4, C-3)

3. **Priority 80**: Young Children
   - Children age ≤ 10 assigned to B-5

4. **Priority 75**: Older Children and Teens
   - Children/teens age 11-17 assigned to C-1

5. **Priority 70**: Adult Client Assignments
   - Adults (≥18) to appropriate offices (B-4, C-2, C-3)

6. **Priority 65**: Clinician Primary Office
   - Use clinician's primary office when available

7. **Priority 62**: Clinician Preferred Office
   - Use one of clinician's preferred offices when available

8. **Priority 55**: In-Person Priority
   - In-person sessions to physical offices (B-4, B-5, C-1, C-2, C-3)

9. **Priority 40**: Telehealth to Preferred Office
   - For telehealth, use clinician's preferred office if available

10. **Priority 35**: Special Features Match
    - Office has features that match client requirements

11. **Priority 30**: Alternative Clinician Office
    - Office lists this clinician as alternative

12. **Priority 20**: Available Office
    - Any office available during appointment time

13. **Priority 15**: Break Room Last Resort
    - Use break room (B-1) only when no other physical offices available

14. **Priority 10**: Default Telehealth
    - Virtual office (A-v) as last resort for telehealth sessions

## System Operation Sequence

### Daily Process Flow

1. **5:45 AM EST**: Apps Script refreshes Active_Appointments tab and cleans up past appointments
2. **6:00 AM EST**: Daily schedule report generation and email distribution

### Webhook Processing Flow

1. **Webhook Received**: IntakeQ sends appointment event
2. **Signature Verification**: HMAC verification of request
3. **Quick Acknowledgment**: Immediate response to IntakeQ
4. **Background Processing**: Asynchronous appointment processing with idempotency check
5. **Office Assignment**: Rule-based office determination
6. **Database Update**: Update appointment record with retry logic
7. **Conflict Resolution**: Resolve any scheduling conflicts

### Email Generation Process

1. **Generate Daily Schedule**:
   - Get appointments for target date from Active_Appointments
   - Resolve any TBD assignments
   - Apply conflict resolution
   - Group appointments by clinician
   - Filter duplicate appointments

2. **Enhanced Email Format**:
   - Group appointments by clinician with color-coded headers
   - Highlight office changes with visual indicators:
     - Red highlighting for client needs-based changes
     - Orange highlighting for conflict-based changes
   - Format office IDs consistently
   - Include comprehensive priority level reference table
   - Generate statistics summary

3. **Send Notifications**:
   - Send to configured recipients
   - Include error handling and retries
   - Log email delivery status

## Duplicate Appointment Handling

The system includes mechanisms to detect and manage duplicate appointments:

1. **Webhook Idempotency**:
   - Tracks processed webhooks to prevent duplication
   - Checks for existing appointments before creating new ones
   - Handles "Created" events on existing appointments as updates

2. **Appointment Locking**:
   - Implements per-appointment locking
   - Prevents concurrent processing of same appointment
   - Avoids race conditions during webhook processing

3. **Cleanup Process**:
   - `cleanupDuplicateAppointments()` runs during daily processing
   - Preserves the most recently updated record
   - Logs removed duplicates in the Audit_Log
   - Includes duplicate statistics in daily email

## IntakeQ Integration

The system integrates with IntakeQ through:

1. **Webhooks**: Receive real-time appointment events
2. **Direct API**: Fetch appointment data during refresh operations
3. **Form Processing**: Extract client accessibility information

## Error Handling and Reliability

The system implements these reliability features:

1. **Cache Layer**: Google Sheets caching to reduce API calls
2. **Rate Limiting**: Exponential backoff for API rate limits (120 requests/minute)
3. **Retry Logic**: Multiple retry attempts for transient failures
4. **Fallbacks**: Default office assignments when preferences unavailable
5. **Locking Mechanism**: Prevents concurrent execution of scheduled tasks
6. **Error Recovery**: Tracks and retries failed operations

## Google Sheets API Management

To handle Google Sheets API quotas effectively, the system employs several strategies:

1. **Audit Log Batching**: Groups audit log entries into batches to reduce API calls
2. **Caching Common Data**: Keeps frequently accessed configuration in memory
3. **Apps Script for Bulk Operations**: Uses Apps Script for cleaning past appointments
4. **Retry Logic**: Implements exponential backoff for rate limit errors

## Common Issues and Solutions

1. **Office Assignment Not Applied**
   - Check Client_Accessibility_Info for correct clientId mapping
   - Verify Assignment_Rules priority and syntax
   - Check for appointment status being "cancelled"

2. **Missing Client Data**
   - Ensure client exists in IntakeQ
   - Check webhook logs for processing errors
   - Verify client name matching between systems

3. **IntakeQ Synchronization Issues**
   - Check API key validity and permissions
   - Verify webhook configuration in IntakeQ
   - Check rate limit handling in logs

4. **Duplicate Appointments**
   - Verify webhook idempotency check is working
   - Check appointment locking implementation
   - Examine webhook retry patterns from IntakeQ
   - Review Apps Script synchronization logs