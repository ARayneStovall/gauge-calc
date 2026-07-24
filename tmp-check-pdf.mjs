import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'node:module';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);
const pdfjsDistPath = require.resolve('pdfjs-dist');
const pdfjsRoot = path.resolve(path.dirname(pdfjsDistPath), '../../');
const fontDataPath = path.join(pdfjsRoot, 'standard_fonts') + '/';
const cmapPath = path.join(pdfjsRoot, 'cmaps') + '/';
const data = new Uint8Array(fs.readFileSync('samplePatterns/miuTopPattern.pdf'));
const pdf = await getDocument({ data, standardFontDataUrl: fontDataPath, cMapUrl: cmapPath }).promise;
const out = [];
for (let p = 1; p <= pdf.numPages; p++) {
  const page = await pdf.getPage(p);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  out.push(`PAGE ${p} height ${viewport.height} width ${viewport.width} items ${textContent.items.length}`);
  const items = textContent.items.filter(item => 'str' in item);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const s = item.str;
    if (/\b(?:156|218|109)\b|Ribbing|Bust shaping|Front panel/i.test(s)) {
      out.push(`MATCH ${p} ${i} ${JSON.stringify(s)} transform=${JSON.stringify(item.transform)} width=${item.width} height=${item.height ?? 'n/a'}`);
      const start = Math.max(0, i - 3);
      const end = Math.min(items.length, i + 4);
      out.push('SURROUNDING:');
      for (let j = start; j < end; j++) {
        const neighbor = items[j];
        out.push(`${j === i ? '=>' : '  '} ${j} ${JSON.stringify(neighbor.str)} transform=${JSON.stringify(neighbor.transform)} width=${neighbor.width} height=${neighbor.height ?? 'n/a'}`);
      }
      out.push('----');
    }
  }
}
fs.writeFileSync('tmp-pdf-out.txt', out.join('\n'));
