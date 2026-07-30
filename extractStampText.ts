import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createRequire } from "node:module";
import path from "path";
import { rescaleCount, rescaleShaping } from "./rescale.js";
const DEBUG = process.env.DEBUG === "1";

// Thrown when a PDF yields too little (or no) extracted text to plausibly
// contain real pattern instructions — most commonly a scanned/image-only PDF
// with no embedded text layer at all (pdfjs can only read text actually
// encoded in the PDF, not pixels in a scanned image). Without this check,
// the LLM was observed to confidently hallucinate a complete, plausible
// -looking gauge output even from zero input text — silently fabricating
// numbers is worse than failing with a clear reason, so this is checked
// before ever calling the LLM. server.ts catches this specifically to
// surface the message to the user instead of a generic error.
export class InsufficientPatternTextError extends Error {}

// The shortest genuine sample pattern seen so far (a one-size hat with full
// written directions, no charts) is well over 1500 characters; 200 is a
// conservative floor that only catches near-empty extractions, not
// legitimately short patterns.
const MIN_PATTERN_TEXT_LENGTH = 200;

// Which LLM actually does the extraction — set LLM_PROVIDER=claude to use
// promptingClaude.ts instead of the Gemini default. Both share the same
// schema and system prompt (promptShared.ts), so this is a like-for-like
// comparison via test:patterns, not two different behaviors. Dynamically
// imported (rather than importing both statically) so only the selected
// provider's SDK client actually gets constructed.
const LLM_PROVIDER = process.env.LLM_PROVIDER === "claude" ? "claude" : "gemini";
async function prompting(context: string, preferredSizeLabel: string) {
    const mod = LLM_PROVIDER === "claude"
        ? await import("./promptingClaude.js")
        : await import("./promptingGemini.js");
    return mod.prompting(context, preferredSizeLabel);
}

// Finds `numberText` in `str` as a standalone number, not as a substring of a
// larger one — e.g. target "1" must not match inside "11" or "51". Plain
// String#includes/indexOf would match those, which previously caused a
// section with a row/stitch count of "1" to get "found" (and stamped over)
// dozens of unrelated numbers throughout its text.
function findWholeNumberIndex(str: string, numberText: string): number {
    const escaped = numberText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?<![0-9])${escaped}(?![0-9])`);
    const match = regex.exec(str);
    return match ? match.index : -1;
}

// Builds the two shaping-cadence stamp targets for a section (its shaping
// event count and its row/round interval), if it has any periodic shaping at
// all (shaping_stitches_per_event !== 0). Unlike the plain stitches/rows
// targets, these need a *precomputed* replacement value — rescaleShaping()
// depends on the section's own already-rescaled start/end stitch counts and
// row count, not a simple ptrnCnt/knitterCnt ratio — so callers must use
// `precomputedRescaled` instead of calling rescaleCount() for these two
// target types. Shared by extractAndStamp and extractStampDiagnostics so the
// shaping math itself isn't duplicated, even though the rest of each
// function's stamping loop is (see the comments on sectionBoundaries there).
function buildShapingTargets(section: any, index: number, stsCnt: number, knitterGaugeSts: number, rowCnt: number, knitterGaugeRow: number): Array<any> {
    const stitchesPerEvent = Number(section.shaping_stitches_per_event ?? 0);
    if (!stitchesPerEvent) return [];

    const repeatMultiple = Number(section.repeat_multiple ?? 1) || 1;
    const rowRepeatMultiple = Number(section.row_repeat_multiple ?? 1) || 1;
    const sectionName = section.name ?? "";

    const newStartStitches = rescaleCount(stsCnt, knitterGaugeSts, Number(section.shaping_start_stitch_count ?? 0), repeatMultiple, sectionName, "shaping-start");
    const newEndStitches = rescaleCount(stsCnt, knitterGaugeSts, Number(section.stitch_count ?? 0), repeatMultiple, sectionName, "stitches");
    const newTotalRows = rescaleCount(rowCnt, knitterGaugeRow, Number(section.row_count ?? 0), rowRepeatMultiple, sectionName, "rows");

    const { eventCount, intervalRows } = rescaleShaping(newStartStitches, newEndStitches, stitchesPerEvent, newTotalRows);

    return [
        {
            ptrnCnt: 0,
            knitterCnt: 0,
            numStsPtrn: Number(section.shaping_event_count ?? 0),
            repeatMultiple: 1,
            sectionName,
            sectionIndex: index,
            type: "shaping_event_count",
            precomputedRescaled: eventCount
        },
        {
            ptrnCnt: 0,
            knitterCnt: 0,
            numStsPtrn: Number(section.shaping_interval_rows ?? 0),
            repeatMultiple: 1,
            sectionName,
            sectionIndex: index,
            type: "shaping_interval",
            precomputedRescaled: intervalRows
        }
    ];
}

// Used to derive a page-wide scale/offset from many per-glyph measurements.
// Median (rather than mean) so a handful of noisy/mismeasured items on a
// page don't skew the value used to position every stamp on that page.
function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid]!;
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Flattens every page's text into one string (patternText) for the LLM to
// read, while recording each text item's character offset into that
// flattened string (pageTextInfoArrays). The offsets are what let a later
// matching pass scope a number match to the correct section, even though
// sections and text items are tracked completely separately. Shared by
// extractAndStamp, extractStampDiagnostics, and the fine-tuning dataset
// builder (scripts/build_finetune_dataset.mjs) — all three need the same
// text, but only the first two go on to touch pdf-lib/stamping.
export async function extractPatternText(pdfBuffer: Buffer): Promise<{ patternText: string; pageTextInfoArrays: Array<Array<{ text: string; offset: number }>>; pdf: any }> {
    const require = createRequire(import.meta.url);
    const pdfjsDistPath = require.resolve("pdfjs-dist");
    const fontDataPath = path.join(path.resolve(pdfjsDistPath, "../../standard_fonts"), "/");
    const cmapPath = path.join(path.resolve(pdfjsDistPath, "../../cmaps"), "/");

    const uint8Array = new Uint8Array(pdfBuffer);
    const pdf = await getDocument({ data: uint8Array, standardFontDataUrl: fontDataPath, cMapUrl: cmapPath }).promise;

    let patternText = "";
    const pageTextInfoArrays: Array<Array<{ text: string; offset: number }>> = [];

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const viewportHeight = page.getViewport({ scale: 1 }).height;
        const marginBand = viewportHeight * 0.08;

        let pageText = "";
        const pageItemInfos: Array<{ text: string; offset: number }> = [];
        const pageStartOffset = patternText.length;
        let prevEnd: number | null = null;
        let prevY: number | null = null;

        textContent.items.forEach((item: any) => {
            // pageItemInfos is later indexed positionally by idx against a
            // *second*, independently-fetched textContent.items array (the
            // stamping passes in extractAndStamp/extractStampDiagnostics
            // re-fetch each page's text content rather than reusing this
            // one). pdfjs returns items in the same deterministic order both
            // times, so that positional lookup only stays valid if every
            // item here — including ones we don't want matched — gets a
            // pageItemInfos entry of its own. Skipping the push (as this
            // used to do) shifted every later item's info one slot out of
            // alignment for the rest of the page, silently associating text
            // items with the wrong character offset. A sentinel offset of -1
            // keeps such items permanently outside any real matching range
            // (ranges always start at 0 or above) without disturbing the
            // alignment of everything after them.
            if (!("str" in item)) {
                pageItemInfos.push({ text: "", offset: -1 });
                return;
            }
            const str = item.str;

            // Skip an isolated page-number stamp: a text item that is
            // exactly the page's own 1-indexed number, sitting in the
            // page's top or bottom margin. pdfjs otherwise interleaves these
            // directly into the flattened body text wherever the page break
            // falls — often mid-sentence — where a stray digit can throw off
            // counting-sensitive extraction (e.g. matching a bracketed size
            // list). Requiring both the exact page-number match and the
            // margin-band position (confirmed against every sample PDF)
            // keeps this from ever touching a real stitch/row count.
            const y = item.transform?.[5];
            const isPageNumberStamp = /^\d+$/.test(str.trim()) && Number(str.trim()) === i && typeof y === "number" && (y < marginBand || y > viewportHeight - marginBand);
            if (isPageNumberStamp) {
                pageItemInfos.push({ text: str, offset: -1 });
                return;
            }

            // Adjacent items on the same line separated by (near) zero
            // horizontal gap are typically one word pdfjs split mid-glyph —
            // most often a ligature like "ff"/"fi" rendered as its own glyph
            // run, e.g. "Cuffs" arriving as three items "Cu"/"ff"/"s".
            // Unconditionally inserting a space between every item (as this
            // used to do) mangled words like that into "Cu ff s" in the
            // LLM's own input text. Only insert a space when the gap is
            // wide enough to be a real visual space, scaled to this item's
            // own font size so it holds across differently-sized text.
            const x = item.transform?.[4];
            const fontSize = Math.abs(item.transform?.[3]) || 10;
            const gap = (typeof x === "number" && typeof prevEnd === "number" && prevY === y) ? x - prevEnd : Infinity;
            if (pageText.length > 0 && gap > fontSize * 0.15) pageText += " ";

            const offset = pageStartOffset + pageText.length;
            pageText += str;
            pageItemInfos.push({ text: str, offset });

            if (typeof x === "number" && typeof item.width === "number") {
                prevEnd = x + item.width;
                prevY = y;
            } else {
                prevEnd = null;
                prevY = null;
            }
        });

        pageText += " ";
        pageTextInfoArrays.push(pageItemInfos);
        patternText += pageText;
    }

    return { patternText, pageTextInfoArrays, pdf };
}

// One row per number that extractStampDiagnostics would stamp — mirrors the
// match/position data extractAndStamp computes internally, for inspection
// without writing to a PDF.
export interface StampDiagnostic {
    page: number;
    text: string;
    originalNumber: string;
    rescaledNumber: number;
    sectionName: string;
    type: string;
    fontSize: number;
    widthRatio: number;
    stampedWidth: number;
    pdfLibY: number;
    finalX: number;
    pageAutoScale: number;
    stampDx: number;
    offset: number;
}

// The core pipeline: read the pattern's text + per-glyph positions (pdfjs),
// ask Claude to identify the gauge and per-section stitch/row counts, rescale
// each count to the knitter's gauge, and draw the new numbers back onto the
// original PDF at the old numbers' positions (pdf-lib).
//
// Two PDF libraries are involved because neither does both jobs: pdfjs-dist
// is used read-only for text extraction and layout (it exposes each text
// item's position and width as rendered), while pdf-lib is used to actually
// mutate and re-save the document. Their font metrics don't agree exactly,
// which is why candidate matches carry a computed widthRatio below — it
// reconciles pdfjs's rendered glyph widths with pdf-lib/Helvetica's metrics
// for the same string so the replacement text can be sized and centered
// correctly over the original.
export async function extractAndStamp(pdfBuffer: Buffer, knitterGaugeSts: number, knitterGaugeRow: number, stampDx: number = 0, preferredSize: string = "3") {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const pages = pdfDoc.getPages();
    if (!pages || pages.length === 0) throw new Error("page not found");

    const { patternText, pageTextInfoArrays, pdf } = await extractPatternText(pdfBuffer);
    if (patternText.trim().length < MIN_PATTERN_TEXT_LENGTH) {
        throw new InsufficientPatternTextError("Couldn't find any readable text in this PDF — it may be a scanned image with no selectable text, which this tool can't currently read. Try a PDF with real (selectable) text.");
    }

    const patternResults = await prompting(patternText, preferredSize);
    if (!patternResults || !patternResults.sections || !Array.isArray(patternResults.sections.sections)) {
        throw new Error("Invalid parser output: missing sections");
    }

    // Locate each section's own grounding sentence (source_quote) in the
    // flattened text and derive a [start, end) character range for it (a
    // section runs until the next section's own anchor starts, or end of
    // document for the last one). Anchored on source_quote rather than the
    // bare heading name: many patterns reuse an identical heading across
    // symmetric pieces (e.g. "RIBBING" or "BODY" under both a back panel and
    // a front panel, each with different counts) — anchoring on name alone
    // made every section sharing that name collapse onto whichever
    // occurrence of the name came first in the text, since a plain
    // patternText.indexOf(name) can't tell those repeats apart. Falls back
    // to name if a quote is missing or doesn't literally appear (e.g. the
    // model paraphrased it slightly).
    //
    // Search runs with a monotonically-advancing cursor rather than an
    // independent indexOf per section: sections are produced in the same
    // left-to-right order they occur in the pattern, so searching each one
    // forward from where the previous section's match ended correctly picks
    // out successive occurrences. This matters even beyond repeated
    // headings — some patterns have two panels (e.g. a left and right front
    // panel on a cardigan) that are truly identical in wording and numbers,
    // so even a distinct-but-repeated source_quote would otherwise collide
    // on the same first match for both. If a section's anchor can't be
    // found ahead of the cursor at all (out-of-order model output), fall
    // back to searching the whole text so one bad match doesn't cascade.
    // Ranges are tracked by each section's original array index (not by
    // name) so a later section with the same name as an earlier one still
    // gets matched to its own distinct range.
    let searchCursor = 0;
    const sectionBoundaries = patternResults.sections.sections.map((section: any, index: number) => {
        const anchor = section.source_quote && patternText.includes(section.source_quote) ? section.source_quote : section.name;
        let start = patternText.indexOf(anchor, searchCursor);
        if (start === -1) start = patternText.indexOf(anchor);
        if (start !== -1) searchCursor = start + anchor.length;
        return { index, start };
    });
    const sortedBoundaries = [...sectionBoundaries].sort((a: any, b: any) => a.start - b.start);
    const rangeByIndex = new Map<number, { start: number; end: number }>();
    sortedBoundaries.forEach((section: any, i: number) => {
        const nextSection = sortedBoundaries[i + 1];
        const end = (nextSection !== undefined) ? nextSection.start : patternText.length;
        rangeByIndex.set(section.index, { start: section.start, end });
    });

    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
        const page = await pdf.getPage(pageIndex);
        const currentPage = pages[pageIndex - 1];
        if (!currentPage) continue;
        const textContent = await page.getTextContent();

        const stsCnt = patternResults.stitches_per_4in;
        const rowCnt = patternResults.rows_per_4in;
        if (stsCnt === 0 && rowCnt === 0) continue;

        const gaugeInfoSts = patternResults.sections.sections.map((s: any, index: number) => ({
            ptrnCnt: Number(stsCnt || 0),
            knitterCnt: Number(knitterGaugeSts || 0),
            numStsPtrn: Number(s.stitch_count ?? 0),
            repeatMultiple: Number(s.repeat_multiple ?? 1) || 1,
            sectionName: s.name ?? "",
            sectionIndex: index,
            type: "stitches"
        }));

        const gaugeInfoRows = patternResults.sections.sections.map((s: any, index: number) => ({
            ptrnCnt: Number(rowCnt || 0),
            knitterCnt: Number(knitterGaugeRow || 0),
            numStsPtrn: Number(s.row_count ?? 0),
            repeatMultiple: Number(s.row_repeat_multiple ?? 1) || 1,
            sectionName: s.name ?? "",
            sectionIndex: index,
            type: "rows"
        }));

        const gaugeInfoShaping = patternResults.sections.sections.flatMap((s: any, index: number) =>
            buildShapingTargets(s, index, Number(stsCnt || 0), Number(knitterGaugeSts || 0), Number(rowCnt || 0), Number(knitterGaugeRow || 0))
        );

        const gaugeInfoArray = [...gaugeInfoSts, ...gaugeInfoRows, ...gaugeInfoShaping];

        // Drop targets that can't be searched for reliably: a repeat
        // multiple of 0 would divide-by-zero in the rounding step, and a
        // count of 0 or ±1 is too common/ambiguous a token to search for in
        // free-form pattern prose (a section whose real row count is "1"
        // would otherwise match nearly every "1" digit anywhere in its text).
        // This also naturally drops shaping targets for sections with no
        // periodic shaping (shaping_event_count/shaping_interval_rows are 0
        // there).
        const filteredGaugeInfo = gaugeInfoArray.filter((entry: any) =>
            entry.repeatMultiple !== 0 &&
            entry.numStsPtrn !== 0 &&
            Math.abs(entry.numStsPtrn) > 1 &&
            !Number.isNaN(entry.numStsPtrn) &&
            entry.sectionName
        );

        if (DEBUG) console.log({ filteredCount: filteredGaugeInfo.length, sample: filteredGaugeInfo.slice(0, 3) });

        const pageItemInfos = pageTextInfoArrays[pageIndex - 1] ?? [];

        // First pass over this page: find every text item that both contains
        // one of our target numbers as a whole number and falls within that
        // number's own section's character range, and record enough info to
        // draw a replacement for it. Drawing happens in a later pass once we
        // know the page-wide scale factor (see pageAutoScale).
        const candidates: Array<any> = [];
        const widthRatios: number[] = [];

        textContent.items.forEach((item: any, idx: number) => {
            const itemInfo = pageItemInfos[idx];
            if (!itemInfo) return;
            if (!("str" in item)) return;
            const str = item.str;

            for (const target of filteredGaugeInfo) {
                const matchingRange = rangeByIndex.get(target.sectionIndex);
                if (!matchingRange) continue;
                const substringIndex = findWholeNumberIndex(str, String(target.numStsPtrn));
                if (substringIndex === -1) continue;
                if (!(itemInfo.offset >= matchingRange.start && itemInfo.offset < matchingRange.end)) continue;

                // pdfjs's transform matrix gives font size (via the a/b
                // components) and glyph origin (e, f = x, y in PDF
                // coordinate space, which pdf-lib shares).
                const fontSize = Math.hypot(item.transform[0], item.transform[1]) || Math.abs(item.transform[3]) || 10;
                const prefix = str.substring(0, substringIndex);
                const originalNumberText = String(target.numStsPtrn);
                // How much wider/narrower pdf-lib+Helvetica renders this same
                // string than pdfjs reports it was actually rendered at in
                // the source PDF (different font metrics/embedded font) —
                // used below to scale our own measurements onto pdfjs's.
                const pdfLibItemWidth = font.widthOfTextAtSize(str, fontSize);
                const perItemWidthRatio = pdfLibItemWidth > 0 ? item.width / pdfLibItemWidth : 1;
                widthRatios.push(perItemWidthRatio);

                const pdfLibY = item.transform[5];
                // Shaping targets carry a precomputed value from
                // rescaleShaping() (it depends on the section's own rescaled
                // start/end stitch counts and row count, not a flat
                // ptrnCnt/knitterCnt ratio) rather than going through
                // rescaleCount() like every other target type.
                const stsRescaled = (target.type === "shaping_event_count" || target.type === "shaping_interval")
                    ? target.precomputedRescaled
                    : rescaleCount(target.ptrnCnt, target.knitterCnt, target.numStsPtrn, target.repeatMultiple, target.sectionName, target.type);
                const stampedWidthRaw = font.widthOfTextAtSize(String(stsRescaled), fontSize);

                candidates.push({
                    itemTransform: item.transform,
                    itemWidth: item.width,
                    str,
                    prefix,
                    substringIndex,
                    fontSize,
                    originalNumberText,
                    pdfLibY,
                    stsRescaled,
                    stampedWidthRaw,
                    pdfLibItemWidth
                });
            }
        });

        // A single scale factor for the whole page (median across every
        // candidate's per-item widthRatio) rather than each candidate using
        // its own — per-item ratios are noisy for short strings, so a page
        // median gives a much more stable width estimate for how wide the
        // replacement text will render.
        const pageAutoScale = widthRatios.length > 0 ? median(widthRatios) : 1;

        // Locate where the original number's center actually sits on the
        // page: split the item's true on-page width (item.width, as measured
        // by pdfjs) by the *font-metric* fraction of the string that falls
        // before and through the number, rather than a naive per-character
        // fraction. A per-character split assumes every glyph is the same
        // width, which badly misjudges position for bracket-heavy multi-size
        // lists like "(192) 204 (218) 252 (270)" — parentheses are much
        // narrower than digits, and the more sizes bracketed together, the
        // worse a uniform-width assumption gets. Using actual glyph widths
        // (pdf-lib's Helvetica metrics, a reasonable proxy for the embedded
        // font's relative glyph proportions even when its absolute scale
        // differs) keeps this accurate regardless of how dense the list is.
        for (const c of candidates) {
            const prefixWidthMetric = font.widthOfTextAtSize(c.prefix, c.fontSize);
            const numberWidthMetric = font.widthOfTextAtSize(c.originalNumberText, c.fontSize);
            const numberCenterFraction = c.pdfLibItemWidth > 0 ? (prefixWidthMetric + numberWidthMetric / 2) / c.pdfLibItemWidth : 0.5;
            c.originalNumberCenterX = c.itemTransform[4] + c.itemWidth * numberCenterFraction;
            c.stampedWidth = c.stampedWidthRaw * pageAutoScale;
            // The cover rectangle has to be at least as wide as whichever of
            // the old/new number is wider, or a narrower replacement (e.g.
            // "93" over "102") leaves a sliver of the original digit or
            // parenthesis peeking out from behind it.
            c.originalWidth = numberWidthMetric * pageAutoScale;
            c.coverWidth = Math.max(c.originalWidth, c.stampedWidth);
        }

        if (DEBUG) console.log('PAGE_AUTO', { page: pageIndex, pageAutoScale, candidates: candidates.length });

        // Second pass: paint over each original number with a white
        // rectangle and draw the rescaled number centered on it. `stampDx`
        // is an optional manual nudge on top of the automatic centering, for
        // cases where the auto estimate is still slightly off.
        for (const c of candidates) {
            const centerX = c.originalNumberCenterX + (stampDx || 0);
            const finalX = centerX - c.stampedWidth / 2;
            const fontSizeAdjusted = c.fontSize;
            const padding = Math.max(2, Math.round(fontSizeAdjusted * 0.15));
            if (DEBUG) {
                console.log('STAMP', { page: pageIndex, text: c.str, original: c.originalNumberText, rescaled: c.stsRescaled, pageAutoScale, finalX, fontSizeAdjusted });
            }
            currentPage.drawRectangle({ x: centerX - c.coverWidth / 2 - padding, y: c.pdfLibY - padding, width: c.coverWidth + padding * 2, height: fontSizeAdjusted + padding * 2, color: rgb(1, 1, 1) });
            currentPage.drawText(String(c.stsRescaled), { x: finalX, y: c.pdfLibY, size: fontSizeAdjusted, font, color: rgb(1, 0, 0) });
        }
    }

    const pdfBytes = await pdfDoc.save();
    return pdfBytes;
}

// Same matching, rescaling, and centering logic as extractAndStamp (kept in
// sync manually — see the comments there for how each step works), but
// collects the results into a StampDiagnostic[] instead of drawing on the
// PDF. Used by scripts/run_validation.mjs to inspect what would be stamped
// without producing an output file.
export async function extractStampDiagnostics(pdfBuffer: Buffer, knitterGaugeSts: number, knitterGaugeRow: number, stampDx: number = 0, preferredSize: string = "3") {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const pages = pdfDoc.getPages();
    if (!pages || pages.length === 0) throw new Error("page not found");

    const { patternText, pageTextInfoArrays, pdf } = await extractPatternText(pdfBuffer);
    if (patternText.trim().length < MIN_PATTERN_TEXT_LENGTH) {
        throw new InsufficientPatternTextError("Couldn't find any readable text in this PDF — it may be a scanned image with no selectable text, which this tool can't currently read. Try a PDF with real (selectable) text.");
    }

    const patternResults = await prompting(patternText, preferredSize);
    if (!patternResults || !patternResults.sections || !Array.isArray(patternResults.sections.sections)) {
        throw new Error("Invalid parser output: missing sections");
    }

    // See extractAndStamp for why this anchors on source_quote (with a
    // name-based fallback), searches with a monotonically-advancing cursor
    // rather than an independent indexOf per section, and tracks ranges by
    // original array index rather than by name — kept in sync with that
    // function manually.
    let searchCursor = 0;
    const sectionBoundaries = patternResults.sections.sections.map((section: any, index: number) => {
        const anchor = section.source_quote && patternText.includes(section.source_quote) ? section.source_quote : section.name;
        let start = patternText.indexOf(anchor, searchCursor);
        if (start === -1) start = patternText.indexOf(anchor);
        if (start !== -1) searchCursor = start + anchor.length;
        return { index, start };
    });
    const sortedBoundaries = [...sectionBoundaries].sort((a: any, b: any) => a.start - b.start);
    const rangeByIndex = new Map<number, { start: number; end: number }>();
    sortedBoundaries.forEach((section: any, i: number) => {
        const nextSection = sortedBoundaries[i + 1];
        const end = nextSection !== undefined ? nextSection.start : patternText.length;
        rangeByIndex.set(section.index, { start: section.start, end });
    });

    const diagnostics: StampDiagnostic[] = [];

    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
        const page = await pdf.getPage(pageIndex);
        const currentPage = pages[pageIndex - 1];
        if (!currentPage) continue;
        const textContent = await page.getTextContent();

        const stsCnt = patternResults.stitches_per_4in;
        const rowCnt = patternResults.rows_per_4in;
        if (stsCnt === 0 && rowCnt === 0) continue;

        const gaugeInfoSts = patternResults.sections.sections.map((s: any, index: number) => ({
            ptrnCnt: Number(stsCnt || 0),
            knitterCnt: Number(knitterGaugeSts || 0),
            numStsPtrn: Number(s.stitch_count ?? 0),
            repeatMultiple: Number(s.repeat_multiple ?? 1) || 1,
            sectionName: s.name ?? "",
            sectionIndex: index,
            type: "stitches"
        }));

        const gaugeInfoRows = patternResults.sections.sections.map((s: any, index: number) => ({
            ptrnCnt: Number(rowCnt || 0),
            knitterCnt: Number(knitterGaugeRow || 0),
            numStsPtrn: Number(s.row_count ?? 0),
            repeatMultiple: Number(s.row_repeat_multiple ?? 1) || 1,
            sectionName: s.name ?? "",
            sectionIndex: index,
            type: "rows"
        }));

        const gaugeInfoShaping = patternResults.sections.sections.flatMap((s: any, index: number) =>
            buildShapingTargets(s, index, Number(stsCnt || 0), Number(knitterGaugeSts || 0), Number(rowCnt || 0), Number(knitterGaugeRow || 0))
        );

        const gaugeInfoArray = [...gaugeInfoSts, ...gaugeInfoRows, ...gaugeInfoShaping];
        const filteredGaugeInfo = gaugeInfoArray.filter((entry: any) =>
            entry.repeatMultiple !== 0 &&
            entry.numStsPtrn !== 0 &&
            Math.abs(entry.numStsPtrn) > 1 &&
            !Number.isNaN(entry.numStsPtrn) &&
            entry.sectionName
        );

        const pageItemInfos = pageTextInfoArrays[pageIndex - 1] ?? [];
        const candidates: Array<any> = [];
        const widthRatios: number[] = [];

        textContent.items.forEach((item: any, idx: number) => {
            const itemInfo = pageItemInfos[idx];
            if (!itemInfo) return;
            if (!("str" in item)) return;
            const str = item.str;

            for (const target of filteredGaugeInfo) {
                const matchingRange = rangeByIndex.get(target.sectionIndex);
                if (!matchingRange) continue;
                const substringIndex = findWholeNumberIndex(str, String(target.numStsPtrn));
                if (substringIndex === -1) continue;
                if (!(itemInfo.offset >= matchingRange.start && itemInfo.offset < matchingRange.end)) continue;

                const fontSize = Math.hypot(item.transform[0], item.transform[1]) || Math.abs(item.transform[3]) || 10;
                const prefix = str.substring(0, substringIndex);
                const originalNumberText = String(target.numStsPtrn);
                const pdfLibItemWidth = font.widthOfTextAtSize(str, fontSize);
                const widthRatio = pdfLibItemWidth > 0 ? item.width / pdfLibItemWidth : 1;
                widthRatios.push(widthRatio);

                const pdfLibY = item.transform[5];
                const stsRescaled = (target.type === "shaping_event_count" || target.type === "shaping_interval")
                    ? target.precomputedRescaled
                    : rescaleCount(target.ptrnCnt, target.knitterCnt, target.numStsPtrn, target.repeatMultiple, target.sectionName, target.type);
                const stampedWidthRaw = font.widthOfTextAtSize(String(stsRescaled), fontSize);

                candidates.push({
                    pageIndex,
                    text: str,
                    prefix,
                    substringIndex,
                    originalNumberText,
                    fontSize,
                    widthRatio,
                    pdfLibItemWidth,
                    pdfLibY,
                    stsRescaled,
                    stampedWidthRaw,
                    itemTransform: item.transform,
                    itemWidth: item.width,
                    matchingRangeStart: matchingRange.start,
                    offset: itemInfo.offset,
                    target
                });
            }
        });

        const pageAutoScale = widthRatios.length > 0 ? median(widthRatios) : 1;

        // See extractAndStamp for why this uses a font-metric fraction of
        // the item's true on-page width rather than a per-character split.
        for (const c of candidates) {
            const prefixWidthMetric = font.widthOfTextAtSize(c.prefix, c.fontSize);
            const numberWidthMetric = font.widthOfTextAtSize(c.originalNumberText, c.fontSize);
            const numberCenterFraction = c.pdfLibItemWidth > 0 ? (prefixWidthMetric + numberWidthMetric / 2) / c.pdfLibItemWidth : 0.5;
            c.originalNumberCenterX = c.itemTransform[4] + c.itemWidth * numberCenterFraction;
            c.stampedWidth = c.stampedWidthRaw * pageAutoScale;
        }

        for (const c of candidates) {
            const centerX = c.originalNumberCenterX + stampDx;
            const finalX = centerX - c.stampedWidth / 2;
            diagnostics.push({
                page: pageIndex,
                text: c.text,
                originalNumber: c.originalNumberText,
                rescaledNumber: c.stsRescaled,
                sectionName: c.target.sectionName,
                type: c.target.type,
                fontSize: c.fontSize,
                widthRatio: c.widthRatio,
                stampedWidth: c.stampedWidth,
                pdfLibY: c.pdfLibY,
                finalX,
                pageAutoScale,
                stampDx,
                offset: c.offset
            });
        }
    }

    return diagnostics;
}
