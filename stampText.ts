import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";

const existingPdfBytes = fs.readFileSync("/Users/rayne/Desktop/MiuTopPattern.pdf");
const pdfDoc = await PDFDocument.load(existingPdfBytes);

const pages = pdfDoc.getPages();
const firstPage = pages[0];

const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

if (firstPage === undefined) {
    throw new Error ("page not found");
}

firstPage.drawText("TEST", { x: 335.1922, y: 91, size: 8, font, color: rgb(1, 0, 0) });

const pdfBytes = await pdfDoc.save();
fs.writeFileSync("stamped-output.pdf", pdfBytes);