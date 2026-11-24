import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// Scores the parser against the hand-reviewed answer key in
// finetuneData/raw/ (every file with "reviewed": true). Unlike
// test:patterns, which only checks whether repeat runs agree with each
// other, this checks whether a parse is actually *right*, so prompt,
// model, fine-tuning or retrieval changes can be compared by one number.
//
//   npm run score                         parse every reviewed pattern once and score it
//   npm run score -- --repeat 3           parse each 3 times (the LLM isn't deterministic)
//   npm run score -- --files "Hat,Petty"  only these patterns (exact or partial name)
//   npm run score -- --from scoreRuns/2026-11-24-01
//                                         re-score saved parses without calling the LLM
//                                         (a testRuns/ folder works too)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const answerKeyDir = path.join(repoRoot, "finetuneData", "raw");
const sampleDir = path.join(repoRoot, "samplePatterns");
const scoreRunsDir = path.join(repoRoot, "scoreRuns");

// What gets compared. Shaping phases aren't scored: the answer key was
// written before shaping_phases existed in the schema, so it has none.
// Row counts are compared only after keepOnlyPrintedRowCounts() has been
// applied to both sides, so a total that's never printed (and so never
// stamped), or a 0 against a 1, doesn't count as a difference.
const GAUGE_FIELDS = ["stitches_per_4in", "rows_per_4in", "stitch_count"];
const SECTION_FIELDS = ["stitch_count", "row_count", "repeat_multiple", "row_repeat_multiple"];

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { repeat: 1, files: null, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repeat" && argv[i + 1]) opts.repeat = Math.max(1, Number(argv[++i]));
    else if (a === "--files" && argv[i + 1]) opts.files = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--from" && argv[i + 1]) opts.from = path.resolve(argv[++i]);
    else {
      console.error(`Unknown or incomplete argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

// promptingGemini.js builds its client when it's first imported, so the key
// has to be in process.env before then (same approach as
// build_finetune_dataset.mjs).
async function loadDotEnv() {
  let raw;
  try {
    raw = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
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

async function loadAnswerKey(fileFilters) {
  const names = (await fs.readdir(answerKeyDir)).filter(n => n.endsWith(".json")).sort();
  const entries = [];
  for (const name of names) {
    const raw = JSON.parse(await fs.readFile(path.join(answerKeyDir, name), "utf8"));
    if (raw.reviewed !== true) continue;
    entries.push({ file: raw.file, base: raw.file.replace(/\.pdf$/i, ""), preferredSizeLabel: raw.preferredSizeLabel, patternText: raw.patternText, expected: raw.output });
  }
  if (!fileFilters) return entries;
  return entries.filter(e => fileFilters.some(want => e.file.toLowerCase().includes(want.toLowerCase())));
}

// --- Section matching -----------------------------------------------------

function normalizeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// 1 for the same heading, 0.9 when one name contains the other ("Sleeves"
// vs "Sleeves (make 2)"), otherwise the share of words they have in common.
function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  const shared = [...ta].filter(t => tb.has(t)).length;
  return (2 * shared) / (ta.size + tb.size);
}

const MIN_NAME_SIMILARITY = 0.5;

// Pairs each expected section with at most one predicted section, best name
// match first. When two candidates are named equally well (e.g. a pattern
// with two "Sleeve" sections), the one with the same stitch count wins, then
// the one in the same position in the list.
function matchSections(expectedSections, predictedSections) {
  const candidates = [];
  expectedSections.forEach((exp, ei) => {
    predictedSections.forEach((pred, pi) => {
      const sim = nameSimilarity(exp.name, pred.name);
      if (sim < MIN_NAME_SIMILARITY) return;
      const sameCount = exp.stitch_count === pred.stitch_count ? 0.01 : 0;
      const positionPenalty = Math.abs(ei - pi) * 0.0001;
      candidates.push({ ei, pi, score: sim + sameCount - positionPenalty });
    });
  });
  candidates.sort((a, b) => b.score - a.score);

  const usedExpected = new Set();
  const usedPredicted = new Set();
  const pairs = [];
  for (const c of candidates) {
    if (usedExpected.has(c.ei) || usedPredicted.has(c.pi)) continue;
    usedExpected.add(c.ei);
    usedPredicted.add(c.pi);
    pairs.push(c);
  }
  return {
    pairs: pairs.sort((a, b) => a.ei - b.ei),
    missed: expectedSections.map((_, i) => i).filter(i => !usedExpected.has(i)),
    extra: predictedSections.map((_, i) => i).filter(i => !usedPredicted.has(i)),
  };
}

// --- Scoring --------------------------------------------------------------

function sectionsOf(parse) {
  return parse?.sections?.sections ?? [];
}

// Every check is worth one point:
//   - each of the 3 gauge fields
//   - each expected section: 1 for finding it, plus 1 per field in
//     SECTION_FIELDS (a missed section loses all of these)
//   - each extra section the answer key doesn't have: 1 lost point
//     (it would get stamped somewhere it shouldn't)
function scoreParse(expected, predicted) {
  const mistakes = [];
  let correct = 0;
  let total = 0;

  for (const field of GAUGE_FIELDS) {
    total++;
    if (expected[field] === predicted[field]) correct++;
    else mistakes.push(`gauge ${field}: expected ${expected[field]}, got ${predicted[field]}`);
  }

  const expSections = sectionsOf(expected);
  const predSections = sectionsOf(predicted);
  const { pairs, missed, extra } = matchSections(expSections, predSections);

  let fieldsRight = 0;
  for (const { ei, pi } of pairs) {
    const exp = expSections[ei];
    const pred = predSections[pi];
    correct++;
    total++;
    const label = normalizeName(exp.name) === normalizeName(pred.name) ? `"${exp.name}"` : `"${exp.name}" (found as "${pred.name}")`;
    for (const field of SECTION_FIELDS) {
      total++;
      if (exp[field] === pred[field]) {
        correct++;
        fieldsRight++;
      } else {
        mistakes.push(`${label} ${field}: expected ${exp[field]}, got ${pred[field]}`);
      }
    }
  }
  for (const ei of missed) {
    total += 1 + SECTION_FIELDS.length;
    mistakes.push(`missed section "${expSections[ei].name}"`);
  }
  for (const pi of extra) {
    total++;
    mistakes.push(`extra section "${predSections[pi].name}"`);
  }

  return {
    correct,
    total,
    accuracy: total ? correct / total : 0,
    sectionsExpected: expSections.length,
    sectionsFound: pairs.length,
    sectionsExtra: extra.length,
    fieldsChecked: pairs.length * SECTION_FIELDS.length,
    fieldsRight,
    mistakes,
  };
}

// --- Where parses come from -----------------------------------------------

async function nextRunFolderName() {
  const date = new Date().toISOString().slice(0, 10);
  let existing = [];
  try {
    existing = await fs.readdir(scoreRunsDir);
  } catch {
    // scoreRuns/ doesn't exist yet
  }
  const pattern = new RegExp(`^${date}-(\\d+)$`);
  const used = existing.map(name => Number(pattern.exec(name)?.[1] ?? 0));
  return `${date}-${String(Math.max(0, ...used) + 1).padStart(2, "0")}`;
}

// The size each file was parsed at in a saved folder: report.json for a
// scoreRuns/ folder, summary.json for a testRuns/ folder. Parses made at a
// different size than the answer key's can't be compared, so they're skipped.
async function savedSizes(dir) {
  const sizes = new Map();
  for (const [name, read] of [
    ["report.json", data => (data.files ?? []).map(f => [f.file, f.preferredSizeLabel])],
    ["summary.json", data => (data.results ?? []).map(r => [r.file, r.spec?.preferredSize])],
  ]) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
      for (const [file, size] of read(data)) if (file && size != null) sizes.set(file, String(size));
    } catch {
      // that file isn't in this folder
    }
  }
  return sizes;
}

async function loadSavedParses(dir, entry, sizes) {
  const savedSize = sizes.get(entry.file);
  if (savedSize !== undefined && savedSize !== String(entry.preferredSizeLabel)) {
    return { skipped: `parsed at size "${savedSize}", answer key is size "${entry.preferredSizeLabel}"` };
  }
  let names;
  try {
    names = await fs.readdir(path.join(dir, entry.base));
  } catch {
    return { skipped: "not in that folder" };
  }
  const runFiles = names.filter(n => /^run-\d+-parse\.json$/.test(n)).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));
  if (runFiles.length === 0) return { skipped: "no saved parses" };
  const runs = [];
  for (const name of runFiles) runs.push({ parse: JSON.parse(await fs.readFile(path.join(dir, entry.base, name), "utf8")) });
  return { runs };
}

async function parseLive(entry, repeat, runDir, parsePattern) {
  let pdf;
  try {
    pdf = await fs.readFile(path.join(sampleDir, entry.file));
  } catch {
    return { skipped: `${entry.file} isn't in samplePatterns/` };
  }
  const fileDir = path.join(runDir, entry.base);
  await fs.mkdir(fileDir, { recursive: true });
  const runs = [];
  for (let i = 1; i <= repeat; i++) {
    try {
      const parse = await parsePattern(pdf, entry.preferredSizeLabel);
      await fs.writeFile(path.join(fileDir, `run-${i}-parse.json`), JSON.stringify(parse, null, 2));
      runs.push({ parse });
    } catch (err) {
      runs.push({ error: `${err?.status ? `${err.status} ` : ""}${err?.message ?? err}`.slice(0, 300) });
    }
  }
  return { runs };
}

// --- Reporting ------------------------------------------------------------

const pct = x => `${(x * 100).toFixed(1)}%`;

function summarize(fileResults) {
  const scores = fileResults.flatMap(f => f.runs.filter(r => r.score).map(r => r.score));
  const sum = key => scores.reduce((acc, s) => acc + s[key], 0);
  const sectionsPredicted = sum("sectionsFound") + sum("sectionsExtra");
  return {
    runsScored: scores.length,
    runsFailed: fileResults.reduce((acc, f) => acc + f.runs.filter(r => r.error).length, 0),
    filesSkipped: fileResults.filter(f => f.skipped).length,
    accuracy: sum("total") ? sum("correct") / sum("total") : 0,
    sectionsFoundRate: sum("sectionsExpected") ? sum("sectionsFound") / sum("sectionsExpected") : 0,
    extraSectionRate: sectionsPredicted ? sum("sectionsExtra") / sectionsPredicted : 0,
    numbersRightRate: sum("fieldsChecked") ? sum("fieldsRight") / sum("fieldsChecked") : 0,
  };
}

function formatReport(fileResults, overall, source) {
  const lines = [];
  lines.push(`Source: ${source}`);
  lines.push("");
  lines.push(`Overall accuracy:      ${pct(overall.accuracy)}   (share of all checks passed)`);
  lines.push(`Sections found:        ${pct(overall.sectionsFoundRate)}   (of the sections the answer key has)`);
  lines.push(`Extra sections:        ${pct(overall.extraSectionRate)}   (of the sections the parser returned)`);
  lines.push(`Numbers right:         ${pct(overall.numbersRightRate)}   (counts and repeats, in sections it did find)`);
  lines.push(`Runs scored: ${overall.runsScored}, failed: ${overall.runsFailed}, files skipped: ${overall.filesSkipped}`);
  lines.push("");

  const width = Math.max(...fileResults.map(f => f.file.length));
  for (const f of fileResults) {
    if (f.skipped) {
      lines.push(`${f.file.padEnd(width)}  skipped: ${f.skipped}`);
      continue;
    }
    const scored = f.runs.filter(r => r.score);
    const accs = scored.map(r => r.score.accuracy);
    const mean = accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null;
    let cell = mean === null ? "  -   " : pct(mean).padStart(6);
    if (accs.length > 1) cell += `  (runs: ${accs.map(a => pct(a)).join(", ")})`;
    const failed = f.runs.filter(r => r.error).length;
    if (failed) cell += `  ${failed} run(s) failed`;
    lines.push(`${f.file.padEnd(width)}  ${cell}`);
  }
  return lines.join("\n");
}

function formatMistakes(fileResults) {
  const lines = [];
  for (const f of fileResults) {
    if (f.skipped) continue;
    const runLines = [];
    f.runs.forEach((r, i) => {
      if (r.error) runLines.push(`  run ${i + 1}: FAILED (${r.error})`);
      else if (r.score.mistakes.length) {
        runLines.push(`  run ${i + 1}: ${r.score.correct}/${r.score.total}`);
        for (const m of r.score.mistakes) runLines.push(`    - ${m}`);
      }
    });
    if (runLines.length) {
      lines.push(`${f.file} (size ${f.preferredSizeLabel})`);
      lines.push(...runLines, "");
    }
  }
  return lines.length ? lines.join("\n") : "No mistakes.\n";
}

// --- Main -----------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const entries = await loadAnswerKey(opts.files);
  if (entries.length === 0) {
    console.error(`No reviewed answer-key files${opts.files ? " match --files" : ""} in ${path.relative(repoRoot, answerKeyDir)}/.`);
    process.exit(1);
  }

  await loadDotEnv();
  const { parsePattern, keepOnlyPrintedRowCounts } = await import("../extractStampText.js");
  // Uses the answer key's saved pattern text for both sides, so the same
  // section ranges and size list decide what counts as printed.
  const applyRowRule = (entry, parse) => keepOnlyPrintedRowCounts(parse, entry.patternText, entry.preferredSizeLabel);

  let outDir;
  let source;
  let getRuns;
  if (opts.from) {
    outDir = opts.from;
    source = `saved parses in ${path.relative(repoRoot, opts.from)}`;
    const sizes = await savedSizes(opts.from);
    getRuns = entry => loadSavedParses(opts.from, entry, sizes);
  } else {
    outDir = path.join(scoreRunsDir, await nextRunFolderName());
    await fs.mkdir(outDir, { recursive: true });
    source = `live parses, ${opts.repeat} run(s) per pattern, saved to ${path.relative(repoRoot, outDir)}`;
    getRuns = entry => parseLive(entry, opts.repeat, outDir, parsePattern);
  }

  console.log(`Scoring ${entries.length} reviewed pattern(s): ${source}\n`);
  const fileResults = [];
  for (const entry of entries) {
    const { runs, skipped } = await getRuns(entry);
    const result = { file: entry.file, preferredSizeLabel: entry.preferredSizeLabel };
    if (skipped) {
      result.skipped = skipped;
      result.runs = [];
      console.log(`[${entry.file}] skipped: ${skipped}`);
    } else {
      result.runs = runs.map(r => (r.error ? { error: r.error } : { score: scoreParse(applyRowRule(entry, entry.expected), applyRowRule(entry, r.parse)) }));
      const summary = result.runs.map(r => (r.error ? "failed" : pct(r.score.accuracy))).join(", ");
      console.log(`[${entry.file}] ${summary}`);
    }
    fileResults.push(result);
  }

  const overall = summarize(fileResults);
  const report = formatReport(fileResults, overall, source);
  console.log(`\n${report}`);

  // Re-scoring a saved folder writes score files beside the parses and
  // leaves its report.json alone (it records the sizes those parses used).
  const prefix = opts.from ? "rescore-" : "";
  await fs.writeFile(path.join(outDir, `${prefix}score.txt`), report + "\n");
  await fs.writeFile(path.join(outDir, `${prefix}mistakes.txt`), formatMistakes(fileResults));
  if (!opts.from) {
    await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify({ overall, files: fileResults }, null, 2));
  }
  console.log(`\nEvery wrong answer is listed in ${path.relative(repoRoot, path.join(outDir, `${prefix}mistakes.txt`))}`);
}

await main();
