import fs from 'fs';
import path from 'path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const outputDir = path.join(process.cwd(), 'output');
const sampleDir = path.join(process.cwd(), 'samplePatterns');
const diagnosticsDir = path.join(process.cwd(), 'diagnostics');
const files = fs.readdirSync(outputDir)
  .filter(f => f.toLowerCase().endsWith('-stamped.pdf'));

async function extractText(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const pdf = await getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(item => item.str.trim()).filter(Boolean);
    pages.push(strings);
  }
  return { pages, pageCount: pdf.numPages };
}

(async () => {
  for (const file of files) {
    const outputPath = path.join(outputDir, file);
    const baseName = file.replace(/-stamped\.pdf$/i, '.pdf');
    const originalPath = path.join(sampleDir, baseName);
    const diagPath = path.join(diagnosticsDir, baseName.replace(/\.pdf$/i, '-diagnostics.json'));

    console.log('===', file);
    if (!fs.existsSync(originalPath)) {
      console.log('  no matching original in samplePatterns, skipping');
      console.log('---');
      continue;
    }

    const out = await extractText(outputPath);
    const orig = await extractText(originalPath);
    console.log(' pages:', out.pageCount, '(original:', orig.pageCount, ')');

    let expectedByPage = {};
    if (fs.existsSync(diagPath)) {
      const diag = JSON.parse(fs.readFileSync(diagPath, 'utf8'));
      for (const d of diag.diagnostics) {
        expectedByPage[d.page] = expectedByPage[d.page] || new Set();
        expectedByPage[d.page].add(String(d.rescaledNumber));
      }
    }

    let totalNew = 0;
    for (let p = 0; p < out.pageCount; p++) {
      const stampedTokens = out.pages[p] ?? [];
      const origTokens = orig.pages[p] ?? [];
      const newTokens = stampedTokens.filter(s => /\d/.test(s) && !origTokens.includes(s));
      if (newTokens.length === 0) continue;
      totalNew += newTokens.length;
      const pageNum = p + 1;
      const expected = expectedByPage[pageNum];
      console.log(`  page ${pageNum}: ${newTokens.length} new numeric token(s):`, newTokens.slice(0, 15));
      if (expected) {
        const found = [...expected].filter(e => newTokens.some(t => t.includes(e)));
        const missing = [...expected].filter(e => !found.includes(e));
        console.log(`    expected rescaled values: ${[...expected].join(', ')}`);
        if (missing.length > 0) console.log(`    MISSING (not found in new tokens): ${missing.join(', ')}`);
      }
    }
    if (totalNew === 0) {
      console.log('  WARNING: no new numeric tokens found on any page (stamping may have failed)');
    }
    console.log('---');
  }
})();
