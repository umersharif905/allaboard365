import { Loader2, Plus, Trash2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';
import type { ApiHeaderBodyItem, AuthStepConfig } from '../../types/productApiConfig.types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  config: AuthStepConfig | null | undefined;
  onSave: (config: AuthStepConfig) => void;
}

export default function AuthStepConfigModal({
  isOpen,
  onClose,
  config,
  onSave
}: Props) {
  const [endpoint, setEndpoint] = useState(config?.endpoint || '');
  const [method, setMethod] = useState(config?.method || 'POST');
  const [contentType, setContentType] = useState<AuthStepConfig['contentType']>(config?.contentType || 'application/x-www-form-urlencoded');
  const [body, setBody] = useState<ApiHeaderBodyItem[]>(config?.body?.length ? [...config.body] : []);
  const [tokenPath, setTokenPath] = useState(config?.responseMapping?.tokenPath || 'headers.Authorization');
  const [tokenPrefixStrip, setTokenPrefixStrip] = useState(config?.responseMapping?.tokenPrefixStrip || 'Bearer ');
  const [generating, setGenerating] = useState(false);
  const [testResponse, setTestResponse] = useState<{ status: number; statusText: string; headers: Record<string, string>; data: any; extractedToken: string | null } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setEndpoint(config?.endpoint || '');
      setMethod(config?.method || 'POST');
      setContentType(config?.contentType || 'application/x-www-form-urlencoded');
      setBody(config?.body?.length ? config.body.map((b) => ({ ...b })) : []);
      setTokenPath(config?.responseMapping?.tokenPath || 'headers.Authorization');
      setTokenPrefixStrip(config?.responseMapping?.tokenPrefixStrip || 'Bearer ');
      setTestResponse(null);
      setTestError(null);
    }
  }, [isOpen, config]);

  const handleGenerateToken = async () => {
    setGenerating(true);
    setTestResponse(null);
    setTestError(null);
    try {
      const r = await apiService.post('/api/me/tenant-admin/product-api/test-auth-step', {
        endpoint: endpoint.trim(),
        method,
        contentType,
        body,
        responseMapping: { tokenPath: tokenPath.trim() || undefined, tokenPrefixStrip: tokenPrefixStrip || undefined }
      }) as { success: boolean; data?: any; message?: string };
      if (r.success && r.data) {
        setTestResponse(r.data);
      } else {
        setTestError(r.message || 'Request failed');
      }
    } catch (e: any) {
      setTestError(e.message || 'Request failed');
    } finally {
      setGenerating(false);
    }
  };

  const addBodyItem = () => setBody((b) => [...b, { key: '', value: '', prefill: null }]);

  const updateBodyItem = (index: number, updates: Partial<ApiHeaderBodyItem>) => {
    setBody((b) => b.map((x, i) => (i === index ? { ...x, ...updates } : x)));
  };

  const removeBodyItem = (index: number) => setBody((b) => b.filter((_, i) => i !== index));

  const handleSave = () => {
    onSave({
      enabled: true,
      endpoint: endpoint.trim(),
      method,
      contentType,
      body,
      responseMapping: { tokenPath: tokenPath.trim() || undefined, tokenPrefixStrip: tokenPrefixStrip || undefined }
    });
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-lg max-w-xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-6 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">Auth Token Configuration</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-2">
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Configure the API call used to obtain the auth token. Use <code className="bg-gray-100 px-1 rounded">${'{VAR}'}</code> in values to substitute env vars (e.g. $LYRIC_STAGING_API_USERNAME).
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Endpoint</label>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://api.example.com/login"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              >
                <option value="POST">POST</option>
                <option value="GET">GET</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Content-Type</label>
              <select
                value={contentType}
                onChange={(e) => setContentType(e.target.value as AuthStepConfig['contentType'])}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              >
                <option value="application/x-www-form-urlencoded">Form (x-www-form-urlencoded)</option>
                <option value="application/json">JSON</option>
                <option value="multipart/form-data">Multipart form-data</option>
              </select>
            </div>
          </div>

          {method !== 'GET' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">Request body</label>
                <button type="button" onClick={addBodyItem} className="text-blue-600 hover:text-blue-800 text-sm flex items-center">
                  <Plus className="h-4 w-4 mr-1" /> Add
                </button>
              </div>
              <div className="space-y-2">
                {body.map((b, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input
                      placeholder="Key (e.g. email)"
                      value={b.key}
                      onChange={(e) => updateBodyItem(i, { key: e.target.value })}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                    <input
                      placeholder={'Value or ${ENV_VAR}'}
                      value={b.value}
                      onChange={(e) => updateBodyItem(i, { value: e.target.value })}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                    <button type="button" onClick={() => removeBodyItem(i)} className="p-2 text-red-600 hover:bg-red-50 rounded">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-gray-200 pt-4 space-y-3">
            <h4 className="text-sm font-medium text-gray-700">Response – extract token</h4>
            <p className="text-xs text-gray-500 mb-2">Defaults: headers.Authorization, prefix "Bearer " (used when left blank)</p>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Token path (e.g. headers.Authorization) – header keys are case-insensitive</label>
              <input
                value={tokenPath}
                onChange={(e) => setTokenPath(e.target.value)}
                placeholder="headers.Authorization"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Prefix to strip (e.g. Bearer )</label>
              <input
                value={tokenPrefixStrip}
                onChange={(e) => setTokenPrefixStrip(e.target.value)}
                placeholder="Bearer "
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>
          </div>

          <div className="border-t border-gray-200 pt-4">
            <button
              type="button"
              onClick={handleGenerateToken}
              disabled={generating || !endpoint.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {generating && <Loader2 className="h-4 w-4 animate-spin" />}
              Generate token
            </button>
            {testError && (
              <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
                {testError}
              </div>
            )}
            {testResponse && (
              <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
                <h4 className="text-sm font-medium text-gray-700 bg-gray-50 px-4 py-2 border-b border-gray-200">Response</h4>
                <div className="p-4 space-y-3 text-sm">
                  <p>
                    <span className="font-medium text-gray-600">Status:</span>{' '}
                    <span className={testResponse.status >= 400 ? 'text-red-600' : 'text-green-600'}>
                      {testResponse.status} {testResponse.statusText}
                    </span>
                  </p>
                  <p>
                    <span className="font-medium text-gray-600">Extracted token:</span>{' '}
                    {testResponse.extractedToken != null ? (
                      <code className="bg-gray-100 px-1 rounded break-all">
                        {testResponse.extractedToken.length > 60 ? testResponse.extractedToken.substring(0, 60) + '...' : testResponse.extractedToken}
                      </code>
                    ) : (
                      <span className="text-amber-600">No token extracted – check token path and prefix</span>
                    )}
                  </p>
                  {testResponse.headers && Object.keys(testResponse.headers).length > 0 && (
                    <div>
                      <p className="font-medium text-gray-600 mb-1">Headers:</p>
                      <pre className="bg-gray-50 p-2 rounded text-xs overflow-x-auto max-h-32 overflow-y-auto">
                        {JSON.stringify(testResponse.headers, null, 2)}
                      </pre>
                    </div>
                  )}
                  <div>
                    <p className="font-medium text-gray-600 mb-1">Body:</p>
                    <pre className="bg-gray-50 p-2 rounded text-xs overflow-x-auto max-h-48 overflow-y-auto">
                      {typeof testResponse.data === 'object'
                        ? JSON.stringify(testResponse.data, null, 2)
                        : String(testResponse.data ?? '')}
                    </pre>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-gray-200 p-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!endpoint.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
