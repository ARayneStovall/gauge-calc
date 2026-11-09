// Cases are taken from real sample-pattern text. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSizeListSlots, isAcceptableMatch, findAcceptableNumberIndex, type MatchContext } from "./matchRules.js";
import type { ResolvedSize } from "./resolveSize.js";

function sizes(position: number, totalSizes: number): ResolvedSize {
    return { position, totalSizes, labels: Array.from({ length: totalSizes }, (_, i) => String(i + 1)), matchedLabel: null };
}

function context(patternText: string, resolved: ResolvedSize | null): MatchContext {
    return { patternText, slots: findSizeListSlots(patternText), resolved };
}

// Slot of every number in `text`, as "value@slot/length", for lists only.
function slotsOf(text: string): string[] {
    return [...findSizeListSlots(text)].map(([offset, s]) => `${text.slice(offset).match(/^[\d.]+(?:st|nd|rd|th)?/)![0]}@${s.slot}/${s.length}`);
}

// Every offset where `value` is accepted.
function accepted(text: string, value: string, type: string, resolved: ResolvedSize | null): number[] {
    const ctx = context(text, resolved);
    const hits: number[] = [];
    for (let i = text.indexOf(value); i !== -1; i = text.indexOf(value, i + 1)) {
        if (isAcceptableMatch(ctx, i, value, type)) hits.push(i);
    }
    return hits;
}

test("size lists: common bracket layouts", () => {
    assert.deepEqual(slotsOf("Cast on 56 (64, 72) stitches."), ["56@1/3", "64@2/3", "72@3/3"]);
    assert.deepEqual(slotsOf("still have 38 (42) 48 (52) 58 (64) Sts"), ["38@1/6", "42@2/6", "48@3/6", "52@4/6", "58@5/6", "64@6/6"]);
    assert.deepEqual(slotsOf("another 16 (18, 20) (28, 30) times"), ["16@1/5", "18@2/5", "20@3/5", "28@4/5", "30@5/5"]);
    assert.deepEqual(slotsOf("total (192) 204 (218) sts"), ["192@1/3", "204@2/3", "218@3/3"]);
    assert.deepEqual(slotsOf("K19(22,25), YO"), ["19@1/3", "22@2/3", "25@3/3"]);
    assert.deepEqual(slotsOf("every 4th (4th, 6th) round"), ["4th@1/3", "4th@2/3", "6th@3/3"]);
});

test("size lists: prose before the list isn't part of it", () => {
    assert.deepEqual(slotsOf("Repeat Rounds 1 & 2, 6 (6, 7, 8) more times"), ["6@1/4", "6@2/4", "7@3/4", "8@4/4"]);
    assert.deepEqual(slotsOf("Repeat Rows 1-2 another 16 (18, 20) times"), ["16@1/3", "18@2/3", "20@3/3"]);
});

test("size lists: placeholders hold a slot", () => {
    assert.deepEqual(slotsOf("27 (-, -, 39, 37) sts inc'd"), ["27@1/5", "39@4/5", "37@5/5"]);
    assert.deepEqual(slotsOf("first X (9) X (11) 13 (X) Sts"), ["9@2/6", "11@4/6", "13@5/6"]);
    // A dash after the list is prose, not an empty slot.
    assert.deepEqual(slotsOf("Sizes 1 (2) 3 (4) – Only Row 1"), ["1@1/4", "2@2/4", "3@3/4", "4@4/4"]);
});

test("size lists: slash-separated", () => {
    assert.deepEqual(slotsOf("cast on 22 120/130/140/150/160 sts"), ["120@1/5", "130@2/5", "140@3/5", "150@4/5", "160@5/5"]);
    // Two numbers are a fraction, not a list.
    assert.deepEqual(slotsOf("about 1/2 inch"), []);
    assert.deepEqual(accepted("pick up 94/98/104/108/112 sts", "98", "stitches", sizes(2, 5)), [11]);
    assert.deepEqual(accepted("pick up 94/98/104/108/112 sts", "104", "stitches", sizes(2, 5)), []);
});

test("size lists: numbers without brackets aren't lists", () => {
    assert.deepEqual(slotsOf("Repeat rounds 1 & 2 until 12 sts remain. 22 sts x 31 rows = 10 cm"), []);
});

test("whole numbers only", () => {
    assert.deepEqual(accepted("11 and 1", "1", "stitches", null), [7]);
    assert.deepEqual(accepted("measures 8.5 cm, then 8 more", "8", "stitches", null), [22]);
    assert.deepEqual(accepted("k2tog, then knit 2", "2", "stitches", null), [17]);
    assert.deepEqual(accepted("watch?v=ff_U8l2F3Fg", "8", "stitches", null), []);
    // One letter neighbor is fine.
    assert.deepEqual(accepted("k39 (43, 47) sts", "39", "stitches", sizes(1, 3)), [1]);
});

test("a number split across text items is still read as a whole", () => {
    // "22" as one string in patternText; the matcher must not take its first "2".
    assert.deepEqual(accepted("working on the 22 (24, 26) sts", "2", "stitches", null), []);
});

test("only the knitter's slot in a full size list", () => {
    const text = "Cast on 56 (64, 72) stitches.";
    assert.deepEqual(accepted(text, "64", "stitches", sizes(1, 3)), []);
    assert.deepEqual(accepted(text, "64", "stitches", sizes(2, 3)), [12]);
    // The same value in several slots: only the knitter's own one counts.
    const repeated = "across the 29 (33, 33, 33, 37, 37) sts";
    assert.deepEqual(accepted(repeated, "33", "stitches", sizes(3, 6)), [19]);
});

test("lists shorter than the full size list are skipped", () => {
    assert.deepEqual(accepted("work 4 (4, 6, 8) rounds", "6", "rows", sizes(3, 19)), []);
});

test("without a resolved size, list slots aren't checked", () => {
    assert.deepEqual(accepted("Cast on 56 (64, 72) stitches.", "64", "stitches", null), [12]);
});

test("numbers outside lists are unaffected for stitches and rows", () => {
    assert.deepEqual(accepted("Work 12 rounds of 1x1 ribbing", "12", "rows", sizes(1, 3)), [5]);
});

test("shaping event counts need a repeat sentence", () => {
    assert.deepEqual(accepted("Repeat these two rounds 7 (8, 10) more times", "7", "shaping_event_count", sizes(1, 3)), [24]);
    assert.deepEqual(accepted("Repeat Rows 1-2 another 16 (18, 20) times", "16", "shaping_event_count", sizes(1, 3)), [24]);
    assert.deepEqual(accepted("worked a total of 16 (17, 18) increase rounds", "17", "shaping_event_count", sizes(2, 3)), [22]);
    assert.deepEqual(accepted("Work 5 times", "5", "shaping_event_count", null), [5]);
    // Same digits, not a repeat count.
    assert.deepEqual(accepted("BO 10 (11) 12 (14) Sts", "12", "shaping_event_count", sizes(3, 4)), []);
    assert.deepEqual(accepted("Rounds only until 8 stitches remain", "8", "shaping_event_count", null), []);
    assert.deepEqual(accepted("turn. Row 7: Make DS", "7", "shaping_event_count", null), []);
});

test("shaping intervals need 'every'", () => {
    assert.deepEqual(accepted("dec every 4th round", "4", "shaping_interval", null), [10]);
    assert.deepEqual(accepted("dec every 4 (4, 6) rounds", "4", "shaping_interval", sizes(1, 3)), [10]);
    assert.deepEqual(accepted("Round 2: Knit. Repeat Rows 1-2.", "2", "shaping_interval", null), []);
    assert.deepEqual(accepted("k1, k2tog, k1", "2", "shaping_interval", null), []);
});

test("findAcceptableNumberIndex returns the first acceptable occurrence in an item", () => {
    const text = "Intro. across the 29 (33, 33, 33, 37, 37) sts";
    const itemStart = 7;
    const item = text.slice(itemStart);
    const ctx = context(text, sizes(3, 6));
    // Slot 3 is the second "33", not the first.
    assert.equal(findAcceptableNumberIndex(item, itemStart, "33", "stitches", ctx), item.indexOf("33", item.indexOf("33") + 1));
    assert.equal(findAcceptableNumberIndex(item, -1, "33", "stitches", ctx), -1);
});
