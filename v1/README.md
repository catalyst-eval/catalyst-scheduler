# Catalyst Scheduler - Version 1

This is the original version of the Catalyst Scheduler that uses Google Sheets as its primary database.

## Architecture

- **Database**: Google Sheets
- **API Integration**: IntakeQ 
- **Hosting**: Render
- **Runtime**: Node.js

## Key Components

- Appointment synchronization with IntakeQ
- Office assignment algorithm
- Daily schedule generation
- Client accessibility scanning

## Limitations

This version has inherent limitations due to the use of Google Sheets:
- API quota limitations
- Concurrency issues with multiple webhooks
- No true transaction support
- Limited query capabilities

See Version 2 for the improved Firestore-based implementation.