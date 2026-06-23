import React, { useEffect, useMemo, useState } from 'react';

import {
  BookOpenText,
  CircleHelp,
  FileText,
  Link as LinkIcon
} from 'lucide-react';

import BlobService from '../../../../services/blob.service';
import type { ModuleStep, SectionQuiz, TrainingAttachment } from '../trainingTypes';
import { diagnoseH1InlinePdfEligibility, isTrainingDiagnosticsConsoleEnabled, logH1ToConsole } from '../trainingPlayerDiagnostics';
import AudioAttachmentPlayer, { isLikelyAudioFileUrl } from './AudioAttachmentPlayer';
import QuizPlayer from './QuizPlayer';

/** Resolves Azure blob URLs to time-limited SAS URLs so iframes can load PDFs (same pattern as audio). */
const InlinePdfFrame: React.FC<{ attachment: TrainingAttachment }> = ({ attachment }) => {
  const rawUrl = attachment.url?.trim() ?? '';
  const [resolvedSrc, setResolvedSrc] = useState(rawUrl);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    if (!rawUrl) {
      setResolvedSrc('');
      setResolving(false);
      return;
    }
    if (!BlobService.isBlobUrl(rawUrl)) {
      setResolvedSrc(rawUrl);
      setResolving(false);
      return;
    }
    let cancelled = false;
    setResolving(true);
    BlobService.getAuthenticatedUrl(rawUrl)
      .then(u => {
        if (!cancelled) {
          setResolvedSrc(u);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedSrc(rawUrl);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setResolving(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rawUrl]);

  if (!rawUrl) {
    return <p className="text-sm text-amber-800">No PDF URL for this attachment.</p>;
  }

  if (resolving) {
    return (
      <div className="flex h-[min(400px,50vh)] min-h-[200px] items-center justify-center rounded border border-indigo-200 bg-white text-sm text-slate-600">
        Preparing PDF…
      </div>
    );
  }

  return (
    <>
      <div className="rounded border border-indigo-200 bg-white overflow-hidden">
        <iframe
          src={resolvedSrc}
          title={attachment.title || 'Inline PDF Attachment'}
          className="w-full h-[560px]"
        />
      </div>
      <a
        href={resolvedSrc}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1 rounded border border-indigo-300 bg-white px-2.5 py-1 text-xs text-indigo-900 hover:bg-indigo-100"
      >
        <LinkIcon className="h-3.5 w-3.5" />
        <span>Open in new tab</span>
      </a>
    </>
  );
};

type Props = {
  packageTitle: string;
  moduleTitle: string;
  /** 1-based index of this module in the selected package (assignment order). */
  moduleOrdinalInPackage?: number;
  modulePurpose: string;
  step: ModuleStep | null;
  stepNumberInModule: number;
  totalStepsInModule: number;
  onUpdateStepQuiz: (updater: (quiz: SectionQuiz) => SectionQuiz) => void;
  showEmbeddedQuiz?: boolean;
  headerActions?: React.ReactNode;
  /** Notifies when an inline audio attachment begins playback (e.g. to sync Columbus animation). */
  onAudioPlayStart?: () => void;
  /** Notifies when inline audio stops (pause or natural end). */
  onAudioPlayPause?: () => void;
};

const TrainingStepViewport: React.FC<Props> = ({
  modulePurpose,
  moduleTitle,
  moduleOrdinalInPackage,
  step,
  stepNumberInModule,
  totalStepsInModule,
  onUpdateStepQuiz,
  showEmbeddedQuiz = true,
  headerActions,
  onAudioPlayStart,
  onAudioPlayPause
}) => {
  const moduleHeadingText = useMemo(() => {
    const title = moduleTitle.trim();
    if (!title || /^no module selected$/i.test(title)) {
      return '';
    }
    if (typeof moduleOrdinalInPackage === 'number' && moduleOrdinalInPackage > 0) {
      return `Module ${moduleOrdinalInPackage} - ${title}`;
    }
    return title;
  }, [moduleTitle, moduleOrdinalInPackage]);

  const quizSectionChipText = (quizTitle: string): string => {
    const sectionMatch = quizTitle.match(/Section\s+\d+\s+Quiz/i);

    if (sectionMatch) {
      return sectionMatch[0];
    }

    return 'Section Quiz';
  };

  const isInlinePdfAttachment = (attachment: ModuleStep['attachments'][number]): boolean =>
    attachment.attachmentType === 'pdf' && Boolean(attachment.renderInline) && Boolean(attachment.url?.trim());

  const isAudioAttachment = (attachment: ModuleStep['attachments'][number]): boolean => {
    if (!attachment.url?.trim()) {
      return false;
    }
    if (attachment.attachmentType === 'audio') {
      return true;
    }
    if (attachment.attachmentType === 'link') {
      return isLikelyAudioFileUrl(attachment.url);
    }
    return false;
  };

  const stepAttachments = step?.attachments ?? [];

  const inlinePdfAttachments = stepAttachments.filter(isInlinePdfAttachment);
  const audioAttachments = stepAttachments.filter(isAudioAttachment);
  const linkOnlyAttachments = stepAttachments.filter(
    attachment => !isInlinePdfAttachment(attachment) && !isAudioAttachment(attachment)
  );

  const attachmentProbe = useMemo(
    () =>
      step
        ? JSON.stringify(
            (step.attachments ?? []).map(a => ({
              id: a.id,
              t: a.attachmentType,
              r: a.renderInline,
              u: (a.url ?? '').trim().length
            }))
          )
        : '',
    [step]
  );

  useEffect(() => {
    if (!step || !isTrainingDiagnosticsConsoleEnabled()) {
      return;
    }
    const h1 = diagnoseH1InlinePdfEligibility(step);
    logH1ToConsole(h1, `step ${step.id}`);
    // Only when step id or attachment snapshot changes — not when parent passes a new `step` object reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id, attachmentProbe]);

  if (!step) {
    return (
      <div className="rounded-lg border border-sky-200 bg-gradient-to-b from-sky-50 to-white p-4 h-full min-h-[320px] flex flex-col overflow-y-auto">
        {moduleHeadingText ? (
          <p className="mb-2 shrink-0 text-center text-sm font-semibold text-slate-400">{moduleHeadingText}</p>
        ) : null}
        {headerActions ? (
          <div className="mb-3 flex shrink-0 justify-end">{headerActions}</div>
        ) : null}
        <div className="rounded-md border border-indigo-200 bg-indigo-50 p-4 flex-1 min-h-[220px] flex flex-col">
          <h3 className="text-sm font-semibold text-indigo-900 uppercase tracking-wide mb-2">
            <span className="inline-flex items-center gap-1.5">
              <BookOpenText className="h-3.5 w-3.5 text-indigo-800" />
              <span>Module Purpose</span>
            </span>
          </h3>
          <div className="flex-1 min-h-0 overflow-y-auto pr-1">
            {modulePurpose ? (
              <p className="text-xl leading-9 text-slate-800 whitespace-pre-wrap">{modulePurpose}</p>
            ) : (
              <p className="text-xl leading-9 text-slate-500">No module purpose has been provided yet.</p>
            )}
          </div>
        </div>

        <p className="mt-3 text-xs text-slate-500">
          Select a step in the table of contents to start the walkthrough.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full min-h-[420px] lg:min-h-0 flex flex-col overflow-y-auto bg-transparent p-4">
      {moduleHeadingText ? (
        <p className="mb-2 shrink-0 text-center text-sm font-semibold text-slate-400">{moduleHeadingText}</p>
      ) : null}
      <div className="mb-3 flex shrink-0 items-start justify-between gap-3 bg-transparent">
        <div className="min-w-0 flex-1 p-0">
          <p className="text-sm font-medium text-slate-600">
            {step.subtitle || 'Module Step'}
          </p>
          <h3 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">{step.title}</h3>
          <p className="text-xs text-slate-500 mt-1">
            {Math.max(stepNumberInModule, 1)} of {Math.max(totalStepsInModule, 1)}
          </p>
        </div>
        {headerActions ? <div className="shrink-0 pt-0.5">{headerActions}</div> : null}
      </div>

      {audioAttachments.length > 0 ? (
        <div className="mb-3 shrink-0 space-y-3">
          {audioAttachments.map(attachment => (
            <AudioAttachmentPlayer
              key={`audio-${attachment.id}`}
              attachment={attachment}
              onPlayStart={onAudioPlayStart}
              onPlayPause={onAudioPlayPause}
            />
          ))}
        </div>
      ) : null}

      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 mb-3 flex shrink-0 flex-col min-h-0 max-h-[min(55vh,520px)] sm:max-h-[min(60vh,560px)]">
        <h4 className="text-sm font-semibold text-blue-900 uppercase tracking-wide mb-2 shrink-0">
          <span className="inline-flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 text-blue-800" />
            <span>Overview</span>
          </span>
        </h4>
        <div className="min-h-[120px] flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1 text-xl leading-9 text-slate-800">
          {step.copy ? (
            <p className="whitespace-pre-wrap">{step.copy}</p>
          ) : (
            <p className="text-slate-500">No copy for this step yet.</p>
          )}
        </div>
      </div>

      {inlinePdfAttachments.map(attachment => (
        <div
          key={`inline-${attachment.id}`}
          className="rounded-md border border-indigo-200 bg-indigo-50 p-3 mb-3 shrink-0"
        >
          <h4 className="text-xs font-semibold text-indigo-900 uppercase tracking-wide mb-2">
            <span className="inline-flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-indigo-800" />
              <span>{attachment.title || 'Inline PDF'}</span>
            </span>
          </h4>
          <InlinePdfFrame attachment={attachment} />
        </div>
      ))}

      {linkOnlyAttachments.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 mb-3 shrink-0">
          <h4 className="text-xs font-semibold text-amber-900 uppercase tracking-wide mb-2">
            <span className="inline-flex items-center gap-1.5">
              <LinkIcon className="h-3.5 w-3.5 text-amber-800" />
              <span>Attachments</span>
            </span>
          </h4>
          <div className="flex flex-wrap gap-2">
            {linkOnlyAttachments.map(attachment => {
              const href = attachment.url?.trim();
              const isPdfLike =
                attachment.attachmentType === 'pdf' ||
                /\.pdf(\?|#|$)/i.test(attachment.url || '');
              const label = attachment.title || (isPdfLike ? 'PDF' : 'Link');
              const chipClass =
                'inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-2.5 py-1 text-xs text-amber-900';
              if (!href) {
                return (
                  <span
                    key={attachment.id}
                    className={`${chipClass} cursor-not-allowed opacity-60`}
                    title="Attachment has no URL yet"
                  >
                    {isPdfLike ? (
                      <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    ) : (
                      <LinkIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    )}
                    <span>{label} (no URL)</span>
                  </span>
                );
              }
              return (
                <a
                  key={attachment.id}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${chipClass} hover:bg-amber-100`}
                >
                  {isPdfLike ? (
                    <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  ) : (
                    <LinkIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  )}
                  <span>{label}</span>
                </a>
              );
            })}
          </div>
        </div>
      )}

      {showEmbeddedQuiz && step.sectionQuiz && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 shrink-0">
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-white px-2.5 py-1">
            <CircleHelp className="h-3.5 w-3.5 text-emerald-800" />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-900">
              {quizSectionChipText(step.sectionQuiz.title)}
            </span>
          </div>
          <p className="text-xs text-slate-600 mt-1">
            {step.sectionQuiz.questions.length} question(s) | ~
            {Math.max(1, Number(step.sectionQuiz.estimatedDurationMinutes) || 1)} minute(s)
          </p>
          <QuizPlayer quiz={step.sectionQuiz} onUpdateQuiz={onUpdateStepQuiz} />
        </div>
      )}
    </div>
  );
};

export default TrainingStepViewport;
