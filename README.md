# gaugeCalc

A tool for knitters and crocheters: upload a PDF pattern and your actual gauge, get back the same PDF with stitch and row counts recalculated for your gauge — stamped directly over the original numbers. The original number is painted over with a white rectangle and the recalculated one is drawn on top in red, so the original isn't recoverable from the output PDF.

## How it works

1. **Extraction** — the uploaded PDF's text is pulled out along with each text fragment's position on the page (`pdfjs-dist`).
2. **Parsing** — the raw pattern text is sent to Claude, which extracts structured data: the pattern's gauge, and each section (ribbing, front panel, sleeve decreases, etc.) with its stitch count, row count, and repeat constraints. If the pattern lists multiple sizes, a preferred size label can be passed through so Claude extracts counts for that size specifically (falling back to the middle/nearest size if the label isn't found).
3. **Rescaling** — deterministic math (no LLM involved) converts each section's stitch/row counts from the pattern's gauge to the knitter's actual gauge, rounding up to the nearest valid repeat.
4. **Stamping** — the recalculated numbers are drawn back onto the original PDF (`pdf-lib`) at the same position as the original numbers. Each number is matched as a whole number (not a substring) within its own section's text range, so a repeated number (e.g. the same stitch count used in both the front and back panel) only gets replaced within its own section, and a short count like "1" doesn't get matched inside unrelated numbers like "11" or "51". A number's on-page position is found by splitting the text run's true rendered width by the *font-metric* fraction of it that falls before and through the number — not a naive per-character split, which badly misjudges position in dense multi-size bracket lists like "(192) 204 (218)" where parentheses are much narrower than digits. The white cover rectangle is sized to whichever of the old or new number is wider, so a shorter replacement (e.g. "93" over "102") doesn't leave a sliver of the original visible. An optional manual x-offset nudge is available for fine-tuning.

## Known limitations

- **Increases/decreases aren't rescaled.** The rescaling math (`rescale.ts`) converts a section's flat stitch/row count and rounds up to the nearest repeat multiple — it doesn't detect or adjust shaping (increases/decreases) within a section, so patterns that rely on those may need manual adjustment after rescaling.
- **Cover-rectangle padding can occasionally clip adjacent punctuation.** The small padding added around each cover rectangle (to fully hide anti-aliased edges of the original glyph) can, on rare occasions, slightly overlap a parenthesis or other character sitting with zero gap against the number (e.g. "(44)") if the position estimate is off by even a couple of points.
- **Rare residual false-positive matches.** Numbers are matched as whole numbers within their own section's text range (not substrings), which fixed most false-positive stamping. A narrower edge case remains: if a stitch count is legitimately repeated inside the pattern author's own worked-example math prose, it can still get matched and stamped more than once.
- **LLM parsing isn't perfectly deterministic.** Each run sends the pattern text to Claude fresh, so two separate runs can occasionally return slightly different section boundaries or values — worse on patterns with many repeated, similarly-shaped size lists or checkpoint sentences (e.g. "You should still have N sts on your needles" restated many times throughout a pattern). Temperature is set to 0, `max_tokens` is generous, and the prompt requires a verbatim source quote per section plus explicit rules for section boundaries and size-position resolution, which together substantially reduce (but don't eliminate) this. Some pattern structures also don't map cleanly onto the extraction schema at all — a section spanning several rounds that each restate their own running stitch total has no single canonical "the" count for that section. Use `npm run test:patterns -- --repeat N` (see below) to check whether a specific pattern parses consistently before trusting a one-off result.

## Stack

- **Backend**: Node.js + TypeScript, Express, `pdfjs-dist` (extraction), `pdf-lib` (stamping), Anthropic SDK (`@anthropic-ai/sdk`) with Zod structured outputs for parsing pattern text.
- **Frontend**: React + TypeScript (Vite).

## Running locally

You'll need an `ANTHROPIC_API_KEY` set in your environment.

**Backend:**
```
npm install
npm run build
npm start
```
Runs on `http://localhost:3001`. (`npm run build` compiles the TypeScript in place; re-run it after editing backend source, or use your editor's TS watch/build task instead.)

**Frontend** (separate terminal):
```
cd frontend
npm install
npm run dev
```
Runs on `http://localhost:5173`.

With both running, open the frontend in your browser, upload a pattern PDF, enter your gauge (and optionally a preferred size label), and download the recalculated version. (`stampDx`, a manual x-offset nudge for fine-tuning stamp position, is a backend/CLI-only knob — see [Testing against sample patterns](#testing-against-sample-patterns) — not exposed in the UI.)

## Deploying

The frontend (static) and backend (needs a running Node process + your Anthropic API key kept secret) are hosted separately, both on free tiers.

**Backend — [Render](https://render.com):**
1. New → Blueprint, connect this repo. Render will read `render.yaml` and set up the build (`npm install --include=dev && npm run build`) and start (`npm start`) commands automatically.
2. When prompted for env vars, set `ANTHROPIC_API_KEY` (required) and `FRONTEND_ORIGIN` (optional — the deployed frontend's URL, once you have it, to restrict CORS instead of allowing any origin). When set, CORS also automatically allows any Vercel preview URL for this same project (matched by a `gaugecalculator-*.vercel.app` pattern in `server.ts`) so preview deployments can hit the same shared backend — update that pattern if you rename the Vercel project.
3. Note the resulting service URL (`https://<name>.onrender.com`) — the frontend needs it.

Free tier caveats: the service spins down after inactivity, so the first request after idle time takes 10–30s to wake up before PDF processing even starts; uploads are also capped at 20MB (`server.ts`), since the whole file is buffered into memory before processing.

**Frontend — [Vercel](https://vercel.com):**
1. New Project, import this repo, set **Root Directory** to `frontend`. Vercel auto-detects the Vite build.
2. Add env var `VITE_API_URL` set to the Render backend URL from above.
3. Deploy. Vite only bakes in vars prefixed `VITE_` at build time, so if you change `VITE_API_URL` later you'll need to redeploy the frontend, not just the backend.

## Project structure

- `rescale.ts` — pure gauge-rescaling and rounding-to-repeat math.
- `promptingClaude.ts` — sends pattern text to Claude and returns structured gauge/section data.
- `extractStampText.ts` — the core pipeline: extracts text + positions, calls the parser, matches each section to its location in the text, rescales, and stamps the corrected numbers onto the PDF. Also exports `extractStampDiagnostics`, a non-mutating variant that returns the same match/position data for debugging instead of writing to the PDF.
- `server.ts` — Express API exposing the pipeline over HTTP.
- `frontend/` — React upload form and download flow.
- `scripts/` — CLI tooling for testing against `samplePatterns/` without going through the UI (see below).

## Testing against sample patterns

`samplePatterns/` holds real pattern PDFs used to sanity-check the pipeline outside the UI. Outputs go to `output/` and `diagnostics/` (both gitignored).

```
npm run batch -- --sts 20 --row 28 --preferredSize 3 --stampDx 0
```
Runs `extractAndStamp` over every PDF in `samplePatterns/`, writing stamped copies to `output/`.

```
npm run validate -- --sts 20 --row 28 --preferredSize 3
```
Runs `extractStampDiagnostics` over every sample PDF and writes per-file match/position data (section, original/rescaled number, page, computed offsets) to `diagnostics/`, without touching the PDFs.

```
npm run test:patterns
npm run test:patterns -- --files "Bow Pop Mittens,Petty_Harbour" --sts 20 --row 28 --preferredSize 3 --repeat 3
npm run test:patterns -- --config myOtherConfig.json
npm run test:patterns -- --clean
```
Runs one or more specific patterns (matched by exact or partial filename) with your own gauge/size/offset, `--repeat N` times each. Reads `test.config.json` at the repo root by default (edit it directly instead of typing flags every time — see below), or point at a different file with `--config`; any CLI flag passed overrides the config for that run. When `repeat` is greater than 1, it also diffs each section's original/rescaled numbers across runs and flags any that differ — since `prompting()` hits Claude fresh every call (see the non-determinism note above), this is how to check whether a given pattern parses consistently before trusting a one-off result.

Each invocation writes to its own folder named `<date>-<run number>` (e.g. `testRuns/2026-07-26-01/`, then `-02` for the next run that same day, and so on) — every file tested in that invocation shares it, so successive test runs build up a history instead of overwriting each other. Inside, each file gets its own subfolder (`run-N-diagnostics.json` per repeat, `run-1-stamped.pdf` for the first run — pass `stampEveryRun: true` to write one for every repeat), `testRuns/<date>-<run number>/summary.json` gives the full per-file overview for that invocation, and `testRuns/<date>-<run number>/inconsistencies.txt` is a flat, quick-scan list of every inconsistency found across every file tested (skip straight to this one instead of digging through each file's own summary). `--clean` wipes the whole `testRuns/` folder if you want to clear the history out (and resets the run number back to 01). `testRuns/` is gitignored.

`test.config.json` accepts:
```json
{
  "sts": 20,
  "row": 28,
  "preferredSize": "3",
  "stampDx": 0,
  "repeat": 1,
  "stampEveryRun": false,
  "files": null
}
```
`files: null` tests every sample pattern with the settings above. To test specific patterns, list their names in `files`; to give one of them different settings, add an entry under `overrides` keyed by that same name (only the fields you name there override the top-level settings, everything else is inherited):
```json
"files": ["Bow Pop Mittens", "Petty_Harbour"],
"overrides": {
  "Petty_Harbour": { "sts": 22, "row": 30, "repeat": 5 }
}
```

```
node scripts/inspect_output.mjs
```
Compares each stamped PDF in `output/` against its original in `samplePatterns/`, page by page, reporting which numeric tokens are new and cross-checking them against the corresponding `diagnostics/` file's expected rescaled values.
