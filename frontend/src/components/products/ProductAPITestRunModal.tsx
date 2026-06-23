import { Loader2, Play, Plus, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import SearchableDropdown from '../common/SearchableDropdown';
import { apiService } from '../../services/api.service';
import type { ApiHeaderBodyItem, AuthStepConfig } from '../../types/productApiConfig.types';

const CONTENT_TYPE_OPTIONS = [
  { value: 'application/json', label: 'application/json' },
  { value: 'application/x-www-form-urlencoded', label: 'application/x-www-form-urlencoded' },
  { value: 'multipart/form-data', label: 'multipart/form-data' }
] as const;

interface EnrolledMemberOption {
  id: string;
  label: string;
  value: string;
  email?: string;
  code?: string;
}

interface Props {
  productId?: string;
  isOpen: boolean;
  onClose: () => void;
  initialConfig?: {
    endpoint: string;
    method: string;
    contentType?: 'application/json' | 'application/x-www-form-urlencoded' | 'multipart/form-data';
    headers: ApiHeaderBodyItem[];
    body: ApiHeaderBodyItem[];
    authStep?: AuthStepConfig | null;
    responseMapping?: { tokenPath?: string; tokenPrefixStrip?: string };
  };
}

export default function ProductAPITestRunModal({
  productId,
  isOpen,
  onClose,
  initialConfig
}: Props) {
  const defaultHeaders: ApiHeaderBodyItem[] = [{ key: 'X-API-Key', value: '', prefill: null }];
  const [endpoint, setEndpoint] = useState(initialConfig?.endpoint || '');
  const [method, setMethod] = useState(initialConfig?.method || 'POST');
  const [contentType, setContentType] = useState<'application/json' | 'application/x-www-form-urlencoded' | 'multipart/form-data'>(initialConfig?.contentType || 'application/json');
  const [headers, setHeaders] = useState<ApiHeaderBodyItem[]>(defaultHeaders);
  const [body, setBody] = useState<ApiHeaderBodyItem[]>([]);
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<{ status: number; statusText: string; headers: Record<string, string>; data: any; authTokenUsed?: string | null; extractedValue?: unknown; tokenPathUsed?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memberOptions, setMemberOptions] = useState<EnrolledMemberOption[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [selectedMemberValue, setSelectedMemberValue] = useState('');
  const [pastingMember, setPastingMember] = useState(false);

  const headersWithoutContentType = (arr: ApiHeaderBodyItem[]) =>
    (arr || []).filter((h) => (h.key || '').toLowerCase() !== 'content-type');

  useEffect(() => {
    if (isOpen) {
      setEndpoint(initialConfig?.endpoint || '');
      setMethod(initialConfig?.method || 'POST');
      setContentType(initialConfig?.contentType || 'application/json');
      const rawHeaders = initialConfig?.headers?.length ? initialConfig.headers : defaultHeaders;
      setHeaders(headersWithoutContentType(rawHeaders).length ? headersWithoutContentType(rawHeaders).map((h) => ({ ...h })) : [...defaultHeaders]);
      setBody(initialConfig?.body?.length ? initialConfig.body.map((b) => ({ ...b })) : []);
      setResponse(null);
      setError(null);
      setSelectedMemberValue('');
    }
  }, [isOpen, initialConfig]);

  useEffect(() => {
    if (!isOpen || !productId) {
      setMemberOptions([]);
      return;
    }
    let cancelled = false;
    setMembersLoading(true);
    apiService.get<{ success: boolean; data?: { list: { memberId: string; enrollmentId: string; label: string; email?: string; householdMemberID?: string }[] } }>(`/api/me/tenant-admin/product-api/${productId}/enrolled-primary-members`)
      .then((r) => {
        if (cancelled || !r.success || !r.data?.list) return;
        setMemberOptions(r.data.list.map((m) => ({
          id: m.memberId,
          label: m.label,
          value: m.memberId,
          email: m.email,
          code: m.householdMemberID
        })));
      })
      .catch(() => { if (!cancelled) setMemberOptions([]); })
      .finally(() => { if (!cancelled) setMembersLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, productId]);

  const handlePasteMemberDetails = useCallback(async (value: string, _label: string, option?: EnrolledMemberOption) => {
    const memberId = value || option?.value || option?.id;
    if (!productId || !memberId) return;
    setPastingMember(true);
    setError(null);
    try {
      const r = await apiService.post<{ success: boolean; data?: { headers: Record<string, string>; body: Record<string, string> }; message?: string }>(
        `/api/me/tenant-admin/product-api/${productId}/resolve-prefills`,
        { memberId, headers: headersWithoutContentType(headers), body }
      );
      if (!r.success || !r.data) {
        setError(r.message || 'Failed to resolve member details');
        return;
      }
      const { headers: resolvedHeaders, body: resolvedBody } = r.data;
      setHeaders((h) => h.map((x) => ({
        ...x,
        value: resolvedHeaders[x.key ?? ''] !== undefined ? resolvedHeaders[x.key ?? ''] : x.value
      })));
      setBody((b) => b.map((x) => ({
        ...x,
        value: resolvedBody[x.key ?? ''] !== undefined ? resolvedBody[x.key ?? ''] : x.value
      })));
      setSelectedMemberValue(memberId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to paste member details');
    } finally {
      setPastingMember(false);
    }
  }, [productId, headers, body]);

  const addItem = (part: 'headers' | 'body') => {
    if (part === 'headers') setHeaders((h) => [...h, { key: '', value: '', prefill: null }]);
    else setBody((b) => [...b, { key: '', value: '', prefill: null }]);
  };

  const updateItem = (part: 'headers' | 'body', index: number, updates: Partial<ApiHeaderBodyItem>) => {
    if (part === 'headers') {
      setHeaders((h) => h.map((x, i) => (i === index ? { ...x, ...updates } : x)));
    } else {
      setBody((b) => b.map((x, i) => (i === index ? { ...x, ...updates } : x)));
    }
  };

  const removeItem = (part: 'headers' | 'body', index: number) => {
    if (part === 'headers') setHeaders((h) => h.filter((_, i) => i !== index));
    else setBody((b) => b.filter((_, i) => i !== index));
  };

  const runTest = async () => {
    setRunning(true);
    setResponse(null);
    setError(null);
    try {
      const authStep = initialConfig?.authStep;
      const r = await apiService.post('/api/me/tenant-admin/product-api/test-run', {
        endpoint: endpoint.trim(),
        method,
        contentType,
        headers: headersWithoutContentType(headers),
        body,
        authStep: authStep?.enabled ? authStep : undefined,
        responseMapping: initialConfig?.responseMapping
      }) as { success: boolean; data?: any; message?: string };
      if (r.success && r.data) {
        setResponse(r.data);
      } else {
        setError(r.message || 'Test failed');
      }
    } catch (e: any) {
      setError(e.message || 'Request failed');
    } finally {
      setRunning(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-6 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">Test API</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-2">
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="text-sm text-gray-500 mt-1">Run a test request with manual inputs. Edit any field below.</p>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {productId && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">Paste existing member details</label>
              <p className="text-xs text-gray-500 mb-2">Select a primary member enrolled in this product to fill headers and body with their data.</p>
              <SearchableDropdown
                options={memberOptions}
                value={selectedMemberValue}
                onChange={(val, label, opt) => {
                  if (!val) {
                    setSelectedMemberValue('');
                    return;
                  }
                  handlePasteMemberDetails(val, label, opt);
                }}
                placeholder={membersLoading ? 'Loading members...' : pastingMember ? 'Pasting...' : 'Select a member'}
                searchPlaceholder="Search by name, email, or ID..."
                loading={membersLoading}
                disabled={pastingMember}
                showEmail
                showCode
                className="max-w-md"
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Endpoint</label>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://api.example.com/endpoint"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">Headers</label>
              <button type="button" onClick={() => addItem('headers')} className="text-blue-600 hover:text-blue-800 text-sm flex items-center">
                <Plus className="h-4 w-4 mr-1" /> Add
              </button>
            </div>
            <div className="space-y-2">
              <div className="flex gap-2 items-center">
                <input value="Content-Type" readOnly className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-600" />
                <select
                  value={contentType}
                  onChange={(e) => setContentType(e.target.value as typeof contentType)}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                >
                  {CONTENT_TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <div className="w-10 shrink-0" />
              </div>
              {headers.filter((h) => (h.key || '').toLowerCase() !== 'content-type').map((h, i) => {
                const actualIndex = headers.indexOf(h);
                return (
                <div key={actualIndex} className="flex gap-2 items-center">
                  <input
                    placeholder="Key"
                    value={h.key}
                    onChange={(e) => updateItem('headers', actualIndex, { key: e.target.value })}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <input
                    placeholder={h.prefill === 'authToken' ? '(auto)' : 'Value'}
                    value={h.value}
                    onChange={(e) => updateItem('headers', actualIndex, { value: e.target.value })}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    disabled={h.prefill === 'authToken'}
                  />
                  <button type="button" onClick={() => removeItem('headers', actualIndex)} className="p-2 text-red-600 hover:bg-red-50 rounded">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
              })}
            </div>
          </div>

          {method !== 'GET' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">Body</label>
                <button type="button" onClick={() => addItem('body')} className="text-blue-600 hover:text-blue-800 text-sm flex items-center">
                  <Plus className="h-4 w-4 mr-1" /> Add
                </button>
              </div>
              <div className="space-y-2">
                {body.map((b, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input
                      placeholder="Key"
                      value={b.key}
                      onChange={(e) => updateItem('body', i, { key: e.target.value })}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                    <input
                      placeholder={b.prefill === 'authToken' ? '(auto)' : 'Value'}
                      value={b.value}
                      onChange={(e) => updateItem('body', i, { value: e.target.value })}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      disabled={b.prefill === 'authToken'}
                    />
                    <button type="button" onClick={() => removeItem('body', i)} className="p-2 text-red-600 hover:bg-red-50 rounded">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={runTest}
            disabled={running || !endpoint.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? 'Running...' : 'Run test'}
          </button>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-800">
              {error}
            </div>
          )}

          {response && (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <h4 className="text-sm font-medium text-gray-700 bg-gray-50 px-4 py-2 border-b border-gray-200">Response</h4>
              <div className="p-4 space-y-3 text-sm">
                <p>
                  <span className="font-medium text-gray-600">Status:</span>{' '}
                  <span className={response.status >= 400 ? 'text-red-600' : 'text-green-600'}>
                    {response.status} {response.statusText}
                  </span>
                </p>
                {response.authTokenUsed != null && (
                  <p>
                    <span className="font-medium text-gray-600">Auth token used:</span>{' '}
                    <code className="bg-gray-100 px-1 rounded text-xs break-all">{response.authTokenUsed}</code>
                  </p>
                )}
                {response.extractedValue != null && (
                  <div className="bg-blue-50 border border-blue-200 rounded p-2">
                    <p className="font-medium text-blue-800">
                      Extracted value <span className="font-normal text-blue-700">(from token path <code className="bg-blue-100 px-1 rounded">{response.tokenPathUsed || '—'}</code>):</span>
                    </p>
                    <code className="text-blue-900 break-all">{String(response.extractedValue)}</code>
                    <p className="text-xs text-blue-600 mt-1">The full API response is stored in ExternalAPIResponseJson</p>
                  </div>
                )}
                {response.data && typeof response.data === 'object' && response.extractedValue == null && Object.keys(response.data).length > 0 && (
                  <p className="text-xs text-gray-500">
                    Response has keys: {Object.keys(response.data).join(', ')}. Set token path in Response – extract token (e.g. <code>data.userid</code>) to extract a value.
                  </p>
                )}
                {response.headers && Object.keys(response.headers).length > 0 && (
                  <div>
                    <p className="font-medium text-gray-600 mb-1">Headers:</p>
                    <pre className="bg-gray-50 p-2 rounded text-xs overflow-x-auto max-h-24 overflow-y-auto">
                      {JSON.stringify(response.headers, null, 2)}
                    </pre>
                  </div>
                )}
                <div>
                  <p className="font-medium text-gray-600 mb-1">Body:</p>
                  <pre className="bg-gray-50 p-2 rounded text-xs overflow-x-auto max-h-48 overflow-y-auto">
                    {typeof response.data === 'object'
                      ? JSON.stringify(response.data, null, 2)
                      : String(response.data ?? '')}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 p-4 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
