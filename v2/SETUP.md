# Firebase Setup Instructions

Follow these steps to set up the Firebase project locally:

## Prerequisites
- Node.js and npm installed
- Firebase CLI installed (`npm install -g firebase-tools`)

## Step 1: Login to Firebase

```bash
firebase login
```

This will open a browser window where you should log in with:
- Email: tyler@bridgefamilytherapy.com
- (Use your secure password)

## Step 2: Initialize Firebase

After logging in, navigate to the v2 directory and run:

```bash
cd v2
firebase use catalyst-scheduler-v2
firebase init
```

When prompted during initialization:
1. Select the following features:
   - Firestore
   - Functions
   - Hosting
   - Emulators

2. Use the existing configurations:
   - Use existing Firestore rules (firestore.rules)
   - Use existing Firestore indexes (firestore.indexes.json)
   - Use JavaScript for Functions
   - Use existing functions configuration
   - Use "public" as the hosting directory
   - Configure as a single-page app
   - Set up automatic builds and deploys with GitHub (if desired)
   - Use existing firebase.json

## Step 3: Install Dependencies

```bash
npm install firebase-admin firebase-functions express cors helmet dotenv
npm install -D typescript ts-node-dev @types/express @types/node
```

## Step 4: Set Up Environment Variables

Create a `.env` file in the v2 directory:

```bash
cp .env.example .env
```

Edit the `.env` file with your actual configuration values.

## Step 5: Start Local Development

```bash
npm run dev
```

For Firebase emulators:

```bash
npm run firebase:emulators
```

## Deployment

To deploy to Firebase:

```bash
npm run firebase:deploy
```

Or to deploy only functions:

```bash
npm run deploy:functions
```