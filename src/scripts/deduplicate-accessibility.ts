// src/scripts/deduplicate-accessibility.ts
import { GoogleSheetsService } from '../lib/google/sheets';

interface ClientAccessibilityInfo {
  clientId: string;
  clientName: string;
  lastUpdated: string;
  hasMobilityNeeds: boolean;
  mobilityDetails: string;
  hasSensoryNeeds: boolean;
  sensoryDetails: string;
  hasPhysicalNeeds: boolean;
  physicalDetails: string;
  roomConsistency: number;
  hasSupport: boolean;
  supportDetails: string;
  additionalNotes: string;
  formType: string;
  formId: string;
}

async function deduplicateAccessibilityInfo() {
  try {
    console.log('Starting Client_Accessibility_Info deduplication process');
    const sheetsService = new GoogleSheetsService();
    
    // 1. Fetch all client accessibility records
    const allRecords = await sheetsService.getClientAccessibilityRecords();
    console.log(`Retrieved ${allRecords.length} total accessibility records`);
    
    // 2. Group records by clientId
    const groupedByClient = new Map<string, ClientAccessibilityInfo[]>();
    
    allRecords.forEach(record => {
      if (!record.clientId) return; // Skip records without clientId
      
      if (!groupedByClient.has(record.clientId)) {
        groupedByClient.set(record.clientId, []);
      }
      groupedByClient.get(record.clientId)?.push(record);
    });
    
    console.log(`Found ${groupedByClient.size} unique clients with accessibility data`);
    
    // 3. Process each client's records
    let totalProcessed = 0;
    let totalDuplicates = 0;
    
    for (const [clientId, records] of groupedByClient.entries()) {
      if (records.length <= 1) {
        // No duplicates for this client
        continue;
      }
      
      totalDuplicates += records.length - 1;
      
      // Sort by lastUpdated (newest first)
      records.sort((a, b) => {
        const dateA = new Date(a.lastUpdated || '2000-01-01');
        const dateB = new Date(b.lastUpdated || '2000-01-01');
        return dateB.getTime() - dateA.getTime();
      });
      
      // Keep the most recent record
      const latestRecord = records[0];
      const oldRecords = records.slice(1);
      
      // Merge unique information from older records
      oldRecords.forEach(oldRecord => {
        // Merge mobilityDetails if missing in latest record
        if (!latestRecord.mobilityDetails && oldRecord.mobilityDetails) {
          latestRecord.mobilityDetails = oldRecord.mobilityDetails;
        }
        
        // Merge sensoryDetails if missing in latest record
        if (!latestRecord.sensoryDetails && oldRecord.sensoryDetails) {
          latestRecord.sensoryDetails = oldRecord.sensoryDetails;
        }
        
        // Merge physicalDetails if missing in latest record
        if (!latestRecord.physicalDetails && oldRecord.physicalDetails) {
          latestRecord.physicalDetails = oldRecord.physicalDetails;
        }
        
        // Merge supportDetails if missing in latest record
        if (!latestRecord.supportDetails && oldRecord.supportDetails) {
          latestRecord.supportDetails = oldRecord.supportDetails;
        }
        
        // Merge additionalNotes if missing in latest record
        if (!latestRecord.additionalNotes && oldRecord.additionalNotes) {
          latestRecord.additionalNotes = oldRecord.additionalNotes;
        }
      });
      
      // Update the latest record in the sheet
      await sheetsService.updateClientAccessibilityInfo(latestRecord);
      
      // Note: We're not actually removing old records here
      // That would require adding a deleteClientAccessibilityInfo method to sheetsService
      
      totalProcessed++;
    }
    
    console.log(`Deduplication complete: ${totalProcessed} clients processed, ${totalDuplicates} duplicates found`);
    
    return {
      processed: totalProcessed,
      duplicates: totalDuplicates
    };
  } catch (error) {
    console.error('Error in deduplication process:', error);
    throw error;
  }
}

// Run the script when executed directly
if (require.main === module) {
  deduplicateAccessibilityInfo().catch(err => {
    console.error('Deduplication error:', err);
    process.exit(1);
  });
}

export default deduplicateAccessibilityInfo;