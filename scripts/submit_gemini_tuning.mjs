import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const examplesPath = path.join(repoRoot, "finetuneData", "tuning", "gemini_examples.json");

// This submits a real, billable tuning job to Google's Gemini Developer API
// and creates cloud state (a TuningJob, eventually a tuned model). Not
// something to run casually or automatically — run it deliberately once
// finetuneData/tuning/gemini_examples.json (built by
// scripts/build_gemini_tuning_file.mjs) actually has enough reviewed
// examples in it.
//
// client.tunings is marked @experimental in @google/genai as of the version
// pinned in package.json — check node_modules/@google/genai/dist/genai.d.ts
// or Google's current docs if this starts failing, since the shape may have
// moved on.
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

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { baseModel: "gemini-3.5-flash-lite", displayName: "gaugecalc-gauge-extraction", epochCount: undefined, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--baseModel" && argv[i + 1]) opts.baseModel = argv[++i];
    else if (a === "--displayName" && argv[i + 1]) opts.displayName = argv[++i];
    else if (a === "--epochCount" && argv[i + 1]) opts.epochCount = Number(argv[++i]);
    else if (a === "--yes") opts.yes = true;
  }
  return opts;
}

async function run() {
  const opts = parseArgs();
  await loadDotEnv();

  const examples = JSON.parse(await fs.readFile(examplesPath, "utf8").catch(() => {
    throw new Error(`${path.relative(repoRoot, examplesPath)} not found — run npm run finetune:build-tuning-file first.`);
  }));

  if (examples.length === 0) {
    console.error("No examples in gemini_examples.json — nothing to submit. Review and mark raw examples \"reviewed\": true first.");
    process.exit(1);
  }

  if (!opts.yes) {
    console.log(`About to submit a real tuning job: baseModel=${opts.baseModel}, ${examples.length} example(s), displayName="${opts.displayName}".`);
    console.log(`This creates billable cloud state. Re-run with --yes to actually submit.`);
    process.exit(0);
  }

  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({});

  const tuningJob = await client.tunings.tune({
    baseModel: opts.baseModel,
    trainingDataset: { examples },
    config: {
      tunedModelDisplayName: opts.displayName,
      ...(opts.epochCount ? { epochCount: opts.epochCount } : {}),
    },
  });

  console.log("Tuning job submitted:");
  console.log(JSON.stringify(tuningJob, null, 2));
  console.log(`\nPoll status with: node -e "import('@google/genai').then(async ({GoogleGenAI}) => console.log(await new GoogleGenAI({}).tunings.get({name: '${tuningJob.name}'})))"`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
