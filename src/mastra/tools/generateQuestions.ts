import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const model = openai("gpt-5-mini");

import {
  type SituationalQuestion,
  type QuestionDomain,
  type DifficultyTier,
  type SupportedLanguage,
} from "../types/digitalReadiness";

// ─────────────────────────────────────────────────────────────────────────────
// Input schema — accepts the BehavioralProfile produced by analyzeMetrics
// ─────────────────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  behavioralProfile: z.object({
    behavioralScore: z.number(),
    dominantWeaknesses: z.array(z.string()),
    difficultyTier: z.enum(["low", "medium", "high"]),
    ageContext: z.enum(["child", "adult", "unknown"]),
    childMode: z.boolean(),
    supportMode: z.boolean(),
    language: z.enum(["en", "ha", "ig", "yo"]),
  }),
  questionCount: z.number().min(10).max(20).default(15),
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Human-readable domain descriptions for prompt clarity */
const DOMAIN_DESCRIPTIONS: Record<QuestionDomain, string> = {
  app_opening: "opening and launching apps on a phone",
  messaging: "sending and reading messages",
  internet_search: "searching for information online",
  form_filling: "filling in forms or entering information",
  settings_navigation: "navigating phone settings",
  app_download: "finding and downloading apps",
  online_safety: "staying safe online and recognizing scams",
  digital_payments: "sending or receiving money using a phone",
};

/** Difficulty guidance inserted into the prompt */
const DIFFICULTY_GUIDANCE: Record<DifficultyTier, string> = {
  low:
    "Questions must be very simple — single-step actions, familiar everyday objects. " +
    "Assume the user has very limited experience with smartphones. " +
    "Example complexity: 'Your phone screen is dark. What do you press to turn it on?'",
  medium:
    "Questions may involve two steps or a slightly unfamiliar situation. " +
    "Assume the user knows basic phone use but struggles with less common tasks. " +
    "Example complexity: 'You want to find a health clinic nearby. How would you use your phone to look it up?'",
  high:
    "Questions may involve multi-step reasoning, safety awareness, or problem-solving. " +
    "Assume the user is comfortable with basic phone use but needs challenge. " +
    "Example complexity: 'You receive a message saying you have won money and must send your PIN to claim it. What would you do?'",
};

/** Language names for the prompt */
const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  ha: "Hausa",
  ig: "Igbo",
  yo: "Yoruba",
};

/**
 * Build the generation prompt sent to the LLM.
 * All constraints from the design document are encoded here.
 */
function buildGenerationPrompt(
  profile: z.infer<typeof inputSchema>["behavioralProfile"],
  questionCount: number,
  domains: QuestionDomain[],
): string {
  const languageName = LANGUAGE_NAMES[profile.language as SupportedLanguage];
  const domainList = domains
    .map((d) => `  - ${d}: ${DOMAIN_DESCRIPTIONS[d as QuestionDomain]}`)
    .join("\n");
  const difficultyInstructions =
    DIFFICULTY_GUIDANCE[profile.difficultyTier as DifficultyTier];
  const childInstruction = profile.childMode
    ? "\nCHILD MODE IS ACTIVE: The user is under 13. Use only child-appropriate, school/family scenarios. Do NOT include online safety, digital payments, or any adult topics."
    : "";
  const supportInstruction = profile.supportMode
    ? "\nSUPPORT MODE IS ACTIVE: The user shows very limited digital capability. Keep questions as simple and encouraging as possible."
    : "";

  return `You are generating situational digital literacy questions for a rural user assessment.

CONTEXT:
- User's behavioral score: ${profile.behavioralScore}/100
- Age context: ${profile.ageContext}
- Difficulty tier: ${profile.difficultyTier.toUpperCase()}
- Output language: ${languageName}
${childInstruction}
${supportInstruction}

DIFFICULTY INSTRUCTIONS:
${difficultyInstructions}

QUESTION DOMAINS TO COVER (select from these):
${domainList}

STRICT CONSTRAINTS:
1. Write ALL questions and expectedReasoning in ${languageName}.
2. Questions must describe a real scenario — never ask for definitions.
3. Never use technical jargon (no "browser", "URL", "Wi-Fi" unless in a natural phrase).
4. Questions must be culturally neutral — avoid brand names except universal ones (WhatsApp is acceptable).
5. Each question must be independently answerable — no question should depend on a previous answer.
6. acceptableKeywords must be in ${languageName} as well.

GENERATE exactly ${questionCount} questions.

RESPOND ONLY with a valid JSON array. No markdown, no explanation, no preamble.
Schema for each item:
{
  "id": "q1",                          // q1, q2, q3 ...
  "domain": "<domain_key>",            // from the domain list above
  "difficulty": "${profile.difficultyTier}",
  "question": "<scenario question in ${languageName}>",
  "expectedReasoning": "<what a capable user would say/do, in ${languageName}>",
  "acceptableKeywords": ["<keyword1>", "<keyword2>"]   // 3–6 keywords in ${languageName}
}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────────────

export const generateQuestionsTool = createTool({
  id: "generateQuestions",
  description:
    "Uses the LLM to generate 10-20 adaptive situational questions based on the user's BehavioralProfile. " +
    "Questions are contextual, practical, culturally neutral, and rendered in the user's language. " +
    "Child mode and support mode constraints are enforced automatically. " +
    "Returns a typed SituationalQuestion array.",
  inputSchema,
  execute: async (rawInput: any) => {
    const input = rawInput?.context ?? rawInput;
    const { behavioralProfile, questionCount } = input as any;

    const domains = behavioralProfile.dominantWeaknesses as QuestionDomain[];
    const prompt = buildGenerationPrompt(
      behavioralProfile,
      questionCount,
      domains,
    );

    // ── Call the LLM via AI SDK generateText ─────────────────────────────────
    const { text: rawText } = await generateText({
      model,
      prompt,
      temperature: 0.4,
    });

    // ── Parse and validate JSON ─────────────────────────────────────────────
    let parsed: unknown;
    try {
      // Strip markdown fences if the model wraps output despite instructions
      const cleaned = rawText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(
        `generateQuestions: LLM returned non-JSON output.\nRaw: ${rawText.slice(0, 300)}`,
      );
    }

    if (!Array.isArray(parsed)) {
      throw new Error(
        "generateQuestions: Expected a JSON array from the LLM, got: " +
          typeof parsed,
      );
    }

    // ── Validate each question object ───────────────────────────────────────
    const questionSchema = z.object({
      id: z.string(),
      domain: z.string(),
      difficulty: z.string(),
      question: z.string().min(10),
      expectedReasoning: z.string().min(5),
      acceptableKeywords: z.array(z.string()).min(1),
    });

    const validated: SituationalQuestion[] = [];
    for (const item of parsed) {
      const result = questionSchema.safeParse(item);
      if (!result.success) {
        // Skip malformed items rather than failing the whole call
        console.warn(
          "[generateQuestions] Skipping malformed question item:",
          result.error.issues,
        );
        continue;
      }
      validated.push(result.data as SituationalQuestion);
    }

    if (validated.length === 0) {
      throw new Error(
        "generateQuestions: All returned question items failed validation.",
      );
    }

    return validated;
  },
});
