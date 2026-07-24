import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const client = new Anthropic();

export async function prompting(context: string) {
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
        max_tokens: 500,
        system: [
            {
                type: "text",
                text: "The knitter would like to make their top in the third size. Only extract one value for both stitches_per_4in and rows_per_4in. This value is consistent across all GaugeSchema objects for the entire pattern. If the stitch count and row count for the object is zero, do not add the object to the GaugeSchema. For each section's name field, copy the exact text as it appears in the pattern, including capitalization — do not paraphrase or reformat the heading. If a section genuinely has no stated row count in the text (because it's described by measurement or shaping instructions instead), there's no real printed number to search for or correct in the first place — so that section should probably be skipped entirely for the rows pass, rather than given any fallback placeholder value at all. If a section has no stated repeat multiple, assume it is one.",
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