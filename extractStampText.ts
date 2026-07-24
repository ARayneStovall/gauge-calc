import { getDocument, PDFDataRangeTransport } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createRequire } from "node:module";
import path from "path";
import fs from "fs";
import { rescaleCount } from "./rescale.js";
import { prompting } from "./promptingClaude.js";
const DEBUG = process.env.DEBUG === "1";

export async function extractAndStamp(pdfBuffer: Buffer, knitterGaugeSts: number, knitterGaugeRow: number) {


    const require = createRequire(import.meta.url);
    const pdfjsDistPath = require.resolve("pdfjs-dist");
    const fontDataPath = path.join(path.resolve(pdfjsDistPath, "../../standard_fonts"), "/");
    const cmapPath = path.join(path.resolve(pdfjsDistPath, "../../cmaps"), "/");

    const uint8Array = new Uint8Array(pdfBuffer);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const pages = pdfDoc.getPages();
    var currentPage = pages[0];

    if (currentPage === undefined) {
        throw new Error("page not found");
    }

    var patternText = "";

    const pdf = await getDocument({ data: uint8Array, standardFontDataUrl: fontDataPath, cMapUrl: cmapPath }).promise;

    const pageTextInfoArrays: Array<Array<{ text: string, offset: number }>> = [];

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        currentPage = pages[i - 1];
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

    var patternResults = await prompting(patternText);

    if (!patternResults || !patternResults.sections || !Array.isArray(patternResults.sections.sections)) {
        throw new Error("Invalid parser output: missing sections");
    }

    if (patternResults === null) {
        throw new Error("No pattern found.")
    }
    var sectionBoundaries = patternResults.sections.sections.map(function (section) {
        return { name: section.name, start: patternText.indexOf(section.name) };
    });

    sectionBoundaries.sort(function (a, b) { return a.start - b.start; })

    var sectionRanges = sectionBoundaries.map(function (section, index, array) {
        var nextSection = array[index + 1];
        var end = (nextSection !== undefined) ? nextSection.start : patternText.length;
        return { name: section.name, start: section.start, end: end };
    });

    for (let i: number = 1; i <= pdf.numPages; i++) {
        var page = await pdf.getPage(i);
        currentPage = pages[i - 1];
        var textContent = await page.getTextContent();

        var stsCnt = patternResults.stitches_per_4in;
        var rowCnt = patternResults.rows_per_4in;

        if (stsCnt !== 0 || rowCnt !== 0) {


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

            const filteredGaugeInfo = gaugeInfoArray.filter(entry =>
                entry.repeatMultiple !== 0 &&
                entry.numStsPtrn !== 0 &&
                !Number.isNaN(entry.numStsPtrn) &&
                entry.sectionName
            );

            if (DEBUG) {
                console.log({
                    filteredCount: filteredGaugeInfo.length,
                    sample: filteredGaugeInfo.slice(0, 3)
                });
            }


            textContent.items.forEach((item, b) => {
                const pageItemInfos = pageTextInfoArrays[i - 1] ?? [];;
                const itemInfo = pageItemInfos[b];
                if (!itemInfo) {
                    if (DEBUG) console.warn("skip: no itemInfo for itemIndex", b);
                    return;
                }
                if ("str" in item) {
                    var str = item.str;
                    for (let j: number = 0; j < filteredGaugeInfo.length; j++) {
                        var target = filteredGaugeInfo[j]
                        if (target === undefined) {
                            if (DEBUG) console.warn("skip: no target at index", j);
                            continue;
                        }
                        var sectionName = target.sectionName;

                        const matchingRange = sectionRanges.find(r => r.name === sectionName);
                        if (!matchingRange) {
                            if (DEBUG) console.warn("skip: no matchingRange for", target.sectionName);
                            continue;
                        }

                        if (pageItemInfos === undefined) {
                            if (DEBUG) console.warn("no pageItemInfos for page", i);
                            continue;
                        }

                        if (str.includes(String(target.numStsPtrn)) &&
                            itemInfo.offset >= matchingRange.start &&
                            itemInfo.offset < matchingRange.end) {
                            if (currentPage === undefined) {
                                throw new Error("page not found");
                            }
                            if (DEBUG) {
                                console.log(item.str, item.transform);
                            }

                            var substringXIndex = item.str.indexOf(String(target.numStsPtrn));
                            const fontSize = Math.hypot(item.transform[0], item.transform[1]) || Math.abs(item.transform[3]) || 10;
                            const prefix = item.str.substring(0, substringXIndex);
                            const originalNumberText = String(target.numStsPtrn);
                            const pdfLibItemWidth = font.widthOfTextAtSize(item.str, fontSize);
                            const widthRatio = pdfLibItemWidth > 0 ? item.width / pdfLibItemWidth : 1;
                            const substringXPosition = item.transform[4] + font.widthOfTextAtSize(prefix, fontSize) * widthRatio;
                            const originalNumberWidth = font.widthOfTextAtSize(originalNumberText, fontSize) * widthRatio;
                            const pdfLibY = item.transform[5];
                            const padding = Math.max(2, Math.round(fontSize * 0.15));
                            var stsRescaled = rescaleCount(target.ptrnCnt, target.knitterCnt, target.numStsPtrn, target.repeatMultiple, target.sectionName, target.type);
                            const stampedWidth = font.widthOfTextAtSize(String(stsRescaled), fontSize) * widthRatio;
                            const centeredXPosition = substringXPosition + (originalNumberWidth - stampedWidth) / 2;
                            if (DEBUG) {
                                console.log('STAMP', {
                                    page: i,
                                    text: item.str,
                                    original: target.numStsPtrn,
                                    rescaled: stsRescaled,
                                    section: target.sectionName,
                                    repeatMultiple: target.repeatMultiple,
                                    type: target.type,
                                    widthRatio
                                });
                            }
                            currentPage.drawRectangle({ x: centeredXPosition - padding, y: pdfLibY - padding, width: stampedWidth + padding * 2, height: fontSize + padding * 2, color: rgb(1, 1, 1) });
                            currentPage.drawText(String(stsRescaled), { x: centeredXPosition, y: pdfLibY, size: fontSize, font, color: rgb(1, 0, 0) });
                        }
                    }
                }
            })
        }
    }

    const pdfBytes = await pdfDoc.save();
    //fs.writeFileSync("stamped-output.pdf", pdfBytes);
    return pdfBytes;
}