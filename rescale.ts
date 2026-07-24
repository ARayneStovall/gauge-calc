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