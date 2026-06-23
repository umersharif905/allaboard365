import { useState, type FormEvent } from 'react';
import { X, CheckCircle2, Loader2 } from 'lucide-react';
import { authService } from '../../services/auth.service';

type Mode = 'otp' | 'password';

/**
 * Inline "sign in to save your progress" modal for the public form. Mirrors the
 * main login page: a one-time code (email/SMS) by default, with a password
 * fallback. Both paths persist the session via authService; the parent then
 * hydrates AuthContext so the form switches to signed-in mode (autofill +
 * drafts) with the visitor's typed values preserved.
 */
export function SignInToSaveModal({
  open,
  onClose,
  onAuthenticated
}: {
  open: boolean;
  onClose: () => void;
  /** Called after the session is persisted, with the issued tokens. */
  onAuthenticated: (accessToken: string, refreshToken: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>('otp');
  const [identifier, setIdentifier] = useState(''); // email or phone
  const [password, setPassword] = useState('');
  const [keepMeSignedIn, setKeepMeSignedIn] = useState(true);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Shows a "Signed in ✓" confirmation while the parent hydrates the session,
  // so the modal never just vanishes (or silently hangs) after a sign-in.
  const [succeeded, setSucceeded] = useState(false);
  // When one email/phone maps to several portal accounts (e.g. an Agent who is
  // also a Member), the backend returns the list instead of sending a code. We
  // show a picker; choosing one re-requests the OTP scoped to that userId. The
  // main login page does the same — without this branch the modal dead-ends.
  const [accountChoices, setAccountChoices] = useState<{ userId: string; label: string }[]>([]);

  if (!open) return null;

  // Request an OTP, optionally scoped to a chosen account (userId). Returns the
  // result so callers can react; surfaces the account-choice list when the
  // identifier is ambiguous.
  const sendOtp = async (userId?: string) => {
    if (submitting) return;
    setError(null);
    setNotice(null);
    if (!userId && !identifier.trim()) {
      setError('Enter your email or phone number.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await authService.requestLoginOtpPortal({
        identifier: identifier.trim() || undefined,
        channel: 'auto',
        userId
      });
      if (result.needsAccountChoice && result.accountChoices?.length) {
        setAccountChoices(result.accountChoices);
        return;
      }
      if (!result.codeSent || !result.challengeId) {
        throw new Error(result.message || 'Unable to send sign-in code.');
      }
      setAccountChoices([]);
      setChallengeId(result.challengeId);
      setNotice(
        result.maskedDestination
          ? `We sent a 6-digit code to ${result.maskedDestination}.`
          : 'We sent you a 6-digit code.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send your code. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const requestOtp = async (e: FormEvent) => {
    e.preventDefault();
    await sendOtp();
  };

  const verifyOtp = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting || !challengeId) return;
    setError(null);
    const digits = code.replace(/\D/g, '');
    if (digits.length < 6) {
      setError('Enter the 6-digit code.');
      return;
    }
    setSubmitting(true);
    try {
      // verifyLoginOtpPortal persists the session and returns the tokens.
      const data = await authService.verifyLoginOtpPortal({ challengeId, code: digits, keepMeSignedIn });
      if (!data.accessToken || !data.refreshToken) throw new Error('Sign in failed. Please try again.');
      setSucceeded(true);
      await onAuthenticated(data.accessToken, data.refreshToken);
    } catch (err) {
      setSucceeded(false);
      setError(err instanceof Error ? err.message : 'Invalid or expired code.');
      setSubmitting(false);
    }
  };

  const passwordSignIn = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await authService.login(identifier.trim(), password, keepMeSignedIn);
      const data = res?.data;
      if (!data?.accessToken || !data?.refreshToken) throw new Error('Sign in failed. Please try again.');
      setSucceeded(true);
      await onAuthenticated(data.accessToken, data.refreshToken);
    } catch (err) {
      setSucceeded(false);
      setError(err instanceof Error ? err.message : 'Invalid email or password.');
      setSubmitting(false);
    }
  };

  const inputCls = 'mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-2 mb-1">
          <h2 className="text-lg font-semibold text-slate-900">Sign in to save your progress</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            disabled={submitting}
            className="text-gray-400 hover:text-gray-600 rounded p-0.5 disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="text-sm text-slate-600 mb-4">
          Sign in and we'll save what you've entered so you can finish later — and fill in your
          details automatically.
        </p>

        {succeeded ? (
          <div className="flex flex-col items-center text-center py-6">
            <CheckCircle2 className="h-12 w-12 text-oe-success mb-3" />
            <p className="text-base font-semibold text-slate-900">Signed in successfully</p>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading your information…
            </p>
          </div>
        ) : mode === 'otp' ? (
          accountChoices.length > 0 && !challengeId ? (
            <div className="space-y-3">
              <p className="text-sm text-slate-700">
                Multiple accounts match. Choose yours to continue.
              </p>
              <div className="space-y-2">
                {accountChoices.map((c) => (
                  <button
                    key={c.userId}
                    type="button"
                    disabled={submitting}
                    onClick={() => sendOtp(c.userId)}
                    className="w-full text-left text-sm border border-gray-300 rounded px-3 py-2 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="button"
                onClick={() => {
                  setAccountChoices([]);
                  setError(null);
                  setNotice(null);
                }}
                disabled={submitting}
                className="mt-1 text-xs text-oe-primary hover:underline disabled:opacity-50"
              >
                Use a different email/phone
              </button>
            </div>
          ) : !challengeId ? (
            <form onSubmit={requestOtp} className="space-y-3">
              <label className="block text-sm">
                <span className="text-gray-700">Email or phone</span>
                <input
                  type="text"
                  autoComplete="username"
                  required
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  className={inputCls}
                />
              </label>
              {notice && <p className="text-sm text-oe-dark">{notice}</p>}
              {error && <p className="text-sm text-red-600">{error}</p>}
              <ModalActions
                submitting={submitting}
                submitLabel={submitting ? 'Sending…' : 'Email/text me a code'}
                onCancel={onClose}
                altLabel="Use a password instead"
                onAlt={() => { setMode('password'); setError(null); setNotice(null); setAccountChoices([]); }}
              />
            </form>
          ) : (
            <form onSubmit={verifyOtp} className="space-y-3">
              <label className="block text-sm">
                <span className="text-gray-700">Enter the 6-digit code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className={inputCls}
                />
              </label>
              {notice && <p className="text-sm text-oe-dark">{notice}</p>}
              {error && <p className="text-sm text-red-600">{error}</p>}
              <ModalActions
                submitting={submitting}
                submitLabel={submitting ? 'Verifying…' : 'Verify & save'}
                onCancel={onClose}
                altLabel="Use a different email/phone"
                onAlt={() => { setChallengeId(null); setCode(''); setError(null); setNotice(null); setAccountChoices([]); }}
              />
            </form>
          )
        ) : (
          <form onSubmit={passwordSignIn} className="space-y-3">
            <label className="block text-sm">
              <span className="text-gray-700">Email</span>
              <input
                type="email"
                autoComplete="email"
                required
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className={inputCls}
              />
            </label>
            <label className="block text-sm">
              <span className="text-gray-700">Password</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={keepMeSignedIn}
                onChange={(e) => setKeepMeSignedIn(e.target.checked)}
              />
              Keep me signed in
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <ModalActions
              submitting={submitting}
              submitLabel={submitting ? 'Signing in…' : 'Sign in & save'}
              onCancel={onClose}
              altLabel="Email me a one-time code instead"
              onAlt={() => { setMode('otp'); setError(null); setNotice(null); setAccountChoices([]); }}
            />
          </form>
        )}
      </div>
    </div>
  );
}

function ModalActions({
  submitting,
  submitLabel,
  onCancel,
  altLabel,
  onAlt
}: {
  submitting: boolean;
  submitLabel: string;
  onCancel: () => void;
  altLabel: string;
  onAlt: () => void;
}) {
  return (
    <div className="pt-1">
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="text-sm border border-gray-300 text-gray-700 bg-white rounded px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="text-sm bg-oe-primary hover:bg-oe-dark text-white rounded px-3 py-1.5 disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
      <button
        type="button"
        onClick={onAlt}
        disabled={submitting}
        className="mt-2 text-xs text-oe-primary hover:underline disabled:opacity-50"
      >
        {altLabel}
      </button>
    </div>
  );
}
