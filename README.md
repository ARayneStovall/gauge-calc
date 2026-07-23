# gaugeCalc

A tool for knitters and crocheters: upload a PDF pattern and your actual gauge, get back the same PDF with stitch and row counts recalculated for your gauge — stamped directly over the original numbers, so you can still see what the pattern originally said.

## How it works

1. **Extraction** — the uploaded PDF's text is pulled out along with each text fragment's position on the page (`pdfjs-dist`).
2. **Parsing** — the raw pattern text is sent to Claude, which extracts structured data: the pattern's gauge, and each section (ribbing, front panel, sleeve decreases, etc.) with its stitch count, row count, and repeat constraints.
3. **Rescaling** — deterministic math (no LLM involved) converts each section's stitch/row counts from the pattern's gauge to the knitter's actual gauge, rounding up to the nearest valid repeat.
4. **Stamping** — the recalculated numbers are drawn back onto the original PDF (`pdf-lib`) at the same position as the original numbers, scoped to the correct section using each section's location in the document — so a repeated number (e.g. the same stitch count used in both the front and back panel) only gets replaced within its own section.

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

With both running, open the frontend in your browser, upload a pattern PDF, enter your gauge, and download the recalculated version.

## Project structure

- `rescale.ts` — pure gauge-rescaling and rounding-to-repeat math.
- `promptingClaude.ts` — sends pattern text to Claude and returns structured gauge/section data.
- `extractStampText.ts` — the core pipeline: extracts text + positions, calls the parser, matches each section to its location in the text, rescales, and stamps the corrected numbers onto the PDF.
- `server.ts` — Express API exposing the pipeline over HTTP.
- `frontend/` — React upload form and download flow.

## Development notes

This project was built as a hands-on learning exercise. All application code — the rescale math, the PDF extraction/stamping pipeline, the Express server, and the React frontend — was written by hand by the project's author. Claude (via Claude Code) was used as a guide throughout: explaining concepts, pointing out bugs, and walking through API usage, but not writing the application logic itself. Claude did directly handle non-logic tooling — package installs, TypeScript/build config, and this README.
