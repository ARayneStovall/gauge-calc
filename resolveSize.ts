// Resolves a knitter's preferredSizeLabel (e.g. "S") to a concrete 1-indexed
// position in the pattern's own size list — deterministically, in code,
// rather than asking the LLM to find and count a bracketed size list itself.
// Repeated review of real extraction failures showed the model miscounting
// bracket positions (especially in patterns with no letter labels, just
// plain numbers) far more reliably than it should for a task that's really
// just "find this list, count to this label" — exactly the kind of counting
// task deterministic code does perfectly and an LLM does inconsistently.

export interface ResolvedSize {
    position: number;
    totalSizes: number;
    labels: string[];
    matchedLabel: string | null;
    // Maps a category word (e.g. "adult") to the 0-indexed position in
    // `labels` where that category's own label run began — only present when
    // the size list itself declared the split inline (e.g. "...8-10 yrs,
    // Adult XS, S, SM, ..."). Lets findSizeSubsetClauses resolve a later
    // "Adult sizes:" clause against the same split point.
    categoryMarkers?: Record<string, number> | undefined;
}

// One subset-scoping clause found in the pattern body (e.g. "Sizes 1, 3, 6, 7
// only:", "ALL SIZES EXCEPT XL:", "Adult sizes:") — see findSizeSubsetClauses.
export interface SubsetClause {
    headerText: string;
    isMember: boolean;
    localPosition: number | null;
    subsetSize: number;
}

// Matches the vocabulary of size labels actually seen across sample patterns:
// plain numbers (1, 2, 3...), X-prefixed S/L (XXS, XS, S, L, XL, XXL...), M,
// numeric-prefixed XL sizes (2XL, 3XL...), and compound in-between sizes (SM,
// ML — e.g. "XS, S, SM, M, ML, L, XL, XXL"). Deliberately narrow — a token
// that doesn't look like a size label ends the list, which is what lets scanning
// stop cleanly before trailing text like "To Fit:" or "MEASUREMENTS". Without
// SM/ML here, a list using them truncated after just "XS, S" (Tip_Top_Tank's
// real list) and fell back to a longer but wrong run elsewhere in the text
// (the "To Fit Bust" measurement numbers) — SM/ML were previously only
// recognized by the separate prose-list strategy below, not this one.
const SIZE_LABEL_REGEX = /^(?:\d{1,2}|X{0,3}S|M|X{0,3}L|\d{1,2}X{1,2}L|SM|ML)$/i;

// pdfjs occasionally splits one word across two text items with a stray space
// in between (the same font-kerning artifact documented in extractStampText.ts),
// e.g. "Size" extracted as "Si ze". Tolerating optional internal whitespace
// in the keyword itself catches that without needing a second pass.
const SIZE_KEYWORD_REGEX = /\bs\s*i\s*z\s*e\s*s?\b/gi;

function extractLabelRun(windowText: string): string[] {
    const stripped = windowText.replace(/[()]/g, " ");
    const tokens = stripped.split(/[,\s/]+/).filter(Boolean);
    const labels: string[] = [];
    let skipped = 0;
    // Once the run starts, it must stay consistently all-numeric or
    // all-letter-based — a lone stray digit (e.g. a page-number artifact
    // that slipped past extractPatternText, or vice versa) shouldn't be
    // able to extend or contaminate a list of the other kind.
    let runIsNumeric: boolean | null = null;
    for (const token of tokens) {
        const isNumeric = /^\d+$/.test(token);
        if (SIZE_LABEL_REGEX.test(token) && (runIsNumeric === null || runIsNumeric === isNumeric)) {
            labels.push(token);
            runIsNumeric = isNumeric;
        } else if (labels.length === 0 && skipped < 6) {
            // Tolerate a few leading non-label tokens (e.g. "&", "FINISHED",
            // "MEASUREMENTS", or a stray "Si"/"ze" fragment from a second,
            // noisier match of the same keyword) before the real list starts.
            skipped++;
        } else {
            break;
        }
    }
    return labels;
}

// Scans every occurrence of "size"/"sizes" in the text (not just the first —
// the first hit is frequently unrelated body prose, e.g. "this pattern comes
// in multiple sizes...") and keeps whichever occurrence's following text
// parses into the longest run of size-label-shaped tokens.
function findSizeLabelList(patternText: string): string[] | null {
    let best: string[] = [];
    let match: RegExpExecArray | null;
    SIZE_KEYWORD_REGEX.lastIndex = 0;
    while ((match = SIZE_KEYWORD_REGEX.exec(patternText)) !== null) {
        const windowStart = match.index + match[0].length;
        const window = patternText.slice(windowStart, windowStart + 300);
        const labels = extractLabelRun(window);
        if (labels.length > best.length) best = labels;
    }
    return best.length >= 2 ? best : null;
}

// A second detection strategy for patterns that disclose sizes only via a
// measurements table — e.g. "S – 7” M – 8” L – 9”" — with no "size"/"sizes"
// keyword anywhere nearby for findSizeLabelList to anchor on at all
// (Petty_Harbour is exactly this: its only size list is under a "FINISHED
// MEASUREMENTS (FOOT CIRCUMFERENCE)" heading). Looks for a run of at least
// two adjacent "LABEL - measurement" pairs and returns the labels in order.
const MEASUREMENT_PAIR_REGEX = /(\d{1,2}X{1,2}L|X{0,3}[SML])\s*[-–]\s*\d+(?:\.\d+)?/gi;

function findMeasurementTableLabelList(patternText: string): string[] | null {
    const matches = [...patternText.matchAll(MEASUREMENT_PAIR_REGEX)];
    if (matches.length < 2) return null;

    // Adjacent pairs sit right next to each other in the text (just a little
    // whitespace between); a bigger gap means a new, unrelated run started —
    // keep whichever run is longest.
    let bestRun: string[] = [];
    let currentRun: string[] = [];
    let lastEnd = -1;
    for (const m of matches) {
        const start = m.index!;
        if (lastEnd !== -1 && start - lastEnd > 15) {
            if (currentRun.length > bestRun.length) bestRun = currentRun;
            currentRun = [];
        }
        currentRun.push(m[1]!);
        lastEnd = start + m[0].length;
    }
    if (currentRun.length > bestRun.length) bestRun = currentRun;

    return bestRun.length >= 2 ? bestRun : null;
}

// A third detection strategy for patterns (e.g. Tin Can Knits) that state
// their full size list as prose right after a "sizing:" heading, mixing
// word-based child-size ranges ("0-6 mo", "1-2 yrs") with standard and
// compound adult letter labels ("XS, S, SM, M, ML, L, XL..."). Neither
// earlier strategy can parse this: findSizeLabelList's token vocabulary has
// no notion of a two-word age range, and there's no "LABEL - measurement"
// table to anchor on. Requires the colon immediately after "sizing" (no
// intervening word) so this doesn't fire on "sizing notes:" or "sizing
// table:" headings elsewhere in the same patterns, which aren't the list.
const SIZING_HEADING_REGEX = /\bsizing\s*:/gi;

// A single size-list token: a word-based child/baby age range, a named
// child-size word (some patterns label sizes "Newborn (Baby, Toddler,
// Child, Adult S, M, L)" instead of age ranges), a compound adult label
// (SM, ML — sits between the standard letters in this vocabulary), or the
// same plain-letter/numeric-prefixed vocabulary as SIZE_LABEL_REGEX above.
const PROSE_SIZE_TOKEN_REGEX = /^(?:\d{1,2}\s*-\s*\d{1,2}\s*(?:mo|yrs?)|\d{1,2}X{1,2}L|SM|ML|X{0,3}S|M|X{0,3}L|Newborn|Preemie|Infant|Baby|Toddler|Child|Kids?|Youth|Teen)$/i;

function extractProseLabelRun(windowText: string): { labels: string[]; categoryMarkers: Record<string, number> } {
    // Parens are just visual grouping around the same comma-separated list
    // ("0-6 mo (6-12 mo, 1-2 yrs, ...)"), so folding them into commas lets a
    // single comma-split produce the right tokens without losing the age
    // ranges' internal spaces the way whitespace-splitting would.
    const tokens = windowText.replace(/[()]/g, ",").split(",").map(t => t.trim()).filter(Boolean);
    const labels: string[] = [];
    const categoryMarkers: Record<string, number> = {};
    for (const token of tokens) {
        // "Adult"/"Child" sometimes prefixes the first label of that
        // category inline ("8-10 yrs, Adult XS, S, ...") as a category
        // marker, not a size — recorded (not just stripped) so a later
        // "Adult sizes:"/"Child sizes:" body clause can be resolved against
        // the same split point.
        const categoryMatch = token.match(/^(adult|child)\s+(.+)$/i);
        const candidate = categoryMatch ? categoryMatch[2]! : token;
        if (PROSE_SIZE_TOKEN_REGEX.test(candidate)) {
            if (categoryMatch) categoryMarkers[categoryMatch[1]!.toLowerCase()] = labels.length;
            labels.push(candidate);
        } else {
            break;
        }
    }
    return { labels, categoryMarkers };
}

function findProseSizeLabelList(patternText: string): { labels: string[]; categoryMarkers: Record<string, number> } | null {
    let best: { labels: string[]; categoryMarkers: Record<string, number> } = { labels: [], categoryMarkers: {} };
    let match: RegExpExecArray | null;
    SIZING_HEADING_REGEX.lastIndex = 0;
    while ((match = SIZING_HEADING_REGEX.exec(patternText)) !== null) {
        const windowStart = match.index + match[0].length;
        const window = patternText.slice(windowStart, windowStart + 400);
        const result = extractProseLabelRun(window);
        if (result.labels.length > best.labels.length) best = result;
    }
    return best.labels.length >= 2 ? best : null;
}

// Returns null when no confident size list can be parsed by any strategy —
// callers should fall back to the existing label-based prompting behavior
// in that case rather than force a guess.
export function resolveSizePosition(patternText: string, preferredSizeLabel: string): ResolvedSize | null {
    // Tried first: a "sizing:" heading is a stronger, more specific signal of
    // the pattern's authoritative full size list than a bare "size"/"sizes"
    // mention anywhere in the text (findSizeLabelList's anchor). Without this
    // ordering, a scoped conditional clause elsewhere — e.g. "Sizes XL (XXL,
    // 3XL, 4XL, 5XL, 6XL) only:" — can out-rank the real list simply by being
    // a longer label run than whatever a looser "size" match happens to find,
    // even though it only covers a subset of the pattern's sizes.
    const proseResult = findProseSizeLabelList(patternText);
    const labels = proseResult?.labels ?? findSizeLabelList(patternText) ?? findMeasurementTableLabelList(patternText);
    if (!labels) return null;
    const categoryMarkers = proseResult?.categoryMarkers;

    const exactIndex = labels.findIndex(l => l.toLowerCase() === preferredSizeLabel.toLowerCase());
    if (exactIndex !== -1) {
        return { position: exactIndex + 1, totalSizes: labels.length, labels, matchedLabel: labels[exactIndex]!, categoryMarkers };
    }

    if (/^\d+$/.test(preferredSizeLabel)) {
        const asPosition = Number(preferredSizeLabel);
        if (asPosition >= 1 && asPosition <= labels.length) {
            return { position: asPosition, totalSizes: labels.length, labels, matchedLabel: null, categoryMarkers };
        }
    }

    const middlePosition = Math.ceil(labels.length / 2);
    return { position: middlePosition, totalSizes: labels.length, labels, matchedLabel: null, categoryMarkers };
}

// Tokenizes a subset-scoping clause's body the same way extractLabelRun does
// for the pattern's main size list, but also tolerates "-"/"–" as an
// excluded-position placeholder (kept as its own marker, not a real label —
// e.g. "Sizes 1 (2) - (-) 5 (-) 7 (8) – Only" marks which of the 8 sizes
// aren't in this subset) and drops "and"/"&" list connectors rather than
// letting them end the run the way an unrecognized token normally would.
function extractSubsetTokens(clauseBody: string): string[] {
    const stripped = clauseBody.replace(/[()]/g, " ");
    // Splitting on ":" too matters for a header with no space before it
    // ("for sizes 1, 3, 6, 7: work p2tog...") — otherwise "7:" fails the
    // label regex (which requires an exact match, no trailing punctuation)
    // and truncates the run one token early.
    const tokens = stripped.split(/[,\s/:]+/).filter(Boolean).filter(t => !/^(?:and|&)$/i.test(t));
    const result: string[] = [];
    let runIsNumeric: boolean | null = null;
    for (const token of tokens) {
        // Only the plain ASCII hyphen is a placeholder — the en dash is
        // reserved for the "– Only"/"– measurement" phrase separator that
        // follows the real token run (e.g. "7 (8) – Only"), which must end
        // the run rather than be swept in as one more excluded slot.
        if (token === "-") {
            result.push("-");
            continue;
        }
        const isNumeric = /^\d+$/.test(token);
        if (SIZE_LABEL_REGEX.test(token) && (runIsNumeric === null || runIsNumeric === isNumeric)) {
            result.push(token);
            runIsNumeric = isNumeric;
        } else {
            break;
        }
    }
    return result;
}

const EXCEPT_CLAUSE_REGEX = /\ball\s+sizes?\s+except\s+([^:.\n]{1,80})/gi;
const CATEGORY_HEADING_REGEX = /\b(adult|child)\s+sizes?\s*:/gi;

// Finds every size-restricted clause in the pattern body (as opposed to the
// pattern's own main size declaration, already resolved into `resolved`) and
// determines, for each, whether the knitter's resolved size is a member of
// that specific subset — and if so, its 1-indexed position within just that
// subset's own membership order, which is what any bracket scoped to that
// clause should actually use instead of the pattern-wide position. Handles
// the three most syntactically reliable formats found across real sample
// patterns (comma-enumerated "Sizes X, Y, Z only"/"for sizes X, Y, Z:",
// dash-placeholder "Sizes 1 (2) - (-) 5 (-) 7 (8) – Only", "ALL SIZES EXCEPT
// X", and named category prefixes like "Adult sizes:" when the main list
// parse recorded that split point). Clause phrasings that don't match any of
// these are left alone rather than guessed at — deliberately: the point of
// resolving sizes in code at all is to avoid asking the model to do
// unreliable counting, so a clause type not confidently parseable here
// should get no guidance rather than a shaky prompt-only guess.
export function findSizeSubsetClauses(patternText: string, resolved: ResolvedSize): SubsetClause[] {
    const { labels, position: globalPosition, totalSizes, categoryMarkers } = resolved;
    const knitterLabel = labels[globalPosition - 1] ?? null;
    const clauses: SubsetClause[] = [];
    const seenHeaders = new Set<string>();

    // "ALL SIZES EXCEPT X[, Y...]" — subset is every label except the
    // excluded one(s).
    let exceptMatch: RegExpExecArray | null;
    EXCEPT_CLAUSE_REGEX.lastIndex = 0;
    while ((exceptMatch = EXCEPT_CLAUSE_REGEX.exec(patternText)) !== null) {
        const excludedTokens = extractSubsetTokens(exceptMatch[1]!).filter(t => t !== "-");
        if (excludedTokens.length === 0) continue;
        const headerText = exceptMatch[0].trim();
        if (seenHeaders.has(headerText)) continue;
        seenHeaders.add(headerText);

        const excludedSet = new Set(excludedTokens.map(t => t.toLowerCase()));
        const subsetMembers = labels.filter(l => !excludedSet.has(l.toLowerCase()));
        const isMember = knitterLabel !== null && !excludedSet.has(knitterLabel.toLowerCase());
        const localIndex = isMember ? subsetMembers.findIndex(l => l.toLowerCase() === knitterLabel!.toLowerCase()) : -1;
        clauses.push({ headerText, isMember: localIndex !== -1, localPosition: localIndex !== -1 ? localIndex + 1 : null, subsetSize: subsetMembers.length });
    }

    // Comma-enumerated or dash-placeholder "Sizes ... only"/"for sizes ...:"
    // clauses. The pattern's own main size declaration also matches this
    // keyword, so the first occurrence is always skipped. A dash-aligned
    // clause is expected to have exactly `totalSizes` tokens (it pads every
    // excluded slot with a placeholder to stay aligned with the full list),
    // so the "must be shorter than the whole pattern" guard only applies to
    // the plain-enumerated case below — applying it before checking for
    // dashes would reject every legitimate dash-aligned clause too.
    let match: RegExpExecArray | null;
    SIZE_KEYWORD_REGEX.lastIndex = 0;
    let occurrence = 0;
    while ((match = SIZE_KEYWORD_REGEX.exec(patternText)) !== null) {
        occurrence++;
        if (occurrence === 1) continue;

        const windowStart = match.index + match[0].length;
        const window = patternText.slice(windowStart, windowStart + 150);
        const tokens = extractSubsetTokens(window);
        if (tokens.length < 2) continue;

        // Trim the header down to just the clause itself (stopping right
        // after "only" or at the next colon) rather than a fixed character
        // count, which would otherwise sweep in whatever instruction text
        // happens to follow — this string is what gets quoted verbatim in
        // the prompt as the text to watch for.
        const rawHeaderWindow = patternText.slice(match.index, match.index + 100);
        const onlyIdx = rawHeaderWindow.search(/only\b/i);
        const colonIdx = rawHeaderWindow.indexOf(":");
        const headerEnd = onlyIdx !== -1 ? onlyIdx + 4 : colonIdx !== -1 ? colonIdx + 1 : Math.min(60, rawHeaderWindow.length);
        const headerText = rawHeaderWindow.slice(0, headerEnd).trim();
        if (seenHeaders.has(headerText)) continue;

        const hasDashes = tokens.includes("-");
        if (hasDashes && tokens.length === totalSizes) {
            // Dash-aligned to the full list: the token sitting at the
            // knitter's own global position tells us directly whether
            // they're excluded, and counting the non-dash tokens up to and
            // including that slot gives the local position.
            const ownToken = tokens[globalPosition - 1];
            const isMember = ownToken !== undefined && ownToken !== "-";
            const localPosition = isMember ? tokens.slice(0, globalPosition).filter(t => t !== "-").length : null;
            seenHeaders.add(headerText);
            clauses.push({ headerText, isMember, localPosition, subsetSize: tokens.filter(t => t !== "-").length });
        } else if (!hasDashes && tokens.length < totalSizes) {
            // Plain enumerated subset — membership by literal label match,
            // since this list only names its own members (no placeholders
            // marking the pattern's other sizes). Must be strictly shorter
            // than the full list, or this is the main declaration re-matched.
            const isMember = knitterLabel !== null && tokens.some(t => t.toLowerCase() === knitterLabel.toLowerCase());
            const localIndex = isMember ? tokens.findIndex(t => t.toLowerCase() === knitterLabel!.toLowerCase()) : -1;
            seenHeaders.add(headerText);
            clauses.push({ headerText, isMember: localIndex !== -1, localPosition: localIndex !== -1 ? localIndex + 1 : null, subsetSize: tokens.length });
        }
    }

    // Named category prefix/suffix ("Adult sizes:"/"Child sizes:"), only
    // when the main label-list parse recorded where that category began.
    // Every sample seen uses this format as a simple contiguous split of the
    // ascending list at that marker — "adult" means the marker through the
    // end, any other category name found means everything before it.
    if (categoryMarkers) {
        let catMatch: RegExpExecArray | null;
        CATEGORY_HEADING_REGEX.lastIndex = 0;
        while ((catMatch = CATEGORY_HEADING_REGEX.exec(patternText)) !== null) {
            const categoryWord = catMatch[1]!.toLowerCase();
            const markerIndex = categoryMarkers[categoryWord];
            if (markerIndex === undefined) continue;
            const headerText = catMatch[0].trim();
            if (seenHeaders.has(headerText)) continue;
            seenHeaders.add(headerText);

            const isAdultCategory = categoryWord === "adult";
            const subsetSize = isAdultCategory ? labels.length - markerIndex : markerIndex;
            const isMember = isAdultCategory ? globalPosition - 1 >= markerIndex : globalPosition - 1 < markerIndex;
            const localPosition = isMember ? (isAdultCategory ? globalPosition - markerIndex : globalPosition) : null;
            clauses.push({ headerText, isMember, localPosition, subsetSize });
        }
    }

    return clauses;
}
