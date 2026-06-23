import { CheckCircle2, Info, Ticket, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { getPostHogSessionReplayUrl } from '../../config/posthog';
import { apiService } from '../../services/api.service';

type ReportType = 'bug' | 'feature';

const FEATURE_TIPS: { main: string; sub?: string }[] = [
  { main: 'Give us the most detail possible — the more detail you provide, the better we can implement it.' },
  { main: 'Include the context: who it’s for, when you’d use it, and why it would help.' },
  {
    main: 'If you have examples from other apps, describing them can speed things up.',
    sub: 'It’s fine to paste URLs for content that exemplifies what you’re trying to achieve.'
  }
];

/**
 * Support ticket modal (issue vs feature). Opens via `isOpen` / `onClose`.
 * Submits to the same endpoint as before (`type` remains `bug` | `feature` for the API).
 */
export const BugReportModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const [step, setStep] = useState<'form' | 'success'>('form');
  const [reportType, setReportType] = useState<ReportType>('bug');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setStep('form');
    setReportType('bug');
    setDescription('');
    setError(null);
  }, [isOpen]);

  const resetAndClose = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resetAndClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, resetAndClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = description.trim();
    if (!trimmed) {
      setError('Please describe your request before submitting.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const posthogSessionUrl = getPostHogSessionReplayUrl();
      const res = await apiService.post<{ success: boolean; message?: string }>('/api/me/bug-report', {
        type: reportType,
        description: trimmed,
        ...(posthogSessionUrl ? { posthogSessionUrl } : {}),
      });
      const data = res as { success?: boolean; message?: string };
      if (data?.success) {
        setStep('success');
      } else {
        setError((data as any)?.message || 'Something went wrong.');
      }
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || 'Failed to submit.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50"
        onClick={resetAndClose}
        role="dialog"
        aria-modal="true"
        aria-labelledby="support-ticket-title"
      >
        <div
          className="bg-white rounded-lg shadow-xl border border-gray-200 w-full max-w-md"
          onClick={(e) => e.stopPropagation()}
        >
          {step === 'success' ? (
            <>
              <div className="flex items-center justify-between p-4 border-b border-gray-200">
                <h2 id="support-ticket-title" className="text-lg font-semibold text-gray-900">
                  Ticket received
                </h2>
                <button
                  type="button"
                  onClick={resetAndClose}
                  className="p-1 rounded text-gray-500 hover:bg-gray-100 shrink-0"
                  aria-label="Close"
                >
                  <X size={20} />
                </button>
              </div>
              <div className="p-6 text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                  <CheckCircle2 className="h-9 w-9 text-green-600" aria-hidden />
                </div>
                <p className="text-base font-medium text-gray-900 mb-2">You&apos;re all set</p>
                <p className="text-sm text-gray-600 leading-relaxed mb-1">
                  Our AI has started working on your ticket right away.
                </p>
                <p className="text-sm text-gray-600 leading-relaxed mb-6">
                  Our team will review it and be in touch if we need anything else.
                </p>
                <p className="text-xs text-gray-500 mb-6">
                  If email confirmations are enabled for your account, you may receive a message shortly.
                </p>
                <button
                  type="button"
                  onClick={resetAndClose}
                  className="w-full px-4 py-2.5 text-sm font-medium text-white bg-oe-primary rounded-lg hover:opacity-90 transition-opacity"
                >
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between p-4 border-b border-gray-200">
                <div className="flex items-center gap-2 min-w-0">
                  <Ticket size={22} className="text-oe-primary shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <h2 id="support-ticket-title" className="text-lg font-semibold text-gray-900">
                      New support ticket
                    </h2>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={resetAndClose}
                  className="p-1 rounded text-gray-500 hover:bg-gray-100 shrink-0"
                  aria-label="Close"
                  disabled={submitting}
                >
                  <X size={20} />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="p-4 space-y-4">
                <div className="flex gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-left">
                  <Info className="h-5 w-5 shrink-0 text-blue-600 mt-0.5" aria-hidden />
                  <p className="text-sm text-blue-900 leading-relaxed">
                    After you submit, our AI begins working on your ticket immediately. Our team will also review your
                    request and be in touch if needed.
                  </p>
                </div>

                {error && (
                  <div className="p-2 text-sm text-red-600 bg-red-50 rounded-md">
                    {error}
                  </div>
                )}

                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-gray-700 mb-1">Category</legend>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="reportType"
                      value="bug"
                      checked={reportType === 'bug'}
                      onChange={() => setReportType('bug')}
                      className="w-4 h-4 text-oe-primary border-gray-300 focus:ring-oe-primary"
                    />
                    <span className="text-sm font-medium text-gray-700">Issue or something not working</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="reportType"
                      value="feature"
                      checked={reportType === 'feature'}
                      onChange={() => setReportType('feature')}
                      className="w-4 h-4 text-oe-primary border-gray-300 focus:ring-oe-primary"
                    />
                    <span className="text-sm font-medium text-gray-700">Feature request</span>
                  </label>
                </fieldset>

                {reportType === 'bug' && (
                  <div>
                    <label htmlFor="ticket-issue-description" className="block text-sm font-medium text-gray-700 mb-1">
                      What should we know?
                    </label>
                    <textarea
                      id="ticket-issue-description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Describe what happened, what you expected, and steps to reproduce if you can."
                      rows={4}
                      disabled={submitting}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary disabled:opacity-60"
                    />
                  </div>
                )}

                {reportType === 'feature' && (
                  <div className="space-y-3">
                    <div>
                      <label
                        htmlFor="ticket-feature-description"
                        className="block text-sm font-medium text-gray-700 mb-1"
                      >
                        Describe the feature you are looking for in detail below.
                      </label>
                      <textarea
                        id="ticket-feature-description"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="What would you like to see? Who is it for? When would you use it?"
                        rows={4}
                        disabled={submitting}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary disabled:opacity-60"
                      />
                    </div>
                    <div className="rounded-md bg-amber-50 border border-amber-200 p-3">
                      <p className="text-xs font-medium text-amber-800 mb-2">Tips</p>
                      <ul className="space-y-1.5 text-xs text-amber-800">
                        {FEATURE_TIPS.map((tip, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="shrink-0" aria-hidden>
                              💡
                            </span>
                            <span>
                              {tip.main}
                              {tip.sub != null && (
                                <span className="flex gap-1.5 pl-4 mt-0.5 text-amber-700">
                                  <span className="shrink-0" aria-hidden>
                                    🔗
                                  </span>
                                  <span>{tip.sub}</span>
                                </span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={resetAndClose}
                    disabled={submitting}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-md hover:opacity-90 disabled:opacity-60"
                  >
                    {submitting ? 'Submitting…' : 'Submit ticket'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </>
  );
};

/** Legacy FAB wrapper — kept for backward compatibility but no longer used. */
const BugReportFAB: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="w-16 h-16 rounded-full flex items-center justify-center bg-transparent hover:scale-105 transition-all duration-200"
        title="New support ticket"
      >
        <Ticket size={24} className="text-gray-400" />
      </button>
      <BugReportModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
};

export default BugReportFAB;
