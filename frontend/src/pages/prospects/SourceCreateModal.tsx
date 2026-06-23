// frontend/src/pages/prospects/SourceCreateModal.tsx
// Agent self-service modal to create a lead Source. Website/Landing sources mint a
// trackable link to a tenant-configured destination; API sources mint a one-time key.

import { AlertTriangle, Check, Copy, Loader2, Tag, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiService } from '../../services/api.service';
import {
  createProspectSource,
  CreateSourceResult,
  SourceType,
} from '../../services/prospect.service';
import { LEAD_INGEST_URL, sampleCurl } from './leadIngestSample';
import { SOURCE_COLORS } from './sourceColors';

interface Destination {
  type: 'website' | 'landing';
  label: string;
  url: string;
}

interface MarketingLinkResponse {
  success: boolean;
  data?: {
    destinations?: Destination[];
  };
}

const TYPE_OPTIONS: { value: SourceType; label: string }[] = [
  { value: 'website', label: 'Website' },
  { value: 'landing', label: 'Landing Page' },
  { value: 'api', label: 'API feed' },
];

export default function SourceCreateModal({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [type, setType] = useState<SourceType>('website');
  const [color, setColor] = useState<string | null>(null);
  const [destinationLabel, setDestinationLabel] = useState('');

  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [loadingDestinations, setLoadingDestinations] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateSourceResult | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset on open.
  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setTag('');
    setType('website');
    setColor(null);
    setDestinationLabel('');
    setError(null);
    setResult(null);
    setCopied(false);
  }, [isOpen]);

  // Fetch destinations when the modal opens (needed for website/landing types).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoadingDestinations(true);
    (async () => {
      try {
        const resp = await apiService.get<MarketingLinkResponse>('/api/me/agent/marketing-link');
        if (cancelled) return;
        const dests = Array.isArray(resp?.data?.destinations) ? resp.data!.destinations! : [];
        setDestinations(dests);
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load destinations', err);
          setDestinations([]);
        }
      } finally {
        if (!cancelled) setLoadingDestinations(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const isLink = type === 'website' || type === 'landing';
  const filteredDestinations = destinations.filter((d) => d.type === type);
  const noDestinations = isLink && !loadingDestinations && filteredDestinations.length === 0;

  const handleSelectType = (next: SourceType) => {
    setType(next);
    setDestinationLabel('');
    setError(null);
  };

  const submitDisabled =
    submitting ||
    !name.trim() ||
    (isLink && (noDestinations || !destinationLabel));

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await createProspectSource({
        name: name.trim(),
        tag: tag.trim() || undefined,
        type,
        color: color || undefined,
        destinationLabel: isLink ? destinationLabel : undefined,
      });
      setResult(res);
    } catch (err) {
      // api.service throws a normalized ApiError object (not an Error instance),
      // so read `.message` directly to surface the server's reason.
      const message = (err as { message?: string } | undefined)?.message;
      setError(message || 'Failed to create source.');
    } finally {
      setSubmitting(false);
    }
  };

  const copy = (text: string) => {
    window.navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDone = () => {
    onCreated();
    onClose();
  };

  if (!isOpen) return null;

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Tag className="w-5 h-5 text-oe-primary" /> Create Source
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {result ? (
          // --- Success view ---
          <div className="p-6 space-y-5">
            {result.type === 'api' ? (
              <>
                <p className="text-sm text-gray-600">
                  Share this endpoint with a lead source. Leads sent with this key are attributed to
                  you and de-duplicated automatically.
                </p>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Endpoint</label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-2 break-all font-mono">
                      {LEAD_INGEST_URL}
                    </code>
                    <button
                      onClick={() => copy(LEAD_INGEST_URL)}
                      className="flex items-center gap-1 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                    >
                      <Copy className="w-4 h-4" />
                      Copy
                    </button>
                  </div>
                </div>

                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-amber-800">
                    Save this key now — it won&apos;t be shown again.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">API key</label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-2 break-all font-mono">
                      {result.apiKey}
                    </code>
                    <button
                      onClick={() => copy(result.apiKey || '')}
                      className="flex items-center gap-1 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                    >
                      {copied ? <Check className="w-4 h-4 text-oe-success" /> : <Copy className="w-4 h-4" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-gray-700 mb-2">Example request</h3>
                  <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                    {sampleCurl(result.apiKey)}
                  </pre>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-oe-success flex items-center gap-1.5">
                  <Check className="w-4 h-4" /> Link created
                </p>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Your link</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={result.link || ''}
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                      className="flex-1 bg-gray-50 border border-gray-300 rounded px-2 py-2 text-sm font-mono text-gray-800 focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    />
                    <button
                      onClick={() => copy(result.link || '')}
                      className="flex items-center gap-1 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                    >
                      {copied ? <Check className="w-4 h-4 text-oe-success" /> : <Copy className="w-4 h-4" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              </>
            )}
            <div className="flex justify-end pt-2">
              <button
                onClick={handleDone}
                className="px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          // --- Form view ---
          <div className="p-6 space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Name <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Spring Facebook Campaign"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tag (optional)</label>
              <input
                type="text"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="e.g. social"
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

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Type</label>
              <div className="grid grid-cols-3 gap-2">
                {TYPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSelectType(opt.value)}
                    className={`px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
                      type === opt.value
                        ? 'border-oe-primary text-oe-dark bg-oe-light'
                        : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {isLink && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Destination</label>
                {loadingDestinations ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading destinations…
                  </div>
                ) : noDestinations ? (
                  <p className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3">
                    No {type} destinations configured — ask your tenant admin to add one in
                    Settings → Marketing Links.
                  </p>
                ) : (
                  <select
                    value={destinationLabel}
                    onChange={(e) => setDestinationLabel(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                  >
                    <option value="">Select a destination…</option>
                    {filteredDestinations.map((d) => (
                      <option key={d.label} value={d.label}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

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
                onClick={handleSubmit}
                disabled={submitDisabled}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-60"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {submitting ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
