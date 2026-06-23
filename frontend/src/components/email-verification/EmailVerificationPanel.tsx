import { CheckCircle, Mail } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useInFlightGuard } from '../../hooks/useInFlightGuard';

export interface EmailVerificationPanelProps {
  /** Current email on the user record. Read-only — wrong addresses must go through the agent. */
  email: string;
  /** When true, shows a "Skip for now" button alongside primary actions. */
  allowSkip?: boolean;
  /** Send a code to the email shown above. */
  onSendCode: () => Promise<{ success: boolean; message?: string }>;
  /** Verify the code submitted by the user. */
  onVerifyCode: (code: string) => Promise<{ success: boolean; message?: string }>;
  /** Called once verification succeeds. */
  onVerified: () => void;
  /** Called when the user clicks Skip (only rendered if allowSkip). */
  onSkip?: () => void;
  /** Optional heading override. */
  heading?: string;
  /** Optional description override. */
  description?: string;
}

const EmailVerificationPanel: React.FC<EmailVerificationPanelProps> = ({
  email,
  allowSkip = false,
  onSendCode,
  onVerifyCode,
  onVerified,
  onSkip,
  heading = 'Verify Your Email',
  description = "We'll send a 6-digit code to confirm we can reach you.",
}) => {
  const [step, setStep] = useState<'initial' | 'verify'>('initial');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const { guard: sendGuard, isPending: sending } = useInFlightGuard();
  const { guard: verifyGuard, isPending: verifying } = useInFlightGuard();
  const { guard: resendGuard, isPending: resending } = useInFlightGuard();

  useEffect(() => {
    setStep('initial');
    setCode('');
    setError(null);
    setInfo(null);
  }, [email]);

  const startCooldown = () => {
    setResendCooldown(60);
    const interval = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const send = () =>
    sendGuard(async () => {
      setError(null);
      setInfo(null);
      try {
        const result = await onSendCode();
        if (result.success) {
          setStep('verify');
          startCooldown();
        } else {
          setError(result.message || 'Failed to send verification code.');
        }
      } catch (e: any) {
        setError(e?.message || 'Failed to send verification code.');
      }
    });

  const handleVerify = () =>
    verifyGuard(async () => {
      if (code.length !== 6) {
        setError('Please enter the 6-character code.');
        return;
      }
      setError(null);
      try {
        const result = await onVerifyCode(code);
        if (result.success) {
          onVerified();
        } else {
          setError(result.message || 'Invalid verification code.');
          setCode('');
        }
      } catch (e: any) {
        setError(e?.message || 'Failed to verify code.');
        setCode('');
      }
    });

  const handleResend = () =>
    resendGuard(async () => {
      if (resendCooldown > 0) return;
      setCode('');
      setError(null);
      try {
        const result = await onSendCode();
        if (result.success) {
          setInfo('A new code has been sent.');
          startCooldown();
        } else {
          setError(result.message || 'Failed to resend code.');
        }
      } catch (e: any) {
        setError(e?.message || 'Failed to resend code.');
      }
    });

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-start mb-4">
        <div className="w-10 h-10 bg-oe-light rounded-full flex items-center justify-center mr-3 flex-shrink-0">
          {step === 'initial' ? (
            <Mail className="h-5 w-5 text-oe-primary" />
          ) : (
            <CheckCircle className="h-5 w-5 text-oe-primary" />
          )}
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900">{heading}</h3>
          <p className="text-sm text-gray-600 mt-1">{description}</p>
        </div>
      </div>

      {step === 'initial' ? (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Email address</label>
          <div className="bg-gray-50 rounded-md px-3 py-2 mb-3">
            <span className="font-medium text-gray-900 break-all">{email}</span>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            The code expires in 10 minutes. If this email is wrong, please contact your agent to fix it.
          </p>

          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
            {allowSkip && (
              <button
                type="button"
                onClick={onSkip}
                className="px-4 py-2 border border-gray-300 text-gray-700 bg-white rounded-md hover:bg-gray-50 text-sm font-medium"
              >
                Skip for now
              </button>
            )}
            <button
              type="button"
              onClick={send}
              disabled={sending}
              className="px-4 py-2 bg-oe-primary hover:bg-oe-dark text-white rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending…' : 'Send Verification Code'}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <p className="text-sm text-gray-600 mb-1">We sent a 6-character code to:</p>
          <p className="font-medium text-gray-900 mb-1 break-all">{email}</p>
          <p className="text-xs text-gray-500 mb-4">Don't see it? Check your spam or junk folder.</p>

          <label className="block text-sm font-medium text-gray-700 mb-2">Verification code</label>
          <input
            type="text"
            value={code}
            onChange={(e) => {
              const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
              if (v.length <= 6) {
                setCode(v);
                setError(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && code.length === 6) handleVerify();
            }}
            maxLength={6}
            placeholder="ABC123"
            autoFocus
            className="w-full px-4 py-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-center text-2xl tracking-[0.5em] font-mono uppercase mb-3"
            autoComplete="one-time-code"
          />

          {info && (
            <div className="mb-3 p-3 bg-oe-light border border-oe-primary/20 rounded-md text-sm text-oe-dark">
              {info}
            </div>
          )}

          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="flex flex-col sm:flex-row gap-2 text-sm">
              {resendCooldown > 0 ? (
                <span className="text-gray-500">Resend in {resendCooldown}s</span>
              ) : (
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resending}
                  className="text-oe-primary hover:text-oe-dark text-left sm:text-center disabled:opacity-50"
                >
                  {resending ? 'Resending…' : 'Resend code'}
                </button>
              )}
            </div>
            <div className="flex flex-col-reverse sm:flex-row gap-2">
              {allowSkip && (
                <button
                  type="button"
                  onClick={onSkip}
                  className="px-4 py-2 border border-gray-300 text-gray-700 bg-white rounded-md hover:bg-gray-50 text-sm font-medium"
                >
                  Skip for now
                </button>
              )}
              <button
                type="button"
                onClick={handleVerify}
                disabled={verifying || code.length !== 6}
                className="px-4 py-2 bg-oe-primary hover:bg-oe-dark text-white rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {verifying ? 'Verifying…' : 'Verify'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EmailVerificationPanel;
