// The row_count rule (keepOnlyPrintedRowCounts in extractStampText.ts): keep
// a section's row_count only when that number is printed in the section's
// own text. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepOnlyPrintedRowCounts } from "./extractStampText.js";

function section(name: string, row_count: number, source_quote = "") {
    return { name, stitch_count: 40, repeat_multiple: 1, row_count, row_repeat_multiple: 1, shaping_phases: [], source_quote };
}

function rowCounts(text: string, sections: any[], preferredSize = "3"): number[] {
    const parsed = { stitches_per_4in: 20, rows_per_4in: 28, stitch_count: 40, sections: { sections } };
    return keepOnlyPrintedRowCounts(parsed, text, preferredSize).sections.sections.map((s: any) => s.row_count);
}

const SOCK = "Cuff: Cast on 40 sts. Work 1x1 rib for 24 rounds. " +
    "Heel Flap: Row 1: sl1, knit across. Row 2: sl1, purl across. Repeat rows 1-2 12 more times. " +
    "Foot: Knit until foot measures 7 in.";

test("keeps a row count printed in its own section", () => {
    assert.deepEqual(rowCounts(SOCK, [section("Cuff", 24)]), [24]);
});

test("zeroes a total worked out from repeats, since it isn't printed", () => {
    // 2 + 2 x 12 = 26 rows, but "26" appears nowhere in the text.
    assert.deepEqual(rowCounts(SOCK, [section("Cuff", 24), section("Heel Flap", 26), section("Foot", 0)]), [24, 0, 0]);
});

test("zeroes a number printed only in a different section", () => {
    // 24 is the cuff's count; it doesn't belong to the heel flap.
    assert.deepEqual(rowCounts(SOCK, [section("Cuff", 24), section("Heel Flap", 24), section("Foot", 0)]), [24, 0, 0]);
});

test("treats 1 like 0: too common a number to stamp", () => {
    assert.deepEqual(rowCounts(SOCK, [section("Cuff", 1)]), [0]);
});

test("needs a whole number, not digits inside another number", () => {
    const text = "Body: Work 124 rounds even.";
    assert.deepEqual(rowCounts(text, [section("Body", 24)]), [0]);
    assert.deepEqual(rowCounts(text, [section("Body", 124)]), [124]);
});

test("zeroes a number printed only in another size's slot", () => {
    const text = "Sizes 1 (2, 3, 4). Body: Work 20 (24, 28, 32) rounds.";
    assert.deepEqual(rowCounts(text, [section("Body", 28)], "3"), [28]);
    assert.deepEqual(rowCounts(text, [section("Body", 24)], "3"), [0]);
});

test("is safe to apply twice", () => {
    const parsed = { stitches_per_4in: 20, rows_per_4in: 28, stitch_count: 40, sections: { sections: [section("Cuff", 24), section("Heel Flap", 26)] } };
    const once = keepOnlyPrintedRowCounts(parsed, SOCK);
    assert.deepEqual(keepOnlyPrintedRowCounts(once, SOCK), once);
});
