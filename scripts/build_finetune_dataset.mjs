import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const sampleDir = path.join(repoRoot, "samplePatterns");
const datasetDir = path.join(repoRoot, "finetuneData", "raw");
const defaultConfigPath = path.join(repoRoot, "test.config.json");

// promptingGemini.js constructs its GoogleGenAI client at module-load time,
// so GEMINI_API_KEY has to be in process.env *before* that module is
// imported — a static top-level `import` would already have run by the
// time this script's own body executes. Loading a project-local .env
// (gitignored) here means the key doesn't depend on which shell/profile
// happens to be sourced by whatever runs this script.
async function loadDotEnv() {
  const envPath = path.join(repoRoot, ".env");
  let raw;
  try {
    raw = await fs.readFile(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

await loadDotEnv();

const { extractPatternText } = await import("../extractStampText.js");
const { prompting } = await import("../promptingGemini.js");

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { sizes: null, files: null, force: false, configPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sizes" && argv[i + 1]) opts.sizes = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--files" && argv[i + 1]) opts.files = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--force") opts.force = true;
    else if (a === "--config" && argv[i + 1]) opts.configPath = argv[++i];
  }
  return opts;
}

async function loadConfig(configPath) {
  const resolvedPath = configPath ? path.resolve(configPath) : defaultConfigPath;
  try {
    const raw = await fs.readFile(resolvedPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sanitizeLabel(label) {
  return String(label).replace(/[^a-zA-Z0-9_-]/g, "_");
}

// One raw example per (file, size label): the same PDF read at a different
// preferredSize is a genuinely different valid GaugeSchema output (different
// size chosen from the bracketed list), so this is how a handful of sample
// PDFs turns into more than a handful of distinct training pairs without
// needing new source patterns.
async function buildOneExample(file, sizeLabel, force) {
  const base = file.replace(/\.pdf$/i, "");
  const outPath = path.join(datasetDir, `${base}--size-${sanitizeLabel(sizeLabel)}.json`);

  if (!force) {
    try {
      await fs.access(outPath);
      console.log(`[${file}] size=${sizeLabel} already exists, skipping (use --force to redo)`);
      return { file, sizeLabel, status: "skipped" };
    } catch {
      // doesn't exist yet, proceed
    }
  }

  console.log(`[${file}] size=${sizeLabel} extracting text + calling prompting()...`);
  const pdfBuffer = await fs.readFile(path.join(sampleDir, file));
  const { patternText } = await extractPatternText(pdfBuffer);

  try {
    const output = await prompting(patternText, sizeLabel);
    await fs.mkdir(datasetDir, { recursive: true });
    await fs.writeFile(outPath, JSON.stringify({
      file,
      preferredSizeLabel: sizeLabel,
      patternText,
      output,
      reviewed: false,
      generatedAt: new Date().toISOString(),
    }, null, 2));
    console.log(`[${file}] size=${sizeLabel} wrote ${path.relative(repoRoot, outPath)}`);
    return { file, sizeLabel, status: "ok", outPath };
  } catch (err) {
    console.error(`[${file}] size=${sizeLabel} FAILED:`, err && err.message ? err.message : err);
    return { file, sizeLabel, status: "error", error: err?.message ?? String(err) };
  }
}

async function run() {
  const opts = parseArgs();
  const config = await loadConfig(opts.configPath);

  const allFiles = (await fs.readdir(sampleDir)).filter(f => f.toLowerCase().endsWith(".pdf"));
  // Defaults to every sample PDF, not test.config.json's "files" list — that
  // config is scoped to whatever run_test.mjs is currently focused on
  // testing, which is often a single pattern, not the full dataset corpus.
  const files = opts.files ?? allFiles;
  const resolvedFiles = files
    .map(want => allFiles.find(f => f.toLowerCase() === want.toLowerCase()) ?? allFiles.find(f => f.toLowerCase().includes(want.toLowerCase())))
    .filter(Boolean);

  // Default to a single size (whatever test.config.json already uses, or
  // "3") to keep the first run cheap — pass --sizes to fan out per PDF once
  // you're ready to multiply examples by size.
  const sizes = opts.sizes ?? [config?.preferredSize ?? "3"];

  await fs.mkdir(datasetDir, { recursive: true });

  const results = [];
  for (const file of resolvedFiles) {
    for (const sizeLabel of sizes) {
      results.push(await buildOneExample(file, sizeLabel, opts.force));
    }
  }

  const ok = results.filter(r => r.status === "ok").length;
  const skipped = results.filter(r => r.status === "skipped").length;
  const failed = results.filter(r => r.status === "error").length;
  console.log(`\nDone: ${ok} written, ${skipped} skipped, ${failed} failed. Raw examples in ${path.relative(repoRoot, datasetDir)}/`);
  console.log(`Each file has "reviewed": false — go through them against the source PDF and flip to true (correcting "output" as needed) before using them for fine-tuning.`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
