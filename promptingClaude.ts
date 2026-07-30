import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GaugeSchema, buildSystemPrompt } from "./promptShared.js";

const client = new Anthropic();

// Same job as promptingGemini.ts's prompting() — sends the pattern's full
// extracted text to Claude and gets back the same structured gauge data,
// using the same schema and system prompt (promptShared.ts) so the two
// providers are directly comparable via test:patterns. The Anthropic SDK
// retries rate-limited requests internally by default, so this doesn't need
// its own retry wrapper the way promptingGemini.ts does.
export async function prompting(context: string, preferredSizeLabel: string = "3") {
    const response = await client.messages.parse({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 5000,
        temperature: 0,
        system: [
            {
                type: "text",
                text: buildSystemPrompt(context, preferredSizeLabel),
                cache_control: { type: "ephemeral" },
            },
        ],
        messages: [
            { role: "user", content: context },
        ],
        output_config: {
            format: zodOutputFormat(GaugeSchema),
        },
    });
    console.log(JSON.stringify(response.parsed_output, null, 2));
    return response.parsed_output;
}
