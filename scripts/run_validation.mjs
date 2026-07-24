import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractStampDiagnostics } from '../extractStampText.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sampleDir = path.join(__dirname, '..', 'samplePatterns');
const outDir = path.join(__dirname, '..', 'output');
const diagnosticsDir = path.join(__dirname, '..', 'diagnostics');

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { sts: 20, row: 28, stampDx: 0, preferredSize: '3' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sts' && argv[i + 1]) opts.sts = Number(argv[++i]);
    else if (a === '--row' && argv[i + 1]) opts.row = Number(argv[++i]);
    else if (a === '--stampDx' && argv[i + 1]) opts.stampDx = Number(argv[++i]);
    else if (a === '--preferredSize' && argv[i + 1]) opts.preferredSize = argv[++i];
  }
  return opts;
}

async function ensureDirs() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(diagnosticsDir, { recursive: true });
}

async function run() {
  const opts = parseArgs();
  await ensureDirs();
  const files = await fs.readdir(sampleDir);
  const pdfs = files.filter((f) => f.toLowerCase().endsWith('.pdf'));
  if (pdfs.length === 0) {
    console.error('No PDFs found in', sampleDir);
    process.exit(1);
  }

  for (const f of pdfs) {
    const inPath = path.join(sampleDir, f);
    const outPath = path.join(outDir, f.replace(/\.pdf$/i, '') + '-stamped.pdf');
    const diagPath = path.join(diagnosticsDir, f.replace(/\.pdf$/i, '') + '-diagnostics.json');
    try {
      console.log('Validating', f);
      const data = await fs.readFile(inPath);
      const diagnostics = await extractStampDiagnostics(data, opts.sts, opts.row, opts.stampDx, opts.preferredSize);
      await fs.writeFile(diagPath, JSON.stringify({ file: f, options: opts, diagnostics }, null, 2));
      console.log('Wrote diagnostics', diagPath);
      if (diagnostics.length === 0) {
        console.log('  No stamp diagnostics found for this file.');
      } else {
        console.log('  Diagnostics count:', diagnostics.length);
      }
    } catch (err) {
      console.error('Error validating', f, err && err.message ? err.message : err);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
