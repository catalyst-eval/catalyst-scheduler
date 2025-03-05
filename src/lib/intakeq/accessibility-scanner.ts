// src/lib/intakeq/accessibility-scanner.ts

import { GoogleSheetsService, AuditEventType } from '../google/sheets';
import { IntakeQService } from './service';
import { WebhookHandler } from './webhook-handler';

export class AccessibilityScanner {
  private intakeQService: IntakeQService;
  private webhookHandler: WebhookHandler;

  constructor(
    private readonly sheetsService: GoogleSheetsService
  ) {
    this.intakeQService = new IntakeQService(this.sheetsService);
    this.webhookHandler = new WebhookHandler(this.sheetsService, null, this.intakeQService);
  }

  /**
   * Scan all intake forms for accessibility data and update Client_Accessibility_Info
   */
  async scanIntakeFormsForAccessibility(startDate?: string, endDate?: string): Promise<number> {
    try {
      // Default to scanning the last 6 months if no dates provided
      const defaultStartDate = new Date();
      defaultStartDate.setMonth(defaultStartDate.getMonth() - 6);
      
      const start = startDate || defaultStartDate.toISOString().split('T')[0];
      const end = endDate || new Date().toISOString().split('T')[0];
      
      console.log(`Scanning intake forms from ${start} to ${end} for accessibility info`);
      
      // Get all intake forms in the date range
      const forms = await this.getIntakeForms(start, end);
      
      let processedCount = 0;
      
      // Log start of scan
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: `Starting accessibility form scan from ${start} to ${end}`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          formCount: forms.length
        })
      });
      
      // Process each form to extract accessibility info
      for (const form of forms) {
        try {
          // Only process completed forms
          if (form.Status !== 'Completed') continue;
          
          // Get full form data
          const fullForm = await this.intakeQService.getFullIntakeForm(form.Id);
          
          if (!fullForm) continue;
          
          // Extract accessibility info using existing logic from webhook handler
          const accessibilityInfo = this.webhookHandler.extractAccessibilityInfo(
            fullForm, 
            fullForm.ClientId?.toString() || '0'
          );
          
          // Update client accessibility info
          await this.sheetsService.updateClientAccessibilityInfo(accessibilityInfo);
          
          processedCount++;
          
          // Add small delay to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`Error processing form ${form.Id}:`, error);
        }
      }
      
      // Log completion
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.INTEGRATION_UPDATED,
        description: `Completed accessibility form scan`,
        user: 'SYSTEM',
        systemNotes: JSON.stringify({
          scanned: forms.length,
          processed: processedCount
        })
      });
      
      return processedCount;
    } catch (error) {
      console.error('Error scanning intake forms:', error);
      
      // Log error
      await this.sheetsService.addAuditLog({
        timestamp: new Date().toISOString(),
        eventType: AuditEventType.SYSTEM_ERROR,
        description: 'Error scanning intake forms for accessibility info',
        user: 'SYSTEM',
        systemNotes: error instanceof Error ? error.message : 'Unknown error'
      });
      
      throw error;
    }
  }

  /**
   * Get intake forms from IntakeQ
   */
  private async getIntakeForms(startDate: string, endDate: string): Promise<any[]> {
    try {
      const response = await this.intakeQService.fetchFromIntakeQ(
        `intakes/summary?startDate=${startDate}&endDate=${endDate}`
      );
      
      return response || [];
    } catch (error) {
      console.error('Error getting intake forms:', error);
      return [];
    }
  }
}