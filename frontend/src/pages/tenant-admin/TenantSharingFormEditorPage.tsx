import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, HelpCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { apiService, withTenantScope } from '../../services/api.service';
import { usePublicFormsContext } from '../../hooks/usePublicFormsContext';
import { PublicFormBuilder } from '../../components/tenant-admin/public-form-builder/PublicFormBuilder';
import { useFormDefinition } from '../../components/tenant-admin/public-form-builder/useFormDefinition';
import { PublicFormPreviewDialog } from '../../components/tenant-admin/public-form-builder/PublicFormPreviewDialog';
import { SubmissionPdfPreviewDialog } from '../../components/tenant-admin/public-form-builder/SubmissionPdfPreviewDialog';
import {
  embedModeFromStored,
  serializeEmbedSites,
  type EmbedMode
} from '../../utils/allowedFrameAncestorsUi';
import {
  emailsToRowList,
  parseNotifyEmailsJson,
  serializeNotifyEmailsFromRows
} from '../../utils/notifyEmails';
import {
  fbAddOptionBtn,
  fbLinkBlueBtn,
  fbOutlineBtn,
  fbSolidDangerOutlineBtn,
  fbSolidEmeraldBtn
} from '../../components/tenant-admin/public-form-builder/formBuilderButtonClasses';

type VersionRow = {
  VersionId: string;
  VersionNumber: number;
  ChangeNote: string | null;
  CreatedDate: string;
  CreatedBy?: string | null;
};

type EditorTab = 'setup' | 'build' | 'advanced';

const TABS: { id: EditorTab; label: string }[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'build', label: 'Build form' },
  { id: 'advanced', label: 'Advanced' }
];

const inputCls =
  'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent';

/** Card section wrapper — matches the app's bg-white / rounded-lg / border style. */
function Section({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
      <div>
        <h2 className="font-medium text-gray-900">{title}</h2>
        {description && <p className="text-sm text-gray-500 mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export default function TenantSharingFormEditorPage() {
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const tenantReq = useMemo(() => withTenantScope(activeTenantId), [activeTenantId]);
  const { apiBase, routeBase, canDelete, canPublish, canEdit } = usePublicFormsContext();
  const { formTemplateId } = useParams<{ formTemplateId: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const [activeTab, setActiveTab] = useState<EditorTab>('setup');
  const [title, setTitle] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [notifyEmailRows, setNotifyEmailRows] = useState<string[]>(['']);
  const [notifyEmailsLoadWarning, setNotifyEmailsLoadWarning] = useState<string | null>(null);
  const [embedMode, setEmbedMode] = useState<EmbedMode>('any');
  const [embedSiteLines, setEmbedSiteLines] = useState('');
  const [defaultVendorId, setDefaultVendorId] = useState<string>('');
  const [vendorOptions, setVendorOptions] = useState<{ VendorId: string; VendorName: string }[]>([]);
  // ResolverTenantIds: which tenants the member-ID resolver may search for this
  // form (a vendor-wide form serves members across sibling tenants). Options come
  // from the selected vendor's tenants.
  const [resolverTenantIds, setResolverTenantIds] = useState<string[]>([]);
  const [tenantOptions, setTenantOptions] = useState<{ tenantId: string; tenantName: string }[]>([]);
  const [allowAnonymous, setAllowAnonymous] = useState(true);
  const [allowTargeted, setAllowTargeted] = useState(false);
  const [allowAuthenticated, setAllowAuthenticated] = useState(false);
  const [createsShareRequestOnSubmit, setCreatesShareRequestOnSubmit] = useState(false);
  const [createsCaseOnSubmit, setCreatesCaseOnSubmit] = useState(false);
  const [definitionJson, setDefinitionJson] = useState('');
  /** The definition JSON as last loaded/saved — used to skip pointless version rows. */
  const [loadedDefinitionJson, setLoadedDefinitionJson] = useState('');
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [latestVersion, setLatestVersion] = useState<number | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [loadingVersionNumber, setLoadingVersionNumber] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  /** B-032 — true when the user just landed via "+ New form" on the forms
   *  list. Reset on save / hard refresh, so Discard is a fresh-create-only
   *  bail-out, not an always-on Delete (Delete still lives in Advanced). */
  const [isFreshDraft, setIsFreshDraft] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  // Shared form-definition state — the Setup tab drives the form-structure
  // toggles and the Build tab renders the builder, both off this controller.
  const formDef = useFormDefinition(definitionJson, setDefinitionJson);

  const load = useCallback(
    async (opts?: { soft?: boolean }) => {
      if (!formTemplateId) return;
      if (!opts?.soft) setLoading(true);
      setError(null);
      try {
        const res = await apiService.get<{
          success: boolean;
          data?: {
            template: {
              Title: string;
              FormKind: string;
              KindLabel?: string | null;
              IsActive?: boolean | number | null;
              NotifyEmails: string;
              AllowedFrameAncestors: string;
              PublishedVersion: number | null;
              DefaultVendorId?: string | null;
              ResolverTenantIds?: string | null;
              AllowAnonymous?: boolean | number | null;
              AllowTargeted?: boolean | number | null;
              AllowAuthenticated?: boolean | number | null;
              CreatesShareRequestOnSubmit?: boolean | number | null;
              CreatesCaseOnSubmit?: boolean | number | null;
            };
            versions?: VersionRow[];
            latestDefinition?: { DefinitionJson: string; VersionNumber: number };
          };
        }>(`${apiBase}/templates/${formTemplateId}`, tenantReq);
        if (!res.success || !res.data) throw new Error('Not found');
        const { template, latestDefinition, versions: vlist } = res.data;
        setTitle(template.Title);
        const ia = template.IsActive;
        setIsActive(ia == null || Boolean(ia));
        const parsedNotify = parseNotifyEmailsJson(template.NotifyEmails);
        setNotifyEmailRows(emailsToRowList(parsedNotify.emails));
        setNotifyEmailsLoadWarning(
          parsedNotify.parseError
            ? 'Previous notify email list could not be read; re-enter addresses below.'
            : null
        );
        const embed = embedModeFromStored(template.AllowedFrameAncestors);
        setEmbedMode(embed.mode);
        setEmbedSiteLines(embed.linesText);
        setDefaultVendorId(template.DefaultVendorId || '');
        // ResolverTenantIds is stored as a JSON array string; degrade gracefully.
        let rtids: string[] = [];
        if (template.ResolverTenantIds) {
          try {
            const parsed = JSON.parse(template.ResolverTenantIds);
            if (Array.isArray(parsed)) rtids = parsed.map((x: unknown) => String(x)).filter(Boolean);
          } catch {
            /* ignore bad JSON — degrade to none */
          }
        }
        setResolverTenantIds(rtids);
        setAllowAnonymous(template.AllowAnonymous == null ? true : Boolean(template.AllowAnonymous));
        setAllowTargeted(Boolean(template.AllowTargeted));
        setAllowAuthenticated(Boolean(template.AllowAuthenticated));
        setCreatesShareRequestOnSubmit(Boolean(template.CreatesShareRequestOnSubmit));
        setCreatesCaseOnSubmit(Boolean(template.CreatesCaseOnSubmit));
        setPublishedVersion(template.PublishedVersion);
        setVersions(Array.isArray(vlist) ? vlist : []);
        if (latestDefinition) {
          setDefinitionJson(latestDefinition.DefinitionJson);
          setLoadedDefinitionJson(latestDefinition.DefinitionJson);
          setLatestVersion(latestDefinition.VersionNumber);
        } else {
          setDefinitionJson('');
          setLoadedDefinitionJson('');
          setLatestVersion(null);
        }
      } catch (e: any) {
        setError(e?.message || 'Load failed');
      } finally {
        if (!opts?.soft) setLoading(false);
      }
    },
    [formTemplateId, tenantReq, apiBase]
  );

  useEffect(() => {
    load();
  }, [load]);

  // B-032 — consume the "+ New form" signal once. Forms list passes
  // `state: { justCreated: true }` when it navigates here right after
  // creating a draft; clear the state from history so a refresh doesn't
  // keep showing Discard after the user has moved on.
  useEffect(() => {
    const state = location.state as { justCreated?: boolean } | null;
    if (state?.justCreated) {
      setIsFreshDraft(true);
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Vendor list for the DefaultVendorId dropdown. Cheap GET on open; ignored on
  // error. Note: /api/vendors aliases VendorId AS Id — handle both keys.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{
          success: boolean;
          data: { Id?: string; VendorId?: string; VendorName: string }[];
        }>('/api/vendors?limit=200&sortBy=VendorName&sortOrder=ASC', tenantReq);
        if (!cancelled && res.success && Array.isArray(res.data)) {
          setVendorOptions(
            res.data
              .map((v) => ({
                VendorId: (v.Id || v.VendorId || '').toString(),
                VendorName: v.VendorName
              }))
              .filter((v) => v.VendorId)
          );
        }
      } catch {
        // silently ignore — empty dropdown still works as "(none)"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantReq]);

  // Tenant pick-list for "Resolve members across tenants" = the selected vendor's
  // tenants. Refetches whenever the chosen default vendor changes.
  useEffect(() => {
    if (!defaultVendorId) {
      setTenantOptions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{
          success: boolean;
          data: { tenantId: string; tenantName: string }[];
        }>(`${apiBase}/resolver-tenant-options?vendorId=${encodeURIComponent(defaultVendorId)}`, tenantReq);
        if (!cancelled && res.success && Array.isArray(res.data)) setTenantOptions(res.data);
      } catch {
        if (!cancelled) setTenantOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [defaultVendorId, apiBase, tenantReq]);

  const deliveryModeError =
    !allowAnonymous && !allowTargeted && !allowAuthenticated
      ? 'Pick at least one delivery mode.'
      : null;

  // Soft warning: an anonymous form with no well-known identity fields can't be
  // auto-resolved to a member. Non-blocking; shown in the advisory strip.
  const identityWarning = useMemo<string | null>(() => {
    if (!allowAnonymous) return null;
    let fields: Array<{ name: string; type: string }> = [];
    try {
      const d = JSON.parse(definitionJson || '{}');
      if (Array.isArray(d?.fields)) fields = d.fields;
    } catch {
      return null;
    }
    const hasIdentity = fields.some((f) => {
      if (f.type === 'member_id') return true;
      if (f.type === 'email') return true;
      if (f.type === 'first_name') return fields.some((g) => g.type === 'last_name');
      if (f.type === 'date' && /dob|dateofbirth/i.test(f.name || '')) return true;
      return false;
    });
    return hasIdentity
      ? null
      : 'This form allows public submissions but does not ask for any identifying information ' +
          '(Member ID, email, first + last name, or date of birth). Submissions may not auto-resolve ' +
          'to a member — consider adding a Member ID field, or limit it to personal or secure ' +
          'delivery only.';
  }, [allowAnonymous, definitionJson]);

  const deleteForm = async () => {
    if (!formTemplateId) return;
    const ok = window.confirm(
      `Delete this form? If it has submissions, deletion will be blocked — use “Active” off instead.`
    );
    if (!ok) return;
    setMessage(null);
    setError(null);
    try {
      await apiService.delete(`${apiBase}/templates/${formTemplateId}`, tenantReq);
      navigate(routeBase);
    } catch (e: any) {
      setError(e?.message || 'Delete failed');
    }
  };

  /**
   * B-032 — discard a just-created draft. "+ New form" auto-creates a stub
   * template so a mid-editing crash doesn't lose work; Discard is the
   * recoverable bail-out for I-clicked-this-by-accident. Same underlying
   * DELETE as the danger-zone Delete; just a friendlier label and easier
   * to find when the user has only been on the form for a moment.
   */
  const discardForm = async () => {
    if (!formTemplateId) return;
    const ok = window.confirm(
      'Discard this draft? The form will be deleted. This cannot be undone.'
    );
    if (!ok) return;
    setMessage(null);
    setError(null);
    setDiscarding(true);
    try {
      await apiService.delete(`${apiBase}/templates/${formTemplateId}`, tenantReq);
      navigate(routeBase);
    } catch (e: any) {
      setError(e?.message || 'Discard failed');
      setDiscarding(false);
    }
  };

  /**
   * Single save: persists settings (PATCH), a new definition version when it
   * changed, and publishes when the user can. On a validation error in a tab
   * that isn't active, switch to that tab so the problem is visible.
   */
  const save = async () => {
    if (!formTemplateId) return;
    setMessage(null);
    setError(null);

    const notifySerialized = serializeNotifyEmailsFromRows(notifyEmailRows);
    if (notifySerialized.ok === false) {
      setActiveTab('advanced');
      setError(notifySerialized.message);
      return;
    }
    let allowedFrameAncestors: string;
    if (embedMode === 'any') {
      allowedFrameAncestors = '*';
    } else {
      const sites = serializeEmbedSites(embedSiteLines);
      if (!sites) {
        setActiveTab('advanced');
        setError('Add at least one website, or choose “Allow embedding from any website”.');
        return;
      }
      allowedFrameAncestors = sites;
    }
    if (!allowAnonymous && !allowTargeted && !allowAuthenticated) {
      setActiveTab('setup');
      setError('Pick at least one delivery mode (public, personal, or secure).');
      return;
    }
    if (definitionJson.trim()) {
      try {
        JSON.parse(definitionJson);
      } catch {
        setActiveTab('advanced');
        setError('The form definition is not valid JSON. Open “Raw JSON” under Advanced to fix it.');
        return;
      }
    }

    const definitionChanged =
      definitionJson.trim() !== '' && definitionJson !== loadedDefinitionJson;

    setSaving(true);
    try {
      await apiService.patch(
        `${apiBase}/templates/${formTemplateId}`,
        {
          title,
          isActive,
          notifyEmails: notifySerialized.json,
          allowedFrameAncestors,
          defaultVendorId: defaultVendorId || null,
          resolverTenantIds,
          allowAnonymous,
          allowTargeted,
          allowAuthenticated,
          createsShareRequestOnSubmit,
          createsCaseOnSubmit
        },
        tenantReq
      );
      setNotifyEmailsLoadWarning(null);
      // Once anything has been saved this form is no longer a "fresh" draft —
      // hide the Discard affordance so it doesn't linger past the first save.
      setIsFreshDraft(false);

      let versionNumber = latestVersion;
      if (definitionChanged) {
        const res = await apiService.post<{ success: boolean; data?: { versionNumber: number } }>(
          `${apiBase}/templates/${formTemplateId}/versions`,
          { definitionJson, changeNote },
          tenantReq
        );
        versionNumber = res.data?.versionNumber ?? null;
        if (!versionNumber) {
          setError('Saving the form definition failed.');
          setSaving(false);
          return;
        }
      }

      let published = false;
      if (canPublish && versionNumber != null) {
        await apiService.post(
          `${apiBase}/templates/${formTemplateId}/publish`,
          { versionNumber },
          tenantReq
        );
        published = true;
      }

      // Save (draft or publish) always keeps the user on the editor — there
      // are plenty of cases where someone saves but wants to keep working.
      // Refresh from the server, surface the confirmation toast, and scroll
      // to the top so the freshly-updated status pills are in view.
      if (versionNumber != null) setLatestVersion(versionNumber);
      await load({ soft: true });
      setChangeNote('');
      setMessage(
        published
          ? `Saved and published version ${versionNumber}.`
          : definitionChanged
            ? `Saved version ${versionNumber} as a draft. A tenant admin must publish it to go live.`
            : 'Settings saved.'
      );
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (e: any) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const loadVersionIntoEditor = async (versionNumber: number) => {
    if (!formTemplateId) return;
    setMessage(null);
    setError(null);
    setLoadingVersionNumber(versionNumber);
    try {
      const res = await apiService.get<{
        success: boolean;
        data?: { definitionJson: string; versionNumber: number; changeNote?: string | null };
      }>(`${apiBase}/templates/${formTemplateId}/versions/${versionNumber}`, tenantReq);
      if (!res.success || !res.data?.definitionJson) throw new Error('Not found');
      setDefinitionJson(res.data.definitionJson);
      setActiveTab('build');
      setMessage(
        `Loaded version ${versionNumber} into the editor. Use “Save” when you are ready to save a new version.`
      );
    } catch (e: any) {
      setError(e?.message || 'Failed to load version');
    } finally {
      setLoadingVersionNumber(null);
    }
  };

  if (loading) return <div className="p-6 text-gray-600">Loading…</div>;

  const isPublished = publishedVersion != null;
  const inactiveButPublished = !isActive && isPublished;
  const saveLabel = canPublish ? 'Save & publish' : 'Save draft';
  const hasAdvisories = !canEdit || inactiveButPublished || !!identityWarning;

  return (
    <div className="max-w-7xl mx-auto pb-16">
      {/* ===== Sticky header: identity, status, primary actions ===== */}
      <div className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="px-6 pt-4 pb-0">
          <Link
            to={routeBase}
            className="inline-flex items-center gap-1 text-sm text-oe-primary hover:text-oe-dark hover:underline"
          >
            <ArrowLeft className="h-4 w-4" /> All forms
          </Link>
          <div className="mt-2 flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={!canEdit}
                placeholder="Untitled form"
                aria-label="Form title"
                className="w-full max-w-2xl text-2xl font-semibold text-gray-900 bg-transparent rounded-lg px-2 py-1 -ml-2 border border-transparent hover:border-gray-200 focus:outline-none focus:border-oe-primary focus:ring-1 focus:ring-oe-primary disabled:hover:border-transparent placeholder:text-gray-400"
              />
              <div className="flex flex-wrap items-center gap-2 mt-1.5 ml-0.5">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                    isPublished
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : 'bg-gray-100 text-gray-600 border-gray-200'
                  }`}
                >
                  {isPublished ? `Published · v${publishedVersion}` : 'Draft'}
                </span>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                    isActive
                      ? 'bg-oe-light text-oe-dark border-oe-primary/30'
                      : 'bg-amber-50 text-amber-800 border-amber-200'
                  }`}
                >
                  {isActive ? 'Active' : 'Inactive'}
                </span>
                {latestVersion != null && latestVersion !== publishedVersion && (
                  <span className="text-xs text-gray-400">Latest draft · v{latestVersion}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className={`${fbOutlineBtn} inline-flex items-center gap-1.5`}
              >
                <Eye className="h-4 w-4" /> Preview
              </button>
              {isFreshDraft && canDelete && (
                <button
                  type="button"
                  onClick={discardForm}
                  disabled={discarding}
                  className="inline-flex items-center border border-red-300 text-red-700 bg-white hover:bg-red-50 disabled:opacity-50 px-3 py-1.5 rounded text-sm font-medium"
                >
                  {discarding ? 'Discarding…' : 'Discard draft'}
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className={fbSolidEmeraldBtn}
                >
                  {saving ? 'Saving…' : saveLabel}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Tab nav */}
        <nav className="px-6 flex gap-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`-mb-px border-b-2 pb-2 pt-1 text-sm font-medium transition-colors ${
                activeTab === t.id
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* ===== Advisory strip — cross-cutting notices, visible on every tab ===== */}
      {hasAdvisories && (
        <div className="px-6 pt-4 space-y-2">
          {!canEdit && (
            <p className="text-sm text-gray-700 bg-oe-light border border-oe-primary/30 rounded-lg px-3 py-2">
              Read-only view. Vendor agents can review form configuration and submissions but cannot
              edit, publish, or delete forms.
            </p>
          )}
          {inactiveButPublished && (
            <p className="text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
              This form is inactive — the public embed URL will not load until you activate it again
              (Setup tab).
            </p>
          )}
          {identityWarning && (
            <p className="text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm leading-relaxed">
              <span className="font-medium">Heads up. </span>
              {identityWarning}
            </p>
          )}
        </div>
      )}

      {/* ===== Tab panels ===== */}
      <div className="px-6 pt-6 space-y-6">
        {/* ---------- TAB: SETUP ---------- */}
        {activeTab === 'setup' && (
          <>
            <Section
              title="Form structure"
              description="These choices shape the Build tab — decide them first."
            >
              <label className="flex items-start gap-3 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 rounded border-gray-300"
                  checked={!!formDef.def.multiPage}
                  disabled={!canEdit}
                  onChange={(e) => formDef.toggleMultiPage(e.target.checked)}
                />
                <span>
                  <span className="text-gray-800 font-medium">Multi-page form</span>
                  <span className="block text-xs text-gray-500">
                    Group fields into pages the recipient steps through one at a time. Leave off for
                    a short single-page form.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 rounded border-gray-300"
                  checked={!!formDef.def.preScreeningEnabled}
                  disabled={!canEdit}
                  onChange={(e) => formDef.togglePreScreening(e.target.checked)}
                />
                <span>
                  <span className="text-gray-800 font-medium">Pre-screening questions</span>
                  <span className="block text-xs text-gray-500">
                    Ask a few questions up front; the answers reveal or hide pages and fields so the
                    recipient only fills in what applies to them.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 rounded border-gray-300"
                  checked={formDef.def.suggestSignIn !== false}
                  disabled={!canEdit}
                  onChange={(e) => formDef.toggleSuggestSignIn(e.target.checked)}
                />
                <span>
                  <span className="text-gray-800 font-medium">Offer sign-in to save</span>
                  <span className="block text-xs text-gray-500">
                    Invite anonymous visitors to sign in mid-form so they can autofill their details
                    and save progress to finish later. Turn off for forms that don't need a member
                    account.
                  </span>
                </span>
              </label>
            </Section>

            <Section
              title="Delivery"
              description="How this form reaches recipients, and whether it's available."
            >
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded border-gray-300"
                  checked={isActive}
                  disabled={!canEdit}
                  onChange={(e) => setIsActive(e.target.checked)}
                />
                <span className="text-gray-800 font-medium">Form is active</span>
                <span className="text-xs text-gray-500">— public links work when published</span>
              </label>

              <div className="border-t border-gray-100 pt-3 space-y-3">
                <label className="flex items-start gap-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-gray-300"
                    checked={allowAnonymous}
                    disabled={!canEdit}
                    onChange={(e) => setAllowAnonymous(e.target.checked)}
                  />
                  <span>
                    <span className="text-gray-800">Public link</span>
                    <span className="block text-xs text-gray-500">
                      Anyone with the link can fill this form. Use for non-sensitive intake.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-gray-300"
                    checked={allowTargeted}
                    disabled={!canEdit}
                    onChange={(e) => setAllowTargeted(e.target.checked)}
                  />
                  <span>
                    <span className="text-gray-800">Personal link (no login)</span>
                    <span className="block text-xs text-gray-500">
                      Care team sends this form to a member by email; the recipient does not log in.
                      Best for short forms.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-gray-300"
                    checked={allowAuthenticated}
                    disabled={!canEdit}
                    onChange={(e) => setAllowAuthenticated(e.target.checked)}
                  />
                  <span>
                    <span className="text-gray-800">Secure link (requires login)</span>
                    <span className="block text-xs text-gray-500">
                      Recipient logs into their member account; the form is prefilled from their
                      profile. Use for PHI or verified-identity forms.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 text-sm cursor-pointer pt-1 border-t border-gray-100">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-gray-300"
                    checked={createsShareRequestOnSubmit}
                    disabled={!canEdit}
                    onChange={(e) => setCreatesShareRequestOnSubmit(e.target.checked)}
                  />
                  <span>
                    <span className="text-gray-800">Auto-create a share request on submit</span>
                    <span className="block text-xs text-gray-500">
                      Each known-member submission spawns a new share request. Only for SR intake
                      forms.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-gray-300"
                    checked={createsCaseOnSubmit}
                    disabled={!canEdit}
                    onChange={(e) => setCreatesCaseOnSubmit(e.target.checked)}
                  />
                  <span>
                    <span className="text-gray-800">Auto-create a case on submit</span>
                    <span className="block text-xs text-gray-500">
                      Each known-member submission spawns a new reimbursement case. Pair with an
                      A/B pre-screen so preventative/copay submissions route here and SR submissions
                      route to the share-request flow.
                    </span>
                  </span>
                </label>
                {deliveryModeError && (
                  <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                    {deliveryModeError}
                  </p>
                )}
              </div>
            </Section>
          </>
        )}

        {/* ---------- TAB: BUILD FORM ---------- */}
        {activeTab === 'build' && (
          <PublicFormBuilder controller={formDef} formTemplateId={formTemplateId} />
        )}

        {/* ---------- TAB: ADVANCED ---------- */}
        {activeTab === 'advanced' && (
          <>
            <Section title="Routing & notifications">
              <div className="text-sm space-y-1">
                <span className="text-gray-700 font-medium inline-flex items-center gap-1.5">
                  Default vendor
                  <HelpCircle
                    className="h-3.5 w-3.5 text-gray-400"
                    aria-label="Help"
                    title={
                      "When a member submits this form we create a share request in the vendor's " +
                      'back office. Set a vendor here and every submission of this form goes to ' +
                      "that vendor, regardless of the member's other products. Leave blank to fall " +
                      "back to the member's most recent active product's vendor."
                    }
                  />
                </span>
                <p className="text-xs text-gray-500">Where share requests from this form are sent.</p>
                <select
                  className={`${inputCls} w-full bg-white mt-1`}
                  value={defaultVendorId}
                  disabled={!canEdit}
                  onChange={(e) => setDefaultVendorId(e.target.value)}
                >
                  <option value="">— No default (use member's product vendor) —</option>
                  {vendorOptions.map((v) => (
                    <option key={v.VendorId} value={v.VendorId}>
                      {v.VendorName}
                    </option>
                  ))}
                </select>
              </div>

              <div className="text-sm space-y-1 border-t border-gray-100 pt-4">
                <span className="text-gray-700 font-medium inline-flex items-center gap-1.5">
                  Resolve members across tenants
                  <HelpCircle
                    className="h-3.5 w-3.5 text-gray-400"
                    aria-label="Help"
                    title={
                      'When a member types their member ID on this form, we match it within these ' +
                      'tenants. A vendor-wide form should include every tenant whose members use it. ' +
                      "Leave empty to search only this form's own tenant."
                    }
                  />
                </span>
                <p className="text-xs text-gray-500">
                  Which tenants’ members can be matched by ID on this form — pick from the vendor’s tenants.
                </p>
                {!defaultVendorId ? (
                  <p className="text-xs text-gray-500 italic">Set a default vendor above to choose its tenants.</p>
                ) : (
                  (() => {
                    const opts = [
                      ...tenantOptions,
                      ...resolverTenantIds
                        .filter((id) => !tenantOptions.some((t) => t.tenantId === id))
                        .map((id) => ({ tenantId: id, tenantName: `${id} (not served by this vendor)` }))
                    ];
                    if (opts.length === 0) {
                      return <p className="text-xs text-gray-500 italic">No tenants found for this vendor.</p>;
                    }
                    return (
                      <div className="max-h-48 overflow-y-auto border border-gray-200 rounded divide-y divide-gray-100 mt-1">
                        {opts.map((t) => (
                          <label
                            key={t.tenantId}
                            className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              disabled={!canEdit}
                              checked={resolverTenantIds.includes(t.tenantId)}
                              onChange={(e) =>
                                setResolverTenantIds((prev) =>
                                  e.target.checked
                                    ? [...new Set([...prev, t.tenantId])]
                                    : prev.filter((x) => x !== t.tenantId)
                                )
                              }
                            />
                            <span className="text-gray-800">{t.tenantName}</span>
                          </label>
                        ))}
                      </div>
                    );
                  })()
                )}
              </div>

              <div className="text-sm space-y-2 border-t border-gray-100 pt-4">
                <span className="text-gray-700 font-medium">Email addresses to notify</span>
                <p className="text-xs text-gray-500">
                  We email these people when someone submits this form.
                </p>
                {notifyEmailsLoadWarning && (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                    {notifyEmailsLoadWarning}
                  </p>
                )}
                <div className="space-y-2">
                  {notifyEmailRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="email"
                        autoComplete="email"
                        placeholder={i === 0 ? 'hr@company.com' : 'email@company.com'}
                        className={`${inputCls} flex-1 min-w-0`}
                        value={row}
                        disabled={!canEdit}
                        onChange={(e) => {
                          const v = e.target.value;
                          setNotifyEmailRows((rows) => rows.map((r, j) => (j === i ? v : r)));
                        }}
                      />
                      {notifyEmailRows.length > 1 && canEdit ? (
                        <button
                          type="button"
                          className="shrink-0 text-xs text-red-700 hover:underline rounded px-1 py-1"
                          onClick={() =>
                            setNotifyEmailRows((rows) =>
                              rows.length <= 1 ? rows : rows.filter((_, j) => j !== i)
                            )
                          }
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  ))}
                  {canEdit && (
                    <button
                      type="button"
                      className={fbAddOptionBtn}
                      onClick={() => setNotifyEmailRows((rows) => [...rows, ''])}
                    >
                      + Add another email
                    </button>
                  )}
                </div>
              </div>
            </Section>

            <Section
              title="Embedding"
              description="Only matters if you put this form inside another website (an iframe)."
            >
              <label className="flex items-start gap-3 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="embedMode"
                  className="mt-0.5"
                  checked={embedMode === 'any'}
                  disabled={!canEdit}
                  onChange={() => setEmbedMode('any')}
                />
                <span>
                  <span className="text-gray-800">Allow embedding from any website</span>
                  <span className="block text-xs text-gray-500">
                    Less restrictive. Use only if you need it.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="embedMode"
                  className="mt-0.5"
                  checked={embedMode === 'restrict'}
                  disabled={!canEdit}
                  onChange={() => setEmbedMode('restrict')}
                />
                <span className="text-gray-800">Only these websites</span>
              </label>
              {embedMode === 'restrict' && (
                <div className="pl-6">
                  <p className="text-xs text-gray-500 mb-1">
                    One site per line (include https://).
                  </p>
                  <textarea
                    className={`${inputCls} w-full font-mono text-xs`}
                    rows={4}
                    placeholder="https://www.yourcompany.com"
                    value={embedSiteLines}
                    disabled={!canEdit}
                    onChange={(e) => setEmbedSiteLines(e.target.value)}
                  />
                </div>
              )}
            </Section>

            <Section
              title="Submission PDF"
              description="Generate and store a PDF copy of each submission."
            >
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-start gap-3 text-sm cursor-pointer flex-1">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-gray-300"
                    checked={formDef.def.submissionPdf?.enabled === true}
                    disabled={!canEdit}
                    onChange={(e) =>
                      formDef.patchDef({
                        submissionPdf: { ...formDef.def.submissionPdf, enabled: e.target.checked }
                      })
                    }
                  />
                  <span className="text-gray-700">
                    Generate a PDF for each submission and store it with the submission. Each
                    field's inspector controls whether its answer is included.
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => setPdfPreviewOpen(true)}
                  className={`${fbOutlineBtn} shrink-0`}
                >
                  Preview PDF
                </button>
              </div>
              <label className="block text-sm">
                <span className="text-gray-600">PDF letterhead — company information</span>
                <textarea
                  className={`${inputCls} w-full mt-1 min-h-[88px]`}
                  rows={4}
                  placeholder="Company name, address, phone, fax — appears below the header image on the submission PDF."
                  value={formDef.def.submissionPdf?.companyLetterhead ?? ''}
                  disabled={!canEdit}
                  onChange={(e) =>
                    formDef.patchDef({
                      submissionPdf: {
                        ...formDef.def.submissionPdf,
                        companyLetterhead: e.target.value === '' ? undefined : e.target.value
                      }
                    })
                  }
                />
              </label>
            </Section>

            <Section title="Version history">
              {versions.length === 0 ? (
                <p className="text-sm text-gray-500">No saved versions yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-500">
                        <th className="py-2 pr-2 font-medium">Ver</th>
                        <th className="py-2 pr-2 font-medium">Saved</th>
                        <th className="py-2 pr-2 font-medium">Note</th>
                        <th className="py-2 pr-2 font-medium">Status</th>
                        <th className="py-2 font-medium w-28" />
                      </tr>
                    </thead>
                    <tbody>
                      {versions.map((v) => (
                        <tr key={v.VersionId} className="border-b border-gray-100">
                          <td className="py-2 pr-2 font-mono">{v.VersionNumber}</td>
                          <td className="py-2 pr-2 whitespace-nowrap">
                            {v.CreatedDate ? new Date(v.CreatedDate).toLocaleString() : '—'}
                          </td>
                          <td className="py-2 pr-2 max-w-[200px] truncate" title={v.ChangeNote || ''}>
                            {v.ChangeNote?.trim() || '—'}
                          </td>
                          <td className="py-2 pr-2">
                            {publishedVersion === v.VersionNumber ? (
                              <span className="text-emerald-700 font-medium">Published</span>
                            ) : v.VersionNumber === latestVersion ? (
                              <span className="text-gray-600">Latest draft</span>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="py-2">
                            {canEdit && (
                              <button
                                type="button"
                                disabled={loadingVersionNumber !== null}
                                onClick={() => loadVersionIntoEditor(v.VersionNumber)}
                                className={fbLinkBlueBtn}
                              >
                                {loadingVersionNumber === v.VersionNumber
                                  ? 'Loading…'
                                  : 'Open in editor'}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {canEdit && (
                <label className="block text-sm border-t border-gray-100 pt-3">
                  <span className="text-gray-600">Change note for the next save (optional)</span>
                  <input
                    type="text"
                    placeholder="What changed in this version?"
                    className={`${inputCls} w-full mt-1`}
                    value={changeNote}
                    onChange={(e) => setChangeNote(e.target.value)}
                  />
                </label>
              )}
            </Section>

            <details className="bg-white border border-gray-200 rounded-lg">
              <summary className="cursor-pointer select-none px-6 py-4 text-sm font-medium text-gray-700">
                Raw JSON
                <span className="ml-2 font-normal text-gray-400">
                  — advanced escape hatch; edit only if you know the schema
                </span>
              </summary>
              <div className="border-t border-gray-100 p-6">
                <textarea
                  className={`${inputCls} w-full font-mono text-xs`}
                  rows={14}
                  value={definitionJson}
                  disabled={!canEdit}
                  onChange={(e) => setDefinitionJson(e.target.value)}
                />
              </div>
            </details>

            {canDelete && (
              <div className="bg-white border border-red-200 rounded-lg p-6 space-y-3">
                <div>
                  <h2 className="font-medium text-red-800">Danger zone</h2>
                  <p className="text-sm text-gray-500 mt-0.5">
                    Deletion is permanent. Forms with submissions cannot be deleted — set them
                    inactive instead.
                  </p>
                </div>
                <button type="button" onClick={deleteForm} className={fbSolidDangerOutlineBtn}>
                  Delete form
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Fixed confirmation — seen regardless of scroll position. */}
      {(message || error) && (
        <div className="fixed bottom-6 right-6 z-50 max-w-sm">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 shadow-lg">
              <p className="text-sm text-red-800 flex-1">{error}</p>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-red-500 hover:text-red-700 text-sm"
              >
                ✕
              </button>
            </div>
          )}
          {message && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-lg">
              <p className="text-sm text-emerald-800 flex-1">{message}</p>
              <button
                type="button"
                onClick={() => setMessage(null)}
                className="text-emerald-600 hover:text-emerald-800 text-sm"
              >
                ✕
              </button>
            </div>
          )}
        </div>
      )}

      <PublicFormPreviewDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        definitionJson={definitionJson}
        templateTitle={title}
      />
      <SubmissionPdfPreviewDialog
        open={pdfPreviewOpen}
        onClose={() => setPdfPreviewOpen(false)}
        definitionJson={definitionJson}
        templateTitle={title}
      />
    </div>
  );
}
