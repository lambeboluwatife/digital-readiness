// ─────────────────────────────────────────────────────────────────────────────
// Digital Readiness Assessment — Shared Types
// ─────────────────────────────────────────────────────────────────────────────

// ── Supported languages ──────────────────────────────────────────────────────
export type SupportedLanguage = "en" | "ha" | "ig" | "yo";

// ── Readiness levels aligned with PRD scoring bands ──────────────────────────
export type ReadinessLevel = "Beginner" | "Basic" | "Intermediate" | "Advanced";

// ── Difficulty tiers for situational questions ────────────────────────────────
export type DifficultyTier = "low" | "medium" | "high";

// ── Signal strength used in behavioral profiling ─────────────────────────────
export type SignalStrength = "low" | "medium" | "high";

// ── Age context resolved from Form Completion additionalData ─────────────────
export type AgeContext = "child" | "adult" | "unknown";

// ── Question domains ─────────────────────────────────────────────────────────
export type QuestionDomain =
  | "app_opening"
  | "messaging"
  | "internet_search"
  | "form_filling"
  | "settings_navigation"
  | "app_download"
  | "online_safety"
  | "digital_payments";

// ─────────────────────────────────────────────────────────────────────────────
// INPUT — Raw metrics from the mobile app
// ─────────────────────────────────────────────────────────────────────────────

export interface RawTaskMetric {
  taskName: string;
  taskStartTime: number;
  taskCompletionTime: number;
  timeTaken: number;
  errors: number;
  retries: number;
  tapAccuracy?: number; // Only on Tap Accuracy Test (0–100)
  navigationMistakes?: number; // Only on Navigation and Multi-Step tasks
  additionalData?: {
    age?: string; // Provided in Form Completion
    [key: string]: unknown;
  };
}

export interface MetricsPayload {
  allMetrics: RawTaskMetric[];
  languageInUse: SupportedLanguage;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERMEDIATE — Behavioral Profile (output of analyzeMetrics)
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskProfile {
  taskName: string;
  speedSignal: SignalStrength;
  accuracySignal: SignalStrength;
  errorSignal: SignalStrength; // "high" means many errors — bad signal
  taskScore: number; // 0–100 numeric score for this task
  notes: string[]; // Human-readable observations about this task
}

export interface BehavioralProfile {
  tasks: TaskProfile[];
  behavioralScore: number; // 0–100 aggregate
  dominantWeaknesses: QuestionDomain[]; // Domains to target in questions
  difficultyTier: DifficultyTier;
  ageContext: AgeContext;
  childMode: boolean;
  supportMode: boolean;
  language: SupportedLanguage;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERMEDIATE — Generated situational questions
// ─────────────────────────────────────────────────────────────────────────────

export interface SituationalQuestion {
  id: string;
  domain: QuestionDomain;
  difficulty: DifficultyTier;
  question: string; // In target language
  expectedReasoning: string; // Internal — not shown to user
  acceptableKeywords: string[]; // Internal — used by evaluateResponse
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERMEDIATE — Evaluated question response
// ─────────────────────────────────────────────────────────────────────────────

export type QuestionScore = 0 | 50 | 100;

export interface EvaluatedResponse {
  questionId: string;
  question: string;
  userAnswer: string;
  score: QuestionScore; // 0 = no credit, 50 = partial, 100 = full
  feedback: string; // Internal reasoning for this score
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT — Final ReadinessResult returned to the mobile app
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadinessResult {
  readinessScore: number; // 0–100 final weighted score
  readinessLevel: ReadinessLevel;
  behavioralScore: number; // 0–100
  knowledgeScore: number; // 0–100
  summary: string; // Opening paragraph shown directly to user
  reasoning: string; // Why they got this result, grounded in their data
  strengths: string[]; // 1–3 full-sentence positive observations
  weaknesses: string[]; // 1–3 full-sentence constructive gaps
  improvementRecommendations: string[]; // 2–4 specific, actionable next steps
  closingMessage: string; // Warm closing sentence shown to user
  generatedQuestions: Array<
    SituationalQuestion & {
      userAnswer: string;
      score: QuestionScore;
    }
  >;
  metadata: {
    language: SupportedLanguage;
    ageContext: AgeContext;
    childMode: boolean;
    supportMode: boolean;
    assessmentDurationMs: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS — Task baselines and scoring weights
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expected baseline durations in milliseconds for each task.
 * These represent the "comfortable but not rushed" range for an adult
 * with moderate digital experience. Times above 2× baseline trigger
 * a speed penalty; times between 1.5× and 2× trigger a partial penalty.
 */
export const TASK_BASELINES: Record<string, number> = {
  "Scroll Test": 6000,
  "Tap Accuracy Test": 2000,
  "Navigation Test": 2000,
  "Multi-Step Test": 5000,
  "Form Completion": 8000,
};

/**
 * Score weight split between behavioral and knowledge components.
 * Must sum to 1.
 */
export const SCORE_WEIGHTS = {
  behavioral: 0.5,
  knowledge: 0.5,
} as const;

/**
 * Readiness level thresholds aligned with the PRD.
 */
export const READINESS_THRESHOLDS: Array<{
  min: number;
  max: number;
  level: ReadinessLevel;
}> = [
  { min: 0, max: 30, level: "Beginner" },
  { min: 31, max: 60, level: "Basic" },
  { min: 61, max: 80, level: "Intermediate" },
  { min: 81, max: 100, level: "Advanced" },
];
