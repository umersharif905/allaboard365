import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Award,
  // BookOpenText,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  FileQuestion,
  LayoutList,
  Lock,
  MinusCircle
} from 'lucide-react';

import type {
  AgentLibraryProgress,
  AgentLibraryQuizCompletion,
  ModuleStep,
  QuizTake,
  SectionQuiz,
  TrainingModule,
  TrainingPackageCertificate,
  TrainingPackage
} from '../../trainingTypes';
import ColumbusTrainingCallout, { type ColumbusTrainingCalloutHandle } from '../ColumbusTrainingCallout';
import TrainingPackageSelector from '../TrainingPackageSelector';
import TrainingTocTree, { type TocModuleItem } from '../TrainingTocTree';
import TrainingStepViewport from '../TrainingStepViewport';
import QuizPlayer from '../QuizPlayer';

type Props = {
  packages: TrainingPackage[];
  moduleLibrary: TrainingModule[];
  initialPackageId?: string;
  initialTabId?: TabKind;
  onUpdateModule: (moduleId: string, updater: (module: TrainingModule) => TrainingModule) => void;
  onModuleCompleted?: (packageId: string, moduleId: string) => void;
  onCompleteLibraryQuiz?: (payload: {
    packageId: string;
    moduleId: string;
    stepId: string;
    quizId: string;
    score: number;
    totalQuestions: number;
  }) => Promise<{ packageCertificationPassed?: boolean } | void>;
  onNavigateToCertificates?: () => void;
  certificateGallery?: Array<{
    packageId: string;
    packageTitle: string;
    certificate: TrainingPackageCertificate;
    earned: boolean;
    awardedAt?: string | null;
  }>;
  /** Server-backed progress so refresh keeps quiz + step completion in sync with DB */
  agentProgress?: AgentLibraryProgress | null;
  /**
   * When set (tenant admin split with module library), keep the preview player on this module
   * so it reflects the same `moduleLibrary` entry as the editor.
   */
  editorLinkedModuleId?: string;
  /** Agent `/agent/training` surface: show Columbus mascot callout */
  showColumbusCallout?: boolean;
  /** When true with `showColumbusCallout`, shows "Columbus Callout Controls" tuning panel */
  columbusShowDevControls?: boolean;
};

type TabKind = 'intro' | 'curriculum' | 'step' | 'quiz' | 'certificates';

type DynamicTabEntry = {
  id: string;
  kind: 'step' | 'quiz';
  moduleId: string;
  stepKey: string;
  step: ModuleStep;
  stepNumber: number;
  totalSteps: number;
  label: string;
};

type TabEntry = {
  id: string;
  kind: TabKind;
  label: string;
  percent: number;
  dynamic?: DynamicTabEntry;
};

type CurriculumSwapPhase =
  | 'packages_idle'
  | 'packages_exit'
  | 'toc_enter'
  | 'toc_idle'
  | 'toc_exit'
  | 'packages_enter';

const CURRICULUM_SWAP_MS = 420;
const CURRICULUM_SWAP_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

function prefersReducedMotionClient(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function formatPackageTitleCase(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/\S+/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

// const INTRO_TAB_ID = 'intro';
const CURRICULUM_TAB_ID = 'curriculum';
const CERTIFICATES_TAB_ID = 'certificates';

const buildStepKey = (moduleId: string, stepId: string): string => `${moduleId}::${stepId}`;

function deriveSectionQuizStatus(step: ModuleStep): 'not_started' | 'in_progress' | 'completed' | undefined {
  const quiz = step.sectionQuiz;
  if (!quiz?.questions?.length) {
    return undefined;
  }
  const takes = quiz.quizTakes || [];
  if (takes.length === 0) {
    return 'not_started';
  }
  const last = takes[takes.length - 1];
  if (last.status === 'completed') {
    return 'completed';
  }
  if (last.status === 'started' || last.status === 'paused') {
    return 'in_progress';
  }
  return 'not_started';
}

function computeQuizProgressPercent(step: ModuleStep): number {
  const quiz = step.sectionQuiz;
  if (!quiz?.questions?.length) {
    return 0;
  }
  const takes = quiz.quizTakes || [];
  const last = takes[takes.length - 1];
  if (!last) {
    return 0;
  }
  if (last.status === 'completed') {
    return 100;
  }
  const activeQuestionIds = last.questionIds?.length
    ? last.questionIds
    : quiz.questions.map(question => question.id);
  const activeQuestionIdSet = new Set(activeQuestionIds);
  const total = Math.max(activeQuestionIds.length, 1);
  const answered = (last.answers || []).filter(answer => activeQuestionIdSet.has(answer.questionId)).length;
  return Math.min(100, Math.round((answered / total) * 100));
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const getLatestCompletedQuizTake = (quiz?: SectionQuiz) => {
  if (!quiz || !Array.isArray(quiz.quizTakes) || quiz.quizTakes.length === 0) {
    return null;
  }
  for (let index = quiz.quizTakes.length - 1; index >= 0; index -= 1) {
    const take = quiz.quizTakes[index];
    if (take.status === 'completed') {
      return take;
    }
  }
  return null;
};

const buildSyntheticCompletedTake = (quiz: SectionQuiz, row: AgentLibraryQuizCompletion): QuizTake => {
  const completedAt = row.completedAt;
  const sorted = [...quiz.questions].sort((a, b) => {
    if (a.questionNumber === b.questionNumber) {
      return a.id.localeCompare(b.id);
    }
    return a.questionNumber - b.questionNumber;
  });
  const answers = sorted.map((question, idx) => {
    const isCorrect = idx < row.correctAnswers;
    const choice = isCorrect
      ? question.answerChoices.find(c => c.answerTrueFalse) || question.answerChoices[0]
      : question.answerChoices.find(c => !c.answerTrueFalse) || question.answerChoices[0];
    if (!choice) {
      return {
        questionId: question.id,
        selectedChoiceId: '',
        selectedOrdinal: '',
        isCorrect,
        answeredAt: completedAt
      };
    }
    return {
      questionId: question.id,
      selectedChoiceId: choice.id,
      selectedOrdinal: choice.answerOrdinal,
      isCorrect,
      answeredAt: completedAt
    };
  });
  return {
    id: `server-${row.quizId}-${row.packageId}`,
    userId: 'server-hydrated',
    status: 'completed',
    startedAt: completedAt,
    completedAt,
    currentQuestionIndex: Math.max(0, sorted.length - 1),
    answers
  };
};

const computePackageEarnedFromServerProgress = (
  pkg: TrainingPackage,
  modules: TrainingModule[],
  progress: AgentLibraryProgress | null | undefined
): boolean | null => {
  if (!progress?.quizCompletions?.length) {
    return null;
  }
  const moduleMap = new Map(modules.map(m => [m.id, m]));
  let totalQuizzes = 0;
  let completed = 0;
  let aggregateCorrect = 0;
  let aggregateTotal = 0;
  pkg.moduleAssignments.forEach(assignment => {
    const mod = moduleMap.get(assignment.moduleId);
    if (!mod) {
      return;
    }
    mod.moduleSteps.forEach(step => {
      const quiz = step.sectionQuiz;
      if (!quiz?.questions?.length) {
        return;
      }
      totalQuizzes += 1;
      const row = progress.quizCompletions.find(
        r => r.packageId === pkg.id && r.quizId === quiz.id
      );
      if (!row) {
        return;
      }
      completed += 1;
      aggregateCorrect += row.correctAnswers;
      aggregateTotal += row.totalQuestions;
    });
  });
  if (totalQuizzes === 0 || aggregateTotal === 0) {
    return false;
  }
  if (completed !== totalQuizzes) {
    return false;
  }
  return (aggregateCorrect / aggregateTotal) * 100 >= 70;
};

const computeLocalPackageCertificationPassed = (
  trainingPackage: TrainingPackage,
  moduleMap: Map<string, TrainingModule>
): boolean => {
  let totalQuizCount = 0;
  let completedQuizCount = 0;
  let aggregateCorrectAnswers = 0;
  let aggregateTotalQuestions = 0;

  trainingPackage.moduleAssignments.forEach(assignment => {
    const module = moduleMap.get(assignment.moduleId);
    if (!module) {
      return;
    }
    module.moduleSteps.forEach(step => {
      const quiz = step.sectionQuiz;
      if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
        return;
      }
      totalQuizCount += 1;
      const latestCompletedTake = getLatestCompletedQuizTake(quiz);
      if (!latestCompletedTake) {
        return;
      }
      completedQuizCount += 1;
      aggregateTotalQuestions += quiz.questions.length;
      aggregateCorrectAnswers += latestCompletedTake.answers.filter(answer => answer.isCorrect).length;
    });
  });

  if (totalQuizCount === 0 || completedQuizCount !== totalQuizCount || aggregateTotalQuestions === 0) {
    return false;
  }
  const cumulativePercent = (aggregateCorrectAnswers / aggregateTotalQuestions) * 100;
  return cumulativePercent >= 70;
};

type RequiredModuleProgressVariant = 'no_quiz' | 'not_started' | 'perfect' | 'partial';

type RequiredModuleProgressRow = {
  moduleId: string;
  title: string;
  order: number;
  variant: RequiredModuleProgressVariant;
  scorePercent?: number;
  hasMissingQuiz?: boolean;
};

function buildRequiredModuleProgressRows(
  pkg: TrainingPackage,
  moduleMap: Map<string, TrainingModule>,
  progress: AgentLibraryProgress | null | undefined
): RequiredModuleProgressRow[] {
  const required = [...pkg.moduleAssignments]
    .filter(assignment => assignment.required)
    .sort((a, b) => a.order - b.order);

  return required.map(assignment => {
    const mod = moduleMap.get(assignment.moduleId);
    const title = mod?.title ?? `Module (${assignment.moduleId})`;
    const quizSteps = mod
      ? mod.moduleSteps.filter(
          step => step.sectionQuiz && (step.sectionQuiz.questions?.length ?? 0) > 0
        )
      : [];

    if (quizSteps.length === 0) {
      return {
        moduleId: assignment.moduleId,
        title,
        order: assignment.order,
        variant: 'no_quiz' as const
      };
    }

    const completions = quizSteps.map(step => {
      const qid = step.sectionQuiz!.id;
      return progress?.quizCompletions?.find(
        row => row.packageId === pkg.id && row.quizId === qid
      );
    });

    const missingSome = completions.some(c => !c);
    const scores = completions
      .filter((c): c is AgentLibraryQuizCompletion => Boolean(c))
      .map(c => c.scorePercent);

    if (scores.length === 0) {
      return {
        moduleId: assignment.moduleId,
        title,
        order: assignment.order,
        variant: 'not_started' as const
      };
    }

    const all100 = completions.every(c => c && c.scorePercent === 100);
    if (all100 && !missingSome) {
      return {
        moduleId: assignment.moduleId,
        title,
        order: assignment.order,
        variant: 'perfect' as const
      };
    }

    const minScore = scores.length ? Math.min(...scores) : 0;
    return {
      moduleId: assignment.moduleId,
      title,
      order: assignment.order,
      variant: 'partial' as const,
      scorePercent: minScore,
      hasMissingQuiz: missingSome
    };
  });
}

const SegmentedProgressRing: React.FC<{ percent: number; title: string }> = ({ percent, title }) => {
  const safePercent = clampPercent(percent);
  const size = 24;
  const strokeWidth = 2.3;
  const segments = 10;
  const center = size / 2;
  const radius = center - strokeWidth / 2;
  const circumference = 2 * Math.PI * radius;
  const segmentArc = circumference / segments;
  const dashLength = segmentArc * 0.72;
  const filledSegments = Math.round((safePercent / 100) * segments);

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      title={title}
      aria-label={`${title}: ${safePercent}%`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        {Array.from({ length: segments }, (_, index) => (
          <circle
            key={`track-${index}`}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${dashLength} ${circumference}`}
            strokeDashoffset={-index * segmentArc}
            className="text-gray-200"
          />
        ))}
        {Array.from({ length: filledSegments }, (_, index) => (
          <circle
            key={`fill-${index}`}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${dashLength} ${circumference}`}
            strokeDashoffset={-index * segmentArc}
            className="text-emerald-600"
          />
        ))}
      </svg>
      <span className="absolute text-[8px] font-semibold text-gray-700">{safePercent}</span>
    </span>
  );
};

const TrainingPlayer2Panel: React.FC<Props> = ({
  packages,
  moduleLibrary,
  initialPackageId,
  initialTabId,
  onUpdateModule,
  onModuleCompleted,
  onCompleteLibraryQuiz,
  onNavigateToCertificates,
  certificateGallery,
  agentProgress,
  editorLinkedModuleId,
  showColumbusCallout = false,
  columbusShowDevControls = false
}) => {
  // Allow explicit empty string to mean "start on package picker with no selection".
  // Undefined still falls back to the first package for legacy/default behavior.
  const initialSelectedPackageId = initialPackageId ?? packages[0]?.id ?? '';
  const [selectedPackageId, setSelectedPackageId] = useState<string>(initialSelectedPackageId);
  const [curriculumSwapPhase, setCurriculumSwapPhase] = useState<CurriculumSwapPhase>(() =>
    initialSelectedPackageId ? 'toc_idle' : 'packages_idle'
  );
  const [tocEnterArmed, setTocEnterArmed] = useState(false);
  const [packagesEnterArmed, setPackagesEnterArmed] = useState(false);
  const curriculumPhaseRef = useRef(curriculumSwapPhase);
  curriculumPhaseRef.current = curriculumSwapPhase;

  const [selectedModuleId, setSelectedModuleId] = useState<string>('');
  const [selectedTabId, setSelectedTabId] = useState<string>(CURRICULUM_TAB_ID);
  const [expandedModuleIds, setExpandedModuleIds] = useState<string[]>([]);
  const [isTocCollapsedAll, setIsTocCollapsedAll] = useState<boolean>(false);
  const [visitedStepKeys, setVisitedStepKeys] = useState<string[]>([]);
  const [columbusDismissedUntilNextPlay, setColumbusDismissedUntilNextPlay] = useState(false);
  const [columbusIntroPlayToken, setColumbusIntroPlayToken] = useState(0);
  const columbusCalloutRef = useRef<ColumbusTrainingCalloutHandle | null>(null);
  const curriculumPackagesRegionRef = useRef<HTMLDivElement>(null);

  const bumpColumbusIntroFromAudio = useCallback(() => {
    if (!showColumbusCallout) {
      return;
    }
    setColumbusDismissedUntilNextPlay(false);
    setColumbusIntroPlayToken(previous => previous + 1);
  }, [showColumbusCallout]);

  const hideColumbusFromAudioPause = useCallback(() => {
    if (!showColumbusCallout || columbusDismissedUntilNextPlay) {
      return;
    }
    columbusCalloutRef.current?.animateTurtleOut();
  }, [columbusDismissedUntilNextPlay, showColumbusCallout]);

  const moduleCompletionReportedRef = useRef<Set<string>>(new Set());
  const moduleLibraryRef = useRef(moduleLibrary);
  moduleLibraryRef.current = moduleLibrary;
  const previousPackageIdForVisitedRef = useRef<string>(selectedPackageId);

  const displayModuleLibrary = useMemo(() => {
    if (!selectedPackageId || !agentProgress?.quizCompletions?.length) {
      return moduleLibrary;
    }
    const rowsForPackage = agentProgress.quizCompletions.filter(r => r.packageId === selectedPackageId);
    if (rowsForPackage.length === 0) {
      return moduleLibrary;
    }
    const byQuizId = new Map(rowsForPackage.map(r => [r.quizId, r]));
    return moduleLibrary.map(mod => ({
      ...mod,
      moduleSteps: mod.moduleSteps.map(step => {
        const q = step.sectionQuiz;
        if (!q?.id || !byQuizId.has(q.id)) {
          return step;
        }
        if (q.quizTakes && q.quizTakes.length > 0) {
          return step;
        }
        const row = byQuizId.get(q.id)!;
        return {
          ...step,
          sectionQuiz: {
            ...q,
            quizTakes: [buildSyntheticCompletedTake(q, row)]
          }
        };
      })
    }));
  }, [agentProgress, moduleLibrary, selectedPackageId]);

  const moduleLookup = useMemo(
    () => new Map(displayModuleLibrary.map(module => [module.id, module])),
    [displayModuleLibrary]
  );

  const handleCurriculumPackageSelect = useCallback((packageId: string) => {
    if (!packageId) {
      setSelectedPackageId('');
      return;
    }
    setSelectedPackageId(packageId);
    if (prefersReducedMotionClient()) {
      setCurriculumSwapPhase('toc_idle');
      return;
    }
    setCurriculumSwapPhase('packages_exit');
  }, []);

  const handleCurriculumChangePackage = useCallback(() => {
    if (prefersReducedMotionClient()) {
      setSelectedPackageId('');
      setCurriculumSwapPhase('packages_idle');
      return;
    }
    setCurriculumSwapPhase('toc_exit');
  }, []);

  useEffect(() => {
    if (curriculumSwapPhase !== 'toc_enter') {
      setTocEnterArmed(false);
      return;
    }
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setTocEnterArmed(true));
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, [curriculumSwapPhase]);

  useEffect(() => {
    if (curriculumSwapPhase !== 'packages_enter') {
      setPackagesEnterArmed(false);
      return;
    }
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setPackagesEnterArmed(true));
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, [curriculumSwapPhase]);

  useEffect(() => {
    if (selectedTabId !== CURRICULUM_TAB_ID) {
      setCurriculumSwapPhase(selectedPackageId ? 'toc_idle' : 'packages_idle');
      setTocEnterArmed(false);
      setPackagesEnterArmed(false);
    }
  }, [selectedPackageId, selectedTabId]);

  useEffect(() => {
    if (!selectedPackageId) {
      return;
    }
    if (curriculumSwapPhase !== 'packages_idle') {
      return;
    }
    setCurriculumSwapPhase('toc_idle');
  }, [curriculumSwapPhase, selectedPackageId]);

  useEffect(() => {
    if (curriculumSwapPhase !== 'packages_exit') {
      return;
    }
    const timer = window.setTimeout(() => {
      if (curriculumPhaseRef.current === 'packages_exit') {
        setCurriculumSwapPhase('toc_enter');
      }
    }, CURRICULUM_SWAP_MS + 200);
    return () => window.clearTimeout(timer);
  }, [curriculumSwapPhase]);

  useEffect(() => {
    if (!initialPackageId || !packages.some(trainingPackage => trainingPackage.id === initialPackageId)) {
      return;
    }
    setSelectedPackageId(prev => {
      if (prev === '') {
        return '';
      }
      if (packages.some(trainingPackage => trainingPackage.id === prev)) {
        return prev;
      }
      return initialPackageId;
    });
  }, [initialPackageId, packages]);

  useEffect(() => {
    if (initialTabId) {
      setSelectedTabId(initialTabId === 'certificates' ? CERTIFICATES_TAB_ID : CURRICULUM_TAB_ID);
    }
  }, [initialTabId]);

  useEffect(() => {
    if (selectedPackageId === '') {
      return;
    }
    if (packages.length === 0) {
      setSelectedPackageId('');
      return;
    }
    if (!packages.some(trainingPackage => trainingPackage.id === selectedPackageId)) {
      setSelectedPackageId(packages[0]?.id || '');
    }
  }, [packages, selectedPackageId]);

  const selectedPackage = useMemo(
    () => packages.find(trainingPackage => trainingPackage.id === selectedPackageId) || null,
    [packages, selectedPackageId]
  );

  const tocModules = useMemo<TocModuleItem[]>(() => {
    if (!selectedPackage) {
      return [];
    }

    return [...selectedPackage.moduleAssignments]
      .sort((a, b) => a.order - b.order)
      .map(assignment => {
        const module = moduleLookup.get(assignment.moduleId);
        if (!module) {
          return {
            id: assignment.moduleId,
            title: `Missing module (${assignment.moduleId})`,
            modulePurpose: '',
            required: assignment.required,
            steps: [],
            missing: true
          };
        }

        return {
          id: module.id,
          title: module.title,
          modulePurpose: module.modulePurpose,
          required: assignment.required,
          steps: module.moduleSteps.map(step => ({
            id: step.id,
            key: buildStepKey(module.id, step.id),
            title: step.title,
            subtitle: step.subtitle,
            hasSectionQuiz: Boolean(step.sectionQuiz?.questions?.length),
            quizStatus: deriveSectionQuizStatus(step)
          }))
        };
      });
  }, [moduleLookup, selectedPackage]);

  const selectedModuleObject = useMemo(() => {
    if (!selectedModuleId) {
      return null;
    }
    return moduleLookup.get(selectedModuleId) || null;
  }, [moduleLookup, selectedModuleId]);

  const selectedModuleOrdinalInPackage = useMemo(() => {
    if (!selectedModuleId) {
      return undefined;
    }
    const index = tocModules.findIndex(module => module.id === selectedModuleId);
    return index >= 0 ? index + 1 : undefined;
  }, [tocModules, selectedModuleId]);

  const moduleContextHeadingLabel = useMemo(() => {
    const title = selectedModuleObject?.title?.trim();
    if (!title) {
      return '';
    }
    if (selectedModuleOrdinalInPackage != null && selectedModuleOrdinalInPackage > 0) {
      return `Module ${selectedModuleOrdinalInPackage} - ${title}`;
    }
    return title;
  }, [selectedModuleObject, selectedModuleOrdinalInPackage]);

  const dynamicTabs = useMemo<DynamicTabEntry[]>(() => {
    if (!selectedModuleObject) {
      return [];
    }

    const entries: DynamicTabEntry[] = [];
    selectedModuleObject.moduleSteps.forEach((step, index) => {
      const stepKey = buildStepKey(selectedModuleObject.id, step.id);
      entries.push({
        id: `step:${stepKey}`,
        kind: 'step',
        moduleId: selectedModuleObject.id,
        stepKey,
        step,
        stepNumber: index + 1,
        totalSteps: selectedModuleObject.moduleSteps.length,
        label: `Step ${index + 1}`
      });

      if (step.sectionQuiz?.questions?.length) {
        entries.push({
          id: `quiz:${stepKey}`,
          kind: 'quiz',
          moduleId: selectedModuleObject.id,
          stepKey,
          step,
          stepNumber: index + 1,
          totalSteps: selectedModuleObject.moduleSteps.length,
          label: `Quiz ${index + 1}`
        });
      }
    });

    return entries;
  }, [selectedModuleObject]);

  const dynamicTabLookup = useMemo(() => new Map(dynamicTabs.map(entry => [entry.id, entry])), [dynamicTabs]);

  const stepPercentByKey = useMemo(() => {
    const map: Record<string, number> = {};
    tocModules.forEach(module => {
      const sourceModule = moduleLookup.get(module.id);
      if (!sourceModule) {
        return;
      }
      sourceModule.moduleSteps.forEach(step => {
        const stepKey = buildStepKey(sourceModule.id, step.id);
        if (step.sectionQuiz?.questions?.length) {
          map[stepKey] = computeQuizProgressPercent(step);
          return;
        }
        map[stepKey] = visitedStepKeys.includes(stepKey) ? 100 : 0;
      });
    });
    return map;
  }, [moduleLookup, tocModules, visitedStepKeys]);

  const modulePercentById = useMemo(() => {
    const out: Record<string, number> = {};
    tocModules.forEach(module => {
      if (module.steps.length === 0) {
        out[module.id] = 0;
        return;
      }
      let sum = 0;
      module.steps.forEach(step => {
        sum += stepPercentByKey[step.key] ?? 0;
      });
      out[module.id] = Math.round(sum / module.steps.length);
    });
    return out;
  }, [stepPercentByKey, tocModules]);

  const packagePercent = useMemo(() => {
    const moduleIds = tocModules.map(module => module.id);
    if (moduleIds.length === 0) {
      return 0;
    }
    let sum = 0;
    moduleIds.forEach(moduleId => {
      sum += modulePercentById[moduleId] ?? 0;
    });
    return Math.round(sum / moduleIds.length);
  }, [modulePercentById, tocModules]);

  const tabs = useMemo<TabEntry[]>(() => {
    const fixedTabs: TabEntry[] = [
      // { id: INTRO_TAB_ID, kind: 'intro', label: 'Intro', percent: 100 },
      { id: CURRICULUM_TAB_ID, kind: 'curriculum', label: 'Training Packages', percent: packagePercent }
    ];

    const generatedDynamicTabs: TabEntry[] = dynamicTabs.map(dynamic => {
      const stepPercent = stepPercentByKey[dynamic.stepKey] ?? 0;
      const tabPercent = dynamic.kind === 'quiz' ? stepPercent : stepPercent;
      return {
        id: dynamic.id,
        kind: dynamic.kind,
        label: dynamic.label,
        percent: tabPercent,
        dynamic
      };
    });

    return [
      ...fixedTabs,
      ...generatedDynamicTabs,
      {
        id: CERTIFICATES_TAB_ID,
        kind: 'certificates',
        label: 'Certificates',
        percent: packagePercent
      }
    ];
  }, [dynamicTabs, packagePercent, stepPercentByKey]);

  const visibleTabs = useMemo(
    () =>
      tabs.filter(tab => {
        const showOnlyCoreTabs = !selectedModuleId;
        const isVisibleBeforeModuleSelect =
          /* tab.kind === 'intro' || */ tab.kind === 'curriculum' || tab.kind === 'certificates';
        if (showOnlyCoreTabs && !isVisibleBeforeModuleSelect) {
          return false;
        }
        return true;
      }),
    [tabs, selectedModuleId]
  );

  useEffect(() => {
    if (!tabs.some(tab => tab.id === selectedTabId)) {
      setSelectedTabId(CURRICULUM_TAB_ID);
    }
  }, [selectedModuleId, selectedTabId, tabs]);

  useEffect(() => {
    if (!selectedModuleId) {
      setExpandedModuleIds([]);
      return;
    }
    if (isTocCollapsedAll) {
      return;
    }
    setExpandedModuleIds(previousIds =>
      previousIds.length === 1 && previousIds[0] === selectedModuleId ? previousIds : [selectedModuleId]
    );
  }, [isTocCollapsedAll, selectedModuleId]);

  useEffect(() => {
    setSelectedModuleId('');
    setSelectedTabId(CURRICULUM_TAB_ID);
    setIsTocCollapsedAll(false);
    setExpandedModuleIds([]);
    moduleCompletionReportedRef.current.clear();
  }, [selectedPackageId]);

  useEffect(() => {
    if (!editorLinkedModuleId) {
      return;
    }
    setSelectedModuleId(editorLinkedModuleId);
  }, [editorLinkedModuleId, selectedPackageId]);

  useEffect(() => {
    const packageChanged = previousPackageIdForVisitedRef.current !== selectedPackageId;
    previousPackageIdForVisitedRef.current = selectedPackageId;

    const keys: string[] = [];
    if (agentProgress?.moduleCompletions?.length && selectedPackageId) {
      const baseLookup = new Map(moduleLibraryRef.current.map(m => [m.id, m]));
      agentProgress.moduleCompletions
        .filter(r => r.packageId === selectedPackageId)
        .forEach(row => {
          const mod = baseLookup.get(row.moduleId);
          if (!mod) {
            return;
          }
          mod.moduleSteps.forEach(s => keys.push(buildStepKey(mod.id, s.id)));
        });
    }

    setVisitedStepKeys(prev => {
      if (packageChanged) {
        return keys;
      }
      return [...new Set([...prev, ...keys])];
    });
  }, [agentProgress, selectedPackageId]);

  useEffect(() => {
    if (!onModuleCompleted || !selectedPackageId) {
      return;
    }

    tocModules.forEach(module => {
      if ((modulePercentById[module.id] ?? 0) < 100) {
        return;
      }
      const dedupeKey = `${selectedPackageId}::${module.id}`;
      if (moduleCompletionReportedRef.current.has(dedupeKey)) {
        return;
      }
      moduleCompletionReportedRef.current.add(dedupeKey);
      onModuleCompleted(selectedPackageId, module.id);
    });
  }, [modulePercentById, onModuleCompleted, selectedPackageId, tocModules]);

  const activateStepByKey = (stepKey: string): void => {
    const nextModuleId = stepKey.split('::')[0];
    const nextTabId = `step:${stepKey}`;
    if (!dynamicTabLookup.has(nextTabId)) {
      return;
    }
    setSelectedModuleId(nextModuleId);
    setSelectedTabId(nextTabId);
    setIsTocCollapsedAll(false);
    setExpandedModuleIds([nextModuleId]);
  };

  const onSelectModule = (moduleId: string): void => {
    if (!moduleId) {
      return;
    }

    const selectedTocModule = tocModules.find(module => module.id === moduleId);
    if (!selectedTocModule || selectedTocModule.steps.length === 0) {
      setSelectedModuleId(moduleId);
      setSelectedTabId(CURRICULUM_TAB_ID);
      return;
    }

    const firstStepKey = selectedTocModule.steps[0].key;
    setSelectedModuleId(moduleId);
    setSelectedTabId(`step:${firstStepKey}`);
    setIsTocCollapsedAll(false);
    setExpandedModuleIds([moduleId]);
  };

  const onSelectStep = (stepKey: string): void => {
    activateStepByKey(stepKey);
  };

  const onUpdateQuizForStep = (moduleId: string, stepId: string, updater: (quiz: SectionQuiz) => SectionQuiz): void => {
    onUpdateModule(moduleId, module => ({
      ...module,
      moduleSteps: module.moduleSteps.map(moduleStep => {
        if (moduleStep.id !== stepId || !moduleStep.sectionQuiz) {
          return moduleStep;
        }
        return {
          ...moduleStep,
          sectionQuiz: updater(moduleStep.sectionQuiz)
        };
      })
    }));
  };

  const certificateCards = useMemo(() => {
    if (Array.isArray(certificateGallery) && certificateGallery.length > 0) {
      return certificateGallery;
    }
    return packages.map(pkg => {
      const fromServer = computePackageEarnedFromServerProgress(pkg, moduleLibrary, agentProgress);
      const earned =
        fromServer !== null
          ? fromServer
          : computeLocalPackageCertificationPassed(pkg, moduleLookup);
      return {
        packageId: pkg.id,
        packageTitle: pkg.title,
        certificate: pkg.certificate,
        earned,
        awardedAt: null
      };
    });
  }, [agentProgress, certificateGallery, moduleLibrary, moduleLookup, packages]);

  const requiredModuleRowsByPackage = useMemo(() => {
    const map = new Map<string, RequiredModuleProgressRow[]>();
    packages.forEach(pkg => {
      map.set(pkg.id, buildRequiredModuleProgressRows(pkg, moduleLookup, agentProgress ?? null));
    });
    return map;
  }, [packages, moduleLookup, agentProgress]);

  const quizCompletionHasNextModule = useMemo(() => {
    const idx = tocModules.findIndex(module => module.id === selectedModuleId);
    if (idx < 0 || idx >= tocModules.length - 1) {
      return false;
    }
    const next = tocModules[idx + 1];
    return next.steps.length > 0;
  }, [tocModules, selectedModuleId]);

  const handleQuizCompletionPrimary = useCallback(() => {
    const idx = tocModules.findIndex(module => module.id === selectedModuleId);
    if (idx >= 0 && idx < tocModules.length - 1) {
      const next = tocModules[idx + 1];
      if (next.steps.length > 0) {
        const firstStepKey = next.steps[0].key;
        setSelectedModuleId(next.id);
        setSelectedTabId(`step:${firstStepKey}`);
        setIsTocCollapsedAll(false);
        setExpandedModuleIds([next.id]);
        return;
      }
    }
    setSelectedModuleId('');
    setSelectedTabId(CURRICULUM_TAB_ID);
  }, [tocModules, selectedModuleId]);

  const curriculumSwapTransition = useMemo(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }
    return `transform ${CURRICULUM_SWAP_MS}ms ${CURRICULUM_SWAP_EASE}`;
  }, []);

  const showCurriculumPackages =
    curriculumSwapPhase === 'packages_idle' ||
    curriculumSwapPhase === 'packages_exit' ||
    curriculumSwapPhase === 'packages_enter';

  const showCurriculumToc =
    Boolean(selectedPackage) &&
    (curriculumSwapPhase === 'toc_enter' ||
      curriculumSwapPhase === 'toc_idle' ||
      curriculumSwapPhase === 'toc_exit');

  const packagesShellClass =
    curriculumSwapPhase === 'packages_exit'
      ? '-translate-x-full'
      : curriculumSwapPhase === 'packages_enter' && !packagesEnterArmed
        ? '-translate-x-full'
        : curriculumSwapPhase === 'packages_enter' && packagesEnterArmed
          ? 'translate-x-0'
          : 'translate-x-0';

  const packagesShellTransition =
    curriculumSwapPhase === 'packages_idle' || curriculumSwapPhase === 'packages_exit'
      ? curriculumSwapTransition
      : curriculumSwapPhase === 'packages_enter' && packagesEnterArmed
        ? curriculumSwapTransition
        : undefined;

  const tocShellClass =
    curriculumSwapPhase === 'toc_exit'
      ? 'translate-x-full'
      : curriculumSwapPhase === 'toc_enter' && !tocEnterArmed
        ? 'translate-x-full'
        : curriculumSwapPhase === 'toc_enter' && tocEnterArmed
          ? 'translate-x-0'
          : 'translate-x-0';

  const tocShellTransition =
    curriculumSwapPhase === 'toc_exit'
      ? curriculumSwapTransition
      : curriculumSwapPhase === 'toc_enter' && tocEnterArmed
        ? curriculumSwapTransition
        : undefined;

  const onPackagesExitTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (curriculumPhaseRef.current !== 'packages_exit') {
      return;
    }
    if (event.propertyName !== 'transform') {
      return;
    }
    setCurriculumSwapPhase('toc_enter');
  };

  const onTocEnterTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (curriculumPhaseRef.current !== 'toc_enter' || !tocEnterArmed) {
      return;
    }
    if (event.propertyName !== 'transform') {
      return;
    }
    setCurriculumSwapPhase('toc_idle');
  };

  const onTocExitTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (curriculumPhaseRef.current !== 'toc_exit') {
      return;
    }
    if (event.propertyName !== 'transform') {
      return;
    }
    setSelectedPackageId('');
    setCurriculumSwapPhase('packages_enter');
  };

  const onPackagesEnterTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (curriculumPhaseRef.current !== 'packages_enter' || !packagesEnterArmed) {
      return;
    }
    if (event.propertyName !== 'transform') {
      return;
    }
    setCurriculumSwapPhase('packages_idle');
  };

  const currentTab = tabs.find(tab => tab.id === selectedTabId) || tabs[0];
  const currentDynamic = currentTab?.dynamic || null;

  const nextTab = useMemo(() => {
    const idx = visibleTabs.findIndex(tab => tab.id === selectedTabId);
    if (idx < 0 || idx >= visibleTabs.length - 1) {
      return null;
    }
    return visibleTabs[idx + 1];
  }, [visibleTabs, selectedTabId]);

  const nextTabControl =
    nextTab ? (
      <button
        type="button"
        onClick={() => setSelectedTabId(nextTab.id)}
        className="inline-flex items-center gap-1 rounded-md border border-oe-primary bg-oe-primary px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:opacity-95"
      >
        Next
        <ChevronRight className="h-4 w-4" aria-hidden />
      </button>
    ) : null;

  useEffect(() => {
    if (!currentDynamic || currentDynamic.kind !== 'step') {
      return;
    }
    setVisitedStepKeys(previousKeys =>
      previousKeys.includes(currentDynamic.stepKey) ? previousKeys : [...previousKeys, currentDynamic.stepKey]
    );
  }, [currentDynamic]);

  return (
    <section className="relative w-full min-w-0 bg-transparent">
      <div className="w-full border-b border-gray-200 bg-white">
        <div className="w-full bg-white px-0">
          <nav className="w-full flex flex-wrap items-center justify-center gap-x-8 gap-y-1 bg-white">
            {tabs.map(tab => {
              const isActive = tab.id === currentTab.id;
              const isLockedStepTab = tab.kind === 'step' || tab.kind === 'quiz';
              const showOnlyCoreTabs = !selectedModuleId;
              const isVisibleBeforeModuleSelect =
                /* tab.kind === 'intro' || */ tab.kind === 'curriculum' || tab.kind === 'certificates';

              if (showOnlyCoreTabs && !isVisibleBeforeModuleSelect) {
                return null;
              }

              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSelectedTabId(tab.id)}
                  className={`flex items-center py-4 px-1 border-b-2 transition-colors ${
                    isActive
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                  title={
                    isLockedStepTab && showOnlyCoreTabs
                      ? 'Select a module under Training Packages to unlock step tabs'
                      : undefined
                  }
                >
                  {/* {tab.kind === 'intro' ? <BookOpenText className="h-5 w-5 mr-2" /> : null} */}
                  {tab.kind === 'curriculum' ? <LayoutList className="h-5 w-5 mr-2" /> : null}
                  {tab.kind === 'step' ? <CheckCircle2 className="h-5 w-5 mr-2" /> : null}
                  {tab.kind === 'quiz' ? <FileQuestion className="h-5 w-5 mr-2" /> : null}
                  {tab.kind === 'certificates' ? <Award className="h-5 w-5 mr-2" /> : null}
                  <span className="text-sm font-medium">{tab.label}</span>
                  {tab.kind === 'step' || tab.kind === 'quiz' ? (
                    <span className="ml-2">
                      <SegmentedProgressRing percent={tab.percent} title={`${tab.label} completion`} />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="w-full bg-transparent px-0 py-6">
        <div className="w-full max-w-4xl mx-auto min-w-0 bg-transparent">
          {/* <div className="mb-3 border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
            <div className="font-semibold">
              {currentTab.kind === 'intro' ? 'How this training works' : null}
              {currentTab.kind === 'curriculum' ? 'Choose package and module' : null}
              {currentTab.kind === 'step'
                ? `Step ${currentStepIndex} of ${Math.max(selectedModuleSteps.length, 1)}`
                : null}
              {currentTab.kind === 'quiz' ? `Quiz checkpoint after Step ${currentStepIndex}` : null}
              {currentTab.kind === 'certificates' ? 'Certificates and earned achievements' : null}
            </div>
            <div className="mt-1 text-sky-800">
              Package: {selectedPackage?.title || 'No package selected'}
              {selectedModuleObject ? ` | Module: ${selectedModuleObject.title}` : ''}
              {` | Overall completion: ${packagePercent}%`}
            </div>
          </div> */}

          <div className="min-h-[520px]">
            {/* Intro tab panel (hidden)
            {currentTab.kind === 'intro' ? (
              <div className="space-y-3 rounded-md border border-gray-200 bg-white p-4">
                <div className="rounded-md border border-blue-200 bg-blue-50 p-6">
                  <h3 className="text-[1.5rem] font-semibold leading-snug text-blue-900">
                    How to use this tool
                  </h3>
                  <ul className="mt-4 list-disc space-y-2 pl-6 text-[1.5rem] leading-relaxed text-blue-900">
                    <li>Start in Curriculum to choose a package and select a module from the table of contents.</li>
                    <li>Step tabs are generated for the selected module only, in learning order.</li>
                    <li>If a step includes a quiz, a quiz tab appears right after that step.</li>
                    <li>Completion wheels on tabs show progress for each area.</li>
                    <li>You can return to this Intro tab any time for the same baseline instructions.</li>
                  </ul>
                </div>
              </div>
            ) : null}
            */}

            {currentTab.kind === 'curriculum' ? (
              <div className="space-y-9">
                <div className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
                  <p className="min-w-0 flex-1">
                    {selectedPackageId
                      ? 'Select a module from the table of contents to view Step and Quiz tabs for that module.'
                      : 'Select a training package below to load its table of contents.'}
                  </p>
                  {selectedPackageId && curriculumSwapPhase === 'toc_idle' ? (
                    <button
                      type="button"
                      onClick={handleCurriculumChangePackage}
                      className="shrink-0 rounded-md border border-indigo-300 bg-white px-2.5 py-1 text-xs font-semibold text-indigo-900 hover:bg-indigo-100"
                    >
                      Choose a different package
                    </button>
                  ) : null}
                </div>

                <div
                  ref={curriculumPackagesRegionRef}
                  className="relative space-y-9 overflow-x-hidden"
                >
                  {showCurriculumPackages ? (
                    <div
                      className={`will-change-transform ${packagesShellClass}`}
                      style={{ transition: packagesShellTransition }}
                      onTransitionEnd={event => {
                        onPackagesExitTransitionEnd(event);
                        onPackagesEnterTransitionEnd(event);
                      }}
                    >
                      <TrainingPackageSelector
                        packages={packages}
                        selectedPackageId={selectedPackageId}
                        onSelectPackage={handleCurriculumPackageSelect}
                      />
                    </div>
                  ) : null}

                  {showCurriculumToc && selectedPackage ? (
                    <div
                      className={`will-change-transform ${tocShellClass}`}
                      style={{ transition: tocShellTransition }}
                      onTransitionEnd={event => {
                        onTocEnterTransitionEnd(event);
                        onTocExitTransitionEnd(event);
                      }}
                    >
                      <div className="flex min-h-[360px] flex-col">
                        <h2 className="ml-6 mb-3 border-b border-gray-200 pb-2 text-xl font-semibold leading-snug tracking-tight text-gray-300">
                          {formatPackageTitleCase(selectedPackage.title)}
                        </h2>
                   
                        <TrainingTocTree
                          modules={tocModules}
                          expandedModuleIds={expandedModuleIds}
                          selectedModuleId={selectedModuleId}
                          selectedStepKey={currentDynamic?.stepKey || ''}
                          modulePercentById={modulePercentById}
                          stepPercentByKey={stepPercentByKey}
                          onToggleModule={moduleId => {
                            setIsTocCollapsedAll(false);
                            setExpandedModuleIds(previousIds =>
                              previousIds.includes(moduleId) ? [] : [moduleId]
                            );
                          }}
                          onSelectModule={onSelectModule}
                          onSelectStep={onSelectStep}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {currentTab.kind === 'step' && currentDynamic ? (
              <TrainingStepViewport
                packageTitle={selectedPackage?.title || 'No package selected'}
                moduleTitle={selectedModuleObject?.title || 'No module selected'}
                moduleOrdinalInPackage={selectedModuleOrdinalInPackage}
                modulePurpose={selectedModuleObject?.modulePurpose || ''}
                step={currentDynamic.step}
                stepNumberInModule={currentDynamic.stepNumber}
                totalStepsInModule={currentDynamic.totalSteps}
                onUpdateStepQuiz={updater =>
                  onUpdateQuizForStep(currentDynamic.moduleId, currentDynamic.step.id, updater)
                }
                showEmbeddedQuiz={false}
                headerActions={nextTabControl}
                onAudioPlayStart={bumpColumbusIntroFromAudio}
                onAudioPlayPause={hideColumbusFromAudioPause}
              />
            ) : null}

            {currentTab.kind === 'quiz' && currentDynamic ? (
              <div className="rounded-lg border border-sky-200 bg-gradient-to-b from-sky-50 to-white p-3 pl-12">
                {moduleContextHeadingLabel ? (
                  <p className="mb-2 shrink-0 text-center text-sm font-semibold text-slate-400">
                    {moduleContextHeadingLabel}
                  </p>
                ) : null}
                <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                  <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-purple-200 py-1 pl-4 pr-2.5 ml-6 text-sm font-semibold text-slate-800">
                    <ClipboardList className="h-3.5 w-3.5" />
                    <span>Quiz</span>
                  </div>
                  {nextTabControl}
                </div>
                {currentDynamic.step.sectionQuiz ? (
                  <QuizPlayer
                    quiz={currentDynamic.step.sectionQuiz}
                    onUpdateQuiz={updater =>
                      onUpdateQuizForStep(currentDynamic.moduleId, currentDynamic.step.id, updater)
                    }
                    onCompleteQuizAttempt={async ({ score, totalQuestions }) => {
                      if (!selectedPackage || !onCompleteLibraryQuiz || !currentDynamic.step.sectionQuiz) {
                        return undefined;
                      }
                      return onCompleteLibraryQuiz({
                        packageId: selectedPackage.id,
                        moduleId: currentDynamic.moduleId,
                        stepId: currentDynamic.step.id,
                        quizId: currentDynamic.step.sectionQuiz.id,
                        score,
                        totalQuestions
                      });
                    }}
                    onNavigateToCertificates={() => {
                      setSelectedTabId(CERTIFICATES_TAB_ID);
                      onNavigateToCertificates?.();
                    }}
                    onCompletionPrimaryAction={handleQuizCompletionPrimary}
                    completionPrimaryActionLabel={
                      quizCompletionHasNextModule ? 'Go to next module' : 'Close'
                    }
                  />
                ) : (
                  <div className="rounded border border-dashed border-sky-200 bg-white p-3 text-sm text-slate-700">
                    No quiz configured for this step.
                  </div>
                )}
              </div>
            ) : null}

            {currentTab.kind === 'certificates' ? (
              <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50/80 p-9">
                <h3 className="text-lg font-semibold text-slate-900">Certificates Gallery</h3>
                <p className="text-sm text-slate-700">
                  Complete package quizzes with a cumulative score of 70% or better to unlock certificates.
                </p>
                <div className="space-y-10 pt-6">
                  {certificateCards.map(card => {
                    const moduleRows = requiredModuleRowsByPackage.get(card.packageId) ?? [];
                    return (
                      <div
                        key={card.packageId}
                        className="flex flex-col gap-6 rounded-xl border border-slate-200/90 bg-white p-4 shadow-md lg:flex-row lg:items-stretch lg:gap-8"
                      >
                        <div
                          className={`relative min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 pb-3 pt-2 shadow-lg lg:max-w-xl ${
                            card.earned ? '' : 'opacity-60 grayscale'
                          }`}
                        >
                          {card.earned ? (
                            <span
                              className="absolute right-2 top-2 z-10 cursor-default text-emerald-600"
                              title="You have earned this certificate."
                              role="img"
                              aria-label="You have earned this certificate."
                            >
                              <CheckCircle2 className="h-7 w-7" strokeWidth={2} aria-hidden />
                            </span>
                          ) : (
                            <span
                              className="absolute right-2 top-2 z-10 cursor-default text-slate-400"
                              title="Complete the package quiz requirements with a cumulative score of 70% or better to earn this certificate."
                              role="img"
                              aria-label="Certificate locked. Complete the package quiz requirements with a cumulative score of 70% or better to earn this certificate."
                            >
                              <Lock className="h-6 w-6" aria-hidden />
                            </span>
                          )}

                          <div className="flex flex-col">
                            <div className="flex w-full justify-center">
                              <img
                                src={card.certificate.certificateImageUrl}
                                alt={card.certificate.certificateName}
                                className="max-h-[min(calc(36rem*0.85),calc(78vh*0.85),calc(92vw*0.85))] w-auto max-w-full object-contain object-center px-12 py-12"
                              />
                            </div>

                            <hr className="mt-2 border-t border-slate-200 mb-3" />

                            <div className="flex justify-center">
                              <div className="w-full max-w-md rounded-lg border border-blue-200 bg-gradient-to-b from-sky-50 via-blue-50/90 to-white px-4 py-3 text-center shadow-md">
                                <p className="text-base font-semibold text-slate-900">
                                  {card.certificate.certificateName}
                                </p>
                                <p className="mt-2 text-sm text-slate-700">
                                  Package: {card.certificate.packageName || card.packageTitle}
                                </p>
                                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                                  {card.earned && card.awardedAt ? (
                                    <span className="inline-flex items-center rounded-full border border-sky-400/80 bg-white/95 px-3 py-1 text-xs font-semibold text-sky-950 shadow-sm backdrop-blur-sm">
                                      Issued: {new Date(card.awardedAt).toLocaleString()}
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center rounded-full border border-slate-300 bg-white/80 px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm">
                                      Not yet awarded
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="min-w-0 flex-1 lg:border-l lg:border-slate-200 lg:pl-8">
                          <h4 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                            Required modules
                          </h4>
                          <p className="mt-1 text-xs text-slate-500">
                            Quiz status per module (100% on every section quiz in the module to show as passed).
                          </p>
                          <ul className="mt-4 flex flex-col gap-2.5" aria-label="Required modules and quiz progress">
                            {moduleRows.length === 0 ? (
                              <li className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-3 py-2 text-sm text-slate-500">
                                No required modules in this package.
                              </li>
                            ) : (
                              moduleRows.map(row => {
                                const baseLi =
                                  'flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left shadow-sm transition-colors';
                                if (row.variant === 'perfect') {
                                  return (
                                    <li
                                      key={row.moduleId}
                                      className={`${baseLi} border-emerald-200/90 bg-gradient-to-r from-emerald-50/95 to-white`}
                                    >
                                      <CheckCircle2
                                        className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600"
                                        aria-hidden
                                      />
                                      <div className="min-w-0 flex-1">
                                        <p className="text-sm font-semibold text-emerald-950">{row.title}</p>
                                        <p className="text-xs font-medium text-emerald-800">100% — Passed</p>
                                      </div>
                                    </li>
                                  );
                                }
                                if (row.variant === 'partial') {
                                  return (
                                    <li
                                      key={row.moduleId}
                                      className={`${baseLi} border-amber-200/90 bg-gradient-to-r from-amber-50/95 to-white`}
                                    >
                                      <MinusCircle
                                        className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
                                        aria-hidden
                                      />
                                      <div className="min-w-0 flex-1">
                                        <p className="text-sm font-semibold text-amber-950">{row.title}</p>
                                        <p className="text-xs font-medium text-amber-900">
                                          {Math.round(row.scorePercent ?? 0)}% (need 100%)
                                          {row.hasMissingQuiz ? ' · some quizzes not completed yet' : ''}
                                        </p>
                                      </div>
                                    </li>
                                  );
                                }
                                if (row.variant === 'not_started') {
                                  return (
                                    <li
                                      key={row.moduleId}
                                      className={`${baseLi} border-slate-200 bg-slate-50/95`}
                                    >
                                      <MinusCircle
                                        className="mt-0.5 h-5 w-5 shrink-0 text-slate-400"
                                        aria-hidden
                                      />
                                      <div className="min-w-0 flex-1">
                                        <p className="text-sm font-semibold text-slate-800">{row.title}</p>
                                        <p className="text-xs font-medium text-slate-600">Not started</p>
                                      </div>
                                    </li>
                                  );
                                }
                                return (
                                  <li
                                    key={row.moduleId}
                                    className={`${baseLi} border-violet-200/80 bg-violet-50/70`}
                                  >
                                    <ClipboardList
                                      className="mt-0.5 h-5 w-5 shrink-0 text-violet-600"
                                      aria-hidden
                                    />
                                    <div className="min-w-0 flex-1">
                                      <p className="text-sm font-semibold text-violet-950">{row.title}</p>
                                      <p className="text-xs font-medium text-violet-800">No section quiz in this module</p>
                                    </div>
                                  </li>
                                );
                              })
                            )}
                          </ul>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {showColumbusCallout ? (
        <div className="mt-4 shrink-0">
          <ColumbusTrainingCallout
            ref={columbusCalloutRef}
            showDevControls={columbusShowDevControls}
            onDismiss={() => setColumbusDismissedUntilNextPlay(true)}
            showReplayButton
            introPlayToken={columbusIntroPlayToken}
          />
        </div>
      ) : null}
    </section>
  );
};

export default TrainingPlayer2Panel;
