import express from "express";
import { extractAndStamp } from "./extractStampText.js";
import cors from "cors";
import multer from "multer";
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());

app.get("/", function (req, res) {
    res.send("hello");
});

app.listen(3001, function () {
    console.log("Server running on port 3001");
});

// Accepts a multipart upload (pdf + knitter's gauge, and optionally a
// preferred size label / manual stamp offset) and returns the same PDF with
// gauge-adjusted numbers stamped over the originals. The uploaded file never
// touches disk — multer keeps it in memory and it's passed straight through
// to extractAndStamp.
app.post("/api/rescale", upload.single("pdf"), async function (req, res) {
    try {
        const knitterGaugeSts = Number(req.body.knitterGaugeSts);
        const knitterGaugeRow = Number(req.body.knitterGaugeRow);
        const stampDx = Number(req.body.stampDx) || 0;
        const preferredSize = req.body.preferredSize || "3";
        if (req.file === undefined) {
            throw new Error("no file found");
        }
        const pdfBytes = await extractAndStamp(req.file.buffer, knitterGaugeSts, knitterGaugeRow, stampDx, preferredSize);
        res.set("Content-Type", "application/pdf");
        res.send(pdfBytes);
    } catch (error) {
        res.status(500).send("Error processing pattern");
    }
});

