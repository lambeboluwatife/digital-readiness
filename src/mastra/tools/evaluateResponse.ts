import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const model = openai("gpt-5-mini");
import {
  type EvaluatedResponse,
  type QuestionScore,
  type SupportedLanguage,
} from "../types/digitalReadiness";

// ─────────────────────────────────────────────────────────────────────────────
// Input schema
// ─────────────────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  questionId: z.string(),
  question: z.string(),
  expectedReasoning: z.string(),
  acceptableKeywords: z.array(z.string()),
  userAnswer: z.string(),
  language: z.enum(["en", "ha", "ig", "yo"]).default("en"),
  childMode: z.boolean().default(false),
  supportMode: z.boolean().default(false),
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the evaluation prompt for the LLM.
 *
 * The LLM is used here rather than simple keyword matching because:
 * 1. Users in low-literacy contexts may express correct reasoning in non-standard ways.
 * 2. Keyword matching cannot capture partial credit nuance.
 * 3. Multi-language answers need semantic evaluation, not string comparison.
 */
function buildEvaluationPrompt(
  question: string,
  expectedReasoning: string,
  acceptableKeywords: string[],
  userAnswer: string,
  language: SupportedLanguage,
  childMode: boolean,
  supportMode: boolean,
): string {
  const lenientInstruction =
    childMode || supportMode
      ? "Be generous in awarding partial credit. These users may not use precise language but show practical understanding."
      : "Award full credit only when the answer shows clear, practical reasoning aligned with the expected approach.";

  return `You are evaluating a digital literacy assessment response.

QUESTION ASKED:
"${question}"

EXPECTED REASONING (internal reference — do NOT reveal to user):
"${expectedReasoning}"

ACCEPTABLE KEYWORDS/CONCEPTS (may appear in any language):
${acceptableKeywords.map((k) => `- ${k}`).join("\n")}

USER'S ANSWER:
"${userAnswer}"

SCORING RULES:
- Score 100: The user's answer shows clear practical reasoning that aligns with the expected approach. They do not need to use exact words.
- Score 50:  The user shows some relevant understanding or intent but their answer is incomplete, vague, or partially correct.
- Score 0:   The user's answer shows no relevant reasoning, is blank, or is entirely off-topic.

${lenientInstruction}

IMPORTANT:
- The user may have answered in ${language === "en" ? "English" : language === "ha" ? "Hausa" : language === "ig" ? "Igbo" : "Yoruba"} or a mix of languages — evaluate the MEANING, not the language.
- Do NOT penalise grammatical errors or spelling mistakes.
- Do NOT penalise brevity — a short but correct answer scores 100.
- If the user answer is empty or only whitespace, score is 0.

RESPOND ONLY with a valid JSON object. No markdown, no explanation.
Schema:
{
  "score": 0 | 50 | 100,
  "feedback": "<one sentence explaining the score, written in ${language === "en" ? "English" : language === "ha" ? "Hausa" : language === "ig" ? "Igbo" : "Yoruba"}>"
}`;
}

/**
 * Fast path: if the answer is empty, return 0 immediately without an LLM call.
 */
function isEmptyAnswer(answer: string): boolean {
  return answer.trim().length === 0;
}

/**
 * Validate that the score value is one of the allowed discrete values.
 */
function assertValidScore(value: unknown): asserts value is QuestionScore {
  if (value !== 0 && value !== 50 && value !== 100) {
    throw new Error(
      `evaluateResponse: Invalid score value "${value}". Expected 0, 50, or 100.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────────────

export const evaluateResponseTool = createTool({
  id: "evaluateResponse",
  description:
    "Evaluates a single user answer against a situational question using LLM-based semantic reasoning. " +
    "Returns a typed EvaluatedResponse with a score of 0 (no credit), 50 (partial), or 100 (full credit). " +
    "Handles multi-language answers, empty answers, and applies lenient scoring in child/support mode.",
  inputSchema,
  execute: async (rawInput: any) => {
    const input = rawInput?.context ?? rawInput;
    const {
      questionId,
      question,
      expectedReasoning,
      acceptableKeywords,
      userAnswer,
      language,
      childMode,
      supportMode,
    } = input as any;

    // ── Fast path: empty answer ─────────────────────────────────────────────
    if (isEmptyAnswer(userAnswer)) {
      const result: EvaluatedResponse = {
        questionId,
        question,
        userAnswer,
        score: 0,
        feedback: "No answer was provided.",
      };
      return result;
    }

    const prompt = buildEvaluationPrompt(
      question,
      expectedReasoning,
      acceptableKeywords,
      userAnswer,
      language as SupportedLanguage,
      childMode,
      supportMode,
    );

    // ── Call the LLM via AI SDK generateText ─────────────────────────────────
    const { text: rawText } = await generateText({
      model,
      prompt,
      temperature: 0.1,
    });

    // ── Parse response ──────────────────────────────────────────────────────
    let parsed: { score: unknown; feedback: string };
    try {
      const cleaned = rawText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(
        `evaluateResponse: LLM returned non-JSON output.\nRaw: ${rawText.slice(0, 200)}`,
      );
    }

    // ── Validate score ──────────────────────────────────────────────────────
    // Coerce to number first in case LLM returns a string like "100"
    const scoreValue = Number(parsed.score);
    assertValidScore(scoreValue);

    const result: EvaluatedResponse = {
      questionId,
      question,
      userAnswer,
      score: scoreValue,
      feedback: String(parsed.feedback ?? ""),
    };

    return result;
  },
});
