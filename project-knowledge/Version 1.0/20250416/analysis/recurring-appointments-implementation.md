# Recurring Appointments Implementation

This document outlines the enhancements made to the Catalyst Scheduler to better handle recurring appointments and address synchronization issues between IntakeQ and the Google Sheets database.

## Enhancements Summary

1. **Rate Limiting for Webhook Processing**
   - Added concurrent webhook tracking and rate limiting
   - Implemented stale webhook cleanup to prevent memory leaks
   - Limited webhook processing to 3 concurrent operations

2. **Recurring Series Identification**
   - Added `getRecurringSeriesId()` to generate deterministic IDs for recurring appointment series
   - Stores series ID in appointment notes for future reference
   - Uses cryptographic hashing for consistent identification

3. **Client Name-Based Appointment Matching**
   - Enhanced cancellation logic with client name fallback when appointment IDs don't match
   - Uses approximate date matching to find the right appointment
   - Helps recover from synchronization issues with recurring appointments

4. **Series Cancellation Handling**
   - Added `handleRecurringSeriesCancellation()` to cancel all appointments in a series
   - Processes cancellations in small batches to avoid API quota errors
   - Detects series cancellation intent from notes and reason fields

5. **Series Stop Date Handling**
   - Added `handleRecurringSeriesStop()` to cancel appointments after a specific date
   - Parses stop dates from cancellation notes
   - Only cancels future occurrences past the stop date

## Key Components

### WebhookHandler Rate Limiting

The WebhookHandler now implements rate limiting to prevent overwhelming the Google Sheets API:

```typescript
private activeWebhooks: Map<string, Date> = new Map();
private readonly MAX_CONCURRENT = 3;
private readonly WEBHOOK_TIMEOUT_MS = 30000; // 30 seconds

// In processWebhook method:
this.cleanupStaleWebhooks();
if (this.activeWebhooks.size >= this.MAX_CONCURRENT) {
  return {
    success: false,
    error: 'Rate limit reached, too many concurrent webhooks',
    retryable: true // IntakeQ will retry later
  };
}
```

### Recurring Series Identification

The `getRecurringSeriesId()` method provides consistent identification for appointments in the same series:

```typescript
private getRecurringSeriesId(appointment: IntakeQAppointment): string | null {
  // Check for direct recurring pattern
  if (appointment.RecurrencePattern) {
    // Hash the basic details to create a series ID
    const seriesDetails = {
      clientId: appointment.ClientId,
      practitionerId: appointment.PractitionerId,
      serviceId: appointment.ServiceId,
      recurrencePattern: appointment.RecurrencePattern
    };
    
    // Create deterministic hash
    const crypto = require('crypto');
    return crypto.createHash('md5')
      .update(JSON.stringify(seriesDetails))
      .digest('hex');
  }
  
  // If no direct pattern but recurring indicators in notes/tags
  if (appointment.Notes?.includes('recurring') || 
      appointment.Tags?.includes('recurring') ||
      appointment.Tags?.includes('series')) {
    return `series_${appointment.ClientId}_${appointment.PractitionerId}_${appointment.ServiceId}`;
  }
  
  return null;
}
```

### Client Name Matching for Cancellations

When appointment IDs don't match (common with recurring appointments), we now employ client name matching:

```typescript
// If appointment not found by ID, try by client name and date
if (!existingAppointment) {
  console.warn(`Appointment ${appointment.Id} not found for cancellation`);
  
  // Try broader search if we have client name and approximate time
  if (appointment.ClientName && appointment.StartDateIso) {
    console.log(`Trying broader search for appointment by client name: ${appointment.ClientName}`);
    
    // Using getAppointments with filter as a fallback
    const allAppointments = await this.sheetsService.getAllAppointments();
    
    // Filter appointments by client name (case insensitive)
    const clientNameLower = appointment.ClientName.toLowerCase();
    let clientAppointments = allAppointments.filter(a => 
      a.clientName.toLowerCase().includes(clientNameLower) || 
      clientNameLower.includes(a.clientName.toLowerCase())
    );
    
    // Further filter by date (if available) - approximately same day
    if (appointment.StartDateIso) {
      const targetDate = new Date(appointment.StartDateIso);
      const targetDay = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD
      
      clientAppointments = clientAppointments.filter(a => {
        const appDay = new Date(a.startTime).toISOString().split('T')[0];
        return appDay === targetDay;
      });
    }
    
    // Handle the first matching appointment that isn't already cancelled
    const activeAppointment = clientAppointments.find(a => a.status !== 'cancelled');
    if (activeAppointment) {
      // Cancel this appointment with cancellation reason from IntakeQ
      await this.sheetsService.updateAppointmentStatus(activeAppointment.appointmentId, 'cancelled');
    }
  }
}
```

### Series Cancellation Handling

When a recurring series is cancelled completely, we handle all related appointments:

```typescript
async handleRecurringSeriesCancellation(appointmentId: string, seriesId: string): Promise<void> {
  // Find all appointments in the same series
  const relatedAppointments = await this.findRelatedSeriesAppointments(seriesId);
  
  // Process in batches to avoid API quota issues
  const batchSize = 3;
  for (let i = 0; i < relatedAppointments.length; i += batchSize) {
    const batch = relatedAppointments.slice(i, i + batchSize);
    
    for (const appt of batch) {
      // Skip the trigger appointment & already cancelled appointments
      if (appt.appointmentId === appointmentId || appt.status === 'cancelled') {
        continue;
      }
      
      // Cancel the appointment with context about series cancellation
      await this.sheetsService.updateAppointmentStatus(appt.appointmentId, 'cancelled', {
        reason: 'Recurring series cancellation',
        notes: `Cancelled as part of recurring series (trigger: ${appointmentId})`
      });
    }
    
    // Short delay between batches to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
```

## Handling Rules

The system uses the following rules to determine how to handle recurring appointments:

1. **Single Appointment Cancellation:** 
   - Default behavior when cancellation in IntakeQ is for a single occurrence

2. **Series Cancellation:**
   - Triggered when cancellation notes include "cancel series", "cancel all", or "cancel recurring"
   - Cancels all future appointments in the series across all dates

3. **Series Stop:**
   - Triggered by notes containing "stop after [date]"
   - Cancels only appointments after the specified date
   - Keeps prior appointments intact

## Limitations and Future Enhancements

1. **Google Sheets API Limitation:**
   - Even with batching and rate limiting, the Google Sheets API may throttle requests
   - A proper database in Version 2.0 will address this limitation

2. **Series Identification Accuracy:**
   - Identification relies on notes and limited metadata
   - May not always perfectly identify all recurring appointments
   - Future: Add explicit recurring series ID from IntakeQ

3. **Recovery for Missed Appointments:**
   - Implement a periodic task to scan for missed verifications
   - Add automatic recovery for appointments that weren't properly synchronized

## Testing Recommendations

When testing recurring appointments, verify:

1. Creating a recurring series (all appointments should appear in sheets)
2. Cancelling a single appointment within a series (only that one should be cancelled)
3. Cancelling an entire series (all appointments should be cancelled)
4. Stopping a series after a specific date (only future appointments should be cancelled)
5. Appointment verification works correctly for all cases

## Next Steps

1. Implement the periodic repair task for partial verifications
2. Enhance the Google Sheets service with batch operations for performance
3. Prepare for eventual migration to proper database in Version 2.0