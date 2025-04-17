# Catalyst Scheduler - Version 2

This is the next generation of the Catalyst Scheduler for Bridge Family Therapy that uses Firebase Firestore as its primary database.

## Project Information
- Organization: bridgefamilytherapy.com
- Project Name: Catalyst-Scheduler-V2
- Project ID: catalyst-scheduler-v2
- Project Number: 210918475405

## Architecture

- **Database**: Firebase Firestore
- **API Integration**: IntakeQ
- **Hosting**: Firebase Hosting & Cloud Functions
- **Runtime**: Node.js

## Key Improvements

- True database transactions for data integrity
- Higher throughput for webhook processing
- Better concurrency handling
- Simplified deployment with Firebase
- Admin interface for configuration
- Improved error handling and recovery

## Migration

This version maintains the core functionality of Version 1 while improving reliability and performance. Data migration utilities are available to transition from Google Sheets to Firestore.

## Getting Started

1. Install Firebase tools: `npm install -g firebase-tools`
2. Initialize Firebase: `firebase init`
3. Set up environment: `cp .env.example .env`
4. Install dependencies: `npm install`
5. Start local development: `npm run dev`