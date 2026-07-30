import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const rawDir = path.join(repoRoot, "finetuneData", "raw");
const outDir = path.join(repoRoot, "finetuneData", "tuning");
const outPath = path.join(outDir, "gemini_examples.json");

// The Gemini Developer API's tuning endpoint (client.tunings.tune) accepts
// inline { textInput, output } pairs directly — no GCS bucket needed, unlike
// Vertex AI tuning. See @google/genai's TuningExample/TuningDataset types
// (node_modules/@google/genai/dist/genai.d.ts) for the exact shape this
// targets.
//
// preferredSizeLabel has to be baked into textInput rather than left as a
// separate field: it's real information that changes which bracketed size
// value is the correct output for the *same* patternText (that's the whole
// point of generating one raw example per size), and TuningExample has no
// slot for it other than textInput itself. The big system prompt (schema
// rules, heading-detection rules, etc.) is deliberately NOT duplicated in
// here — the assumption is that promptingGemini.ts keeps sending that same
// systemInstruction at inference time even when calling the tuned model, and
// tuning is just nudging the weights to follow it more reliably, not
// replacing it.
function buildTextInput(raw) {
  return `Preferred size label: ${raw.preferredSizeLabel}\n\n${raw.patternText}`;
}

async function run() {
  let files;
  try {
    files = (await fs.readdir(rawDir)).filter(f => f.toLowerCase().endsWith(".json"));
  } catch {
    console.error(`No ${path.relative(repoRoot, rawDir)}/ directory found — run npm run finetune:dataset first.`);
    process.exit(1);
  }

  const allRaw = [];
  for (const f of files) {
    allRaw.push(JSON.parse(await fs.readFile(path.join(rawDir, f), "utf8")));
  }

  const reviewed = allRaw.filter(r => r.reviewed === true);
  const unreviewed = allRaw.filter(r => r.reviewed !== true);

  const examples = reviewed.map(raw => ({
    textInput: buildTextInput(raw),
    output: JSON.stringify(raw.output),
  }));

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(examples, null, 2));

  console.log(`${reviewed.length} reviewed example(s) written to ${path.relative(repoRoot, outPath)}.`);
  if (unreviewed.length > 0) {
    console.log(`${unreviewed.length} file(s) still have "reviewed": false and were skipped: ${unreviewed.map(r => `${r.file} (${r.preferredSizeLabel})`).join(", ")}`);
  }
  if (reviewed.length === 0) {
    console.log(`\nNothing to tune with yet — go through finetuneData/review/*.md against the source PDFs, correct finetuneData/raw/*.json, and flip "reviewed": true before running this again.`);
  } else if (reviewed.length < 20) {
    console.log(`\nNote: ${reviewed.length} examples is thin for supervised fine-tuning. Consider re-running npm run finetune:dataset with --sizes to add more size variants per pattern before submitting a real tuning job.`);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
