import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ExternalLink, Minimize2, MonitorPlay, Move } from 'lucide-react';
import { useShowCalloutControls } from '../../../../hooks/useShowCalloutControls';

import type {
  ModuleStep,
  SectionQuiz,
  TrainingModule,
  TrainingPackage
} from '../trainingTypes';
import TrainingPackageSelector from './TrainingPackageSelector';
import TrainingPlayerControls from './TrainingPlayerControls';
import TrainingStepViewport from './TrainingStepViewport';
import ColumbusTrainingCallout, { type ColumbusTrainingCalloutHandle } from './ColumbusTrainingCallout';
import TrainingTocTree, { type TocModuleItem } from './TrainingTocTree';

type PlayerStepEntry = {
  key: string;
  moduleId: string;
  moduleTitle: string;
  modulePurpose: string;
  stepNumberInModule: number;
  totalStepsInModule: number;
  step: ModuleStep;
};

type Props = {
  packages: TrainingPackage[];
  moduleLibrary: TrainingModule[];
  initialPackageId?: string;
  onUpdateModule: (moduleId: string, updater: (module: TrainingModule) => TrainingModule) => void;
  /** Cleaner header; hides pop-out/dock on agent-facing pages */
  embedded?: boolean;
  /** When the learner leaves a module (next module or end of package), for server progress tracking */
  onModuleCompleted?: (packageId: string, moduleId: string) => void;
};

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

const TrainingPlayerPanel: React.FC<Props> = ({
  packages,
  moduleLibrary,
  initialPackageId,
  onUpdateModule,
  embedded = false,
  onModuleCompleted
}) => {
  const showCalloutControls = useShowCalloutControls();

  const [selectedPackageId, setSelectedPackageId] = useState<string>(
    initialPackageId || packages[0]?.id || ''
  );
  const [selectedModuleId, setSelectedModuleId] = useState<string>('');
  const [selectedStepKey, setSelectedStepKey] = useState<string>('');
  const [expandedModuleIds, setExpandedModuleIds] = useState<string[]>([]);
  const [isTocCollapsedAll, setIsTocCollapsedAll] = useState<boolean>(false);
  const [completedStepKeys, setCompletedStepKeys] = useState<string[]>([]);
  const [isPoppedOut, setIsPoppedOut] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [showColumbusCallout, setShowColumbusCallout] = useState<boolean>(true);
  const [columbusDismissedUntilNextPlay, setColumbusDismissedUntilNextPlay] = useState<boolean>(false);
  const [columbusIntroPlayToken, setColumbusIntroPlayToken] = useState(0);
  const columbusCalloutRef = useRef<ColumbusTrainingCalloutHandle | null>(null);
  const [popPosition, setPopPosition] = useState<{ x: number; y: number }>({
    x: 120,
    y: 72
  });
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

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

  const reportModuleCompleted = (packageId: string, moduleId: string): void => {
    if (!onModuleCompleted || !packageId || !moduleId) {
      return;
    }
    const dedupeKey = `${packageId}::${moduleId}`;
    if (moduleCompletionReportedRef.current.has(dedupeKey)) {
      return;
    }
    moduleCompletionReportedRef.current.add(dedupeKey);
    onModuleCompleted(packageId, moduleId);
  };

  useEffect(() => {
    moduleCompletionReportedRef.current.clear();
  }, [selectedPackageId]);

  useEffect(() => {
    setCompletedStepKeys([]);
    setIsTocCollapsedAll(false);
  }, [selectedPackageId]);

  const completedStepKeySet = useMemo(() => new Set(completedStepKeys), [completedStepKeys]);

  const markStepCompleted = (stepKey: string): void => {
    if (!stepKey) {
      return;
    }
    setCompletedStepKeys(prev => (prev.includes(stepKey) ? prev : [...prev, stepKey]));
  };

  useEffect(() => {
    if (embedded && isPoppedOut) {
      setIsPoppedOut(false);
    }
  }, [embedded, isPoppedOut]);

  const moduleLookup = useMemo(
    () => new Map(moduleLibrary.map(module => [module.id, module])),
    [moduleLibrary]
  );

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

  const flattenedSteps = useMemo<PlayerStepEntry[]>(() => {
    const entries: PlayerStepEntry[] = [];
    tocModules.forEach(module => {
      const sourceModule = moduleLookup.get(module.id);
      if (!sourceModule) {
        return;
      }
      sourceModule.moduleSteps.forEach((step, index) => {
        entries.push({
          key: buildStepKey(sourceModule.id, step.id),
          moduleId: sourceModule.id,
          moduleTitle: sourceModule.title,
          modulePurpose: sourceModule.modulePurpose,
          stepNumberInModule: index + 1,
          totalStepsInModule: sourceModule.moduleSteps.length,
          step
        });
      });
    });
    return entries;
  }, [moduleLookup, tocModules]);

  useEffect(() => {
    if (tocModules.length === 0) {
      setExpandedModuleIds([]);
      setSelectedStepKey('');
      setSelectedModuleId('');
      setIsTocCollapsedAll(false);
      return;
    }

    const selectedModuleStillExists = tocModules.some(module => module.id === selectedModuleId);
    if (!selectedModuleStillExists) {
      const firstModuleId = tocModules[0].id;
      setExpandedModuleIds(isTocCollapsedAll ? [] : [firstModuleId]);
      setSelectedModuleId(firstModuleId);
      setSelectedStepKey('');
      return;
    }

    if (selectedStepKey) {
      const stillExists = flattenedSteps.some(step => step.key === selectedStepKey);
      if (!stillExists) {
        setSelectedStepKey('');
      }
    }
  }, [flattenedSteps, isTocCollapsedAll, selectedModuleId, selectedStepKey, tocModules]);

  useEffect(() => {
    if (!selectedModuleId || isTocCollapsedAll) {
      return;
    }
    setExpandedModuleIds(previousIds =>
      previousIds.length === 1 && previousIds[0] === selectedModuleId ? previousIds : [selectedModuleId]
    );
  }, [isTocCollapsedAll, selectedModuleId]);

  const currentStepIndex = useMemo(
    () => flattenedSteps.findIndex(step => step.key === selectedStepKey),
    [flattenedSteps, selectedStepKey]
  );

  const currentStepEntry = currentStepIndex >= 0 ? flattenedSteps[currentStepIndex] : null;

  const stepPercentByKey = useMemo(() => {
    const map: Record<string, number> = {};
    flattenedSteps.forEach(entry => {
      if (completedStepKeySet.has(entry.key)) {
        map[entry.key] = 100;
        return;
      }
      map[entry.key] = computeQuizProgressPercent(entry.step);
    });
    return map;
  }, [flattenedSteps, completedStepKeySet, moduleLibrary]);

  const modulePercentById = useMemo(() => {
    const out: Record<string, number> = {};
    tocModules.forEach(mod => {
      if (mod.steps.length === 0) {
        out[mod.id] = 0;
        return;
      }
      let sum = 0;
      mod.steps.forEach(s => {
        sum += stepPercentByKey[s.key] ?? 0;
      });
      out[mod.id] = Math.round(sum / mod.steps.length);
    });
    return out;
  }, [tocModules, stepPercentByKey]);

  const toggleModule = (moduleId: string): void => {
    setIsTocCollapsedAll(false);
    setExpandedModuleIds(previousIds => (previousIds.includes(moduleId) ? [] : [moduleId]));
  };

  const selectModule = (moduleId: string): void => {
    const moduleEntry = tocModules.find(module => module.id === moduleId);
    if (!moduleEntry) {
      return;
    }

    setIsTocCollapsedAll(false);
    setExpandedModuleIds([moduleId]);
    setSelectedModuleId(moduleId);
    setSelectedStepKey('');
  };

  const goPrev = (): void => {
    if (currentStepIndex <= 0) {
      return;
    }
    const nextStep = flattenedSteps[currentStepIndex - 1];
    setIsTocCollapsedAll(false);
    setExpandedModuleIds([nextStep.moduleId]);
    setSelectedModuleId(nextStep.moduleId);
    setSelectedStepKey(nextStep.key);
  };

  const goNext = (): void => {
    if (currentStepIndex < 0) {
      const moduleStartStep =
        flattenedSteps.find(step => step.moduleId === selectedModuleId) || flattenedSteps[0];
      if (!moduleStartStep) {
        return;
      }
      setIsTocCollapsedAll(false);
      setExpandedModuleIds([moduleStartStep.moduleId]);
      setSelectedModuleId(moduleStartStep.moduleId);
      setSelectedStepKey(moduleStartStep.key);
      return;
    }
    if (currentStepIndex >= flattenedSteps.length - 1) {
      const last = flattenedSteps[currentStepIndex];
      if (last) {
        markStepCompleted(last.key);
        reportModuleCompleted(selectedPackageId, last.moduleId);
      }
      return;
    }
    const cur = flattenedSteps[currentStepIndex];
    const nextStep = flattenedSteps[currentStepIndex + 1];
    markStepCompleted(cur.key);
    if (cur.moduleId !== nextStep.moduleId) {
      reportModuleCompleted(selectedPackageId, cur.moduleId);
    }
    setIsTocCollapsedAll(false);
    setExpandedModuleIds([nextStep.moduleId]);
    setSelectedModuleId(nextStep.moduleId);
    setSelectedStepKey(nextStep.key);
  };

  const restart = (): void => {
    if (flattenedSteps.length === 0) {
      return;
    }
    const moduleStartStep =
      flattenedSteps.find(step => step.moduleId === selectedModuleId) || flattenedSteps[0];
    setIsTocCollapsedAll(false);
    setExpandedModuleIds([moduleStartStep.moduleId]);
    setSelectedModuleId(moduleStartStep.moduleId);
    setSelectedStepKey(moduleStartStep.key);
    setCompletedStepKeys([]);
  };

  const selectedModuleEntry = useMemo(() => {
    if (!selectedModuleId) {
      return null;
    }
    return tocModules.find(module => module.id === selectedModuleId) || null;
  }, [selectedModuleId, tocModules]);

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

  const selectedStepProgress = useMemo(() => {
    if (!selectedModuleObject || !selectedStepKey) {
      return 0;
    }
    const selectedStepId = selectedStepKey.split('::')[1];
    const indexInModule = selectedModuleObject.moduleSteps.findIndex(
      moduleStep => moduleStep.id === selectedStepId
    );
    return indexInModule >= 0 ? indexInModule + 1 : 0;
  }, [selectedModuleObject, selectedStepKey]);

  const onUpdateCurrentStepQuiz = (updater: (quiz: SectionQuiz) => SectionQuiz): void => {
    if (!currentStepEntry?.step.sectionQuiz) {
      return;
    }
    const moduleId = currentStepEntry.moduleId;
    const stepId = currentStepEntry.step.id;

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

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    const onMouseMove = (event: MouseEvent): void => {
      const targetX = event.clientX - dragOffsetRef.current.x;
      const targetY = event.clientY - dragOffsetRef.current.y;
      const maxX = Math.max(window.innerWidth - 360, 16);
      const maxY = Math.max(window.innerHeight - 220, 16);
      setPopPosition({
        x: Math.min(Math.max(16, targetX), maxX),
        y: Math.min(Math.max(16, targetY), maxY)
      });
    };

    const onMouseUp = (): void => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging]);

  const beginDrag = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (!isPoppedOut) {
      return;
    }
    dragOffsetRef.current = {
      x: event.clientX - popPosition.x,
      y: event.clientY - popPosition.y
    };
    setIsDragging(true);
  };

  const sectionClassName = isPoppedOut
    ? 'fixed z-[110] w-[min(980px,92vw)] h-[min(88vh,940px)] overflow-auto bg-white rounded-lg border border-slate-300 p-4 shadow-2xl'
    : 'relative h-full bg-white rounded-lg border border-gray-200 p-4 flex flex-col';

  return (
    <section
      className={sectionClassName}
      style={isPoppedOut ? { left: popPosition.x, top: popPosition.y } : undefined}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
            <span className="inline-flex items-center gap-1.5">
              <MonitorPlay className="h-4 w-4 text-gray-800" />
              <span>{embedded ? 'Training' : 'Training Player (Skeleton)'}</span>
            </span>
          </h2>
          {!embedded && (
            <p className="text-xs text-gray-600 mt-1">
              Package -&gt; module/step TOC -&gt; viewport with play controls.
            </p>
          )}
        </div>

        {!embedded && (
          <div className="flex items-center gap-2">
            {isPoppedOut && (
              <button
                type="button"
                onMouseDown={beginDrag}
                className={`inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 ${
                  isDragging ? 'cursor-grabbing' : 'cursor-grab'
                }`}
                title="Drag player"
              >
                <Move className="h-3.5 w-3.5" />
                Drag
              </button>
            )}
            <button
              type="button"
              onClick={() => setIsPoppedOut(previousValue => !previousValue)}
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
              title={isPoppedOut ? 'Dock player' : 'Pop out player'}
            >
              {isPoppedOut ? (
                <>
                  <Minimize2 className="h-3.5 w-3.5" />
                  <span>Dock</span>
                </>
              ) : (
                <>
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>Pop Out</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>

      <TrainingPackageSelector
        packages={packages}
        selectedPackageId={selectedPackageId}
        onSelectPackage={packageId => {
          setSelectedPackageId(packageId);
          setSelectedModuleId('');
          setSelectedStepKey('');
          setCompletedStepKeys([]);
        }}
      />

      <div
        className={`mt-3 grid grid-cols-1 gap-3 flex-1 min-h-0 ${selectedPackageId ? 'lg:grid-cols-12' : ''}`}
      >
        {selectedPackageId ? (
          <div className="lg:col-span-4 min-h-[260px] max-h-[45vh] lg:max-h-none lg:min-h-0 h-full flex flex-col">
            <TrainingTocTree
              modules={tocModules}
              expandedModuleIds={expandedModuleIds}
              selectedModuleId={selectedModuleId}
              selectedStepKey={selectedStepKey}
              modulePercentById={modulePercentById}
              stepPercentByKey={stepPercentByKey}
              onToggleModule={toggleModule}
              onSelectModule={selectModule}
              onSelectStep={stepKey => {
                const stepEntry = flattenedSteps.find(step => step.key === stepKey);
                if (stepEntry) {
                  setIsTocCollapsedAll(false);
                  setExpandedModuleIds([stepEntry.moduleId]);
                  setSelectedModuleId(stepEntry.moduleId);
                }
                setSelectedStepKey(stepKey);
              }}
            />
          </div>
        ) : null}

        <div
          className={`min-h-[420px] lg:min-h-0 flex flex-col gap-3 ${selectedPackageId ? 'lg:col-span-8' : 'lg:col-span-12'}`}
        >
          <TrainingPlayerControls
            canNavigate={flattenedSteps.length > 0}
            canPrev={currentStepIndex > 0}
            canNext={
              currentStepIndex >= 0
                ? currentStepIndex < flattenedSteps.length - 1
                : flattenedSteps.some(step => step.moduleId === selectedModuleId)
            }
            completedSteps={selectedStepProgress}
            totalSteps={selectedModuleObject?.moduleSteps.length || 0}
            onPrev={goPrev}
            onNext={goNext}
            onRestart={restart}
          />

          <div className="flex-1 min-h-[320px] lg:min-h-0">
            <TrainingStepViewport
              packageTitle={selectedPackage?.title || 'No package selected'}
              moduleTitle={currentStepEntry?.moduleTitle || selectedModuleEntry?.title || 'No module selected'}
              moduleOrdinalInPackage={selectedModuleOrdinalInPackage}
              modulePurpose={
                currentStepEntry?.modulePurpose ||
                selectedModuleObject?.modulePurpose ||
                ''
              }
              step={currentStepEntry?.step || null}
              stepNumberInModule={currentStepEntry?.stepNumberInModule || 0}
              totalStepsInModule={currentStepEntry?.totalStepsInModule || selectedModuleObject?.moduleSteps.length || 0}
              onUpdateStepQuiz={onUpdateCurrentStepQuiz}
              onAudioPlayStart={bumpColumbusIntroFromAudio}
              onAudioPlayPause={hideColumbusFromAudioPause}
            />
          </div>
        </div>
      </div>

      {showColumbusCallout ? (
        <div className="mt-4 shrink-0">
          <ColumbusTrainingCallout
            ref={columbusCalloutRef}
            showDevControls={showCalloutControls}
            onDismiss={() => setColumbusDismissedUntilNextPlay(true)}
            onButtonClick={() => setShowColumbusCallout(false)}
            introPlayToken={columbusIntroPlayToken}
          />
        </div>
      ) : null}
    </section>
  );
};

export default TrainingPlayerPanel;
