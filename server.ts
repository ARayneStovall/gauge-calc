import express from "express";
import { extractAndStamp } from "./extractStampText.js";
import cors from "cors";
import multer from "multer";
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
// FRONTEND_ORIGIN restricts CORS to the production frontend URL, plus any
// Vercel preview deployment for this same project (each branch/PR gets its
// own unique *.vercel.app subdomain, so a single fixed origin can't cover
// them). Left unset, allows any origin — fine for local development.
const frontendOrigin = process.env.FRONTEND_ORIGIN;
const previewOriginPattern = /^https:\/\/gaugecalculator-[a-z0-9-]+\.vercel\.app$/;
app.use(cors(frontendOrigin ? {
    origin(origin, callback) {
        if (!origin || origin === frontendOrigin || previewOriginPattern.test(origin)) {
            return callback(null, true);
        }
        callback(new Error("Not allowed by CORS"));
    }
} : undefined));

app.get("/", function (req, res) {
    res.send("hello");
});

// Hosts like Render assign the port via PORT; 3001 remains the local default.
const port = Number(process.env.PORT) || 3001;
app.listen(port, function () {
    console.log(`Server running on port ${port}`);
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

