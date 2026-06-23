import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { apiService, withTenantScope } from '../../../services/api.service';
import { LinkagePicker, type OpenShareRequest } from './LinkagePicker';
import { copyToClipboard } from '../../../utils/clipboard';

type MemberHit = {
  MemberId: string;
  FirstName: string | null;
  LastName: string | null;
  Email: string | null;
  Phone?: string | null;
  HouseholdMemberID?: string | null;
};

type DeliveryMode = 'targeted' | 'authenticated';
type DeliveryMethod = 'email' | 'copy' | 'both';

export type SendToMemberModalProps = {
  open: boolean;
  onClose: () => void;
  apiBase: string;
  membersApiBase: string;
  tenantId: string;
  template: {
    FormTemplateId: string;
    Title: string;
    /** SQL BIT — server may deliver as boolean or 0/1. */
    AllowTargeted?: boolean | number | null;
    AllowAuthenticated?: boolean | number | null;
    AllowAnonymous?: boolean | number | null;
    IsPublished?: boolean | number | null;
  };
};

type Step = 1 | 2 | 3 | 4;

export function SendToMemberModal({
  open,
  onClose,
  apiBase,
  membersApiBase,
  tenantId,
  template
}: SendToMemberModalProps) {
  const tenantReq = useMemo(() => withTenantScope(tenantId), [tenantId]);
  const allowTargeted = Boolean(template.AllowTargeted);
  const allowAuthenticated = Boolean(template.AllowAuthenticated);

  // If only one mode is enabled, step 2 is automatic.
  const onlyOneMode = allowTargeted !== allowAuthenticated;
  const defaultMode: DeliveryMode = allowAuthenticated ? 'authenticated' : 'targeted';

  const allowAnonymous = template.AllowAnonymous == null || Boolean(template.AllowAnonymous);
  const [anonymousMode, setAnonymousMode] = useState(false);
  const [anonRecipient, setAnonRecipient] = useState('');
  const [anonMessage, setAnonMessage] = useState('');
  const [anonSending, setAnonSending] = useState(false);
  const [anonSentTo, setAnonSentTo] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<MemberHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [member, setMember] = useState<MemberHit | null>(null);
  const [mode, setMode] = useState<DeliveryMode>(defaultMode);
  const [openSrs, setOpenSrs] = useState<OpenShareRequest[]>([]);
  const [linkedShareRequestId, setLinkedShareRequestId] = useState<string | null>(null);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>('email');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset state every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setSearch('');
    setHits([]);
    setMember(null);
    setMode(defaultMode);
    setOpenSrs([]);
    setLinkedShareRequestId(null);
    setRecipientEmail('');
    setDeliveryMethod('email');
    setError(null);
    setResultUrl(null);
    setCopied(false);
    setAnonymousMode(false);
    setAnonRecipient('');
    setAnonMessage('');
    setAnonSending(false);
    setAnonSentTo(null);
  }, [open, defaultMode]);

  const submitAnonymous = useCallback(async () => {
    setError(null);
    const to = anonRecipient.trim();
    if (!to || !/^.+@.+\..+$/.test(to)) {
      setError('Enter a valid recipient email.');
      return;
    }
    setAnonSending(true);
    try {
      const res = await apiService.post<{ success: boolean; message?: string }>(
        `${apiBase}/templates/${template.FormTemplateId}/send-anonymous-link`,
        { recipientEmail: to, message: anonMessage.trim() || undefined },
        tenantReq
      );
      if (!res.success) {
        setError(res.message || 'Email send failed');
        return;
      }
      setAnonSentTo(to);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Email send failed');
    } finally {
      setAnonSending(false);
    }
  }, [apiBase, template.FormTemplateId, anonRecipient, anonMessage, tenantReq]);

  // Debounced member search.
  useEffect(() => {
    if (!open || step !== 1) return;
    const q = search.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiService.get<{ success: boolean; data: MemberHit[] }>(
          `${membersApiBase}/search?q=${encodeURIComponent(q)}&limit=20`,
          tenantReq
        );
        if (!cancelled && res.success) setHits(res.data || []);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, step, search, membersApiBase, tenantReq]);

  const pickMember = useCallback(
    async (m: MemberHit) => {
      setMember(m);
      setRecipientEmail(m.Email || '');
      // Open SRs fetched lazily by the extracted LinkagePicker; the picker
      // syncs them back via onShareRequestsLoaded so step 4 can render the
      // selected request number.
      setStep(onlyOneMode ? 3 : 2);
    },
    [onlyOneMode]
  );

  const submit = useCallback(async () => {
    if (!member) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiService.post<{
        success: boolean;
        data?: { invitationId: string; url: string; expiresAt: string };
        message?: string;
      }>(
        `${apiBase}/templates/${template.FormTemplateId}/invitations`,
        {
          memberId: member.MemberId,
          mode,
          linkedShareRequestId: linkedShareRequestId || null,
          linkedCaseId: null,
          recipientEmail: recipientEmail.trim(),
          deliveryMethod
        },
        tenantReq
      );
      if (!res.success || !res.data?.url) {
        setError(res.message || 'Send failed');
        return;
      }
      setResultUrl(res.data.url);
      if (deliveryMethod === 'copy' || deliveryMethod === 'both') {
        const ok = await copyToClipboard(res.data.url);
        if (ok) setCopied(true);
        // If both modern + legacy paths fail, the URL is still visible
        // below for manual copy.
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSubmitting(false);
    }
  }, [apiBase, template.FormTemplateId, member, mode, linkedShareRequestId, recipientEmail, deliveryMethod, tenantReq]);

  if (!open) return null;

  const memberName = member ? `${member.FirstName || ''} ${member.LastName || ''}`.trim() : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-gray-900/50"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        className="relative z-10 flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
          <h2 className="text-lg font-semibold text-gray-900">
            Send “{template.Title || 'form'}” to a member
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-gray-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
          {resultUrl ? (
            <div className="space-y-3">
              <p className="text-sm text-oe-success font-medium">Invitation created.</p>
              {deliveryMethod !== 'copy' && (
                <p className="text-sm text-gray-700">
                  An email with the form link was sent to{' '}
                  <span className="font-medium">{recipientEmail}</span>.
                </p>
              )}
              <div className="space-y-1">
                <p className="text-xs text-gray-600">Recipient URL</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded bg-gray-100 px-2 py-1 text-xs text-gray-800">
                    {resultUrl}
                  </code>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await copyToClipboard(resultUrl);
                      if (ok) setCopied(true);
                    }}
                    className="shrink-0 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-dark"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              {!anonymousMode && <StepIndicator step={step} onlyOneMode={onlyOneMode} />}

              {/* STEP 1 — Pick member */}
              {/* Public-link mode: not the "send to member" flow — emails the
                  form's public link to a recipient without creating an
                  invitation. Only available when the template allows the public mode. */}
              {anonymousMode && (
                <div className="space-y-3">
                  {anonSentTo ? (
                    <div className="space-y-3">
                      <p className="text-sm text-oe-success font-medium">
                        Public link sent to {anonSentTo}.
                      </p>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={onClose}
                          className="rounded bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-dark"
                        >
                          Done
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-gray-700">
                        Email the form&apos;s public link to a recipient. No invitation,
                        no token — anyone with the URL can fill it out.
                      </p>
                      <label className="block text-sm">
                        <span className="text-gray-700 font-medium">Recipient email</span>
                        <input
                          type="email"
                          className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                          placeholder="name@example.com"
                          value={anonRecipient}
                          onChange={(e) => setAnonRecipient(e.target.value)}
                          autoFocus
                        />
                      </label>
                      <label className="block text-sm">
                        <span className="text-gray-700 font-medium">
                          Message (optional)
                        </span>
                        <textarea
                          rows={3}
                          className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                          placeholder="Add a short note to include in the email."
                          value={anonMessage}
                          onChange={(e) => setAnonMessage(e.target.value)}
                        />
                      </label>
                      {error && <p className="text-sm text-red-700">{error}</p>}
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setAnonymousMode(false)}
                          className="text-sm text-gray-600 hover:underline"
                        >
                          Back to send-to-member
                        </button>
                        <button
                          type="button"
                          onClick={submitAnonymous}
                          disabled={anonSending}
                          className="rounded bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-dark disabled:opacity-50"
                        >
                          {anonSending ? 'Sending…' : 'Send public link'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {!anonymousMode && step === 1 && (
                <div className="space-y-3">
                  {allowAnonymous && Boolean(template.IsPublished) && (
                    <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs flex items-center justify-between gap-3">
                      <span className="text-gray-700">
                        Don&apos;t need it pinned to a member? Send the public link
                        instead.
                      </span>
                      <button
                        type="button"
                        onClick={() => setAnonymousMode(true)}
                        className="shrink-0 text-oe-primary hover:underline"
                      >
                        Switch to public link
                      </button>
                    </div>
                  )}
                  <label className="block text-sm">
                    <span className="text-gray-700 font-medium">Pick member</span>
                    <div className="relative mt-1">
                      <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <input
                        type="text"
                        className="w-full rounded border border-gray-300 px-8 py-2 text-sm"
                        placeholder="Search by name, email, or member ID"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        autoFocus
                      />
                    </div>
                  </label>
                  <div className="rounded border border-gray-200 bg-white">
                    {searching ? (
                      <p className="px-3 py-2 text-xs text-gray-500">Searching…</p>
                    ) : hits.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-gray-500">
                        {search.trim().length < 2
                          ? 'Type at least 2 characters.'
                          : 'No matches.'}
                      </p>
                    ) : (
                      <ul className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
                        {hits.map((h) => (
                          <li key={h.MemberId}>
                            <button
                              type="button"
                              onClick={() => pickMember(h)}
                              className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                            >
                              <span className="font-medium text-gray-900">
                                {h.FirstName} {h.LastName}
                              </span>
                              <span className="ml-2 text-xs text-gray-500">
                                {h.HouseholdMemberID || '—'} · {h.Email || 'no email'}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}

              {/* STEP 2 — Pick mode */}
              {step === 2 && member && (
                <div className="space-y-3">
                  <p className="text-sm text-gray-700">
                    Send to{' '}
                    <span className="font-medium">
                      {memberName} ({member.Email || 'no email on file'})
                    </span>
                  </p>
                  <div className="space-y-2">
                    {allowAuthenticated && (
                      <label className="flex items-start gap-2 rounded border border-gray-200 p-2 hover:bg-gray-50 cursor-pointer">
                        <input
                          type="radio"
                          name="deliveryMode"
                          className="mt-1"
                          checked={mode === 'authenticated'}
                          onChange={() => setMode('authenticated')}
                        />
                        <span className="text-sm">
                          <span className="font-medium text-gray-800">
                            Secure link (requires login)
                          </span>
                          <span className="block text-xs text-gray-500">
                            Recipient must log in. Profile fields prefill from their account.
                            Best for PHI.
                          </span>
                        </span>
                      </label>
                    )}
                    {allowTargeted && (
                      <label className="flex items-start gap-2 rounded border border-gray-200 p-2 hover:bg-gray-50 cursor-pointer">
                        <input
                          type="radio"
                          name="deliveryMode"
                          className="mt-1"
                          checked={mode === 'targeted'}
                          onChange={() => setMode('targeted')}
                        />
                        <span className="text-sm">
                          <span className="font-medium text-gray-800">
                            Personal link (no login)
                          </span>
                          <span className="block text-xs text-gray-500">
                            Recipient gets a signed link. No login needed. Best for short
                            non-PHI forms.
                          </span>
                        </span>
                      </label>
                    )}
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="text-sm text-gray-600 hover:underline"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={() => setStep(3)}
                      className="rounded bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-dark"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 3 — Optional linkage */}
              {step === 3 && member && (
                <div className="space-y-3">
                  <p className="text-sm text-gray-700">
                    Link this submission to an open share request or case (optional).
                  </p>
                  <LinkagePicker
                    memberId={member.MemberId}
                    membersApiBase={membersApiBase}
                    tenantReq={tenantReq}
                    selectedShareRequestId={linkedShareRequestId}
                    selectedCaseId={null}
                    onChange={(srId) => setLinkedShareRequestId(srId)}
                    onShareRequestsLoaded={setOpenSrs}
                  />
                  <div className="flex items-center justify-between pt-1">
                    <button
                      type="button"
                      onClick={() => setStep(onlyOneMode ? 1 : 2)}
                      className="text-sm text-gray-600 hover:underline"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={() => setStep(4)}
                      className="rounded bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-dark"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 4 — Recipient email + method + confirm */}
              {step === 4 && member && (
                <div className="space-y-3">
                  <label className="block text-sm">
                    <span className="text-gray-700 font-medium">Recipient email</span>
                    <input
                      type="email"
                      className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                      value={recipientEmail}
                      onChange={(e) => setRecipientEmail(e.target.value)}
                    />
                  </label>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium text-gray-700">Delivery</legend>
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="deliveryMethod"
                        className="mt-1"
                        checked={deliveryMethod === 'email'}
                        onChange={() => setDeliveryMethod('email')}
                      />
                      <span>
                        Email link to recipient{' '}
                        <span className="block text-xs text-gray-500">
                          We send the recipient the URL. No clipboard copy.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="deliveryMethod"
                        className="mt-1"
                        checked={deliveryMethod === 'copy'}
                        onChange={() => setDeliveryMethod('copy')}
                      />
                      <span>
                        Copy link only — no email{' '}
                        <span className="block text-xs text-gray-500">
                          We create the invitation; you copy the URL and share it yourself.
                        </span>
                      </span>
                    </label>
                  </fieldset>
                  <div className="rounded bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-700 space-y-1">
                    <p>
                      <span className="text-gray-500">Form:</span> {template.Title}
                    </p>
                    <p>
                      <span className="text-gray-500">Member:</span> {memberName} ·{' '}
                      {member.HouseholdMemberID || '—'}
                    </p>
                    <p>
                      <span className="text-gray-500">Mode:</span>{' '}
                      {mode === 'authenticated' ? 'Secure (requires login)' : 'Personal (no login)'}
                    </p>
                    <p>
                      <span className="text-gray-500">Linked share request:</span>{' '}
                      {linkedShareRequestId
                        ? openSrs.find((s) => s.ShareRequestId === linkedShareRequestId)
                            ?.RequestNumber || linkedShareRequestId
                        : 'None'}
                    </p>
                  </div>
                  {error && <p className="text-sm text-red-700">{error}</p>}
                  <div className="flex items-center justify-between pt-1">
                    <button
                      type="button"
                      onClick={() => setStep(3)}
                      className="text-sm text-gray-600 hover:underline"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={submit}
                      disabled={submitting || !recipientEmail.trim()}
                      className="rounded bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-dark disabled:opacity-50"
                    >
                      {submitting ? 'Sending…' : deliveryMethod === 'copy' ? 'Create link' : 'Send'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StepIndicator({ step, onlyOneMode }: { step: Step; onlyOneMode: boolean }) {
  const labels = onlyOneMode
    ? ['Member', 'Linkage', 'Send']
    : ['Member', 'Mode', 'Linkage', 'Send'];
  // Map internal step (1..4) to the visible index when mode is skipped.
  const visibleIndex = onlyOneMode
    ? step === 1
      ? 0
      : step === 3
        ? 1
        : 2
    : step - 1;
  return (
    <ol className="flex items-center gap-2 text-xs text-gray-500">
      {labels.map((l, i) => {
        const active = i === visibleIndex;
        const done = i < visibleIndex;
        return (
          <li key={l} className="flex items-center gap-2">
            <span
              className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${
                active
                  ? 'bg-oe-primary text-white'
                  : done
                    ? 'bg-oe-light text-oe-dark'
                    : 'bg-gray-100 text-gray-600'
              }`}
            >
              {i + 1}
            </span>
            <span className={active ? 'text-gray-900 font-medium' : ''}>{l}</span>
            {i < labels.length - 1 && <span className="text-gray-300">→</span>}
          </li>
        );
      })}
    </ol>
  );
}
