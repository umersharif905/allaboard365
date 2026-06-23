import React, { useRef, useState } from 'react';
import {
  Brain,
  Braces,
  CheckCircle,
  CheckSquare,
  FileText,
  Headphones,
  KeyRound,
  Link,
  List,
  ListOrdered,
  MessageSquare,
  PenTool,
  Trash2,
  Type,
  Upload,
  Video
} from 'lucide-react';

import { apiService } from '../../../services/api.service';
import AudioAttachmentPlayer, { isLikelyAudioFileUrl } from './player/AudioAttachmentPlayer';
import { createTrainingId } from './trainingMockData';
import type {
  AnswerChoice,
  ModuleStep,
  SectionQuiz,
  TrainingAttachmentType,
  TrainingModule,
  TrainingQuestion
} from './trainingTypes';

type TrainingUploadResponse = {
  success?: boolean;
  data?: { url?: string }[];
  url?: string;
};

function attachmentAcceptString(attachmentType: TrainingAttachmentType): string {
  switch (attachmentType) {
    case 'pdf':
      return '.pdf,application/pdf';
    case 'video':
      return 'video/*';
    case 'audio':
      return 'audio/*';
    case 'link':
    default:
      return '*/*';
  }
}

/** Align stored attachmentType with uploaded file so the training player maps media correctly. */
function inferAttachmentTypeFromFile(file: File): TrainingAttachmentType | null {
  const mime = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  if (mime.startsWith('audio/')) {
    return 'audio';
  }
  if (mime.startsWith('video/')) {
    return 'video';
  }
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    return 'pdf';
  }
  if (/\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(name)) {
    return 'audio';
  }
  if (/\.(mp4|webm|mov|m4v|mkv)$/i.test(name)) {
    return 'video';
  }
  return null;
}

function displayNameForAttachment(title: string, url: string): string {
  const trimmed = title?.trim();
  if (trimmed) {
    return trimmed;
  }
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).pop();
    if (segment) {
      return decodeURIComponent(segment);
    }
  } catch {
    // ignore
  }
  return url.length > 56 ? `${url.slice(0, 54)}…` : url;
}

function shouldShowAudioPreview(attachment: {
  attachmentType: TrainingAttachmentType;
  url: string;
}): boolean {
  const hasUrl = Boolean(attachment.url?.trim());
  if (!hasUrl) {
    return false;
  }
  if (attachment.attachmentType === 'audio') {
    return true;
  }
  if (attachment.attachmentType === 'link') {
    return isLikelyAudioFileUrl(attachment.url);
  }
  return false;
}

function AttachmentTypeIcon({
  attachmentType
}: {
  attachmentType: TrainingAttachmentType;
}): React.ReactElement {
  const className = 'h-5 w-5 shrink-0 text-emerald-700';
  switch (attachmentType) {
    case 'audio':
      return <Headphones className={className} aria-hidden />;
    case 'video':
      return <Video className={className} aria-hidden />;
    case 'pdf':
      return <FileText className={className} aria-hidden />;
    case 'link':
    default:
      return <Link className={className} aria-hidden />;
  }
}

function TrainingAttachmentUrlSlot({
  tone,
  attachment,
  uploading,
  showUrlField,
  onToggleShowUrlField,
  onBeginUpload,
  onUrlChange,
  emptyStateLayout = 'urlAndUpload',
  showUploadButton = true,
  showReplaceUploadButton = true
}: {
  tone: 'gray' | 'amber';
  attachment: {
    id: string;
    title: string;
    url: string;
    attachmentType: TrainingAttachmentType;
  };
  uploading: boolean;
  showUrlField: boolean;
  onToggleShowUrlField: () => void;
  onBeginUpload: () => void;
  onUrlChange: (value: string) => void;
  emptyStateLayout?: 'urlAndUpload' | 'uploadOnly';
  showUploadButton?: boolean;
  showReplaceUploadButton?: boolean;
}): React.ReactElement {
  const hasUrl = Boolean(attachment.url?.trim());
  const inputBorder =
    tone === 'gray'
      ? 'border-gray-300 focus:ring-oe-primary'
      : 'border-amber-200 focus:ring-oe-primary';
  const btnOutline =
    tone === 'gray'
      ? 'border-gray-300 text-gray-700 hover:bg-gray-50'
      : 'border-amber-300 text-amber-900 hover:bg-amber-100';

  if (!hasUrl) {
    if (emptyStateLayout === 'uploadOnly' && showUploadButton) {
      return (
        <div className="flex items-stretch">
          <button
            type="button"
            onClick={onBeginUpload}
            disabled={uploading}
            title="Upload audio to Azure training storage"
            className={`inline-flex flex-1 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm disabled:opacity-50 ${btnOutline}`}
          >
            {uploading ? (
              <span
                className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                aria-hidden
              />
            ) : (
              <Upload className="h-4 w-4 shrink-0" aria-hidden />
            )}
            <span>{uploading ? 'Uploading…' : 'Upload audio file'}</span>
          </button>
        </div>
      );
    }

    return (
      <div className="flex gap-2 items-stretch">
        <input
          value={attachment.url}
          onChange={event => onUrlChange(event.target.value)}
          placeholder="https://... or upload"
          className={`flex-1 min-w-0 rounded-md border px-3 py-2 text-sm ${inputBorder}`}
        />
        {showUploadButton ? (
          <button
            type="button"
            onClick={onBeginUpload}
            disabled={uploading}
            title="Upload file to Azure training storage"
            className={`shrink-0 inline-flex items-center justify-center rounded-md border px-2 py-2 text-xs disabled:opacity-50 ${btnOutline}`}
          >
            {uploading ? (
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
            ) : (
              <Upload className="h-4 w-4" aria-hidden />
            )}
            <span className="sr-only">Upload file</span>
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        className="flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2"
        role="status"
      >
        <AttachmentTypeIcon attachmentType={attachment.attachmentType} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
            Attached
          </p>
          <p className="text-sm font-medium text-emerald-950 truncate">
            {displayNameForAttachment(attachment.title, attachment.url)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showReplaceUploadButton ? (
            <button
              type="button"
              onClick={onBeginUpload}
              disabled={uploading}
              title="Replace file"
              className={`rounded-md border px-2 py-1.5 text-xs disabled:opacity-50 ${btnOutline}`}
            >
              {uploading ? 'Uploading…' : 'Replace'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onToggleShowUrlField}
            className="rounded-md border border-emerald-300 bg-white px-2 py-1.5 text-xs text-emerald-900 hover:bg-emerald-100"
          >
            {showUrlField ? 'Hide URL' : 'Edit URL'}
          </button>
        </div>
      </div>
      {showUrlField && (
        <input
          value={attachment.url}
          onChange={event => onUrlChange(event.target.value)}
          placeholder="https://..."
          className={`w-full rounded-md border px-3 py-2 text-sm ${inputBorder}`}
        />
      )}
      {uploading && (
        <p className="text-[11px] text-emerald-800">Uploading attachment...</p>
      )}
    </div>
  );
}

type Props = {
  module: TrainingModule | null;
  onChangeModule: (updater: (module: TrainingModule) => TrainingModule) => void;
  /** Scrolls to the page-level raw JSON editor (tenant training admin). */
  onOpenRawJsonEditor?: () => void;
};

const ModuleEditorPanel: React.FC<Props> = ({ module, onChangeModule, onOpenRawJsonEditor }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingUploadRef = useRef<
    | { target: 'module'; attachmentId: string }
    | { target: 'step'; stepId: string; attachmentId: string }
    | null
  >(null);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [attachmentUrlFieldVisible, setAttachmentUrlFieldVisible] = useState<
    Record<string, boolean>
  >({});

  const sortQuestionsByNumber = (questions: TrainingQuestion[]): TrainingQuestion[] => {
    return [...questions].sort((a, b) => {
      if (a.questionNumber === b.questionNumber) {
        return a.id.localeCompare(b.id);
      }
      return a.questionNumber - b.questionNumber;
    });
  };

  if (!module) {
    return (
      <section className="xl:col-span-9 bg-white rounded-lg border border-gray-200 p-4">
        {onOpenRawJsonEditor ? (
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              onClick={onOpenRawJsonEditor}
              className="inline-flex items-center gap-1.5 rounded border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"
            >
              <Braces className="h-3.5 w-3.5" aria-hidden />
              Raw JSON
            </button>
          </div>
        ) : null}
        <div className="rounded-md border border-dashed border-gray-300 p-6 text-center text-gray-500">
          Choose a module from the library to edit, or create a new module.
        </div>
      </section>
    );
  }

  const updateStep = (
    stepId: string,
    updater: (step: ModuleStep) => ModuleStep
  ): void => {
    onChangeModule(currentModule => ({
      ...currentModule,
      moduleSteps: currentModule.moduleSteps.map(step =>
        step.id === stepId ? updater(step) : step
      )
    }));
  };

  const updateQuizQuestion = (
    stepId: string,
    questionId: string,
    updater: (question: TrainingQuestion) => TrainingQuestion
  ): void => {
    updateStep(stepId, step => {
      if (!step.sectionQuiz) {
        return step;
      }
      return {
        ...step,
        sectionQuiz: {
          ...step.sectionQuiz,
          questions: sortQuestionsByNumber(
            step.sectionQuiz.questions.map(question =>
              question.id === questionId ? updater(question) : question
            )
          )
        }
      };
    });
  };

  const updateAnswerChoice = (
    stepId: string,
    questionId: string,
    choiceId: string,
    updater: (choice: AnswerChoice) => AnswerChoice
  ): void => {
    updateQuizQuestion(stepId, questionId, question => ({
      ...question,
      answerChoices: question.answerChoices.map(choice =>
        choice.id === choiceId ? updater(choice) : choice
      )
    }));
  };

  const beginAttachmentUpload = (
    attachmentType: TrainingAttachmentType,
    ctx:
      | { target: 'module'; attachmentId: string }
      | { target: 'step'; stepId: string; attachmentId: string }
  ): void => {
    pendingUploadRef.current = ctx;
    const input = fileInputRef.current;
    if (input) {
      input.accept = attachmentAcceptString(attachmentType);
      input.value = '';
      input.click();
    }
  };

  const handleAttachmentFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ): Promise<void> => {
    const file = event.target.files?.[0];
    const pending = pendingUploadRef.current;
    event.target.value = '';
    pendingUploadRef.current = null;
    if (!file || !pending) {
      return;
    }

    const uploadKey =
      pending.target === 'module'
        ? `module-${pending.attachmentId}`
        : `step-${pending.stepId}-${pending.attachmentId}`;
    setUploadingKey(uploadKey);

    try {
      const formDataUpload = new FormData();
      formDataUpload.append('files', file);
      formDataUpload.append('uploadType', 'training');
      const res = await apiService.post<TrainingUploadResponse>('/api/uploads', formDataUpload, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      const url = res?.data?.[0]?.url ?? res?.url;
      if (!url) {
        console.error('Training attachment upload: no URL in response', res);
        return;
      }

      const inferredType = inferAttachmentTypeFromFile(file);

      if (pending.target === 'module') {
        onChangeModule(currentModule => ({
          ...currentModule,
          attachments: currentModule.attachments.map(att =>
            att.id === pending.attachmentId
              ? {
                  ...att,
                  url,
                  title: att.title?.trim() ? att.title : file.name,
                  ...(inferredType ? { attachmentType: inferredType } : {})
                }
              : att
          )
        }));
      } else {
        updateStep(pending.stepId, currentStep => ({
          ...currentStep,
          attachments: currentStep.attachments.map(att =>
            att.id === pending.attachmentId
              ? {
                  ...att,
                  url,
                  title: att.title?.trim() ? att.title : file.name,
                  ...(inferredType ? { attachmentType: inferredType } : {})
                }
              : att
          )
        }));
      }
    } catch (err) {
      console.error('Training attachment upload failed:', err);
      alert('Upload failed. Please check file type and size (max 10MB).');
    } finally {
      setUploadingKey(null);
    }
  };

  return (
    <section className="xl:col-span-9 bg-white rounded-lg border border-gray-200 p-4">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleAttachmentFileChange}
      />

      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Module Editor</h2>
            {onOpenRawJsonEditor ? (
              <button
                type="button"
                onClick={onOpenRawJsonEditor}
                className="inline-flex items-center gap-1.5 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-semibold text-gray-800 hover:bg-gray-50"
                title="Open raw JSON editor at the bottom of this page"
              >
                <Braces className="h-3.5 w-3.5" aria-hidden />
                Raw JSON
              </button>
            ) : null}
          </div>
          <p className="text-xs text-gray-600 mt-1">
            Edit library module structure. Changes apply to every package that includes this module.
          </p>
        </div>
        <div
          className="shrink-0 text-right font-mono text-3xl font-semibold leading-none text-gray-300/80 sm:text-4xl sm:pt-0.5"
          title="Module id"
          aria-label={`Module id ${module.id}`}
        >
          {module.id}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Module Title</label>
          <input
            value={module.title}
            onChange={event =>
              onChangeModule(currentModule => ({ ...currentModule, title: event.target.value }))
            }
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex items-end">
          <label className="inline-flex items-center gap-2 text-sm text-gray-800">
            <input
              type="checkbox"
              checked={module.defaultRequired}
              onChange={() =>
                onChangeModule(currentModule => ({
                  ...currentModule,
                  defaultRequired: !currentModule.defaultRequired
                }))
              }
              className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
            />
            Default required when added to a package
          </label>
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Module Purpose</label>
          <textarea
            value={module.modulePurpose}
            onChange={event =>
              onChangeModule(currentModule => ({
                ...currentModule,
                modulePurpose: event.target.value
              }))
            }
            rows={2}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div className="rounded-md border border-gray-200 p-3 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
            Module Attachments
          </h3>
          <button
            type="button"
            onClick={() =>
              onChangeModule(currentModule => ({
                ...currentModule,
                attachments: [
                  ...currentModule.attachments,
                  {
                    id: createTrainingId('att'),
                    title: 'New Attachment',
                    url: '',
                    attachmentType: 'link',
                    renderInline: false
                  }
                ]
              }))
            }
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            + Add Attachment
          </button>
        </div>
        <div className="space-y-2">
          {module.attachments.map(attachment => (
            <div key={attachment.id} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-start">
              <input
                value={attachment.title}
                onChange={event =>
                  onChangeModule(currentModule => ({
                    ...currentModule,
                    attachments: currentModule.attachments.map(existingAttachment =>
                      existingAttachment.id === attachment.id
                        ? { ...existingAttachment, title: event.target.value }
                        : existingAttachment
                    )
                  }))
                }
                placeholder="Attachment title"
                className="md:col-span-3 rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
              <div className="md:col-span-6">
                <TrainingAttachmentUrlSlot
                  tone="gray"
                  attachment={attachment}
                  uploading={uploadingKey === `module-${attachment.id}`}
                  showUrlField={Boolean(attachmentUrlFieldVisible[`module-${attachment.id}`])}
                  onToggleShowUrlField={() =>
                    setAttachmentUrlFieldVisible(previous => ({
                      ...previous,
                      [`module-${attachment.id}`]: !previous[`module-${attachment.id}`]
                    }))
                  }
                  onBeginUpload={() =>
                    beginAttachmentUpload(attachment.attachmentType, {
                      target: 'module',
                      attachmentId: attachment.id
                    })
                  }
                  onUrlChange={value =>
                    onChangeModule(currentModule => ({
                      ...currentModule,
                      attachments: currentModule.attachments.map(existingAttachment =>
                        existingAttachment.id === attachment.id
                          ? { ...existingAttachment, url: value }
                          : existingAttachment
                      )
                    }))
                  }
                />
              </div>
              <select
                value={attachment.attachmentType}
                onChange={event =>
                  onChangeModule(currentModule => ({
                    ...currentModule,
                    attachments: currentModule.attachments.map(existingAttachment =>
                      existingAttachment.id === attachment.id
                        ? {
                            ...existingAttachment,
                            attachmentType: event.target.value as TrainingAttachmentType
                          }
                        : existingAttachment
                    )
                  }))
                }
                className="md:col-span-2 rounded-md border border-gray-300 px-2 py-2 text-sm"
              >
                <option value="link">Link</option>
                <option value="pdf">PDF</option>
                <option value="video">Video</option>
                <option value="audio">Audio</option>
              </select>
              <button
                type="button"
                onClick={() =>
                  onChangeModule(currentModule => ({
                    ...currentModule,
                    attachments: currentModule.attachments.filter(
                      existingAttachment => existingAttachment.id !== attachment.id
                    )
                  }))
                }
                className="md:col-span-1 rounded border border-red-200 px-2 py-2 text-xs text-red-700 hover:bg-red-50"
              >
                Delete
              </button>
              {shouldShowAudioPreview(attachment) && (
                <div className="md:col-span-12">
                  <AudioAttachmentPlayer attachment={attachment} />
                </div>
              )}
            </div>
          ))}
          {module.attachments.length === 0 && (
            <p className="text-xs text-gray-500">No module attachments yet.</p>
          )}
        </div>
      </div>

      <div className="rounded-md border border-gray-200 p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
            Steps, Copy Sections, and Quizzes
          </h3>
          <button
            type="button"
            onClick={() =>
              onChangeModule(currentModule => ({
                ...currentModule,
                moduleSteps: [
                  ...currentModule.moduleSteps,
                  {
                    id: createTrainingId('step'),
                    title: 'New Step',
                    subtitle: '',
                    copy: '',
                    attachments: []
                  }
                ]
              }))
            }
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            + Add Step
          </button>
        </div>

        <div className="space-y-3">
          {module.moduleSteps.map((step, stepIndex) => {
            const stepOrdinal = stepIndex + 1;
            return (
            <div key={step.id} className="rounded-lg border border-slate-300 bg-slate-50 p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <p
                  className="font-mono text-2xl font-semibold leading-none text-slate-300/90 sm:text-3xl"
                  title={`Step ${stepOrdinal}`}
                >
                  Step {stepOrdinal}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    onChangeModule(currentModule => ({
                      ...currentModule,
                      moduleSteps: currentModule.moduleSteps.filter(
                        currentStep => currentStep.id !== step.id
                      )
                    }))
                  }
                  className="shrink-0 rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                >
                  Remove
                </button>
              </div>

              <div className="mb-2">
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  <span className="inline-flex items-center gap-1.5">
                    <PenTool className="h-3.5 w-3.5 text-slate-700" />
                    <span>Title</span>
                  </span>
                </label>
                <input
                  value={step.title}
                  onChange={event =>
                    updateStep(step.id, currentStep => ({
                      ...currentStep,
                      title: event.target.value
                    }))
                  }
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />

                <label className="mb-1 mt-2 block text-xs font-semibold text-slate-700">
                  <span className="inline-flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 text-slate-700" />
                    <span>Subtitle</span>
                  </span>
                </label>
                <input
                  value={step.subtitle}
                  onChange={event =>
                    updateStep(step.id, currentStep => ({
                      ...currentStep,
                      subtitle: event.target.value
                    }))
                  }
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="Example: Review Overview"
                />
              </div>

              <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 p-3">
                <label className="block text-xs font-semibold text-blue-900 uppercase tracking-wide mb-1">
                  <span className="inline-flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 text-blue-800" />
                    <span>Copy</span>
                  </span>
                </label>
                <textarea
                  value={step.copy}
                  onChange={event =>
                    updateStep(step.id, currentStep => ({
                      ...currentStep,
                      copy: event.target.value
                    }))
                  }
                  rows={5}
                  className="w-full rounded-md border border-blue-200 bg-white px-3 py-2 text-sm"
                  placeholder="Training copy for this step..."
                />
              </div>

              <div className="mb-3 rounded-lg border border-amber-200/90 bg-amber-50/80 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3 mb-4">
                  <p className="text-sm font-semibold text-amber-950 tracking-tight">
                    <span className="inline-flex items-center gap-2">
                      <Link className="h-4 w-4 text-amber-700 shrink-0" aria-hidden />
                      <span>Attachments</span>
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      updateStep(step.id, currentStep => ({
                        ...currentStep,
                        attachments: [
                          ...currentStep.attachments,
                          {
                            id: createTrainingId('att'),
                            title: 'Step Attachment',
                            url: '',
                            attachmentType: 'link',
                            renderInline: false
                          }
                        ]
                      }))
                    }
                    className="inline-flex items-center justify-center rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 shadow-sm hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-200 shrink-0"
                  >
                    + Add attachment
                  </button>
                </div>
                <div className="space-y-4">
                  {step.attachments.map(attachment => {
                    const stepAttKey = `step-${step.id}-${attachment.id}`;
                    const isLink = attachment.attachmentType === 'link';
                    const isAudio = attachment.attachmentType === 'audio';
                    const isPdfOrVideo =
                      attachment.attachmentType === 'pdf' ||
                      attachment.attachmentType === 'video';

                    const typeSelectId = `step-att-type-${step.id}-${attachment.id}`;

                    return (
                      <div
                        key={attachment.id}
                        className="rounded-lg border border-slate-200 bg-white shadow-sm"
                      >
                        <div className="p-4 sm:p-5 space-y-5">
                          <div>
                            <label
                              className="block text-sm font-medium text-slate-800 mb-1.5"
                              htmlFor={`step-att-title-${step.id}-${attachment.id}`}
                            >
                              <span className="inline-flex items-center gap-2">
                                <Type className="h-4 w-4 text-amber-600 shrink-0" aria-hidden />
                                Attachment title
                              </span>
                            </label>
                            <input
                              id={`step-att-title-${step.id}-${attachment.id}`}
                              value={attachment.title}
                              onChange={event =>
                                updateStep(step.id, currentStep => ({
                                  ...currentStep,
                                  attachments: currentStep.attachments.map(existingAttachment =>
                                    existingAttachment.id === attachment.id
                                      ? { ...existingAttachment, title: event.target.value }
                                      : existingAttachment
                                  )
                                }))
                              }
                              placeholder="e.g. Overview voiceover"
                              className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
                            />
                          </div>

                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                            <label
                              className="text-sm font-medium text-slate-800 sm:w-40 sm:shrink-0"
                              htmlFor={typeSelectId}
                            >
                              Attachment type
                            </label>
                            <select
                              id={typeSelectId}
                              value={attachment.attachmentType}
                              onChange={event =>
                                updateStep(step.id, currentStep => ({
                                  ...currentStep,
                                  attachments: currentStep.attachments.map(existingAttachment =>
                                    existingAttachment.id === attachment.id
                                      ? {
                                          ...existingAttachment,
                                          attachmentType: event.target.value as TrainingAttachmentType
                                        }
                                      : existingAttachment
                                  )
                                }))
                              }
                              className="w-full min-w-0 sm:flex-1 sm:max-w-md rounded-md border border-slate-300 px-3 py-2.5 text-sm text-slate-900 bg-white focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
                            >
                              <option value="link">Link</option>
                              <option value="pdf">PDF</option>
                              <option value="video">Video</option>
                              <option value="audio">Audio</option>
                            </select>
                          </div>

                          <div className="border-t border-slate-200 pt-5 space-y-4">
                            {(isLink || isPdfOrVideo) && (
                              <div className="space-y-1.5">
                                <label className="block text-sm font-medium text-slate-800">
                                  <span className="inline-flex items-center gap-2">
                                    <Link className="h-4 w-4 text-amber-600 shrink-0" aria-hidden />
                                    {isLink ? 'Attachment URL' : 'Linked file'}
                                  </span>
                                </label>
                                <TrainingAttachmentUrlSlot
                                  tone="amber"
                                  attachment={attachment}
                                  uploading={uploadingKey === stepAttKey}
                                  showUrlField={Boolean(attachmentUrlFieldVisible[stepAttKey])}
                                  showUploadButton
                                  showReplaceUploadButton
                                  onToggleShowUrlField={() =>
                                    setAttachmentUrlFieldVisible(previous => ({
                                      ...previous,
                                      [stepAttKey]: !previous[stepAttKey]
                                    }))
                                  }
                                  onBeginUpload={() =>
                                    beginAttachmentUpload(attachment.attachmentType, {
                                      target: 'step',
                                      stepId: step.id,
                                      attachmentId: attachment.id
                                    })
                                  }
                                  onUrlChange={value =>
                                    updateStep(step.id, currentStep => ({
                                      ...currentStep,
                                      attachments: currentStep.attachments.map(existingAttachment =>
                                        existingAttachment.id === attachment.id
                                          ? { ...existingAttachment, url: value }
                                          : existingAttachment
                                      )
                                    }))
                                  }
                                />
                              </div>
                            )}

                            {isAudio && (
                              <div className="space-y-1.5">
                                <label className="block text-sm font-medium text-slate-800">
                                  Audio file
                                </label>
                                <TrainingAttachmentUrlSlot
                                  tone="amber"
                                  attachment={attachment}
                                  uploading={uploadingKey === stepAttKey}
                                  showUrlField={Boolean(attachmentUrlFieldVisible[stepAttKey])}
                                  emptyStateLayout="uploadOnly"
                                  showUploadButton
                                  showReplaceUploadButton
                                  onToggleShowUrlField={() =>
                                    setAttachmentUrlFieldVisible(previous => ({
                                      ...previous,
                                      [stepAttKey]: !previous[stepAttKey]
                                    }))
                                  }
                                  onBeginUpload={() =>
                                    beginAttachmentUpload(attachment.attachmentType, {
                                      target: 'step',
                                      stepId: step.id,
                                      attachmentId: attachment.id
                                    })
                                  }
                                  onUrlChange={value =>
                                    updateStep(step.id, currentStep => ({
                                      ...currentStep,
                                      attachments: currentStep.attachments.map(existingAttachment =>
                                        existingAttachment.id === attachment.id
                                          ? { ...existingAttachment, url: value }
                                          : existingAttachment
                                      )
                                    }))
                                  }
                                />
                              </div>
                            )}

                          </div>

                          {shouldShowAudioPreview(attachment) && (
                            <div className="rounded-md border border-violet-100 bg-violet-50/30 p-2">
                              <AudioAttachmentPlayer attachment={attachment} />
                            </div>
                          )}

                          {attachment.attachmentType === 'pdf' && (
                            <div className="rounded-md border border-slate-200 bg-slate-50/80 px-3 py-2.5">
                              <label className="inline-flex items-center gap-2.5 text-sm text-slate-800 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={Boolean(attachment.renderInline)}
                                  onChange={event =>
                                    updateStep(step.id, currentStep => ({
                                      ...currentStep,
                                      attachments: currentStep.attachments.map(existingAttachment =>
                                        existingAttachment.id === attachment.id
                                          ? {
                                              ...existingAttachment,
                                              renderInline: event.target.checked
                                            }
                                          : existingAttachment
                                      )
                                    }))
                                  }
                                  className="h-4 w-4 rounded border-slate-300 text-oe-primary focus:ring-oe-primary"
                                />
                                Render inline after overview copy
                              </label>
                            </div>
                          )}

                          <div className="flex justify-end border-t border-slate-200 pt-4 -mb-1">
                            <button
                              type="button"
                              onClick={() =>
                                updateStep(step.id, currentStep => ({
                                  ...currentStep,
                                  attachments: currentStep.attachments.filter(
                                    existingAttachment => existingAttachment.id !== attachment.id
                                  )
                                }))
                              }
                              className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 shadow-sm hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-200"
                            >
                              <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
                              Remove attachment
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {step.attachments.length === 0 && (
                    <p className="text-xs text-gray-500">No attachments for this step.</p>
                  )}
                </div>
              </div>

              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                <div className="flex items-center justify-between mb-2">
                  <label className="inline-flex items-center gap-2 text-sm font-medium text-emerald-900">
                    <input
                      type="checkbox"
                      checked={Boolean(step.sectionQuiz)}
                      onChange={() =>
                        updateStep(step.id, currentStep => {
                          if (currentStep.sectionQuiz) {
                            return { ...currentStep, sectionQuiz: undefined };
                          }
                          const newQuiz: SectionQuiz = {
                            id: createTrainingId('quiz'),
                            title: 'New Quiz',
                            sectionId: currentStep.id,
                            estimatedDurationMinutes: 5,
                            questions: [],
                            quizTakes: []
                          };
                          return { ...currentStep, sectionQuiz: newQuiz };
                        })
                      }
                      className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                    />
                    <Brain className="h-4 w-4 text-emerald-800" />
                    <span>This step includes a quiz</span>
                  </label>
                  {step.sectionQuiz && (
                    <button
                      type="button"
                      onClick={() =>
                        updateStep(step.id, currentStep => ({
                          ...currentStep,
                          sectionQuiz: {
                            ...currentStep.sectionQuiz!,
                            questions: [
                              ...currentStep.sectionQuiz!.questions,
                              {
                                id: createTrainingId('question'),
                                questionNumber: currentStep.sectionQuiz!.questions.length + 1,
                                questionText: 'New question',
                                answerText: '',
                                answerOrdinal: '',
                                answerChoices: []
                              }
                            ]
                          }
                        }))
                      }
                      className="rounded border border-emerald-300 bg-white px-2 py-1 text-xs text-emerald-900 hover:bg-emerald-100"
                    >
                      + Add Question
                    </button>
                  )}
                </div>

                {step.sectionQuiz && (
                  <div>
                    <label className="block text-xs font-semibold text-emerald-900 uppercase tracking-wide mb-1">
                      <span className="inline-flex items-center gap-1.5">
                        <FileText className="h-3.5 w-3.5 text-emerald-800" />
                        <span>Quiz title</span>
                      </span>
                    </label>
                    <input
                      value={step.sectionQuiz.title}
                      onChange={event =>
                        updateStep(step.id, currentStep => ({
                          ...currentStep,
                          sectionQuiz: {
                            ...currentStep.sectionQuiz!,
                            title: event.target.value
                          }
                        }))
                      }
                      placeholder="Quiz title"
                      className="w-full rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm mb-3"
                    />

                    <div className="mb-3">
                      <label className="block text-xs font-semibold text-emerald-900 uppercase tracking-wide mb-1">
                        <span className="inline-flex items-center gap-1.5">
                          <ListOrdered className="h-3.5 w-3.5 text-emerald-800" />
                          <span>Estimated quiz time (minutes)</span>
                        </span>
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={step.sectionQuiz.estimatedDurationMinutes}
                        onChange={event =>
                          updateStep(step.id, currentStep => ({
                            ...currentStep,
                            sectionQuiz: {
                              ...currentStep.sectionQuiz!,
                              estimatedDurationMinutes: Math.max(
                                1,
                                Number(event.target.value) || 1
                              )
                            }
                          }))
                        }
                        className="w-full rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm"
                      />
                    </div>

                    <div className="space-y-2">
                      {step.sectionQuiz.questions.map(question => (
                        <div key={question.id} className="rounded-md border border-indigo-200 bg-indigo-50 p-3">
                          <div className="mb-2 flex items-center justify-between">
                            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-900">
                              <span className="inline-flex items-center gap-1.5">
                                <MessageSquare className="h-3.5 w-3.5 text-indigo-800" />
                                <span>Question</span>
                              </span>
                            </p>
                            <span className="text-[11px] text-indigo-700">id: {question.id}</span>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                            <div className="md:col-span-2">
                              <label className="block text-[11px] font-medium text-indigo-800 mb-1">
                                <span className="inline-flex items-center gap-1">
                                  <ListOrdered className="h-3 w-3 text-indigo-700" />
                                  <span>Question Number</span>
                                </span>
                              </label>
                              <input
                                type="number"
                                min={1}
                                value={question.questionNumber}
                                onChange={event =>
                                  updateQuizQuestion(step.id, question.id, currentQuestion => ({
                                    ...currentQuestion,
                                    questionNumber: Number(event.target.value) || 1
                                  }))
                                }
                                className="w-full rounded-md border border-indigo-200 bg-white px-3 py-2 text-sm"
                                placeholder="#"
                              />
                            </div>
                            <div className="md:col-span-7">
                              <label className="block text-[11px] font-medium text-indigo-800 mb-1">
                                <span className="inline-flex items-center gap-1">
                                  <MessageSquare className="h-3 w-3 text-indigo-700" />
                                  <span>Question Text</span>
                                </span>
                              </label>
                              <input
                                value={question.questionText}
                                onChange={event =>
                                  updateQuizQuestion(step.id, question.id, currentQuestion => ({
                                    ...currentQuestion,
                                    questionText: event.target.value
                                  }))
                                }
                                className="w-full rounded-md border border-indigo-200 bg-white px-3 py-2 text-sm"
                                placeholder="Question text"
                              />
                            </div>
                            <div className="md:col-span-3">
                              <label className="block text-[11px] font-medium text-indigo-800 mb-1">
                                <span className="inline-flex items-center gap-1">
                                  <KeyRound className="h-3 w-3 text-indigo-700" />
                                  <span>Correct Ordinal</span>
                                </span>
                              </label>
                              <input
                                value={question.answerOrdinal}
                                onChange={event =>
                                  updateQuizQuestion(step.id, question.id, currentQuestion => ({
                                    ...currentQuestion,
                                    answerOrdinal: event.target.value
                                  }))
                                }
                                className="w-full rounded-md border border-indigo-200 bg-white px-3 py-2 text-sm"
                                placeholder="A / B / C / 1 / 2"
                              />
                            </div>

                            <div className="md:col-span-9">
                              <label className="block text-[11px] font-medium text-indigo-800 mb-1">
                                <span className="inline-flex items-center gap-1">
                                  <CheckCircle className="h-3 w-3 text-indigo-700" />
                                  <span>Correct Answer Text</span>
                                </span>
                              </label>
                              <input
                                value={question.answerText}
                                onChange={event =>
                                  updateQuizQuestion(step.id, question.id, currentQuestion => ({
                                    ...currentQuestion,
                                    answerText: event.target.value
                                  }))
                                }
                                className="w-full rounded-md border border-indigo-200 bg-white px-3 py-2 text-sm"
                                placeholder="Correct answer text"
                              />
                            </div>
                            <div className="md:col-span-3">
                              <label className="block text-[11px] font-medium text-indigo-800 mb-1">
                                <span className="inline-flex items-center gap-1">
                                  <Trash2 className="h-3 w-3 text-red-600" />
                                  <span>Remove Question</span>
                                </span>
                              </label>
                              <button
                                type="button"
                                onClick={() =>
                                  updateStep(step.id, currentStep => ({
                                    ...currentStep,
                                    sectionQuiz: {
                                      ...currentStep.sectionQuiz!,
                                      questions: currentStep.sectionQuiz!.questions.filter(
                                        existingQuestion => existingQuestion.id !== question.id
                                      )
                                    }
                                  }))
                                }
                                className="w-full rounded border border-red-200 bg-white px-2 py-2 text-xs text-red-700 hover:bg-red-50"
                              >
                                Remove Question
                              </button>
                            </div>
                          </div>

                          <div className="mt-3 rounded-md border border-cyan-200 bg-cyan-50 p-2">
                            <div className="flex items-center justify-between mb-1">
                              <p className="text-xs font-semibold uppercase tracking-wide text-cyan-900">
                                <span className="inline-flex items-center gap-1.5">
                                  <List className="h-3.5 w-3.5 text-cyan-800" />
                                  <span>Answer choices</span>
                                </span>
                              </p>
                              <button
                                type="button"
                                onClick={() =>
                                  updateQuizQuestion(step.id, question.id, currentQuestion => ({
                                    ...currentQuestion,
                                    answerChoices: [
                                      ...currentQuestion.answerChoices,
                                      {
                                        id: createTrainingId('choice'),
                                        answerText: '',
                                        answerTrueFalse: false,
                                        answerOrdinal: ''
                                      }
                                    ]
                                  }))
                                }
                                className="rounded border border-cyan-300 bg-white px-2 py-1 text-xs text-cyan-900 hover:bg-cyan-100"
                              >
                                + Choice
                              </button>
                            </div>
                            <div className="space-y-2">
                              {question.answerChoices.map(choice => (
                                <div key={choice.id} className="grid grid-cols-1 md:grid-cols-12 gap-2 rounded-md border border-cyan-200 bg-white p-2">
                                  <div className="md:col-span-2">
                                    <label className="block text-[11px] font-medium text-cyan-800 mb-1">
                                      <span className="inline-flex items-center gap-1">
                                        <ListOrdered className="h-3 w-3 text-cyan-700" />
                                        <span>Choice Ordinal</span>
                                      </span>
                                    </label>
                                    <input
                                      value={choice.answerOrdinal}
                                      onChange={event =>
                                        updateAnswerChoice(
                                          step.id,
                                          question.id,
                                          choice.id,
                                          currentChoice => ({
                                            ...currentChoice,
                                            answerOrdinal: event.target.value
                                          })
                                        )
                                      }
                                      className="w-full rounded-md border border-cyan-200 px-3 py-2 text-sm"
                                      placeholder="A / B / C"
                                    />
                                  </div>
                                  <div className="md:col-span-6">
                                    <label className="block text-[11px] font-medium text-cyan-800 mb-1">
                                      <span className="inline-flex items-center gap-1">
                                        <Type className="h-3 w-3 text-cyan-700" />
                                        <span>Choice Text</span>
                                      </span>
                                    </label>
                                    <input
                                      value={choice.answerText}
                                      onChange={event =>
                                        updateAnswerChoice(
                                          step.id,
                                          question.id,
                                          choice.id,
                                          currentChoice => ({
                                            ...currentChoice,
                                            answerText: event.target.value
                                          })
                                        )
                                      }
                                      className="w-full rounded-md border border-cyan-200 px-3 py-2 text-sm"
                                      placeholder="Choice text"
                                    />
                                  </div>
                                  <div className="md:col-span-2">
                                    <label className="block text-[11px] font-medium text-cyan-800 mb-1">
                                      <span className="inline-flex items-center gap-1">
                                        <CheckSquare className="h-3 w-3 text-cyan-700" />
                                        <span>Correct</span>
                                      </span>
                                    </label>
                                    <label className="inline-flex h-[38px] items-center gap-2 text-xs text-gray-700">
                                      <input
                                        type="checkbox"
                                        checked={choice.answerTrueFalse}
                                        onChange={event =>
                                          updateAnswerChoice(
                                            step.id,
                                            question.id,
                                            choice.id,
                                            currentChoice => ({
                                              ...currentChoice,
                                              answerTrueFalse: event.target.checked
                                            })
                                          )
                                        }
                                        className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                                      />
                                      Correct
                                    </label>
                                  </div>
                                  <div className="md:col-span-2">
                                    <label className="block text-[11px] font-medium text-cyan-800 mb-1">
                                      <span className="inline-flex items-center gap-1">
                                        <Trash2 className="h-3 w-3 text-red-600" />
                                        <span>Delete Choice</span>
                                      </span>
                                    </label>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateQuizQuestion(step.id, question.id, currentQuestion => ({
                                          ...currentQuestion,
                                          answerChoices: currentQuestion.answerChoices.filter(
                                            existingChoice => existingChoice.id !== choice.id
                                          )
                                        }))
                                      }
                                      className="w-full rounded border border-red-200 px-2 py-2 text-xs text-red-700 hover:bg-red-50"
                                    >
                                      Delete
                                    </button>
                                  </div>
                                </div>
                              ))}
                              {question.answerChoices.length === 0 && (
                                <p className="text-xs text-cyan-800">No answer choices yet.</p>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                      {step.sectionQuiz.questions.length === 0 && (
                        <p className="text-xs text-gray-500">No quiz questions yet.</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
            );
          })}
          {module.moduleSteps.length === 0 && (
            <p className="text-xs text-gray-500">No steps yet.</p>
          )}
        </div>
      </div>
    </section>
  );
};

export default ModuleEditorPanel;
