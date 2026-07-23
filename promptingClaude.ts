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
        cache_control: { type: "ephemeral" },
        system: "The knitter would like to make their top in the third size. Only extract one value for both stitches_per_4in and rows_per_4in. This value is consistent across all GaugeSchema objects for the entire patter. If the stitch count and row count for the object is zero, do not add the object to the GaugeSchema",
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