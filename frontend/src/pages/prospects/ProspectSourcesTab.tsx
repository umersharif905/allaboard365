// frontend/src/pages/prospects/ProspectSourcesTab.tsx
// "Sources" tab on the Prospects page: create/list/edit/archive named lead sources.
// Website/Landing sources expose a trackable link; API sources show a masked key.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Eye, Loader2, Pencil, Plus, Tag, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  archiveProspectSource,
  listProspectSources,
  ProspectSource,
  SourceType,
  updateProspectSource,
} from '../../services/prospect.service';
import { LEAD_INGEST_URL, sampleCurl } from './leadIngestSample';
import { getSourceColor, SOURCE_COLORS } from './sourceColors';
import SourceCreateModal from './SourceCreateModal';

const TYPE_BADGE: Record<SourceType, { label: string; className: string }> = {
  website: { label: 'Website', className: 'bg-sky-100 text-sky-800' },
  landing: { label: 'Landing', className: 'bg-violet-100 text-violet-800' },
  api: { label: 'API', className: 'bg-amber-100 text-amber-800' },
};

export default function ProspectSourcesTab() {
  const queryClient = useQueryClient();
  const { data: sources = [], isLoading } = useQuery({
    queryKey: ['prospect-sources'],
    queryFn: listProspectSources,
  });

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<ProspectSource | null>(null);
  const [viewing, setViewing] = useState<ProspectSource | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<ProspectSource | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['prospect-sources'] });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => archiveProspectSource(id),
    onSuccess: () => {
      invalidate();
      setConfirmArchive(null);
    },
  });

  const copyLink = (source: ProspectSource) => {
    if (!source.link) return;
    window.navigator.clipboard?.writeText(source.link);
    setCopiedId(source.sourceId);
    setTimeout(() => setCopiedId((cur) => (cur === source.sourceId ? null : cur)), 1500);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Sources</h2>
          <p className="text-sm text-gray-500 mt-1">
            Track where your leads come from with named website links, landing pages, and API feeds.
          </p>
        </div>
        <button
          data-testid="source-create-open"
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg whitespace-nowrap"
        >
          <Plus className="w-4 h-4" /> Create New Source
        </button>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      ) : sources.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <Tag className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">
            No sources yet. Create one to start tracking where your leads come from.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Link / Key</th>
                <th className="px-4 py-3 text-right">Leads</th>
                <th className="px-4 py-3 text-right">Enrolled</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sources.map((s) => {
                const badge = TYPE_BADGE[s.type];
                const isApi = s.type === 'api';
                const colorDef = getSourceColor(s.color);
                return (
                  <tr key={s.sourceId} data-testid="source-row" className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {colorDef && (
                          <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${colorDef.dot}`} />
                        )}
                        <span className="font-medium text-gray-900">{s.name}</span>
                        {s.isDefault && (
                          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-600">
                            Default
                          </span>
                        )}
                      </div>
                      {s.tag && (
                        <span className="inline-block mt-1 px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-600">
                          {s.tag}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded ${badge.className}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      {isApi ? (
                        <code className="text-xs text-gray-600 font-mono">
                          sk_live_…{s.apiPartialKey || '••••'}
                        </code>
                      ) : s.link ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-600 font-mono truncate" title={s.link}>
                            {s.link}
                          </span>
                          <button
                            onClick={() => copyLink(s)}
                            className="flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 flex-shrink-0"
                            aria-label="Copy link"
                          >
                            {copiedId === s.sourceId ? (
                              <Check className="w-3.5 h-3.5 text-oe-success" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-900">{s.leadCount}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-oe-success font-medium">{s.enrolledCount}</span>
                      {s.leadCount > 0 && (
                        <span className="text-xs text-gray-400 ml-1">
                          ({Math.round((s.enrolledCount / s.leadCount) * 100)}%)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {isApi && (
                          <button
                            onClick={() => setViewing(s)}
                            className="flex items-center gap-1 px-2 py-1 text-gray-600 hover:bg-gray-100 rounded"
                            aria-label="View API source"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => setEditing(s)}
                          className="flex items-center gap-1 px-2 py-1 text-gray-600 hover:bg-gray-100 rounded"
                          aria-label="Edit source"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        {!s.isDefault && (
                          <button
                            onClick={() => setConfirmArchive(s)}
                            className="flex items-center gap-1 px-2 py-1 text-red-600 hover:bg-red-50 rounded"
                            aria-label="Archive source"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create */}
      <SourceCreateModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={invalidate}
      />

      {/* Edit */}
      {editing && (
        <SourceEditModal source={editing} onClose={() => setEditing(null)} onSaved={invalidate} />
      )}

      {/* View (API source detail) */}
      {viewing && (
        <ApiSourceViewModal
          source={viewing}
          onClose={() => setViewing(null)}
          onRevoke={() => {
            setViewing(null);
            setConfirmArchive(viewing);
          }}
        />
      )}

      {/* Archive confirm */}
      {confirmArchive && (
        <ConfirmPopup
          title={confirmArchive.type === 'api' ? 'Revoke this API key?' : 'Archive this source?'}
          message={
            confirmArchive.type === 'api'
              ? 'The key will stop working immediately and cannot be recovered.'
              : 'Its link/key will stop working.'
          }
          confirmLabel={
            archiveMutation.isPending
              ? confirmArchive.type === 'api'
                ? 'Revoking…'
                : 'Archiving…'
              : confirmArchive.type === 'api'
              ? 'Revoke'
              : 'Archive'
          }
          pending={archiveMutation.isPending}
          onCancel={() => setConfirmArchive(null)}
          onConfirm={() => archiveMutation.mutate(confirmArchive.sourceId)}
        />
      )}
    </div>
  );
}

// --- Inline edit modal (name + tag only) ---
function SourceEditModal({
  source,
  onClose,
  onSaved,
}: {
  source: ProspectSource;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(source.name);
  const [tag, setTag] = useState(source.tag || '');
  const [color, setColor] = useState<string | null>(source.color || null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      updateProspectSource(source.sourceId, {
        name: name.trim(),
        tag: tag.trim() || undefined,
        color: color || undefined,
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError((err as { message?: string } | undefined)?.message || 'Failed to update source.'),
  });

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Edit Source</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name <span className="text-red-600">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tag (optional)</label>
            <input
              type="text"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Color (optional)</label>
            <div className="flex flex-wrap items-center gap-2">
              {SOURCE_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setColor((cur) => (cur === c.key ? null : c.key))}
                  title={c.label}
                  aria-label={c.label}
                  aria-pressed={color === c.key}
                  className={`w-7 h-7 rounded-full ${c.dot} transition-transform hover:scale-110 ${
                    color === c.key
                      ? 'ring-2 ring-offset-2 ring-oe-primary'
                      : 'ring-1 ring-gray-200'
                  }`}
                />
              ))}
            </div>
          </div>
          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">{error}</p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                setError(null);
                mutation.mutate();
              }}
              disabled={mutation.isPending || !name.trim()}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-60"
            >
              {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              {mutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

// --- API source detail (endpoint + sample curl + masked key + revoke) ---
function ApiSourceViewModal({
  source,
  onClose,
  onRevoke,
}: {
  source: ProspectSource;
  onClose: () => void;
  onRevoke: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, what: string) => {
    window.navigator.clipboard?.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied((cur) => (cur === what ? null : cur)), 1500);
  };

  // Full key is only shown at creation; here we render the masked partial placeholder.
  const maskedKey = `sk_live_…${source.apiPartialKey || '••••'}`;

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">{source.name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <p className="text-sm text-gray-600">
            Share this endpoint with a lead source. Leads sent with this key are attributed to you
            and de-duplicated automatically.
          </p>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Endpoint</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-2 break-all font-mono">
                {LEAD_INGEST_URL}
              </code>
              <button
                onClick={() => copy(LEAD_INGEST_URL, 'url')}
                className="flex items-center gap-1 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                {copied === 'url' ? <Check className="w-4 h-4 text-oe-success" /> : <Copy className="w-4 h-4" />}
                {copied === 'url' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">API key</label>
            <code className="block text-xs bg-gray-50 border border-gray-200 rounded px-2 py-2 font-mono text-gray-600">
              {maskedKey}
            </code>
            <p className="text-xs text-gray-400 mt-1">
              The full key is only shown once at creation. Revoke and recreate if you&apos;ve lost it.
            </p>
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2">Example request</h3>
            <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
              {sampleCurl(maskedKey)}
            </pre>
          </div>
        </div>

        <div className="flex justify-between items-center p-6 border-t border-gray-200">
          <button
            onClick={onRevoke}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 border border-red-200 rounded-lg"
          >
            <Trash2 className="w-4 h-4" /> Revoke key
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

// --- Small inline confirm popup ---
function ConfirmPopup({
  title,
  message,
  confirmLabel,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Close on Escape for keyboard accessibility.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-sm p-6 space-y-4">
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
        <p className="text-sm text-gray-600">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={pending}
            className="px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 border border-red-200 rounded-lg disabled:opacity-60"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
