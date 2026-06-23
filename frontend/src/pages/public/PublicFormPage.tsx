import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiService } from '../../services/api.service';
import { useAuth } from '../../contexts/AuthContext';
import { PublicFormView } from '../../components/public/PublicFormView';
import { WhoIsThisForSelect, type HouseholdMemberOption } from '../../components/public/WhoIsThisForSelect';
import { SignInToSaveModal } from '../../components/public/SignInToSaveModal';
import { useFormDraft } from '../../hooks/member/useFormDraft';
import { mapPrefillToInitialValues } from './prefillMapping';
import type { FormDefinition } from '../../types/publicFormDefinition';
import type { PriorProvider } from '../../types/providerSearch';

export default function PublicFormPage() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading: authLoading, login: authLogin } = useAuth();
  const [leaveSaveOpen, setLeaveSaveOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  // Values the visitor typed while anonymous, preserved across mid-form sign-in.
  const anonValuesRef = useRef<Record<string, unknown>>({});
  const [postSignInSeed, setPostSignInSeed] = useState<Record<string, unknown> | null>(null);
  const [leaveSaving, setLeaveSaving] = useState(false);
  const [leaveSaveError, setLeaveSaveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [def, setDef] = useState<FormDefinition | null>(null);
  const [meta, setMeta] = useState<{ title: string; tenantName?: string; embedUrl?: string } | null>(
    null
  );

  // Signed-in autofill triggers for anyone who IS a member — whether Member is
  // their active role or just one of their roles (e.g. a GroupAdmin/Agent who is
  // also a Member). The backend scopes every prefill/draft call to the user's
  // own household, so this only ever fills their own family's data.
  const role = (user?.currentRole || user?.userType || '') as string;
  const hasMemberRole = Array.isArray(user?.roles) && user!.roles.includes('Member');
  const signedInMember = isAuthenticated && (role === 'Member' || hasMemberRole);
  const [household, setHousehold] = useState<HouseholdMemberOption[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<Record<string, string | null> | null>(null);
  const [priorProviders, setPriorProviders] = useState<PriorProvider[]>([]);

  // Draft autosave / resume / file staging (signed-in only).
  const draft = useFormDraft({
    enabled: signedInMember,
    formTemplateId: formId,
    forMemberId: selectedMemberId
  });

  // Load the signed-in member's household once, defaulting the selection to self.
  useEffect(() => {
    if (authLoading || !signedInMember) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{
          success: boolean;
          data?: { householdMembers: HouseholdMemberOption[] };
        }>('/api/me/member/household');
        if (cancelled || !res.success || !res.data) return;
        const members = res.data.householdMembers || [];
        setHousehold(members);
        const self = members.find((m) => m.IsCurrentUser === 1 || m.IsCurrentUser === true);
        setSelectedMemberId((self || members[0])?.MemberId ?? null);
      } catch {
        /* autofill is best-effort; ignore failures */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, signedInMember]);

  // Fetch the prefill payload for whichever household member is selected.
  useEffect(() => {
    if (!signedInMember || !selectedMemberId) return;
    let cancelled = false;
    setPrefill(null); // clear the previous person's data while the new one loads
    setPriorProviders([]);
    const mid = encodeURIComponent(selectedMemberId);
    (async () => {
      try {
        const res = await apiService.get<{
          success: boolean;
          data?: { prefill: Record<string, string | null> };
        }>(`/api/me/member/forms/prefill?memberId=${mid}`);
        if (cancelled || !res.success || !res.data) return;
        setPrefill(res.data.prefill);
      } catch {
        /* best-effort */
      }
    })();
    (async () => {
      try {
        const res = await apiService.get<{
          success: boolean;
          data?: { providers: PriorProvider[] };
        }>(`/api/me/member/forms/prior-providers?memberId=${mid}&formTemplateId=${encodeURIComponent(formId || '')}`);
        if (cancelled || !res.success || !res.data) return;
        setPriorProviders(res.data.providers || []);
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedInMember, selectedMemberId]);

  // Initial values = profile prefill, with a resumed draft (or values preserved
  // across a mid-form sign-in) layered on top.
  const initialValues = useMemo(() => {
    if (!def) return undefined;
    const base = prefill ? mapPrefillToInitialValues(def, prefill) : {};
    if (draft.resumedPayload) return { ...base, ...draft.resumedPayload };
    if (postSignInSeed) return { ...base, ...postSignInSeed };
    return prefill ? base : undefined;
  }, [def, prefill, draft.resumedPayload, postSignInSeed]);

  // After a mid-form sign-in, persist the preserved values as the first draft
  // once the member + selection have resolved, then clear the seed.
  useEffect(() => {
    if (!signedInMember || !selectedMemberId || !postSignInSeed) return;
    let cancelled = false;
    (async () => {
      try {
        await draft.saveValues(postSignInSeed);
      } catch {
        /* best-effort */
      } finally {
        if (!cancelled) setPostSignInSeed(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedInMember, selectedMemberId, postSignInSeed, draft]);

  // Whether to offer anonymous visitors the sign-in-to-save prompts (per-form).
  const offerSignIn = !signedInMember && !authLoading && def?.suggestSignIn !== false;

  // Exit-intent backstop: warn an anonymous visitor who's typed something before
  // they close/reload the tab (a custom modal can't render during unload). Only
  // when sign-in-to-save is on offer and they actually have unsaved input.
  useEffect(() => {
    if (!offerSignIn) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (Object.keys(anonValuesRef.current || {}).length === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [offerSignIn]);

  // In-app exit intent: pop the styled "sign in to save" modal (which the native
  // tab-close dialog can't be) when an anonymous visitor with unsaved input
  // moves the cursor up out of the viewport toward the tab/address bar — the
  // classic desktop "exit intent" signal. Shown at most once so it doesn't nag,
  // and only when they've actually entered something worth saving.
  const exitIntentShownRef = useRef(false);
  useEffect(() => {
    if (!offerSignIn) return;
    const onMouseOut = (e: MouseEvent) => {
      if (exitIntentShownRef.current || signInOpen) return;
      if (e.clientY > 0 || e.relatedTarget) return; // not a top-edge exit
      if (Object.keys(anonValuesRef.current || {}).length === 0) return;
      exitIntentShownRef.current = true;
      setSignInOpen(true);
    };
    document.addEventListener('mouseout', onMouseOut);
    return () => document.removeEventListener('mouseout', onMouseOut);
  }, [offerSignIn, signInOpen]);

  // The modal authenticates (OTP or password) and persists the session; here we
  // preserve the visitor's typed values, hydrate AuthContext so the form
  // re-renders signed-in, and close. The post-sign-in effect saves the
  // preserved values as the first draft.
  const handleAuthenticated = async (accessToken: string, refreshToken: string) => {
    setPostSignInSeed({ ...anonValuesRef.current });
    await authLogin(accessToken, refreshToken);
    setSignInOpen(false);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!formId) return;
      setLoading(true);
      setError(null);
      try {
        const res = await apiService.get<{
          success: boolean;
          data?: {
            title: string;
            tenantName?: string;
            definition: FormDefinition;
            embedUrl?: string;
          };
          message?: string;
        }>(`/api/public/forms/${formId}`);
        if (cancelled) return;
        if (!res.success || !res.data) {
          setError(res.message || 'Form not available');
          return;
        }
        setMeta({
          title: res.data.title,
          tenantName: res.data.tenantName,
          embedUrl: res.data.embedUrl
        });
        setDef(res.data.definition);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load form');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [formId]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-600">Loading form…</p>
      </div>
    );
  }

  if (error && !def) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <p className="text-red-700 text-center">{error}</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-lg w-full bg-white shadow rounded-lg p-8 text-center border-2 border-emerald-200">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 text-3xl">
            ✓
          </div>
          <h1 className="text-2xl font-semibold text-slate-900 mb-2">Submission received</h1>
          <p className="text-slate-600 mb-1">
            Thanks for your submission — we've got it on file.
          </p>
          <p className="text-slate-500 text-sm">
            If you do not hear from us within a few business days, please contact support.
          </p>
        </div>
      </div>
    );
  }

  if (!def || !formId) {
    return null;
  }

  const topBanner = signedInMember ? (
    <div>
      <WhoIsThisForSelect
        members={household}
        selectedMemberId={selectedMemberId}
        onChange={setSelectedMemberId}
      />
      {draft.resumedPayload && (
        <p className="mb-3 text-xs text-oe-dark">We picked up where you left off — your saved progress is loaded.</p>
      )}
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={() => setLeaveSaveOpen(true)}
          className="text-sm border border-gray-300 text-gray-700 bg-white rounded px-3 py-1.5 hover:bg-gray-50"
        >
          Leave &amp; save
        </button>
      </div>
    </div>
  ) : offerSignIn ? (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-oe-light bg-oe-light/30 p-3">
      <p className="text-sm text-oe-dark">
        Have an account?{' '}
        <span className="text-slate-600">Sign in to autofill your details and save your progress.</span>
      </p>
      <button
        type="button"
        onClick={() => setSignInOpen(true)}
        className="text-sm bg-oe-primary hover:bg-oe-dark text-white rounded px-3 py-1.5"
      >
        Sign in to save
      </button>
    </div>
  ) : undefined;

  return (
    <div className="min-h-screen bg-slate-100 py-6 px-2 sm:px-4 md:py-10 md:px-6">
      <PublicFormView
        key={
          signedInMember
            ? `${selectedMemberId ?? 'self'}-${prefill ? 'p' : '0'}-${draft.resumedPayload ? 'd' : '0'}`
            : 'anon'
        }
        // ^ remounts to re-seed fields when the resumed draft is applied.
        definition={def}
        pageTitle={meta?.title ?? ''}
        tenantName={meta?.tenantName}
        formId={formId}
        initialValues={initialValues}
        onValuesChange={
          offerSignIn
            ? (v: Record<string, unknown>) => {
                anonValuesRef.current = v;
              }
            : undefined
        }
        priorProviders={signedInMember ? priorProviders : undefined}
        draft={signedInMember ? draft.bundle : undefined}
        topBanner={topBanner}
        onSubmitSuccess={() => setDone(true)}
      />

      {draft.pendingResume && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-lg">
            <h2 className="text-lg font-semibold text-slate-900">Resume where you left off?</h2>
            <p className="mt-2 text-sm text-slate-600">
              You have a saved draft of this form
              {draft.pendingResume.updatedDate
                ? ` from ${new Date(draft.pendingResume.updatedDate).toLocaleDateString()}`
                : ''}
              {draft.pendingResume.files.length > 0
                ? ` (including ${draft.pendingResume.files.length} uploaded file${
                    draft.pendingResume.files.length === 1 ? '' : 's'
                  })`
                : ''}
              . Resume it, or start a new form — starting over permanently deletes the saved draft.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => draft.discardDraft()}
                className="text-sm border border-gray-300 text-gray-700 bg-white rounded px-3 py-1.5 hover:bg-gray-50"
              >
                Start over
              </button>
              <button
                type="button"
                onClick={() => draft.resumeDraft()}
                className="text-sm bg-oe-primary hover:bg-oe-dark text-white rounded px-3 py-1.5"
              >
                Resume
              </button>
            </div>
          </div>
        </div>
      )}

      {leaveSaveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-lg">
            <h2 className="text-lg font-semibold text-slate-900">Save and leave?</h2>
            <p className="mt-2 text-sm text-slate-600">
              We'll save your progress so you can return anytime from your account and pick up right
              where you left off.
            </p>
            {leaveSaveError && <p className="mt-2 text-sm text-red-600">{leaveSaveError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setLeaveSaveError(null);
                  setLeaveSaveOpen(false);
                }}
                disabled={leaveSaving}
                className="text-sm border border-gray-300 text-gray-700 bg-white rounded px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50"
              >
                Keep editing
              </button>
              <button
                type="button"
                disabled={leaveSaving}
                onClick={async () => {
                  setLeaveSaveError(null);
                  setLeaveSaving(true);
                  try {
                    await draft.flush();
                    navigate('/');
                  } catch (e) {
                    setLeaveSaveError(
                      e instanceof Error ? e.message : 'Could not save your progress. Please try again.'
                    );
                  } finally {
                    setLeaveSaving(false);
                  }
                }}
                className="text-sm bg-oe-primary hover:bg-oe-dark text-white rounded px-3 py-1.5 disabled:opacity-50"
              >
                {leaveSaving ? 'Saving…' : 'Save & leave'}
              </button>
            </div>
          </div>
        </div>
      )}

      <SignInToSaveModal
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        onAuthenticated={handleAuthenticated}
      />
    </div>
  );
}
