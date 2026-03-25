import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { digitalReadinessAgent } from "../agents/digital-readiness-agent";
import { analyzeMetricsTool } from "../tools/analyzeMetrics";
import { generateQuestionsTool } from "../tools/generateQuestions";
import { evaluateResponseTool } from "../tools/evaluateResponse";
import { computeScoreTool } from "../tools/computeScore";
import {
  type MetricsPayload,
  type BehavioralProfile,
  type SituationalQuestion,
  type EvaluatedResponse,
  type ReadinessResult,
  type SupportedLanguage,
} from "../types/digitalReadiness";

// ─────────────────────────────────────────────────────────────────────────────
// Shared Zod schemas (re-used across step input/output definitions)
// ─────────────────────────────────────────────────────────────────────────────

const rawTaskMetricSchema = z.object({
  taskName: z.string(),
  taskStartTime: z.number(),
  taskCompletionTime: z.number(),
  timeTaken: z.number(),
  errors: z.number(),
  retries: z.number(),
  tapAccuracy: z.number().optional(),
  navigationMistakes: z.number().optional(),
  additionalData: z
    .object({ age: z.string().optional() })
    .passthrough()
    .optional(),
});

const taskProfileSchema = z.object({
  taskName: z.string(),
  speedSignal: z.enum(["low", "medium", "high"]),
  accuracySignal: z.enum(["low", "medium", "high"]),
  errorSignal: z.enum(["low", "medium", "high"]),
  taskScore: z.number(),
  notes: z.array(z.string()),
});

const behavioralProfileSchema = z.object({
  tasks: z.array(taskProfileSchema),
  behavioralScore: z.number(),
  dominantWeaknesses: z.array(
    z.enum([
      "app_opening",
      "messaging",
      "internet_search",
      "form_filling",
      "settings_navigation",
      "app_download",
      "online_safety",
      "digital_payments",
    ]),
  ),
  difficultyTier: z.enum(["low", "medium", "high"]),
  ageContext: z.enum(["child", "adult", "unknown"]),
  childMode: z.boolean(),
  supportMode: z.boolean(),
  language: z.enum(["en", "ha", "ig", "yo"]),
});

const situationalQuestionSchema = z.object({
  id: z.string(),
  domain: z.enum([
    "app_opening",
    "messaging",
    "internet_search",
    "form_filling",
    "settings_navigation",
    "app_download",
    "online_safety",
    "digital_payments",
  ]),
  difficulty: z.enum(["low", "medium", "high"]),
  question: z.string(),
  expectedReasoning: z.string(),
  acceptableKeywords: z.array(z.string()),
});

const userAnswerSchema = z.object({
  questionId: z.string(),
  answer: z.string(),
});

const evaluatedResponseSchema = z.object({
  questionId: z.string(),
  question: z.string(),
  userAnswer: z.string(),
  score: z.union([z.literal(0), z.literal(50), z.literal(100)]),
  feedback: z.string(),
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — validate-payload
//
// Ensures the incoming metrics payload is structurally valid before any
// processing begins. Fails fast with a descriptive error if required fields
// are missing or malformed. This is a deterministic step — no LLM call.
// ─────────────────────────────────────────────────────────────────────────────

const validatePayloadStep = createStep({
  id: "validate-payload",
  description:
    "Validates the incoming metrics payload schema before processing.",

  inputSchema: z.object({
    allMetrics: z
      .array(rawTaskMetricSchema)
      .min(1, "At least one task metric is required"),
    languageInUse: z.enum(["en", "ha", "ig", "yo"]).default("en"),
  }),

  outputSchema: z.object({
    allMetrics: z.array(rawTaskMetricSchema),
    languageInUse: z.enum(["en", "ha", "ig", "yo"]),
    assessmentStartTime: z.number(),
    isValid: z.boolean(),
  }),

  execute: async ({ inputData }) => {
    const triggerData = inputData as MetricsPayload;
    const { allMetrics, languageInUse } = triggerData;

    // Surface-level checks beyond Zod schema
    const knownTasks = [
      "Scroll Test",
      "Tap Accuracy Test",
      "Navigation Test",
      "Multi-Step Test",
      "Form Completion",
    ];

    const unknownTasks = allMetrics.filter(
      (m: { taskName: string }) => !knownTasks.includes(m.taskName),
    );

    if (unknownTasks.length > 0) {
      console.warn(
        `[validate-payload] Unknown task names detected: ${unknownTasks
          .map((t: { taskName: string }) => t.taskName)
          .join(", ")}. These will use default baselines.`,
      );
    }

    return {
      allMetrics,
      languageInUse: languageInUse ?? "en",
      assessmentStartTime: Date.now(),
      isValid: true,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — enrich-context
//
// Extracts supplementary context from the payload: age, detected language,
// and sets a human-readable session label. Deterministic — no LLM call.
// ─────────────────────────────────────────────────────────────────────────────

const enrichContextStep = createStep({
  id: "enrich-context",
  description:
    "Extracts age context and enriches the payload with session metadata.",

  inputSchema: z.object({
    allMetrics: z.array(rawTaskMetricSchema),
    languageInUse: z.enum(["en", "ha", "ig", "yo"]),
    assessmentStartTime: z.number(),
  }),
  outputSchema: z.object({
    allMetrics: z.array(rawTaskMetricSchema),
    languageInUse: z.enum(["en", "ha", "ig", "yo"]),
    assessmentStartTime: z.number(),
    detectedAge: z.string().nullable(),
    sessionLabel: z.string(),
  }),

  execute: async ({ inputData }) => {
    const { allMetrics, languageInUse, assessmentStartTime } = inputData;

    // Extract age from Form Completion task if present
    const formTask = allMetrics.find(
      (m: { taskName: string }) => m.taskName === "Form Completion",
    );
    const detectedAge = formTask?.additionalData?.age ?? null;

    // Build a human-readable session label for logging/observability
    const langLabels: Record<string, string> = {
      en: "English",
      ha: "Hausa",
      ig: "Igbo",
      yo: "Yoruba",
    };
    const sessionLabel = `Assessment [${langLabels[languageInUse] ?? "English"}]${
      detectedAge ? ` | Age: ${detectedAge}` : ""
    } | ${new Date(assessmentStartTime).toISOString()}`;

    console.info(`[enrich-context] ${sessionLabel}`);

    return {
      allMetrics,
      languageInUse,
      assessmentStartTime,
      detectedAge,
      sessionLabel,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — analyze-metrics
//
// Calls the analyzeMetrics tool via the agent to produce a typed
// BehavioralProfile. This is deterministic logic wrapped in a tool call —
// no LLM inference happens inside analyzeMetrics itself.
// ─────────────────────────────────────────────────────────────────────────────

const analyzeMetricsStep = createStep({
  id: "analyze-metrics",
  description:
    "Runs the analyzeMetrics tool to produce a BehavioralProfile from raw task data.",
  inputSchema: z.object({
    allMetrics: z.array(rawTaskMetricSchema),
    languageInUse: z.enum(["en", "ha", "ig", "yo"]),
  }),

  outputSchema: z.object({
    behavioralProfile: behavioralProfileSchema,
  }),

  execute: async ({ inputData }) => {
    const { allMetrics, languageInUse } = inputData;

    const result = await analyzeMetricsTool.execute!(
      {
        allMetrics,
        languageInUse,
      },
      {},
    );

    console.info(
      `[analyze-metrics] BehavioralScore: ${result.behavioralScore} | ` +
        `Difficulty: ${result.difficultyTier} | ` +
        `ChildMode: ${result.childMode} | ` +
        `SupportMode: ${result.supportMode}`,
    );

    return { behavioralProfile: result as BehavioralProfile };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — calibrate-difficulty
//
// Applies any override rules to the difficulty tier before question generation.
// Deterministic. Separated from analyze-metrics to keep each step single-purpose
// and to make it easy to inject future business rules (e.g. NGO-specific overrides).
// ─────────────────────────────────────────────────────────────────────────────

const calibrateDifficultyStep = createStep({
  id: "calibrate-difficulty",
  description:
    "Applies override rules to difficulty and selects the final question count.",

  inputSchema: z.object({
    behavioralProfile: behavioralProfileSchema,
  }),

  outputSchema: z.object({
    behavioralProfile: behavioralProfileSchema,
    questionCount: z.number(),
    difficultyOverrideApplied: z.boolean(),
  }),

  execute: async ({ inputData }) => {
    const { behavioralProfile } = inputData;
    let finalDifficulty = behavioralProfile.difficultyTier;
    let difficultyOverrideApplied = false;

    // Override rule: child mode caps at medium regardless of profile
    if (behavioralProfile.childMode && finalDifficulty === "high") {
      finalDifficulty = "medium";
      difficultyOverrideApplied = true;
      console.info("[calibrate-difficulty] Child mode override: high → medium");
    }

    // Override rule: support mode forces low
    if (behavioralProfile.supportMode && finalDifficulty !== "low") {
      finalDifficulty = "low";
      difficultyOverrideApplied = true;
      console.info("[calibrate-difficulty] Support mode override: → low");
    }

    // Question count: 3 for low difficulty (keep it short for struggling users),
    // 4 for medium, 5 for high
    const questionCountMap: Record<string, number> = {
      low: 3,
      medium: 4,
      high: 5,
    };
    const questionCount = questionCountMap[finalDifficulty] ?? 4;

    const calibratedProfile: BehavioralProfile = {
      ...behavioralProfile,
      difficultyTier: finalDifficulty as BehavioralProfile["difficultyTier"],
    };

    return {
      behavioralProfile: calibratedProfile,
      questionCount,
      difficultyOverrideApplied,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 — generate-questions
//
// Calls the generateQuestions tool (which uses the LLM) to produce
// situational questions adapted to the user's BehavioralProfile.
// Questions are produced in the user's language.
// ─────────────────────────────────────────────────────────────────────────────

const generateQuestionsStep = createStep({
  id: "generate-questions",
  description:
    "Generates adaptive situational questions using the LLM via the generateQuestions tool.",

  inputSchema: z.object({
    behavioralProfile: behavioralProfileSchema,
    questionCount: z.number(),
  }),

  outputSchema: z.object({
    questions: z.array(situationalQuestionSchema),
    questionCount: z.number(),
  }),

  execute: async ({ inputData }) => {
    const { behavioralProfile, questionCount } = inputData;

    const questions = await generateQuestionsTool.execute!(
      {
        behavioralProfile,
        questionCount,
      },
      {},
    );

    console.info(
      `[generate-questions] Generated ${questions.length} questions | ` +
        `Difficulty: ${behavioralProfile.difficultyTier} | ` +
        `Language: ${behavioralProfile.language}`,
    );

    return {
      questions: questions as SituationalQuestion[],
      questionCount: questions.length,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6 — collect-answers  ⏸ SUSPEND POINT
//
// The workflow suspends here after emitting the questions to the caller.
// The mobile app presents the questions to the user and collects their answers.
// When the app is ready, it calls workflow.resume() with the user's answers,
// which injects them as resumeData into this step's context.
//
// Resume payload shape:
//   { answers: [{ questionId: string, answer: string }] }
// ─────────────────────────────────────────────────────────────────────────────

const collectAnswersStep = createStep({
  id: "collect-answers",
  description:
    "Suspends the workflow and emits questions to the mobile app. " +
    "Resumes when the app delivers user answers via workflow.resume().",

  inputSchema: z.object({
    questions: z.array(situationalQuestionSchema),
    questionCount: z.number(),
  }),

  outputSchema: z.object({
    questions: z.array(situationalQuestionSchema),
    userAnswers: z.array(userAnswerSchema),
  }),

  // resumeSchema defines the shape of data expected when workflow.resume() is called
  resumeSchema: z.object({
    answers: z
      .array(userAnswerSchema)
      .min(1, "At least one answer is required to resume"),
  }),

  execute: async ({ inputData, suspend, resumeData }) => {
    const { questions } = inputData;

    if (!resumeData?.answers) {
      // ── First execution: suspend ──
      console.info(
        `[collect-answers] Suspending. Delivering ${questions.length} questions to caller.`,
      );

      await suspend({
        questions: questions.map((q: SituationalQuestion) => ({
          id: q.id,
          question: q.question,
          domain: q.domain,
          difficulty: q.difficulty,
        })),
        instruction:
          "Please answer all questions and call resume() with your answers.",
      });

      return { questions, userAnswers: [] };
    }

    // ── Resumed: validate and align answers with questions ──────────────────
    const { answers } = resumeData;

    const alignedAnswers = questions.map((q: SituationalQuestion) => {
      const provided = answers.find(
        (a: { questionId: string; answer: string }) => a.questionId === q.id,
      );
      return {
        questionId: q.id,
        answer: provided?.answer ?? "",
      };
    });

    console.info(
      `[collect-answers] Resumed with ${answers.length} answer(s) for ${questions.length} question(s).`,
    );

    return {
      questions,
      userAnswers: alignedAnswers,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7 — evaluate-responses
//
// Calls the evaluateResponse tool once per question-answer pair.
// Sequential execution is intentional — allows per-question logging and
// avoids overwhelming the LLM with parallel evaluation requests.
// ─────────────────────────────────────────────────────────────────────────────

const evaluateResponsesStep = createStep({
  id: "evaluate-responses",
  description:
    "Evaluates each user answer against its question using the LLM. Called once per question.",

  inputSchema: z.object({
    questions: z.array(situationalQuestionSchema),
    userAnswers: z.array(userAnswerSchema),
  }),

  outputSchema: z.object({
    evaluatedResponses: z.array(evaluatedResponseSchema),
    knowledgeScore: z.number(),
  }),

  execute: async ({ inputData, getStepResult }) => {
    const { questions, userAnswers } = inputData;

    const behavioralProfile = getStepResult(calibrateDifficultyStep);

    const evaluatedResponses: EvaluatedResponse[] = [];

    // Evaluate sequentially — predictable order, easier to debug
    for (const question of questions as SituationalQuestion[]) {
      const userAnswerEntry = userAnswers.find(
        (a: { questionId: string; answer: string }) =>
          a.questionId === question.id,
      );
      const userAnswer = userAnswerEntry?.answer ?? "";

      const result = await evaluateResponseTool.execute!(
        {
          questionId: question.id,
          question: question.question,
          expectedReasoning: question.expectedReasoning,
          acceptableKeywords: question.acceptableKeywords,
          userAnswer,
          language: behavioralProfile.language as SupportedLanguage,
          childMode: behavioralProfile.childMode,
          supportMode: behavioralProfile.supportMode,
        },
        {},
      );

      console.info(
        `[evaluate-responses] Q: "${question.id}" → Score: ${result.score}/100`,
      );

      evaluatedResponses.push(result as EvaluatedResponse);
    }

    // Compute knowledge score here for logging visibility
    const knowledgeScore =
      evaluatedResponses.length > 0
        ? Math.round(
            evaluatedResponses.reduce((sum, r) => sum + r.score, 0) /
              evaluatedResponses.length,
          )
        : 0;

    console.info(`[evaluate-responses] KnowledgeScore: ${knowledgeScore}/100`);

    return { evaluatedResponses, knowledgeScore };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 8 — compute-score
//
// Applies the 50/50 weighting formula, classifies the readiness level,
// and uses the LLM to generate the personalized narrative report
// (reasoning, strengths, weaknesses, recommendations) in the user's language.
// ─────────────────────────────────────────────────────────────────────────────

const computeScoreStep = createStep({
  id: "compute-score",
  description:
    "Computes the final score, classifies readiness level, and generates the narrative report.",

  inputSchema: z.object({
    evaluatedResponses: z.array(evaluatedResponseSchema),
    knowledgeScore: z.number(),
  }),

  outputSchema: z.object({
    result: z.object({
      readinessScore: z.number(),
      readinessLevel: z.enum(["Beginner", "Basic", "Intermediate", "Advanced"]),
      behavioralScore: z.number(),
      knowledgeScore: z.number(),
      reasoning: z.string(),
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
      improvementRecommendations: z.array(z.string()),
      generatedQuestions: z.array(z.any()),
      metadata: z.object({
        language: z.string(),
        ageContext: z.string(),
        childMode: z.boolean(),
        supportMode: z.boolean(),
        assessmentDurationMs: z.number(),
      }),
    }),
  }),

  execute: async ({ inputData, getStepResult }) => {
    const { knowledgeScore } = inputData;

    const { behavioralProfile } = getStepResult(calibrateDifficultyStep);

    const { evaluatedResponses } = getStepResult(evaluateResponsesStep);

    const { questions } = getStepResult(collectAnswersStep);

    const { assessmentStartTime } = getStepResult(enrichContextStep);

    const result = await computeScoreTool.execute!(
      {
        behavioralProfile,
        evaluatedResponses,
        generatedQuestions: questions,
        assessmentStartTime,
        knowledgeScore,
      },
      {},
    );

    console.info(
      `[compute-score] FinalScore: ${result.readinessScore}/100 | ` +
        `Level: ${result.readinessLevel} | ` +
        `Behavioral: ${result.behavioralScore} | ` +
        `Knowledge: ${result.knowledgeScore}`,
    );

    return { result: result as ReadinessResult };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 9 — format-output
//
// Final deterministic step. Shapes the result for the mobile app consumer:
// strips internal fields (expectedReasoning, acceptableKeywords) that should
// never be exposed to the user, and attaches the session label for logging.
// ─────────────────────────────────────────────────────────────────────────────

const formatOutputStep = createStep({
  id: "format-output",
  description:
    "Strips internal fields and shapes the final ReadinessResult for the mobile app.",

  outputSchema: z.object({
    readinessResult: z.object({
      readinessScore: z.number(),
      readinessLevel: z.enum(["Beginner", "Basic", "Intermediate", "Advanced"]),
      behavioralScore: z.number(),
      knowledgeScore: z.number(),
      reasoning: z.string(),
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
      improvementRecommendations: z.array(z.string()),
      questions: z.array(
        z.object({
          id: z.string(),
          domain: z.string(),
          question: z.string(),
          userAnswer: z.string(),
          score: z.number(),
        }),
      ),
      metadata: z.object({
        language: z.string(),
        ageContext: z.string(),
        childMode: z.boolean(),
        supportMode: z.boolean(),
        assessmentDurationMs: z.number(),
      }),
    }),
    sessionLabel: z.string(),
  }),

  execute: async ({ getStepResult }) => {
    const { result } = getStepResult(computeScoreStep);
    const { sessionLabel } = getStepResult(enrichContextStep);

    // Strip internal-only fields from questions before returning to mobile app
    const generatedQuestions = Array.isArray(result.generatedQuestions)
      ? result.generatedQuestions
      : [];

    const publicQuestions = generatedQuestions.map(
      (q: SituationalQuestion & { userAnswer?: string; score?: number }) => ({
        id: q.id,
        domain: q.domain,
        question: q.question,
        userAnswer: q.userAnswer ?? "",
        score: typeof q.score === "number" ? q.score : 0,
        // expectedReasoning and acceptableKeywords are intentionally omitted
      }),
    );

    const readinessResult = {
      readinessScore: result.readinessScore,
      readinessLevel: result.readinessLevel,
      behavioralScore: result.behavioralScore,
      knowledgeScore: result.knowledgeScore,
      reasoning: result.reasoning,
      strengths: result.strengths,
      weaknesses: result.weaknesses,
      improvementRecommendations: result.improvementRecommendations,
      questions: publicQuestions,
      metadata: result.metadata,
    };

    console.info(
      `[format-output] Assessment complete. ` +
        `Score: ${readinessResult.readinessScore} (${readinessResult.readinessLevel})`,
    );

    return { readinessResult, sessionLabel };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKFLOW — assemble all steps in order
// ─────────────────────────────────────────────────────────────────────────────

export const digitalReadinessWorkflow = createWorkflow({
  id: "digital-readiness-workflow",
  description:
    "Runs the full digital readiness assessment pipeline: validatePayloadStep -> enrichContextStep -> analyzeMetricsStep -> calibrateDifficultyStep -> generateQuestionsStep -> collectAnswersStep -> evaluateResponsesStep -> computeScoreStep -> formatOutputStep",
  inputSchema: z.object({
    allMetrics: z.array(rawTaskMetricSchema).min(1),
    languageInUse: z.enum(["en", "ha", "ig", "yo"]).default("en"),
  }),
  outputSchema: z.object({
    readinessResult: z.object({
      readinessScore: z.number(),
      readinessLevel: z.enum(["Beginner", "Basic", "Intermediate", "Advanced"]),
      behavioralScore: z.number(),
      knowledgeScore: z.number(),
      reasoning: z.string(),
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
      improvementRecommendations: z.array(z.string()),
      questions: z.array(
        z.object({
          id: z.string(),
          domain: z.string(),
          question: z.string(),
          userAnswer: z.string(),
          score: z.number(),
        }),
      ),
    }),
    sessionLabel: z.string(),
  }),
})
  .then(validatePayloadStep)
  .then(enrichContextStep)
  .then(analyzeMetricsStep)
  .then(calibrateDifficultyStep)
  .then(generateQuestionsStep)
  .then(collectAnswersStep) // ⏸ Workflow suspends here
  .then(evaluateResponsesStep) // ▶ Resumes here after app delivers answers
  .then(computeScoreStep)
  .then(formatOutputStep)
  .commit(); // Locks the step chain — required by Mastra
