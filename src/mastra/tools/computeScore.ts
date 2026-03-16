import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const model = openai("gpt-5-mini");
import {
  type ReadinessResult,
  type ReadinessLevel,
  type SupportedLanguage,
  SCORE_WEIGHTS,
  READINESS_THRESHOLDS,
} from "../types/digitalReadiness";

// ─────────────────────────────────────────────────────────────────────────────
// Input schema
// ─────────────────────────────────────────────────────────────────────────────

const evaluatedResponseSchema = z.object({
  questionId: z.string(),
  question: z.string(),
  userAnswer: z.string(),
  score: z.union([z.literal(0), z.literal(50), z.literal(100)]),
  feedback: z.string(),
});

const situationalQuestionSchema = z.object({
  id: z.string(),
  domain: z.string(),
  difficulty: z.string(),
  question: z.string(),
  expectedReasoning: z.string(),
  acceptableKeywords: z.array(z.string()),
});

const taskProfileSchema = z.object({
  taskName: z.string(),
  speedSignal: z.enum(["low", "medium", "high"]),
  accuracySignal: z.enum(["low", "medium", "high"]),
  errorSignal: z.enum(["low", "medium", "high"]),
  taskScore: z.number(),
  notes: z.array(z.string()),
});

const inputSchema = z.object({
  behavioralProfile: z.object({
    tasks: z.array(taskProfileSchema),
    behavioralScore: z.number(),
    dominantWeaknesses: z.array(z.string()),
    difficultyTier: z.enum(["low", "medium", "high"]),
    ageContext: z.enum(["child", "adult", "unknown"]),
    childMode: z.boolean(),
    supportMode: z.boolean(),
    language: z.enum(["en", "ha", "ig", "yo"]),
  }),
  evaluatedResponses: z.array(evaluatedResponseSchema),
  generatedQuestions: z.array(situationalQuestionSchema),
  assessmentStartTime: z.number(), // Unix timestamp ms — used for duration
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify the final score into a ReadinessLevel using PRD thresholds.
 */
function classifyLevel(score: number): ReadinessLevel {
  for (const band of READINESS_THRESHOLDS) {
    if (score >= band.min && score <= band.max) return band.level;
  }
  return "Beginner"; // fallback (score = 0 edge case)
}

/**
 * Compute the Knowledge Score as the average of individual question scores.
 * Returns 0 if no responses were evaluated.
 */
function computeKnowledgeScore(
  responses: z.infer<typeof evaluatedResponseSchema>[],
): number {
  if (responses.length === 0) return 0;
  const total = responses.reduce((sum, r) => sum + r.score, 0);
  return Math.round(total / responses.length);
}

/**
 * Build the narrative prompt for the LLM to generate the human-facing report.
 *
 * The LLM is used here because:
 * - Generating warm, natural-language summaries with cultural sensitivity requires reasoning.
 * - The output must be in the user's language (Hausa, Igbo, Yoruba, or English).
 * - Strengths/weaknesses/recommendations must be personalized, not generic.
 */
function buildReportPrompt(
  behavioralScore: number,
  knowledgeScore: number,
  finalScore: number,
  level: ReadinessLevel,
  profile: z.infer<typeof inputSchema>["behavioralProfile"],
  responses: z.infer<typeof evaluatedResponseSchema>[],
  language: SupportedLanguage,
): string {
  const taskSummary = profile.tasks
    .map(
      (t) =>
        `  - ${t.taskName}: score ${t.taskScore}/100 (${t.notes.join("; ")})`,
    )
    .join("\n");

  const responseSummary = responses
    .map((r) => `  - Q: "${r.question}" → Score: ${r.score}/100`)
    .join("\n");

  const languageName =
    language === "en"
      ? "English"
      : language === "ha"
        ? "Hausa"
        : language === "ig"
          ? "Igbo"
          : "Yoruba";

  const childNote = profile.childMode
    ? "Note: This user is a child. Use simple, encouraging language appropriate for young learners."
    : "";

  const supportNote = profile.supportMode
    ? "Note: This user has very limited digital experience. Be warm, encouraging, and non-judgmental."
    : "";

  return `You are producing the final digital readiness assessment report for a real user.
Write everything in ${languageName}. This report will be shown directly to the user — make it warm, clear, and personal.

ASSESSMENT DATA (internal — do not expose raw numbers in the report):
  Behavioral Score  : ${behavioralScore}/100
  Knowledge Score   : ${knowledgeScore}/100
  Final Score       : ${finalScore}/100
  Readiness Level   : ${level}
  Age Context       : ${profile.ageContext}
  Child Mode        : ${profile.childMode}
  Support Mode      : ${profile.supportMode}

TASK PERFORMANCE (use this to personalize the report — do not list raw scores):
${taskSummary}

QUESTION RESPONSES (use this to personalize strengths and weaknesses):
${responseSummary}

${childNote}
${supportNote}

INSTRUCTIONS:
Respond ONLY with a valid JSON object. No markdown, no preamble, no extra keys.

{
  "summary": "<3–5 sentence opening that tells the user what their result means in plain, encouraging language. Mention their readiness level by name (${level}). Do not mention raw numbers. Speak directly to them — say 'you' not 'the user'.>",
  "reasoning": "<2–3 sentences explaining WHY they received this result, grounded in their specific task performance and question responses. Be specific — mention which tasks went well and which were harder.>",
  "strengths": [
    "<Strength 1: a full sentence describing something concrete the user did well, with context>",
    "<Strength 2: another specific strength observed in their performance>",
    "<Strength 3: optional — only include if genuinely earned>"
  ],
  "weaknesses": [
    "<Weakness 1: a full sentence describing a specific gap, written respectfully and constructively — frame as 'an area to grow in', not a failure>",
    "<Weakness 2: another specific gap with context>",
    "<Weakness 3: optional — only include if genuinely relevant>"
  ],
  "improvementRecommendations": [
    "<Recommendation 1: a specific, practical, actionable next step — include what to do, how to start, and why it will help>",
    "<Recommendation 2: another specific step — prefer accessible resources (free videos, community classes, practice apps)>",
    "<Recommendation 3: a third step focused on building confidence and daily practice>",
    "<Recommendation 4: optional — only include if genuinely useful>"
  ],
  "closingMessage": "<1–2 sentence warm closing that encourages the user and reminds them that digital skills are learned over time. Appropriate for their age and readiness level.>"
}

TONE RULES:
- Write as if speaking directly to the user. Use "you" and "your".
- Be warm, specific, and encouraging — even for low scores.
- Never use technical jargon. No mention of "metrics", "scores", "behavioral profile", or "tokens".
- For children (childMode=true): use simple words, celebrate effort, keep it fun.
- For support mode users: be especially gentle and focus on what they CAN do.
- Write everything in ${languageName}. Do not fall back to English for any field.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────────────

export const computeScoreTool = createTool({
  id: "computeScore",
  description:
    "Computes the final Digital Readiness Score by applying the 50/50 weighting formula to the " +
    "behavioral and knowledge scores. Classifies the user into Beginner/Basic/Intermediate/Advanced. " +
    "Uses the LLM to generate a personalized, language-appropriate narrative report with strengths, " +
    "weaknesses, and actionable improvement recommendations. Returns the complete ReadinessResult.",
  inputSchema,
  execute: async (rawInput: any) => {
    const input = rawInput?.context ?? rawInput;
    const {
      behavioralProfile,
      evaluatedResponses,
      generatedQuestions,
      assessmentStartTime,
    } = input as any;

    const language = behavioralProfile.language as SupportedLanguage;

    // ── Step 1: Compute scores ───────────────────────────────────────────────
    const behavioralScore = behavioralProfile.behavioralScore;
    const knowledgeScore = computeKnowledgeScore(evaluatedResponses);

    const finalScore = Math.round(
      behavioralScore * SCORE_WEIGHTS.behavioral +
        knowledgeScore * SCORE_WEIGHTS.knowledge,
    );

    const readinessLevel = classifyLevel(finalScore);

    const reportPrompt = buildReportPrompt(
      behavioralScore,
      knowledgeScore,
      finalScore,
      readinessLevel,
      behavioralProfile,
      evaluatedResponses,
      language,
    );

    // ── Step 2: Generate narrative via AI SDK generateText ──────────────────
    const rawResponse = await generateText({
      model,
      prompt: reportPrompt,
      temperature: 0.5,
    });

    // ── Step 3: Parse narrative ──────────────────────────────────────────────
    let narrative: {
      summary: string;
      reasoning: string;
      strengths: string[];
      weaknesses: string[];
      improvementRecommendations: string[];
      closingMessage: string;
    };

    try {
      const cleaned = rawResponse.text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      narrative = JSON.parse(cleaned);
    } catch {
      // Graceful fallback: if narrative generation fails, provide minimal defaults
      console.warn(
        "[computeScore] Narrative parsing failed. Using fallback defaults.",
      );
      narrative = {
        summary:
          "You have completed the digital readiness assessment. Your results are ready.",
        reasoning:
          "Your performance across the interaction tasks and knowledge questions has been reviewed.",
        strengths: [
          "You completed the full assessment — that takes courage and commitment",
        ],
        weaknesses: ["Some areas of digital interaction need more practice"],
        improvementRecommendations: [
          "Spend a few minutes each day exploring your phone's features",
          "Ask a friend or family member to show you how they use their phone",
          "Look for a local digital literacy class or community training program",
        ],
        closingMessage:
          "Remember — digital skills take time to build. Every step you take brings you closer to feeling confident with technology.",
      };
    }

    // ── Step 4: Assemble the full generatedQuestions array ───────────────────
    // Merge: questions + user answers + scores into a single array
    const questionsWithAnswers = generatedQuestions.map((q: { id: any }) => {
      const evaluated = evaluatedResponses.find(
        (r: { questionId: any }) => r.questionId === q.id,
      );
      return {
        ...q,
        userAnswer: evaluated?.userAnswer ?? "",
        score: (evaluated?.score ?? 0) as 0 | 50 | 100,
      };
    });

    // ── Step 5: Compute assessment duration ─────────────────────────────────
    const assessmentDurationMs = Date.now() - assessmentStartTime;

    // ── Step 6: Assemble final result ────────────────────────────────────────
    const result: ReadinessResult = {
      readinessScore: finalScore,
      readinessLevel,
      behavioralScore,
      knowledgeScore,
      summary: narrative.summary ?? "",
      reasoning: narrative.reasoning,
      strengths: narrative.strengths ?? [],
      weaknesses: narrative.weaknesses ?? [],
      improvementRecommendations: narrative.improvementRecommendations ?? [],
      closingMessage: narrative.closingMessage ?? "",
      generatedQuestions: questionsWithAnswers,
      metadata: {
        language,
        ageContext: behavioralProfile.ageContext,
        childMode: behavioralProfile.childMode,
        supportMode: behavioralProfile.supportMode,
        assessmentDurationMs,
      },
    };

    return result;
  },
});
