import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs';

async function make() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([600, 800]);
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  page.drawText('Gauge: 20 sts = 4 in', { x: 50, y: 700, size: fontSize, font: helv, color: rgb(0,0,0) });
  page.drawText('Ribbing: 32 sts', { x: 50, y: 680, size: fontSize, font: helv, color: rgb(0,0,0) });
  const bytes = await pdfDoc.save();
  fs.writeFileSync('sample.pdf', bytes);
  console.log('Wrote sample.pdf');
}

make().catch((e) => { console.error(e); process.exit(1); });
