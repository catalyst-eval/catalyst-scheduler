# Log Analysis Report

## Summary

- **Total Lines:**    10418
- **Webhook Events:** 581
- **Unique Appointment IDs:**       92
- **Error Events:** 7

## Missing Appointments

    message: 'Appointment not found, but recorded cancellation for recurring series'
Appointment 67dda51e9f0abc9065dd9b6d not found on attempt 3
Appointment 67dda51e9f0abc9065dd9b6d not found for cancellation after 3 attempts
Appointment 67dda51e9f0abc9065dd9b6d not found on attempt 2
Appointment 67dda51e9f0abc9065dd9b6d not found on attempt 1

## Duplicate Appointments

Removed duplicate appointment 67fe4cc74226f7d2e5170140 from 2025-04-15T12:10:59.025Z
Removed duplicate appointment 67fd6e50211218516cffaced from 2025-04-14T20:23:44.318Z
Removed duplicate appointment 67c708635a72d45d44d14a0f from 2025-03-04T14:04:00.000Z
Removed duplicate appointment 67c708625a72d45d44d14a0b from 2025-03-04T14:04:00.000Z
Removed duplicate appointment 67c708625a72d45d44d14a04 from 2025-03-04T14:04:00.000Z
Removed duplicate appointment 67c708605a72d45d44d149f4 from 2025-03-04T14:04:00.000Z
Removed duplicate appointment 67c708605a72d45d44d149ee from 2025-03-04T14:04:00.000Z
Removed duplicate appointment 67c7085f5a72d45d44d149eb from 2025-03-04T14:04:00.000Z
Removed duplicate appointment 67e3f37fc021e28ca9aa61b1 from 2025-04-03T18:57:00.000Z
Removed duplicate appointment 67c03923c87d44c7f489a381 from 2025-02-27T16:43:00.000Z
Found 10 appointments with duplicates
Checking for duplicate appointment entries
Registering scheduled task: DUPLICATE_CLEANUP (Clean up duplicate appointments)
Removed duplicate appointment 67f939939f38b669902db74f from 2025-04-11T15:47:40.707Z
Removed duplicate appointment 67f912851726f9bbf67feba0 from 2025-04-11T13:01:01.831Z
Removed duplicate appointment 67f6c58221324a74325045a7 from 2025-04-10T12:13:10.689Z
Removed duplicate appointment 67d1d9bff109c797ac7d40c4 from 2025-03-26T18:57:00.000Z
Removed duplicate appointment 67ec35b5252f16ec70d96d8a from 2025-04-01T18:51:00.000Z
Removed duplicate appointment 67784c6d2848a011d64dcbc0 from 2025-02-27T16:43:00.000Z
Removed duplicate appointment 67e59f560a7853e04e1125d9 from 2025-03-27T18:56:00.000Z
Removed duplicate appointment 67e1ad5a600db10a739376bd from 2025-03-24T19:07:00.000Z
Found 8 appointments with duplicates
Checking for duplicate appointment entries

## Webhook Processing

Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
Received webhook: {
...

## Appointment Events

### Created Appointments

Processing AppointmentCreated event for appointment 67ffe324604b571d275bbd3d
Processing AppointmentCreated event for appointment 67ffdd4bd70e2cdfc2c38a9a
Processing AppointmentCreated event for appointment 67ffabf4771d092225b74de5
Processing AppointmentCreated event for appointment 67fef8519503305ce5cfb738
Processing AppointmentCreated event for appointment 67fef78d33178c7faa73efe1
Processing AppointmentCreated event for appointment 67fef78c33178c7faa73efde
Processing AppointmentCreated event for appointment 67fef78c33178c7faa73efdc
Processing AppointmentCreated event for appointment 67fef78b33178c7faa73efda
Processing AppointmentCreated event for appointment 67fef78a33178c7faa73efd1
Processing AppointmentCreated event for appointment 67fef78b33178c7faa73efd5
Processing AppointmentCreated event for appointment 67fef78a33178c7faa73efca
Processing AppointmentCreated event for appointment 67fef78833178c7faa73efbc
Processing AppointmentCreated event for appointment 67fef78933178c7faa73efbf
Processing AppointmentCreated event for appointment 67feec33b23568658e583ade
Processing AppointmentCreated event for appointment 67fedbdcd6648c7549dea1f9
...

### Updated Appointments

Updated 13 appointments with new office assignments
Updated 12 appointments with new office assignments
Updated 10 appointments with new office assignments
Updated 11 appointments with new office assignments
Updated 10 appointments with new office assignments
Updated 18 appointments with new office assignments
...

### Cancelled Appointments

    action: 'cancelled_recurring_appointment',
...

## Office Assignment

  - Assigned office: C-2
  - Assignment reason: Telehealth appointment assigned to clinician's primary office (Priority 85)
  - Assigned office: B-2
  - Assignment reason: Telehealth appointment assigned to clinician's primary office (Priority 85)
Updated 13 appointments with new office assignments
    Assigned to: C-2, Reason: Client has specific office requirement (Priority 100)
    Assigned to: C-2, Reason: Client has specific office requirement (Priority 100)
=== OFFICE ASSIGNMENT SUMMARY ===
  Reason: Assigned to clinician's primary office (Priority 65)
  MATCH: Assigned to clinician's primary office (Priority 65) - Office C-3
  Reason: Assigned to clinician's primary office (Priority 65)
  MATCH: Assigned to clinician's primary office (Priority 65) - Office B-4
  MATCH: Young child (9 years old) assigned to B-5 (Priority 80) - Office B-5
  Reason: Assigned to clinician's primary office (Priority 65)
  MATCH: Assigned to clinician's primary office (Priority 65) - Office C-3
  Reason: Assigned to clinician's primary office (Priority 65)
  MATCH: Assigned to clinician's primary office (Priority 65) - Office C-2
  Reason: Assigned to clinician's primary office (Priority 65)
  MATCH: Assigned to clinician's primary office (Priority 65) - Office C-3
  MATCH: Young child (10 years old) assigned to B-5 (Priority 80) - Office B-5
...

## Validation Issues

Invalidating cache key: sheet:Active_Appointments!A2:R
Invalidating cache key: sheet:Appointments!A2:R
Date validation complete for appointment 67ffe324604b571d275bbd3d
Invalidating cache key: sheet:Active_Appointments!A2:R
Invalidating cache key: sheet:Appointments!A2:R
Date validation complete for appointment 67ffdd4bd70e2cdfc2c38a9a
Invalidating cache key: sheet:Active_Appointments!A2:R
Invalidating cache key: sheet:Appointments!A2:R
Invalidating cache key: sheet:Appointments!A:A
Invalidating cache key: sheet:Active_Appointments!A2:R
Invalidated 0 cache entries matching pattern: daily:.*
Invalidating cache keys matching pattern: daily:.*
Invalidated 1 cache entries matching pattern: sheet:.*Appointments.*
Invalidating cache keys matching pattern: sheet:.*Appointments.*
Invalidating all appointment-related cache entries
Invalidating cache key: sheet:Active_Appointments!A2:R
Invalidating cache key: sheet:Appointments!A2:R
Date validation complete for appointment 67ffabf4771d092225b74de5
Invalidating cache key: sheet:Active_Appointments!A2:R
Invalidating cache key: sheet:Appointments!A2:R

## Analysis of Duplicate Appointments

### Appointment ID: 67784c6d2848a011d64dcbc0

Removed duplicate appointment 67784c6d2848a011d64dcbc0 from 2025-02-27T16:43:00.000Z
Successfully deleted appointment 67784c6d2848a011d64dcbc0 from row 8
Successfully deleted appointment 67784c6d2848a011d64dcbc0 from main Appointments tab
Found appointment 67784c6d2848a011d64dcbc0 at row index 6 (Row 8 in sheet)
Starting deletion process for appointment 67784c6d2848a011d64dcbc0
Keeping appointment 67784c6d2848a011d64dcbc0 from 2025-04-15T10:00:09.785Z
Found appointment 67784c6d2848a011d64dcbc0 in Active_Appointments
Found appointment 67784c6d2848a011d64dcbc0 in Active_Appointments
Looking for appointment 67784c6d2848a011d64dcbc0 in Active_Appointments
Looking for appointment 67784c6d2848a011d64dcbc0 in Active_Appointments
Resolving office for appointment 67784c6d2848a011d64dcbc0 (Addy Cleland): Addy Cleland with Carlisle
Resolving office for appointment 67784c6d2848a011d64dcbc0 (Addy Cleland): Addy Cleland with Carlisle Bading
Found appointment: 67784c6d2848a011d64dcbc0, time: 2025-04-14 18:00, client: Addy Cleland
Found appointment: 67784c6d2848a011d64dcbc0, time: 2025-04-14T20:30:00.000Z, client: Addy Cleland

### Appointment ID: 67c03923c87d44c7f489a381

Removed duplicate appointment 67c03923c87d44c7f489a381 from 2025-02-27T16:43:00.000Z
Successfully deleted appointment 67c03923c87d44c7f489a381 from row 14
Successfully deleted appointment 67c03923c87d44c7f489a381 from main Appointments tab
Found appointment 67c03923c87d44c7f489a381 at row index 12 (Row 14 in sheet)
Starting deletion process for appointment 67c03923c87d44c7f489a381
Keeping appointment 67c03923c87d44c7f489a381 from 2025-04-16T10:00:07.988Z
Found appointment 67c03923c87d44c7f489a381 in Active_Appointments
Looking for appointment 67c03923c87d44c7f489a381 in Active_Appointments
Resolving office for appointment 67c03923c87d44c7f489a381 (Morgan Watson): Morgan Watson with Samantha Barnhart
Found appointment: 67c03923c87d44c7f489a381, time: 2025-04-15T18:30:00.000Z, client: Morgan Watson
Looking for appointment 67c03923c87d44c7f489a381 in Active_Appointments
Resolving office for appointment 67c03923c87d44c7f489a381 (Morgan Watson): Morgan Watson with Samantha Barnhart
Found appointment: 67c03923c87d44c7f489a381, time: 2025-04-15T18:30:00.000Z, client: Morgan Watson
Found appointment 67c03923c87d44c7f489a381 in Active_Appointments
Looking for appointment 67c03923c87d44c7f489a381 in Active_Appointments
Resolving office for appointment 67c03923c87d44c7f489a381 (Morgan Watson): Morgan Watson with Samantha Barnhart
Found appointment: 67c03923c87d44c7f489a381, time: 2025-04-15T18:30:00.000Z, client: Morgan Watson

### Appointment ID: 67c7085f5a72d45d44d149eb

Removed duplicate appointment 67c7085f5a72d45d44d149eb from 2025-03-04T14:04:00.000Z
Successfully deleted appointment 67c7085f5a72d45d44d149eb from row 135
Successfully deleted appointment 67c7085f5a72d45d44d149eb from main Appointments tab
Found appointment 67c7085f5a72d45d44d149eb at row index 133 (Row 135 in sheet)
Starting deletion process for appointment 67c7085f5a72d45d44d149eb
Keeping appointment 67c7085f5a72d45d44d149eb from 2025-04-15T13:47:21.124Z
    appointmentId: '67c7085f5a72d45d44d149eb',
Date validation complete for appointment 67c7085f5a72d45d44d149eb
Validating dates for appointment 67c7085f5a72d45d44d149eb, StartDateIso: 2025-05-16T18:30:00.0000000Z, EndDateIso: 2025-05-16T19:20:00.0000000Z
Processing appointment update: 67c7085f5a72d45d44d149eb
Found existing appointment 67c7085f5a72d45d44d149eb in database
    "Id": "67c7085f5a72d45d44d149eb",
Processing AppointmentRescheduled event for appointment 67c7085f5a72d45d44d149eb
  appointmentId: '67c7085f5a72d45d44d149eb',

### Appointment ID: 67c708605a72d45d44d149ee

Removed duplicate appointment 67c708605a72d45d44d149ee from 2025-03-04T14:04:00.000Z
Successfully deleted appointment 67c708605a72d45d44d149ee from row 171
Successfully deleted appointment 67c708605a72d45d44d149ee from main Appointments tab
Found appointment 67c708605a72d45d44d149ee at row index 169 (Row 171 in sheet)
Starting deletion process for appointment 67c708605a72d45d44d149ee
Keeping appointment 67c708605a72d45d44d149ee from 2025-04-15T13:47:35.335Z
    appointmentId: '67c708605a72d45d44d149ee',
Date validation complete for appointment 67c708605a72d45d44d149ee
Validating dates for appointment 67c708605a72d45d44d149ee, StartDateIso: 2025-05-30T18:30:00.0000000Z, EndDateIso: 2025-05-30T19:20:00.0000000Z
Processing appointment update: 67c708605a72d45d44d149ee
Found existing appointment 67c708605a72d45d44d149ee in database
    "Id": "67c708605a72d45d44d149ee",
Processing AppointmentRescheduled event for appointment 67c708605a72d45d44d149ee
  appointmentId: '67c708605a72d45d44d149ee',

### Appointment ID: 67c708605a72d45d44d149f4

Removed duplicate appointment 67c708605a72d45d44d149f4 from 2025-03-04T14:04:00.000Z
Successfully deleted appointment 67c708605a72d45d44d149f4 from row 198
Successfully deleted appointment 67c708605a72d45d44d149f4 from main Appointments tab
Found appointment 67c708605a72d45d44d149f4 at row index 196 (Row 198 in sheet)
Starting deletion process for appointment 67c708605a72d45d44d149f4
Keeping appointment 67c708605a72d45d44d149f4 from 2025-04-15T13:47:41.263Z
    appointmentId: '67c708605a72d45d44d149f4',
Date validation complete for appointment 67c708605a72d45d44d149f4
Validating dates for appointment 67c708605a72d45d44d149f4, StartDateIso: 2025-06-13T18:30:00.0000000Z, EndDateIso: 2025-06-13T19:20:00.0000000Z
Processing appointment update: 67c708605a72d45d44d149f4
Found existing appointment 67c708605a72d45d44d149f4 in database
    "Id": "67c708605a72d45d44d149f4",
Processing AppointmentRescheduled event for appointment 67c708605a72d45d44d149f4
  appointmentId: '67c708605a72d45d44d149f4',

### Appointment ID: 67c708625a72d45d44d14a04

Removed duplicate appointment 67c708625a72d45d44d14a04 from 2025-03-04T14:04:00.000Z
Successfully deleted appointment 67c708625a72d45d44d14a04 from row 216
Successfully deleted appointment 67c708625a72d45d44d14a04 from main Appointments tab
Found appointment 67c708625a72d45d44d14a04 at row index 214 (Row 216 in sheet)
Starting deletion process for appointment 67c708625a72d45d44d14a04
Keeping appointment 67c708625a72d45d44d14a04 from 2025-04-15T13:48:09.911Z
    appointmentId: '67c708625a72d45d44d14a04',
Date validation complete for appointment 67c708625a72d45d44d14a04
Validating dates for appointment 67c708625a72d45d44d14a04, StartDateIso: 2025-06-27T18:30:00.0000000Z, EndDateIso: 2025-06-27T19:20:00.0000000Z
Processing appointment update: 67c708625a72d45d44d14a04
Found existing appointment 67c708625a72d45d44d14a04 in database
    "Id": "67c708625a72d45d44d14a04",
Processing AppointmentRescheduled event for appointment 67c708625a72d45d44d14a04
  appointmentId: '67c708625a72d45d44d14a04',

### Appointment ID: 67c708625a72d45d44d14a0b

Removed duplicate appointment 67c708625a72d45d44d14a0b from 2025-03-04T14:04:00.000Z
Successfully deleted appointment 67c708625a72d45d44d14a0b from row 231
Successfully deleted appointment 67c708625a72d45d44d14a0b from main Appointments tab
Found appointment 67c708625a72d45d44d14a0b at row index 229 (Row 231 in sheet)
Starting deletion process for appointment 67c708625a72d45d44d14a0b
Keeping appointment 67c708625a72d45d44d14a0b from 2025-04-15T13:48:19.440Z
    appointmentId: '67c708625a72d45d44d14a0b',
Date validation complete for appointment 67c708625a72d45d44d14a0b
Validating dates for appointment 67c708625a72d45d44d14a0b, StartDateIso: 2025-07-11T18:30:00.0000000Z, EndDateIso: 2025-07-11T19:20:00.0000000Z
Processing appointment update: 67c708625a72d45d44d14a0b
Found existing appointment 67c708625a72d45d44d14a0b in database
    "Id": "67c708625a72d45d44d14a0b",
Processing AppointmentRescheduled event for appointment 67c708625a72d45d44d14a0b
  appointmentId: '67c708625a72d45d44d14a0b',

### Appointment ID: 67c708635a72d45d44d14a0f

Removed duplicate appointment 67c708635a72d45d44d14a0f from 2025-03-04T14:04:00.000Z
Successfully deleted appointment 67c708635a72d45d44d14a0f from row 241
Successfully deleted appointment 67c708635a72d45d44d14a0f from main Appointments tab
Found appointment 67c708635a72d45d44d14a0f at row index 239 (Row 241 in sheet)
Starting deletion process for appointment 67c708635a72d45d44d14a0f
Keeping appointment 67c708635a72d45d44d14a0f from 2025-04-15T13:48:29.593Z
    appointmentId: '67c708635a72d45d44d14a0f',
Date validation complete for appointment 67c708635a72d45d44d14a0f
Validating dates for appointment 67c708635a72d45d44d14a0f, StartDateIso: 2025-07-25T18:30:00.0000000Z, EndDateIso: 2025-07-25T19:20:00.0000000Z
Processing appointment update: 67c708635a72d45d44d14a0f
Found existing appointment 67c708635a72d45d44d14a0f in database
    "Id": "67c708635a72d45d44d14a0f",
Processing AppointmentRescheduled event for appointment 67c708635a72d45d44d14a0f
  appointmentId: '67c708635a72d45d44d14a0f',

### Appointment ID: 67d1d9bff109c797ac7d40c4

Removed duplicate appointment 67d1d9bff109c797ac7d40c4 from 2025-03-26T18:57:00.000Z
Successfully deleted appointment 67d1d9bff109c797ac7d40c4 from row 24
Successfully deleted appointment 67d1d9bff109c797ac7d40c4 from main Appointments tab
Found appointment 67d1d9bff109c797ac7d40c4 at row index 22 (Row 24 in sheet)
Starting deletion process for appointment 67d1d9bff109c797ac7d40c4
Keeping appointment 67d1d9bff109c797ac7d40c4 from 2025-04-14T17:38:37.248Z

### Appointment ID: 67e1ad5a600db10a739376bd

Removed duplicate appointment 67e1ad5a600db10a739376bd from 2025-03-24T19:07:00.000Z
Successfully deleted appointment 67e1ad5a600db10a739376bd from row 6
Successfully deleted appointment 67e1ad5a600db10a739376bd from main Appointments tab
Found appointment 67e1ad5a600db10a739376bd at row index 4 (Row 6 in sheet)
Starting deletion process for appointment 67e1ad5a600db10a739376bd
Keeping appointment 67e1ad5a600db10a739376bd from 2025-04-15T10:00:06.856Z
Found appointment 67e1ad5a600db10a739376bd in Active_Appointments
Looking for appointment 67e1ad5a600db10a739376bd in Active_Appointments
Resolving office for appointment 67e1ad5a600db10a739376bd (Scott Tolbert): Scott Tolbert with Tyler Seabolt
Found appointment: 67e1ad5a600db10a739376bd, time: 2025-04-14T17:00:00.000Z, client: Scott Tolbert

### Appointment ID: 67e3f37fc021e28ca9aa61b1

Removed duplicate appointment 67e3f37fc021e28ca9aa61b1 from 2025-04-03T18:57:00.000Z
Successfully deleted appointment 67e3f37fc021e28ca9aa61b1 from row 22
Successfully deleted appointment 67e3f37fc021e28ca9aa61b1 from Active_Appointments tab
Found appointment 67e3f37fc021e28ca9aa61b1 in Active_Appointments at row 9
Successfully deleted appointment 67e3f37fc021e28ca9aa61b1 from main Appointments tab
Found appointment 67e3f37fc021e28ca9aa61b1 at row index 20 (Row 22 in sheet)
Starting deletion process for appointment 67e3f37fc021e28ca9aa61b1
Keeping appointment 67e3f37fc021e28ca9aa61b1 from 2025-04-15T17:15:36.209Z
Looking for appointment 67e3f37fc021e28ca9aa61b1 in Active_Appointments
Resolving office for appointment 67e3f37fc021e28ca9aa61b1 (Creed King): Creed King with Julia
Found appointment: 67e3f37fc021e28ca9aa61b1, time: 2025-04-16 18:00, client: Creed King
Found appointment 67e3f37fc021e28ca9aa61b1 in Active_Appointments
Found appointment 67e3f37fc021e28ca9aa61b1 in Active_Appointments
Looking for appointment 67e3f37fc021e28ca9aa61b1 in Active_Appointments
Resolving office for appointment 67e3f37fc021e28ca9aa61b1 (Creed King): Creed King with Julia
Found appointment: 67e3f37fc021e28ca9aa61b1, time: 2025-04-16 18:00, client: Creed King
    appointmentId: '67e3f37fc021e28ca9aa61b1',
Date validation complete for appointment 67e3f37fc021e28ca9aa61b1
Validating dates for appointment 67e3f37fc021e28ca9aa61b1, StartDateIso: 2025-04-16T18:00:00.0000000Z, EndDateIso: 2025-04-16T18:50:00.0000000Z
Processing appointment update: 67e3f37fc021e28ca9aa61b1

### Appointment ID: 67e59f560a7853e04e1125d9

Removed duplicate appointment 67e59f560a7853e04e1125d9 from 2025-03-27T18:56:00.000Z
Successfully deleted appointment 67e59f560a7853e04e1125d9 from row 7
Successfully deleted appointment 67e59f560a7853e04e1125d9 from main Appointments tab
Found appointment 67e59f560a7853e04e1125d9 at row index 5 (Row 7 in sheet)
Starting deletion process for appointment 67e59f560a7853e04e1125d9
Keeping appointment 67e59f560a7853e04e1125d9 from 2025-04-15T10:00:08.634Z
Found appointment 67e59f560a7853e04e1125d9 in Active_Appointments
Looking for appointment 67e59f560a7853e04e1125d9 in Active_Appointments
Resolving office for appointment 67e59f560a7853e04e1125d9 (Jarasen Peneguy): Jarasen Peneguy with Bailey Serrano
Found appointment: 67e59f560a7853e04e1125d9, time: 2025-04-14T18:00:00.000Z, client: Jarasen Peneguy

### Appointment ID: 67ec35b5252f16ec70d96d8a

Found appointment 67ec35b5252f16ec70d96d8a in Active_Appointments
Looking for appointment 67ec35b5252f16ec70d96d8a in Active_Appointments
Resolving office for appointment 67ec35b5252f16ec70d96d8a (Kinsey Segars): Kinsey Segars with Carlisle Bading
Found appointment: 67ec35b5252f16ec70d96d8a, time: 2025-04-15T16:00:00.000Z, client: Kinsey Segars
Removed duplicate appointment 67ec35b5252f16ec70d96d8a from 2025-04-01T18:51:00.000Z
Successfully deleted appointment 67ec35b5252f16ec70d96d8a from row 12
Successfully deleted appointment 67ec35b5252f16ec70d96d8a from Active_Appointments tab
Found appointment 67ec35b5252f16ec70d96d8a in Active_Appointments at row 5
Successfully deleted appointment 67ec35b5252f16ec70d96d8a from main Appointments tab
Found appointment 67ec35b5252f16ec70d96d8a at row index 10 (Row 12 in sheet)
Starting deletion process for appointment 67ec35b5252f16ec70d96d8a
Keeping appointment 67ec35b5252f16ec70d96d8a from 2025-04-14T18:01:11.310Z
Looking for appointment 67ec35b5252f16ec70d96d8a in Active_Appointments
Resolving office for appointment 67ec35b5252f16ec70d96d8a (Kinsey Segars): Kinsey Segars with Carlisle Bading
Found appointment: 67ec35b5252f16ec70d96d8a, time: 2025-04-15T16:00:00.000Z, client: Kinsey Segars
Found appointment 67ec35b5252f16ec70d96d8a in Active_Appointments
Found appointment 67ec35b5252f16ec70d96d8a in Active_Appointments
Looking for appointment 67ec35b5252f16ec70d96d8a in Active_Appointments
Resolving office for appointment 67ec35b5252f16ec70d96d8a (Kinsey Segars): Kinsey Segars with Carlisle Bading
Found appointment: 67ec35b5252f16ec70d96d8a, time: 2025-04-15T16:00:00.000Z, client: Kinsey Segars

### Appointment ID: 67f6c58221324a74325045a7

Removed duplicate appointment 67f6c58221324a74325045a7 from 2025-04-10T12:13:10.689Z
Successfully deleted appointment 67f6c58221324a74325045a7 from row 316
Successfully deleted appointment 67f6c58221324a74325045a7 from main Appointments tab
Found appointment 67f6c58221324a74325045a7 at row index 314 (Row 316 in sheet)
Starting deletion process for appointment 67f6c58221324a74325045a7
Keeping appointment 67f6c58221324a74325045a7 from 2025-04-15T10:00:06.484Z
Found appointment 67f6c58221324a74325045a7 in Active_Appointments
Looking for appointment 67f6c58221324a74325045a7 in Active_Appointments
Resolving office for appointment 67f6c58221324a74325045a7 (John Vollrath): John Vollrath with Tyler
Found appointment: 67f6c58221324a74325045a7, time: 2025-04-14 14:00, client: John Vollrath

### Appointment ID: 67f912851726f9bbf67feba0

Removed duplicate appointment 67f912851726f9bbf67feba0 from 2025-04-11T13:01:01.831Z
Successfully deleted appointment 67f912851726f9bbf67feba0 from row 326
Successfully deleted appointment 67f912851726f9bbf67feba0 from main Appointments tab
Found appointment 67f912851726f9bbf67feba0 at row index 324 (Row 326 in sheet)
Starting deletion process for appointment 67f912851726f9bbf67feba0
Keeping appointment 67f912851726f9bbf67feba0 from 2025-04-15T10:00:10.255Z
Found appointment 67f912851726f9bbf67feba0 in Active_Appointments
Looking for appointment 67f912851726f9bbf67feba0 in Active_Appointments
Resolving office for appointment 67f912851726f9bbf67feba0 (George Rinke): George Rinke with Cullen
Found appointment: 67f912851726f9bbf67feba0, time: 2025-04-14 20:00, client: George Rinke

### Appointment ID: 67f939939f38b669902db74f

Removed duplicate appointment 67f939939f38b669902db74f from 2025-04-11T15:47:40.707Z
Successfully deleted appointment 67f939939f38b669902db74f from row 327
Successfully deleted appointment 67f939939f38b669902db74f from main Appointments tab
Found appointment 67f939939f38b669902db74f at row index 325 (Row 327 in sheet)
Starting deletion process for appointment 67f939939f38b669902db74f
Keeping appointment 67f939939f38b669902db74f from 2025-04-15T10:00:10.795Z
Found appointment 67f939939f38b669902db74f in Active_Appointments
Looking for appointment 67f939939f38b669902db74f in Active_Appointments
Resolving office for appointment 67f939939f38b669902db74f (Daniel Sartain): Daniel Sartain with Tyler
Found appointment: 67f939939f38b669902db74f, time: 2025-04-14 19:00, client: Daniel Sartain

### Appointment ID: 67fd6e50211218516cffaced

Removed duplicate appointment 67fd6e50211218516cffaced from 2025-04-14T20:23:44.318Z
Successfully deleted appointment 67fd6e50211218516cffaced from row 337
Successfully deleted appointment 67fd6e50211218516cffaced from main Appointments tab
Found appointment 67fd6e50211218516cffaced at row index 335 (Row 337 in sheet)
Starting deletion process for appointment 67fd6e50211218516cffaced
Keeping appointment 67fd6e50211218516cffaced from 2025-04-15T16:20:00.379Z
    appointmentId: '67fd6e50211218516cffaced',
Date validation complete for appointment 67fd6e50211218516cffaced
Validating dates for appointment 67fd6e50211218516cffaced, StartDateIso: 2025-04-17T18:00:00.0000000Z, EndDateIso: 2025-04-17T18:50:00.0000000Z
Processing appointment update: 67fd6e50211218516cffaced
Found existing appointment 67fd6e50211218516cffaced in database
    "Id": "67fd6e50211218516cffaced",
Processing AppointmentConfirmed event for appointment 67fd6e50211218516cffaced
  appointmentId: '67fd6e50211218516cffaced',
    appointmentId: '67fd6e50211218516cffaced',
Date validation complete for appointment 67fd6e50211218516cffaced
Validating dates for appointment 67fd6e50211218516cffaced, StartDateIso: 2025-04-17T18:00:00.0000000Z, EndDateIso: 2025-04-17T18:50:00.0000000Z
Processing new appointment: 67fd6e50211218516cffaced, client: Joseph Daniel
    "Id": "67fd6e50211218516cffaced",
Processing AppointmentCreated event for appointment 67fd6e50211218516cffaced

### Appointment ID: 67fe4cc74226f7d2e5170140

Removed duplicate appointment 67fe4cc74226f7d2e5170140 from 2025-04-15T12:10:59.025Z
Successfully deleted appointment 67fe4cc74226f7d2e5170140 from row 340
Successfully deleted appointment 67fe4cc74226f7d2e5170140 from main Appointments tab
Found appointment 67fe4cc74226f7d2e5170140 at row index 338 (Row 340 in sheet)
Starting deletion process for appointment 67fe4cc74226f7d2e5170140
Keeping appointment 67fe4cc74226f7d2e5170140 from 2025-04-15T16:16:14.113Z
    appointmentId: '67fe4cc74226f7d2e5170140',
Date validation complete for appointment 67fe4cc74226f7d2e5170140
Validating dates for appointment 67fe4cc74226f7d2e5170140, StartDateIso: 2025-04-25T12:00:00.0000000Z, EndDateIso: 2025-04-25T13:20:00.0000000Z
Processing appointment update: 67fe4cc74226f7d2e5170140
Found existing appointment 67fe4cc74226f7d2e5170140 in database
    "Id": "67fe4cc74226f7d2e5170140",
Processing AppointmentConfirmed event for appointment 67fe4cc74226f7d2e5170140
  appointmentId: '67fe4cc74226f7d2e5170140',
    appointmentId: '67fe4cc74226f7d2e5170140',
Date validation complete for appointment 67fe4cc74226f7d2e5170140
Validating dates for appointment 67fe4cc74226f7d2e5170140, StartDateIso: 2025-04-25T12:00:00.0000000Z, EndDateIso: 2025-04-25T13:20:00.0000000Z
Processing new appointment: 67fe4cc74226f7d2e5170140, client: Kasey Tillery
    "Id": "67fe4cc74226f7d2e5170140",
Processing AppointmentCreated event for appointment 67fe4cc74226f7d2e5170140


## Analysis of Missing Appointments

### Appointment ID: 67dda51e9f0abc9065dd9b6d

    appointmentId: '67dda51e9f0abc9065dd9b6d',
Appointment 67dda51e9f0abc9065dd9b6d not found on attempt 3
Appointment 67dda51e9f0abc9065dd9b6d not found for cancellation after 3 attempts
Appointment 67dda51e9f0abc9065dd9b6d not found on attempt 2
Appointment 67dda51e9f0abc9065dd9b6d not found on attempt 1
Processing appointment cancellation: 67dda51e9f0abc9065dd9b6d
    "Id": "67dda51e9f0abc9065dd9b6d",
Processing AppointmentCanceled event for appointment 67dda51e9f0abc9065dd9b6d
  appointmentId: '67dda51e9f0abc9065dd9b6d',


## IntakeQ API Issues

No API issues found

## Database/Sheet Issues

No database issues found

## Errors with Context

}
  processingTime: '1077ms'
  retryable: false,
  error: 'Unsupported webhook type: Note Locked',
  success: false,
Webhook event processed: {
Successfully read sheet range: Webhook_Log!A:A - Retrieved 518 rows
--
}
  processingTime: '2057ms'
  retryable: false,
  error: 'Unsupported webhook type: Note Locked',
  success: false,
Webhook event processed: {
Successfully read sheet range: Webhook_Log!A:A - Retrieved 517 rows
--
}
  processingTime: '3480ms'
  retryable: false,
  error: 'Unsupported webhook type: Note Locked',
  success: false,
Webhook event processed: {
Successfully read sheet range: Webhook_Log!A:A - Retrieved 516 rows
--
==> Docs on specifying a port: https://render.com/docs/web-services#port-binding
==> Detected service running on port 10000
[INFO] 2025-04-15T14:46:03.552Z: Server closed
[INFO] 2025-04-15T14:46:03.550Z: Stopped error recovery service
Stopped task: OFFICE_ASSIGNMENT
Stopped task: WEEKLY_CLEANUP
Stopped task: DUPLICATE_CLEANUP
--
[INFO] 2025-04-15T14:44:55.415Z: Webhook endpoint available at http://localhost:10000/api/webhooks/intakeq
[INFO] 2025-04-15T14:44:55.415Z: Server running on port 10000 in production mode
[INFO] 2025-04-15T14:44:55.413Z: Service initialization complete
[INFO] 2025-04-15T14:44:55.413Z: ErrorRecoveryService initialized and started
[INFO] 2025-04-15T14:44:55.413Z: Starting error recovery service
[INFO] 2025-04-15T14:44:55.413Z: Got singleton SchedulerService instance
[INFO] 2025-04-15T14:44:55.413Z: DailyScheduleService initialized
[INFO] 2025-04-15T14:44:55.413Z: EmailService initialized
--
}
  initializeScheduler: false
  enableRowMonitoring: false,
  enableErrorRecovery: true,
Context: {
[INFO] 2025-04-15T14:44:55.412Z: Initializing application services
}
