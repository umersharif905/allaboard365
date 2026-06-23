import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, Copy, FolderOpen, Loader2 } from 'lucide-react';
import { apiService } from '../../services/api.service';
import { MarketingFolderTree, MarketingResourcesService } from '../../services/marketing-resources.service';

interface TenantOption {
  TenantId: string;
  Name: string;
}

interface TenantListResponse {
  success: boolean;
  data?: TenantOption[];
  message?: string;
}

const MarketingResourceCopy: React.FC = () => {
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(true);
  const [tenantsError, setTenantsError] = useState<string | null>(null);

  const [sourceTenantId, setSourceTenantId] = useState('');
  const [targetTenantId, setTargetTenantId] = useState('');

  const [sourceFolders, setSourceFolders] = useState<MarketingFolderTree[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<{ count: number; targetName: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setTenantsLoading(true);
        const res = await apiService.get<TenantListResponse>('/api/tenants?lightweight=true');
        if (!cancelled) {
          if (res.success && Array.isArray(res.data)) {
            const sorted = [...res.data].sort((a, b) => a.Name.localeCompare(b.Name));
            setTenants(sorted);
          } else {
            setTenantsError(res.message || 'Failed to load tenants');
          }
        }
      } catch (err) {
        if (!cancelled) {
          setTenantsError(err instanceof Error ? err.message : 'Failed to load tenants');
        }
      } finally {
        if (!cancelled) setTenantsLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSelectedFolderIds(new Set());
    setSubmitResult(null);
    setSubmitError(null);
    if (!sourceTenantId) {
      setSourceFolders([]);
      setSourceError(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        setSourceLoading(true);
        setSourceError(null);
        const folders = await MarketingResourcesService.getTenantLibraryAsSysadmin(sourceTenantId);
        if (!cancelled) setSourceFolders(folders);
      } catch (err) {
        if (!cancelled) {
          setSourceError(err instanceof Error ? err.message : 'Failed to load source library');
          setSourceFolders([]);
        }
      } finally {
        if (!cancelled) setSourceLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [sourceTenantId]);

  const targetTenantOptions = useMemo(
    () => tenants.filter((t) => t.TenantId !== sourceTenantId),
    [tenants, sourceTenantId]
  );

  const targetTenantName = useMemo(
    () => tenants.find((t) => t.TenantId === targetTenantId)?.Name || '',
    [tenants, targetTenantId]
  );

  const toggleFolder = (folderId: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const allSelected = sourceFolders.length > 0 && selectedFolderIds.size === sourceFolders.length;
  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedFolderIds(new Set());
    } else {
      setSelectedFolderIds(new Set(sourceFolders.map((f) => f.folderId)));
    }
  };

  const canSubmit =
    !!sourceTenantId &&
    !!targetTenantId &&
    sourceTenantId !== targetTenantId &&
    selectedFolderIds.size > 0 &&
    !submitting;

  const handleCopy = async () => {
    if (!canSubmit) return;
    const folderIds = [...selectedFolderIds];
    const totalResources = sourceFolders
      .filter((f) => selectedFolderIds.has(f.folderId))
      .reduce((sum, f) => sum + (f.resources?.length || 0), 0);
    const ok = window.confirm(
      `Copy ${folderIds.length} folder(s) and ${totalResources} resource(s) into "${targetTenantName}"? ` +
        `This creates independent copies — files will be duplicated and editing the source later will not change them.`
    );
    if (!ok) return;
    try {
      setSubmitting(true);
      setSubmitError(null);
      setSubmitResult(null);
      const result = await MarketingResourcesService.copyFoldersBetweenTenants({
        sourceTenantId,
        targetTenantId,
        folderIds
      });
      setSubmitResult({ count: result.copiedFolderCount, targetName: targetTenantName });
      setSelectedFolderIds(new Set());
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Copy failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
          <Copy className="h-6 w-6 text-oe-primary" />
          Copy Marketing Library Between Tenants
        </h1>
        <p className="text-sm text-gray-600 mt-1 max-w-3xl">
          Duplicate selected folders (and their files and links) from one tenant&apos;s marketing library into
          another. Each copy is independent — new ids, new file uploads, new blobs. Editing or deleting on the
          source later will not affect the target.
        </p>
      </div>

      {tenantsError && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-4 mb-4 flex items-center gap-2">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          <span>{tenantsError}</span>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-[1fr,auto,1fr] gap-4 items-end">
          <label className="text-sm font-medium text-gray-700 block">
            Source tenant
            <select
              value={sourceTenantId}
              onChange={(e) => setSourceTenantId(e.target.value)}
              disabled={tenantsLoading}
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="">{tenantsLoading ? 'Loading…' : 'Select source tenant'}</option>
              {tenants.map((t) => (
                <option key={t.TenantId} value={t.TenantId}>
                  {t.Name}
                </option>
              ))}
            </select>
          </label>

          <div className="hidden md:flex items-center justify-center pb-2 text-gray-400">
            <ArrowRight className="h-5 w-5" />
          </div>

          <label className="text-sm font-medium text-gray-700 block">
            Target tenant
            <select
              value={targetTenantId}
              onChange={(e) => setTargetTenantId(e.target.value)}
              disabled={tenantsLoading || !sourceTenantId}
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="">{!sourceTenantId ? 'Pick a source first' : 'Select target tenant'}</option>
              {targetTenantOptions.map((t) => (
                <option key={t.TenantId} value={t.TenantId}>
                  {t.Name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <FolderOpen className="h-5 w-5 text-gray-500" />
            Folders to copy
          </h2>
          {sourceFolders.length > 0 && (
            <button
              type="button"
              onClick={toggleSelectAll}
              className="text-sm text-oe-primary hover:underline"
            >
              {allSelected ? 'Clear selection' : 'Select all'}
            </button>
          )}
        </div>

        {!sourceTenantId ? (
          <p className="text-sm text-gray-500">Select a source tenant to see its folders.</p>
        ) : sourceLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading source library…
          </div>
        ) : sourceError ? (
          <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 text-sm flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span>{sourceError}</span>
          </div>
        ) : sourceFolders.length === 0 ? (
          <p className="text-sm text-gray-500">This tenant has no marketing folders.</p>
        ) : (
          <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
            {sourceFolders.map((f) => {
              const checked = selectedFolderIds.has(f.folderId);
              const fileCount = f.resources?.filter((r) => r.resourceType === 'file').length || 0;
              const linkCount = f.resources?.filter((r) => r.resourceType === 'link').length || 0;
              return (
                <li key={f.folderId} className="p-3 flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleFolder(f.folderId)}
                    className="mt-1 h-4 w-4"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate flex items-center gap-2">
                      {f.name}
                      {f.hideFromAgents && (
                        <span className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-gray-100 text-gray-600">
                          Hidden from agents
                        </span>
                      )}
                    </div>
                    {f.description && (
                      <div className="text-xs text-gray-500 mt-0.5 truncate">{f.description}</div>
                    )}
                    <div className="text-xs text-gray-500 mt-1">
                      {fileCount} file{fileCount === 1 ? '' : 's'} · {linkCount} link{linkCount === 1 ? '' : 's'}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {submitError && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-4 mb-4 flex items-center gap-2">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          <span>{submitError}</span>
        </div>
      )}

      {submitResult && (
        <div className="rounded-lg bg-green-50 border border-green-200 text-green-800 p-4 mb-4 flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
          <span>
            Copied {submitResult.count} folder{submitResult.count === 1 ? '' : 's'} into &quot;{submitResult.targetName}
            &quot;.
          </span>
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleCopy}
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed text-sm"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
          {submitting
            ? 'Copying…'
            : `Copy ${selectedFolderIds.size || ''} folder${selectedFolderIds.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
};

export default MarketingResourceCopy;
