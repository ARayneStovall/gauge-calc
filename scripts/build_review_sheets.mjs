import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const rawDir = path.join(repoRoot, "finetuneData", "raw");
const reviewDir = path.join(repoRoot, "finetuneData", "review");

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { files: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--files" && argv[i + 1]) opts.files = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
  }
  return opts;
}

// Strips whitespace and hyphens entirely rather than just collapsing runs of
// whitespace: pdfjs's font-kerning-driven text extraction sometimes splits
// what's visually one token into two items with a space between (e.g. "48"
// extracted as "4 8", "68, 72" as "68 , 72"), and PDF line-wrap justification
// sometimes leaves a literal hyphen at a word break (e.g. "ending" extracted
// as "end-\ning"). The model correctly reads these as one token/word when
// quoting, so collapsing to a single space isn't enough. Stripping both
// still requires an exact character match otherwise, so a genuinely
// different (hallucinated) sentence still won't pass — this just absorbs
// these two known PDF-extraction quirks.
function normalizeWhitespace(str) {
  return str.replace(/[\s-]+/g, "");
}

// patternText is pdfjs items joined with single spaces, which doesn't always
// land on the same whitespace as the quote the model produced (extra/missing
// spaces around punctuation, line-wrap joins). Comparing on normalized
// whitespace catches genuine hallucinations without flagging cosmetic
// mismatches as false positives.
function quoteIsGrounded(patternText, quote) {
  if (!quote) return false;
  return normalizeWhitespace(patternText).includes(normalizeWhitespace(quote));
}

function renderSheet(record) {
  const { file, preferredSizeLabel, patternText, output } = record;
  const lines = [];
  lines.push(`# ${file} — size "${preferredSizeLabel}"`);
  lines.push("");
  lines.push(`Overall gauge: ${output.stitches_per_4in} sts / ${output.rows_per_4in} rows per 4in. Top-level stitch_count: ${output.stitch_count}.`);
  lines.push("");
  lines.push("Review checklist (fix directly in the matching .json in finetuneData/raw/, then set \"reviewed\": true there):");
  lines.push("- [ ] Every section heading below is a real heading in the PDF, copied verbatim (not paraphrased)");
  lines.push("- [ ] No real heading from the PDF is missing from this list");
  lines.push("- [ ] No section here is hallucinated / doesn't correspond to a real heading");
  lines.push("- [ ] Each source_quote is the sentence that actually justifies that section's stitch_count and row_count (not a similar-looking checkpoint from elsewhere in the pattern)");
  lines.push("");
  lines.push("For each section: Cmd/Ctrl-F the quoted sentence in the source PDF to jump straight to it instead of reading the whole pattern.");
  lines.push("");

  const sections = output?.sections?.sections ?? [];
  if (sections.length === 0) {
    lines.push("_No sections extracted — check whether the pattern actually has named sections/headings the model missed._");
  }

  for (const s of sections) {
    lines.push(`## ${s.name}`);
    lines.push(`- Stitches: ${s.stitch_count} (repeat multiple: ${s.repeat_multiple})`);
    lines.push(`- Rows: ${s.row_count} (repeat multiple: ${s.row_repeat_multiple})`);
    const grounded = quoteIsGrounded(patternText, s.source_quote);
    lines.push(`- Source quote${grounded ? "" : " — ⚠️ NOT FOUND VERBATIM in extracted text, check this one first"}:`);
    lines.push(`  > ${s.source_quote}`);
    lines.push("");
  }

  return lines.join("\n");
}

async function run() {
  const opts = parseArgs();
  await fs.mkdir(reviewDir, { recursive: true });

  const allRaw = (await fs.readdir(rawDir)).filter(f => f.toLowerCase().endsWith(".json"));
  const targets = opts.files
    ? allRaw.filter(f => opts.files.some(want => f.toLowerCase().includes(want.toLowerCase())))
    : allRaw;

  const indexRows = [];
  let flaggedCount = 0;

  for (const rawFile of targets) {
    const raw = JSON.parse(await fs.readFile(path.join(rawDir, rawFile), "utf8"));
    const sheet = renderSheet(raw);
    const outName = rawFile.replace(/\.json$/i, ".md");
    await fs.writeFile(path.join(reviewDir, outName), sheet);

    const sections = raw.output?.sections?.sections ?? [];
    const ungroundedCount = sections.filter(s => !quoteIsGrounded(raw.patternText, s.source_quote)).length;
    if (ungroundedCount > 0) flaggedCount++;

    indexRows.push({
      file: raw.file,
      sizeLabel: raw.preferredSizeLabel,
      reviewed: !!raw.reviewed,
      sectionCount: sections.length,
      ungroundedCount,
      sheet: outName,
    });

    console.log(`Wrote ${path.relative(repoRoot, path.join(reviewDir, outName))}${ungroundedCount > 0 ? ` (${ungroundedCount} quote(s) not found verbatim — check first)` : ""}`);
  }

  const indexLines = ["# Fine-tune dataset review status", ""];
  for (const row of indexRows) {
    indexLines.push(`- [${row.reviewed ? "x" : " "}] ${row.file} (size ${row.sizeLabel}, ${row.sectionCount} sections${row.ungroundedCount > 0 ? `, ⚠️ ${row.ungroundedCount} ungrounded quote(s)` : ""}) — see ${row.sheet}`);
  }
  await fs.writeFile(path.join(reviewDir, "index.md"), indexLines.join("\n") + "\n");

  console.log(`\n${targets.length} sheet(s) written to finetuneData/review/. ${flaggedCount} file(s) have at least one quote that wasn't found verbatim in the extracted text — start with those. See finetuneData/review/index.md for overall status.`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
