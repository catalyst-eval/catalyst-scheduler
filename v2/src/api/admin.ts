/**
 * Admin API Endpoints
 * 
 * This file implements the admin REST API for the Catalyst Scheduler.
 */

import express from 'express';
import * as db from '../db/firestore';
import { runFullMigration } from '../lib/migration';
import { verifyAdmin } from '../auth/middleware';

const router = express.Router();

// Middleware to verify admin access
router.use(verifyAdmin);

// Migration endpoint
router.post('/migration', async (req, res) => {
  try {
    const { spreadsheetId } = req.body;
    
    if (!spreadsheetId) {
      return res.status(400).json({
        error: 'Missing spreadsheetId in request body'
      });
    }
    
    // Start migration
    const result = await runFullMigration(spreadsheetId);
    
    return res.status(200).json(result);
  } catch (error) {
    console.error('Migration error:', error);
    return res.status(500).json({
      error: 'Migration failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Configuration endpoints
router.get('/config', async (req, res) => {
  try {
    const configSnapshot = await db.configCollection.get();
    const config: Record<string, any> = {};
    
    configSnapshot.forEach(doc => {
      config[doc.id] = doc.data();
    });
    
    return res.status(200).json(config);
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to retrieve configuration',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.post('/config/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const value = req.body;
    
    await db.configCollection.doc(key).set(value);
    
    return res.status(200).json({
      success: true,
      key,
      value
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to update configuration',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Office management endpoints
router.get('/offices', async (req, res) => {
  try {
    const officesSnapshot = await db.officesCollection.get();
    const offices = officesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    return res.status(200).json(offices);
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to retrieve offices',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.post('/offices', async (req, res) => {
  try {
    const officeData = req.body;
    
    if (!officeData.id) {
      return res.status(400).json({
        error: 'Office ID is required'
      });
    }
    
    await db.officesCollection.doc(officeData.id).set(officeData);
    
    return res.status(201).json({
      success: true,
      office: officeData
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to create office',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Clinician management endpoints
router.get('/clinicians', async (req, res) => {
  try {
    const cliniciansSnapshot = await db.cliniciansCollection.get();
    const clinicians = cliniciansSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    return res.status(200).json(clinicians);
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to retrieve clinicians',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// System logs endpoints
router.get('/logs', async (req, res) => {
  try {
    const { limit = 100, type, startDate, endDate } = req.query;
    
    let query = db.logsCollection.orderBy('timestamp', 'desc');
    
    if (type) {
      query = query.where('eventType', '==', type);
    }
    
    if (startDate) {
      query = query.where('timestamp', '>=', startDate);
    }
    
    if (endDate) {
      query = query.where('timestamp', '<=', endDate);
    }
    
    query = query.limit(Number(limit));
    
    const logsSnapshot = await query.get();
    const logs = logsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    return res.status(200).json(logs);
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to retrieve logs',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;