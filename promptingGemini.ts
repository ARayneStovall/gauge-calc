import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { GaugeSchema, buildSystemPrompt } from "./promptShared.js";

const client = new GoogleGenAI({});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The free tier caps requests per minute per model, so a burst of calls
// (e.g. test:patterns running several repeats back to back) can hit a 429
// well within normal use. Gemini also returns 503 "high demand" errors that
// usually clear within seconds (5 of roughly 100 calls on 2026-11-09), plus
// the occasional 500/504. Retry all of these a few times with backoff before
// giving up: rate limits need a long wait for the window to reset, the
// others only a short one.
const RETRYABLE_STATUSES = new Set([429, 500, 503, 504]);

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err instanceof ApiError ? err.status : undefined;
            if (status === undefined || !RETRYABLE_STATUSES.has(status) || attempt >= maxAttempts) throw err;
            await sleep(attempt * (status === 429 ? 20_000 : 5_000));
        }
    }
}

// Sends the pattern's full extracted text to Gemini and gets back structured
// gauge data: the pattern's stated stitches/rows per 4in, and each named
// section with the stitch/row count and repeat multiple to knit that section
// for the chosen size. `preferredSizeLabel` selects which size's numbers to
// extract when the pattern lists more than one (see promptShared.ts's
// buildSystemPrompt for how that's resolved).
export async function prompting(context: string, preferredSizeLabel: string = "3") {
    const response = await withRetry(() => client.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: [
            { role: "user", parts: [{ text: context }] },
        ],
        config: {
            temperature: 0,
            maxOutputTokens: 5000,
            systemInstruction: buildSystemPrompt(context, preferredSizeLabel),
            responseMimeType: "application/json",
            responseJsonSchema: z.toJSONSchema(GaugeSchema),
        },
    }));
    const parsed = GaugeSchema.parse(JSON.parse(response.text ?? ""));
    console.log(JSON.stringify(parsed, null, 2));
    return parsed;
}
