import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { extractStampDiagnostics, extractAndStamp } from "../extractStampText.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const sampleDir = path.join(repoRoot, "samplePatterns");
const testRunsDir = path.join(repoRoot, "testRuns");
const defaultConfigPath = path.join(repoRoot, "test.config.json");

const DEFAULTS = { sts: 20, row: 28, stampDx: 0, preferredSize: "3", repeat: 1, stampEveryRun: false };

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { configPath: null, clean: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sts" && argv[i + 1]) opts.sts = Number(argv[++i]);
    else if (a === "--row" && argv[i + 1]) opts.row = Number(argv[++i]);
    else if (a === "--stampDx" && argv[i + 1]) opts.stampDx = Number(argv[++i]);
    else if (a === "--preferredSize" && argv[i + 1]) opts.preferredSize = argv[++i];
    else if (a === "--repeat" && argv[i + 1]) opts.repeat = Math.max(1, Number(argv[++i]));
    else if (a === "--files" && argv[i + 1]) opts.files = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--stampEveryRun") opts.stampEveryRun = true;
    else if (a === "--config" && argv[i + 1]) opts.configPath = argv[++i];
    else if (a === "--clean") opts.clean = true;
  }
  return opts;
}

async function loadConfig(configPath) {
  const resolvedPath = configPath ? path.resolve(configPath) : defaultConfigPath;
  try {
    const raw = await fs.readFile(resolvedPath, "utf8");
    return { path: resolvedPath, data: JSON.parse(raw) };
  } catch (err) {
    if (configPath) throw new Error(`Couldn't read config at ${resolvedPath}: ${err.message}`);
    return { path: resolvedPath, data: null };
  }
}

// Merge order (lowest to highest precedence): hardcoded DEFAULTS, the
// config file's top-level fields, CLI flags. config.overrides[filename] can
// further override any of these for just that one file.
function resolveFileSpecs(cliOpts, configData) {
  const base = { ...DEFAULTS, ...(configData || {}), ...cliOpts };
  delete base.files;
  delete base.overrides;
  delete base.configPath;
  delete base.clean;

  const rawFiles = cliOpts.files ?? configData?.files ?? null;
  if (!rawFiles) return { base, fileSpecs: null };

  const overrides = configData?.overrides || {};
  const fileSpecs = rawFiles.map(name => ({ ...base, ...(overrides[name] || {}), file: name }));
  return { base, fileSpecs };
}

function resolveTargetFiles(allFiles, want) {
  const exact = allFiles.find(f => f.toLowerCase() === want.toLowerCase());
  if (exact) return [exact];
  return allFiles.filter(f => f.toLowerCase().includes(want.toLowerCase()));
}

// One row per (sectionName, type) instead of one per matched stamp, so
// runs can be compared on what Claude/rescale actually decided for that
// section rather than on how many places in the text it happened to match.
function summarizeDiagnostics(diagnostics) {
  const bySection = new Map();
  for (const d of diagnostics) {
    const key = `${d.sectionName}::${d.type}`;
    if (!bySection.has(key)) {
      bySection.set(key, { sectionName: d.sectionName, type: d.type, originalNumber: d.originalNumber, rescaledNumber: d.rescaledNumber, matchCount: 0 });
    }
    bySection.get(key).matchCount += 1;
  }
  return [...bySection.values()].sort((a, b) => a.sectionName.localeCompare(b.sectionName) || a.type.localeCompare(b.type));
}

function compareRuns(runSummaries) {
  const allKeys = new Set();
  for (const run of runSummaries) for (const s of run) allKeys.add(`${s.sectionName}::${s.type}`);

  const differences = [];
  for (const key of allKeys) {
    const perRun = runSummaries.map(run => run.find(s => `${s.sectionName}::${s.type}` === key));
    const signatures = perRun.map(v => v ? `${v.originalNumber}->${v.rescaledNumber} (x${v.matchCount})` : "MISSING");
    if (new Set(signatures).size > 1) differences.push({ key, signatures });
  }
  return differences;
}

async function testOneFile(pdfName, spec, allFiles) {
  const matches = resolveTargetFiles(allFiles, spec.file);
  if (matches.length === 0) {
    console.error(`No sample PDF matches "${spec.file}"`);
    return { file: spec.file, error: "no matching PDF" };
  }

  const file = matches[0];
  const base = file.replace(/\.pdf$/i, "");
  // No timestamp in the path: each file always writes to the same folder,
  // so re-running overwrites the previous result instead of piling up.
  const fileDir = path.join(testRunsDir, base);
  await fs.mkdir(fileDir, { recursive: true });
  const data = await fs.readFile(path.join(sampleDir, file));

  console.log(`[${file}] sts=${spec.sts} row=${spec.row} preferredSize=${spec.preferredSize} stampDx=${spec.stampDx}, ${spec.repeat} repeat(s)`);

  const runSummaries = [];
  for (let i = 1; i <= spec.repeat; i++) {
    console.log(`[${file}] run ${i}/${spec.repeat}...`);
    try {
      const diagnostics = await extractStampDiagnostics(data, spec.sts, spec.row, spec.stampDx, spec.preferredSize);
      await fs.writeFile(path.join(fileDir, `run-${i}-diagnostics.json`), JSON.stringify(diagnostics, null, 2));
      runSummaries.push(summarizeDiagnostics(diagnostics));

      if (i === 1 || spec.stampEveryRun) {
        const pdfBytes = await extractAndStamp(data, spec.sts, spec.row, spec.stampDx, spec.preferredSize);
        await fs.writeFile(path.join(fileDir, `run-${i}-stamped.pdf`), Buffer.from(pdfBytes));
      }
    } catch (err) {
      console.error(`[${file}] run ${i} FAILED:`, err && err.message ? err.message : err);
      runSummaries.push([]);
    }
  }

  const differences = spec.repeat > 1 ? compareRuns(runSummaries) : [];
  const result = { file, spec, consistent: differences.length === 0, differences };

  if (spec.repeat > 1) {
    if (differences.length === 0) {
      console.log(`[${file}] consistent across ${spec.repeat} runs`);
    } else {
      console.log(`[${file}] INCONSISTENT across ${spec.repeat} runs:`);
      for (const d of differences) console.log(`    ${d.key}: ${d.signatures.join(" | ")}`);
    }
  }

  await fs.writeFile(path.join(fileDir, "summary.json"), JSON.stringify(result, null, 2));
  return result;
}

async function run() {
  const cliOpts = parseArgs();
  const { path: configPath, data: configData } = await loadConfig(cliOpts.configPath);
  const { base, fileSpecs } = resolveFileSpecs(cliOpts, configData);

  if (configData) console.log(`Using config ${configPath}`);

  if (cliOpts.clean) {
    await fs.rm(testRunsDir, { recursive: true, force: true });
    console.log("Cleared testRuns/");
  }
  await fs.mkdir(testRunsDir, { recursive: true });

  const allFiles = (await fs.readdir(sampleDir)).filter(f => f.toLowerCase().endsWith(".pdf"));
  const specs = fileSpecs ?? allFiles.map(file => ({ ...base, file }));

  const results = [];
  for (const spec of specs) {
    results.push(await testOneFile(spec.file, spec, allFiles));
  }

  await fs.writeFile(path.join(testRunsDir, "summary.json"), JSON.stringify({ results }, null, 2));
  console.log(`\nFull results in ${testRunsDir}/ (see summary.json for the overview, each file's own folder for its runs)`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
