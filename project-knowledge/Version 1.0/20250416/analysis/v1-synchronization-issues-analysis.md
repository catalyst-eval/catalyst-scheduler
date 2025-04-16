# Catalyst Scheduler Version 1.0: Synchronization Issues Analysis

## Executive Summary

After extensive analysis of log files, appointment data, and code review, we've identified several critical issues causing appointment synchronization problems between IntakeQ and the Catalyst Scheduler system. This document outlines these issues and provides recommendations for fixes that can be implemented while maintaining the Version 1.0 architecture with Google Sheets as the primary database, before moving to Version 2.0.

## Key Issues Identified

### 1. Silent API Failures During Appointment Creation

**Problem**: Appointments created in IntakeQ are properly processed by webhooks but fail to appear in the scheduler sheets.

**Root Causes**:
- Google Sheets API calls are failing silently during high-volume periods
- Lack of proper verification that appointments were actually added to sheets
- Insufficient error handling and logging for sheet operations

**Evidence**:
- 67fef78* series appointments show as "Created" in logs but missing from scheduler
- Webhook logs show "completed" status despite appointments not appearing in sheets
- No explicit error messages for these failures in logs

**Affected Files**:
- `src/lib/google/sheets.ts`: `addAppointment()` method doesn't verify successful addition
- `src/lib/intakeq/appointment-sync.ts`: `handleNewAppointment()` doesn't confirm sheet updates

### 2. Aggressive Duplicate Appointment Detection

**Problem**: The system is too aggressive in marking appointments as duplicates and removing them.

**Root Causes**:
- Duplicate detection logic uses insufficient criteria
- No confirmation of actual duplication before removal
- Client-time combination checks missing additional context

**Evidence**:
- Appointments like 67c03923c87d44c7f489a381 removed as duplicates
- These appear in "Missing from IntakeQ" list in discrepancies
- Log entries show "Removed duplicate appointment" for legitimate appointments

**Affected Files**:
- `src/lib/intakeq/appointment-sync.ts`: `handleNewAppointment()` duplicate detection logic
- `src/lib/scheduling/daily-schedule-service.ts`: `cleanupDuplicateAppointments()` method

### 3. Appointment Cancellation Failures

**Problem**: Appointments can't be found when attempting to cancel them.

**Root Causes**:
- Ineffective cache invalidation causing stale data
- Appointment lookup only occurs in two places without fallback options
- Race conditions between creations and cancellations

**Evidence**:
- Appointment 67dda51e9f0abc9065dd9b6d not found after 3 attempts
- Log entry: "Appointment not found, but recorded cancellation for recurring series"
- Cancellations registered in IntakeQ but not in Scheduler

**Affected Files**:
- `src/lib/google/sheets.ts`: `getAppointment()` method
- `src/lib/intakeq/appointment-sync.ts`: `handleAppointmentCancellation()` method

### 4. Webhook Idempotency Issues

**Problem**: Webhook processing fails to accurately track and prevent duplicate processing.

**Root Causes**:
- Idempotency key generation algorithm creates collisions
- Webhook status tracking doesn't properly verify complete processing
- Race conditions in webhook handling

**Evidence**:
- Webhook logs show multiple "completed" entries for the same appointment events
- Duplicate appointments appearing in sheets
- Inconsistent timestamps between IntakeQ and Scheduler

**Affected Files**:
- `src/lib/intakeq/webhook-handler.ts`: `generateIdempotencyKey()` method
- `src/lib/google/sheets.ts`: `isWebhookProcessed()` method

### 5. Google Sheets API Quota Management

**Problem**: The system hits Google Sheets API quotas during high-volume periods.

**Root Causes**:
- Insufficient batching of sheet operations
- Wasteful cache invalidation patterns
- Too many read operations before writes

**Evidence**:
- Cache invalidation messages appearing frequently in logs
- Frequent sheet reads before writes
- Missing appointments during high-volume periods

**Affected Files**:
- `src/lib/google/sheets.ts`: Cache invalidation methods
- `src/lib/google/sheets-cache.ts`: Caching implementation

## Recommended Fixes

### 1. Enhance Appointment Creation with Verification

**Implement in**: `src/lib/intakeq/appointment-sync.ts` and `src/lib/google/sheets.ts`

```typescript
// In appointment-sync.ts - handleNewAppointment method
async handleNewAppointment(appointment: IntakeQAppointment): Promise<WebhookResponse> {
  try {
    // Convert and add appointment as before
    const newAppointment = this.convertToAppointmentRecord(appointment);
    const addResult = await this.sheetsService.addAppointmentWithVerification(newAppointment);
    
    if (addResult.success) {
      return { 
        success: true, 
        details: { 
          appointmentId: appointment.Id,
          verificationStatus: addResult.verification 
        } 
      };
    } else {
      // Log the specific failure for diagnostics
      console.error(`Failed to add appointment ${appointment.Id}: ${addResult.error}`);
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: 'SYSTEM_ERROR',
        description: `Failed to add appointment ${appointment.Id}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          error: addResult.error,
          appointmentId: appointment.Id
        })
      });
      
      return { 
        success: false, 
        error: addResult.error,
        retryable: true 
      };
    }
  } catch (error) {
    // Error handling as before
  }
}

// In sheets.ts - New method with verification
async addAppointmentWithVerification(appt: AppointmentRecord): Promise<{
  success: boolean;
  verification?: 'full' | 'partial' | 'none';
  error?: string;
}> {
  try {
    // Step 1: Add to main Appointments tab
    await this.appendRows(`${SHEET_NAMES.APPOINTMENTS}!A:R`, [this.appointmentToRow(appt)]);
    
    // Step 2: Check if it's for today and add to Active_Appointments if needed
    const isForToday = this.isAppointmentForToday(appt);
    if (isForToday) {
      await this.appendRows(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A:R`, [this.appointmentToRow(appt)]);
    }
    
    // Step 3: Verify the appointment was actually added
    // Wait a short time for Google Sheets to process
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check if appointment exists in main tab
    const mainVerification = await this.verifyAppointmentExists(appt.appointmentId, SHEET_NAMES.APPOINTMENTS);
    
    // If for today, also verify in Active_Appointments
    let activeVerification = true;
    if (isForToday) {
      activeVerification = await this.verifyAppointmentExists(appt.appointmentId, SHEET_NAMES.ACTIVE_APPOINTMENTS);
    }
    
    // Determine verification level
    let verification: 'full' | 'partial' | 'none' = 'none';
    if (mainVerification && (!isForToday || activeVerification)) {
      verification = 'full';
    } else if (mainVerification || activeVerification) {
      verification = 'partial';
    }
    
    if (verification === 'none') {
      return {
        success: false,
        verification,
        error: 'Appointment was not found in sheets after adding'
      };
    }
    
    if (verification === 'partial') {
      // Log partial success for diagnostics
      console.warn(`Partial verification for appointment ${appt.appointmentId}: main=${mainVerification}, active=${activeVerification}`);
      
      // Try to fix the inconsistency
      if (mainVerification && !activeVerification && isForToday) {
        await this.appendRows(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A:R`, [this.appointmentToRow(appt)]);
      }
    }
    
    // Invalidate caches
    this.cache.invalidatePattern(`appointments:${appt.appointmentId}`);
    
    return {
      success: true,
      verification
    };
  } catch (error) {
    return {
      success: false,
      verification: 'none',
      error: error instanceof Error ? error.message : 'Unknown error adding appointment'
    };
  }
}

// Helper method to verify an appointment exists in a sheet
private async verifyAppointmentExists(appointmentId: string, sheetName: string): Promise<boolean> {
  try {
    const values = await this.readSheet(`${sheetName}!A:A`);
    return values?.some(row => row[0] === appointmentId) || false;
  } catch (error) {
    console.error(`Error verifying appointment ${appointmentId} in ${sheetName}:`, error);
    return false;
  }
}
```

### 2. Improve Duplicate Detection Logic

**Implement in**: `src/lib/intakeq/appointment-sync.ts`

```typescript
// In appointment-sync.ts - Enhanced duplicate detection
private async isDuplicateAppointment(appointment: AppointmentRecord): Promise<{
  isDuplicate: boolean;
  reason?: string;
  existingAppointmentId?: string;
}> {
  try {
    // Check 1: Direct ID match (this is handled separately in handleNewAppointment)
    
    // Check 2: Same client, clinician, start time, end time
    const sameTimeAppointments = await this.sheetsService.findAppointments({
      clientId: appointment.clientId,
      clinicianId: appointment.clinicianId,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
      excludeIds: [appointment.appointmentId] // Exclude this appointment
    });
    
    if (sameTimeAppointments.length > 0) {
      return {
        isDuplicate: true,
        reason: 'Same client, clinician, and time',
        existingAppointmentId: sameTimeAppointments[0].appointmentId
      };
    }
    
    // Check 3: Very close start times (within 2 minutes) for same client and clinician
    // This helps catch IntakeQ time zone conversion issues
    const startDateObj = new Date(appointment.startTime);
    const twoMinutesMs = 2 * 60 * 1000;
    
    const timeWindowStart = new Date(startDateObj.getTime() - twoMinutesMs);
    const timeWindowEnd = new Date(startDateObj.getTime() + twoMinutesMs);
    
    const nearbyAppointments = await this.sheetsService.findAppointments({
      clientId: appointment.clientId,
      clinicianId: appointment.clinicianId,
      dateRangeStart: timeWindowStart.toISOString(),
      dateRangeEnd: timeWindowEnd.toISOString(),
      excludeIds: [appointment.appointmentId]
    });
    
    if (nearbyAppointments.length > 0) {
      // Additional verification - check status
      const possibleDuplicate = nearbyAppointments[0];
      
      // If the existing appointment is cancelled, this is likely not a duplicate
      // but a rescheduled appointment
      if (possibleDuplicate.status === 'cancelled') {
        return { isDuplicate: false };
      }
      
      return {
        isDuplicate: true,
        reason: 'Same client and clinician with very close start time',
        existingAppointmentId: possibleDuplicate.appointmentId
      };
    }
    
    // Not a duplicate
    return { isDuplicate: false };
  } catch (error) {
    console.error('Error checking for duplicate appointment:', error);
    // Fail safe - if we can't check properly, assume it's not a duplicate
    return { isDuplicate: false };
  }
}

// In sheets.ts - Add this method to support the improved duplicate detection
async findAppointments(criteria: {
  clientId?: string;
  clinicianId?: string;
  startTime?: string;
  endTime?: string;
  dateRangeStart?: string;
  dateRangeEnd?: string;
  status?: string;
  excludeIds?: string[];
}): Promise<AppointmentRecord[]> {
  // Implementation to search appointments based on criteria
  // This can be optimized with caching and proper filtering
}
```

### 3. Fix Appointment Cancellation Process

**Implement in**: `src/lib/intakeq/appointment-sync.ts`

```typescript
// In appointment-sync.ts - Enhanced cancellation handling
async handleAppointmentCancellation(
  appointment: IntakeQAppointment, 
  attempt: number = 1
): Promise<WebhookResponse> {
  const maxAttempts = 3;
  const appointmentId = appointment.Id;
  
  console.log(`Processing appointment cancellation: ${appointmentId}`);
  
  try {
    // Force cache invalidation for this appointment before searching
    this.sheetsService.cache.invalidatePattern(`appointments:${appointmentId}`);
    this.sheetsService.cache.invalidatePattern(`sheet:${SHEET_NAMES.APPOINTMENTS}`);
    this.sheetsService.cache.invalidatePattern(`sheet:${SHEET_NAMES.ACTIVE_APPOINTMENTS}`);
    
    // First, try to get the appointment
    let existingAppointment = await this.sheetsService.getAppointment(appointmentId);
    
    // If not found on first attempt, try broader search
    if (!existingAppointment && attempt === 1) {
      console.log(`Appointment ${appointmentId} not found on initial lookup, trying broader search...`);
      
      // Search by client name and approximate time if available
      if (appointment.ClientName && appointment.StartDateIso) {
        const clientAppointments = await this.sheetsService.findAppointmentsByClientName(
          appointment.ClientName,
          new Date(appointment.StartDateIso)
        );
        
        if (clientAppointments.length > 0) {
          console.log(`Found ${clientAppointments.length} possible matches for cancelled appointment by client name`);
          
          // Log potential matches for debugging
          clientAppointments.forEach(app => {
            console.log(`Potential match: ${app.appointmentId}, ${app.startTime}, ${app.status}`);
          });
          
          // Update the first matching appointment's ID in our system to match IntakeQ
          // This helps sync appointments that somehow got different IDs
          if (clientAppointments.length === 1 && clientAppointments[0].status !== 'cancelled') {
            console.log(`Updating appointment ID from ${clientAppointments[0].appointmentId} to ${appointmentId} to match IntakeQ`);
            
            await this.sheetsService.updateAppointmentId(
              clientAppointments[0].appointmentId, 
              appointmentId
            );
            
            // Now it should be found with the correct ID
            existingAppointment = await this.sheetsService.getAppointment(appointmentId);
          }
        }
      }
    }
    
    if (!existingAppointment) {
      console.log(`Appointment ${appointmentId} not found on attempt ${attempt}`);
      
      if (attempt < maxAttempts) {
        // Wait before trying again - exponential backoff
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        
        return this.handleAppointmentCancellation(appointment, attempt + 1);
      }
      
      // After all attempts, record the issue but don't fail
      console.log(`Appointment ${appointmentId} not found for cancellation after ${maxAttempts} attempts`);
      
      // Special handling for recurring appointments
      const isRecurring = this.isRecurringAppointment(appointment);
      if (isRecurring) {
        await this.sheetsService.addAuditLog({
          timestamp: new Date().toISOString(),
          eventType: 'SYSTEM_WARNING',
          description: `Appointment not found, but recorded cancellation for recurring series`,
          user: 'SYSTEM',
          systemNotes: JSON.stringify({
            appointmentId,
            clientName: appointment.ClientName,
            startDate: appointment.StartDateIso
          })
        });
        
        return {
          success: true,
          details: {
            appointmentId,
            message: 'Appointment not found, but recorded cancellation for recurring series'
          }
        };
      }
      
      // For non-recurring, this is an error but we don't retry further
      return {
        success: false,
        error: `Appointment ${appointmentId} not found for cancellation`,
        retryable: false
      };
    }
    
    // Normal cancellation process continues here
    await this.sheetsService.updateAppointmentStatus(appointmentId, 'cancelled', {
      reason: appointment.CancellationReason || 'Cancelled via IntakeQ',
      notes: `Cancelled on ${new Date().toISOString()}`
    });
    
    console.log(`Successfully cancelled appointment ${appointmentId}`);
    
    // Log cancellation audit
    await this.sheetsService.addAuditLog({
      timestamp: new Date().toISOString(),
      eventType: 'APPOINTMENT_CANCELLED',
      description: `Cancelled appointment for ${existingAppointment.clientName}`,
      user: 'INTAKEQ_WEBHOOK',
      systemNotes: JSON.stringify({
        appointmentId,
        reason: appointment.CancellationReason || 'Not specified',
        clientId: existingAppointment.clientId
      })
    });
    
    return {
      success: true,
      details: {
        appointmentId,
        status: 'cancelled'
      }
    };
  } catch (error) {
    // Error handling as before
  }
}

// Add in sheets.ts - Support method for finding appointments by client name
async findAppointmentsByClientName(
  clientName: string,
  approximateDate?: Date,
  status?: string
): Promise<AppointmentRecord[]> {
  try {
    // Search in both tabs for robustness
    const mainAppointments = await this.readSheet(`${SHEET_NAMES.APPOINTMENTS}!A:R`);
    const activeAppointments = await this.readSheet(`${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A:R`);
    
    const allRows = [...(mainAppointments || []), ...(activeAppointments || [])];
    const uniqueRows = this.removeDuplicateRows(allRows);
    
    let filteredAppointments = uniqueRows
      .filter(row => {
        // Client name match (case insensitive and allowing partial matches)
        const rowClientName = (row[2] || '').toLowerCase();
        const searchName = clientName.toLowerCase();
        
        return rowClientName.includes(searchName) || searchName.includes(rowClientName);
      })
      .map(row => this.rowToAppointment(row))
      .filter(appointment => appointment !== null) as AppointmentRecord[];
    
    // Further filter by date if provided
    if (approximateDate) {
      const targetDate = approximateDate.getTime();
      const dayInMs = 24 * 60 * 60 * 1000;
      
      filteredAppointments = filteredAppointments.filter(appt => {
        const appointmentDate = new Date(appt.startTime).getTime();
        // Allow 1 day before or after for timezone issues
        return Math.abs(appointmentDate - targetDate) < dayInMs;
      });
    }
    
    // Filter by status if provided
    if (status) {
      filteredAppointments = filteredAppointments.filter(appt => 
        appt.status.toLowerCase() === status.toLowerCase()
      );
    }
    
    return filteredAppointments;
  } catch (error) {
    console.error('Error finding appointments by client name:', error);
    return [];
  }
}
```

### 4. Improve Webhook Idempotency

**Implement in**: `src/lib/intakeq/webhook-handler.ts`

```typescript
// In webhook-handler.ts - Enhanced idempotency key generation
private generateIdempotencyKey(payload: any): string {
  // Create a unique identifier based on payload content
  const type = payload.Type || payload.EventType || 'Unknown';
  let entityId = '';
  
  if (payload.Appointment?.Id) {
    entityId = `appointment-${payload.Appointment.Id}`;
    
    // For appointment updates, include the timestamp or a hash of critical fields
    // to distinguish between multiple updates to the same appointment
    if (type.includes('Updated') || type.includes('Rescheduled')) {
      const fieldsHash = this.hashAppointmentFields(payload.Appointment);
      return `${type}-${entityId}-${fieldsHash}`;
    }
    
    // For creation and cancellation, just use the ID as these should be processed only once
    if (type.includes('Created') || type.includes('Cancelled') || type.includes('Canceled')) {
      return `${type}-${entityId}`;
    }
  } else if (payload.IntakeId || payload.formId) {
    entityId = `form-${payload.IntakeId || payload.formId}`;
  }
  
  // Add timestamp from payload if available
  const timestamp = payload.DateCreated || payload.Appointment?.DateCreated || '';
  
  // Create a more reliable hash of the content
  // Use critical fields that would differentiate this webhook from others
  const criticalFields = {
    type,
    entityId,
    timestamp,
    clientId: payload.ClientId,
    startDate: payload.Appointment?.StartDateIso || '',
    endDate: payload.Appointment?.EndDateIso || '',
    status: payload.Appointment?.Status || ''
  };
  
  const contentString = JSON.stringify(criticalFields);
  
  const contentHash = require('crypto')
    .createHash('sha256')
    .update(contentString)
    .digest('hex')
    .substring(0, 12); // Use more characters for better uniqueness
  
  return `${type}-${entityId}-${contentHash}`;
}

// Helper method to hash critical appointment fields
private hashAppointmentFields(appointment: any): string {
  // Extract the fields that constitute a meaningful change
  const criticalFields = {
    startDate: appointment.StartDateIso || '',
    endDate: appointment.EndDateIso || '',
    status: appointment.Status || '',
    location: appointment.Location || '',
    serviceType: appointment.ServiceType || '',
    practitionerId: appointment.PractitionerId || ''
  };
  
  return require('crypto')
    .createHash('md5')
    .update(JSON.stringify(criticalFields))
    .digest('hex')
    .substring(0, 8);
}
```

### 5. Optimize Google Sheets API Usage

**Implement in**: `src/lib/google/sheets.ts` and `src/lib/google/sheets-cache.ts`

```typescript
// In sheets.ts - Optimized cache invalidation
async invalidateCacheForAppointment(appointmentId: string): Promise<void> {
  // Targeted invalidation instead of broad sheet invalidation
  this.cache.invalidate(`appointment:${appointmentId}`);
}

// Batch appointment updates to reduce API calls
async batchUpdateAppointments(appointments: AppointmentRecord[]): Promise<{
  success: boolean;
  successCount: number;
  failureCount: number;
  failures: { appointmentId: string; error: string }[];
}> {
  if (appointments.length === 0) {
    return { success: true, successCount: 0, failureCount: 0, failures: [] };
  }
  
  const failures: { appointmentId: string; error: string }[] = [];
  let successCount = 0;
  
  try {
    // Group updates by sheet
    const mainSheetUpdates: any[] = [];
    const activeSheetUpdates: any[] = [];
    
    // Prepare batch requests
    for (const appointment of appointments) {
      // Find row index in main Appointments sheet
      const mainRowIndex = await this.findRowIndexByAppointmentId(
        appointment.appointmentId, 
        SHEET_NAMES.APPOINTMENTS
      );
      
      if (mainRowIndex > 0) {
        mainSheetUpdates.push({
          range: `${SHEET_NAMES.APPOINTMENTS}!A${mainRowIndex}:R${mainRowIndex}`,
          values: [this.appointmentToRow(appointment)]
        });
        
        // Invalidate cache entry
        this.cache.invalidate(`appointment:${appointment.appointmentId}`);
        
        // If for today, also update Active_Appointments
        if (this.isAppointmentForToday(appointment)) {
          const activeRowIndex = await this.findRowIndexByAppointmentId(
            appointment.appointmentId, 
            SHEET_NAMES.ACTIVE_APPOINTMENTS
          );
          
          if (activeRowIndex > 0) {
            activeSheetUpdates.push({
              range: `${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A${activeRowIndex}:R${activeRowIndex}`,
              values: [this.appointmentToRow(appointment)]
            });
          } else {
            // Not found in Active_Appointments but should be - append it
            activeSheetUpdates.push({
              range: `${SHEET_NAMES.ACTIVE_APPOINTMENTS}!A:R`, 
              values: [this.appointmentToRow(appointment)]
            });
          }
        }
        
        successCount++;
      } else {
        failures.push({
          appointmentId: appointment.appointmentId,
          error: 'Appointment not found in main sheet'
        });
      }
    }
    
    // Execute batch updates if any
    if (mainSheetUpdates.length > 0) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: {
          valueInputOption: 'RAW',
          data: mainSheetUpdates
        }
      });
    }
    
    if (activeSheetUpdates.length > 0) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: {
          valueInputOption: 'RAW',
          data: activeSheetUpdates
        }
      });
    }
    
    return {
      success: failures.length === 0,
      successCount,
      failureCount: failures.length,
      failures
    };
  } catch (error) {
    console.error('Error in batch update appointments:', error);
    
    // Add any appointments not in failures list
    const processedIds = failures.map(f => f.appointmentId);
    for (const appointment of appointments) {
      if (!processedIds.includes(appointment.appointmentId)) {
        failures.push({
          appointmentId: appointment.appointmentId,
          error: error instanceof Error ? error.message : 'Unknown batch update error'
        });
      }
    }
    
    return {
      success: false,
      successCount,
      failureCount: failures.length,
      failures
    };
  }
}
```

## Implementation Plan

To implement these fixes with minimal risk, we recommend the following approach:

1. **Phase 1: Monitoring and Diagnostics**
   - Implement enhanced logging for Google Sheets operations
   - Add audit log entries for silent failures
   - Create a real-time monitoring dashboard for operation status

2. **Phase 2: Verification and Recovery**
   - Add appointment existence verification after adding
   - Implement recovery processes for failed operations
   - Enhance the Webhook_Log tab to store more detailed status information

3. **Phase 3: Core Fixes**
   - Improve duplicate detection with the more robust algorithm
   - Enhance appointment cancellation with fallback searches
   - Fix the webhook idempotency key generation

4. **Phase 4: Performance Optimization**
   - Implement targeted cache invalidation to reduce API calls
   - Add batching for appointment updates
   - Optimize sheet reading operations

5. **Phase 5: Testing and Validation**
   - Create comprehensive test cases for each fix
   - Run simulated high-volume webhook tests
   - Verify appointments are properly synchronized in all scenarios

## Conclusion

These fixes address the core synchronization issues while maintaining the current Version 1.0 architecture based on Google Sheets. By implementing these changes, we can significantly improve reliability without requiring a complete migration to Version 2.0 yet.

The focus has been on addressing the immediate synchronization issues while ensuring we stay within Google Sheets API quota limits. These changes will pave the way for a smoother migration to Version 2.0 when ready by establishing more robust synchronization patterns that can be carried forward.