# Catalyst Scheduler

The Catalyst Scheduler is a system to manage therapy office assignments and appointment scheduling for Bridge Family Therapy.

## Repository Structure

This repository contains two versions of the Catalyst Scheduler:

- **v1/**: The original version using Google Sheets as a database
- **v2/**: The next-generation version using Firebase Firestore

## Version 1 (Google Sheets)

Version 1 is the currently deployed version that:
- Integrates with IntakeQ for appointment management
- Uses Google Sheets as its primary database
- Assigns offices based on therapist and client needs
- Manages the daily schedule generation

See [Version 1 README](./v1/README.md) for more details.

## Version 2 (Firebase)

Version 2 is the next-generation implementation that:
- Uses Firestore for improved reliability and performance
- Maintains the same core functionality as Version 1
- Adds an administration interface
- Provides better handling of concurrent operations
- Improves error recovery mechanisms

See [Version 2 README](./v2/README.md) for more details.

## Migration

Both versions can run in parallel during the migration phase. Version 2 includes tools to assist with migrating data from Google Sheets to Firestore.

## Development

Choose the appropriate version directory to work on:
- `cd v1` for Google Sheets version
- `cd v2` for Firestore version

Each directory contains its own package.json, dependencies, and scripts.