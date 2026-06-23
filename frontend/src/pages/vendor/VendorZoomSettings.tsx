// frontend/src/pages/vendor/VendorZoomSettings.tsx
// VendorAdmin-only page to connect the vendor's Zoom Phone line and map Zoom
// phone users to internal vendor agents (for call attribution / stats).

import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Link2,
  Loader2,
  PhoneCall,
  RefreshCw,
  Save,
  Users,
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import {
  vendorCallCenterService as svc,
  type AgentMapData,
  type PhoneConfig,
  type ZoomUserMapping,
} from '../../services/vendorCallCenter.service';

const SECRET_PLACEHOLDER = '••••••••••••  (saved — leave blank to keep)';

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-oe-primary focus:ring-1 focus:ring-oe-primary';

const VendorZoomSettings: React.FC = () => {
  const [config, setConfig] = useState<PhoneConfig | null>(null);
  const [secretInput, setSecretInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Agent mapping
  const [mapData, setMapData] = useState<AgentMapData | null>(null);
  const [mapDraft, setMapDraft] = useState<Record<string, string>>({}); // zoomUserId -> internal userId ('' = unmapped)
  const [mapLoading, setMapLoading] = useState(false);
  const [mapSaving, setMapSaving] = useState(false);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const cfg = await svc.getPhoneConfig();
      setConfig(cfg);
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load Zoom config' });
    } finally {
      setLoading(false);
    }
  };

  const loadAgentMap = async () => {
    setMapLoading(true);
    try {
      const data = await svc.getAgentMap();
      setMapData(data);
      const draft: Record<string, string> = {};
      data.zoomUsers.forEach((zu) => {
        draft[zu.zoomUserId] = zu.mappedUserId || '';
      });
      setMapDraft(draft);
    } catch (err) {
      setMapData({ zoomUsers: [], vendorUsers: [], currentMap: [], zoomError: err instanceof Error ? err.message : 'Failed to load mapping' });
    } finally {
      setMapLoading(false);
    }
  };

  useEffect(() => {
    void loadConfig();
    void loadAgentMap();
  }, []);

  const update = <K extends keyof PhoneConfig>(key: K, value: PhoneConfig[K]) => {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setBanner(null);
    try {
      const payload: Partial<PhoneConfig> & { zoomClientSecret?: string } = {
        phoneProvider: 'ZoomPhone',
        phoneProviderEnabled: config.phoneProviderEnabled,
        zoomAccountId: config.zoomAccountId,
        zoomClientId: config.zoomClientId,
        zoomWebhookSecretToken: config.zoomWebhookSecretToken,
        phoneAutoMatchEnabled: config.phoneAutoMatchEnabled,
        phonePopupEnabled: config.phonePopupEnabled,
        phoneRecordingsEnabled: config.phoneRecordingsEnabled,
      };
      if (secretInput.trim()) payload.zoomClientSecret = secretInput.trim();
      await svc.savePhoneConfig(payload);
      setSecretInput('');
      setBanner({ type: 'success', text: 'Zoom settings saved.' });
      await loadConfig();
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setBanner(null);
    try {
      const res = await svc.testConnection();
      setBanner({
        type: res.success ? 'success' : 'error',
        text: res.message || (res.success ? 'Connection successful.' : 'Connection failed.'),
      });
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Connection test failed' });
    } finally {
      setTesting(false);
    }
  };

  const copyWebhook = async () => {
    if (!config?.zoomWebhookUrl) return;
    await window.navigator.clipboard.writeText(config.zoomWebhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const applySuggestions = () => {
    if (!mapData) return;
    setMapDraft((prev) => {
      const next = { ...prev };
      mapData.zoomUsers.forEach((zu) => {
        if (!next[zu.zoomUserId] && zu.suggestedUserId) next[zu.zoomUserId] = zu.suggestedUserId;
      });
      return next;
    });
  };

  const handleSaveMap = async () => {
    if (!mapData) return;
    setMapSaving(true);
    setBanner(null);
    try {
      const entries = mapData.zoomUsers.map((zu) => ({
        zoomUserId: zu.zoomUserId,
        zoomEmail: zu.zoomEmail,
        zoomExtension: zu.zoomExtension,
        zoomDisplayName: zu.zoomDisplayName,
        userId: mapDraft[zu.zoomUserId] || null,
      }));
      await svc.saveAgentMap(entries);
      setBanner({ type: 'success', text: 'Agent mapping saved.' });
      await loadAgentMap();
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save mapping' });
    } finally {
      setMapSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        <Loader2 className="animate-spin mr-2" size={20} /> Loading Zoom settings…
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-oe-light rounded-lg">
          <PhoneCall className="text-oe-primary" size={24} />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Phone &amp; Zoom Integration</h1>
          <p className="text-sm text-gray-500">Connect your Zoom Phone line to power the Call Center.</p>
        </div>
      </div>

      {banner && (
        <div
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
            banner.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {banner.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{banner.text}</span>
        </div>
      )}

      {/* Connection card */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-gray-900">Connection</h2>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
              checked={config?.phoneProviderEnabled || false}
              onChange={(e) => update('phoneProviderEnabled', e.target.checked)}
            />
            Zoom Phone enabled
          </label>
        </div>

        <p className="text-xs text-gray-500">
          Create a <strong>Server-to-Server OAuth</strong> app in the Zoom Marketplace and paste its
          credentials here. Required scopes: call history, recordings, audio download, and phone users.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Account ID">
            <input
              type="text"
              className={inputClass}
              value={config?.zoomAccountId || ''}
              onChange={(e) => update('zoomAccountId', e.target.value)}
              placeholder="Zoom account_id"
            />
          </Field>
          <Field label="Client ID">
            <input
              type="text"
              className={inputClass}
              value={config?.zoomClientId || ''}
              onChange={(e) => update('zoomClientId', e.target.value)}
              placeholder="Zoom client_id"
            />
          </Field>
          <Field label="Client Secret">
            <input
              type="password"
              className={inputClass}
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder={config?.hasZoomClientSecret ? SECRET_PLACEHOLDER : 'Zoom client_secret'}
              autoComplete="new-password"
            />
            <span className="text-xs text-gray-400">Stored encrypted (AES-256-GCM).</span>
          </Field>
          <Field label="Webhook Secret Token">
            <input
              type="text"
              className={inputClass}
              value={config?.zoomWebhookSecretToken || ''}
              onChange={(e) => update('zoomWebhookSecretToken', e.target.value)}
              placeholder="From the Zoom app's Feature → Event Subscriptions"
            />
          </Field>
        </div>

        {config?.zoomWebhookUrl && (
          <Field label="Webhook URL (paste into your Zoom app's Event Subscription)">
            <div className="flex items-center gap-2">
              <input type="text" readOnly className={`${inputClass} bg-gray-50 font-mono text-xs`} value={config.zoomWebhookUrl} />
              <button
                type="button"
                onClick={copyWebhook}
                className="shrink-0 inline-flex items-center gap-1 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg px-3 py-2 text-sm"
              >
                {copied ? <Check size={16} className="text-oe-success" /> : <Copy size={16} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </Field>
        )}

        <div className="border-t border-gray-100 pt-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Call handling</h3>
          <div className="space-y-2">
            <Toggle
              label="Auto-match callers to members by phone number"
              checked={config?.phoneAutoMatchEnabled || false}
              onChange={(v) => update('phoneAutoMatchEnabled', v)}
            />
            <Toggle
              label="Capture call recordings & transcripts"
              checked={config?.phoneRecordingsEnabled || false}
              onChange={(v) => update('phoneRecordingsEnabled', v)}
            />
            <Toggle
              label="Show live call pop-ups in the Call Center"
              checked={config?.phonePopupEnabled || false}
              onChange={(v) => update('phonePopupEnabled', v)}
            />
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 bg-oe-primary hover:bg-oe-dark text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-60"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Save settings
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="inline-flex items-center gap-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg px-4 py-2 text-sm disabled:opacity-60"
          >
            {testing ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
            Test connection
          </button>
        </div>
      </div>

      {/* Agent mapping card */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="text-oe-primary" size={20} />
            <h2 className="text-lg font-medium text-gray-900">Agent mapping</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadAgentMap()}
              className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
            >
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-500">
          Map each Zoom phone user to an internal team member so calls are attributed correctly in
          stats and reports. Suggested matches are based on email.
        </p>

        {mapLoading ? (
          <div className="flex items-center text-gray-500 py-6">
            <Loader2 className="animate-spin mr-2" size={18} /> Loading Zoom users…
          </div>
        ) : mapData && mapData.zoomError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Couldn&apos;t reach Zoom to list phone users ({mapData.zoomError}). Save your connection
            settings and test the connection first.
          </div>
        ) : mapData && mapData.zoomUsers.length > 0 ? (
          <>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={applySuggestions}
                className="text-sm text-oe-primary hover:text-oe-dark"
              >
                Apply suggested matches
              </button>
            </div>
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-gray-500">Zoom user</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500">Extension</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-500">Mapped team member</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {mapData.zoomUsers.map((zu: ZoomUserMapping) => (
                    <tr key={zu.zoomUserId} className="hover:bg-gray-50">
                      <td className="px-4 py-2">
                        <div className="font-medium text-gray-900">{zu.zoomDisplayName}</div>
                        {zu.zoomEmail && <div className="text-xs text-gray-500">{zu.zoomEmail}</div>}
                      </td>
                      <td className="px-4 py-2 text-gray-600">{zu.zoomExtension || '—'}</td>
                      <td className="px-4 py-2">
                        <select
                          className={inputClass}
                          value={mapDraft[zu.zoomUserId] || ''}
                          onChange={(e) =>
                            setMapDraft((prev) => ({ ...prev, [zu.zoomUserId]: e.target.value }))
                          }
                        >
                          <option value="">— Unmapped —</option>
                          {mapData.vendorUsers.map((u) => (
                            <option key={u.UserId} value={u.UserId}>
                              {u.FirstName} {u.LastName} {u.Email ? `(${u.Email})` : ''}
                            </option>
                          ))}
                        </select>
                        {!mapDraft[zu.zoomUserId] && zu.suggestedUserId && (
                          <span className="ml-2 text-xs text-oe-primary">suggestion available</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <button
                type="button"
                onClick={handleSaveMap}
                disabled={mapSaving}
                className="inline-flex items-center gap-2 bg-oe-primary hover:bg-oe-dark text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-60"
              >
                {mapSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                Save mapping
              </button>
            </div>
          </>
        ) : (
          <div className="text-sm text-gray-500 py-4">No Zoom phone users found.</div>
        )}
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block space-y-1">
    <span className="text-sm font-medium text-gray-700">{label}</span>
    {children}
  </label>
);

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({
  label,
  checked,
  onChange,
}) => (
  <label className="flex items-center gap-2 text-sm text-gray-700">
    <input
      type="checkbox"
      className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
    {label}
  </label>
);

export default VendorZoomSettings;
