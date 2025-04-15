# Catalyst Scheduler: API Documentation

## API Overview

### Route Structure
```
/api/
├── webhooks/
│   ├── intakeq/              # IntakeQ webhook processing
│   ├── health/               # Webhook health status
│   └── recent/               # Recent webhook logs
├── scheduling/
│   ├── daily-schedule/       # Daily schedule generation
│   ├── preview-schedule/     # Preview daily schedule
│   ├── resolve-conflicts/    # Resolve scheduling conflicts
│   ├── office-assignments/   # Manual office assignment
│   └── test-intakeq/         # Test IntakeQ connection
└── maintenance/
    ├── diagnostics/          # System diagnostics
    │   ├── sheet-structure/  # Verify sheet structure
    │   ├── rule-validation/  # Validate assignment rules
    │   └── api-usage/        # Monitor API usage statistics
    ├── cleanup/              # Data cleanup operations
    │   ├── duplicates/       # Find and remove duplicates
    │   └── deduplicate-client/ # Deduplicate client info
    └── scan-accessibility/   # Scan client accessibility info
```

### Base URLs
- Development: `http://localhost:3000/api`
- Production: `https://catalyst-scheduler.onrender.com/api`

### Authentication
- IntakeQ webhooks: HMAC signature verification
- Internal endpoints: Environment-based authentication

### Response Format
```typescript
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
  timestamp: string;
}
```

## Webhook Endpoints

### IntakeQ Webhook Handler
```
POST /webhooks/intakeq

Headers:
  Content-Type: application/json
  X-IntakeQ-Signature: {HMAC signature}

Body: {
  Type: string;
  ClientId?: number;
  Appointment?: {
    Id: string;
    ClientName: string;
    StartDateIso: string;
    EndDateIso: string;
    Duration: number;
    ServiceName: string;
    PractitionerId: string;
    PractitionerName: string;
    Status: string;
  };
  FormId?: string;
  FormName?: string;
  FormData?: any;
}

Response: {
  success: boolean;
  error?: string;
  timestamp: string;
}
```

This endpoint processes webhook events from IntakeQ. It supports:
- Appointment created/updated/rescheduled/cancelled/deleted events
- Form submission events for client accessibility information

The handler verifies the webhook signature, immediately returns a 200 OK response, and processes the webhook asynchronously in the background. It includes idempotency checking to prevent duplicate processing.

#### Implementation Notes:
- Webhooks are processed asynchronously after immediate 200 OK response
- Appointment-level locking prevents race conditions
- Idempotency keys are generated for each webhook to prevent duplicates

### Webhook Health Check
```
GET /webhooks/health

Response: {
  success: boolean;
  status: string;
  metrics: {
    totalProcessed: number;
    successCount: number;
    failureCount: number;
    processingTime: {
      avg: number;
      min: number;
      max: number;
    }>
  };
  timestamp: string;
}
```

This endpoint detects and resolves scheduling conflicts for a specified date by reassigning lower-priority appointments to different offices.

### Manual Office Assignment
```
POST /scheduling/office-assignments
Body: {
  appointmentId: string;
  officeId: string;
  reason: string;
}

Response: {
  success: boolean;
  data: {
    appointmentId: string;
    previousOffice: string;
    newOffice: string;
    reason: string;
  };
  timestamp: string;
}
```

This endpoint allows manual assignment of an office to a specific appointment.

### Test IntakeQ Connection
```
GET /scheduling/test-intakeq-connection

Response: {
  success: boolean;
  message: string;
  status: string;
  apiQuota: {
    remaining: number;
    limit: number;
    resetTime: string;
  };
  timestamp: string;
}
```

This endpoint tests the connection to the IntakeQ API to verify credentials and access.

## Maintenance Endpoints

### API Usage Statistics
```
GET /maintenance/diagnostics/api-usage

Response: {
  success: boolean;
  data: {
    googleSheets: {
      todayCalls: number;
      rateLimitHits: number;
      averageResponseTime: number;
      batchedOperations: number;
      individualOperations: number;
    };
    intakeQ: {
      todayCalls: number;
      rateLimitHits: number;
      averageResponseTime: number;
      remainingQuota: number;
    };
  };
  timestamp: string;
}
```

This endpoint provides statistics about API usage to help monitor quota limits.

### Sheet Structure Verification
```
GET /maintenance/diagnostics/sheet-structure

Response: {
  success: boolean;
  data: {
    sheets: Array<{
      name: string;
      exists: boolean;
      columnCount: number;
      rowCount: number;
      issues: Array<string>;
    }>;
    missingSheets: Array<string>;
    missingColumns: Record<string, Array<string>>;
  };
  timestamp: string;
}
```

This endpoint verifies the structure of the Google Sheets database, checking for required sheets and columns.

### Find and Remove Duplicates
```
POST /maintenance/cleanup/duplicates
Body: {
  scope: string; // "appointments" or "client-info"
}

Response: {
  success: boolean;
  data: {
    duplicatesFound: number;
    recordsRemoved: number;
    details: Array<{
      id: string;
      duplicateCount: number;
      keptRecord: string;
    }>;
  };
  timestamp: string;
}
```

This endpoint identifies and removes duplicate records from the specified scope.

### Scan Client Accessibility Information
```
POST /maintenance/scan-accessibility
Body: {
  startDate?: string;  // Optional, format: YYYY-MM-DD
  endDate?: string;    // Optional, format: YYYY-MM-DD
  forceRescan?: boolean; // Optional, default: false
}

Response: {
  success: boolean;
  data: {
    scanned: number;
    updated: number;
    created: number;
    ignored: number;
    details: Array<{
      clientId: string;
      clientName: string;
      formId: string;
      status: string;
    }>;
  };
  timestamp: string;
}
```

This endpoint scans IntakeQ forms for client accessibility information and updates the Client_Accessibility_Info sheet accordingly.

## Webhook Processing Implementation

### Webhook Request Flow

1. **Receive webhook request**:
   - The system receives a webhook POST request at `/api/webhooks/intakeq`.
   - The request contains a payload and X-IntakeQ-Signature header.

2. **Signature verification**:
   - The middleware validates the signature using HMAC-SHA256.
   - If signature is invalid, returns 401 Unauthorized.

3. **Immediate response**:
   - Once the signature is verified, the system immediately responds with 200 OK.
   - This prevents IntakeQ from retrying the webhook due to timeout.

4. **Asynchronous processing**:
   - The webhook is processed asynchronously after the response is sent.
   - This includes idempotency checking to prevent duplicate processing.

5. **Idempotency handling**:
   - An idempotency key is generated from the webhook type, entity ID, and timestamp.
   - The system checks if the webhook has already been processed with this key.
   - If already processed, the webhook is skipped to prevent duplicates.

6. **Appointment locking**:
   - For appointment events, a lock is acquired for the specific appointmentId.
   - This prevents race conditions when multiple webhooks for the same appointment arrive concurrently.

7. **Processing and database update**:
   - The webhook is processed based on its type (create, update, cancel, etc.).
   - Appropriate database updates are made with retry logic for API rate limits.

8. **Logging**:
   - The processing status is logged to the Webhook_Log for monitoring.
   - Audit entries are added in batches to reduce API calls.

### Error Handling

Webhook processing includes robust error handling:

1. **Error recovery**:
   - Failed operations are recorded for later recovery.
   - The recovery service attempts to retry failed operations periodically.

2. **Rate limit handling**:
   - API rate limit errors trigger exponential backoff.
   - The system tracks rate limit hits and adjusts the backoff duration accordingly.

3. **Partial success**:
   - If updating both Appointments and Active_Appointments tabs, failure in one doesn't block the other.
   - The system prioritizes main Appointments tab updates over Active_Appointments.

## Google Sheets API Optimization

The API implements several optimizations to reduce Google Sheets API usage:

1. **Batched operations**:
   - Audit logs are batched together (default: 10 entries per batch).
   - This significantly reduces API calls for logging operations.

2. **Memory caching**:
   - Frequently accessed data like configuration is cached in memory.
   - Configuration data has a longer TTL (15 minutes by default).

3. **Retry logic with exponential backoff**:
   - Rate limit errors trigger increasing backoff periods.
   - Prevents overwhelming the API during rate limit periods.

4. **Apps Script integration**:
   - Bulk operations like cleaning past appointments are handled by Apps Script.
   - This reduces API call volume from the Node.js application.

## API Rate Limits

### Google Sheets API

- Daily quota: 60 million units per project per day
- 100 requests per 100 seconds per user
- Complex operations cost more quota units

### IntakeQ API

- 120 requests per minute
- The system implements a tracking window to stay within this limit

## API Examples

### Webhook Processing Example

```javascript
// Send a test webhook
fetch('https://catalyst-scheduler.onrender.com/api/webhooks/intakeq', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-IntakeQ-Signature': 'generated-hmac-signature'
  },
  body: JSON.stringify({
    Type: 'AppointmentCreated',
    Appointment: {
      Id: 'test-123',
      ClientName: 'Jane Doe',
      PractitionerName: 'Dr. Smith',
      StartDateIso: '2023-05-15T14:00:00Z',
      EndDateIso: '2023-05-15T15:00:00Z',
      Status: 'scheduled'
    }
  })
})
  .then(response => response.json())
  .then(data => console.log(data))
  .catch(error => console.error('Error:', error));
```

### Generate Daily Schedule Example

```javascript
// Get daily schedule for a specific date
fetch('https://catalyst-scheduler.onrender.com/api/scheduling/daily-schedule?date=2023-05-15')
  .then(response => response.json())
  .then(data => console.log(data))
  .catch(error => console.error('Error:', error));
```

### Resolve Conflicts Example

```javascript
// Resolve scheduling conflicts for a specific date
fetch('https://catalyst-scheduler.onrender.com/api/scheduling/resolve-conflicts', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    date: '2023-05-15'
  })
})
  .then(response => response.json())
  .then(data => console.log(data))
  .catch(error => console.error('Error:', error));
```,
    rateLimit: {
      hitCount: number;
      lastHit: string;
      avgBackoffMs: number;
    }
  };
  timestamp: string;
}
```

This endpoint returns the health status of the webhook processing system, including processing metrics, success rates, and rate limit statistics.

### Recent Webhooks
```
GET /webhooks/recent
Query Parameters:
  - limit: number (default: 20)
  - type: string (optional, filter by webhook type)

Response: {
  success: boolean;
  data: Array<{
    idempotencyKey: string;
    webhookType: string;
    entityId: string;
    receivedAt: string;
    status: string;
    processingTimeMs: number;
    error?: string;
  }>;
  timestamp: string;
}
```

This endpoint returns a list of recently processed webhooks for monitoring and debugging purposes.

## Scheduling Endpoints

### Daily Schedule Generation
```
GET /scheduling/daily-schedule
Query Parameters:
  - date: string (YYYY-MM-DD, default: today)

Response: {
  success: boolean;
  data: {
    date: string;
    appointments: Array<{
      appointmentId: string;
      clientName: string;
      clinicianName: string;
      currentOfficeId: string;
      assignedOfficeId: string;
      officeChange: boolean;
      startTime: string;
      endTime: string;
      sessionType: string;
      assignmentReason?: string;
    }>;
    conflicts: Array<{
      type: string;
      description: string;
      severity: 'high' | 'medium' | 'low';
    }>;
    stats: {
      totalAppointments: number;
      inPersonCount: number;
      telehealthCount: number;
      officeChangeCount: number;
      conflictCount: number;
      byOffice: Record<string, number>;
      byClinician: Record<string, number>;
    };
  };
  timestamp: string;
}
```

This endpoint returns the daily schedule assignments for a specified date. It includes:
- All appointments for the day with assigned offices
- Any conflicts detected in the schedule
- Statistics and counts for different appointment types

### Send Daily Schedule Email
```
POST /scheduling/send-daily-schedule
Body: {
  date: string (YYYY-MM-DD)
}

Response: {
  success: boolean;
  message: string;
  emailSent: boolean;
  recipientCount: number;
  timestamp: string;
}
```

This endpoint generates and sends the daily schedule email for a specified date.

### Preview Daily Schedule
```
GET /scheduling/preview-schedule
Query Parameters:
  - date: string (YYYY-MM-DD, default: today)

Response: {
  success: boolean;
  data: {
    date: string;
    appointments: Array<{...}>;
    conflicts: Array<{...}>;
    stats: {...};
    emailPreview: {
      html: string;
      text: string;
      subject: string;
    }
  };
  timestamp: string;
}
```

This endpoint generates a preview of the daily schedule, including the email that would be sent, without actually sending it.

### Resolve Scheduling Conflicts
```
POST /scheduling/resolve-conflicts
Body: {
  date: string (YYYY-MM-DD)
}

Response: {
  success: boolean;
  data: {
    date: string;
    conflictsResolved: number;
    reassignments: Array<{
      appointmentId: string;
      clientName: string;
      clinicianName: string;
      previousOffice: string;
      newOffice: string;
      reason: string;
    }>;