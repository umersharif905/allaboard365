import { useEffect, useState } from 'react';
import { Mail, X, AlertCircle, Loader2 } from 'lucide-react';
import { useForwardingPreview, useSendForwarding } from '../../../hooks/vendor/useCaseForwarding';

interface Props { caseId: string; isOpen: boolean; onClose: () => void }

const TpaForwardPreviewModal = ({ caseId, isOpen, onClose }: Props) => {
  const { data: preview, isLoading } = useForwardingPreview(isOpen ? caseId : null);
  const sendMut = useSendForwarding();

  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([]);
  const [extraRecipient, setExtraRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preview) {
      setSelectedRecipients(preview.recipients);
      setSubject(preview.subject);
      setBody(preview.body);
      setSelectedDocs([]);
    }
  }, [preview]);

  if (!isOpen) return null;

  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const allRecipients = Array.from(new Set([
    ...selectedRecipients,
    ...(extraRecipient.trim() ? [extraRecipient.trim()] : []),
  ]));

  const handleSend = async () => {
    setError(null);
    if (allRecipients.length === 0) { setError('Select or add at least one recipient.'); return; }
    try {
      await sendMut.mutateAsync({ caseId, to: allRecipients, subject, body, documentIds: selectedDocs });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send');
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 py-8">
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={onClose} />
        <div className="relative inline-block bg-white rounded-lg text-left shadow-xl w-full max-w-2xl">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <div className="flex items-center">
              <Mail className="h-5 w-5 text-oe-primary mr-2" />
              <h3 className="text-lg font-medium text-gray-900">
                Forward to {preview?.target?.label || 'TPA'}
              </h3>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500"><X className="h-5 w-5" /></button>
          </div>

          <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
            {isLoading && <div className="flex items-center gap-2 text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading preview…</div>}

            {preview?.priorSends?.length ? (
              <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-800">
                  Already sent on {new Date(preview.priorSends[0].SentDate).toLocaleString()} to {preview.priorSends[0].RecipientAddress}. You can resend.
                </p>
              </div>
            ) : null}

            {preview && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Recipients</label>
                  <div className="space-y-1">
                    {preview.recipients.map((rcpt) => (
                      <label key={rcpt} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={selectedRecipients.includes(rcpt)}
                          onChange={() => setSelectedRecipients((l) => toggle(l, rcpt))} />
                        {rcpt}
                      </label>
                    ))}
                  </div>
                  <input type="email" placeholder="Add another recipient…" value={extraRecipient}
                    onChange={(e) => setExtraRecipient(e.target.value)}
                    className="mt-2 w-full border border-gray-300 rounded-md px-2 py-1 text-sm" />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Subject</label>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject"
                    className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm" />
                  <p className="mt-1 text-xs text-gray-500 truncate" title={subject}>{subject}</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Body</label>
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} aria-label="Body"
                    className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm font-mono" />
                </div>

                {preview.documents.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Attach documents</label>
                    <div className="space-y-1">
                      {preview.documents.map((d) => (
                        <label key={d.DocumentId} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={selectedDocs.includes(d.DocumentId)}
                            onChange={() => setSelectedDocs((l) => toggle(l, d.DocumentId))} />
                          {d.DocumentName || d.FileName}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 shrink-0" />
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}
          </div>

          <div className="bg-gray-50 px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
            <button type="button" onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">
              Cancel
            </button>
            <button type="button" onClick={handleSend}
              disabled={sendMut.isPending || allRecipients.length === 0}
              className="px-4 py-2 bg-oe-primary text-white rounded-lg text-sm font-medium hover:bg-oe-dark disabled:opacity-50 inline-flex items-center gap-2">
              {sendMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TpaForwardPreviewModal;
