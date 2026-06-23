import { CheckCircle, Circle, Info, Loader2, Upload } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  E123AgentTreeSnapshotStatus,
  E123CatalogSnapshotStatus,
  E123GroupsListSnapshotStatus,
  E123PayablesSnapshotStatus,
  e123MigrationService
} from '../../../services/e123Migration.service';

const PRODUCT_EXPORT_SLOTS = [
  {
    id: 'setup',
    kind: 'setup',
    label: 'Product Information',
    helpText:
      'E123 → Products tab → export menu → Product Information. CSV with product setup, rules, categories, and enrollment configuration.',
    accept: '.csv,text/csv'
  },
  {
    id: 'pricing',
    kind: 'pricing',
    label: 'Pricing Matrix',
    helpText:
      'E123 → Products tab → export menu → Pricing Matrix. CSV with MSRP tiers, benefit IDs, and age bands.',
    accept: '.csv,text/csv'
  },
  {
    id: 'vendorCosts',
    kind: 'vendorCosts',
    label: 'Vendor Costs',
    helpText:
      'E123 → Products tab → export menu → Vendor Costs. CSV with net rates, fees, and vendor cost breakdowns.',
    accept: '.csv,text/csv'
  },
  {
    id: 'fulfillment',
    kind: 'fulfillment',
    label: 'Vendor Products',
    helpText:
      'E123 → Products tab → export menu → Vendor Products. CSV with fulfillment vendors and eligibility configuration.',
    accept: '.csv,text/csv'
  },
  {
    id: 'content',
    kind: 'content',
    label: 'Product Content',
    helpText:
      'E123 → Products tab → export menu → Product Content. CSV with documents, SOBs, and member portal content references.',
    accept: '.csv,text/csv'
  }
] as const;

const AGENT_TREE_SLOT = {
  id: 'agentTree',
  label: 'Agent Tree',
  helpText:
    'E123 → Agents area → export Agent Tree (.xls), or use the SFTP nightly export Agent_Full_*.csv. Required for the member import agent picker.',
  accept: '.csv,.xls,.xlsx,text/csv,application/vnd.ms-excel'
} as const;

const PAYABLES_DETAIL_SLOT = {
  id: 'payablesDetail',
  label: 'Payables Detail',
  helpText:
    'E123 → Payables → export Payables Detail for the most recent full calendar month (e.g. 1552_payables_detail_*.csv). Used for agent ACH and commission tier hints during agent migration.',
  accept: '.csv,text/csv'
} as const;

const GROUPS_LIST_SLOT = {
  id: 'groupsList',
  label: 'Groups List (Invoices)',
  helpText:
    'E123 → Invoices → View Groups → Export List (.csv). Authoritative list-bill groups with ID, contact, address, email, and member Count. Required for group migration (alongside Agent Tree). EIN/Tax ID: enrich via v2 agents API at apply time if not in export.',
  accept: '.csv,text/csv'
} as const;

function isAgentTreeExportFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return /agenttree|agent_full|agent full/.test(name) || (name.endsWith('.xls') && !name.includes('_product_'));
}

function isPayablesDetailExportFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return /payables.*detail|payables_detail|_payables_detail_/.test(name);
}

function isGroupsListExportFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return /groups.*list|group_list|view.?groups|sharewell.*groups|listbilling.*groups/.test(name)
    || (name.includes('groups') && name.endsWith('.csv') && !name.includes('member'));
}

function InfoTip({ text }: { text: string }) {
  return (
    <span className="relative inline-flex group">
      <Info
        className="h-4 w-4 text-gray-400 hover:text-gray-600 cursor-help shrink-0"
        aria-label="How to get this file"
      />
      <span
        role="tooltip"
        className="pointer-events-none invisible group-hover:visible absolute right-0 top-full z-20 mt-1 w-64 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 shadow-lg"
      >
        {text}
      </span>
    </span>
  );
}

interface Props {
  instanceId?: string | null;
  onImported?: () => void;
  compact?: boolean;
}

export default function E123CatalogUploadPanel({ instanceId = null, onImported, compact = false }: Props) {
  const batchInputRef = useRef<HTMLInputElement>(null);
  const rowInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const [catalogStatus, setCatalogStatus] = useState<E123CatalogSnapshotStatus | null>(null);
  const [agentTreeStatus, setAgentTreeStatus] = useState<E123AgentTreeSnapshotStatus | null>(null);
  const [payablesStatus, setPayablesStatus] = useState<E123PayablesSnapshotStatus | null>(null);
  const [groupsListStatus, setGroupsListStatus] = useState<E123GroupsListSnapshotStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [uploadingSlot, setUploadingSlot] = useState<string | null>(null);
  const [batchUploading, setBatchUploading] = useState(false);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setError(null);
    try {
      const [catalogRes, treeRes, payablesRes, groupsListRes] = await Promise.all([
        e123MigrationService.getE123CatalogStatus(undefined, instanceId),
        instanceId ? e123MigrationService.getAgentTreeStatus(instanceId) : Promise.resolve(null),
        instanceId ? e123MigrationService.getPayablesStatus(instanceId) : Promise.resolve(null),
        instanceId ? e123MigrationService.getGroupsListStatus(instanceId) : Promise.resolve(null)
      ]);

      if (treeRes?.success && treeRes.data) setAgentTreeStatus(treeRes.data);
      else if (!instanceId) setAgentTreeStatus(null);

      if (payablesRes?.success && payablesRes.data) setPayablesStatus(payablesRes.data);
      else if (!instanceId) setPayablesStatus(null);

      if (groupsListRes?.success && groupsListRes.data) setGroupsListStatus(groupsListRes.data);
      else if (!instanceId) setGroupsListStatus(null);

      const treeRootBrokerId = treeRes?.success ? treeRes.data?.latestExport?.rootBrokerId : undefined;
      const catalogHasManifest = Boolean(
        catalogRes.success
        && catalogRes.data?.latestExport?.fileManifest?.some((m) => m.kind !== 'unknown')
      );

      let resolvedCatalog = catalogRes;
      if (
        !catalogHasManifest
        && treeRootBrokerId
        && catalogRes.success
      ) {
        resolvedCatalog = await e123MigrationService.getE123CatalogStatus(treeRootBrokerId, instanceId);
      }

      if (resolvedCatalog.success && resolvedCatalog.data) setCatalogStatus(resolvedCatalog.data);
    } catch (err: unknown) {
      setCatalogStatus(null);
      setAgentTreeStatus(null);
      setPayablesStatus(null);
      setGroupsListStatus(null);
      setError(err instanceof Error ? err.message : 'Failed to load export status');
    } finally {
      setStatusLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const latestCatalog = catalogStatus?.latestExport;
  const latestAgentTree = agentTreeStatus?.latestExport;
  const latestPayables = payablesStatus?.latestExport;
  const latestGroupsList = groupsListStatus?.latestExport;
  const manifestByKind = new Map(
    (latestCatalog?.fileManifest ?? []).filter((m) => m.kind !== 'unknown').map((m) => [m.kind, m])
  );
  const hasStagedAgentTree = Boolean(latestAgentTree && (agentTreeStatus?.nodeCount ?? 0) > 0);
  const hasStagedPayables = Boolean(payablesStatus?.configured && (payablesStatus?.agentCount ?? 0) > 0);
  const hasStagedGroupsList = Boolean(groupsListStatus?.configured && (groupsListStatus?.groupCount ?? 0) > 0);

  const importFiles = async (files: File[], slotHint?: string) => {
    const payablesFiles = files.filter(isPayablesDetailExportFile);
    const groupsListFiles = files.filter(isGroupsListExportFile);
    const agentTreeFiles = files.filter((f) => isAgentTreeExportFile(f) && !isPayablesDetailExportFile(f) && !isGroupsListExportFile(f));
    const productFiles = files.filter(
      (file) => !isAgentTreeExportFile(file) && !isPayablesDetailExportFile(file) && !isGroupsListExportFile(file)
    );

    if (slotHint === 'agentTree') {
      if (!agentTreeFiles.length) {
        throw new Error('Select an Agent Tree (.xls) or Agent_Full (.csv) file.');
      }
      if (!instanceId) throw new Error('Select a migration instance first.');
      const treeRes = await e123MigrationService.importAgentTree(agentTreeFiles[0], instanceId);
      if (!treeRes.success || !treeRes.data) throw new Error(treeRes.message || 'Agent tree import failed');
      return `Agent tree imported (${treeRes.data.nodeCount} agents).`;
    }

    if (slotHint === 'groupsList') {
      if (!groupsListFiles.length) {
        throw new Error('Select a Groups List CSV from E123 Invoices → View Groups → Export List.');
      }
      if (!instanceId) throw new Error('Select a migration instance first.');
      const groupsRes = await e123MigrationService.importGroupsList(groupsListFiles[0], instanceId);
      if (!groupsRes.success || !groupsRes.data) throw new Error(groupsRes.message || 'Groups list import failed');
      return `Groups list imported (${groupsRes.data.groupCount} groups).`;
    }

    if (slotHint === 'payablesDetail') {
      if (!payablesFiles.length) {
        throw new Error('Select a payables detail CSV (filename usually contains payables_detail).');
      }
      if (!instanceId) throw new Error('Select a migration instance first.');
      const payRes = await e123MigrationService.importPayables(payablesFiles[0], instanceId);
      if (!payRes.success || !payRes.data) throw new Error(payRes.message || 'Payables import failed');
      const month = payRes.data.dominantMonth ? ` · month ${payRes.data.dominantMonth}` : '';
      return `Payables detail imported (${payRes.data.agentCount} agents${month}).`;
    }

    if (slotHint && slotHint !== 'agentTree' && slotHint !== 'payablesDetail' && slotHint !== 'groupsList' && productFiles.length === 1) {
      const catalogRes = await e123MigrationService.importE123Catalog(productFiles, undefined, instanceId);
      if (!catalogRes.success || !catalogRes.data) throw new Error(catalogRes.message || 'Import failed');
      const slot = PRODUCT_EXPORT_SLOTS.find((s) => s.id === slotHint);
      return `${slot?.label || 'File'} imported.`;
    }

    if (agentTreeFiles.length && !instanceId) {
      throw new Error('Select a migration instance before uploading an agent tree.');
    }
    if (agentTreeFiles.length > 1) {
      throw new Error('Include only one agent tree file per upload.');
    }
    if (payablesFiles.length > 1) {
      throw new Error('Include only one payables detail file per upload.');
    }

    if (groupsListFiles.length > 1) {
      throw new Error('Include only one groups list file per upload.');
    }

    const messages: string[] = [];
    if (groupsListFiles.length && instanceId) {
      const groupsRes = await e123MigrationService.importGroupsList(groupsListFiles[0], instanceId);
      if (!groupsRes.success || !groupsRes.data) throw new Error(groupsRes.message || 'Groups list import failed');
      messages.push(`Groups list (${groupsRes.data.groupCount} groups)`);
    }
    if (payablesFiles.length && instanceId) {
      const payRes = await e123MigrationService.importPayables(payablesFiles[0], instanceId);
      if (!payRes.success || !payRes.data) throw new Error(payRes.message || 'Payables import failed');
      messages.push(`Payables detail (${payRes.data.agentCount} agents)`);
    }
    if (agentTreeFiles.length && instanceId) {
      const treeRes = await e123MigrationService.importAgentTree(agentTreeFiles[0], instanceId);
      if (!treeRes.success || !treeRes.data) throw new Error(treeRes.message || 'Agent tree import failed');
      messages.push(`Agent tree (${treeRes.data.nodeCount} agents)`);
    }
    if (productFiles.length) {
      const catalogRes = await e123MigrationService.importE123Catalog(productFiles, undefined, instanceId);
      if (!catalogRes.success || !catalogRes.data) throw new Error(catalogRes.message || 'Product import failed');
      messages.push(`${productFiles.length} product file${productFiles.length === 1 ? '' : 's'}`);
    }
    if (!messages.length) throw new Error('No recognized E123 export files selected.');
    return `Imported ${messages.join(' and ')}.`;
  };

  const handleRowUpload = async (slotId: string, fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setUploadingSlot(slotId);
    setError(null);
    setSuccessMessage(null);
    try {
      const msg = await importFiles([file], slotId);
      setSuccessMessage(msg);
      await loadStatus();
      onImported?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setUploadingSlot(null);
      const input = rowInputRefs.current[slotId];
      if (input) input.value = '';
    }
  };

  const handleBatchUpload = async () => {
    if (!batchFiles.length) {
      setError('Select one or more E123 export files first.');
      return;
    }
    setBatchUploading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const msg = await importFiles(batchFiles);
      setSuccessMessage(msg);
      setBatchFiles([]);
      if (batchInputRef.current) batchInputRef.current.value = '';
      await loadStatus();
      onImported?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBatchUploading(false);
    }
  };

  const renderRow = (opts: {
    slotId: string;
    label: string;
    helpText: string;
    accept: string;
    uploaded: boolean;
    detail?: string;
    disabled?: boolean;
  }) => {
    const busy = uploadingSlot === opts.slotId;
    return (
      <div
        key={opts.slotId}
        className="flex flex-col sm:flex-row sm:items-center gap-3 py-3 border-b border-gray-100 last:border-b-0"
      >
        <div className="flex items-start gap-3 min-w-0 flex-1">
          {opts.uploaded ? (
            <CheckCircle className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
          ) : (
            <Circle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-900 text-sm">{opts.label}</span>
              <InfoTip text={opts.helpText} />
            </div>
            {opts.detail ? (
              <p className="text-xs text-gray-500 mt-0.5 truncate" title={opts.detail}>
                {opts.detail}
              </p>
            ) : (
              <p className="text-xs text-amber-700 mt-0.5">Not uploaded yet</p>
            )}
          </div>
        </div>
        <div className="shrink-0 sm:pl-4">
          <input
            ref={(el) => { rowInputRefs.current[opts.slotId] = el; }}
            type="file"
            accept={opts.accept}
            className="hidden"
            disabled={opts.disabled || busy}
            onChange={(e) => void handleRowUpload(opts.slotId, e.target.files)}
          />
          <button
            type="button"
            disabled={opts.disabled || busy}
            onClick={() => rowInputRefs.current[opts.slotId]?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {opts.uploaded ? 'Replace' : 'Upload'}
          </button>
        </div>
      </div>
    );
  };

  const productCount = catalogStatus?.productCount ?? latestCatalog?.productCount ?? 0;
  const agentCount = agentTreeStatus?.nodeCount ?? latestAgentTree?.nodeCount ?? 0;
  const payablesAgentCount = payablesStatus?.agentCount ?? latestPayables?.agentCount ?? 0;
  const groupsListCount = groupsListStatus?.groupCount ?? latestGroupsList?.groupCount ?? 0;

  return (
    <div className={`bg-white rounded-lg border border-gray-200 ${compact ? 'p-4 mb-4' : 'p-6 mb-6'}`}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">E123 migration data</h2>
          <p className="text-sm text-gray-600 mt-1 max-w-3xl">
            Upload exports from your E123 portal for this migration. Each file is staged separately — upload
            one at a time or use batch import below.
          </p>
        </div>
        {!statusLoading && (productCount > 0 || agentCount > 0 || payablesAgentCount > 0 || groupsListCount > 0) ? (
          <div className="shrink-0 text-right text-xs text-gray-500 space-y-1">
            {productCount > 0 ? (
              <div className="text-green-700 font-medium">{productCount} products staged</div>
            ) : null}
            {agentCount > 0 ? (
              <div className="text-green-700 font-medium">{agentCount} agents staged</div>
            ) : null}
            {groupsListCount > 0 ? (
              <div className="text-green-700 font-medium">{groupsListCount} groups staged</div>
            ) : null}
            {payablesAgentCount > 0 ? (
              <div className="text-green-700 font-medium">{payablesAgentCount} payables agents</div>
            ) : null}
          </div>
        ) : null}
      </div>

      {statusLoading ? (
        <div className="py-8 text-sm text-gray-500 inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading export status…
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 px-4">
          {instanceId ? (
            <>
              {!compact ? (
                <div className="py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Agents &amp; hierarchy
                </div>
              ) : null}
              {renderRow({
                slotId: AGENT_TREE_SLOT.id,
                label: AGENT_TREE_SLOT.label,
                helpText: AGENT_TREE_SLOT.helpText,
                accept: AGENT_TREE_SLOT.accept,
                uploaded: hasStagedAgentTree,
                detail: hasStagedAgentTree && latestAgentTree
                  ? `${latestAgentTree.fileName || 'Uploaded'} · ${agentCount} agents · root ${latestAgentTree.rootBrokerId}`
                  : undefined
              })}
              {renderRow({
                slotId: PAYABLES_DETAIL_SLOT.id,
                label: PAYABLES_DETAIL_SLOT.label,
                helpText: PAYABLES_DETAIL_SLOT.helpText,
                accept: PAYABLES_DETAIL_SLOT.accept,
                uploaded: hasStagedPayables,
                detail: hasStagedPayables && latestPayables
                  ? `${latestPayables.fileName || 'Uploaded'} · ${payablesAgentCount} agents${
                      latestPayables.dominantMonth ? ` · ${latestPayables.dominantMonth}` : ''
                    }`
                  : undefined
              })}
              {renderRow({
                slotId: GROUPS_LIST_SLOT.id,
                label: GROUPS_LIST_SLOT.label,
                helpText: GROUPS_LIST_SLOT.helpText,
                accept: GROUPS_LIST_SLOT.accept,
                uploaded: hasStagedGroupsList,
                detail: hasStagedGroupsList && latestGroupsList
                  ? `${latestGroupsList.fileName || 'Uploaded'} · ${groupsListCount} groups`
                  : undefined
              })}
            </>
          ) : null}

          {!compact || !instanceId ? (
            <div className={`py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 ${instanceId ? 'border-t border-gray-100 mt-0' : ''}`}>
              Product catalog
            </div>
          ) : null}

          {PRODUCT_EXPORT_SLOTS.map((slot) => {
            const manifest = manifestByKind.get(slot.kind);
            return renderRow({
              slotId: slot.id,
              label: slot.label,
              helpText: slot.helpText,
              accept: slot.accept,
              uploaded: !!manifest,
              detail: manifest
                ? `${manifest.originalName || 'Uploaded'} · ${manifest.rowCount} rows`
                : undefined
            });
          })}
        </div>
      )}

      {successMessage ? (
        <div className="mt-4 text-sm text-green-800 bg-green-50 border border-green-100 rounded-md px-3 py-2">
          {successMessage}
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </div>
      ) : null}

      {!compact ? (
        <div className="mt-6 pt-5 border-t border-gray-200">
          <p className="text-sm font-medium text-gray-900 mb-1">Upload all at once</p>
          <p className="text-xs text-gray-500 mb-3">
            Select multiple E123 exports in one step — product CSVs, agent tree, groups list, and payables detail files are routed automatically.
          </p>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <input
              ref={batchInputRef}
              type="file"
              accept={instanceId ? '.csv,.xls,.xlsx,text/csv,application/vnd.ms-excel' : '.csv,text/csv'}
              multiple
              disabled={batchUploading}
              onChange={(e) => {
                setBatchFiles(e.target.files ? Array.from(e.target.files) : []);
                setError(null);
              }}
              className="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
            />
            <button
              type="button"
              onClick={() => void handleBatchUpload()}
              disabled={batchUploading || !batchFiles.length}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 shrink-0"
            >
              {batchUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {batchUploading ? 'Importing…' : 'Import all'}
            </button>
          </div>
          {batchFiles.length > 0 ? (
            <p className="text-xs text-gray-500 mt-2">
              {batchFiles.length} file{batchFiles.length === 1 ? '' : 's'}: {batchFiles.map((f) => f.name).join(', ')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
