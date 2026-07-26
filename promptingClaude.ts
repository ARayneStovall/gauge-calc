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
                row_repeat_multiple: z.number()
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
                text: `The knitter would like to make their top in the size labeled "${preferredSizeLabel}" when the pattern lists multiple sizes. If the pattern lists multiple sizes and the requested label is not present, choose the middle size (or the size nearest to the labeled size). Only extract one value for both stitches_per_4in and rows_per_4in corresponding to the chosen size; this value should be consistent across all GaugeSchema objects for the entire pattern. If the stitch count and row count for a section are zero, do not include that section in the GaugeSchema. For each section's name field, copy the exact text as it appears in the pattern, including capitalization — do not paraphrase or reformat the heading. If a section genuinely has no stated row count in the text (because it's described by measurement or shaping instructions instead), skip that section for rows rather than supplying a fallback. If a section has no stated repeat multiple, assume it is one.`,
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