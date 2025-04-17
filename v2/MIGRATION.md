# Migration Plan: Sheets to Firestore

This document outlines the plan for migrating from Version 1 (Google Sheets) to Version 2 (Firestore).

## Migration Strategy

The migration will follow these key principles:

1. **Parallel Operation**: Both systems will run in parallel during migration
2. **Data Integrity**: Ensure all data is correctly transferred
3. **Minimal Disruption**: Users should experience no downtime
4. **Verifiable Results**: Validation steps to ensure data accuracy

## Migration Steps

### 1. Infrastructure Setup

- [x] Create Firebase project
- [x] Set up Firestore database
- [x] Configure Firebase security rules
- [ ] Set up authentication system
- [ ] Deploy Firebase functions

### 2. Data Migration

- [ ] Export existing data from Google Sheets
- [ ] Transform data to fit Firestore schema
- [ ] Import data to Firestore
- [ ] Verify data integrity

### 3. Parallel Operation

- [ ] Configure IntakeQ to send webhooks to both systems
- [ ] Implement dual-write strategy for any manual changes
- [ ] Compare results between systems daily
- [ ] Fix any discrepancies in near real-time

### 4. Final Cutover

- [ ] Verify all data is in sync
- [ ] Redirect all webhooks to V2 exclusively
- [ ] Switch API endpoints to V2
- [ ] Maintain V1 in read-only mode for reference

## Migration Timeline

| Phase | Estimated Time | Description |
|-------|----------------|-------------|
| Setup | 1 week | Infrastructure setup and initial development |
| Data Migration | 1-2 days | One-time copy of historical data |
| Parallel Run | 2-4 weeks | Both systems running, fixing any issues |
| Cutover | 1 day | Final switch to V2 |

## Testing Approach

Before the final cutover, we'll perform extensive testing:

1. **Unit Tests**: For all core functionality
2. **Integration Tests**: Webhook handling, scheduling logic
3. **Data Verification**: Compare data between V1 and V2
4. **Performance Tests**: Ensure V2 meets or exceeds V1 performance

## Rollback Plan

If issues are encountered during migration:

1. Keep V1 as the system of record
2. Redirect webhooks back to V1
3. Fix issues in V2
4. Retry migration

## Post-Migration Monitoring

After migration, we'll closely monitor:

1. Webhook processing
2. Appointment creation/updates
3. Office assignment accuracy
4. System performance

## Data Mapping

| V1 (Sheets) | V2 (Firestore) | Notes |
|-------------|----------------|-------|
| Appointments tab | appointments collection | One document per appointment |
| Clinicians tab | clinicians collection | One document per clinician |
| Offices tab | offices collection | One document per office |
| Webhooks tab | webhooks collection | One document per webhook |
| Config tab | config collection | Configuration as documents |
| Logs tab | logs collection | Audit trail as documents |

## Firestore Schema Advantages

The Firestore implementation offers several advantages:

1. **Transactions**: Atomic operations for data consistency
2. **Queries**: More powerful query capabilities than Sheets API
3. **Scalability**: Higher throughput for webhook processing
4. **Security**: Row-level security with Firestore rules
5. **Performance**: Lower latency for read/write operations