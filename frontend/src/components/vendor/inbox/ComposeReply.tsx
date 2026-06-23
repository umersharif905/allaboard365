// ComposeReply — reply box at the bottom of the thread reader. Sends as the
// shared mailbox; the footer + Ref are appended server-side, so we just show a
// hint. No real send happens until the Graph blockers (B-001..003) are live.
import { useRef, useState } from 'react';
import { Send, Paperclip, X, Eye } from 'lucide-react';
import { inboxService } from '../../../services/inbox.service';
import useUserProfile from '../../../hooks/useUserProfile';
import EmailPreview from './EmailPreview';

const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

interface Props {
  threadId: string;
  refLabel?: string | null; // SR-/CASE- number shown in the "added automatically" hint
  othersReplyingName?: string | null; // another agent currently replying (collision presence)
  onReplyingChange: (replying: boolean) => void; // report "I'm replying" up for presence
  onSent: () => void;
}

const ComposeReply = ({ threadId, refLabel, othersReplyingName, onReplyingChange, onSent }: Props) => {
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [replyAll, setReplyAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: profile } = useUserProfile();
  const senderName = `${profile?.FirstName || ''} ${profile?.LastName || ''}`.trim();

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)].slice(0, 10));
  };

  const send = async () => {
    if ((!body.trim() && files.length === 0) || sending) return;
    if (othersReplyingName && !window.confirm(`${othersReplyingName} is also replying to this email. Send anyway?`)) return;
    setSending(true);
    setError(null);
    try {
      // Plain text → minimal HTML; the rich EmailEditor can replace this later.
      const html = body
        .split(/\n{2,}/)
        .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
        .join('');
      await inboxService.sendReply(threadId, { bodyHtml: html || '<p></p>', replyAll, files });
      setBody('');
      setFiles([]);
      onReplyingChange(false);
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-gray-200 p-4 bg-white">
      {error && <div className="mb-2 text-xs text-red-600">{error}</div>}
      <div className="border border-gray-300 rounded-lg focus-within:ring-2 focus-within:ring-oe-primary">
        <textarea
          rows={3}
          value={body}
          onChange={(e) => { setBody(e.target.value); onReplyingChange(true); }}
          onFocus={() => onReplyingChange(true)}
          onBlur={() => onReplyingChange(body.trim().length > 0)}
          placeholder="Reply…"
          className="w-full text-sm p-3 rounded-t-lg focus:outline-none resize-none"
        />
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2">
            {files.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1 text-xs bg-oe-light text-oe-dark rounded px-2 py-0.5">
                <Paperclip className="h-3 w-3" />{f.name} <span className="text-gray-400">{fmtSize(f.size)}</span>
                <button type="button" onClick={() => setFiles((p) => p.filter((_, idx) => idx !== i))} className="hover:text-red-600"><X className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 bg-gray-50 rounded-b-lg">
          <div className="flex items-center gap-3 text-gray-400">
            <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
            <button type="button" onClick={() => inputRef.current?.click()} title="Attach files" className="hover:text-oe-primary">
              <Paperclip className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setShowPreview(true)} title="Preview email" className="inline-flex items-center gap-1 text-xs hover:text-oe-primary">
              <Eye className="h-4 w-4" /> Preview
            </button>
            <label className="inline-flex items-center gap-1 text-xs cursor-pointer hover:text-oe-primary" title="Also CC everyone else on this thread">
              <input
                type="checkbox"
                checked={replyAll}
                onChange={(e) => setReplyAll(e.target.checked)}
                className="h-3 w-3 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
              />
              Reply all
            </label>
            <span className="text-xs">
              Footer{refLabel ? ` + Ref: ${refLabel}` : ''} added automatically
            </span>
          </div>
          <button
            type="button"
            onClick={send}
            disabled={(!body.trim() && files.length === 0) || sending}
            className="inline-flex items-center gap-1 bg-oe-primary hover:bg-oe-dark disabled:opacity-50 text-white text-sm rounded-md px-4 py-1.5 transition-colors"
          >
            <Send className="h-4 w-4" />
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>

      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowPreview(false)}>
          <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-2xl flex flex-col max-h-[88vh]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Eye className="h-4 w-4 text-oe-primary" /> Email preview</h3>
              <button type="button" onClick={() => setShowPreview(false)} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
            </div>
            <div className="overflow-y-auto p-4 bg-gray-100">
              <EmailPreview
                bodyText={body}
                senderName={senderName}
                emailSignature={profile?.EmailSignature}
                emailCard={profile?.EmailCard}
                userId={profile?.UserId || ''}
                refLabel={refLabel}
                showQuoteNote
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ComposeReply;
