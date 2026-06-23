import { useEffect, useState } from 'react';
import { Mail, X } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import { buildIDCardPdfBase64 } from './idCardPdf';

interface SendIDCardModalProps {
  isOpen: boolean;
  memberId: string;
  enrollmentId: string;
  productName: string;
  defaultRecipient?: string;
  onClose: () => void;
  onSent?: () => void;
}

const SendIDCardModal = ({
  isOpen,
  memberId,
  enrollmentId,
  productName,
  defaultRecipient,
  onClose,
  onSent,
}: SendIDCardModalProps) => {
  const [recipient, setRecipient] = useState(defaultRecipient || '');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setRecipient(defaultRecipient || '');
      setSubject(`Your ${productName} ID card`);
      setMessage('');
      setError(null);
      setIsSending(false);
    }
  }, [isOpen, defaultRecipient, productName]);

  if (!isOpen) return null;

  const handleSend = async () => {
    setError(null);
    const trimmed = recipient.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Please enter a valid email address.');
      return;
    }
    setIsSending(true);
    try {
      const { pdfBase64, fileName } = await buildIDCardPdfBase64(enrollmentId, productName);
      const response = await apiService.post<{ success: boolean; message?: string }>(
        `/api/me/vendor/members/${memberId}/id-cards/send`,
        {
          to: trimmed,
          subject: subject.trim() || undefined,
          message: message.trim() || undefined,
          productName,
          fileName,
          pdfBase64,
        },
      );
      if (!response.success) {
        throw new Error(response.message || 'Failed to send ID card.');
      }
      onSent?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send ID card.';
      setError(msg);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="send-id-card-title"
    >
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h2 id="send-id-card-title" className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Mail className="h-4 w-4 text-oe-primary" />
            Send ID Card by Email
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
            disabled={isSending}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Send to</label>
            <input
              type="email"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="member@example.com"
              disabled={isSending}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              disabled={isSending}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Message (optional)</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="Add a personal note (optional)…"
              disabled={isSending}
            />
          </div>
          <p className="text-xs text-gray-500">
            The {productName} ID card (front &amp; back) will be attached as a PDF.
          </p>
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
            disabled={isSending}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSend}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
            disabled={isSending}
          >
            {isSending ? 'Sending…' : (<><Mail className="h-4 w-4" /> Send Email</>)}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SendIDCardModal;
