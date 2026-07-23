import { getDocument, PDFDataRangeTransport } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createRequire } from "node:module";
import path from "path";
import fs from "fs";
import { rescaleCount } from "./rescale.js";
import { prompting } from "./promptingClaude.js";

export async function extractAndStamp(pdfBuffer: Buffer, knitterGauge: number) {
    
    
    const require = createRequire(import.meta.url);
    const pdfjsDistPath = require.resolve("pdfjs-dist");
    const fontDataPath = path.join(path.resolve(pdfjsDistPath, "../../standard_fonts"), "/");
    const cmapPath = path.join(path.resolve(pdfjsDistPath, "../../cmaps"), "/");

    const uint8Array = new Uint8Array(pdfBuffer);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const pages = pdfDoc.getPages();
    var currentPage = pages[1];

    if (currentPage === undefined) {
        throw new Error ("page not found");
    }

    var patternText = "";
    var patternTextInfoArray: {text: string, offset: number}[] = [];

    const pdf = await getDocument({ data: uint8Array, standardFontDataUrl: fontDataPath, cMapUrl: cmapPath }).promise;

    for (let i : number = 1; i <= pdf.numPages; i++) {
        var page = await pdf.getPage(i);
        currentPage = pages[i-1];
        var textContent = await page.getTextContent();

        var pageText = "";
        textContent.items.forEach((item) => {
            if ("str" in item) {
                patternTextInfoArray.push({text: item.str, offset: patternText.length + pageText.length});
                pageText += item.str;
            }
        })
        patternText += pageText;
    }

    var patternResults = await prompting(patternText);

    if (patternResults === null) {
            throw new Error ("No pattern found.")
        }
    var sectionBoundaries = patternResults.sections.sections.map(function (section) {
        return { name: section.name, start: patternText.indexOf(section.name) };
    });

    sectionBoundaries.sort(function(a, b) { return a.start - b.start; })

    var sectionRanges = sectionBoundaries.map(function (section, index, array) {
        var nextSection = array[index + 1];
        var end = (nextSection !== undefined) ? nextSection.start : patternText.length;
        return { name: section.name, start: section.start, end: end };
    });

    var itemCounter = 0;

    for (let i : number = 1; i <= pdf.numPages; i++) {
        var page = await pdf.getPage(i);
        currentPage = pages[i-1];
        var textContent = await page.getTextContent();
        
        var stsCnt = patternResults.stitches_per_4in;

        if (patternResults.stitches_per_4in != 0){
            var gaugeInfo = patternResults.sections.sections.map(function(sections){return {ptrnCnt: stsCnt, knitterCnt: knitterGauge, numStsPtrn: sections.stitch_count, repeatMultiple: sections.repeat_multiple, sectionName: sections.name, type: "stitches"}});

            textContent.items.forEach((item) => {
            var itemInfo = patternTextInfoArray[itemCounter];
            if ("str" in item) {
                var str = item.str;
                itemCounter ++;
                for (let i : number = 0; i < gaugeInfo.length; i++) {
                    var target = gaugeInfo[i]
                    if (target === undefined){
                        throw new Error ("No gauge info.")
                    }

                    var matchingRange = sectionRanges.find(function (range) {
                        if (target === undefined){
                            throw new Error ("No gauge info.")
                        }
                        return range.name === target.sectionName;
                    });

                    if (matchingRange === undefined){
                        throw new Error ("Matching range not found.")
                    }
                    if (itemInfo === undefined){
                        throw new Error ("Item info range not found.")
                    }

                    if (str.includes(String(target.numStsPtrn)) && itemInfo.offset >= matchingRange.start && itemInfo.offset < matchingRange.end){
                        if (currentPage === undefined) {
                            throw new Error ("page not found");
                        }
                        console.log(item.str, item.transform);
                        var substringXIndex = item.str.indexOf(String(target.numStsPtrn));
                        var fontWidth = font.widthOfTextAtSize(item.str.substring(0, substringXIndex), item.transform[0]);
                        var substringXPosition =  item.transform[4] + fontWidth;

                        var stsRescaled = rescaleCount(target.ptrnCnt, target.knitterCnt, target.numStsPtrn, target.repeatMultiple, target.sectionName, target.type)

                        var rectangleWidth = font.widthOfTextAtSize(String(stsRescaled), item.transform[0]);

                        console.log(substringXPosition);
                        currentPage.drawRectangle({x: substringXPosition-5, y: item.transform[5], width: rectangleWidth, height: item.transform[0], color: rgb(1,1,1)});
                        currentPage.drawText(String(stsRescaled), {x: substringXPosition-5, y: item.transform[5], size: item.transform[0], font,  color: rgb(1, 0, 0) });
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