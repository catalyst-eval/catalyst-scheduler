// src/middleware/verify-signature.ts
import crypto from 'crypto';
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
 * With optional signature verification based on environment
 */
export function validateIntakeQWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const payload = req.body;
    const signature = req.headers['x-intakeq-signature'];
    
    // Log incoming webhook metadata for debugging
    console.log('Webhook received:', {
      type: payload?.Type || payload?.EventType,
      clientId: payload?.ClientId,
      hasSignature: !!signature,
      timestamp: new Date().toISOString()
    });
    
    // Basic payload validation
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
    
    // Check signature if provided
    if (signature && typeof signature === 'string') {
      // Only verify if secret is configured
      if (process.env.INTAKEQ_WEBHOOK_SECRET) {
        const isValid = verifySignature(payload, signature);
        
        // In production, reject invalid signatures
        if (!isValid && process.env.NODE_ENV === 'production') {
          console.warn('Invalid webhook signature in production environment');
          return res.status(401).json({ 
            success: false, 
            error: 'Invalid signature',
            timestamp: new Date().toISOString() 
          });
        }
        
        // In development, just log the warning
        if (!isValid) {
          console.warn('Invalid webhook signature (proceeding anyway in development)');
        }
      } else {
        console.warn('INTAKEQ_WEBHOOK_SECRET not configured, skipping signature validation');
      }
    } else if (process.env.NODE_ENV === 'production') {
      // In production, warn about missing signature but still proceed
      console.warn('Missing webhook signature in production environment');
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

/**
 * Verify webhook signature using HMAC-SHA256
 */
function verifySignature(payload: any, signature: string): boolean {
  try {
    const secret = process.env.INTAKEQ_WEBHOOK_SECRET;
    if (!secret) return false;
    
    // Clean the secret (remove quotes, trim)
    const cleanSecret = secret
      .replace(/^["']/, '') // Remove leading quotes
      .replace(/["']$/, '') // Remove trailing quotes
      .trim();
    
    // Create HMAC
    const hmac = crypto.createHmac('sha256', cleanSecret);
    
    // Convert payload to string if needed
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    
    // Generate signature
    hmac.update(payloadStr);
    const calculatedSignature = hmac.digest('hex');
    
    // Log minimal info for debugging
    console.log('Signature verification:', {
      signatureMatches: calculatedSignature === signature,
      calculatedStart: calculatedSignature.substring(0, 8) + '...',
      providedStart: signature.substring(0, 8) + '...',
      renderUrl: 'https://catalyst-scheduler.onrender.com'
    });
    
    return calculatedSignature === signature;
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}