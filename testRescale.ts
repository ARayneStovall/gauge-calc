import sampleData from "./samplePattern.json" with { type: "json" }
import { rescaleCount } from "./rescale.js";

var ptrnStsCnt = sampleData.pattern_gauge.stitches_per_4in;
var knitterStsCnt = sampleData.knitter_gauge.stitches_per_4in;

var ptrnRowCnt = sampleData.pattern_gauge.rows_per_4in;
var knittersRowCnt = sampleData.knitter_gauge.rows_per_4in;


for (let i : number = 0; i < sampleData.sections.length; i++) {
    const section = sampleData.sections[i]
    if (section === undefined) {
        throw new Error("Section is Undefined.");
    }
    var numStsPtrn = section.stitch_count;
    var stitchRepeatMultiple = section.repeat_multiple;
    var ptrnNumRows = section.row_count;
    var rowRepeatMultiple = section.row_repeat_multiple;
    var sectionName = section.name;
    var stitchesRescaled = rescaleCount(ptrnStsCnt, knitterStsCnt, numStsPtrn, stitchRepeatMultiple, sectionName, "stitches");
    var rowsRescaled = rescaleCount(ptrnRowCnt, knittersRowCnt, ptrnNumRows, rowRepeatMultiple, sectionName, "rows");

    stitchesRescaled;
    rowsRescaled;
}