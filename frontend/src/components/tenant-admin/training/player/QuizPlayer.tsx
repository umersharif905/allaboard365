import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  CheckCircle2,
  Minus,
  PlayCircle,
  Shuffle,
  Timer,
  TrendingDown,
  TrendingUp,
  Trophy,
  XCircle
} from 'lucide-react';

import type { AnswerChoice, QuizTake, SectionQuiz } from '../trainingTypes';
import QuizCompletionScoreGauge from './QuizCompletionScoreGauge';

type Props = {
  quiz: SectionQuiz;
  onUpdateQuiz: (updater: (quiz: SectionQuiz) => SectionQuiz) => void;
  onCompleteQuizAttempt?: (payload: {
    score: number;
    totalQuestions: number;
    attemptType?: 'full' | 'retrain';
    missedQuestionIds?: string[];
    effectiveScore?: number;
    effectiveTotalQuestions?: number;
  }) => Promise<{ packageCertificationPassed?: boolean } | void> | { packageCertificationPassed?: boolean } | void;
  onNavigateToCertificates?: () => void;
  /** When set, replaces the completion modal "Close" button: closes modal then runs this (e.g. go to next module). */
  onCompletionPrimaryAction?: () => void;
  completionPrimaryActionLabel?: string;
};

const createQuizTakeId = (): string =>
  `take-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;

const MOCK_CURRENT_USER_ID = 'mock-user-current';

type CompletionSnapshot = {
  score: number;
  total: number;
  showCertificatesCta: boolean;
  attemptType: 'full' | 'retrain';
  missedQuestionIds: string[];
  effectiveScore?: number;
  effectiveTotalQuestions?: number;
};

type RetrainContext = {
  baseTake: QuizTake;
  missedQuestionIds: string[];
};

type ScoreTileTone = 'success' | 'danger';

const SCORE_TILE_STYLES: Record<ScoreTileTone, { ring: string; ringTrack: string }> = {
  success: {
    ring: '#7ac943',
    ringTrack: '#dcf4cb'
  },
  danger: {
    ring: '#c2403d',
    ringTrack: '#f4d3d2'
  }
};

type QuizScoreTileProps = {
  tone: ScoreTileTone;
  title: string;
  percent: number;
  headline: string;
  footer: React.ReactNode;
  topRight?: React.ReactNode;
};

const QuizScoreTile: React.FC<QuizScoreTileProps> = ({
  tone,
  title,
  percent,
  headline,
  footer,
  topRight
}) => {
  const s = SCORE_TILE_STYLES[tone];
  const boundedPercent = Math.max(0, Math.min(100, Math.round(percent)));
  const size = 76;
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - boundedPercent / 100);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="shrink-0">
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            role="img"
            aria-label={`${title} ${boundedPercent}%`}
          >
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke={s.ringTrack}
              strokeWidth={strokeWidth}
              fill="none"
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke={s.ring}
              strokeWidth={strokeWidth}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
            <text
              x="50%"
              y="50%"
              dominantBaseline="central"
              textAnchor="middle"
              fill="#0f172a"
              style={{ fontSize: '17px', fontWeight: 700 }}
            >
              {boundedPercent}%
            </text>
          </svg>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold leading-tight text-slate-700">{title}</p>
            {topRight ? (
              <div className="shrink-0 text-right text-[11px] font-medium text-slate-600">{topRight}</div>
            ) : null}
          </div>
          <p className="mt-1 text-[1.8rem] font-bold leading-none tracking-tight text-slate-900">{headline}</p>
          <div className="mt-2 text-xs font-medium text-slate-600">{footer}</div>
        </div>
      </div>
    </div>
  );
};

const sortQuestionsForQuiz = (questions: SectionQuiz['questions']) =>
  questions.slice().sort((a, b) => {
    if (a.questionNumber === b.questionNumber) {
      return a.id.localeCompare(b.id);
    }
    return a.questionNumber - b.questionNumber;
  });

const getAttemptQuestionIds = (
  take: QuizTake | null,
  orderedQuestions: SectionQuiz['questions']
): string[] => {
  if (!take?.questionIds?.length) {
    return orderedQuestions.map(question => question.id);
  }
  const orderedSet = new Set(orderedQuestions.map(question => question.id));
  return take.questionIds.filter(questionId => orderedSet.has(questionId));
};

const QuizPlayer: React.FC<Props> = ({
  quiz,
  onUpdateQuiz,
  onCompleteQuizAttempt,
  onNavigateToCertificates,
  onCompletionPrimaryAction,
  completionPrimaryActionLabel
}) => {
  const [completionSnapshot, setCompletionSnapshot] = useState<CompletionSnapshot | null>(null);
  const [submittingCompletion, setSubmittingCompletion] = useState(false);
  const [retrainContext, setRetrainContext] = useState<RetrainContext | null>(null);
  const isLocalHost =
    typeof window !== 'undefined' &&
    ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

  const confettiPieces = useMemo(
    () =>
      Array.from({ length: 28 }, (_, index) => ({
        id: index,
        left: `${(index * 13) % 100}%`,
        delay: `${(index % 7) * 0.12}s`,
        duration: `${1.7 + (index % 5) * 0.22}s`,
        backgroundClass: [
          'bg-rose-400',
          'bg-sky-400',
          'bg-emerald-400',
          'bg-amber-400',
          'bg-violet-400',
          'bg-fuchsia-400'
        ][index % 6]
      })),
    []
  );

  const orderedQuestions = useMemo(() => sortQuestionsForQuiz(quiz.questions), [quiz.questions]);

  const latestTake = quiz.quizTakes.length > 0 ? quiz.quizTakes[quiz.quizTakes.length - 1] : null;
  const status = latestTake?.status || 'not_started';
  const totalQuestionsInQuiz = orderedQuestions.length;
  const attemptQuestionIds = useMemo(
    () => getAttemptQuestionIds(latestTake, orderedQuestions),
    [latestTake, orderedQuestions]
  );
  const attemptQuestionIdSet = useMemo(() => new Set(attemptQuestionIds), [attemptQuestionIds]);
  const activeQuestions = useMemo(
    () => orderedQuestions.filter(question => attemptQuestionIdSet.has(question.id)),
    [orderedQuestions, attemptQuestionIdSet]
  );
  const questionCount = activeQuestions.length;
  const estimatedMinutes = Math.max(1, Number(quiz.estimatedDurationMinutes) || 1);

  const currentQuestionIndex = latestTake
    ? Math.min(Math.max(latestTake.currentQuestionIndex, 0), Math.max(questionCount - 1, 0))
    : 0;
  const currentQuestion = activeQuestions[currentQuestionIndex];
  const selectedAnswer = currentQuestion
    ? latestTake?.answers.find(answer => answer.questionId === currentQuestion.id) || null
    : null;

  const answeredCount = latestTake
    ? latestTake.answers.filter(answer => attemptQuestionIdSet.has(answer.questionId)).length
    : 0;
  const canComplete = questionCount > 0 && answeredCount === questionCount && status !== 'completed';
  const completedScore =
    latestTake && latestTake.status === 'completed'
      ? latestTake.answers.filter(
          answer => answer.isCorrect && attemptQuestionIdSet.has(answer.questionId)
        ).length
      : 0;

  const priorCompletedTake = useMemo(() => {
    const takes = quiz.quizTakes;
    if (takes.length < 2) {
      return null;
    }
    for (let i = takes.length - 2; i >= 0; i -= 1) {
      if (takes[i].status === 'completed') {
        return takes[i];
      }
    }
    return null;
  }, [quiz.quizTakes]);

  const positivePercent =
    questionCount > 0 ? Math.round((completedScore / questionCount) * 100) : 0;
  const negativePercent = questionCount > 0 ? Math.max(0, 100 - positivePercent) : 0;

  const priorCompletedQuestionCount = priorCompletedTake
    ? getAttemptQuestionIds(priorCompletedTake, orderedQuestions).length
    : 0;
  const prevPositivePercent =
    priorCompletedTake && priorCompletedQuestionCount > 0
      ? Math.round(
          (priorCompletedTake.answers.filter(a => a.isCorrect).length / priorCompletedQuestionCount) *
            100
        )
      : null;

  const positiveDelta =
    prevPositivePercent === null ? null : positivePercent - prevPositivePercent;
  const negativeDelta =
    prevPositivePercent === null ? null : negativePercent - (100 - prevPositivePercent);

  const incorrectCount = Math.max(0, questionCount - completedScore);

  const updateLatestTake = (updater: (take: QuizTake) => QuizTake): void => {
    onUpdateQuiz(currentQuiz => {
      if (currentQuiz.quizTakes.length === 0) {
        return currentQuiz;
      }
      const updatedTakes = currentQuiz.quizTakes.slice();
      const latestIndex = updatedTakes.length - 1;
      updatedTakes[latestIndex] = updater(updatedTakes[latestIndex]);
      return { ...currentQuiz, quizTakes: updatedTakes };
    });
  };

  const startQuiz = (): void => {
    setCompletionSnapshot(null);
    setRetrainContext(null);
    onUpdateQuiz(currentQuiz => ({
      ...currentQuiz,
      quizTakes: [
        ...currentQuiz.quizTakes,
        {
          id: createQuizTakeId(),
          userId: MOCK_CURRENT_USER_ID,
          status: 'started',
          startedAt: new Date().toISOString(),
          currentQuestionIndex: 0,
          answers: [],
          questionIds: sortQuestionsForQuiz(currentQuiz.questions).map(question => question.id),
          attemptType: 'full'
        }
      ]
    }));
  };

  const startRetrain = (baseTake: QuizTake, missedQuestionIds: string[]): void => {
    if (!missedQuestionIds.length) {
      return;
    }
    setCompletionSnapshot(null);
    setRetrainContext({
      baseTake,
      missedQuestionIds
    });
    onUpdateQuiz(currentQuiz => ({
      ...currentQuiz,
      quizTakes: [
        ...currentQuiz.quizTakes,
        {
          id: createQuizTakeId(),
          userId: MOCK_CURRENT_USER_ID,
          status: 'started',
          startedAt: new Date().toISOString(),
          currentQuestionIndex: 0,
          answers: [],
          questionIds: missedQuestionIds,
          attemptType: 'retrain'
        }
      ]
    }));
  };

  const resumeQuiz = (): void => {
    updateLatestTake(take => ({
      ...take,
      status: 'started',
      pausedAt: undefined
    }));
  };

  const completeQuiz = async (): Promise<void> => {
    if (!latestTake || !canComplete) {
      return;
    }

    const takeQuestionIds = getAttemptQuestionIds(latestTake, orderedQuestions);
    const takeQuestionIdSet = new Set(takeQuestionIds);
    const computedScore = latestTake.answers.filter(
      answer => answer.isCorrect && takeQuestionIdSet.has(answer.questionId)
    ).length;
    const missedQuestionIds = takeQuestionIds.filter(questionId => {
      const answer = latestTake.answers.find(candidate => candidate.questionId === questionId);
      return !answer?.isCorrect;
    });
    const isRetrainAttempt = latestTake.attemptType === 'retrain';

    let persistedScore = computedScore;
    let persistedTotalQuestions = takeQuestionIds.length;
    let effectiveMissedQuestionIds = missedQuestionIds;

    if (isRetrainAttempt && retrainContext) {
      const retrainAnswerByQuestionId = new Map(
        latestTake.answers.map(answer => [answer.questionId, answer] as const)
      );
      const baseAnswerByQuestionId = new Map(
        retrainContext.baseTake.answers.map(answer => [answer.questionId, answer] as const)
      );
      const retrainMissedSet = new Set(retrainContext.missedQuestionIds);

      persistedTotalQuestions = totalQuestionsInQuiz;
      persistedScore = orderedQuestions.reduce((correctCount, question) => {
        if (retrainMissedSet.has(question.id)) {
          const retrainAnswer = retrainAnswerByQuestionId.get(question.id);
          return correctCount + (retrainAnswer?.isCorrect ? 1 : 0);
        }
        const baseAnswer = baseAnswerByQuestionId.get(question.id);
        return correctCount + (baseAnswer?.isCorrect ? 1 : 0);
      }, 0);
      effectiveMissedQuestionIds = orderedQuestions
        .filter(question => retrainMissedSet.has(question.id))
        .filter(question => !retrainAnswerByQuestionId.get(question.id)?.isCorrect)
        .map(question => question.id);
    }

    updateLatestTake(take => ({
      ...take,
      status: 'completed',
      completedAt: new Date().toISOString()
    }));

    setCompletionSnapshot({
      score: computedScore,
      total: questionCount,
      showCertificatesCta: persistedScore === persistedTotalQuestions,
      attemptType: isRetrainAttempt ? 'retrain' : 'full',
      missedQuestionIds: effectiveMissedQuestionIds,
      effectiveScore: persistedScore,
      effectiveTotalQuestions: persistedTotalQuestions
    });

    if (onCompleteQuizAttempt) {
      setSubmittingCompletion(true);
      try {
        const result = await onCompleteQuizAttempt({
          score: persistedScore,
          totalQuestions: persistedTotalQuestions,
          attemptType: isRetrainAttempt ? 'retrain' : 'full',
          missedQuestionIds: effectiveMissedQuestionIds,
          effectiveScore: persistedScore,
          effectiveTotalQuestions: persistedTotalQuestions
        });
        const packageCertificationPassed = Boolean(
          result &&
            typeof result === 'object' &&
            'packageCertificationPassed' in result &&
            result.packageCertificationPassed
        );
        setCompletionSnapshot(prev =>
          prev
            ? {
                ...prev,
                showCertificatesCta:
                  packageCertificationPassed || persistedScore === persistedTotalQuestions
              }
            : null
        );
      } catch (error) {
        console.warn('[QuizPlayer] quiz completion persistence failed', error);
      } finally {
        setSubmittingCompletion(false);
      }
    }
  };

  const buildRandomAnswers = (
    quizQuestions: SectionQuiz['questions']
  ): QuizTake['answers'] => {
    return quizQuestions
      .map(question => {
        if (question.answerChoices.length === 0) {
          return null;
        }
        const randomChoice =
          question.answerChoices[
            Math.floor(Math.random() * question.answerChoices.length)
          ];
        return {
          questionId: question.id,
          selectedChoiceId: randomChoice.id,
          selectedOrdinal: randomChoice.answerOrdinal,
          isCorrect: randomChoice.answerTrueFalse,
          answeredAt: new Date().toISOString()
        };
      })
      .filter((answer): answer is NonNullable<typeof answer> => Boolean(answer));
  };

  const autoAnswerQuiz = (): void => {
    onUpdateQuiz(currentQuiz => {
      const sortedQuestions = sortQuestionsForQuiz(currentQuiz.questions);
      const latest = currentQuiz.quizTakes[currentQuiz.quizTakes.length - 1] || null;
      const activeQuestionIds = getAttemptQuestionIds(latest, sortedQuestions);
      const activeQuestionIdSet = new Set(activeQuestionIds);
      const generatedAnswers = buildRandomAnswers(
        sortedQuestions.filter(question => activeQuestionIdSet.has(question.id))
      );

      if (
        currentQuiz.quizTakes.length === 0 ||
        currentQuiz.quizTakes[currentQuiz.quizTakes.length - 1].status === 'completed'
      ) {
        return {
          ...currentQuiz,
          quizTakes: [
            ...currentQuiz.quizTakes,
            {
              id: createQuizTakeId(),
              userId: MOCK_CURRENT_USER_ID,
              status: 'started',
              startedAt: new Date().toISOString(),
              currentQuestionIndex: 0,
              answers: generatedAnswers,
              questionIds: sortedQuestions.map(question => question.id),
              attemptType: 'full'
            }
          ]
        };
      }

      const updatedTakes = currentQuiz.quizTakes.slice();
      const latestIndex = updatedTakes.length - 1;
      updatedTakes[latestIndex] = {
        ...updatedTakes[latestIndex],
        status: 'started',
        pausedAt: undefined,
        currentQuestionIndex: 0,
        answers: generatedAnswers,
        questionIds: activeQuestionIds,
        attemptType: updatedTakes[latestIndex].attemptType || 'full'
      };

      return {
        ...currentQuiz,
        quizTakes: updatedTakes
      };
    });
  };

  const buildCorrectAnswers = (quizQuestions: SectionQuiz['questions']): QuizTake['answers'] => {
    return quizQuestions
      .map(question => {
        if (question.answerChoices.length === 0) {
          return null;
        }
        const correctChoice =
          question.answerChoices.find(choice => choice.answerTrueFalse) ||
          question.answerChoices.find(choice => choice.answerOrdinal === question.answerOrdinal) ||
          question.answerChoices[0];
        return {
          questionId: question.id,
          selectedChoiceId: correctChoice.id,
          selectedOrdinal: correctChoice.answerOrdinal,
          isCorrect: true,
          answeredAt: new Date().toISOString()
        };
      })
      .filter((answer): answer is NonNullable<typeof answer> => Boolean(answer));
  };

  const buildWrongAnswerForQuestion = (
    question: SectionQuiz['questions'][number]
  ): NonNullable<QuizTake['answers'][number]> | null => {
    if (question.answerChoices.length === 0) {
      return null;
    }
    const correctChoice =
      question.answerChoices.find(choice => choice.answerTrueFalse) ||
      question.answerChoices.find(choice => choice.answerOrdinal === question.answerOrdinal) ||
      question.answerChoices[0];
    const wrongPool = question.answerChoices.filter(choice => !choice.answerTrueFalse);
    const pick =
      wrongPool.length > 0
        ? wrongPool[Math.floor(Math.random() * wrongPool.length)]
        : question.answerChoices.find(choice => choice.id !== correctChoice.id) ?? null;
    if (!pick) {
      return null;
    }
    return {
      questionId: question.id,
      selectedChoiceId: pick.id,
      selectedOrdinal: pick.answerOrdinal,
      isCorrect: false,
      answeredAt: new Date().toISOString()
    };
  };

  const buildAutoPassAnswers = (quizQuestions: SectionQuiz['questions']): QuizTake['answers'] => {
    const correctAnswers = buildCorrectAnswers(quizQuestions);
    const n = correctAnswers.length;
    if (n === 0) {
      return [];
    }
    const minCorrect = Math.min(n, Math.ceil(0.7 * n));
    const targetCorrect = minCorrect + Math.floor(Math.random() * (n - minCorrect + 1));
    const wrongCount = n - targetCorrect;
    const byQuestionId = new Map(quizQuestions.map(question => [question.id, question]));
    const canWrongIndices: number[] = [];
    correctAnswers.forEach((answer, index) => {
      const q = byQuestionId.get(answer.questionId);
      if (q && buildWrongAnswerForQuestion(q)) {
        canWrongIndices.push(index);
      }
    });
    const toFlip = Math.min(wrongCount, canWrongIndices.length);
    const pool = canWrongIndices.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const flipIndices = new Set(pool.slice(0, toFlip));
    return correctAnswers.map((answer, index) => {
      if (!flipIndices.has(index)) {
        return answer;
      }
      const q = byQuestionId.get(answer.questionId);
      if (!q) {
        return answer;
      }
      return buildWrongAnswerForQuestion(q) ?? answer;
    });
  };

  const autoPassQuiz = (): void => {
    onUpdateQuiz(currentQuiz => {
      const sortedQuestions = sortQuestionsForQuiz(currentQuiz.questions);
      const latest = currentQuiz.quizTakes[currentQuiz.quizTakes.length - 1] || null;
      const activeQuestionIds = getAttemptQuestionIds(latest, sortedQuestions);
      const activeQuestionIdSet = new Set(activeQuestionIds);
      const generatedAnswers = buildAutoPassAnswers(
        sortedQuestions.filter(question => activeQuestionIdSet.has(question.id))
      );

      if (
        currentQuiz.quizTakes.length === 0 ||
        currentQuiz.quizTakes[currentQuiz.quizTakes.length - 1].status === 'completed'
      ) {
        return {
          ...currentQuiz,
          quizTakes: [
            ...currentQuiz.quizTakes,
            {
              id: createQuizTakeId(),
              userId: MOCK_CURRENT_USER_ID,
              status: 'started',
              startedAt: new Date().toISOString(),
              currentQuestionIndex: 0,
              answers: generatedAnswers,
              questionIds: sortedQuestions.map(question => question.id),
              attemptType: 'full'
            }
          ]
        };
      }

      const updatedTakes = currentQuiz.quizTakes.slice();
      const latestIndex = updatedTakes.length - 1;
      updatedTakes[latestIndex] = {
        ...updatedTakes[latestIndex],
        status: 'started',
        pausedAt: undefined,
        currentQuestionIndex: 0,
        answers: generatedAnswers,
        questionIds: activeQuestionIds,
        attemptType: updatedTakes[latestIndex].attemptType || 'full'
      };

      return {
        ...currentQuiz,
        quizTakes: updatedTakes
      };
    });
  };

  const goToQuestion = (nextIndex: number): void => {
    updateLatestTake(take => ({
      ...take,
      currentQuestionIndex: Math.min(Math.max(nextIndex, 0), Math.max(questionCount - 1, 0))
    }));
  };

  const selectChoice = (choice: AnswerChoice): void => {
    if (!currentQuestion) {
      return;
    }
    updateLatestTake(take => {
      const existingAnswerIndex = take.answers.findIndex(
        answer => answer.questionId === currentQuestion.id
      );
      const nextAnswer = {
        questionId: currentQuestion.id,
        selectedChoiceId: choice.id,
        selectedOrdinal: choice.answerOrdinal,
        isCorrect: choice.answerTrueFalse,
        answeredAt: new Date().toISOString()
      };
      const updatedAnswers = take.answers.slice();
      if (existingAnswerIndex >= 0) {
        updatedAnswers[existingAnswerIndex] = nextAnswer;
      } else {
        updatedAnswers.push(nextAnswer);
      }
      return {
        ...take,
        answers: updatedAnswers
      };
    });
  };

  const canRetrainNow =
    Boolean(completionSnapshot) &&
    completionSnapshot?.attemptType === 'full' &&
    completionSnapshot.missedQuestionIds.length > 0 &&
    Boolean(latestTake && latestTake.status === 'completed');

  return (
    <div className="mt-3 p-3">
      <div className="flex items-center justify-end gap-2">
        <span className="text-[11px] text-slate-600">
          {questionCount} question(s) | ~{estimatedMinutes} minute(s)
        </span>
      </div>

      {status === 'not_started' && (
        <div className="mt-3 flex min-h-[300px] flex-col items-center justify-center rounded-md bg-white p-4">
          <button
            type="button"
            onClick={startQuiz}
            className="inline-flex min-w-[220px] items-center justify-center gap-2 rounded-md border px-5 py-3 text-base font-bold shadow-sm transition-colors hover:brightness-[0.97]"
            style={{
              backgroundColor: '#7ac943',
              borderColor: '#6ab83a',
              color: '#1f3a5f'
            }}
          >
            <PlayCircle className="h-4 w-4" />
            Start Quiz Now
          </button>
        </div>
      )}

      {status === 'paused' && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-center">
          <p className="text-sm font-medium text-amber-900">Quiz is paused.</p>
          <p className="text-xs text-amber-800 mt-1">
            Answered {answeredCount} of {questionCount} question(s)
          </p>
          <button
            type="button"
            onClick={resumeQuiz}
            className="mt-3 inline-flex items-center gap-2 rounded-md border border-amber-600 bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700"
          >
            <PlayCircle className="h-4 w-4" />
            Resume Quiz
          </button>
        </div>
      )}

      {status === 'started' && currentQuestion && (
        <div className="mt-3 rounded-md bg-white p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-700">
              Question {currentQuestionIndex + 1} of {questionCount}
            </p>
            <p className="text-[11px] text-slate-600">
              Answered {answeredCount}/{questionCount}
            </p>
          </div>

          <p
            className="mt-2 pl-4 font-medium leading-snug text-slate-900"
            style={{ fontSize: '2.1rem' }}
          >
            {currentQuestion.questionText}
          </p>

          <div className="mt-3 space-y-2">
            {currentQuestion.answerChoices.map(choice => {
              const isSelected = selectedAnswer?.selectedChoiceId === choice.id;
              return (
                <button
                  key={choice.id}
                  type="button"
                  onClick={() => selectChoice(choice)}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
                    isSelected
                      ? 'border-emerald-400 bg-emerald-100 text-emerald-900'
                      : 'border-gray-300 bg-white text-slate-800 hover:bg-gray-50'
                  }`}
                >
                  <span className="font-semibold">{choice.answerOrdinal}</span> |{' '}
                  <span>{choice.answerText}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => goToQuestion(currentQuestionIndex - 1)}
              disabled={currentQuestionIndex <= 0}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40"
            >
              Previous Question
            </button>
            <button
              type="button"
              onClick={() => goToQuestion(currentQuestionIndex + 1)}
              disabled={currentQuestionIndex >= questionCount - 1}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40"
            >
              Next Question
            </button>
          </div>
        </div>
      )}

      {status === 'completed' && latestTake && (
        <div className="mt-3 min-h-[300px] rounded-xl border border-slate-200/80 bg-slate-50/80 p-4 md:p-5">
          <div className="flex flex-col gap-4 md:grid md:grid-cols-2 md:gap-4">
            <QuizScoreTile
              tone="success"
              title="Correct"
              percent={positivePercent}
              headline={`${positivePercent}%`}
              topRight={
                positiveDelta !== null ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">
                    {positiveDelta > 0 ? '+' : ''}
                    {positiveDelta}%
                    {positiveDelta > 0 ? (
                      <TrendingUp className="h-3 w-3 shrink-0 opacity-95" aria-hidden />
                    ) : positiveDelta < 0 ? (
                      <TrendingDown className="h-3 w-3 shrink-0 opacity-95" aria-hidden />
                    ) : (
                      <Minus className="h-3 w-3 shrink-0 opacity-95" aria-hidden />
                    )}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                    <Trophy className="h-3 w-3 opacity-90" aria-hidden />
                    Result
                  </span>
                )
              }
              footer={
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 opacity-90" aria-hidden />
                  <span>
                    {completedScore} of {questionCount} correct
                  </span>
                </span>
              }
            />

            <QuizScoreTile
              tone="danger"
              title="Incorrect"
              percent={negativePercent}
              headline={`${negativePercent}%`}
              topRight={
                negativeDelta !== null ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">
                    {negativeDelta > 0 ? '+' : ''}
                    {negativeDelta}%
                    {negativeDelta > 0 ? (
                      <TrendingUp className="h-3 w-3 shrink-0 opacity-95" aria-hidden />
                    ) : negativeDelta < 0 ? (
                      <TrendingDown className="h-3 w-3 shrink-0 opacity-95" aria-hidden />
                    ) : (
                      <Minus className="h-3 w-3 shrink-0 opacity-95" aria-hidden />
                    )}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                    <XCircle className="h-3 w-3 opacity-90" aria-hidden />
                    Missed
                  </span>
                )
              }
              footer={
                <span className="inline-flex items-center gap-1.5">
                  <XCircle className="h-3.5 w-3.5 shrink-0 opacity-90" aria-hidden />
                  <span>{incorrectCount} incorrect</span>
                </span>
              }
            />
          </div>

          <div className="mt-6 border-t border-slate-200/80 pt-4">
            <div className="flex flex-wrap items-center justify-end gap-2">
              {latestTake.attemptType !== 'retrain' && incorrectCount > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    startRetrain(
                      latestTake,
                      activeQuestions
                        .filter(question => {
                          const answer = latestTake.answers.find(
                            candidate => candidate.questionId === question.id
                          );
                          return !answer?.isCorrect;
                        })
                        .map(question => question.id)
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-orange-200/90 bg-orange-100 px-3 py-2 text-xs font-semibold text-orange-900 hover:bg-orange-200/80"
                >
                  <PlayCircle className="h-3.5 w-3.5" />
                  Retrain Missed Questions
                </button>
              ) : null}
              <button
                type="button"
                onClick={startQuiz}
                className="inline-flex items-center gap-1.5 rounded-md border border-sky-200/90 bg-sky-100 px-3 py-2 text-xs font-semibold text-sky-900 hover:bg-sky-200/80"
              >
                <Trophy className="h-3.5 w-3.5" />
                Start New Attempt
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-[11px] text-slate-700">
          <span className="inline-flex items-center gap-1">
            <Timer className="h-3 w-3" />
            <span>Quiz Status: {status}</span>
          </span>
        </p>
        <div className="flex items-center gap-2">
          {isLocalHost ? (
            <>
              <button
                type="button"
                onClick={autoAnswerQuiz}
                className="inline-flex items-center gap-1.5 rounded border border-sky-300 bg-sky-100 px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-200"
              >
                <Shuffle className="h-3.5 w-3.5" />
                Auto Answer
              </button>
              <button
                type="button"
                onClick={autoPassQuiz}
                className="inline-flex items-center gap-1.5 rounded border border-emerald-300 bg-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-200"
              >
                <Trophy className="h-3.5 w-3.5" />
                Auto Pass
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={completeQuiz}
            disabled={!canComplete || submittingCompletion}
            className="rounded border border-emerald-300 bg-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:border-gray-300 disabled:bg-gray-200 disabled:text-gray-500"
          >
            {submittingCompletion ? 'Completing...' : 'Complete Quiz'}
          </button>
        </div>
      </div>

      {completionSnapshot &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/45 p-4"
            role="presentation"
          >
            <style>
              {`@keyframes quiz-confetti-fall {
                0% { transform: translateY(-24px) rotate(0deg); opacity: 1; }
                100% { transform: translateY(320px) rotate(520deg); opacity: 0; }
              }`}
            </style>

            <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-emerald-200 bg-white p-6 shadow-2xl">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-44">
                {confettiPieces.map(piece => (
                  <span
                    key={piece.id}
                    className={`absolute top-0 h-2 w-2 rounded-sm ${piece.backgroundClass}`}
                    style={{
                      left: piece.left,
                      animationName: 'quiz-confetti-fall',
                      animationDuration: piece.duration,
                      animationDelay: piece.delay,
                      animationIterationCount: 'infinite',
                      animationTimingFunction: 'linear'
                    }}
                  />
                ))}
              </div>

              <div className="relative z-10 text-center">
                <div className="mx-auto flex items-center justify-center bg-transparent p-0">
                  <img
                    src="https://res.cloudinary.com/doi8qjcv6/image/upload/v1775673439/customers/mightywell/cm3_nqvdqs.webp"
                    alt="Quiz completed"
                    className="h-auto max-h-40 w-auto border-0 object-contain bg-transparent"
                  />
                </div>
                <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">
                  {completionSnapshot.attemptType === 'retrain'
                    ? 'Retraining Complete'
                    : completionSnapshot.missedQuestionIds.length > 0
                    ? 'Quiz Complete: Retraining Recommended'
                    : 'Congratulations'}
                </h3>
                <p className="mt-2 text-sm text-slate-700">
                  {completionSnapshot.attemptType === 'retrain'
                    ? 'You completed your missed-question retraining attempt.'
                    : completionSnapshot.missedQuestionIds.length > 0
                    ? 'You completed the main quiz. Retrain now to retry only the missed questions.'
                    : 'You completed the quiz.'}
                </p>
                <div className="mt-5">
                  <QuizCompletionScoreGauge
                    score={completionSnapshot.score}
                    total={completionSnapshot.total}
                  />
                </div>
                {completionSnapshot.showCertificatesCta ? (
                  <p className="mt-2 text-sm text-slate-700">
                    Congratulations, you can view all awarded certificates in the Certificates section of your
                    training portal.
                  </p>
                ) : null}
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {canRetrainNow && latestTake ? (
                    <button
                      type="button"
                      onClick={() => startRetrain(latestTake, completionSnapshot.missedQuestionIds)}
                      className="rounded border border-amber-600 bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700"
                    >
                      Retrain Now
                    </button>
                  ) : null}
                  {completionSnapshot.showCertificatesCta ? (
                    <button
                      type="button"
                      onClick={() => {
                        setCompletionSnapshot(null);
                        onNavigateToCertificates?.();
                      }}
                      className="rounded border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                    >
                      View Certificates
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setCompletionSnapshot(null);
                      onCompletionPrimaryAction?.();
                    }}
                    className="rounded border border-teal-600 bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
                  >
                    {onCompletionPrimaryAction
                      ? completionPrimaryActionLabel ?? 'Go to next module'
                      : 'Close'}
                  </button>
             
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

export default QuizPlayer;
