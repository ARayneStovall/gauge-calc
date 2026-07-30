// Converts a section's stitch/row count from the pattern's stated gauge to
// the knitter's actual gauge, preserving the physical size the section knits
// up to. ptrnCnt/knitterCnt are stitches (or rows) per 4in; numStsPtrn is the
// count as printed in the pattern for this section.
export function rescaleCount(ptrnCnt: number, knitterCnt: number, numStsPtrn: number, repeatMultiple: number, sectionName: string, type: string) {
    var ptrnStsPerIn = ptrnCnt / 4;
    var knitterStsPerIn = knitterCnt / 4;
    var ptrnIn = numStsPtrn / ptrnStsPerIn;
    var numStsToKnitUnrounded = knitterStsPerIn * ptrnIn;

    return roundToNearestMultiple(numStsToKnitUnrounded, repeatMultiple, sectionName, type);
}

// Gauge conversion rarely lands on a whole number, and a whole number isn't
// even enough on its own — most stitch patterns (cables, lace, ribbing...)
// only work in multiples of some repeat, so the rescaled count is rounded up
// to the nearest value that's both a whole number and a multiple of
// repeatMultiple (never down, so the section doesn't end up smaller than the
// gauge conversion called for).
export function roundToNearestMultiple(numStsToKnitUnrounded: number, repeatMultiple: number, sectionName: string, type: string) {
    var numStsToKnitRounded = Math.ceil(numStsToKnitUnrounded);
    var remainderSts = numStsToKnitRounded % repeatMultiple;
    var numStsToKnit = numStsToKnitRounded;

    while (remainderSts != 0) {
        numStsToKnit += 1;
        remainderSts = numStsToKnit % repeatMultiple;
    }

    if (process.env.DEBUG === "1") {
        console.log(sectionName, numStsToKnit, type);
    }
    return numStsToKnit;
}

// Recomputes a section's periodic shaping cadence (how many times a
// decrease/increase round is worked, and how many rows/rounds apart each one
// falls) to match its own already-rescaled endpoint stitch counts and row
// count — rather than just rescaling the section's flat totals and leaving
// the shaping instructions printed in the pattern text disconnected from
// them. Callers pass in values that have already been through
// rescaleCount(): newStartStitches (from rescaling shaping_start_stitch_count
// with the section's own repeat_multiple), newEndStitches (the section's own
// rescaled stitch_count), and newTotalRows (the section's own rescaled
// row_count). stitchesPerEvent is never rescaled — it's a fixed technique
// constant (e.g. a k2tog+ssk pair always removes exactly 2 sts) independent
// of gauge.
//
// Because newStartStitches/newEndStitches/newTotalRows were each already
// independently rounded to their own repeat_multiple, eventCount *
// stitchesPerEvent won't always land exactly on the total stitch change —
// that's an accepted approximation, the same rounding trade-off the rest of
// this file already makes, not a new source of error.
export function rescaleShaping(newStartStitches: number, newEndStitches: number, stitchesPerEvent: number, newTotalRows: number): { eventCount: number; intervalRows: number } {
    if (stitchesPerEvent === 0) return { eventCount: 0, intervalRows: 0 };

    const totalChange = Math.abs(newStartStitches - newEndStitches);
    // Extraction noise (rescaled start ≈ rescaled end) shouldn't be read as
    // "one shaping event" — treat it the same as no shaping at all.
    if (totalChange === 0) return { eventCount: 0, intervalRows: 0 };

    const eventCount = Math.max(1, Math.round(totalChange / stitchesPerEvent));
    // A row count of 0 means the section's total rows were never stated in
    // the pattern (measurement-driven length) — defaulting the interval to 1
    // ("every row") would be worse than leaving it unknown.
    const intervalRows = newTotalRows > 0 ? Math.max(1, Math.round(newTotalRows / eventCount)) : 0;

    return { eventCount, intervalRows };
}