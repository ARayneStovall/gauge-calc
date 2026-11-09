// Decides whether one occurrence of a target number in the pattern text is
// really that target, or just the same digits in a different role. Every
// check works on absolute offsets into the flattened patternText rather than
// on a single pdfjs text item, since pdfjs sometimes splits one number
// across two items ("22" arriving as "2" + "2") and an item on its own can't
// show what's next to it.
//
// Measured against stamps from a full test:patterns run before these rules
// existed: 27% of stamps landed on another size's number in a size list
// (rows were worst, at 71 of 79), and none of the 143 shaping-interval stamps
// landed on an actual interval.

import type { ResolvedSize } from "./resolveSize.js";

export interface SizeListSlot {
    // 1-indexed position of this number within its size list.
    slot: number;
    // How many positions the list has, counting "-"/"X" placeholders.
    length: number;
    listStart: number;
    listEnd: number;
}

export interface MatchContext {
    patternText: string;
    slots: Map<number, SizeListSlot>;
    resolved: ResolvedSize | null;
}

// A number, a decimal, or an ordinal ("4th" in "every 4th (4th, 6th) round").
const NUMBER_TOKEN = /\d+(?:\.\d+)?(?:st|nd|rd|th)?/y;
// Placeholders some patterns use for sizes a value doesn't apply to:
// "27 (-, -, 39, 37)" or "X (9) X (11) 13 (X)". They hold a position, so
// they count toward the list's length and alignment.
const PLACEHOLDER_TOKEN = /(?:-|–|X)(?![\w-])/y;
const SEPARATOR = /[\s,()[\]]*/y;

function readToken(text: string, at: number): { text: string; isNumber: boolean } | null {
    NUMBER_TOKEN.lastIndex = at;
    const number = NUMBER_TOKEN.exec(text);
    if (number) return { text: number[0], isNumber: true };
    PLACEHOLDER_TOKEN.lastIndex = at;
    const placeholder = PLACEHOLDER_TOKEN.exec(text);
    return placeholder ? { text: placeholder[0], isNumber: false } : null;
}

function precededByOpenBracket(text: string, at: number): boolean {
    return /[([]\s*$/.test(text.slice(Math.max(0, at - 3), at));
}

// Finds every bracketed size list ("56 (64, 72)", "38 (42) 48 (52)",
// "(192) 204 (218)", "16 (18, 20) (28, 30)") and records each number's slot.
// A run of numbers only counts as a size list if a bracket joins its first
// number to the rest, or the run opens with a bracket. That keeps prose
// like "Repeat Rounds 1 & 2, 6 (6, 7, 8)" from pulling the "2" into the
// list and shifting every slot after it by one.
export function findSizeListSlots(text: string): Map<number, SizeListSlot> {
    const slots = new Map<number, SizeListSlot>();
    const startRegex = /(?<![0-9.])\d/g;
    let start: RegExpExecArray | null;
    while ((start = startRegex.exec(text)) !== null) {
        const tokens: Array<{ start: number; text: string; isNumber: boolean }> = [];
        const separators: string[] = [];
        let at = start.index;
        while (true) {
            const token = readToken(text, at);
            if (!token) break;
            tokens.push({ start: at, ...token });
            at += token.text.length;
            SEPARATOR.lastIndex = at;
            const separator = SEPARATOR.exec(text)![0];
            const next = separator ? readToken(text, at + separator.length) : null;
            if (!next) break;
            separators.push(separator);
            at += separator.length;
        }

        // A trailing placeholder only belongs to the list when a bracket
        // closes it ("(-)"); otherwise it's a dash in the prose, like the
        // one in "7 (8) – Only".
        while (tokens.length > 1 && !tokens[tokens.length - 1]!.isNumber) {
            const last = tokens[tokens.length - 1]!;
            if (/^\s*[)\]]/.test(text.slice(last.start + last.text.length))) break;
            tokens.pop();
            separators.pop();
        }
        while (tokens.length > 1 && !/[([]/.test(separators[0]!) && !precededByOpenBracket(text, tokens[0]!.start)) {
            tokens.shift();
            separators.shift();
        }
        // Lists can open with a placeholder ("X (9) X (11) 13 (X)"), which the
        // digit-based scan above starts after. Take it in only when a bracket
        // joins it to the list, so a dash in the prose before a list
        // ("measurements – 5 (6, 7)") doesn't shift every slot by one.
        let leading: RegExpExecArray | null;
        while ((leading = /(?:^|[\s,([])(-|–|X)([\s,()[\]]*[([][\s,()[\]]*)$/.exec(text.slice(Math.max(0, tokens[0]!.start - 12), tokens[0]!.start))) !== null) {
            const placeholderStart = tokens[0]!.start - leading[2]!.length - leading[1]!.length;
            tokens.unshift({ start: placeholderStart, text: leading[1]!, isNumber: false });
            separators.unshift(leading[2]!);
        }

        const lastToken = tokens[tokens.length - 1]!;
        const listEnd = lastToken.start + lastToken.text.length;
        const isSizeList = tokens.length >= 2 && (separators.some(s => /[([]/.test(s)) || precededByOpenBracket(text, tokens[0]!.start));
        if (isSizeList) {
            tokens.forEach((token, i) => {
                if (token.isNumber) slots.set(token.start, { slot: i + 1, length: tokens.length, listStart: tokens[0]!.start, listEnd });
            });
        }
        startRegex.lastIndex = Math.max(listEnd, start.index + 1);
    }

    // Some patterns separate sizes with slashes instead ("cast on
    // 120/130/140/150/160 sts"). Three or more numbers are required, since
    // two is usually a fraction ("1/2 inch").
    const slashListRegex = /(?<![\d./])\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?){2,}(?![\d/])/g;
    let slashList: RegExpExecArray | null;
    while ((slashList = slashListRegex.exec(text)) !== null) {
        const numbers = [...slashList[0].matchAll(/\d+(?:\.\d+)?/g)];
        const listStart = slashList.index;
        const listEnd = slashList.index + slashList[0].length;
        numbers.forEach((number, i) => {
            slots.set(listStart + number.index!, { slot: i + 1, length: numbers.length, listStart, listEnd });
        });
    }
    return slots;
}

// The digits at `offset` form a whole number: no digit or decimal part on
// either side ("1" isn't in "11", "8" isn't in "8.5"), and not buried inside
// a word ("2" in "k2tog", "8" in a URL like "ff_U8l2F"). One letter neighbor
// is fine: "K19(22,25)" is a real count, as is "4th".
function isWholeNumberAt(text: string, offset: number, numberText: string): boolean {
    if (text.slice(offset, offset + numberText.length) !== numberText) return false;
    const before = text.slice(Math.max(0, offset - 2), offset);
    const after = text.slice(offset + numberText.length, offset + numberText.length + 2);
    if (/\d$/.test(before) || /^\d/.test(after)) return false;
    if (/\d\.$/.test(before) || /^\.\d/.test(after)) return false;
    const letterBefore = /[A-Za-z_]$/.test(before);
    const letterAfter = /^[A-Za-z_]/.test(after) && !/^(?:st|nd|rd|th)\b/i.test(text.slice(offset + numberText.length, offset + numberText.length + 3));
    return !(letterBefore && letterAfter);
}

// Shaping counts aren't printed with a label of their own, so they only
// count where the sentence is clearly about repeats:
// - event count: "N more times", "another N (...) times", "a total of N"
// - interval: "every N" / "every Nth"
// Anywhere else, the same small number is far more likely a row label
// ("Row 2"), a stitch instruction ("k2tog") or a measurement.
function isInRepeatContext(text: string, start: number, end: number, type: string): boolean {
    const before = text.slice(Math.max(0, start - 25), start);
    const after = text.slice(end, end + 30);
    if (type === "shaping_event_count") {
        return /^[\s)\]]*(?:more\s+|additional\s+|further\s+|extra\s+)?times\b/i.test(after)
            || /\btotal\s+of\s*$/i.test(before);
    }
    if (type === "shaping_interval") {
        return /\bevery\s*$/i.test(before);
    }
    return true;
}

export function isAcceptableMatch(context: MatchContext, offset: number, numberText: string, type: string): boolean {
    const { patternText, slots, resolved } = context;
    if (offset < 0 || !isWholeNumberAt(patternText, offset, numberText)) return false;

    const slot = slots.get(offset);
    // Without a resolved size there's no way to tell which slot is the
    // knitter's, so list positions aren't checked at all (same as before
    // these rules). Lists that don't cover every size (subset clauses like
    // "Sizes 1, 3, 6, 7 only:") are skipped: their slots don't line up with
    // the size list, and a missed stamp beats one on another size's number.
    if (slot && resolved) {
        if (slot.length !== resolved.totalSizes || slot.slot !== resolved.position) return false;
    }

    const start = slot ? slot.listStart : offset;
    const end = slot ? slot.listEnd : offset + numberText.length;
    return isInRepeatContext(patternText, start, end, type);
}

// Returns the index within `str` (a text item starting at `itemOffset` in
// patternText) of the first occurrence of numberText that passes
// isAcceptableMatch, or -1. Checks every occurrence, not just the first:
// in "29 (33, 33, 33, 37)" the knitter's 33 may be the second or third one.
export function findAcceptableNumberIndex(str: string, itemOffset: number, numberText: string, type: string, context: MatchContext): number {
    if (itemOffset < 0) return -1;
    let from = 0;
    while (true) {
        const index = str.indexOf(numberText, from);
        if (index === -1) return -1;
        if (isAcceptableMatch(context, itemOffset + index, numberText, type)) return index;
        from = index + 1;
    }
}
