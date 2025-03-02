// src/lib/email/service.ts

import sgMail from '@sendgrid/mail';
import { EmailTemplate } from './templates';
import { GoogleSheetsService, AuditEventType } from '../google/sheets';

export interface EmailRecipient {
  email: string;
  name?: string;
}

export interface SendEmailOptions {
  retries?: number;
  priority?: 'high' | 'normal' | 'low';
  category?: string;
  attachments?: any[];
}

export class EmailService {
  private sheetsService: GoogleSheetsService;
  private fromEmail: string;
  private fromName: string;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAYS = [1000, 5000, 15000]; // 1s, 5s, 15s

  constructor(sheetsService?: GoogleSheetsService) {
    // Initialize SendGrid
    if (!process.env.SENDGRID_API_KEY) {
      throw new Error('Missing SENDGRID_API_KEY environment variable');
    }
    
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    
    // Set default from address
    this.fromEmail = process.env.EMAIL_FROM_ADDRESS || 'scheduler@catalysthealth.care';
    this.fromName = process.env.EMAIL_FROM_NAME || 'Catalyst Scheduler';
    
    // Initialize sheets service for logging
    this.sheetsService = sheetsService || new GoogleSheetsService();
  }

  /**
   * Send an email with retries
   */
  async sendEmail(
    recipients: EmailRecipient[],
    template: EmailTemplate,
    options: SendEmailOptions = {}
  ): Promise<boolean> {
    const { retries = this.MAX_RETRIES, priority = 'normal', category, attachments } = options;
    
    try {
      console.log(`Preparing to send email: "${template.subject}" to ${recipients.length} recipients`);
      
      // Log to audit system
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR, // Using existing type for logging
        description: `Sending email: ${template.subject}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          recipients: recipients.map(r => r.email),
          subject: template.subject,
          priority,
          category
        })
      });
      
      // Call with retry logic
      return this.sendWithRetry(recipients, template, { priority, category, attachments }, 0, retries);
    } catch (error) {
      console.error('Error preparing email:', error);
      
      // Log error to audit system
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: `Failed to send email: ${template.subject}`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      return false;
    }
  }

  /**
   * Send email with retry logic
   */
  private async sendWithRetry(
    recipients: EmailRecipient[],
    template: EmailTemplate,
    options: SendEmailOptions,
    attempt: number = 0,
    maxRetries: number = this.MAX_RETRIES
  ): Promise<boolean> {
    try {
      // Prepare SendGrid message
      const message = {
        to: recipients,
        from: {
          email: this.fromEmail,
          name: this.fromName
        },
        subject: template.subject,
        text: template.textBody,
        html: template.htmlBody,
        category: options.category,
        attachments: options.attachments,
        mailSettings: {
          sandboxMode: {
            enable: process.env.NODE_ENV === 'development'
          }
        }
      };
      
      // Send email via SendGrid
      const response = await sgMail.send(message);
      
      console.log(`Email sent successfully: "${template.subject}"`);
      return true;
    } catch (error) {
      console.error(`Email delivery failed (attempt ${attempt + 1}):`, error);
      
      // Retry if we haven't reached max retries
      if (attempt < maxRetries - 1) {
        const delay = this.RETRY_DELAYS[attempt];
        console.log(`Retrying email in ${delay}ms (attempt ${attempt + 1} of ${maxRetries})`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.sendWithRetry(recipients, template, options, attempt + 1, maxRetries);
      }
      
      // Log terminal failure to audit system
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: `Email delivery failed after ${maxRetries} attempts: ${template.subject}`,
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      return false;
    }
  }

  /**
 * Get recipients for daily schedule emails
 */
async getScheduleRecipients(): Promise<EmailRecipient[]> {
  try {
    // First check if there's a configuration in Google Sheets
    const settings = await this.sheetsService.getIntegrationSettings();
    const emailSetting = settings.find(s => 
      s.serviceName === 'email' && s.settingType === 'daily_schedule_recipients'
    );
    
    if (emailSetting?.value) {
      // Parse comma-separated list of emails from settings
      return emailSetting.value.split(',').map(email => ({
        email: email.trim()
      }));
    }
    
    // Fall back to environment variable
    const envRecipients = process.env.SCHEDULE_EMAIL_RECIPIENTS;
    if (envRecipients) {
      return envRecipients.split(',').map(email => ({
        email: email.trim()
      }));
    }
    
    // Default to Bridge Family Therapy email if no other configuration is found
    return [{ email: 'admin@bridgefamilytherapy.com' }];
  } catch (error) {
    console.error('Error getting schedule recipients:', error);
    // Fallback to Bridge email on error
    return [{ email: 'admin@bridgefamilytherapy.com' }];
  }
}

/**
 * Get recipients for error notifications - use the same logic for consistency
 */
async getErrorNotificationRecipients(): Promise<EmailRecipient[]> {
  try {
    // First check if there's a configuration in Google Sheets
    const settings = await this.sheetsService.getIntegrationSettings();
    const emailSetting = settings.find(s => 
      s.serviceName === 'email' && s.settingType === 'error_notification_recipients'
    );
    
    if (emailSetting?.value) {
      // Parse comma-separated list of emails from settings
      return emailSetting.value.split(',').map(email => ({
        email: email.trim()
      }));
    }
    
    // Fall back to the same recipients as the schedule
    return this.getScheduleRecipients();
  } catch (error) {
    console.error('Error getting error notification recipients:', error);
    // Fallback to Bridge email on error
    return [{ email: 'admin@bridgefamilytherapy.com' }];
  }
}
}