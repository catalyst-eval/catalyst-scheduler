// src/routes/test-intakeq.ts

import express, { Request, Response } from 'express';
import axios from 'axios';

const router = express.Router();

router.get('/fetch-intakes', async (req: Request, res: Response) => {
  try {
    const startDate = req.query.startDate || '2025-02-20';
    const endDate = req.query.endDate || '2025-02-28';
    
    console.log(`Fetching IntakeQ forms from ${startDate} to ${endDate}`);
    
    // Fetch intake forms summary
    const intakeResponse = await axios.get(
      `https://intakeq.com/api/v1/intakes/summary?startDate=${startDate}&endDate=${endDate}`,
      {
        headers: {
          'X-Auth-Key': process.env.INTAKEQ_API_KEY,
          'Accept': 'application/json'
        }
      }
    );
    
    // Extract form IDs
    const formIds = intakeResponse.data.map((intake: any) => intake.Id);
    console.log(`Found ${formIds.length} forms`);
    
    // If we have forms, get detailed data for the first one
    let sampleFormData = null;
    if (formIds.length > 0) {
      const formDetailResponse = await axios.get(
        `https://intakeq.com/api/v1/intakes/${formIds[0]}`,
        {
          headers: {
            'X-Auth-Key': process.env.INTAKEQ_API_KEY,
            'Accept': 'application/json'
          }
        }
      );
      sampleFormData = formDetailResponse.data;
    }
    
    // Return the data
    res.json({
      success: true,
      formCount: formIds.length,
      formSummaries: intakeResponse.data,
      sampleFormData: sampleFormData
    });
  } catch (error) {
    console.error('Error fetching IntakeQ forms:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/fetch-form', async (req: Request, res: Response) => {
    try {
      const formId = req.query.id as string;
      
      if (!formId) {
        return res.status(400).json({
          success: false,
          error: 'Form ID is required',
          timestamp: new Date().toISOString()
        });
      }
      
      console.log(`Fetching IntakeQ form details: ${formId}`);
      
      const formDetailResponse = await axios.get(
        `https://intakeq.com/api/v1/intakes/${formId}`,
        {
          headers: {
            'X-Auth-Key': process.env.INTAKEQ_API_KEY,
            'Accept': 'application/json'
          }
        }
      );
      
      res.json({
        success: true,
        formData: formDetailResponse.data
      });
    } catch (error) {
      console.error('Error fetching IntakeQ form details:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });
  
export default router;