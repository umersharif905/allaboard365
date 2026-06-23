import { useEffect, useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import { buildIDCardPdfBase64 } from './idCardPdf';

interface SendIDCardSmsModalProps {
  isOpen: boolean;
  memberId: string;
  enrollmentId: string;
  productName: string;
  defaultPhone?: string;
  onClose: () => void;
  onSent?: () => void;
}

// Basic E.164-friendly phone validation: at least 10 digits after stripping.
const isLikelyPhone = (raw: string) => raw.replace(/\D/g, '').length >= 10;

const SendIDCardSmsModal = ({
  isOpen,
  memberId,
  enrollmentId,
  productName,
  defaultPhone,
  onClose,
  onSent,
}: SendIDCardSmsModalProps) => {
  const [phone, setPhone] = useState(defaultPhone || '');
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setPhone(defaultPhone || '');
      setMessage('Here is your ID card:');
      setError(null);
      setIsSending(false);
    }
  }, [isOpen, defaultPhone]);

  if (!isOpen) return null;

  const handleSend = async () => {
    setError(null);
    const trimmed = phone.trim();
    if (!trimmed || !isLikelyPhone(trimmed)) {
      setError('Please enter a valid phone number.');
      return;
    }
    setIsSending(true);
    try {
      const { pdfBase64, fileName } = await buildIDCardPdfBase64(enrollmentId, productName);
      const response = await apiService.post<{ success: boolean; message?: string }>(
        `/api/me/vendor/members/${memberId}/id-cards/send-sms`,
        {
          to: trimmed,
          message: message.trim() || undefined,
          productName,
          fileName,
          pdfBase64,
        },
      );
      if (!response.success) {
        throw new Error(response.message || 'Failed to send ID card text.');
      }
      onSent?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send ID card text.';
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
      aria-labelledby="send-id-card-sms-title"
    >
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h2 id="send-id-card-sms-title" className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-oe-primary" />
            Send ID Card by Text
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
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="(555) 123-4567"
              disabled={isSending}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              disabled={isSending}
            />
            <p className="mt-1 text-xs text-gray-500">
              The secure download link will be appended automatically. Link expires in 7 days.
            </p>
          </div>
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
            {isSending ? 'Sending…' : (<><MessageSquare className="h-4 w-4" /> Send Text</>)}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SendIDCardSmsModal;
