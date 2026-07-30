import { z } from "zod";
import { resolveSizePosition, findSizeSubsetClauses, type ResolvedSize } from "./resolveSize.js";

// Shared between promptingGemini.ts and promptingClaude.ts so the two
// providers can never drift apart on schema or prompt wording — every
// extraction-quality fix (size resolution, swatch exclusion,
// checkpoint-selection, etc.) lives in exactly one place and benefits
// whichever provider is actually wired up in extractStampText.ts.
export const GaugeSchema = z.object({
    stitches_per_4in: z.number(),
    rows_per_4in: z.number(),
    stitch_count: z.number(),
    sections: z.object({
        sections: z.array(z.object({
            name: z.string(),
            stitch_count: z.number(),
            repeat_multiple: z.number(),
            row_count: z.number(),
            row_repeat_multiple: z.number(),
            // The following four fields describe a section's *periodic*
            // shaping (gradual increases/decreases), e.g. "decrease every
            // 5th round, 7 more times" — distinct from stitch_count/row_count,
            // which only capture the section's two endpoint totals. All four
            // are 0 when a section has no such repeating shaping (a one-off
            // increase, no shaping at all, or fewer than 2 total shaping
            // instances, which has no meaningful interval).
            shaping_start_stitch_count: z.number(),
            shaping_stitches_per_event: z.number(),
            shaping_event_count: z.number(),
            shaping_interval_rows: z.number(),
            source_quote: z.string()
        }))
    })
});

// Builds the size-selection guidance for the system prompt. Where possible,
// this resolves preferredSizeLabel to a concrete 1-indexed bracket position
// in code (resolveSize.ts) rather than asking the model to find the
// pattern's size list and count a position itself — repeated review of real
// extraction failures showed the model doing that specific counting task
// unreliably, especially for patterns with no letter labels (just plain
// numbers) or unusual parenthetical groupings. When no confident size list
// can be parsed (e.g. a pattern that only states sizes via a measurements
// table, not a "SIZE" list), this falls back to the original label-based
// instruction and lets the model handle it as before.
function buildSizeGuidance(preferredSizeLabel: string, resolved: ResolvedSize | null): string {
    if (!resolved) {
        return `The knitter would like to make their top in the size labeled "${preferredSizeLabel}" when the pattern lists multiple sizes. Sizes are often listed as a plain bracketed sequence with no label printed next to any value, e.g. "112 (120) 136 (152) 168 (184)". When "${preferredSizeLabel}" is a number not literally printed as a label anywhere in the pattern, read it as the position of that size counting from the smallest (so "3" means the 3rd value, not the 1st) — but if that doesn't cleanly apply, fall back to the middle size.`;
    }
    const { position, totalSizes, labels, matchedLabel } = resolved;
    const labelClause = matchedLabel
        ? `the knitter's requested size, "${preferredSizeLabel}", is listed as position ${position} of ${totalSizes} in that order`
        : `"${preferredSizeLabel}" isn't printed anywhere in that list, so use position ${position} of ${totalSizes} (the middle size) instead`;
    return `This pattern lists its sizes, in order from smallest to largest, as: ${labels.join(", ")}. This order is already resolved for you from the pattern's own size list — ${labelClause}. For every bracketed size sequence anywhere in the pattern, always use the value at position ${position} (1-indexed, counting from the smallest), reading strictly left to right — parentheses are just visual grouping and do not change which position corresponds to which size, so do not let them change your counting.`;
}

// Builds guidance for size-restricted ("subset") clauses — instructions
// scoped to only some of the pattern's sizes, e.g. "Sizes 1, 3, 6, 7 only:",
// "ALL SIZES EXCEPT XL:", or "Adult sizes:" — which need a position computed
// within just that subset's own membership order, not the pattern-wide
// position buildSizeGuidance resolves above. Computed the same way and for
// the same reason as that function: repeated review showed the model
// miscounting a subset's membership order at least as unreliably as the
// full-list case, so findSizeSubsetClauses (resolveSize.ts) resolves
// whichever clauses it can confidently parse in code and this just reports
// the answer. Clause phrasings it doesn't recognize are silently omitted
// here too — no attempt is made to teach the model to guess at the general
// case, since that would reintroduce the exact unreliable counting this
// whole mechanism exists to avoid, for cases we can't confidently resolve
// anyway. Returns "" (no-op) when there's no resolved size or no subset
// clauses were found.
function buildSubsetGuidance(context: string, resolved: ResolvedSize | null): string {
    if (!resolved) return "";
    const clauses = findSizeSubsetClauses(context, resolved);
    if (clauses.length === 0) return "";

    const sentences = clauses.map(clause => {
        if (clause.isMember && clause.localPosition !== null) {
            return `The text "${clause.headerText}" DOES include the knitter's requested size in its subset — within whichever real heading this text appears inside, use position ${clause.localPosition} of ${clause.subsetSize} (counting only within this subset, ignoring sizes outside it) for any bracketed sequence up to the next heading or size-restricted clause, instead of the pattern's overall position ${resolved.position}.`;
        }
        return `The text "${clause.headerText}" does NOT include the knitter's requested size in its subset — skip every instruction that follows it, up to the next heading or size-restricted clause, entirely. None of it applies to this knitter.`;
    });

    return ` This pattern also contains instructions restricted to only some of its sizes, e.g. "Sizes 1, 3, 6, 7 only:" or "Adult sizes:". These restriction clauses are NOT section headings — never create a GaugeSchema section entry named after one of them; they are just qualifiers that appear inside a real section's own body and change how you count sizes (or whether you use that part of the section's text at all) for the rest of that section, or until another such clause appears. ${sentences.join(" ")}`;
}

// The full system prompt: overall gauge/section-extraction rules plus the
// size-selection guidance above. Provider-agnostic — both promptingGemini.ts
// and promptingClaude.ts pass this straight through as their system
// instruction, so a wording fix only ever needs to be made once here.
export function buildSystemPrompt(context: string, preferredSizeLabel: string): string {
    const resolved = resolveSizePosition(context, preferredSizeLabel);
    return `${buildSizeGuidance(preferredSizeLabel, resolved)}${buildSubsetGuidance(context, resolved)} Once chosen, use that same size for stitches_per_4in and rows_per_4in, and where you reasonably can, for each section's counts too — this value should be consistent across all GaugeSchema objects for the entire pattern. If the stitch count and row count for a section are zero, do not include that section in the GaugeSchema. For each section's name field, copy the exact text as it appears in the pattern, including capitalization — do not paraphrase or reformat the heading. If the heading itself ends with a colon in the pattern text (e.g. "Toe:" or "Set-up round:"), leave that trailing colon out of the name field — it is just typographic punctuation marking where the heading ends and the instructions begin, not part of the heading's actual name, and including it inconsistently makes the same section look like two different ones. If a section genuinely has no stated row count in the text (because it's described by measurement or shaping instructions instead), skip that section for rows rather than supplying a fallback. If a section has no stated repeat multiple, assume it is one. A section's row_count is often more than the individually-numbered rows/rounds written out in the text: when the pattern says something like "repeat rounds/rows X-Y a total of N times" or "repeat rounds/rows X-Y another N more times", the row_count must include that full repeat — the fixed rows before the repeated block, plus (the repeated block's row span × N) — not just the count of rows individually described before the repeat instruction. "A total of N times" means the block happens N times altogether; "N more times" means N additional times on top of the one already shown. Create one section entry for every distinct heading in the pattern text. A heading is a short title-like line that stands on its own, separate from the knitting instructions themselves (e.g. "Back Section", "Back ribbing", "Neck Ribbing" are headings — an instruction sentence like "you should still have 28 sts" is not, even though it also contains a number). Do not include a gauge-swatch or test-swatch heading (e.g. "SWATCH", or any section whose instructions describe casting on and knitting a small test piece purely to check gauge before starting) as a section — it isn't part of the finished garment, and rescaling its stitch/row counts would give the knitter the wrong test swatch to measure their gauge against, defeating its purpose. Only include sections that knit an actual, permanent part of the finished garment. Two adjacent sections' final counts often look similar or identical to each other (a stitch count carries over from the end of one section into the next) — that is not a reason to skip creating a section for a real heading; every heading gets its own entry with its own count, even one that repeats a nearby section's number. For source_quote, copy the exact sentence (verbatim, not paraphrased) from the pattern text that the section's stitch_count and row_count were read from, so the answer stays grounded in the actual text rather than an inference. Patterns commonly repeat a near-identical checkpoint sentence many times throughout the document — e.g. "You should still have a total of N Sts on your needles", "There are now a total of N Sts on your needles", or "Work Rows/Rounds X-Y until you have N Sts left on your needles" — one immediately before nearly every heading, or embedded inside a section's own body rather than right after its heading. These all share the same shape and size-bracket structure, so it's easy to grab the wrong one. For a given section's stitch_count, use only the checkpoint sentence that sits immediately adjacent to that section's own heading (directly before it, or within its own body) — never a similar-looking checkpoint from elsewhere in the pattern, even if it would otherwise seem plausible. A single section can also have more than one checkpoint of its own — e.g. a starting cast-on/pick-up count at the beginning, then a different count later after increases or decreases within that same section. When that happens, use the checkpoint that describes the state at the end of that section's rows/rounds, matching the same point in time as the row_count you report for it — not an earlier starting count from before that section's shaping happened. This is different from another case that can look similar but needs the opposite choice: a section sometimes describes its one piece being divided into two or more symmetric parts partway through (e.g. "divide the work in the middle and continue knitting both halves separately... with 65 sts each"). That "N sts each" number is a fraction of the section's count, describing only one of the divided parts — it is not a continuation of the whole section's running total the way an increase or decrease checkpoint is. In that case, use the section's earlier, undivided total as its stitch_count instead of this smaller per-part number. Be especially careful with a section whose own heading contains more than one bracketed stitch total describing its own internal reduction, worked one after the other (e.g. a sock toe: "Work rounds 1-2 a total of N times [X sts] Work round 1 a further M times [Y sts]") — use the LAST bracket found within that section's own body as its stitch_count, never the ending stitch count of an earlier, already-completed section (like the foot or gusset before a toe), even though that earlier section's number might otherwise look like a plausible "current" running total to fall back on. Some sections describe a shaping sequence that repeats periodically throughout the section — e.g. "Decrease round: k1, k2tog, knit to last 3 sts, ssk, k1 (2 sts decreased). Knit 4 more plain rounds. Continue every 5th round, 7 more times, until 48 sts remain." When a section has this kind of periodic, repeating shaping (not just a single one-off increase or decrease), also populate these four fields: shaping_start_stitch_count is the stitch count at the point where the repeating shaping begins — this is often a different, later checkpoint than whatever count the section started with, e.g. after an initial pick-up or setup round worked earlier within this same section, before the periodic shaping itself begins. shaping_stitches_per_event is how many stitches change each single time the shaping round/row is worked (e.g. "(2 sts decreased)" means 2). shaping_event_count is how many times the shaping round/row is worked in total, using the same "N more times" vs. "a total of N times" rules as row_count above. shaping_interval_rows is the number of rows/rounds from the start of one shaping instance to the start of the next — e.g. "every 5th round" means 5, or if the pattern instead phrases it as "work a decrease round, then 4 plain rounds, repeat this 5-round sequence" the interval is 5. shaping_interval_rows is a completely different thing from row_repeat_multiple: row_repeat_multiple exists only to keep a rescaled row_count landing on a valid multiple for the section's stitch pattern (e.g. a lace or rib repeat), it is never a stand-in for how often shaping happens — do not set row_repeat_multiple to a shaping cadence value. If a section has no periodic shaping — only a one-off increase/decrease, no shaping at all, or the shaping would occur fewer than 2 total times (a single occurrence has no meaningful interval) — set all four of these fields to 0.`;
}
