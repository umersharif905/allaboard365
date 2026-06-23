import { Mail, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { MemberEmailVerificationService, EmailVerificationStatus } from '../../services/email-verification.service';
import EmailVerificationPanel from './EmailVerificationPanel';

const SESSION_DISMISS_KEY = 'oe-email-verification-banner-dismissed';

const EmailVerificationBanner: React.FC = () => {
  const [status, setStatus] = useState<EmailVerificationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(SESSION_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [modalOpen, setModalOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await MemberEmailVerificationService.getStatus();
      setStatus(s);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const shouldShow =
    !loading &&
    !dismissed &&
    status &&
    status.isPrimary &&
    !status.emailVerified;

  if (!shouldShow) return null;

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(SESSION_DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <>
      <div className="bg-amber-50 border-b border-amber-200">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-2 flex items-center gap-3">
          <Mail className="h-4 w-4 text-amber-700 flex-shrink-0" />
          <p className="text-sm text-amber-900 flex-1">
            <span className="font-medium">Please verify your email address.</span>{' '}
            <span className="hidden sm:inline">
              {status?.email
                ? `We need to confirm we can reach you at ${status.email}.`
                : 'Confirm we can reach you so we can keep your account secure.'}
            </span>
          </p>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="text-sm font-medium px-3 py-1 bg-oe-primary text-white rounded-md hover:bg-oe-dark whitespace-nowrap"
          >
            Verify now
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss for this session"
            title="Dismiss for this session"
            className="p-1 text-amber-700 hover:text-amber-900 rounded-full"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {modalOpen && status && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="max-w-lg w-full">
            <div className="flex justify-end mb-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Close"
                className="p-1 text-white hover:text-gray-200 rounded-full"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <EmailVerificationPanel
              email={status.email || ''}
              onSendCode={MemberEmailVerificationService.sendCode}
              onVerifyCode={MemberEmailVerificationService.verifyCode}
              onVerified={async () => {
                await refresh();
                setModalOpen(false);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
};

export default EmailVerificationBanner;
