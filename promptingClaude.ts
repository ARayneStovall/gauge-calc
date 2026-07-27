import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const client = new Anthropic();

// Sends the pattern's full extracted text to Claude and gets back structured
// gauge data: the pattern's stated stitches/rows per 4in, and each named
// section with the stitch/row count and repeat multiple to knit that section
// for the chosen size. `preferredSizeLabel` selects which size's numbers to
// extract when the pattern lists more than one (see the system prompt below
// for the fallback behavior when that label isn't present in the pattern).
export async function prompting(context: string, preferredSizeLabel: string = "3") {
    const GaugeSchema = z.object({
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
                source_quote: z.string()
            }))
        })
    });
    const response = await client.messages.parse({
        model: "claude-haiku-4-5",
        max_tokens: 2000,
        temperature: 0,
        system: [
            {
                type: "text",
                text: `The knitter would like to make their top in the size labeled "${preferredSizeLabel}" when the pattern lists multiple sizes. Sizes are often listed as a plain bracketed sequence with no label printed next to any value, e.g. "112 (120) 136 (152) 168 (184)". When "${preferredSizeLabel}" is a number not literally printed as a label anywhere in the pattern, read it as the position of that size counting from the smallest (so "3" means the 3rd value, not the 1st) — but if that doesn't cleanly apply, fall back to the middle size. Once chosen, use that same size for stitches_per_4in and rows_per_4in, and where you reasonably can, for each section's counts too — this value should be consistent across all GaugeSchema objects for the entire pattern. If the stitch count and row count for a section are zero, do not include that section in the GaugeSchema. For each section's name field, copy the exact text as it appears in the pattern, including capitalization — do not paraphrase or reformat the heading. If a section genuinely has no stated row count in the text (because it's described by measurement or shaping instructions instead), skip that section for rows rather than supplying a fallback. If a section has no stated repeat multiple, assume it is one. Create one section entry for every distinct heading in the pattern text. A heading is a short title-like line that stands on its own, separate from the knitting instructions themselves (e.g. "Back Section", "Back ribbing", "Neck Ribbing" are headings — an instruction sentence like "you should still have 28 sts" is not, even though it also contains a number). Two adjacent sections' final counts often look similar or identical to each other (a stitch count carries over from the end of one section into the next) — that is not a reason to skip creating a section for a real heading; every heading gets its own entry with its own count, even one that repeats a nearby section's number. For source_quote, copy the exact sentence (verbatim, not paraphrased) from the pattern text that the section's stitch_count and row_count were read from, so the answer stays grounded in the actual text rather than an inference. Patterns commonly repeat a near-identical checkpoint sentence many times throughout the document — e.g. "You should still have a total of N Sts on your needles" or "There are now a total of N Sts on your needles" — one immediately before nearly every heading. These all share the same shape and size-bracket structure, so it's easy to grab the wrong one. For a given section's stitch_count, use only the checkpoint sentence that sits immediately adjacent to that section's own heading (directly before it, or within its own body) — never a similar-looking checkpoint from elsewhere in the pattern, even if it would otherwise seem plausible.`,
                cache_control: { type: "ephemeral" }
            }
        ],
        messages: [
            { role: "user", content: context},
        ],
        output_config: {
            format: zodOutputFormat(GaugeSchema),
        },
    });
    console.log(JSON.stringify(response.parsed_output, null, 2));
    return response.parsed_output;
}