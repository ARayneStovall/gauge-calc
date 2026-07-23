import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const pdfjsDistPath = require.resolve("pdfjs-dist");
const fontDataPath = path.join(path.resolve(pdfjsDistPath, "../../standard_fonts"), "/");
const cmapPath = path.join(path.resolve(pdfjsDistPath, "../../cmaps"), "/");

const pdfBuffer = fs.readFileSync("/Users/rayne/Desktop/MiuTopPattern.pdf");
const uint8Array = new Uint8Array(pdfBuffer);

const pdf = await getDocument({ data: uint8Array, standardFontDataUrl: fontDataPath, cMapUrl: cmapPath }).promise;
for (let i : number = 1; i < pdf.numPages; i++) {
    var page = await pdf.getPage(i);
    const textContent = await page.getTextContent();

    textContent.items.forEach((item) => {
        if ("str" in item) {
            console.log(item.str, item.transform);
        }
    })
}
