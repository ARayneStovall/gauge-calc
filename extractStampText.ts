import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createRequire } from "node:module";
import path from "path";
import { rescaleCount } from "./rescale.js";
import { prompting } from "./promptingClaude.js";
const DEBUG = process.env.DEBUG === "1";

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
    const require = createRequire(import.meta.url);
    const pdfjsDistPath = require.resolve("pdfjs-dist");
    const fontDataPath = path.join(path.resolve(pdfjsDistPath, "../../standard_fonts"), "/");
    const cmapPath = path.join(path.resolve(pdfjsDistPath, "../../cmaps"), "/");

    const uint8Array = new Uint8Array(pdfBuffer);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const pages = pdfDoc.getPages();
    if (!pages || pages.length === 0) throw new Error("page not found");

    // Flatten every page's text into one string (patternText) for Claude to
    // read, while recording each text item's character offset into that
    // flattened string (pageTextInfoArrays). The offsets are what let the
    // matching pass below scope a number match to the correct section later,
    // even though sections and text items are tracked completely separately.
    let patternText = "";

    const pdf = await getDocument({ data: uint8Array, standardFontDataUrl: fontDataPath, cMapUrl: cmapPath }).promise;

    const pageTextInfoArrays: Array<Array<{ text: string, offset: number }>> = [];

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();

        let pageText = "";
        const pageItemInfos: Array<{ text: string, offset: number }> = [];
        const pageStartOffset = patternText.length;

        textContent.items.forEach((item) => {
            if ("str" in item) {
                const str = item.str;
                const offset = pageStartOffset + pageText.length;
                pageText += str + " ";
                pageItemInfos.push({ text: str, offset });
            }
        });

        pageTextInfoArrays.push(pageItemInfos);
        patternText += pageText;
    }

    const patternResults = await prompting(patternText, preferredSize);
    if (!patternResults || !patternResults.sections || !Array.isArray(patternResults.sections.sections)) {
        throw new Error("Invalid parser output: missing sections");
    }

    // Locate each section's heading in the flattened text and derive a
    // [start, end) character range for it (a section runs until the next
    // section's heading starts, or end of document for the last one). This
    // is how a stitch/row count that's reused across sections (e.g. the same
    // number in both the front and back panel) only gets matched — and
    // stamped — within the section it actually belongs to.
    const sectionBoundaries = patternResults.sections.sections.map((section: any) => ({ name: section.name, start: patternText.indexOf(section.name) }));
    sectionBoundaries.sort((a: any, b: any) => a.start - b.start);
    const sectionRanges = sectionBoundaries.map((section: any, index: number, array: any[]) => {
        const nextSection = array[index + 1];
        const end = (nextSection !== undefined) ? nextSection.start : patternText.length;
        return { name: section.name, start: section.start, end };
    });

    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
        const page = await pdf.getPage(pageIndex);
        const currentPage = pages[pageIndex - 1];
        if (!currentPage) continue;
        const textContent = await page.getTextContent();

        const stsCnt = patternResults.stitches_per_4in;
        const rowCnt = patternResults.rows_per_4in;
        if (stsCnt === 0 && rowCnt === 0) continue;

        const gaugeInfoSts = patternResults.sections.sections.map((s: any) => ({
            ptrnCnt: Number(stsCnt || 0),
            knitterCnt: Number(knitterGaugeSts || 0),
            numStsPtrn: Number(s.stitch_count ?? 0),
            repeatMultiple: Number(s.repeat_multiple ?? 1) || 1,
            sectionName: s.name ?? "",
            type: "stitches"
        }));

        const gaugeInfoRows = patternResults.sections.sections.map((s: any) => ({
            ptrnCnt: Number(rowCnt || 0),
            knitterCnt: Number(knitterGaugeRow || 0),
            numStsPtrn: Number(s.row_count ?? 0),
            repeatMultiple: Number(s.row_repeat_multiple ?? 1) || 1,
            sectionName: s.name ?? "",
            type: "rows"
        }));

        const gaugeInfoArray = [...gaugeInfoSts, ...gaugeInfoRows];

        // Drop targets that can't be searched for reliably: a repeat
        // multiple of 0 would divide-by-zero in the rounding step, and a
        // count of 0 or ±1 is too common/ambiguous a token to search for in
        // free-form pattern prose (a section whose real row count is "1"
        // would otherwise match nearly every "1" digit anywhere in its text).
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
                const sectionName = target.sectionName;
                const matchingRange = sectionRanges.find((r: any) => r.name === sectionName);
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
                const stsRescaled = rescaleCount(target.ptrnCnt, target.knitterCnt, target.numStsPtrn, target.repeatMultiple, target.sectionName, target.type);
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
    const require = createRequire(import.meta.url);
    const pdfjsDistPath = require.resolve("pdfjs-dist");
    const fontDataPath = path.join(path.resolve(pdfjsDistPath, "../../standard_fonts"), "/");
    const cmapPath = path.join(path.resolve(pdfjsDistPath, "../../cmaps"), "/");

    const uint8Array = new Uint8Array(pdfBuffer);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const pages = pdfDoc.getPages();
    if (!pages || pages.length === 0) throw new Error("page not found");

    let patternText = "";
    const pdf = await getDocument({ data: uint8Array, standardFontDataUrl: fontDataPath, cMapUrl: cmapPath }).promise;
    const pageTextInfoArrays: Array<Array<{ text: string; offset: number }>> = [];

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();

        let pageText = "";
        const pageItemInfos: Array<{ text: string; offset: number }> = [];
        const pageStartOffset = patternText.length;

        textContent.items.forEach((item: any) => {
            if ("str" in item) {
                const str = item.str;
                const offset = pageStartOffset + pageText.length;
                pageText += str + " ";
                pageItemInfos.push({ text: str, offset });
            }
        });

        pageTextInfoArrays.push(pageItemInfos);
        patternText += pageText;
    }

    const patternResults = await prompting(patternText, preferredSize);
    if (!patternResults || !patternResults.sections || !Array.isArray(patternResults.sections.sections)) {
        throw new Error("Invalid parser output: missing sections");
    }

    const sectionBoundaries = patternResults.sections.sections.map((section: any) => ({ name: section.name, start: patternText.indexOf(section.name) }));
    sectionBoundaries.sort((a: any, b: any) => a.start - b.start);
    const sectionRanges = sectionBoundaries.map((section: any, index: number, array: any[]) => {
        const nextSection = array[index + 1];
        const end = nextSection !== undefined ? nextSection.start : patternText.length;
        return { name: section.name, start: section.start, end };
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

        const gaugeInfoSts = patternResults.sections.sections.map((s: any) => ({
            ptrnCnt: Number(stsCnt || 0),
            knitterCnt: Number(knitterGaugeSts || 0),
            numStsPtrn: Number(s.stitch_count ?? 0),
            repeatMultiple: Number(s.repeat_multiple ?? 1) || 1,
            sectionName: s.name ?? "",
            type: "stitches"
        }));

        const gaugeInfoRows = patternResults.sections.sections.map((s: any) => ({
            ptrnCnt: Number(rowCnt || 0),
            knitterCnt: Number(knitterGaugeRow || 0),
            numStsPtrn: Number(s.row_count ?? 0),
            repeatMultiple: Number(s.row_repeat_multiple ?? 1) || 1,
            sectionName: s.name ?? "",
            type: "rows"
        }));

        const gaugeInfoArray = [...gaugeInfoSts, ...gaugeInfoRows];
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
                const sectionName = target.sectionName;
                const matchingRange = sectionRanges.find((r: any) => r.name === sectionName);
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
                const stsRescaled = rescaleCount(target.ptrnCnt, target.knitterCnt, target.numStsPtrn, target.repeatMultiple, target.sectionName, target.type);
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
