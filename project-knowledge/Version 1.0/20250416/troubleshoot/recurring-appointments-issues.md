# Recurring Appointments and Cancellation Issues Analysis

Based on analysis of the Logs_Tabs data, I've identified several issues affecting the synchronization of recurring appointments between IntakeQ and the Scheduler system. This document outlines these issues and provides specific recommendations for fixing them.

## Issues Identified

### 1. Missing Recurring Appointment Entries

**Observed Behavior:**
- 10 recurring appointments were created in IntakeQ, but only 8 made it to the Appointments tab
- Missing specifically: 
  - 67fffc9eec6d472c417d3ac4 (April 23)
  - 67fffc9eec6d472c417d3acb (April 24)
  - 67fffc9fec6d472c417d3ad0 (April 25 - duplicate entry in Appointments tab)

**Root Causes:**
- **Race Condition**: Multiple webhooks are being processed simultaneously, causing Google Sheets API rate limits
- **Verification Issue**: The system detects appointments were added to Active_Appointments but not to the main Appointments tab ("partial verification")
- **Incomplete Repair**: Despite logging the verification issue, the system doesn't effectively repair the inconsistency

### 2. Duplicate Appointment Entries

**Observed Behavior:**
- 67fffc9fec6d472c417d3ad0 (April 25) appears twice in the Appointments tab

**Root Causes:**
- **Idempotency Failure**: The idempotency check fails to prevent duplicate processing of the same appointment
- **Cache Invalidation Issue**: After adding an appointment, insufficient cache invalidation leads to database checks missing the existing entry

### 3. Recurring Series Cancellation Problems

**Observed Behavior:**
- When cancelling a recurring series, some appointments remain in the system
- Stopping a recurrence (e.g., for dates past a certain point) is not properly handled

**Root Causes:**
- **Insufficient Recurring Series Handling**: The system lacks proper identification of appointments belonging to the same recurring series
- **Missing Bulk Operations**: No bulk operation capability for handling changes to an entire series

## Technical Recommendations

### 1. Implement Rate Limiting for Webhook Processing

```typescript
// Add to webhook-handler.ts
export class WebhookHandler {
  // Add new properties
  private activeWebhooks: Map<string, Date> = new Map();
  private readonly MAX_CONCURRENT = 3;
  private readonly WEBHOOK_TIMEOUT_MS = 30000; // 30 seconds

  async processWebhook(payload: unknown, signature?: string): Promise<WebhookResponse> {
    // Check current active webhooks
    this.cleanupStaleWebhooks();
    
    if (this.activeWebhooks.size >= this.MAX_CONCURRENT) {
      console.log(`Rate limiting webhook, already processing ${this.activeWebhooks.size} webhooks`);
      return {
        success: false,
        error: 'Rate limit reached, too many concurrent webhooks',
        retryable: true
      };
    }
    
    // Generate unique tracking ID and add to active webhooks
    const trackingId = `webhook_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    this.activeWebhooks.set(trackingId, new Date());
    
    try {
      // Original webhook processing logic
      // ...
      
      return result;
    } finally {
      // Always remove from active webhooks
      this.activeWebhooks.delete(trackingId);
    }
  }
  
  // Helper to clean up stale webhook tracking
  private cleanupStaleWebhooks(): void {
    const now = new Date();
    for (const [id, timestamp] of this.activeWebhooks.entries()) {
      if (now.getTime() - timestamp.getTime() > this.WEBHOOK_TIMEOUT_MS) {
        console.log(`Removing stale webhook tracking: ${id}`);
        this.activeWebhooks.delete(id);
      }
    }
  }
}
```

### 2. Enhance Partial Verification Repair

```typescript
// Modify in google/sheets.ts - addAppointmentWithVerification method

// Current code for partial verification
if (verification === 'partial') {
  // Log partial success for diagnostics
  console.warn(`Partial verification for appointment ${normalizedAppointment.appointmentId}: main=${mainVerification}, active=${activeVerification}`);
  
  // Enhanced repair mechanism
  if (!mainVerification && activeVerification) {
    console.log(`Appointment exists in Active_Appointments but missing from main tab - attempting repair`);
    
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Add progressive delay for retries
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        
        // Get the appointment from Active_Appointments to ensure we have the latest data
        const activeAppointment = await this.getAppointmentFromActiveTab(normalizedAppointment.appointmentId);
        if (activeAppointment) {
          // Try to add it to the main Appointments tab
          await this.appendRows(`Appointments!A:R`, [this.appointmentToRow(activeAppointment)]);
          
          // Verify the repair worked
          const repairCheck = await this.verifyAppointmentExists(normalizedAppointment.appointmentId, 'Appointments');
          if (repairCheck) {
            console.log(`Successfully repaired appointment ${normalizedAppointment.appointmentId} on attempt ${attempt + 1}`);
            mainVerification = true;
            verification = 'full';
            break;
          }
        }
      } catch (repairError) {
        console.error(`Repair attempt ${attempt + 1} failed:`, repairError);
      }
    }
    
    // If still not repaired, log the issue for later recovery
    if (!mainVerification) {
      await this.logRepairNeeded(normalizedAppointment.appointmentId, 'partial_verification');
    }
  }
}
```

### 3. Add Recurring Series Group Identification

```typescript
// Add to appointment-sync.ts

// Extract recurring series ID from appointment
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
    
    // Use client-provider-service combo as series identifier
    return `series_${appointment.ClientId}_${appointment.PractitionerId}_${appointment.ServiceId}`;
  }
  
  return null;
}

// Add recurring series handling
async handleRecurringSeriesCancellation(
  appointmentId: string, 
  seriesId: string
): Promise<void> {
  // Find all appointments in the same series
  const relatedAppointments = await this.findRelatedSeriesAppointments(seriesId);
  
  console.log(`Found ${relatedAppointments.length} appointments in recurring series ${seriesId}`);
  
  // Process in batches to avoid API quota issues
  const batchSize = 3;
  for (let i = 0; i < relatedAppointments.length; i += batchSize) {
    const batch = relatedAppointments.slice(i, i + batchSize);
    
    await Promise.all(batch.map(async (appt) => {
      try {
        await this.sheetsService.updateAppointmentStatus(appt.appointmentId, 'cancelled', {
          reason: 'Recurring series cancellation',
          notes: `Cancelled as part of recurring series (trigger: ${appointmentId})`
        });
        console.log(`Cancelled appointment ${appt.appointmentId} as part of series ${seriesId}`);
      } catch (error) {
        console.error(`Failed to cancel appointment ${appt.appointmentId} in series:`, error);
      }
    }));
    
    // Short delay between batches
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
```

### 4. Implement Recurring Series Stop Logic

```typescript
// Add to appointment-sync.ts

// Handle stopping a recurring series after a specific date
async handleRecurringSeriesStop(
  appointment: IntakeQAppointment,
  stopDate: Date
): Promise<WebhookResponse> {
  try {
    const seriesId = this.getRecurringSeriesId(appointment);
    if (!seriesId) {
      return {
        success: false,
        error: 'Could not identify recurring series',
        retryable: false
      };
    }
    
    console.log(`Stopping recurring series ${seriesId} after ${stopDate.toISOString()}`);
    
    // Find all appointments in the series
    const relatedAppointments = await this.findRelatedSeriesAppointments(seriesId);
    
    // Identify appointments after stop date
    const appointmentsToCancel = relatedAppointments.filter(appt => {
      const appointmentDate = new Date(appt.startTime);
      return appointmentDate > stopDate;
    });
    
    console.log(`Found ${appointmentsToCancel.length} appointments to cancel after stop date`);
    
    // Process in batches
    const batchSize = 3;
    for (let i = 0; i < appointmentsToCancel.length; i += batchSize) {
      const batch = appointmentsToCancel.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (appt) => {
        try {
          await this.sheetsService.updateAppointmentStatus(appt.appointmentId, 'cancelled', {
            reason: 'Recurring series stopped',
            notes: `Cancelled due to recurring series stop after ${stopDate.toISOString()}`
          });
          console.log(`Cancelled future appointment ${appt.appointmentId} due to series stop`);
        } catch (error) {
          console.error(`Failed to cancel appointment ${appt.appointmentId} after series stop:`, error);
        }
      }));
      
      // Short delay between batches
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return {
      success: true,
      details: {
        seriesId,
        cancelledCount: appointmentsToCancel.length,
        stopDate: stopDate.toISOString()
      }
    };
  } catch (error) {
    console.error('Error handling recurring series stop:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      retryable: false
    };
  }
}
```

### 5. Implement Recovery Mechanism for Partially Verified Appointments

```typescript
// Add to scheduler-service.ts

/**
 * Scheduled task to repair partially verified appointments
 * Run this every hour to catch and fix synchronization issues
 */
async repairPartialVerifications(): Promise<void> {
  try {
    console.log('Starting repair of partially verified appointments');
    
    // Get all audit log entries for partial verifications
    const partialLogs = await this.sheetsService.getAuditLogsByDescription('Partial verification for appointment');
    
    if (partialLogs.length === 0) {
      console.log('No partial verifications found in logs');
      return;
    }
    
    console.log(`Found ${partialLogs.length} partial verification logs to process`);
    
    // Extract appointment IDs and deduplicate
    const appointmentIds = new Set<string>();
    partialLogs.forEach(log => {
      try {
        // Extract ID from the log entry
        const systemNotes = JSON.parse(log.systemNotes || '{}');
        if (systemNotes.appointmentId) {
          appointmentIds.add(systemNotes.appointmentId);
        }
      } catch (error) {
        console.warn('Could not parse system notes:', error);
      }
    });
    
    console.log(`Found ${appointmentIds.size} unique appointments needing repair`);
    
    // Process each appointment
    let success = 0;
    let failed = 0;
    
    for (const appointmentId of appointmentIds) {
      try {
        // Check main tab
        const existsInMain = await this.sheetsService.verifyAppointmentExists(appointmentId, 'Appointments');
        
        // Check active tab
        const existsInActive = await this.sheetsService.verifyAppointmentExists(appointmentId, 'Active_Appointments');
        
        // If missing from main but in active, repair it
        if (!existsInMain && existsInActive) {
          const appointment = await this.sheetsService.getAppointmentFromActiveAppointments(appointmentId);
          if (appointment) {
            await this.sheetsService.appendToAppointmentsTab(appointment);
            console.log(`Repaired appointment ${appointmentId} - copied from Active_Appointments to main tab`);
            success++;
            
            // Log repair
            await this.sheetsService.addAuditLog({
              timestamp: new Date().toISOString(),
              eventType: 'SYSTEM_REPAIR',
              description: `Repaired partially verified appointment ${appointmentId}`,
              user: 'SYSTEM'
            });
          }
        }
      } catch (error) {
        console.error(`Failed to repair appointment ${appointmentId}:`, error);
        failed++;
      }
      
      // Short delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`Repair results: ${success} fixed, ${failed} failed`);
    
  } catch (error) {
    console.error('Error in repairPartialVerifications:', error);
  }
}
```

## Implementation Priorities

1. **Immediate Fixes:**
   - Rate limiting for webhook processing to prevent overwhelming Google Sheets API
   - Enhanced recovery for partial verifications with multiple repair attempts

2. **Medium Priority:**
   - Recurring series identification to group related appointments
   - Duplicate detection and prevention improvements

3. **Long-term Enhancements:**
   - Scheduled repair task for ongoing recovery of synchronization issues
   - Comprehensive recurring series handling for cancellations and stops

With these enhancements, the system will be much more robust when handling recurring appointments and will recover gracefully from synchronization issues, preparing for a smoother migration to Version 2.0 with a proper database.