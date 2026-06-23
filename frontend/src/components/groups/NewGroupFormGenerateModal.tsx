// Same flow as GroupDetails "Generate New Group Form" — vendor pick, review, PDF/TXT/email, history.
import { Download, Loader2, Mail, Send, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';

export type NewGroupFormNotifySeverity = 'success' | 'error' | 'info' | 'warning';

interface NewGroupFormGenerateModalProps {
  open: boolean;
  onClose: () => void;
  groupId: string;
  groupName: string;
  onNotify?: (message: string, severity: NewGroupFormNotifySeverity) => void;
}

type HistoryRow = {
  id: string;
  vendorId: string;
  vendorName: string;
  actionType: 'Download' | 'Email';
  occurredAt: string;
  recipientEmail?: string;
  markedAsSent: boolean;
};

const NewGroupFormGenerateModal: React.FC<NewGroupFormGenerateModalProps> = ({
  open,
  onClose,
  groupId,
  groupName,
  onNotify,
}) => {
  const notify = (message: string, severity: NewGroupFormNotifySeverity = 'info') => {
    onNotify?.(message, severity);
  };

  const [vendors, setVendors] = useState<
    Array<{ VendorId: string; Id: string; VendorName: string; HasNewGroupFormConfig: boolean }>
  >([]);
  const [vendorsLoading, setVendorsLoading] = useState(false);
  const [emailOverrides, setEmailOverrides] = useState<Record<string, string>>({});
  const [downloading, setDownloading] = useState(false);
  const [downloadingTxt, setDownloadingTxt] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [step, setStep] = useState<'select' | 'review'>('select');
  const [previewVendorId, setPreviewVendorId] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{
    formTitle: string;
    fields: Array<{ key: string; label: string; value: string; missing: boolean; fieldType?: string; defaultValue?: string }>;
    vendorName: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});
  const getFieldStateKey = (f: { key: string }, index: number) => `${f.key}__${index}`;
  const buildOverridesPayload = () => {
    const byIndex: Record<number, string> = {};
    const byKey: Record<string, string> = {};
    (previewData?.fields || []).forEach((f, index) => {
      if (f.fieldType === 'labelHeader') return;
      const stateKey = getFieldStateKey(f, index);
      const edited = editedValues[stateKey] ?? '';
      byIndex[index] = edited;
      if (byKey[f.key] === undefined) byKey[f.key] = edited;
    });
    return { ...byKey, __byIndex: byIndex };
  };

  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPatching, setHistoryPatching] = useState<string | null>(null);
  const [historyDeleting, setHistoryDeleting] = useState<string | null>(null);
  const [historyDownloading, setHistoryDownloading] = useState<string | null>(null);
  const [historyDeleteConfirmId, setHistoryDeleteConfirmId] = useState<string | null>(null);
  const [sendEmailOpen, setSendEmailOpen] = useState(false);

  const fetchHistory = useCallback(async () => {
    if (!groupId) return;
    setHistoryLoading(true);
    try {
      const res = await apiService.get<{
        success: boolean;
        data?: Array<{
          id: string;
          vendorId: string;
          vendorName: string;
          actionType: string;
          occurredAt: string;
          recipientEmail?: string;
          markedAsSent: boolean;
        }>;
      }>(`/api/groups/${groupId}/new-group-form/history`);
      const list = (res?.data && Array.isArray(res.data) ? res.data : []) as typeof res.data;
      setHistory(
        (list || []).map((r) => ({
          ...r,
          actionType: r.actionType as 'Download' | 'Email',
        }))
      );
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    if (!open || !groupId) return;
    setStep('select');
    setPreviewData(null);
    setPreviewVendorId(null);
    setEditedValues({});
    setSendEmailOpen(false);
    setHistoryDeleteConfirmId(null);
  }, [open, groupId]);

  useEffect(() => {
    if (!open || !groupId) return;
    let cancelled = false;
    setVendorsLoading(true);
    apiService
      .get<{
        success: boolean;
        data?: Array<{ VendorId: string; Id: string; VendorName: string; HasNewGroupFormConfig: boolean }>;
      }>(`/api/groups/${groupId}/vendors`)
      .then((res) => {
        if (cancelled) return;
        const list = (res?.data && Array.isArray(res.data) ? res.data : []) as Array<{
          VendorId: string;
          Id: string;
          VendorName: string;
          HasNewGroupFormConfig: boolean;
        }>;
        setVendors(list.filter((v) => v.HasNewGroupFormConfig));
        setEmailOverrides({});
      })
      .catch(() => {
        if (!cancelled) setVendors([]);
      })
      .finally(() => {
        if (!cancelled) setVendorsLoading(false);
      });
    fetchHistory();
    return () => {
      cancelled = true;
    };
  }, [open, groupId, fetchHistory]);

  const openReview = async (vendorId: string) => {
    if (!groupId) return;
    setPreviewVendorId(vendorId);
    setPreviewLoading(true);
    setPreviewData(null);
    setEditedValues({});
    try {
      const res = await apiService.get<{
        success: boolean;
        formTitle?: string;
        fields?: Array<{
          key: string;
          label: string;
          value: string;
          missing: boolean;
          fieldType?: string;
          defaultValue?: string;
        }>;
        vendorName?: string;
        defaultEmail?: string;
      }>(`/api/groups/${groupId}/new-group-form/preview/${vendorId}`);
      if (res?.success && res?.fields) {
        setPreviewData({
          formTitle: res.formTitle || 'New Group Form',
          fields: res.fields,
          vendorName: res.vendorName || 'Vendor',
        });
        const initial: Record<string, string> = {};
        res.fields.forEach((f, index) => {
          const val = f.value != null && String(f.value).trim() !== '' ? String(f.value).trim() : '';
          const next = val || (f.defaultValue ?? '');
          if (f.fieldType === 'labelHeader') return;
          initial[getFieldStateKey(f, index)] = next;
        });
        setEditedValues(initial);
        setEmailOverrides((prev) => ({
          ...prev,
          [vendorId]: (res.defaultEmail ?? prev[vendorId] ?? '').trim(),
        }));
        setStep('review');
      } else {
        notify('Failed to load form preview', 'error');
      }
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        (e as Error)?.message ||
        'Failed to load preview';
      notify(msg, 'error');
    } finally {
      setPreviewLoading(false);
    }
  };

  const safeFileStem = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_');

  const handlePdf = async () => {
    if (!groupId || !previewVendorId) return;
    setDownloading(true);
    try {
      const blob = await apiService.post<Blob>(
        `/api/groups/${groupId}/new-group-form/generate/${previewVendorId}`,
        { fieldOverrides: buildOverridesPayload(), format: 'pdf' },
        { responseType: 'blob' }
      );
      const b = blob instanceof Blob ? blob : (blob as unknown as { data?: Blob })?.data;
      if (!b) throw new Error('No PDF returned');
      const url = window.URL.createObjectURL(b);
      const link = document.createElement('a');
      link.href = url;
      link.download = `NewGroupForm-${safeFileStem(groupName || 'Group')}-${safeFileStem(previewData?.vendorName || 'Vendor')}.pdf`;
      link.click();
      window.URL.revokeObjectURL(url);
      notify('Download started', 'success');
      fetchHistory();
    } catch (e) {
      notify((e as Error)?.message || 'Download failed', 'error');
    } finally {
      setDownloading(false);
    }
  };

  const handleTxt = async () => {
    if (!groupId || !previewVendorId) return;
    setDownloadingTxt(true);
    try {
      const blob = await apiService.post<Blob>(
        `/api/groups/${groupId}/new-group-form/generate/${previewVendorId}`,
        { fieldOverrides: buildOverridesPayload(), format: 'txt' },
        { responseType: 'blob' }
      );
      const b = blob instanceof Blob ? blob : (blob as unknown as { data?: Blob })?.data;
      if (!b) throw new Error('No file returned');
      const url = window.URL.createObjectURL(b);
      const link = document.createElement('a');
      link.href = url;
      link.download = `NewGroupForm-${safeFileStem(groupName || 'Group')}-${safeFileStem(previewData?.vendorName || 'Vendor')}.txt`;
      link.click();
      window.URL.revokeObjectURL(url);
      notify('Download started', 'success');
      fetchHistory();
    } catch (e) {
      notify((e as Error)?.message || 'Download failed', 'error');
    } finally {
      setDownloadingTxt(false);
    }
  };

  const handleSendEmail = async () => {
    if (!groupId || !previewVendorId) return;
    setSending(previewVendorId);
    try {
      const recipientEmail = emailOverrides[previewVendorId]?.trim() || undefined;
      await apiService.post(`/api/groups/${groupId}/new-group-form/send-email`, {
        vendorId: previewVendorId,
        recipientEmail,
        fieldOverrides: buildOverridesPayload(),
      });
      notify('Email sent successfully', 'success');
      setSendEmailOpen(false);
      fetchHistory();
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        (e as Error)?.message ||
        'Send failed';
      notify(msg, 'error');
    } finally {
      setSending(null);
    }
  };

  const handleHistoryMarkSent = async (historyId: string, markedAsSent: boolean) => {
    if (!groupId) return;
    setHistoryPatching(historyId);
    try {
      await apiService.patch(`/api/groups/${groupId}/new-group-form/history/${historyId}`, { markedAsSent });
      setHistory((prev) => prev.map((h) => (h.id === historyId ? { ...h, markedAsSent } : h)));
    } catch {
      notify('Failed to update sent status', 'error');
    } finally {
      setHistoryPatching(null);
    }
  };

  const handleHistoryDelete = async (historyId: string) => {
    if (!groupId) return;
    setHistoryDeleting(historyId);
    setHistoryDeleteConfirmId(null);
    try {
      await apiService.delete(`/api/groups/${groupId}/new-group-form/history/${historyId}`);
      setHistory((prev) => prev.filter((h) => h.id !== historyId));
      notify('History entry removed.', 'success');
    } catch {
      notify('Failed to delete history entry', 'error');
    } finally {
      setHistoryDeleting(null);
    }
  };

  const handleHistoryRedownload = async (h: { id: string; vendorId: string; vendorName: string }) => {
    if (!groupId) return;
    setHistoryDownloading(h.id);
    try {
      const blob = await apiService.post<Blob>(
        `/api/groups/${groupId}/new-group-form/generate/${h.vendorId}`,
        { fieldOverrides: {}, format: 'pdf' },
        { responseType: 'blob' }
      );
      const b = blob instanceof Blob ? blob : (blob as unknown as { data?: Blob })?.data;
      if (!b) throw new Error('No PDF returned');
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeFileStem(groupName)}-${safeFileStem(h.vendorName)}-form.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      notify('PDF downloaded.', 'success');
    } catch {
      notify('Failed to re-download form', 'error');
    } finally {
      setHistoryDownloading(null);
    }
  };

  const handleClose = () => {
    setSendEmailOpen(false);
    setHistoryDeleteConfirmId(null);
    setStep('select');
    setPreviewData(null);
    setPreviewVendorId(null);
    onClose();
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" role="dialog" aria-modal="true">
        <div className="bg-white rounded-lg border border-gray-200 shadow-xl max-w-lg w-full max-h-[90vh] flex flex-col">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
            <h2 className="text-lg font-semibold text-gray-900">
              {step === 'review' ? `Review values – ${previewData?.vendorName ?? 'New Group Form'}` : 'Generate New Group Form'}
            </h2>
            <button
              type="button"
              onClick={handleClose}
              className="p-1 rounded-lg text-gray-500 hover:bg-gray-100"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="px-6 py-4 overflow-y-auto flex-1 min-h-0">
            {step === 'select' && (
              <>
                <p className="text-sm text-gray-600 mb-4">
                  Select a vendor to prepare their configured new group form. The form will load with resolved field values; you can edit if needed, then download as PDF or TXT or send by email.
                </p>
                {vendorsLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
                  </div>
                ) : vendors.length === 0 ? (
                  <p className="text-sm text-gray-600">
                    No vendors with a new group form configured for this group. Vendors can configure their form under Vendor Settings → New Group Form.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {vendors.map((v) => {
                      const id = v.VendorId || v.Id;
                      return (
                        <div
                          key={id}
                          className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-lg border border-gray-200 bg-gray-50"
                        >
                          <span className="font-medium text-gray-900">{v.VendorName}</span>
                          <button
                            type="button"
                            onClick={() => openReview(id)}
                            className="px-3 py-1.5 text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700"
                          >
                            Prepare form
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="mt-6 pt-4 border-t border-gray-200">
                  <h3 className="text-sm font-semibold text-gray-900 mb-1">History</h3>
                  <p className="text-xs text-gray-500 mb-2">
                    Track forms generated or sent. Use &quot;Mark as sent&quot; to record when the form was actually sent to the vendor.
                  </p>
                  {historyLoading ? (
                    <div className="flex justify-center py-4">
                      <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                    </div>
                  ) : history.length === 0 ? (
                    <p className="text-sm text-gray-500">No history yet.</p>
                  ) : (
                    <ul className="max-h-48 overflow-y-auto space-y-1 text-sm">
                      {history.map((h) => (
                        <li
                          key={h.id}
                          className={`flex flex-wrap items-center justify-between gap-2 py-2 px-2 rounded border border-gray-100 ${
                            h.markedAsSent ? 'bg-green-50/80' : ''
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-gray-900 truncate">{h.vendorName}</div>
                            <div className="text-xs text-gray-500">
                              {h.actionType === 'Email' ? 'Sent' : 'Downloaded'}
                              {h.actionType === 'Email' && h.recipientEmail ? ` to ${h.recipientEmail}` : ''}
                              {h.occurredAt ? ` · ${new Date(h.occurredAt).toLocaleString()}` : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              title="Re-download PDF"
                              onClick={() => handleHistoryRedownload(h)}
                              disabled={historyDownloading === h.id}
                              className="p-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                            >
                              {historyDownloading === h.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Download className="h-4 w-4" />
                              )}
                            </button>
                            <label className="flex items-center gap-1 cursor-pointer text-xs text-gray-600">
                              <input
                                type="checkbox"
                                checked={h.markedAsSent}
                                disabled={historyPatching === h.id}
                                onChange={() => handleHistoryMarkSent(h.id, !h.markedAsSent)}
                                className="rounded border-gray-300"
                              />
                              Mark sent
                            </label>
                            <button
                              type="button"
                              title="Delete"
                              onClick={() => setHistoryDeleteConfirmId(h.id)}
                              disabled={historyDeleting === h.id}
                              className="p-1.5 rounded text-red-600 hover:bg-red-50 disabled:opacity-50"
                            >
                              {historyDeleting === h.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}

            {step === 'review' && (
              <>
                {previewLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
                  </div>
                ) : (
                  previewData && (
                    <>
                      <h3 className="text-sm font-semibold text-gray-900 mb-3">{previewData.formTitle}</h3>
                      <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                        {previewData.fields.map((f, idx) => {
                          const isSignatureField = f.key === 'agentSignature' || f.key === 'groupAdminSignature';
                          if (f.fieldType === 'labelHeader') {
                            return (
                              <div key={`${f.key}-${idx}`}>
                                <p className="text-sm font-semibold text-gray-900">{f.label}</p>
                              </div>
                            );
                          }
                          if (isSignatureField) {
                            const provided = !f.missing && f.value != null && String(f.value).trim() !== '';
                            return (
                              <div key={f.key} className="p-3 rounded-lg border border-gray-200 bg-gray-50">
                                <p className="text-xs text-gray-500 mb-1">{f.label}</p>
                                <p className={`text-sm ${provided ? 'text-green-700' : 'text-gray-500'}`}>
                                  {provided ? 'Provided' : 'Missing'}
                                </p>
                              </div>
                            );
                          }
                          return (
                            <div key={`${f.key}-${idx}`}>
                              <label className="block text-xs text-gray-600 mb-1">
                                {f.label}
                                {f.missing ? <span className="text-amber-600"> (missing)</span> : null}
                              </label>
                              <textarea
                                rows={2}
                                value={editedValues[getFieldStateKey(f, idx)] ?? ''}
                                onChange={(e) =>
                                  setEditedValues((prev) => ({
                                    ...prev,
                                    [getFieldStateKey(f, idx)]: e.target.value,
                                  }))
                                }
                                placeholder={f.missing ? 'Enter value or leave blank' : ''}
                                className={`w-full px-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
                                  f.missing ? 'border-amber-300 bg-amber-50' : 'border-gray-300'
                                }`}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )
                )}
              </>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-200 flex flex-wrap items-center justify-end gap-2 shrink-0">
            {step === 'review' ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setStep('select');
                    setPreviewData(null);
                    setPreviewVendorId(null);
                  }}
                  className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handlePdf}
                  disabled={downloading || downloadingTxt}
                  className="inline-flex items-center gap-1 px-3 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  {downloading ? 'Downloading…' : 'Download PDF'}
                </button>
                <button
                  type="button"
                  onClick={handleTxt}
                  disabled={downloading || downloadingTxt}
                  className="inline-flex items-center gap-1 px-3 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {downloadingTxt ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  {downloadingTxt ? 'Downloading…' : 'Download TXT'}
                </button>
                <button
                  type="button"
                  onClick={() => setSendEmailOpen(true)}
                  disabled={!!sending}
                  className="inline-flex items-center gap-1 px-4 py-2 text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                >
                  {sending === previewVendorId ? (
                    <Loader2 className="h-4 w-4 animate-spin text-white" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  Send email
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
            )}
          </div>
        </div>
      </div>

      {historyDeleteConfirmId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-lg border border-gray-200 shadow-xl max-w-sm w-full p-6">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Remove history entry?</h3>
            <p className="text-sm text-gray-600 mb-4">
              {(() => {
                const entry = history.find((x) => x.id === historyDeleteConfirmId);
                return entry
                  ? `Remove the "${entry.vendorName}" history entry? This cannot be undone.`
                  : 'Remove this history entry? This cannot be undone.';
              })()}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setHistoryDeleteConfirmId(null)}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => historyDeleteConfirmId && handleHistoryDelete(historyDeleteConfirmId)}
                disabled={!!historyDeleting}
                className="px-3 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {historyDeleting ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}

      {sendEmailOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-lg border border-gray-200 shadow-xl max-w-sm w-full p-6">
            <h3 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Send to email
            </h3>
            <label className="block text-sm font-medium text-gray-700 mb-1">Recipient email</label>
            <input
              type="email"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              placeholder="Vendor contact email"
              value={previewVendorId ? emailOverrides[previewVendorId] ?? '' : ''}
              onChange={(e) =>
                previewVendorId &&
                setEmailOverrides((prev) => ({ ...prev, [previewVendorId]: e.target.value }))
              }
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setSendEmailOpen(false)}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSendEmail}
                disabled={!!sending}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {sending === previewVendorId ? <Loader2 className="h-4 w-4 animate-spin text-white" /> : <Send className="h-4 w-4" />}
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default NewGroupFormGenerateModal;
