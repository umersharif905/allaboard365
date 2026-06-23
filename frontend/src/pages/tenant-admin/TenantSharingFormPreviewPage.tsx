import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { apiService, withTenantScope } from '../../services/api.service';
import { usePublicFormsContext } from '../../hooks/usePublicFormsContext';
import { PublicFormView } from '../../components/public/PublicFormView';

type PreviewPayload = {
  formTemplateId: string;
  title: string;
  definition: Parameters<typeof PublicFormView>[0]['definition'];
  versionNumber: number | null;
  isDraftPreview: boolean;
};

export default function TenantSharingFormPreviewPage() {
  const { formTemplateId } = useParams<{ formTemplateId: string }>();
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const tenantReq = useMemo(() => withTenantScope(activeTenantId), [activeTenantId]);
  const { apiBase, routeBase } = usePublicFormsContext();

  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!formTemplateId) {
      setError('Missing form template id');
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiService.get<{
          success: boolean;
          data: PreviewPayload;
          message?: string;
        }>(`${apiBase}/templates/${formTemplateId}/preview-payload`, tenantReq);
        if (cancelled) return;
        if (res.success) {
          setPayload(res.data);
        } else {
          setError(res.message || 'Unable to load preview');
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Unable to load preview');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, formTemplateId, tenantReq]);

  return (
    <div className="min-h-screen bg-gray-50">
      <div
        className="mx-auto p-6 space-y-4"
        // Back-office review: use nearly the full window width so the form
        // renders like a desktop page, not a cramped mobile column. Capped at
        // 1600px so it stays readable on ultrawide monitors. PublicFormView's
        // own card chrome is what the recipient sees — wrapping it in a second
        // white container produced a confusing double-card.
        style={{ maxWidth: 'min(96vw, 1600px)', minWidth: 0 }}
      >
        <div className="flex items-center justify-between gap-4">
          <Link
            to={routeBase}
            className="inline-flex items-center gap-1.5 text-sm text-oe-primary hover:text-oe-dark"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to forms
          </Link>
          <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-oe-light text-oe-dark">
            Preview only — no submit
          </span>
        </div>

        {payload?.isDraftPreview && (
          <div className="rounded border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 text-sm flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Previewing an unpublished draft (version {payload.versionNumber ?? '—'}). The live
              form may differ until this version is published.
            </span>
          </div>
        )}

        {loading && <p className="text-sm text-gray-500">Loading preview…</p>}
        {error && (
          <div className="rounded border border-red-200 bg-red-50 text-red-800 px-3 py-2 text-sm">
            {error}
          </div>
        )}

        {!loading && !error && payload && (
          <PublicFormView
            definition={payload.definition}
            pageTitle={payload.title}
            previewMode
          />
        )}
      </div>
    </div>
  );
}
