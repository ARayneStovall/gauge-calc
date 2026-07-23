export function rescaleCount (ptrnCnt : number, knitterCnt : number, numStsPtrn : number, repeatMultiple : number, sectionName: string, type: string) {
    var ptrnStsPerIn = ptrnCnt / 4;
    var knitterStsPerIn = knitterCnt / 4;
    var ptrnIn = numStsPtrn / ptrnStsPerIn;
    var numStsToKnitUnrounded = knitterStsPerIn * ptrnIn;

    return roundToNearestMultiple(numStsToKnitUnrounded, repeatMultiple, sectionName, type);
}

export function roundToNearestMultiple (numStsToKnitUnrounded : number, repeatMultiple : number, sectionName: string, type: string){
    var numStsToKnitRounded = Math.ceil(numStsToKnitUnrounded);
    var remainderSts = numStsToKnitRounded % repeatMultiple;
    var numStsToKnit = numStsToKnitRounded;

    while (remainderSts != 0){
        numStsToKnit += 1;
        remainderSts = numStsToKnit % repeatMultiple;
    }

    console.log(sectionName, numStsToKnit, type);
    return numStsToKnit;
}