# gaugeCalc

A tool for knitters and crocheters: upload a PDF pattern and your actual gauge, get back the same PDF with stitch and row counts recalculated for your gauge — stamped directly over the original numbers, so you can still see what the pattern originally said.

## How it works

1. **Extraction** — the uploaded PDF's text is pulled out along with each text fragment's position on the page (`pdfjs-dist`).
2. **Parsing** — the raw pattern text is sent to Claude, which extracts structured data: the pattern's gauge, and each section (ribbing, front panel, sleeve decreases, etc.) with its stitch count, row count, and repeat constraints. If the pattern lists multiple sizes, a preferred size label can be passed through so Claude extracts counts for that size specifically (falling back to the middle/nearest size if the label isn't found).
3. **Rescaling** — deterministic math (no LLM involved) converts each section's stitch/row counts from the pattern's gauge to the knitter's actual gauge, rounding up to the nearest valid repeat.
4. **Stamping** — the recalculated numbers are drawn back onto the original PDF (`pdf-lib`) at the same position as the original numbers. Each number is matched as a whole number (not a substring) within its own section's text range, so a repeated number (e.g. the same stitch count used in both the front and back panel) only gets replaced within its own section, and a short count like "1" doesn't get matched inside unrelated numbers like "11" or "51". Positioning is auto-centered per page using the median glyph-width scale and offset across that page's matches, with an optional manual x-offset nudge for fine-tuning.

## Stack

- **Backend**: Node.js + TypeScript, Express, `pdfjs-dist` (extraction), `pdf-lib` (stamping), Anthropic SDK (`@anthropic-ai/sdk`) with Zod structured outputs for parsing pattern text.
- **Frontend**: React + TypeScript (Vite).

## Running locally

You'll need an `ANTHROPIC_API_KEY` set in your environment.

**Backend:**
```
npm install
node server.js
```
Runs on `http://localhost:3001`.

**Frontend** (separate terminal):
```
cd frontend
npm install
npm run dev
```
Runs on `http://localhost:5173`.

With both running, open the frontend in your browser, upload a pattern PDF, enter your gauge (and optionally a preferred size label or a manual stamp x-offset), and download the recalculated version.

## Deploying

The frontend (static) and backend (needs a running Node process + your Anthropic API key kept secret) are hosted separately, both on free tiers.

**Backend — [Render](https://render.com):**
1. New → Blueprint, connect this repo. Render will read `render.yaml` and set up the build (`npm install --include=dev && npm run build`) and start (`npm start`) commands automatically.
2. When prompted for env vars, set `ANTHROPIC_API_KEY` (required) and `FRONTEND_ORIGIN` (optional — the deployed frontend's URL, once you have it, to restrict CORS instead of allowing any origin).
3. Note the resulting service URL (`https://<name>.onrender.com`) — the frontend needs it.

Free tier caveat: the service spins down after inactivity, so the first request after idle time takes 10–30s to wake up before PDF processing even starts.

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
node scripts/inspect_output.mjs
```
Compares each stamped PDF in `output/` against its original in `samplePatterns/`, page by page, reporting which numeric tokens are new and cross-checking them against the corresponding `diagnostics/` file's expected rescaled values.
