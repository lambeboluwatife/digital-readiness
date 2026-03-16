import { digitalReadinessWorkflow } from "./src/mastra";

// ─────────────────────────────────────────────────────────────────────────────
// USAGE GUIDE — How to trigger and resume the workflow
//
// This file shows the two calls your backend API needs to make.
// It is NOT part of the workflow itself — include it in your API route layer
// (e.g. Express, Hono, Fastify, or a Next.js API route).
// ─────────────────────────────────────────────────────────────────────────────

// ── CALL 1: Start the assessment ─────────────────────────────────────────────
//
// Your backend receives the metrics payload from the mobile app and triggers
// the workflow. The workflow runs steps 1–5, then suspends at step 6.
// The suspended payload (questions) is returned to your API so you can
// send it back to the mobile app.
//
// POST /assessment/start
//   Body: MetricsPayload { allMetrics, languageInUse }
//   Returns: { runId, questions[] }
// ─────────────────────────────────────────────────────────────────────────────

export async function startAssessment(payload: {
  allMetrics: unknown[];
  languageInUse: "en" | "ha" | "ig" | "yo";
}) {
  const { runId, start } = await digitalReadinessWorkflow.createRun();

  // Start the workflow — it will run until the suspend() call in collect-answers
  const suspendedResult = await start({
    triggerData: payload,
  });

  // The suspended state contains the questions to show the user
  const suspendPayload = suspendedResult.activePaths.find(
    (p: { stepId: string }) => p.stepId === "collect-answers",
  )?.suspendPayload;

  return {
    runId, // Store this — needed to resume
    questions: suspendPayload?.questions ?? [],
    instruction: suspendPayload?.instruction,
  };
}

// ── CALL 2: Resume with user answers ─────────────────────────────────────────
//
// After the mobile app collects all answers, your backend resumes the workflow.
// The workflow runs steps 7–9 and returns the final ReadinessResult.
//
// POST /assessment/resume
//   Body: { runId, answers: [{ questionId, answer }] }
//   Returns: ReadinessResult
// ─────────────────────────────────────────────────────────────────────────────

export async function resumeAssessment(payload: {
  runId: string;
  answers: Array<{ questionId: string; answer: string }>;
}) {
  const { runId, answers } = payload;

  // Resume the workflow from the collect-answers suspend point
  const result = await digitalReadinessWorkflow.resume({
    runId,
    stepId: "collect-answers", // The step we suspended at
    resumeData: { answers }, // Injected as context.getResumeData() inside the step
  });

  // The final ReadinessResult is the output of the last step (format-output)
  const readinessResult =
    result.results?.["format-output"]?.output?.readinessResult;

  if (!readinessResult) {
    throw new Error(
      `[resumeAssessment] Workflow completed but no readinessResult found. ` +
        `Full result: ${JSON.stringify(result.results, null, 2)}`,
    );
  }

  return readinessResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE — Full assessment lifecycle in one function (for testing)
// ─────────────────────────────────────────────────────────────────────────────

export async function runFullAssessmentExample() {
  // Step A: Start
  const { runId, questions } = await startAssessment({
    allMetrics: [
      {
        taskName: "Scroll Test",
        taskStartTime: 1773397854531,
        taskCompletionTime: 1773397859977,
        timeTaken: 5446,
        errors: 0,
        retries: 0,
      },
      {
        taskName: "Tap Accuracy Test",
        taskStartTime: 1773397859979,
        taskCompletionTime: 1773397861079,
        timeTaken: 1100,
        errors: 0,
        retries: 0,
        tapAccuracy: 100,
      },
      {
        taskName: "Navigation Test",
        taskStartTime: 1773397861595,
        taskCompletionTime: 1773397862571,
        timeTaken: 976,
        errors: 0,
        retries: 0,
        navigationMistakes: 0,
      },
      {
        taskName: "Multi-Step Test",
        taskStartTime: 1773397863085,
        taskCompletionTime: 1773397867111,
        timeTaken: 4026,
        errors: 1,
        retries: 0,
        navigationMistakes: 1,
      },
      {
        taskName: "Form Completion",
        taskStartTime: 1773397867619,
        taskCompletionTime: 1773397873602,
        timeTaken: 5983,
        errors: 0,
        retries: 0,
        additionalData: { age: "28" },
      },
    ],
    languageInUse: "en",
  });

  console.log("Workflow started. Run ID:", runId);
  console.log("Questions to show user:", JSON.stringify(questions, null, 2));

  // Step B: Simulate user answering (in production this is async — the mobile app sends answers)
  const simulatedAnswers = questions.map((q: { id: string }) => ({
    questionId: q.id,
    answer: "I would tap the icon on my screen to open the app.",
  }));

  // Step C: Resume
  const readinessResult = await resumeAssessment({
    runId,
    answers: simulatedAnswers,
  });

  console.log("Final result:", JSON.stringify(readinessResult, null, 2));
  return readinessResult;
}
