import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { generateText } from "ai";
// import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";

const model = openai("gpt-4o-mini");
// const model = google("gemini-2.5-flash");)
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
  options: z.array(z.string()),
  correctAnswerIndex: z.number(),
  expectedReasoning: z.string(),
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
 * For MCQs, the score is determined deterministically in code.
 * We only use the LLM to generate localized, encouraging feedback
 * based on the user's specific selection.
 */
function buildEvaluationPrompt(
  question: string,
  options: string[],
  correctAnswerIndex: number,
  expectedReasoning: string,
  userAnswer: string,
  isCorrect: boolean,
  language: SupportedLanguage,
  childMode: boolean,
  supportMode: boolean,
): string {
  const languageName =
    language === "en"
      ? "English"
      : language === "ha"
        ? "Hausa"
        : language === "ig"
          ? "Igbo"
          : "Yoruba";

  return `You are providing feedback for a digital literacy assessment.

QUESTION ASKED:
"${question}"

OPTIONS:
${options.map((opt, i) => `${i}: ${opt}`).join("\n")}

CORRECT ANSWER:
Option ${correctAnswerIndex}: "${options[correctAnswerIndex]}"

USER'S SELECTED ANSWER:
"${userAnswer}"

EXPECTED REASONING (internal reference):
"${expectedReasoning}"

THE USER IS: ${isCorrect ? "CORRECT" : "INCORRECT"}

Based on the above, write a single encouraging sentence of feedback explaining why their answer is correct or incorrect.

IMPORTANT:
- The feedback MUST be written in ${languageName}.
- Keep it to ONE simple sentence.
- ${childMode || supportMode ? "Use very gentle, supportive language." : "Use clear, practical language."}

RESPOND ONLY with a valid JSON object. No markdown, no explanation.
Schema:
{
  "feedback": "<your one-sentence feedback in ${languageName}>"
}`;
}

/**
 * Fast path: if the answer is empty, return 0 immediately without an LLM call.
 */
function isEmptyAnswer(answer: string): boolean {
  return answer.trim().length === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────────────

export const evaluateResponseTool = createTool({
  id: "evaluateResponse",
  description:
    "Evaluates a single user MCQ answer against a situational question. " +
    "Calculates the score deterministically (100 or 0) and uses LLM to generate localized feedback. " +
    "Returns a typed EvaluatedResponse.",
  inputSchema,
  execute: async (rawInput: any) => {
    const input = rawInput?.context ?? rawInput;
    const {
      questionId,
      question,
      options,
      correctAnswerIndex,
      expectedReasoning,
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

    // ── Deterministic Scoring ───────────────────────────────────────────────
    const isCorrect =
      userAnswer === String(correctAnswerIndex) ||
      userAnswer.trim().toLowerCase() ===
        options[correctAnswerIndex].trim().toLowerCase();

    const scoreValue: QuestionScore = isCorrect ? 100 : 0;

    const prompt = buildEvaluationPrompt(
      question,
      options,
      correctAnswerIndex,
      expectedReasoning,
      userAnswer,
      isCorrect,
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
    let parsed: { feedback: string };
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
