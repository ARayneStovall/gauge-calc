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

app.post("/api/rescale", upload.single("pdf"), async function (req, res) {
    try {
        var knitterGaugeSts = Number(req.body.knitterGaugeSts);
        var knitterGaugeRow = Number(req.body.knitterGaugeRow);
        if (req.file === undefined){
            throw new Error ("no file found");
        }
        var pdfBytes = await extractAndStamp(req.file.buffer, knitterGaugeSts, knitterGaugeRow);
        res.set("Content-Type", "application/pdf");
        res.send(pdfBytes);
    } catch (error) {
        res.status(500).send("Error processing pattern");
    }
});

