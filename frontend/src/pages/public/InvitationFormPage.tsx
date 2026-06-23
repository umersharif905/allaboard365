// /forms/i/:token — recipient entry point for the "send to member" invitation flow.
//
// Order of operations:
//   1. Call /api/public/forms/invitations/:token/meta. The meta endpoint returns
//      ONLY { mode, formTitle, expiresAt, exists } — no recipient identity
//      anywhere in this pre-flight.
//   2. Branch on `mode`:
//      - `targeted` → load the full anonymous targeted endpoint
//        (/api/public/forms/invitations/:token), render the form with the
//        recipient greeting block at the top.
//      - `authenticated` → require a logged-in Member session. If not
//        logged in, redirect to /login?returnTo=/forms/i/:token. If logged
//        in but not as Member, show a friendly mismatch screen.
//      - any failure (410 / 409) → render the generic "link no longer valid"
//        screen with no oracle on the underlying reason.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiService } from '../../services/api.service';
import { useAuth } from '../../contexts/AuthContext';
import { PublicFormView } from '../../components/public/PublicFormView';
import { WhoIsThisForSelect, type HouseholdMemberOption } from '../../components/public/WhoIsThisForSelect';
import type { FormDefinition } from '../../types/publicFormDefinition';
import { mapPrefillToInitialValues } from './prefillMapping';

type MetaResponse = {
  success: boolean;
  data?: { exists: boolean; mode: 'targeted' | 'authenticated'; formTitle: string; expiresAt: string };
  message?: string;
};

type TargetedResponse = {
  success: boolean;
  data?: {
    formTitle: string;
    formDefinition: FormDefinition;
    greeting: { firstName: string | null; sentToEmail: string };
    expiresAt: string;
    invitationId: string;
  };
  message?: string;
};

type AuthenticatedResponse = {
  success: boolean;
  data?: {
    formTitle: string;
    formDefinition: FormDefinition;
    prefill: Record<string, string | null>;
    expiresAt: string;
    invitationId: string;
    forMemberId: string;
  };
  message?: string;
};

function LinkInvalid({ message }: { message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="max-w-md w-full bg-white shadow rounded-lg p-8 text-center border border-slate-200">
        <h1 className="text-xl font-semibold text-slate-900 mb-2">Link unavailable</h1>
        <p className="text-slate-600">{message}</p>
        <p className="text-slate-500 text-sm mt-4">
          Contact your care team to request a new link.
        </p>
      </div>
    </div>
  );
}

function FormSent() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="max-w-lg w-full bg-white shadow rounded-lg p-8 text-center border-2 border-emerald-200">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 text-3xl">
          ✓
        </div>
        <h1 className="text-2xl font-semibold text-slate-900 mb-2">Submission received</h1>
        <p className="text-slate-600">
          Thanks. Your care team has your submission on file.
        </p>
      </div>
    </div>
  );
}

export default function InvitationFormPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [meta, setMeta] = useState<MetaResponse['data'] | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [targeted, setTargeted] = useState<TargetedResponse['data'] | null>(null);
  const [authResp, setAuthResp] = useState<AuthenticatedResponse['data'] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Authenticated-invitation "Who is this for?" — lets the signed-in primary
  // file for a household member (spouse/child) instead of always the invitation
  // recipient. Defaults to the invitation's own member.
  const [household, setHousehold] = useState<HouseholdMemberOption[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [overridePrefill, setOverridePrefill] = useState<Record<string, string | null> | null>(null);

  // 1. Fetch meta to decide which flow to run.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setMetaError(null);
      try {
        const res = await apiService.get<MetaResponse>(
          `/api/public/forms/invitations/${token}/meta`
        );
        if (cancelled) return;
        if (!res.success || !res.data?.exists) {
          setMetaError(res.message || 'This link is no longer valid.');
        } else {
          setMeta(res.data);
        }
      } catch {
        if (!cancelled) setMetaError('This link is no longer valid.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const role = (user?.currentRole || user?.userType || '') as string;

  // 2a. Targeted-mode loader.
  useEffect(() => {
    if (!token || !meta || meta.mode !== 'targeted') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<TargetedResponse>(`/api/public/forms/invitations/${token}`);
        if (cancelled) return;
        if (!res.success || !res.data) {
          setLoadError(res.message || 'This link is no longer valid.');
          return;
        }
        setTargeted(res.data);
      } catch {
        if (!cancelled) setLoadError('This link is no longer valid.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, meta]);

  // 2b. Authenticated-mode loader (only runs once we're sure the user is a Member).
  useEffect(() => {
    if (!token || !meta || meta.mode !== 'authenticated') return;
    if (authLoading) return;
    if (!isAuthenticated) {
      const target = `/forms/i/${token}`;
      navigate(`/login?returnTo=${encodeURIComponent(target)}`, { replace: true });
      return;
    }
    if (role !== 'Member') return; // friendly mismatch screen renders below
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<AuthenticatedResponse>(
          `/api/me/member/forms/invitations/${token}`
        );
        if (cancelled) return;
        if (!res.success || !res.data) {
          setLoadError(res.message || 'This form is not associated with your account.');
          return;
        }
        setAuthResp(res.data);
      } catch (e: unknown) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : 'This form is not associated with your account.';
          setLoadError(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, meta, authLoading, isAuthenticated, role, navigate]);

  // Default the member selection to the invitation's recipient once loaded.
  useEffect(() => {
    if (authResp?.forMemberId) setSelectedMemberId(authResp.forMemberId);
  }, [authResp?.forMemberId]);

  // Load the signed-in member's household so the primary can pick a dependent.
  useEffect(() => {
    if (!authResp) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{
          success: boolean;
          data?: { householdMembers: HouseholdMemberOption[] };
        }>('/api/me/member/household');
        if (!cancelled && res.success && res.data) setHousehold(res.data.householdMembers || []);
      } catch {
        /* best-effort; selector just won't render */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authResp]);

  // When the primary picks a different household member, fetch that member's
  // prefill (server re-derives + re-authorizes on submit regardless).
  useEffect(() => {
    if (!authResp || !selectedMemberId) return;
    if (selectedMemberId === authResp.forMemberId) {
      setOverridePrefill(null); // use the invitation's own prefill
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{
          success: boolean;
          data?: { prefill: Record<string, string | null> };
        }>(`/api/me/member/forms/prefill?memberId=${encodeURIComponent(selectedMemberId)}`);
        if (!cancelled && res.success && res.data) setOverridePrefill(res.data.prefill);
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authResp, selectedMemberId]);

  const onSubmitSuccess = useCallback(() => setDone(true), []);

  if (done) {
    return <FormSent />;
  }

  if (loading || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-600">Loading…</p>
      </div>
    );
  }

  if (metaError) {
    return <LinkInvalid message={metaError} />;
  }

  if (loadError) {
    return <LinkInvalid message={loadError} />;
  }

  if (!meta) {
    return null;
  }

  // Pre-login marketing screen for authenticated invitations: we already
  // redirected unauthenticated users above, so this only renders for users
  // who ARE logged in but not as a Member.
  if (meta.mode === 'authenticated' && isAuthenticated && role !== 'Member') {
    return (
      <LinkInvalid message="This link is for a member account. Please log out and log in with the member account." />
    );
  }

  // ───── targeted (no-login) flow ─────────────────────────────────────────────
  if (meta.mode === 'targeted') {
    if (!targeted || !token) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50">
          <p className="text-slate-600">Loading…</p>
        </div>
      );
    }
    const firstName = targeted.greeting.firstName || 'there';
    const banner = (
      <div className="mb-6 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
        <p>
          This form is for you,{' '}
          <span className="font-medium">{firstName}</span> (
          <span className="font-mono">{targeted.greeting.sentToEmail}</span>).
        </p>
      </div>
    );
    return (
      <div className="min-h-screen bg-slate-100 py-6 px-2 sm:px-4 md:py-10 md:px-6">
        <PublicFormView
          definition={targeted.formDefinition}
          pageTitle={targeted.formTitle}
          submitUrl={`/api/public/forms/invitations/${token}/submit`}
          topBanner={banner}
          onSubmitSuccess={onSubmitSuccess}
        />
      </div>
    );
  }

  // ───── authenticated flow ──────────────────────────────────────────────────
  if (!authResp || !token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-600">Loading…</p>
      </div>
    );
  }
  const activePrefill = overridePrefill ?? authResp.prefill;
  const selector =
    household.length > 1 ? (
      <WhoIsThisForSelect
        members={household}
        selectedMemberId={selectedMemberId}
        onChange={setSelectedMemberId}
      />
    ) : undefined;
  return (
    <div className="min-h-screen bg-slate-100 py-6 px-2 sm:px-4 md:py-10 md:px-6">
      <PublicFormView
        // Remount when the selected member or its prefill changes so the form
        // re-seeds the About-You fields from the chosen member.
        key={`${selectedMemberId ?? 'self'}-${overridePrefill ? 'o' : 'i'}`}
        definition={authResp.formDefinition}
        pageTitle={authResp.formTitle}
        submitUrl={`/api/me/member/forms/invitations/${token}/submit`}
        initialValues={mapPrefillToInitialValues(
          authResp.formDefinition,
          activePrefill as Record<string, string | null>
        )}
        topBanner={selector}
        extraSubmitFields={selectedMemberId ? { forMemberId: selectedMemberId } : undefined}
        onSubmitSuccess={onSubmitSuccess}
      />
    </div>
  );
}
