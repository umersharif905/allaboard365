import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiService, withTenantScope, type ApiError } from '../../services/api.service';
import { usePublicFormsContext } from '../../hooks/usePublicFormsContext';
import {
  formatNameWithDiff,
  formatEmailWithDiff,
  formatPhoneWithDiff,
} from '../../utils/formMemberDiff';
import { LinkagePicker } from '../../components/tenant-admin/public-form-builder/LinkagePicker';
import {
  downloadSubmissionCsv,
  downloadSubmissionPdf,
  downloadSubmissionRecordPdfFromUrl,
  formatDurationSeconds,
  getSubmissionRecordPdfBlobUrl,
  payloadToRows,
  buildSubmissionDownloadBasename
} from '../../utils/submissionExport';
import {
  PreScreeningSubmissionSummary,
  readPreScreeningSnapshot
} from '../../components/PreScreeningSubmissionSummary';
import { resolutionStatus } from '../../utils/submissionStatus';
import { isProviderValue, formatProviderValue } from '../../utils/providerFieldValue';

function isSignatureValue(v: unknown): v is { imageDataUrl: string; audit?: Record<string, unknown> } {
  return !!v && typeof v === 'object' && typeof (v as { imageDataUrl?: unknown }).imageDataUrl === 'string';
}

function renderPayloadValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(renderPayloadValue).join(', ');
  if (isSignatureValue(v)) return '[Signature on file]';
  if (isProviderValue(v)) return formatProviderValue(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

function normalizeSubmissionId(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[{}]/g, '').trim();
  return UUID_RE.test(s) ? s : null;
}

function secondsBetween(start: unknown, end: unknown): number | null {
  if (!start || !end) return null;
  const t0 = new Date(start as string).getTime();
  const t1 = new Date(end as string).getTime();
  if (Number.isNaN(t0) || Number.isNaN(t1)) return null;
  return Math.max(0, Math.round((t1 - t0) / 1000));
}

export default function TenantSharingSubmissionDetailPage() {
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const tenantReq = useMemo(() => withTenantScope(activeTenantId), [activeTenantId]);
  const { apiBase, routeBase, membersApiBase } = usePublicFormsContext();
  const { submissionId: submissionIdParam } = useParams<{ submissionId: string }>();
  const submissionId = normalizeSubmissionId(submissionIdParam);
  const [data, setData] = useState<any>(null);
  const [memberIdInput, setMemberIdInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rawJsonOpen, setRawJsonOpen] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [routingRecipients, setRoutingRecipients] = useState('');
  const [routingDefaults, setRoutingDefaults] = useState<string[]>([]);
  const [routingDefaultsLoaded, setRoutingDefaultsLoaded] = useState(false);
  const [routingUserEditedRecipients, setRoutingUserEditedRecipients] = useState(false);
  const [routingQueueSending, setRoutingQueueSending] = useState(false);
  const [pdfDownloading, setPdfDownloading] = useState(false);
  const [completePdfDownloading, setCompletePdfDownloading] = useState(false);
  const [linkagePickerOpen, setLinkagePickerOpen] = useState(false);
  const [linkagePickerSrId, setLinkagePickerSrId] = useState<string | null>(null);
  const [linkageSaving, setLinkageSaving] = useState(false);

  const load = useCallback(async () => {
    if (!submissionId) return;
    setLoading(true);
    setErr(null);
    setData(null);
    try {
      const res = await apiService.get<{ success: boolean; data?: any; message?: string }>(
        `${apiBase}/submissions/${submissionId}`,
        tenantReq
      );
      if (res.success && res.data) setData(res.data);
      else setErr(res.message || 'Failed to load submission');
    } catch (e: any) {
      setErr(e?.message || 'Failed');
    } finally {
      setLoading(false);
    }
  }, [submissionId, tenantReq, apiBase]);

  useEffect(() => {
    if (!submissionIdParam) {
      setLoading(false);
      return;
    }
    if (!submissionId) {
      setLoading(false);
      setData(null);
      setErr('Invalid submission link.');
      return;
    }
    load();
  }, [submissionId, submissionIdParam, load]);

  useEffect(() => {
    if (!submissionId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{
          success: boolean;
          data?: { recipients?: string[] };
          message?: string;
        }>(
          `${apiBase}/submissions/${submissionId}/routing-notification-defaults`,
          tenantReq
        );
        if (cancelled) return;
        const recipients = Array.isArray(res?.data?.recipients) ? res.data!.recipients! : [];
        setRoutingDefaults(recipients);
        setRoutingDefaultsLoaded(true);
        if (!routingUserEditedRecipients) {
          setRoutingRecipients(recipients.join(', '));
        }
      } catch {
        if (cancelled) return;
        setRoutingDefaults([]);
        setRoutingDefaultsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId, tenantReq]);

  const openLinkagePicker = () => {
    setLinkagePickerSrId(data?.ShareRequestId || null);
    setLinkagePickerOpen(true);
  };

  const saveLinkage = async (srId: string | null) => {
    if (!submissionId) return;
    setLinkageSaving(true);
    setErr(null);
    setMsg(null);
    try {
      await apiService.patch(
        `${apiBase}/submissions/${submissionId}/linkage`,
        { shareRequestId: srId, caseId: null },
        tenantReq
      );
      setMsg(srId ? 'Linkage updated.' : 'Linkage cleared.');
      setLinkagePickerOpen(false);
      await load();
    } catch (e: any) {
      setErr(e?.message || 'Failed to update linkage');
    } finally {
      setLinkageSaving(false);
    }
  };

  const resolve = async () => {
    setMsg(null);
    setErr(null);
    try {
      await apiService.post(
        `${apiBase}/submissions/${submissionId}/resolve-member`,
        undefined,
        tenantReq
      );
      setMsg('Resolve attempted; check member match and link status.');
      await load();
    } catch (e: any) {
      setErr(e?.message || 'Failed');
    }
  };

  const setMember = async () => {
    if (!memberIdInput.trim()) return;
    setMsg(null);
    setErr(null);
    try {
      await apiService.post(
        `${apiBase}/submissions/${submissionId}/set-member`,
        { memberId: memberIdInput.trim() },
        tenantReq
      );
      setMsg('Member set and link attempted.');
      setMemberIdInput('');
      await load();
    } catch (e: any) {
      setErr(e?.message || 'Failed');
    }
  };

  const retry = async () => {
    setMsg(null);
    setErr(null);
    try {
      await apiService.post(
        `${apiBase}/submissions/${submissionId}/retry-link`,
        undefined,
        tenantReq
      );
      setMsg('Retry complete.');
      await load();
    } catch (e: any) {
      setErr(e?.message || 'Failed');
    }
  };

  const sendSummaryEmail = async () => {
    if (!submissionId || !emailTo.trim()) return;
    setEmailSending(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await apiService.post<{ success: boolean; message?: string }>(
        `${apiBase}/submissions/${submissionId}/send-summary-email`,
        { toEmail: emailTo.trim() },
        tenantReq
      );
      if (res.success) {
        setMsg(`Summary emailed to ${emailTo.trim()}.`);
        setEmailTo('');
      } else setErr(res.message || 'Send failed');
    } catch (e: any) {
      setErr(e?.message || 'Failed to send email');
    } finally {
      setEmailSending(false);
    }
  };

  const queueRoutingNotifications = async () => {
    if (!submissionId) return;
    setRoutingQueueSending(true);
    setMsg(null);
    setErr(null);
    try {
      const list = routingRecipients
        .split(/[,;\n\r]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const body: { additionalEmailsList: string[]; replaceDefaults: true } = {
        additionalEmailsList: list,
        replaceDefaults: true
      };
      const res = await apiService.post<{
        success: boolean;
        message?: string;
        data?: { queued?: number; recipients?: string[] };
      }>(
        `${apiBase}/submissions/${submissionId}/queue-routing-notifications`,
        body,
        tenantReq
      );
      if (res.success && res.data) {
        const n = res.data.queued ?? 0;
        const recipients = Array.isArray(res.data.recipients) ? res.data.recipients : [];
        const recipientSummary = recipients.length ? ` (${recipients.join(', ')})` : '';
        setMsg(
          n > 0
            ? `Queued ${n} routing notification email(s)${recipientSummary}. A new anonymous viewer link was issued; older public links for this submission no longer work.`
            : 'Request completed.'
        );
      } else setErr(res.message || 'Could not queue routing emails');
    } catch (e: unknown) {
      const ae = e as ApiError & { responseData?: { message?: string } };
      const fromBody =
        ae?.responseData && typeof ae.responseData === 'object' && ae.responseData !== null
          ? (ae.responseData as { message?: string }).message
          : undefined;
      setErr(
        (typeof fromBody === 'string' && fromBody.trim() ? fromBody : null) ||
          (typeof ae?.message === 'string' ? ae.message : null) ||
          'Failed to queue routing emails'
      );
    } finally {
      setRoutingQueueSending(false);
    }
  };

  const resetRoutingRecipientsToDefaults = () => {
    setRoutingRecipients(routingDefaults.join(', '));
    setRoutingUserEditedRecipients(false);
  };

  if (submissionIdParam && !submissionId) {
    return (
      <div className="p-6 max-w-7xl mx-auto space-y-4">
        <Link to={`${routeBase}/submissions`} className="text-oe-primary hover:text-oe-dark text-sm hover:underline">
          ← Submissions
        </Link>
        <p className="text-red-600 text-sm">Invalid submission link.</p>
      </div>
    );
  }

  if (loading) return <div className="p-6 text-gray-600">Loading…</div>;
  if (err && !data) {
    return (
      <div className="p-6 max-w-7xl mx-auto space-y-4">
        <Link to={`${routeBase}/submissions`} className="text-oe-primary hover:text-oe-dark text-sm hover:underline">
          ← Submissions
        </Link>
        <p className="text-red-600 text-sm">{err}</p>
      </div>
    );
  }
  if (!data) return <div className="p-6 text-gray-600">Not found</div>;

  const payloadObj =
    data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload)
      ? (data.payload as Record<string, unknown>)
      : null;

  const preScreeningSnapshot = readPreScreeningSnapshot(data.payload);

  const fieldList: Array<{ name: string; label?: string | null; type?: string | null }> =
    Array.isArray(data.fields) ? data.fields : [];
  const labelByKey = new Map<string, string>();
  for (const f of fieldList) {
    if (f?.name && f.label) labelByKey.set(f.name, f.label);
  }
  const payloadMap = new Map<string, unknown>(payloadObj ? Object.entries(payloadObj) : []);
  // Split the payload into "form answers" (keys in the form definition) vs
  // "account snapshot" (keys in the payload but NOT in the definition —
  // typically authenticated-mode prefill overwrite).
  const formFieldKeys = new Set<string>();
  const formAnswerKeys: string[] = [];
  for (const f of fieldList) {
    if (!f?.name || formFieldKeys.has(f.name)) continue;
    formFieldKeys.add(f.name);
    if (payloadMap.has(f.name)) formAnswerKeys.push(f.name);
  }
  const accountSnapshotKeys: string[] = [];
  for (const k of payloadMap.keys()) {
    if (k.startsWith('__')) continue;
    if (!formFieldKeys.has(k)) accountSnapshotKeys.push(k);
  }
  const orderedKeys = [...formAnswerKeys, ...accountSnapshotKeys];
  const payloadEntries: Array<[string, unknown]> = orderedKeys.map((k) => [k, payloadMap.get(k)]);
  const formAnswerEntries: Array<[string, unknown]> = formAnswerKeys.map((k) => [k, payloadMap.get(k)]);
  const accountSnapshotEntries: Array<[string, unknown]> = accountSnapshotKeys.map((k) => [k, payloadMap.get(k)]);
  const exportRows = payloadToRows(payloadObj || undefined);
  const createdLabel = data.CreatedDate ? new Date(data.CreatedDate).toLocaleString() : '';
  const titleLine = `${data.FormKind || 'Submission'} — ${createdLabel}`;
  const payloadForName = payloadObj;
  const secToLinkView = secondsBetween(data.CreatedDate, data.AnonymousLinkFirstViewedAt);

  const status = resolutionStatus(data);
  const memberName =
    [data.MemberFirstName, data.MemberLastName].filter(Boolean).join(' ').trim();
  const typedName =
    [data.PayloadFirstName, data.PayloadLastName].filter(Boolean).join(' ').trim();
  const submitterDisplay = memberName
    ? memberName
    : typedName
      ? `${typedName} (unmatched)`
      : 'Unmatched recipient';
  const formDisplay = data.FormTitle || data.FormKind || 'Form submission';
  const sourceLabel = String(data.AuthMode || 'anonymous').toLowerCase();

  const runExportPdf = async () => {
    if (!submissionId) return;
    setPdfDownloading(true);
    try {
      await apiService.downloadFile(
        `${apiBase}/submissions/${submissionId}/submission-pdf`,
        `${buildSubmissionDownloadBasename(String(data.FormKind || 'submission'), payloadForName, 'submission')}.pdf`
      );
    } catch {
      const recordUrl = getSubmissionRecordPdfBlobUrl(data.files);
      if (recordUrl) {
        try {
          await downloadSubmissionRecordPdfFromUrl(
            recordUrl,
            `${buildSubmissionDownloadBasename(String(data.FormKind || 'submission'), payloadForName, 'submission-record')}.pdf`
          );
          return;
        } catch {
          /* fall through */
        }
      }
      downloadSubmissionPdf({
        title: titleLine,
        formKind: String(data.FormKind || ''),
        createdDateLabel: createdLabel,
        requestNumber: data.RequestNumber,
        rows: exportRows,
        payload: payloadForName
      });
    } finally {
      setPdfDownloading(false);
    }
  };

  const runExportCompletePdf = async () => {
    if (!submissionId) return;
    setCompletePdfDownloading(true);
    try {
      await apiService.downloadFile(
        `${apiBase}/submissions/${submissionId}/submission-pdf-complete`,
        `${buildSubmissionDownloadBasename(String(data.FormKind || 'submission'), payloadForName, 'submission-complete')}.pdf`
      );
    } catch {
      downloadSubmissionPdf({
        title: titleLine,
        formKind: String(data.FormKind || ''),
        createdDateLabel: createdLabel,
        requestNumber: data.RequestNumber,
        rows: exportRows,
        payload: payloadForName
      });
    } finally {
      setCompletePdfDownloading(false);
    }
  };

  const runExportCsv = () => {
    downloadSubmissionCsv({
      title: String(data.FormKind || 'submission'),
      formKind: String(data.FormKind || ''),
      createdDateLabel: createdLabel,
      requestNumber: data.RequestNumber,
      rows: exportRows,
      payload: payloadForName
    });
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-break-inside-avoid { break-inside: avoid; }
        }
      `}</style>

      <div className="no-print">
        <Link
          to={`${routeBase}/submissions`}
          className="inline-flex items-center gap-1 text-sm text-oe-primary hover:text-oe-dark hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Submissions
        </Link>
      </div>

      {/* ===== Summary header ===== */}
      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <h1 className="text-2xl font-semibold text-gray-900 leading-tight">{formDisplay}</h1>
        <p className="text-sm text-gray-600 mt-1">
          Submitted by <span className="text-gray-900 font-medium">{submitterDisplay}</span>
          {createdLabel ? <> · {createdLabel}</> : null}
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
              status.tone === 'green'
                ? 'bg-green-50 text-green-800 border-green-200'
                : status.tone === 'amber'
                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                  : 'bg-gray-100 text-gray-700 border-gray-200'
            }`}
            title={status.label}
          >
            {status.isResolved ? (
              <CheckCircle className="h-3 w-3" />
            ) : (
              <AlertTriangle className="h-3 w-3" />
            )}
            {status.label}
          </span>
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-gray-100 text-gray-700 border-gray-200"
            title={
              sourceLabel === 'authenticated' ? 'Requires login'
              : sourceLabel === 'targeted' ? 'No login required'
              : 'Anyone with the link can fill this form'
            }
          >
            {sourceLabel === 'authenticated' ? 'Secure'
              : sourceLabel === 'targeted' ? 'Personal'
              : 'Public'}
          </span>
          {data.RequestNumber && data.ShareRequestId && (
            <Link
              to={`/share-requests/${data.ShareRequestId}`}
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-oe-light text-oe-dark border-oe-primary/30 hover:border-oe-primary"
            >
              Linked: {data.RequestNumber}
            </Link>
          )}
        </div>
      </div>

      {msg && <p className="text-oe-success text-sm">{msg}</p>}
      {err && <p className="text-red-600 text-sm">{err}</p>}
      {data.LinkError && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded p-2">{data.LinkError}</p>
      )}

      {/* ===== Needs attention — unresolved only ===== */}
      {status.needsAttention && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-lg p-4 space-y-3 no-print">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-700 mt-0.5 shrink-0" />
            <div>
              <h2 className="font-semibold text-amber-900">Needs attention</h2>
              <p className="text-sm text-amber-800">
                This submission couldn&apos;t be matched to a member. The member ID the recipient
                typed didn&apos;t match a customer in the database — resolve it below so the
                submission lands on the right account.
              </p>
            </div>
          </div>
          <div className="bg-white border border-amber-200 rounded px-3 py-2 text-sm">
            <span className="text-xs text-gray-500 uppercase tracking-wide">Member ID typed</span>
            <div className="font-mono text-gray-900 break-all">
              {data.SubmittedMemberIdText || (
                <span className="italic text-gray-500 font-sans">(none provided)</span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={resolve}
              className="bg-oe-primary hover:bg-oe-dark text-white px-3 py-1.5 rounded text-sm font-medium"
            >
              Re-resolve from typed ID
            </button>
            <button
              type="button"
              onClick={retry}
              className="border border-amber-300 text-amber-900 bg-white hover:bg-amber-100 px-3 py-1.5 rounded text-sm font-medium"
            >
              Retry share-request link
            </button>
          </div>
          <div className="border-t border-amber-200 pt-3">
            <label className="block text-sm">
              <span className="text-gray-700 font-medium">Or assign the member directly</span>
              <div className="flex gap-2 flex-wrap mt-1.5">
                <input
                  className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 min-w-[240px]"
                  placeholder="Paste a Member UUID"
                  value={memberIdInput}
                  onChange={(e) => setMemberIdInput(e.target.value)}
                />
                <button
                  type="button"
                  onClick={setMember}
                  disabled={!memberIdInput.trim()}
                  className="bg-oe-success hover:opacity-90 text-white px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
                >
                  Set member &amp; link
                </button>
              </div>
            </label>
          </div>
        </div>
      )}

      {/* ===== Member panel — resolved only ===== */}
      {data.MemberId && (() => {
        const nameLine = formatNameWithDiff(
          data.MemberFirstName,
          data.MemberLastName,
          data.PayloadFirstName,
          data.PayloadLastName
        );
        const emailLine = formatEmailWithDiff(data.MemberEmail, data.PayloadEmail);
        const phoneLine = formatPhoneWithDiff(data.MemberPhone, data.PayloadPhone);
        return (
          <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-medium text-gray-800">Member</h2>
            </div>
            <div className="space-y-0.5">
              {nameLine && <p className="text-gray-900 font-medium">{nameLine}</p>}
              {emailLine && <p className="text-gray-600">{emailLine}</p>}
              {phoneLine && <p className="text-gray-600">{phoneLine}</p>}
              <p className="text-xs text-gray-400 font-mono break-all pt-0.5">
                MemberId: {data.MemberId}
              </p>
            </div>
            <details className="border-t border-gray-100 pt-3 no-print">
              <summary className="cursor-pointer select-none text-sm font-medium text-gray-700">
                Manage member &amp; linkage
                <span className="ml-2 font-normal text-gray-400">
                  — change linkage, re-resolve, or assign a different member
                </span>
              </summary>
              <div className="mt-3 space-y-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                      Linkage
                    </span>
                    <button
                      type="button"
                      onClick={openLinkagePicker}
                      disabled={linkageSaving}
                      className="text-xs text-oe-primary hover:text-oe-dark disabled:opacity-50"
                    >
                      {data.ShareRequestId ? 'Change' : 'Link to share request'}
                    </button>
                  </div>
                  {data.ShareRequestId ? (
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-gray-700">
                        Share request:{' '}
                        <span className="font-medium text-gray-900">
                          {data.RequestNumber || data.ShareRequestId}
                        </span>
                      </p>
                      <button
                        type="button"
                        onClick={() => saveLinkage(null)}
                        disabled={linkageSaving}
                        className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded disabled:opacity-50"
                      >
                        Remove linkage
                      </button>
                    </div>
                  ) : (
                    <p className="text-gray-500 text-xs">Not linked.</p>
                  )}
                  {linkagePickerOpen && (
                    <div className="border-t border-gray-100 pt-3 space-y-3">
                      <LinkagePicker
                        memberId={data.MemberId}
                        membersApiBase={membersApiBase}
                        tenantReq={tenantReq}
                        selectedShareRequestId={linkagePickerSrId}
                        selectedCaseId={null}
                        onChange={(srId) => setLinkagePickerSrId(srId)}
                      />
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setLinkagePickerOpen(false)}
                          disabled={linkageSaving}
                          className="text-xs text-gray-600 hover:underline disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => saveLinkage(linkagePickerSrId)}
                          disabled={linkageSaving}
                          className="text-xs bg-oe-primary hover:bg-oe-dark text-white px-3 py-1 rounded disabled:opacity-50"
                        >
                          {linkageSaving ? 'Saving…' : 'Save linkage'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-100 pt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={resolve}
                    className="border border-gray-300 bg-white hover:bg-gray-50 text-gray-800 px-3 py-1.5 rounded text-sm"
                  >
                    Re-resolve from typed ID
                  </button>
                  <button
                    type="button"
                    onClick={retry}
                    className="border border-gray-300 bg-white hover:bg-gray-50 text-gray-800 px-3 py-1.5 rounded text-sm"
                  >
                    Retry share-request link
                  </button>
                </div>

                <div className="border-t border-gray-100 pt-3">
                  <label className="block text-sm">
                    <span className="text-gray-600">Assign a different member</span>
                    <div className="flex gap-2 flex-wrap mt-1">
                      <input
                        className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 min-w-[240px]"
                        placeholder="Paste a Member UUID"
                        value={memberIdInput}
                        onChange={(e) => setMemberIdInput(e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={setMember}
                        disabled={!memberIdInput.trim()}
                        className="bg-oe-success hover:opacity-90 text-white px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
                      >
                        Set member &amp; link
                      </button>
                    </div>
                  </label>
                </div>
              </div>
            </details>
          </div>
        );
      })()}

      {/* ===== Submitted answers — the content ===== */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-4">
        <PreScreeningSubmissionSummary questions={preScreeningSnapshot} />
        {payloadEntries.length === 0 ? (
          <>
            <h2 className="font-medium text-gray-800">Payload (decrypted)</h2>
            <p className="text-sm text-gray-500">
              {payloadObj === null ? 'Payload is not a plain object; use Raw JSON below.' : 'No data fields.'}
            </p>
          </>
        ) : (
          <>
            {formAnswerEntries.length > 0 && (
              <div className="space-y-2">
                <h2 className="font-medium text-gray-800">Form answers</h2>
                <p className="text-xs text-gray-500">
                  Fields the recipient saw and filled in.
                </p>
                <div className="rounded border border-gray-200 overflow-hidden bg-white">
                  <table className="w-full text-sm table-fixed">
                    <colgroup>
                      <col className="w-1/3" />
                      <col className="w-2/3" />
                    </colgroup>
                    <tbody>
                      {formAnswerEntries.map(([k, v], idx) => {
                        const label = labelByKey.get(k);
                        return (
                          <tr key={k} className={idx % 2 ? 'bg-gray-50' : 'bg-white'}>
                            <td className="p-3 align-top break-words">
                              <div className="text-gray-900 font-semibold leading-snug">
                                {label || k}
                              </div>
                              {label ? (
                                <div className="text-[11px] text-gray-400 font-mono mt-0.5 break-all">
                                  {k}
                                </div>
                              ) : null}
                            </td>
                            <td className="p-3 align-top text-gray-900 break-words">
                              {isSignatureValue(v) ? (
                                <div>
                                  {(v as { imageDataUrl: string }).imageDataUrl ? (
                                    <img
                                      src={(v as { imageDataUrl: string }).imageDataUrl}
                                      alt="Signature"
                                      className="max-w-[240px] h-auto border border-gray-200 rounded bg-white"
                                    />
                                  ) : (
                                    <span className="text-gray-500 italic">No signature drawn</span>
                                  )}
                                  {(v as { audit?: Record<string, unknown> }).audit && (
                                    <p className="text-xs text-gray-500 mt-1">
                                      Signed: {String((v as { audit: Record<string, unknown> }).audit.signedAtUtc || '—')}
                                    </p>
                                  )}
                                </div>
                              ) : (
                                renderPayloadValue(v)
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {accountSnapshotEntries.length > 0 && (
              <div className="space-y-2">
                <h2 className="font-medium text-gray-800">Account snapshot</h2>
                <p className="text-xs text-gray-500">
                  Fields the server filled in from the member&apos;s profile
                  (authenticated-mode prefill overwrite). The recipient did not type these in this
                  submission.
                </p>
                <div className="rounded border border-gray-200 overflow-hidden bg-white">
                  <table className="w-full text-sm table-fixed">
                    <colgroup>
                      <col className="w-1/3" />
                      <col className="w-2/3" />
                    </colgroup>
                    <tbody>
                      {accountSnapshotEntries.map(([k, v], idx) => (
                        <tr key={k} className={idx % 2 ? 'bg-gray-50' : 'bg-white'}>
                          <td className="p-3 align-top break-words">
                            <div className="text-gray-700 font-medium leading-snug font-mono text-xs">
                              {k}
                            </div>
                          </td>
                          <td className="p-3 align-top text-gray-900 break-words">
                            {renderPayloadValue(v)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {data.files?.length > 0 && (
          <div className="space-y-2">
            <h2 className="font-medium text-gray-800">Files</h2>
            <ul className="text-sm space-y-1 bg-white border border-gray-200 rounded p-3">
              {data.files.map((f: any) => (
                <li key={f.FileId} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {f.OriginalFileName}
                    {f.FilePurpose === 'submission_pdf' ? (
                      <span className="ml-2 text-xs font-medium text-gray-600">
                        (Submission PDF)
                      </span>
                    ) : null}
                  </span>
                  {f.BlobUrl && (
                    <a
                      href={f.BlobUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-oe-primary hover:text-oe-dark text-xs hover:underline no-print shrink-0"
                    >
                      Open
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="no-print">
          <button
            type="button"
            onClick={() => setRawJsonOpen((o) => !o)}
            className="text-sm text-oe-primary hover:text-oe-dark hover:underline"
            aria-expanded={rawJsonOpen}
          >
            {rawJsonOpen ? 'Hide' : 'Show'} raw JSON
          </button>
          {rawJsonOpen && (
            <pre className="text-xs overflow-auto max-h-96 mt-2 p-3 bg-white border border-gray-200 rounded">
              {JSON.stringify(data.payload, null, 2)}
            </pre>
          )}
        </div>
      </div>

      {/* ===== Tracking & notifications — demoted ===== */}
      <details className="bg-white border border-gray-200 rounded-lg no-print">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-gray-700">
          Tracking &amp; notifications
          <span className="ml-2 font-normal text-gray-400">
            — exports, summary email, routing notifications, and link-open timing
          </span>
        </summary>
        <div className="border-t border-gray-100 p-4 space-y-5">
          {/* Tracking */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Tracking
            </h3>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-gray-600">Submitted</dt>
                <dd className="font-medium text-gray-900">{createdLabel || '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-600">Submission link first opened</dt>
                <dd className="font-medium text-gray-900">
                  {data.AnonymousLinkFirstViewedAt
                    ? new Date(data.AnonymousLinkFirstViewedAt).toLocaleString()
                    : 'Not yet (anonymous data link)'}
                </dd>
              </div>
              <div>
                <dt className="text-gray-600">Time from submit → first link open</dt>
                <dd className="font-medium text-gray-900">{formatDurationSeconds(secToLinkView)}</dd>
              </div>
            </dl>
          </div>

          {/* Export */}
          <div className="border-t border-gray-100 pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Export
            </h3>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => window.print()}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50"
              >
                Print
              </button>
              <button
                type="button"
                disabled={pdfDownloading}
                onClick={() => void runExportPdf()}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-60"
              >
                {pdfDownloading ? 'Preparing…' : 'Custom PDF'}
              </button>
              <button
                type="button"
                disabled={completePdfDownloading}
                onClick={() => void runExportCompletePdf()}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-60"
              >
                {completePdfDownloading ? 'Preparing…' : 'Complete PDF'}
              </button>
              <button
                type="button"
                onClick={runExportCsv}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50"
              >
                Download CSV
              </button>
            </div>
          </div>

          {/* Email summary */}
          <div className="border-t border-gray-100 pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Email a summary
            </h3>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1 min-w-[220px] flex-1">
                <label htmlFor="summary-email-to" className="text-xs text-gray-600">
                  Recipient
                </label>
                <input
                  id="summary-email-to"
                  type="email"
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                  placeholder="name@company.com"
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  autoComplete="email"
                />
              </div>
              <button
                type="button"
                disabled={emailSending || !emailTo.trim()}
                onClick={sendSummaryEmail}
                className="rounded-md bg-oe-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-oe-dark disabled:opacity-50"
              >
                {emailSending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>

          {/* Routing notifications */}
          <div className="border-t border-gray-100 pt-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Routing notification (message queue)
            </h3>
            <p className="text-xs text-gray-600">
              Sends the standard “new submission” notice through the same outbound queue as other
              system emails to exactly the addresses below. Re-queuing issues a new secure viewer
              link (previous public links for this submission stop working).
            </p>
            <div className="flex flex-col gap-1 min-w-[220px] max-w-2xl">
              <div className="flex items-center justify-between">
                <label htmlFor="routing-recipients" className="text-xs font-medium text-gray-600">
                  Recipients (comma-separated)
                </label>
                {routingDefaultsLoaded && routingDefaults.length > 0 && (
                  <button
                    type="button"
                    onClick={resetRoutingRecipientsToDefaults}
                    className="text-xs text-oe-primary hover:text-oe-dark hover:underline"
                  >
                    Reset to defaults
                  </button>
                )}
              </div>
              <textarea
                id="routing-recipients"
                rows={2}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-mono"
                placeholder="ops@example.com, partner@example.com"
                value={routingRecipients}
                onChange={(e) => {
                  setRoutingRecipients(e.target.value);
                  setRoutingUserEditedRecipients(true);
                }}
                autoComplete="off"
              />
              {routingDefaultsLoaded && (
                <p className="text-[11px] text-gray-500">
                  {routingDefaults.length === 0
                    ? 'No default recipients are configured for this template / tenant — enter at least one address.'
                    : `Pre-filled with defaults: ${routingDefaults.join(', ')}`}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={routingQueueSending}
              onClick={() => void queueRoutingNotifications()}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
            >
              {routingQueueSending ? 'Queueing…' : 'Queue routing notification emails'}
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
