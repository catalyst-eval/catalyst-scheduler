/**
 * Catalyst Scheduler - Version 2
 * 
 * Main entry point for the application.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import admin from 'firebase-admin';
import adminRouter from './api/admin';

// Initialize Firebase
if (!admin.apps.length) {
  admin.initializeApp();
}

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic routes
app.get('/', (req, res) => {
  res.send('Catalyst Scheduler API - Version 2');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', version: '2.0.0' });
});

// API routes
app.use('/api/admin', adminRouter);

// Start the server
app.listen(port, () => {
  console.log(`Catalyst Scheduler v2 running on port ${port}`);
});

export default app;