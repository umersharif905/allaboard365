// frontend/src/pages/prospects/LeadIngestModal.tsx
// Agent self-service for the lead-ingest API key: create (shown once), list, revoke,
// plus a copy-paste curl sample. Opened from the Prospects page (agent portal).

import { Copy, Key, Loader2, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useAgentApiKeys,
  useCreateAgentApiKey,
  useRevokeAgentApiKey,
} from '../../hooks/useProspects';
import { CreatedApiKey } from '../../services/prospect.service';

const INGEST_URL = 'https://api.allaboard365.com/api/lead-ingest';

export default function LeadIngestModal({ onClose }: { onClose: () => void }) {
  const { data: keys = [], isLoading } = useAgentApiKeys();
  const createMutation = useCreateAgentApiKey();
  const revokeMutation = useRevokeAgentApiKey();

  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreate = () => {
    createMutation.mutate(undefined, { onSuccess: (res) => setCreated(res) });
  };

  const copy = (text: string) => {
    window.navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const sampleCurl = `curl -X POST ${INGEST_URL} \\
  -H "Authorization: Bearer ${created?.key || 'sk_live_...'}" \\
  -H "Content-Type: application/json" \\
  -d '{"firstName":"Jane","lastName":"Doe","email":"jane@example.com","phone":"2015551234","referralName":"Website","premiumAmount":250}'`;

  const activeKeys = keys.filter((k) => k.Status === 'active');

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Key className="w-5 h-5 text-oe-primary" /> Lead Ingest API Key
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <p className="text-sm text-gray-600">
            Share this endpoint with a lead source. Leads sent with your key are attributed to you and
            de-duplicated automatically.
          </p>

          {/* Freshly created key (shown once) */}
          {created && (
            <div className="p-4 rounded-lg bg-oe-light border border-oe-primary/30 space-y-2">
              <p className="text-sm font-medium text-gray-900">New key — copy it now, it won't be shown again.</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-white border border-gray-200 rounded px-2 py-1.5 break-all">{created.key}</code>
                <button
                  onClick={() => copy(created.key)}
                  className="flex items-center gap-1 px-2 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  <Copy className="w-4 h-4" /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* Create */}
          <div>
            <button
              onClick={handleCreate}
              disabled={createMutation.isPending}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-60"
            >
              {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Generate new key
            </button>
          </div>

          {/* Existing keys */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2">Your keys</h3>
            {isLoading ? (
              <div className="flex items-center justify-center py-6 text-gray-500">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
              </div>
            ) : activeKeys.length === 0 ? (
              <p className="text-sm text-gray-500">No active keys.</p>
            ) : (
              <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                {activeKeys.map((k) => (
                  <li key={k.ApiKeyId} className="px-3 py-2 flex items-center gap-3 text-sm">
                    <code className="text-gray-700">sk_live_…{k.PartialKey}</code>
                    <span className="text-xs text-gray-400 flex-1">
                      {k.LastUsedDate ? `Last used ${new Date(k.LastUsedDate).toLocaleDateString()}` : 'Never used'}
                    </span>
                    <button
                      onClick={() => revokeMutation.mutate(k.ApiKeyId)}
                      disabled={revokeMutation.isPending}
                      className="flex items-center gap-1 text-red-600 hover:bg-red-50 rounded px-2 py-1"
                    >
                      <Trash2 className="w-4 h-4" /> Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Sample */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2">Example request</h3>
            <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">{sampleCurl}</pre>
          </div>
        </div>

        <div className="flex justify-end p-6 border-t border-gray-200">
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
