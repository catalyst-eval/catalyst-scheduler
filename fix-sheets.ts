// fix-sheets.ts
import * as fs from 'fs';
import * as path from 'path';

const sheetsPath = path.join(__dirname, 'src/lib/google/sheets.ts');
let content = fs.readFileSync(sheetsPath, 'utf8');

// The problematic section is around line 73-80
const oldCode = `// Replace literal \\n with actual newlines
        privateKey = privateKey.replace(/\\\\n/g, '\\n');`;

// Let's modify it to check if replacement is needed
const newCode = `// Replace literal \\n with actual newlines if needed
        if (privateKey.includes('\\\\n')) {
          privateKey = privateKey.replace(/\\\\n/g, '\\n');
          console.log('Replaced escaped newlines in private key');
        } else {
          console.log('Private key already has proper newlines, no replacement needed');
        }`;

// Replace the problematic section
content = content.replace(oldCode, newCode);

// Write the updated file
fs.writeFileSync(sheetsPath, content, 'utf8');

console.log('Successfully patched Google Sheets service to handle proper newlines!');