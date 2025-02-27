// src/middleware/verify-signature.ts
import { Request, Response, NextFunction } from 'express';

// Extend the Request interface to include rawBody
export interface IntakeQWebhookRequest extends Request {
  rawBody?: string;
}

/**
 * Simple middleware that just passes the request through
 * This removes the encoding conflict that was causing issues
 */
export function handleIntakeQWebhook(req: Request, res: Response, next: NextFunction) {
  console.log('Webhook received:', {
    headers: req.headers,
    contentType: req.headers['content-type'],
    timestamp: new Date().toISOString()
  });
  
  // Just pass through without trying to set stream encoding
  next();
}

/**
 * Basic validation for IntakeQ webhooks
 * Without signature verification for now
 */
export function validateIntakeQWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const payload = req.body;
    
    // Log all incoming webhooks for debugging
    console.log('Webhook payload:', payload);
    
    // Minimal validation
    if (!payload) {
      console.warn('Empty webhook payload');
      return res.status(400).json({ 
        success: false, 
        error: 'Empty webhook payload',
        timestamp: new Date().toISOString() 
      });
    }
    
    // Check for required fields
    if ((!payload.Type && !payload.EventType) || !payload.ClientId) {
      console.warn('Invalid webhook format', payload);
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid webhook format. Required fields missing.',
        timestamp: new Date().toISOString() 
      });
    }
    
    // Payload is valid, proceed
    next();
  } catch (error) {
    console.error('Error processing webhook:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown webhook processing error',
      timestamp: new Date().toISOString()
    });
  }
}