// src/scripts/audit-standalone-scripts.ts
/**
 * Script to audit standalone scripts and integrate them into the main application
 * This is a one-time utility for Phase 3 code consolidation
 * 
 * Run with: npx ts-node src/scripts/audit-standalone-scripts.ts
 */

import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

// Configuration
const SCRIPTS_DIR = path.resolve(__dirname);
const SRC_DIR = path.resolve(__dirname, '..');
const REPORT_FILE = path.resolve(__dirname, '../.script-audit-report.json');

// Scripts to ignore (already integrated or special purpose)
const IGNORE_SCRIPTS = [
  'audit-standalone-scripts.ts',  // This script itself
  'test-intakeq-webhook.ts',      // Integrated into consolidated test router
  'deduplicate-accessibility.ts', // Integrated into maintenance routes
  'manual-import-appointments.ts' // Integrated into bulk-import-service.ts
];

interface ScriptInfo {
  name: string;
  path: string;
  size: number;
  lastModified: Date;
  imports: string[];
  functionality: string;
  status: 'integrated' | 'deprecated' | 'standalone' | 'needs-review';
  notes?: string;
}

/**
 * Main audit function
 */
async function auditStandaloneScripts(): Promise<void> {
  console.log('Auditing standalone scripts...');
  
  // Find all TypeScript files in scripts directory
  const files = await findTsFiles(SCRIPTS_DIR);
  
  // Filter out ignored scripts
  const scriptsToAudit = files.filter(file => 
    !IGNORE_SCRIPTS.includes(path.basename(file)));
  
  console.log(`Found ${scriptsToAudit.length} scripts to audit`);
  
  const scriptInfos: ScriptInfo[] = [];
  
  // Analyze each script
  for (const scriptPath of scriptsToAudit) {
    const scriptInfo = await analyzeScript(scriptPath);
    scriptInfos.push(scriptInfo);
    
    console.log(`Analyzed: ${scriptInfo.name} (${scriptInfo.status})`);
  }
  
  // Generate report
  const report = {
    generatedAt: new Date().toISOString(),
    scriptsAnalyzed: scriptInfos.length,
    integrated: scriptInfos.filter(s => s.status === 'integrated').length,
    deprecated: scriptInfos.filter(s => s.status === 'deprecated').length,
    standalone: scriptInfos.filter(s => s.status === 'standalone').length,
    needsReview: scriptInfos.filter(s => s.status === 'needs-review').length,
    scripts: scriptInfos
  };
  
  // Write report to file
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`Report generated: ${REPORT_FILE}`);
  
  // Print summary
  console.log('\nSCRIPT AUDIT SUMMARY:');
  console.log('=====================');
  console.log(`Total scripts analyzed: ${report.scriptsAnalyzed}`);
  console.log(`Already integrated: ${report.integrated}`);
  console.log(`Deprecated: ${report.deprecated}`);
  console.log(`Still standalone: ${report.standalone}`);
  console.log(`Needs review: ${report.needsReview}`);
  console.log('\nScripts that need review:');
  
  const needReview = scriptInfos.filter(s => s.status === 'needs-review');
  if (needReview.length === 0) {
    console.log('None! All scripts have been assessed.');
  } else {
    for (const script of needReview) {
      console.log(`- ${script.name}: ${script.notes || 'No notes'}`);
    }
  }
}

/**
 * Find all TypeScript files in a directory and its subdirectories
 */
async function findTsFiles(dir: string): Promise<string[]> {
  const files = await fs.promises.readdir(dir);
  const tsFiles: string[] = [];
  
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = await fs.promises.stat(fullPath);
    
    if (stat.isDirectory()) {
      const subDirFiles = await findTsFiles(fullPath);
      tsFiles.push(...subDirFiles);
    } else if (file.endsWith('.ts')) {
      tsFiles.push(fullPath);
    }
  }
  
  return tsFiles;
}

/**
 * Analyze a script file
 */
async function analyzeScript(scriptPath: string): Promise<ScriptInfo> {
  const name = path.basename(scriptPath);
  const stats = await fs.promises.stat(scriptPath);
  const content = await fs.promises.readFile(scriptPath, 'utf8');
  
  // Extract imports
  const importRegex = /import\s+.*from\s+['"](.+)['"]/g;
  const imports: string[] = [];
  let match;
  
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  
  // Check if this script has already been integrated
  const scriptName = name.replace('.ts', '');
  const searchPattern = `/${scriptName}`;
  
  // Search the main src directory for references to this script
  const { stdout: grepResult } = await execAsync(
    `grep -r "${searchPattern}" ${SRC_DIR} --include="*.ts" --exclude-dir="scripts" || true`
  );
  
  // Determine script status
  let status: ScriptInfo['status'] = 'standalone';
  let notes = '';
  let functionality = 'Unknown functionality';
  
  // Try to extract description/functionality from comments
  const descriptionRegex = /\/\*\*\s*([\s\S]*?)\s*\*\//;
  const descriptionMatch = content.match(descriptionRegex);
  if (descriptionMatch) {
    functionality = descriptionMatch[1]
      .replace(/\s*\*\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  // Find first commented description in the file
  const lineCommentRegex = /\/\/\s*(.*)/;
  const lineMatch = content.match(lineCommentRegex);
  if (lineMatch && (!functionality || functionality === 'Unknown functionality')) {
    functionality = lineMatch[1].trim();
  }
  
  if (grepResult && grepResult.length > 0) {
    // This script is referenced elsewhere in the codebase
    const lines = grepResult.split('\n').filter(Boolean);
    
    // Check if it's referenced in a consolidated file
    const isInConsolidated = lines.some(line => 
      line.includes('consolidate') || 
      line.includes('bulk-import-service') ||
      line.includes('service-initializer'));
    
    if (isInConsolidated) {
      status = 'integrated';
      notes = 'Already integrated in consolidated files';
    } else {
      status = 'needs-review';
      notes = `Referenced in ${lines.length} file(s)`;
    }
  } else {
    // Not referenced elsewhere, check for deprecation comments
    if (content.includes('DEPRECATED') || content.includes('deprecated')) {
      status = 'deprecated';
      notes = 'Marked as deprecated in comments';
    } else {
      // Check if this is a test or utility script
      if (name.includes('test') || name.includes('demo')) {
        status = 'deprecated';
        notes = 'Test or demo script, likely not needed';
      } else {
        // Check if this contains important business logic
        if (content.includes('sheetsService.') || content.includes('intakeQService.')) {
          status = 'needs-review';
          notes = 'Contains business logic but not referenced';
        }
      }
    }
  }
  
  return {
    name,
    path: scriptPath,
    size: stats.size,
    lastModified: stats.mtime,
    imports,
    functionality,
    status,
    notes
  };
}

// Run the audit
auditStandaloneScripts().catch(error => {
  console.error('Error running script audit:', error);
  process.exit(1);
});

// Export the function for testing
export { auditStandaloneScripts };