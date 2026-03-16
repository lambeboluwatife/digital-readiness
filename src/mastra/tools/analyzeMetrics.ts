import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  type BehavioralProfile,
  type TaskProfile,
  type QuestionDomain,
  type SignalStrength,
  type AgeContext,
  type DifficultyTier,
  type SupportedLanguage,
  TASK_BASELINES,
} from "../types/digitalReadiness";

// ─────────────────────────────────────────────────────────────────────────────
// Zod input schema — mirrors MetricsPayload
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
    .object({
      age: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

const inputSchema = z.object({
  allMetrics: z.array(rawTaskMetricSchema).min(1),
  languageInUse: z.enum(["en", "ha", "ig", "yo"]).default("en"),
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify speed relative to the task's expected baseline.
 * Returns "high" (fast = good), "medium", or "low" (slow = bad).
 */
function classifySpeed(timeTaken: number, baseline: number): SignalStrength {
  if (timeTaken <= baseline) return "high";
  if (timeTaken <= baseline * 1.5) return "medium";
  return "low";
}

/**
 * Classify accuracy for tap-based tasks.
 * tapAccuracy is 0–100; higher is better.
 */
function classifyTapAccuracy(accuracy: number | undefined): SignalStrength {
  if (accuracy === undefined) return "medium"; // neutral if field absent
  if (accuracy >= 90) return "high";
  if (accuracy >= 70) return "medium";
  return "low";
}

/**
 * Classify error count — note: "high" errorSignal = many errors = BAD.
 */
function classifyErrors(errors: number): SignalStrength {
  if (errors === 0) return "low"; // low errors = good
  if (errors <= 2) return "medium";
  return "high"; // many errors = bad
}

/**
 * Compute a 0–100 numeric score for one task.
 *
 * Penalty breakdown (all capped to prevent below-zero scores):
 *   Speed:    -30 if >2× baseline, -15 if >1.5× baseline
 *   Errors:    -5 per error, capped at -40
 *   Retries:  -10 per retry, capped at -30
 *   Tap acc:  -20 if <70%, -10 if <85%
 *   Nav mis:  -10 if >1 mistake
 */
function computeTaskScore(
  timeTaken: number,
  baseline: number,
  errors: number,
  retries: number,
  tapAccuracy?: number,
  navigationMistakes?: number,
): number {
  let score = 100;

  // Speed penalty
  if (timeTaken > baseline * 2) score -= 30;
  else if (timeTaken > baseline * 1.5) score -= 15;

  // Error penalty
  score -= Math.min(errors * 5, 40);

  // Retry penalty
  score -= Math.min(retries * 10, 30);

  // Tap accuracy penalty
  if (tapAccuracy !== undefined) {
    if (tapAccuracy < 70) score -= 20;
    else if (tapAccuracy < 85) score -= 10;
  }

  // Navigation mistake penalty
  if (navigationMistakes !== undefined && navigationMistakes > 1) {
    score -= 10;
  }

  return Math.max(score, 0);
}

/**
 * Map a low-performing task name to the most relevant question domain(s).
 * Used to focus the situational questions on the user's real weaknesses.
 */
function taskToDomains(taskName: string): QuestionDomain[] {
  const map: Record<string, QuestionDomain[]> = {
    "Scroll Test": ["app_opening", "settings_navigation"],
    "Tap Accuracy Test": ["app_opening", "form_filling"],
    "Navigation Test": ["settings_navigation", "app_download"],
    "Multi-Step Test": ["internet_search", "messaging"],
    "Form Completion": ["form_filling", "digital_payments"],
  };
  return map[taskName] ?? ["app_opening"];
}

/**
 * Resolve the user's age context from Form Completion additionalData.
 */
function resolveAgeContext(allMetrics: z.infer<typeof rawTaskMetricSchema>[]): {
  ageContext: AgeContext;
  isChild: boolean;
} {
  const formTask = allMetrics.find((m) => m.taskName === "Form Completion");
  const rawAge = formTask?.additionalData?.age;

  if (!rawAge) return { ageContext: "unknown", isChild: false };

  const age = parseInt(rawAge, 10);
  if (isNaN(age)) return { ageContext: "unknown", isChild: false };
  if (age < 13) return { ageContext: "child", isChild: true };
  return { ageContext: "adult", isChild: false };
}

/**
 * Determine the difficulty tier for question generation.
 * Rules (from design doc):
 *   - childMode  → always "low" or "medium"
 *   - supportMode → always "low"
 *   - Otherwise  → derived from aggregate low-signal count
 */
function resolveDifficultyTier(
  tasks: TaskProfile[],
  childMode: boolean,
  supportMode: boolean,
): DifficultyTier {
  if (supportMode) return "low";
  if (childMode) return "low"; // Start children at low; upgrade to medium in generateQuestions if scores are high

  const lowSignalCount = tasks.filter(
    (t) => t.speedSignal === "low" || t.errorSignal === "high",
  ).length;

  if (lowSignalCount >= 3) return "low";
  if (lowSignalCount >= 1) return "medium";
  return "high";
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────────────

export const analyzeMetricsTool = createTool({
  id: "analyzeMetrics",
  description:
    "Parses raw mobile interaction metrics from the assessment app and returns a structured BehavioralProfile. " +
    "This profile includes per-task signal classifications, an aggregate behavioral score (0–100), " +
    "dominant weakness domains to target with situational questions, the calibrated question difficulty tier, " +
    "and context flags (childMode, supportMode).",
  inputSchema,
  execute: async (rawInput: any) => {
    const input = rawInput?.context ?? rawInput;
    const { allMetrics, languageInUse } = input as {
      allMetrics: any[];
      languageInUse: string;
    };

    // ── Step 1: Profile each task individually ──────────────────────────────
    interface TaskNotes {
      taskName: string;
      speedSignal: SignalStrength;
      accuracySignal: SignalStrength;
      errorSignal: SignalStrength;
      taskScore: number;
      notes: string[];
    }

    const tasks: TaskProfile[] = allMetrics.map(
      (metric: z.infer<typeof rawTaskMetricSchema>): TaskNotes => {
        const baseline: number = TASK_BASELINES[metric.taskName] ?? 5000;

        const speedSignal: SignalStrength = classifySpeed(
          metric.timeTaken,
          baseline,
        );
        const accuracySignal: SignalStrength = classifyTapAccuracy(
          metric.tapAccuracy,
        );
        const errorSignal: SignalStrength = classifyErrors(metric.errors);

        const taskScore: number = computeTaskScore(
          metric.timeTaken,
          baseline,
          metric.errors,
          metric.retries,
          metric.tapAccuracy,
          metric.navigationMistakes,
        );

        // Build human-readable notes for transparency/debugging
        const notes: string[] = [];
        if (speedSignal === "low")
          notes.push(
            `Slow completion: ${metric.timeTaken}ms vs ${baseline}ms baseline`,
          );
        if (errorSignal === "high")
          notes.push(`High errors: ${metric.errors} errors recorded`);
        if (metric.retries > 0) notes.push(`Retried ${metric.retries} time(s)`);
        if (metric.tapAccuracy !== undefined && metric.tapAccuracy < 85)
          notes.push(`Low tap accuracy: ${metric.tapAccuracy}%`);
        if (metric.navigationMistakes && metric.navigationMistakes > 1)
          notes.push(`Navigation mistakes: ${metric.navigationMistakes}`);
        if (notes.length === 0)
          notes.push("Task completed within expected parameters");

        return {
          taskName: metric.taskName,
          speedSignal,
          accuracySignal,
          errorSignal,
          taskScore,
          notes,
        };
      },
    );

    // ── Step 2: Compute aggregate behavioral score ──────────────────────────
    const behavioralScore = Math.round(
      tasks.reduce((sum, t) => sum + t.taskScore, 0) / tasks.length,
    );

    // ── Step 3: Detect context flags ────────────────────────────────────────
    const { ageContext, isChild } = resolveAgeContext(allMetrics);

    const lowSpeedHighErrorTasks = tasks.filter(
      (t) => t.speedSignal === "low" && t.errorSignal === "high",
    );
    const supportMode = lowSpeedHighErrorTasks.length >= 3;
    const childMode = isChild;

    // ── Step 4: Resolve difficulty tier ─────────────────────────────────────
    const difficultyTier = resolveDifficultyTier(tasks, childMode, supportMode);

    // ── Step 5: Identify dominant weakness domains ──────────────────────────
    // Target domains from the 2 lowest-scoring tasks
    const weakTasks = [...tasks]
      .sort((a, b) => a.taskScore - b.taskScore)
      .slice(0, 2);

    const domainSet = new Set<QuestionDomain>();
    for (const t of weakTasks) {
      for (const domain of taskToDomains(t.taskName)) {
        domainSet.add(domain);
      }
    }

    // Always include online_safety for adults unless child mode
    if (!childMode) domainSet.add("online_safety");

    const dominantWeaknesses = Array.from(domainSet).slice(
      0,
      4,
    ) as QuestionDomain[];

    // ── Assemble and return the BehavioralProfile ────────────────────────────
    const profile: BehavioralProfile = {
      tasks,
      behavioralScore,
      dominantWeaknesses,
      difficultyTier,
      ageContext,
      childMode,
      supportMode,
      language: languageInUse as SupportedLanguage,
    };

    return profile;
  },
});
