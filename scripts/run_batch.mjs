import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { extractAndStamp } from "../extractStampText.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sampleDir = path.join(__dirname, "..", "samplePatterns");
const outDir = path.join(__dirname, "..", "output");

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { sts: 20, row: 28, stampDx: 0, preferredSize: "3" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sts" && argv[i + 1]) opts.sts = Number(argv[++i]);
    else if (a === "--row" && argv[i + 1]) opts.row = Number(argv[++i]);
    else if (a === "--stampDx" && argv[i + 1]) opts.stampDx = Number(argv[++i]);
    else if (a === "--preferredSize" && argv[i + 1]) opts.preferredSize = argv[++i];
  }
  return opts;
}

async function ensureOut() {
  try {
    await fs.mkdir(outDir, { recursive: true });
  } catch (e) {
    // ignore
  }
}

async function run() {
  const opts = parseArgs();
  await ensureOut();
  const files = await fs.readdir(sampleDir);
  const pdfs = files.filter(f => f.toLowerCase().endsWith('.pdf'));
  if (pdfs.length === 0) {
    console.error('No PDFs found in', sampleDir);
    process.exit(1);
  }

  for (const f of pdfs) {
    const inPath = path.join(sampleDir, f);
    const outPath = path.join(outDir, f.replace(/\.pdf$/i, '') + '-stamped.pdf');
    try {
      console.log('Processing', f);
      const data = await fs.readFile(inPath);
      const pdfBytes = await extractAndStamp(data, opts.sts, opts.row, opts.stampDx, opts.preferredSize);
      await fs.writeFile(outPath, Buffer.from(pdfBytes));
      console.log('Wrote', outPath);
    } catch (err) {
      console.error('Error processing', f, err && err.message ? err.message : err);
    }
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
