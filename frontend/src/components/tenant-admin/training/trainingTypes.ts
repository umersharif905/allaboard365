export type TrainingAttachmentType = 'pdf' | 'link' | 'video' | 'audio';

export type TrainingPackageStatus = 'Draft' | 'Active' | 'Archived';

export type TrainingQuestionOrdinal = string;

export type TrainingAnswerOrdinal = string;

export type Maybe<T> = T | null;

export interface TrainingAttachment {
  id: string;
  title: string;
  url: string;
  attachmentType: TrainingAttachmentType;
  renderInline?: boolean;
}

export interface AnswerChoice {
  id: string;
  answerText: string;
  answerTrueFalse: boolean;
  answerOrdinal: TrainingAnswerOrdinal;
}

export interface TrainingQuestion {
  id: string;
  questionNumber: number;
  questionText: string;
  answerText: string;
  answerOrdinal: TrainingQuestionOrdinal;
  answerChoices: AnswerChoice[];
}

export type QuizTakeStatus = 'started' | 'paused' | 'completed';
export type QuizAttemptType = 'full' | 'retrain';

export interface QuizTakeAnswer {
  questionId: string;
  selectedChoiceId: string;
  selectedOrdinal: string;
  isCorrect: boolean;
  answeredAt: string;
}

export interface QuizTake {
  id: string;
  userId: string;
  status: QuizTakeStatus;
  startedAt: string;
  pausedAt?: string;
  completedAt?: string;
  currentQuestionIndex: number;
  answers: QuizTakeAnswer[];
  /** Optional subset of quiz question IDs used for this attempt (e.g., retrain missed-only mode). */
  questionIds?: string[];
  /** Optional attempt type; defaults to full attempt when omitted. */
  attemptType?: QuizAttemptType;
}

export interface SectionQuiz {
  id: string;
  title: string;
  sectionId: string;
  estimatedDurationMinutes: number;
  questions: TrainingQuestion[];
  quizTakes: QuizTake[];
}

export interface ModuleStep {
  id: string;
  title: string;
  subtitle: string;
  copy: string;
  attachments: TrainingAttachment[];
  sectionQuiz?: SectionQuiz;
}

export interface TrainingModule {
  id: string;
  title: string;
  modulePurpose: string;
  defaultRequired: boolean;
  moduleSteps: ModuleStep[];
  attachments: TrainingAttachment[];

  archived?: boolean;
  archivedAt?: string;
  archivedBy?: string;
}

export interface PackageModuleAssignment {
  id: string;
  moduleId: string;
  required: boolean;
  order: number;
}

export interface TrainingPackageCertificate {
  packageName: string;
  certificateName: string;
  certificateDetails: string;
  certificateImageUrl: string;
}

export interface TrainingPackage {
  id: string;
  title: string;
  packagePurpose: string;
  status: TrainingPackageStatus;
  version: string;
  /** Optional image for agent training package picker cards; falls back to certificate image when unset. */
  packageImageUrl?: string;
  certificate: TrainingPackageCertificate;
  moduleAssignments: PackageModuleAssignment[];
}

/** Persisted agent progress returned with library-content (survives refresh). */
export interface AgentLibraryQuizCompletion {
  packageId: string;
  moduleId: string;
  stepId: string;
  quizId: string;
  correctAnswers: number;
  totalQuestions: number;
  scorePercent: number;
  completedAt: string;
}

export interface AgentLibraryModuleCompletion {
  packageId: string;
  moduleId: string;
  completedAt: string;
}

export interface AgentLibraryProgress {
  quizCompletions: AgentLibraryQuizCompletion[];
  moduleCompletions: AgentLibraryModuleCompletion[];
}

export interface ResolvedPackageModule {
  assignment: PackageModuleAssignment;
  module: Maybe<TrainingModule>;
}
