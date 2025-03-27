// src/scripts/run-code-consolidation.ts
/**
 * Master migration script for Phase 3 code consolidation
 * 
 * This script creates all the necessary files for the code consolidation
 * and ensures proper dependencies are maintained.
 * 
 * Run with: npx ts-node src/scripts/run-code-consolidation.ts
 */

import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

// Flag to control whether to perform file operations
const DRY_RUN = process.env.DRY_RUN === 'true';

// Steps in the migration process
type MigrationStep = {
  name: string;
  description: string;
  check: () => Promise<boolean>;
  execute: () => Promise<void>;
};

/**
 * Main migration function
 */
async function runCodeConsolidation(): Promise<void> {
  console.log('Starting Code Consolidation Migration');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE (changes will be applied)'}`);
  
  // Define the migration steps
  const steps: MigrationStep[] = [
    {
      name: 'Check Dependencies',
      description: 'Verify all required dependencies are installed',
      check: checkDependencies,
      execute: installDependencies
    },
    {
      name: 'Create Consolidated Bulk Import Service',
      description: 'Consolidate bulk import functionality into a single service',
      check: async () => await fileExists('src/lib/scheduling/bulk-import-service.ts'),
      execute: createBulkImportService
    },
    {
      name: 'Create Consolidated Testing Router',
      description: 'Consolidate testing routes into a single router',
      check: async () => await fileExists('src/routes/testing/index.ts'),
      execute: createTestingRouter
    },
    {
      name: 'Create Service Initializer',
      description: 'Standardize service initialization',
      check: async () => await fileExists('src/lib/util/service-initializer.ts'),
      execute: createServiceInitializer
    },
    {
      name: 'Create Date Utilities',
      description: 'Standardize date handling',
      check: async () => await fileExists('src/lib/util/date-utils.ts'),
      execute: createDateUtils
    },
    {
      name: 'Audit Standalone Scripts',
      description: 'Identify and mark standalone scripts',
      check: async () => await fileExists('src/scripts/audit-standalone-scripts.ts'),
      execute: createScriptAuditor
    },
    {
      name: 'Update Main Server',
      description: 'Update server.ts to use new consolidated services',
      check: async () => await hasContentChanged('src/server.ts'),
      execute: updateServerFile
    },
    {
      name: 'Update Routes Index',
      description: 'Update routes/index.ts to use new consolidated testing router',
      check: async () => await hasContentChanged('src/routes/index.ts'),
      execute: updateRoutesIndex
    }
  ];
  
  // Execute each step
  let success = true;
  let stepsCompleted = 0;
  
  for (const step of steps) {
    console.log(`\n[${step.name}] ${step.description}`);
    
    try {
      // Check if step is already completed
      const alreadyComplete = await step.check();
      
      if (alreadyComplete) {
        console.log(`✓ Step already completed`);
        stepsCompleted++;
        continue;
      }
      
      // Execute the step
      if (!DRY_RUN) {
        await step.execute();
        console.log(`✓ Step completed successfully`);
        stepsCompleted++;
      } else {
        console.log(`⟳ Would execute step (dry run)`);
      }
    } catch (error) {
      console.error(`✗ Step failed:`, error);
      success = false;
      break;
    }
  }
  
  // Summary
  console.log(`\n==============================`);
  console.log(`Migration ${success ? 'COMPLETED' : 'FAILED'}`);
  console.log(`Steps completed: ${stepsCompleted}/${steps.length}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Time: ${new Date().toISOString()}`);
  
  if (!success) {
    process.exit(1);
  }
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Check if file content has changed from a backup (or if no backup exists)
 */
async function hasContentChanged(filePath: string): Promise<boolean> {
  const backupPath = `${filePath}.bak`;
  
  // If no backup exists, we assume content has not been changed yet
  if (!await fileExists(backupPath)) {
    return false;
  }
  
  try {
    const originalContent = await fs.promises.readFile(backupPath, 'utf8');
    const currentContent = await fs.promises.readFile(filePath, 'utf8');
    
    return originalContent !== currentContent;
  } catch (error) {
    console.error(`Error comparing files:`, error);
    return false;
  }
}

/**
 * Creates a backup of a file before modifying it
 */
async function backupFile(filePath: string): Promise<void> {
  const backupPath = `${filePath}.bak`;
  
  // Only create backup if it doesn't already exist
  if (!await fileExists(backupPath)) {
    await fs.promises.copyFile(filePath, backupPath);
    console.log(`Created backup: ${backupPath}`);
  }
}

/**
 * Check if required dependencies are installed
 */
async function checkDependencies(): Promise<boolean> {
  try {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
    
    const requiredDependencies = [
      'express',
      'axios',
      'dotenv',
      'google-auth-library',
      'googleapis'
    ];
    
    const missingDependencies = requiredDependencies.filter(
      dep => !(dep in packageJson.dependencies || dep in packageJson.devDependencies)
    );
    
    return missingDependencies.length === 0;
  } catch (error) {
    console.error('Error checking dependencies:', error);
    return false;
  }
}

/**
 * Install missing dependencies
 */
async function installDependencies(): Promise<void> {
  try {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
    
    const requiredDependencies = [
      'express',
      'axios',
      'dotenv',
      'google-auth-library',
      'googleapis'
    ];
    
    const missingDependencies = requiredDependencies.filter(
      dep => !(dep in packageJson.dependencies || dep in packageJson.devDependencies)
    );
    
    if (missingDependencies.length > 0) {
      console.log(`Installing missing dependencies: ${missingDependencies.join(', ')}`);
      await execAsync(`npm install ${missingDependencies.join(' ')}`);
    }
  } catch (error) {
    console.error('Error installing dependencies:', error);
    throw error;
  }
}

/**
 * Create consolidated bulk import service
 */
async function createBulkImportService(): Promise<void> {
  const filePath = 'src/lib/scheduling/bulk-import-service.ts';
  const dirPath = path.dirname(filePath);
  
  // Create directory if it doesn't exist
  if (!await fileExists(dirPath)) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }
  
  // Read the content from the template
  const templatePath = path.resolve(__dirname, '../templates/bulk-import-service.ts.template');
  let content;
  
  if (await fileExists(templatePath)) {
    content = await fs.promises.readFile(templatePath, 'utf8');
  } else {
    // If template doesn't exist, use minimal content
    content = `// src/lib/scheduling/bulk-import-service.ts
// Consolidated bulk import service
// This file was generated by the code consolidation migration script

import { GoogleSheetsService, AuditEventType } from '../google/sheets';
import { IntakeQService } from '../intakeq/service';
import { AppointmentSyncHandler } from '../intakeq/appointment-sync';
import { WebhookEventType } from '../../types/webhooks';
import { getTodayEST, getESTDayRange, generateDateRange } from '../util/date-helpers';
import { logger } from '../util/logger';

/**
 * Interface for bulk import results
 */
export interface BulkImportResult {
  success: boolean;
  processed: number;
  errors: number;
  dates: string[];
  cleanupResults?: {
    outsideWindow: number;
    archived: number;
    deleted: number;
    errors: number;
  };
}

/**
 * Configuration options for bulk import operations
 */
export interface BulkImportConfig {
  startDate?: string;
  endDate?: string;
  keepPastDays?: number;
  keepFutureDays?: number;
  cleanupAfterImport?: boolean;
  processAllDates?: boolean;
  statusFilter?: string;
  source?: string;
}

/**
 * Consolidated service for all bulk import functionality
 */
export class BulkImportService {
  private sheetsService: GoogleSheetsService;
  private intakeQService: IntakeQService;
  private appointmentSyncHandler: AppointmentSyncHandler;

  constructor(
    sheetsService?: GoogleSheetsService,
    intakeQService?: IntakeQService,
    appointmentSyncHandler?: AppointmentSyncHandler
  ) {
    this.sheetsService = sheetsService || new GoogleSheetsService();
    this.intakeQService = intakeQService || new IntakeQService(this.sheetsService);
    this.appointmentSyncHandler = appointmentSyncHandler || new AppointmentSyncHandler(this.sheetsService, this.intakeQService);
  }

  // Implementation details to be added during consolidation
}`;
  }
  
  // Write to file
  await fs.promises.writeFile(filePath, content);
  console.log(`Created: ${filePath}`);
}

/**
 * Create consolidated testing router
 */
async function createTestingRouter(): Promise<void> {
  const filePath = 'src/routes/testing/index.ts';
  const dirPath = path.dirname(filePath);
  
  // Create directory if it doesn't exist
  if (!await fileExists(dirPath)) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }
  
  // Read the content from the template
  const templatePath = path.resolve(__dirname, '../templates/testing-router.ts.template');
  let content;
  
  if (await fileExists(templatePath)) {
    content = await fs.promises.readFile(templatePath, 'utf8');
  } else {
    // If template doesn't exist, use minimal content
    content = `// src/routes/testing/index.ts
// Consolidated testing router
// This file was generated by the code consolidation migration script

import express, { Request, Response } from 'express';
import { GoogleSheetsService } from '../../lib/google/sheets';
import { IntakeQService } from '../../lib/intakeq/service';
import { AppointmentSyncHandler } from '../../lib/intakeq/appointment-sync';
import { WebhookHandler } from '../../lib/intakeq/webhook-handler';
import { BulkImportService } from '../../lib/scheduling/bulk-import-service';
import { logger } from '../../lib/util/logger';

const router = express.Router();

// Initialize services
const sheetsService = new GoogleSheetsService();
const intakeQService = new IntakeQService(sheetsService);
const appointmentSyncHandler = new AppointmentSyncHandler(sheetsService, intakeQService);
const webhookHandler = new WebhookHandler(sheetsService, appointmentSyncHandler, intakeQService);
const bulkImportService = new BulkImportService(sheetsService, intakeQService, appointmentSyncHandler);

// Endpoints to be added during consolidation

export default router;`;
  }
  
  // Write to file
  await fs.promises.writeFile(filePath, content);
  console.log(`Created: ${filePath}`);
}

/**
 * Create service initializer
 */
async function createServiceInitializer(): Promise<void> {
  const filePath = 'src/lib/util/service-initializer.ts';
  const dirPath = path.dirname(filePath);
  
  // Create directory if it doesn't exist
  if (!await fileExists(dirPath)) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }
  
  // Read the content from the template
  const templatePath = path.resolve(__dirname, '../templates/service-initializer.ts.template');
  let content;
  
  if (await fileExists(templatePath)) {
    content = await fs.promises.readFile(templatePath, 'utf8');
  } else {
    // If template doesn't exist, use minimal content
    content = `// src/lib/util/service-initializer.ts
// Standardized service initializer
// This file was generated by the code consolidation migration script

import { GoogleSheetsService } from '../google/sheets';
import { IntakeQService } from '../intakeq/service';
import { AppointmentSyncHandler } from '../intakeq/appointment-sync';
import { WebhookHandler } from '../intakeq/webhook-handler';
import { BulkImportService } from '../scheduling/bulk-import-service';
import { ErrorRecoveryService } from './error-recovery';
import { RowMonitorService } from './row-monitor';
import { logger } from './logger';

/**
 * Application services container
 */
export interface ServiceContainer {
  sheetsService: GoogleSheetsService;
  intakeQService: IntakeQService;
  appointmentSyncHandler: AppointmentSyncHandler;
  webhookHandler: WebhookHandler;
  bulkImportService: BulkImportService;
  errorRecovery?: ErrorRecoveryService;
  rowMonitor?: RowMonitorService;
}

/**
 * Initialize all core services
 */
export async function initializeServices(
  options: {
    enableErrorRecovery?: boolean;
    enableRowMonitoring?: boolean;
  } = {}
): Promise<ServiceContainer> {
  logger.info('Initializing application services', options);

  // Implementation details to be added during consolidation
  
  const sheetsService = new GoogleSheetsService();
  const intakeQService = new IntakeQService(sheetsService);
  const appointmentSyncHandler = new AppointmentSyncHandler(sheetsService, intakeQService);
  const webhookHandler = new WebhookHandler(sheetsService, appointmentSyncHandler, intakeQService);
  const bulkImportService = new BulkImportService(sheetsService, intakeQService, appointmentSyncHandler);
  
  return {
    sheetsService,
    intakeQService,
    appointmentSyncHandler,
    webhookHandler,
    bulkImportService
  };
}`;
  }
  
  // Write to file
  await fs.promises.writeFile(filePath, content);
  console.log(`Created: ${filePath}`);
}

/**
 * Create date utilities
 */
async function createDateUtils(): Promise<void> {
  const filePath = 'src/lib/util/date-utils.ts';
  const dirPath = path.dirname(filePath);
  
  // Create directory if it doesn't exist
  if (!await fileExists(dirPath)) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }
  
  // Read the content from the template
  const templatePath = path.resolve(__dirname, '../templates/date-utils.ts.template');
  let content;
  
  if (await fileExists(templatePath)) {
    content = await fs.promises.readFile(templatePath, 'utf8');
  } else {
    // If template doesn't exist, use minimal content
    content = `// src/lib/util/date-utils.ts
// Standardized date utilities
// This file was generated by the code consolidation migration script

import { logger } from './logger';

/**
 * Comprehensive date utilities for the application
 * Consolidates all date-related functionality
 */

/**
 * Date range object with ISO string dates
 */
export interface DateRange {
  start: string;
  end: string;
}

/**
 * Timezone options for date operations
 */
export type TimezoneOption = 'EST' | 'UTC' | 'local';

// Implementation details to be added during consolidation`;
  }
  
  // Write to file
  await fs.promises.writeFile(filePath, content);
  console.log(`Created: ${filePath}`);
}

/**
 * Create script auditor
 */
async function createScriptAuditor(): Promise<void> {
  const filePath = 'src/scripts/audit-standalone-scripts.ts';
  const dirPath = path.dirname(filePath);
  
  // Create directory if it doesn't exist
  if (!await fileExists(dirPath)) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }
  
  // Read the content from the template
  const templatePath = path.resolve(__dirname, '../templates/audit-standalone-scripts.ts.template');
  let content;
  
  if (await fileExists(templatePath)) {
    content = await fs.promises.readFile(templatePath, 'utf8');
  } else {
    // If template doesn't exist, use minimal content
    content = `// src/scripts/audit-standalone-scripts.ts
// Script to audit standalone scripts
// This file was generated by the code consolidation migration script

import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

// Configuration
const SCRIPTS_DIR = path.resolve(__dirname);
const SRC_DIR = path.resolve(__dirname, '..');
const REPORT_FILE = path.resolve(__dirname, '../.script-audit-report.json');

// Implementation details to be added during consolidation

/**
 * Main audit function
 */
async function auditStandaloneScripts(): Promise<void> {
  console.log('Auditing standalone scripts...');
  
  // Implementation to be added during consolidation
}

// Run the audit
auditStandaloneScripts().catch(error => {
  console.error('Error running script audit:', error);
  process.exit(1);
});

// Export the function for testing
export { auditStandaloneScripts };`;
  }
  
  // Write to file
  await fs.promises.writeFile(filePath, content);
  console.log(`Created: ${filePath}`);
}

/**
 * Update server.ts to use new consolidated services
 */
async function updateServerFile(): Promise<void> {
  const filePath = 'src/server.ts';
  
  // Backup original file
  await backupFile(filePath);
  
  // Read current content
  const currentContent = await fs.promises.readFile(filePath, 'utf8');
  
  // Create updated content
  const updatedContent = currentContent
    // Update imports
    .replace(
      /import\s+{.*?}\s+from\s+['"]\.\/lib\/util\/row-monitor['"];?/,
      `import { initializeServices, ServiceContainer } from './lib/util/service-initializer';`
    )
    // Update service initialization
    .replace(
      /\/\/ Initialize services.*?sheetsService = new GoogleSheetsService\(\);/s,
      `// Initialize services
const initializePromise = initializeServices({
  enableErrorRecovery: true,
  enableRowMonitoring: false,
  initializeScheduler: true
});

// Global services placeholder, will be populated when initializePromise resolves
let services: ServiceContainer;`
    )
    // Update app.locals assignments
    .replace(
      /app\.locals\.scheduler = schedulerService;[\s\S]*?app\.locals\.rowMonitor = services\.rowMonitor;/,
      `// Set services in app.locals after they're initialized
initializePromise.then(initializedServices => {
  services = initializedServices;
  app.locals.sheetsService = services.sheetsService;
  app.locals.scheduler = services.schedulerService;
  app.locals.errorRecovery = services.errorRecovery;
  app.locals.rowMonitor = services.rowMonitor;
  app.locals.appointmentSyncHandler = services.appointmentSyncHandler;
  app.locals.webhookHandler = services.webhookHandler;
  app.locals.bulkImportService = services.bulkImportService;
  app.locals.dailyScheduleService = services.dailyScheduleService;
  app.locals.emailService = services.emailService;
  
  logger.info('All services initialized and assigned to app.locals');
}).catch(error => {
  logger.error('Failed to initialize services', error);
  process.exit(1);
});`
    );
  
  // Write updated content
  await fs.promises.writeFile(filePath, updatedContent);
  console.log(`Updated: ${filePath}`);
}

/**
 * Update routes/index.ts to use new consolidated testing router
 */
async function updateRoutesIndex(): Promise<void> {
  const filePath = 'src/routes/index.ts';
  
  // Backup original file
  await backupFile(filePath);
  
  // Read current content
  const currentContent = await fs.promises.readFile(filePath, 'utf8');
  
  // Create updated content
  let updatedContent = currentContent;
  
  // Add import for testing router if not already present
  if (!updatedContent.includes('import testingRouter')) {
    updatedContent = updatedContent.replace(
      /import\s+express\s+from\s+['"]express['"];/,
      `import express from 'express';\nimport testingRouter from './testing';`
    );
  }
  
  // Add route mounting if not already present
  if (!updatedContent.includes("'/testing'")) {
    updatedContent = updatedContent.replace(
      /router\.use\(['"]\/maintenance['"],\s*maintenanceRoutes\);/,
      `router.use('/maintenance', maintenanceRoutes);\nrouter.use('/testing', testingRouter);`
    );
  }
  
  // Write updated content
  await fs.promises.writeFile(filePath, updatedContent);
  console.log(`Updated: ${filePath}`);
}

// Run the migration
runCodeConsolidation().catch(error => {
  console.error('Error running code consolidation:', error);
  process.exit(1);
});