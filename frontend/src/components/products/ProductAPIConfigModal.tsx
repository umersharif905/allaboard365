import {
  Baby,
  Copy,
  Eye,
  ExternalLink,
  FlaskConical,
  Heart,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  User,
  UserCheck,
  Users,
  X
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';
import type { ApiResponse } from '../../types/index';
import type { Member } from '../../types/member.types';
import {
  type ApiHeaderBodyItem,
  type AuthStepConfig,
  type DeactivationApiConfig,
  type EnrollmentApiConfig,
  PREFILL_OPTIONS,
  type ProductAPIConfig,
  type SSOConfig,
  type SSOLoginConfig,
  type SSOPortalConfig,
  type SSOTokenRequestConfig,
  type UpdateApiConfig
} from '../../types/productApiConfig.types';
import SearchableDropdown from '../common/SearchableDropdown';
import MemberManagementModal from '../../pages/members/MemberManagementModal';
import AuthStepConfigModal from './AuthStepConfigModal';
import ProductAPITestRunModal from './ProductAPITestRunModal';

interface Props {
  productId: string;
  productName: string;
  isOpen: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

const emptyHeaderBodyItem = (): ApiHeaderBodyItem => ({ key: '', value: '', prefill: null });

/** Default headers for new API config - Content-Type is a separate required field */
const defaultHeaders = (): ApiHeaderBodyItem[] => [
  { key: 'X-API-Key', value: '', prefill: null }
];

/** Headers excluding Content-Type (it's a dedicated field) */
const headersWithoutContentType = (arr: ApiHeaderBodyItem[]) =>
  (arr || []).filter((h) => (h.key || '').toLowerCase() !== 'content-type');

const emptyEnrollmentConfig = (): EnrollmentApiConfig => ({
  enabled: false,
  method: 'POST',
  endpoint: '',
  headers: defaultHeaders(),
  body: []
});

const emptyDeactivationConfig = (): DeactivationApiConfig => ({
  enabled: false,
  method: 'POST',
  endpoint: '',
  headers: defaultHeaders(),
  body: []
});

const emptyUpdateConfig = (): UpdateApiConfig => ({
  enabled: false,
  method: 'POST',
  endpoint: '',
  headers: defaultHeaders(),
  body: []
});

const emptySSOLoginConfig = (): SSOLoginConfig => ({
  enabled: true,
  endpoint: '',
  method: 'POST',
  contentType: 'application/x-www-form-urlencoded',
  body: [],
  responseMapping: {}
});

const emptySSOTokenRequestConfig = (): SSOTokenRequestConfig => ({
  enabled: false,
  endpoint: '',
  method: 'POST',
  contentType: 'application/x-www-form-urlencoded',
  headers: defaultHeaders(),
  body: []
});

const emptySSOPortalConfig = (): SSOPortalConfig => ({
  portalBaseUrl: '',
  urlTemplate: '',
  customFields: []
});

const emptySSOConfig = (): SSOConfig => ({
  enabled: false,
  login: emptySSOLoginConfig(),
  tokenRequest: emptySSOTokenRequestConfig(),
  portal: emptySSOPortalConfig()
});

export default function ProductAPIConfigModal({
  productId,
  productName,
  isOpen,
  onClose,
  onSaved
}: Props) {
  const [activeTab, setActiveTab] = useState<'enrollment' | 'update' | 'deactivation' | 'sso' | 'run-status'>('enrollment');
  const [config, setConfig] = useState<ProductAPIConfig | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [pendingHouseholds, setPendingHouseholds] = useState(0);
  const [pendingDeactivations, setPendingDeactivations] = useState(0);
  const [syncedHouseholds, setSyncedHouseholds] = useState(0);
  const [showPendingDeactivationsModal, setShowPendingDeactivationsModal] = useState(false);
  const [pendingDeactivationList, setPendingDeactivationList] = useState<{ enrollmentId: string; memberId: string; memberName: string; terminationDate?: string }[]>([]);
  const [loadingPendingDeactivations, setLoadingPendingDeactivations] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runningUpdate, setRunningUpdate] = useState(false);
  const [runResult, setRunResult] = useState<{
    activated?: number;
    deactivated?: number;
    updated?: number;
    errors?: any[];
    activatedList?: { memberName: string; memberId?: string }[];
    updatedList?: { memberName: string; memberId?: string }[];
    deactivatedList?: { memberName: string; memberId?: string }[];
  } | null>(null);
  const [viewingError, setViewingError] = useState<{ memberName: string; type: string; message: string; responseBody?: any; responseStatus?: number } | null>(null);
  const [selectedMemberForView, setSelectedMemberForView] = useState<Member | null>(null);
  const [householdMembersForView, setHouseholdMembersForView] = useState<Member[]>([]);
  const [memberEnrollmentsForView, setMemberEnrollmentsForView] = useState<any[]>([]);
  const [enrollmentsLoadingForView, setEnrollmentsLoadingForView] = useState(false);
  const [showTestRunModal, setShowTestRunModal] = useState(false);
  const [testRunConfigType, setTestRunConfigType] = useState<'enrollment' | 'update' | 'deactivation'>('enrollment');
  const [showAuthStepModal, setShowAuthStepModal] = useState(false);
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [productOptions, setProductOptions] = useState<{ id: string; label: string; value: string }[]>([]);
  const [ssoTestLoginLoading, setSsoTestLoginLoading] = useState(false);
  const [ssoTestLoginResult, setSsoTestLoginResult] = useState<{ status: number; statusText: string; extractedToken: string | null; tokenPathUsed?: string; data?: any; headers?: Record<string, string>; requestUrl?: string; requestMethod?: string; requestBody?: Record<string, unknown> } | null>(null);
  const [ssoTestTokenLoading, setSsoTestTokenLoading] = useState(false);
  const [ssoTestTokenResult, setSsoTestTokenResult] = useState<{ status: number; statusText: string; memberTokenPreview: string | null; data?: any; requestUrl?: string; requestMethod?: string; requestBody?: Record<string, unknown> } | null>(null);
  const [ssoTestPortalLoading, setSsoTestPortalLoading] = useState(false);
  const [testMemberExternalId, setTestMemberExternalId] = useState('TEST_MEMBER');
  const [productsLoading, setProductsLoading] = useState(false);
  const [copyLoading, setCopyLoading] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const loadConfig = async () => {
    if (!productId || !isOpen) return;
    setLoading(true);
    try {
      const r = await apiService.get(`/api/me/tenant-admin/product-api/${productId}/api-config`) as ApiResponse<{ config: ProductAPIConfig; lastRunAt: string | null }>;
      if (r.success && r.data) {
        setConfig(r.data.config || {});
        setLastRunAt(r.data.lastRunAt || null);
      } else {
        setConfig({});
      }
    } catch (e) {
      console.error('Failed to load API config:', e);
      setConfig({});
    } finally {
      setLoading(false);
    }
  };

  const loadPending = async () => {
    if (!productId || !isOpen) return;
    try {
      const r = await apiService.get(`/api/me/tenant-admin/product-api/${productId}/api-pending`) as ApiResponse<{
        pendingHouseholds: number;
        pendingDeactivations: number;
        syncedHouseholds: number;
      }>;
      if (r.success && r.data) {
        setPendingHouseholds(r.data.pendingHouseholds ?? 0);
        setPendingDeactivations(r.data.pendingDeactivations ?? 0);
        setSyncedHouseholds(r.data.syncedHouseholds ?? 0);
      }
    } catch (e) {
      console.error('Failed to load pending:', e);
    }
  };

  const loadPendingDeactivationList = async () => {
    if (!productId) return;
    setLoadingPendingDeactivations(true);
    setShowPendingDeactivationsModal(true);
    setPendingDeactivationList([]);
    try {
      const r = await apiService.get(`/api/me/tenant-admin/product-api/${productId}/api-pending-deactivations?limit=100`) as ApiResponse<{
        list: { enrollmentId: string; memberId: string; memberName: string; terminationDate?: string }[];
      }>;
      if (r.success && r.data?.list) {
        setPendingDeactivationList(r.data.list);
      }
    } catch (e) {
      console.error('Failed to load pending deactivation list:', e);
    } finally {
      setLoadingPendingDeactivations(false);
    }
  };

  const handleOpenMember = async (memberId: string) => {
    setEnrollmentsLoadingForView(true);
    setSelectedMemberForView(null);
    setHouseholdMembersForView([]);
    setMemberEnrollmentsForView([]);
    try {
      const [householdRes, activeRes, pendingRes] = await Promise.all([
        apiService.get<{ success: boolean; data: { member: Member; householdMembers: Member[] } }>(`/api/members/${memberId}/with-household`),
        apiService.get<{ success: boolean; data: any[] }>(`/api/enrollments?memberId=${memberId}&status=Active`),
        apiService.get<{ success: boolean; data: any[] }>(`/api/enrollments?memberId=${memberId}&status=Pending`)
      ]);
      if (householdRes.success && householdRes.data) {
        setSelectedMemberForView(householdRes.data.member);
        setHouseholdMembersForView(householdRes.data.householdMembers || []);
      }
      const active = activeRes.success ? (activeRes.data || []) : [];
      const pending = pendingRes.success ? (pendingRes.data || []) : [];
      const unique = [...active, ...pending].filter((e: any, i: number, arr: any[]) =>
        i === arr.findIndex((x: any) => (x.EnrollmentId || x.enrollmentId) === (e.EnrollmentId || e.enrollmentId))
      );
      setMemberEnrollmentsForView(unique);
    } catch (err) {
      console.error('Failed to load member:', err);
    } finally {
      setEnrollmentsLoadingForView(false);
    }
  };

  const formatCurrency = (amount: number): string =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Active': return 'bg-green-100 text-green-800';
      case 'Inactive': return 'bg-gray-100 text-gray-800';
      case 'Suspended': return 'bg-red-100 text-red-800';
      case 'Pending': return 'bg-yellow-100 text-yellow-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getRelationshipIcon = (relationshipType?: string) => {
    switch (relationshipType) {
      case 'P': return <UserCheck className="h-4 w-4 text-oe-primary" />;
      case 'S': return <Heart className="h-4 w-4 text-pink-600" />;
      case 'C': return <Baby className="h-4 w-4 text-green-600" />;
      default: return <User className="h-4 w-4 text-gray-600" />;
    }
  };

  const getRelationshipColor = (relationshipType?: string) => {
    switch (relationshipType) {
      case 'P': return 'bg-blue-100 text-blue-800';
      case 'S': return 'bg-pink-100 text-pink-800';
      case 'C': return 'bg-green-100 text-green-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadConfig();
      loadPending();
    }
  }, [isOpen, productId]);

  useEffect(() => {
    if (!showCopyModal) return;
    setCopyError(null);
    setSelectedProductId('');
    setProductsLoading(true);
    apiService.get<{ success: boolean; products: { ProductId: string; Name: string; IsBundle?: boolean }[] }>('/api/products')
      .then((res) => {
        const list = res?.products ?? [];
        const filtered = list.filter(
          (p: { ProductId: string; IsBundle?: boolean }) => !p.IsBundle && p.ProductId !== productId
        );
        setProductOptions(
          filtered.map((p: { ProductId: string; Name: string }) => ({
            id: p.ProductId,
            label: p.Name,
            value: p.ProductId
          }))
        );
      })
      .catch(() => setProductOptions([]))
      .finally(() => setProductsLoading(false));
  }, [showCopyModal, productId]);

  const handleCopyFromProductConfirm = useCallback(async () => {
    if (!selectedProductId) return;
    setCopyLoading(true);
    setCopyError(null);
    try {
      const r = (await apiService.get(
        `/api/me/tenant-admin/product-api/${selectedProductId}/api-config`
      )) as ApiResponse<{ config: ProductAPIConfig; lastRunAt: string | null }>;
      if (r.success && r.data?.config != null) {
        setConfig(r.data.config);
        setShowCopyModal(false);
      } else {
        setCopyError('Selected product has no API configuration or failed to load.');
      }
    } catch (e: any) {
      setCopyError(e?.message || 'Failed to copy API configuration.');
    } finally {
      setCopyLoading(false);
    }
  }, [selectedProductId]);

  const saveConfig = async () => {
    setSaving(true);
    try {
      const cleaned = { ...config };
      if (cleaned?.enrollment?.headers) {
        cleaned.enrollment = { ...cleaned.enrollment, headers: headersWithoutContentType(cleaned.enrollment.headers) };
      }
      if (cleaned?.update?.headers) {
        cleaned.update = { ...cleaned.update, headers: headersWithoutContentType(cleaned.update.headers) };
      }
      if (cleaned?.deactivation?.headers) {
        cleaned.deactivation = { ...cleaned.deactivation, headers: headersWithoutContentType(cleaned.deactivation.headers) };
      }
      if (cleaned?.sso?.tokenRequest?.headers) {
        cleaned.sso = {
          ...cleaned.sso,
          tokenRequest: { ...cleaned.sso.tokenRequest, headers: headersWithoutContentType(cleaned.sso.tokenRequest.headers) }
        };
      }
      const r = await apiService.put(`/api/me/tenant-admin/product-api/${productId}/api-config`, { config: cleaned || {} }) as ApiResponse<any>;
      if (r.success) {
        onSaved?.();
      } else {
        throw new Error((r as any).message || 'Failed to save');
      }
    } catch (e: any) {
      console.error('Save failed:', e);
      alert(e.message || 'Failed to save API config');
    } finally {
      setSaving(false);
    }
  };

  const runApi = async () => {
    setRunning(true);
    setRunResult(null);
    try {
      const r = await apiService.post(`/api/me/tenant-admin/product-api/${productId}/run-api`, {}) as ApiResponse<{ activated: number; deactivated: number; updated?: number; errors: any[] }>;
      if (r.success && r.data) {
        setRunResult(r.data);
        loadPending();
        loadConfig();
      } else {
        throw new Error((r as any).message || 'Run failed');
      }
    } catch (e: any) {
      console.error('Run failed:', e);
      alert(e.message || 'API run failed');
    } finally {
      setRunning(false);
    }
  };

  const runUpdateAll = async () => {
    setRunningUpdate(true);
    setRunResult(null);
    try {
      const r = await apiService.post(`/api/me/tenant-admin/product-api/${productId}/run-api`, { updateAll: true }) as ApiResponse<{ updated: number; errors: any[] }>;
      if (r.success && r.data) {
        setRunResult(r.data);
        loadPending();
        loadConfig();
      } else {
        throw new Error((r as any).message || 'Update failed');
      }
    } catch (e: any) {
      console.error('Update failed:', e);
      alert(e.message || 'Update all failed');
    } finally {
      setRunningUpdate(false);
    }
  };

  const testSsoLogin = async () => {
    setSsoTestLoginLoading(true);
    setSsoTestLoginResult(null);
    try {
      const r = await apiService.post(`/api/me/tenant-admin/product-api/${productId}/test-sso-login`) as ApiResponse<{ status: number; statusText: string; extractedToken?: string | null; tokenPathUsed?: string; data?: any; headers?: Record<string, string>; requestUrl?: string; requestMethod?: string; requestBody?: Record<string, unknown> }>;
      if (r.success && r.data) {
        setSsoTestLoginResult({
          status: r.data.status,
          statusText: r.data.statusText,
          extractedToken: r.data.extractedToken ?? null,
          tokenPathUsed: r.data.tokenPathUsed,
          data: r.data.data,
          headers: r.data.headers,
          requestUrl: r.data.requestUrl,
          requestMethod: r.data.requestMethod,
          requestBody: r.data.requestBody
        });
      } else {
        setSsoTestLoginResult({ status: 0, statusText: (r as any).message || 'Failed', extractedToken: null });
      }
    } catch (e: any) {
      setSsoTestLoginResult({ status: 0, statusText: e?.message || 'Request failed', extractedToken: null });
    } finally {
      setSsoTestLoginLoading(false);
    }
  };

  const testSsoMemberToken = async () => {
    setSsoTestTokenLoading(true);
    setSsoTestTokenResult(null);
    try {
      const r = await apiService.post(`/api/me/tenant-admin/product-api/${productId}/test-sso-token`, {
        testMemberExternalId: testMemberExternalId.trim() || undefined
      }) as ApiResponse<{ status: number; statusText: string; memberTokenPreview?: string | null; data?: any; requestUrl?: string; requestMethod?: string; requestBody?: Record<string, unknown> }>;
      if (r.success && r.data) {
        setSsoTestTokenResult({
          status: r.data.status,
          statusText: r.data.statusText,
          memberTokenPreview: r.data.memberTokenPreview ?? null,
          data: r.data.data,
          requestUrl: r.data.requestUrl,
          requestMethod: r.data.requestMethod,
          requestBody: r.data.requestBody
        });
      } else {
        setSsoTestTokenResult({ status: 0, statusText: (r as any).message || 'Failed', memberTokenPreview: null });
      }
    } catch (e: any) {
      setSsoTestTokenResult({ status: 0, statusText: e?.message || 'Request failed', memberTokenPreview: null });
    } finally {
      setSsoTestTokenLoading(false);
    }
  };

  const testSsoPortal = async () => {
    setSsoTestPortalLoading(true);
    try {
      const r = await apiService.post(`/api/me/tenant-admin/product-api/${productId}/test-sso-portal`, {
        testMemberExternalId: testMemberExternalId.trim() || undefined
      }) as ApiResponse<{ url: string }>;
      if (r.success && r.data?.url) {
        window.open(r.data.url, '_blank', 'noopener,noreferrer');
      } else {
        alert((r as any).message || 'Could not generate SSO URL');
      }
    } catch (e: any) {
      alert(e?.message || 'SSO portal test failed');
    } finally {
      setSsoTestPortalLoading(false);
    }
  };

  const enrollment = config?.enrollment ?? emptyEnrollmentConfig();
  const updateConfig = config?.update ?? emptyUpdateConfig();
  const deactivation = config?.deactivation ?? emptyDeactivationConfig();
  const authStep = config?.authStep;
  const sso = config?.sso ?? emptySSOConfig();

  const updateSSO = (updates: Partial<SSOConfig>) => {
    setConfig((c) => ({
      ...c,
      sso: { ...sso, ...updates }
    }));
  };

  const updateAuthStep = (updates: AuthStepConfig | null) => {
    setConfig((c) => ({ ...c, authStep: updates || undefined }));
  };

  const updateEnrollment = (updates: Partial<EnrollmentApiConfig>) => {
    setConfig((c) => ({
      ...c,
      enrollment: { ...enrollment, ...updates }
    }));
  };

  const updateDeactivation = (updates: Partial<DeactivationApiConfig>) => {
    setConfig((c) => ({
      ...c,
      deactivation: { ...deactivation, ...updates }
    }));
  };

  const updateUpdateConfig = (updates: Partial<UpdateApiConfig>) => {
    setConfig((c) => ({
      ...c,
      update: { ...updateConfig, ...updates }
    }));
  };

  const addItem = (section: 'enrollment' | 'update' | 'deactivation', part: 'headers' | 'body') => {
    const arr = part === 'headers'
      ? (section === 'enrollment' ? enrollment.headers : section === 'update' ? updateConfig.headers : deactivation.headers)
      : (section === 'enrollment' ? enrollment.body : section === 'update' ? updateConfig.body : deactivation.body);
    const next = [...(arr || []), emptyHeaderBodyItem()];
    if (section === 'enrollment') updateEnrollment({ [part]: next });
    else if (section === 'update') updateUpdateConfig({ [part]: next });
    else updateDeactivation({ [part]: next });
  };

  const updateItem = (section: 'enrollment' | 'update' | 'deactivation', part: 'headers' | 'body', index: number, updates: Partial<ApiHeaderBodyItem>) => {
    const arr = part === 'headers'
      ? (section === 'enrollment' ? enrollment.headers : section === 'update' ? updateConfig.headers : deactivation.headers)
      : (section === 'enrollment' ? enrollment.body : section === 'update' ? updateConfig.body : deactivation.body);
    const next = [...(arr || [])];
    next[index] = { ...next[index], ...updates };
    if (section === 'enrollment') updateEnrollment({ [part]: next });
    else if (section === 'update') updateUpdateConfig({ [part]: next });
    else updateDeactivation({ [part]: next });
  };

  const removeItem = (section: 'enrollment' | 'update' | 'deactivation', part: 'headers' | 'body', index: number) => {
    const arr = part === 'headers'
      ? (section === 'enrollment' ? enrollment.headers : section === 'update' ? updateConfig.headers : deactivation.headers)
      : (section === 'enrollment' ? enrollment.body : section === 'update' ? updateConfig.body : deactivation.body);
    const next = (arr || []).filter((_, i) => i !== index);
    if (section === 'enrollment') updateEnrollment({ [part]: next });
    else if (section === 'update') updateUpdateConfig({ [part]: next });
    else updateDeactivation({ [part]: next });
  };

  const CONTENT_TYPE_OPTIONS = [
    { value: 'application/json', label: 'application/json' },
    { value: 'application/x-www-form-urlencoded', label: 'application/x-www-form-urlencoded' },
    { value: 'multipart/form-data', label: 'multipart/form-data' }
  ] as const;

  const renderSsoKeyValueSection = (
    title: string,
    items: ApiHeaderBodyItem[],
    onChange: (next: ApiHeaderBodyItem[]) => void,
    options?: { contentType?: string; onContentTypeChange?: (v: string) => void }
  ) => {
    const arr = items || [];
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-gray-700">{title}</h4>
          <button
            type="button"
            onClick={() => onChange([...arr, emptyHeaderBodyItem()])}
            className="text-blue-600 hover:bg-blue-50 text-sm flex items-center px-2 py-1 rounded"
          >
            <Plus className="h-4 w-4 mr-1" />
            Add
          </button>
        </div>
        <div className="space-y-2">
          {options?.contentType != null && options?.onContentTypeChange && (
            <div className="flex gap-2 items-center">
              <input value="Content-Type" readOnly className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-600" />
              <div className="w-40" />
              <select
                value={options.contentType || 'application/json'}
                onChange={(e) => options.onContentTypeChange?.(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                {CONTENT_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <div className="w-10" />
            </div>
          )}
          {arr.map((item, i) => {
            if (options?.contentType != null && (item.key || '').toLowerCase() === 'content-type') return null;
            return (
              <div key={i} className="flex gap-2 items-center">
                <input
                  placeholder="Key"
                  value={item.key}
                  onChange={(e) => {
                    const next = [...arr];
                    next[i] = { ...next[i], key: e.target.value };
                    onChange(next);
                  }}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
                <select
                  value={item.prefill || ''}
                  onChange={(e) => {
                    const next = [...arr];
                    next[i] = { ...next[i], prefill: (e.target.value || null) as ApiHeaderBodyItem['prefill'] };
                    onChange(next);
                  }}
                  className="w-40 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                >
                  <option value="">Manual</option>
                  {PREFILL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <input
                  placeholder="Value"
                  value={item.value}
                  onChange={(e) => {
                    const next = [...arr];
                    next[i] = { ...next[i], value: e.target.value };
                    onChange(next);
                  }}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  disabled={!!item.prefill}
                />
                <button type="button" onClick={() => onChange(arr.filter((_, idx) => idx !== i))} className="p-2 text-red-600 hover:bg-red-50 rounded">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderKeyValueSection = (
    title: string,
    section: 'enrollment' | 'update' | 'deactivation',
    part: 'headers' | 'body'
  ) => {
    const items = part === 'headers'
      ? (section === 'enrollment' ? enrollment.headers : section === 'update' ? updateConfig.headers : deactivation.headers)
      : (section === 'enrollment' ? enrollment.body : section === 'update' ? updateConfig.body : deactivation.body) || [];
    const contentType = part === 'headers'
      ? (section === 'enrollment' ? enrollment.contentType : section === 'update' ? updateConfig.contentType : deactivation.contentType)
      : null;
    const onContentTypeChange = part === 'headers'
      ? (v: string) => (section === 'enrollment' ? updateEnrollment : section === 'update' ? updateUpdateConfig : updateDeactivation)({ contentType: v as any })
      : null;
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-gray-700">{title}</h4>
          <button
            type="button"
            onClick={() => addItem(section, part)}
            className="text-blue-600 hover:text-blue-800 text-sm flex items-center"
          >
            <Plus className="h-4 w-4 mr-1" />
            Add
          </button>
        </div>
        <div className="space-y-2">
          {part === 'headers' && onContentTypeChange && (
            <div className="flex gap-2 items-center">
              <input
                value="Content-Type"
                readOnly
                className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-600"
              />
              <div className="w-40" />
              <select
                value={contentType || 'application/json'}
                onChange={(e) => onContentTypeChange(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                {CONTENT_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <div className="w-10" />
            </div>
          )}
          {items.map((item, i) => {
            if (part === 'headers' && (item.key || '').toLowerCase() === 'content-type') return null;
            return (
            <div key={i} className="flex gap-2 items-center">
              <input
                placeholder="Key"
                value={item.key}
                onChange={(e) => updateItem(section, part, i, { key: e.target.value })}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
              <select
                value={item.prefill || ''}
                onChange={(e) => updateItem(section, part, i, { prefill: (e.target.value || null) as any })}
                className="w-40 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="">Manual</option>
                {PREFILL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <input
                placeholder="Value"
                value={item.value}
                onChange={(e) => updateItem(section, part, i, { value: e.target.value })}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                disabled={!!item.prefill}
              />
              {(part === 'headers' || part === 'body') && item.prefill === 'authToken' && (
                <button
                  type="button"
                  onClick={() => setShowAuthStepModal(true)}
                  className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded"
                  title="Configure auth token"
                >
                  <Settings className="h-4 w-4" />
                </button>
              )}
              <button type="button" onClick={() => removeItem(section, part, i)} className="p-2 text-red-600 hover:bg-red-50 rounded">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          );
          })}
        </div>
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-6 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-xl font-semibold text-gray-900">API Configuration - {productName}</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowCopyModal(true)}
                className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700"
              >
                <Copy className="h-4 w-4" />
                Copy from another product
              </button>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-2">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        <div className="border-b border-gray-200 flex-shrink-0">
          <nav className="flex space-x-6 px-6">
            {(['enrollment', 'update', 'deactivation', 'sso', 'run-status'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`py-4 px-1 border-b-2 font-medium text-sm capitalize ${
                  activeTab === tab
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab === 'run-status' ? 'Run Status' : tab === 'enrollment' ? 'Enrollment API' : tab === 'update' ? 'Update API' : tab === 'deactivation' ? 'Deactivation API' : 'SSO'}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            </div>
          ) : (
            <>
              {activeTab === 'enrollment' && (
                <div className="space-y-6">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={enrollment.enabled}
                      onChange={(e) => updateEnrollment({ enabled: e.target.checked })}
                      className="rounded border-gray-300"
                    />
                    <span className="text-sm font-medium">Enable enrollment API</span>
                  </label>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                    <select
                      value={enrollment.method}
                      onChange={(e) => updateEnrollment({ method: e.target.value })}
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
                      value={enrollment.endpoint}
                      onChange={(e) => updateEnrollment({ endpoint: e.target.value })}
                      placeholder="https://api.example.com/endpoint"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    />
                  </div>
                  {renderKeyValueSection('Request headers', 'enrollment', 'headers')}
                  {renderKeyValueSection('Request body', 'enrollment', 'body')}
                  <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                    <h4 className="text-sm font-medium text-gray-700 mb-2">Response – extract token</h4>
                    <p className="text-xs text-gray-500 mb-3">Where to find the token in the API response (e.g. Authorization header or body).</p>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Token path</label>
                        <input
                          value={enrollment.responseMapping?.tokenPath || ''}
                          onChange={(e) => updateEnrollment({ responseMapping: { ...enrollment.responseMapping, tokenPath: e.target.value || undefined } })}
                          placeholder="headers.Authorization or data.token"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Prefix to strip</label>
                        <input
                          value={enrollment.responseMapping?.tokenPrefixStrip || ''}
                          onChange={(e) => updateEnrollment({ responseMapping: { ...enrollment.responseMapping, tokenPrefixStrip: e.target.value || undefined } })}
                          placeholder="Bearer "
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white"
                        />
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setTestRunConfigType('enrollment'); setShowTestRunModal(true); }}
                    className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700"
                  >
                    <FlaskConical className="h-4 w-4" />
                    Test run
                  </button>
                </div>
              )}

              {activeTab === 'update' && (
                <div className="space-y-6">
                  <p className="text-sm text-gray-600">
                    Update existing members already synced to the external API (e.g. Lyric updateMember). Uses application/x-www-form-urlencoded for Lyric.
                  </p>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={updateConfig.enabled}
                      onChange={(e) => updateUpdateConfig({ enabled: e.target.checked })}
                      className="rounded border-gray-300"
                    />
                    <span className="text-sm font-medium">Enable update API</span>
                  </label>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                    <select
                      value={updateConfig.method}
                      onChange={(e) => updateUpdateConfig({ method: e.target.value })}
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
                      value={updateConfig.endpoint}
                      onChange={(e) => updateUpdateConfig({ endpoint: e.target.value })}
                      placeholder="https://portal.getlyric.com/go/api/census/updateMember"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    />
                  </div>
                  {renderKeyValueSection('Request headers', 'update', 'headers')}
                  {renderKeyValueSection('Request body', 'update', 'body')}
                  <button
                    type="button"
                    onClick={() => { setTestRunConfigType('update'); setShowTestRunModal(true); }}
                    className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700"
                  >
                    <FlaskConical className="h-4 w-4" />
                    Test run
                  </button>
                </div>
              )}

              {activeTab === 'deactivation' && (
                <div className="space-y-6">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={deactivation.enabled}
                      onChange={(e) => updateDeactivation({ enabled: e.target.checked })}
                      className="rounded border-gray-300"
                    />
                    <span className="text-sm font-medium">Enable deactivation API</span>
                  </label>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                    <select
                      value={deactivation.method}
                      onChange={(e) => updateDeactivation({ method: e.target.value })}
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
                      value={deactivation.endpoint}
                      onChange={(e) => updateDeactivation({ endpoint: e.target.value })}
                      placeholder="https://api.example.com/members/cancel"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    />
                  </div>
                  {renderKeyValueSection('Headers', 'deactivation', 'headers')}
                  {renderKeyValueSection('Body', 'deactivation', 'body')}
                  <button
                    type="button"
                    onClick={() => { setTestRunConfigType('deactivation'); setShowTestRunModal(true); }}
                    className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700"
                  >
                    <FlaskConical className="h-4 w-4" />
                    Test run
                  </button>
                </div>
              )}

              {activeTab === 'sso' && (
                <div className="space-y-6">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={sso.enabled}
                      onChange={(e) => updateSSO({ enabled: e.target.checked })}
                      className="rounded border-gray-300"
                    />
                    <span className="text-sm font-medium">Enable SSO configuration</span>
                  </label>

                  <div className="border border-gray-200 rounded-lg p-4 space-y-4">
                    <h4 className="text-sm font-medium text-gray-700">Admin login (required)</h4>
                    <p className="text-xs text-gray-500">Authenticate to obtain JWT for SSO token creation. Use manual value or e.g. {'${ENV_VAR}'} for secrets.</p>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Login URL</label>
                      <input
                        value={sso.login.endpoint}
                        onChange={(e) => updateSSO({ login: { ...sso.login, endpoint: e.target.value } })}
                        placeholder="https://portal.getlyric.com/go/api/login"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                        <select
                          value={sso.login.method}
                          onChange={(e) => updateSSO({ login: { ...sso.login, method: e.target.value } })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                        >
                          <option value="GET">GET</option>
                          <option value="POST">POST</option>
                          <option value="PUT">PUT</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Content-Type</label>
                        <select
                          value={sso.login.contentType}
                          onChange={(e) => updateSSO({ login: { ...sso.login, contentType: e.target.value as SSOLoginConfig['contentType'] } })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                        >
                          {CONTENT_TYPE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {renderSsoKeyValueSection('Login body', sso.login.body, (next) => updateSSO({ login: { ...sso.login, body: next } }))}
                    <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                      <h4 className="text-xs font-medium text-gray-700 mb-2">Response – token location</h4>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Token path</label>
                          <input
                            value={sso.login.responseMapping?.tokenPath || ''}
                            onChange={(e) => updateSSO({ login: { ...sso.login, responseMapping: { ...sso.login.responseMapping, tokenPath: e.target.value || undefined } } })}
                            placeholder="headers.Authorization or data.token"
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Prefix to strip</label>
                          <input
                            value={sso.login.responseMapping?.tokenPrefixStrip || ''}
                            onChange={(e) => updateSSO({ login: { ...sso.login, responseMapping: { ...sso.login.responseMapping, tokenPrefixStrip: e.target.value || undefined } } })}
                            placeholder="Bearer "
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="border border-gray-200 rounded-lg p-4 space-y-4">
                    <h4 className="text-sm font-medium text-gray-700">Token request (optional)</h4>
                    <p className="text-xs text-gray-500">Create member SSO access token. Use prefills e.g. Household Member ID for memberExternalId.</p>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={sso.tokenRequest?.enabled ?? false}
                        onChange={(e) => updateSSO({ tokenRequest: { ...(sso.tokenRequest ?? emptySSOTokenRequestConfig()), enabled: e.target.checked } })}
                        className="rounded border-gray-300"
                      />
                      <span className="text-sm">Enable token request</span>
                    </label>
                    {sso.tokenRequest?.enabled && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Endpoint</label>
                          <input
                            value={sso.tokenRequest.endpoint}
                            onChange={(e) => updateSSO({ tokenRequest: { ...sso.tokenRequest!, endpoint: e.target.value } })}
                            placeholder="https://portal.getlyric.com/go/api/sso/createAccessTokenWithGroupCode"
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                            <select
                              value={sso.tokenRequest.method}
                              onChange={(e) => updateSSO({ tokenRequest: { ...sso.tokenRequest!, method: e.target.value } })}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                            >
                              <option value="GET">GET</option>
                              <option value="POST">POST</option>
                              <option value="PUT">PUT</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Content-Type</label>
                            <select
                              value={sso.tokenRequest.contentType || 'application/x-www-form-urlencoded'}
                              onChange={(e) => updateSSO({ tokenRequest: { ...sso.tokenRequest!, contentType: e.target.value as SSOTokenRequestConfig['contentType'] } })}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                            >
                              {CONTENT_TYPE_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        {renderSsoKeyValueSection('Headers', sso.tokenRequest.headers || [], (next) => updateSSO({ tokenRequest: { ...sso.tokenRequest!, headers: next } }), {
                          contentType: sso.tokenRequest.contentType,
                          onContentTypeChange: (v) => updateSSO({ tokenRequest: { ...sso.tokenRequest!, contentType: v as SSOTokenRequestConfig['contentType'] } })
                        })}
                        {renderSsoKeyValueSection('Body', sso.tokenRequest.body || [], (next) => updateSSO({ tokenRequest: { ...sso.tokenRequest!, body: next } }))}
                      </>
                    )}
                  </div>

                  <div className="border border-gray-200 rounded-lg p-4 space-y-4">
                    <h4 className="text-sm font-medium text-gray-700">Portal</h4>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Portal URL (required)</label>
                      <input
                        value={sso.portal.portalBaseUrl}
                        onChange={(e) => updateSSO({ portal: { ...sso.portal, portalBaseUrl: e.target.value } })}
                        placeholder="https://portal.getlyric.com"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">URL template</label>
                      <input
                        value={sso.portal.urlTemplate}
                        onChange={(e) => updateSSO({ portal: { ...sso.portal, urlTemplate: e.target.value } })}
                        placeholder="/lyric/login/sso/{accessToken}?redirectId={redirectId}"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      />
                      <p className="text-xs text-gray-500 mt-1">Use {'{accessToken}'} and optional placeholders e.g. {'{redirectId}'}.</p>
                    </div>
                    {renderSsoKeyValueSection('Custom fields (query params / template vars)', sso.portal.customFields || [], (next) => updateSSO({ portal: { ...sso.portal, customFields: next } }))}
                  </div>

                  <div className="border border-gray-200 rounded-lg p-4 space-y-4">
                    <h4 className="text-sm font-medium text-gray-700">Test SSO</h4>
                    <p className="text-xs text-gray-500">1) Test Authorization = admin login only. 2) Test member token = admin login + token request (when enabled). 3) Open SSO portal = full flow in a new tab.</p>
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={testSsoLogin}
                        disabled={ssoTestLoginLoading || !sso.login.endpoint}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                      >
                        {ssoTestLoginLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
                        Test Authorization
                      </button>
                      {sso.tokenRequest?.enabled && (
                        <button
                          type="button"
                          onClick={testSsoMemberToken}
                          disabled={ssoTestTokenLoading || !sso.tokenRequest?.endpoint}
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                        >
                          {ssoTestTokenLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
                          Test member token
                        </button>
                      )}
                      <div className="flex items-center gap-2">
                        <label className="text-sm text-gray-600">Test member external ID</label>
                        <input
                          value={testMemberExternalId}
                          onChange={(e) => setTestMemberExternalId(e.target.value)}
                          placeholder="TEST_MEMBER"
                          className="w-40 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={testSsoPortal}
                        disabled={ssoTestPortalLoading || !sso.portal.portalBaseUrl}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                      >
                        {ssoTestPortalLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                        Open SSO portal
                      </button>
                    </div>
                    {ssoTestLoginResult && (
                      <div className="mt-3 p-3 rounded-lg bg-gray-50 border border-gray-200 text-sm">
                        <div className="font-medium text-gray-700 mb-1">Authorization test result</div>
                        <div className="space-y-1 text-gray-600">
                          <div>Status: {ssoTestLoginResult.status} {ssoTestLoginResult.statusText}</div>
                          {ssoTestLoginResult.tokenPathUsed && (
                            <div>Token path used: <code className="text-xs bg-gray-200 px-1 rounded">{ssoTestLoginResult.tokenPathUsed}</code></div>
                          )}
                          {ssoTestLoginResult.extractedToken != null ? (
                            <div className="break-all">Token (preview): {ssoTestLoginResult.extractedToken}</div>
                          ) : ssoTestLoginResult.status >= 200 && ssoTestLoginResult.status < 300 && (
                            <div className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-1">
                              No token extracted. Set <strong>Token path</strong> in Response – token location to where the API returns the token (e.g. <code className="text-xs">data.accessToken</code> or <code className="text-xs">headers.Authorization</code>). Check response body/headers below.
                            </div>
                          )}
                          {(ssoTestLoginResult.requestUrl != null || ssoTestLoginResult.requestBody != null) && (
                            <details className="mt-2" open>
                              <summary className="cursor-pointer text-gray-500">Request (for debugging)</summary>
                              <div className="mt-1 p-2 bg-white rounded border text-xs overflow-auto max-h-48 space-y-1">
                                {ssoTestLoginResult.requestMethod && <div><span className="text-gray-500">Method:</span> {ssoTestLoginResult.requestMethod}</div>}
                                {ssoTestLoginResult.requestUrl && <div className="break-all"><span className="text-gray-500">URL:</span> {ssoTestLoginResult.requestUrl}</div>}
                                {ssoTestLoginResult.requestBody != null && Object.keys(ssoTestLoginResult.requestBody).length > 0 && (
                                  <div><span className="text-gray-500">Body/params:</span><pre className="mt-0.5 whitespace-pre-wrap break-all">{JSON.stringify(ssoTestLoginResult.requestBody, null, 2)}</pre></div>
                                )}
                              </div>
                            </details>
                          )}
                          {ssoTestLoginResult.data != null && (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-gray-500">Response body</summary>
                              <pre className="mt-1 p-2 bg-white rounded border text-xs overflow-auto max-h-40">{JSON.stringify(ssoTestLoginResult.data, null, 2)}</pre>
                            </details>
                          )}
                          {ssoTestLoginResult.headers != null && Object.keys(ssoTestLoginResult.headers).length > 0 && (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-gray-500">Response headers</summary>
                              <pre className="mt-1 p-2 bg-white rounded border text-xs overflow-auto max-h-40">{JSON.stringify(ssoTestLoginResult.headers, null, 2)}</pre>
                            </details>
                          )}
                        </div>
                      </div>
                    )}
                    {ssoTestTokenResult && (
                      <div className="mt-3 p-3 rounded-lg bg-gray-50 border border-gray-200 text-sm">
                        <div className="font-medium text-gray-700 mb-1">Member token test result</div>
                        <div className="space-y-1 text-gray-600">
                          <div>Status: {ssoTestTokenResult.status} {ssoTestTokenResult.statusText}</div>
                          {ssoTestTokenResult.memberTokenPreview != null && (
                            <div className="break-all">Member token (preview): {ssoTestTokenResult.memberTokenPreview}</div>
                          )}
                          {(ssoTestTokenResult.requestUrl != null || ssoTestTokenResult.requestBody != null) && (
                            <details className="mt-2" open>
                              <summary className="cursor-pointer text-gray-500">Request (for debugging)</summary>
                              <div className="mt-1 p-2 bg-white rounded border text-xs overflow-auto max-h-48 space-y-1">
                                {ssoTestTokenResult.requestMethod && <div><span className="text-gray-500">Method:</span> {ssoTestTokenResult.requestMethod}</div>}
                                {ssoTestTokenResult.requestUrl && <div className="break-all"><span className="text-gray-500">URL:</span> {ssoTestTokenResult.requestUrl}</div>}
                                {ssoTestTokenResult.requestBody != null && Object.keys(ssoTestTokenResult.requestBody).length > 0 && (
                                  <div><span className="text-gray-500">Body/params:</span><pre className="mt-0.5 whitespace-pre-wrap break-all">{JSON.stringify(ssoTestTokenResult.requestBody, null, 2)}</pre></div>
                                )}
                              </div>
                            </details>
                          )}
                          {ssoTestTokenResult.data != null && (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-gray-500">Response body</summary>
                              <pre className="mt-1 p-2 bg-white rounded border text-xs overflow-auto max-h-40">{JSON.stringify(ssoTestTokenResult.data, null, 2)}</pre>
                            </details>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'run-status' && (
                <div className="space-y-6">
                  <label className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <input
                      type="checkbox"
                      checked={!!config?.runDaily}
                      onChange={(e) => setConfig((c) => ({ ...(c || {}), runDaily: e.target.checked }))}
                      className="mt-1 rounded border-gray-300"
                    />
                    <span>
                      <span className="text-sm font-medium text-gray-900">Run daily</span>
                      <span className="block text-xs text-gray-500 mt-1">
                        When enabled, the scheduled job runs this product&apos;s API sync once per day (same as &quot;Run API for everyone&quot;). Save to apply.
                      </span>
                    </span>
                  </label>
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-medium text-gray-900">Run Status</h3>
                    <button
                      type="button"
                      onClick={() => { loadPending(); loadConfig(); }}
                      className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Refresh
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-sm text-gray-600">Pending households (need sync)</p>
                      <p className="text-2xl font-semibold text-gray-900">{pendingHouseholds}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-sm text-gray-600">Already synced</p>
                      <p className="text-2xl font-semibold text-gray-900">{syncedHouseholds}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-sm text-gray-600">Pending deactivations</p>
                      <div className="flex items-center gap-2">
                        <p className="text-2xl font-semibold text-gray-900">{pendingDeactivations}</p>
                        {pendingDeactivations > 0 && (
                          <button
                            type="button"
                            onClick={loadPendingDeactivationList}
                            title="View members"
                            className="p-1 rounded hover:bg-gray-200 text-gray-500 hover:text-gray-700"
                          >
                            <Users className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  {lastRunAt && (
                    <p className="text-sm text-gray-600">
                      Last run: {new Date(lastRunAt).toLocaleString()}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-6 items-start">
                    <div>
                      <button
                        onClick={runApi}
                        disabled={running || runningUpdate}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                      >
                        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        {running ? 'Running...' : 'Run API for everyone'}
                      </button>
                      <p className="mt-1 text-xs text-gray-500 max-w-xs">
                        Sync new members, update re-enrollments, and deactivate terminated.
                      </p>
                    </div>
                    <div>
                      <button
                        onClick={runUpdateAll}
                        disabled={running || runningUpdate || syncedHouseholds === 0 || !config?.update?.enabled}
                        className="flex items-center gap-2 px-4 py-2 border border-purple-300 text-purple-700 rounded-lg hover:bg-purple-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {runningUpdate ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        {runningUpdate ? 'Updating...' : 'Update all members'}
                      </button>
                      <p className="mt-1 text-xs text-gray-500 max-w-xs">
                        Refresh existing synced members only (no new syncs or terminations).
                      </p>
                    </div>
                  </div>
                  {runResult && (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm">
                      <p className="font-medium text-green-800">
                        {[
                          (runResult.activated ?? 0) > 0 && `Activated: ${runResult.activated}`,
                          (runResult.deactivated ?? 0) > 0 && `Deactivated: ${runResult.deactivated}`,
                          (runResult.updated ?? 0) > 0 && `Updated: ${runResult.updated}`
                        ].filter(Boolean).join(', ') || 'Done.'}
                      </p>
                      {((runResult.updatedList?.length ?? 0) > 0 || (runResult.deactivatedList?.length ?? 0) > 0 || (runResult.activatedList?.length ?? 0) > 0) && (
                        <div className="mt-3 space-y-2">
                          {runResult.updatedList && runResult.updatedList.length > 0 && (
                            <div>
                              <p className="text-xs font-medium text-gray-600 mb-0.5">Updated</p>
                              <ul className="text-gray-700 text-xs list-disc list-inside space-y-0.5">
                                {runResult.updatedList.map((item, idx) => (
                                  <li key={idx}>
                                    {item.memberId ? (
                                      <button
                                        type="button"
                                        onClick={() => handleOpenMember(item.memberId!)}
                                        className="text-blue-600 hover:underline text-left"
                                      >
                                        {item.memberName}
                                      </button>
                                    ) : (
                                      item.memberName
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {runResult.deactivatedList && runResult.deactivatedList.length > 0 && (
                            <div>
                              <p className="text-xs font-medium text-gray-600 mb-0.5">Deactivated</p>
                              <ul className="text-gray-700 text-xs list-disc list-inside space-y-0.5">
                                {runResult.deactivatedList.map((item, idx) => (
                                  <li key={idx}>
                                    {item.memberId ? (
                                      <button
                                        type="button"
                                        onClick={() => handleOpenMember(item.memberId!)}
                                        className="text-blue-600 hover:underline text-left"
                                      >
                                        {item.memberName}
                                      </button>
                                    ) : (
                                      item.memberName
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {runResult.activatedList && runResult.activatedList.length > 0 && (
                            <div>
                              <p className="text-xs font-medium text-gray-600 mb-0.5">Activated</p>
                              <ul className="text-gray-700 text-xs list-disc list-inside space-y-0.5">
                                {runResult.activatedList.map((item, idx) => (
                                  <li key={idx}>
                                    {item.memberId ? (
                                      <button
                                        type="button"
                                        onClick={() => handleOpenMember(item.memberId!)}
                                        className="text-blue-600 hover:underline text-left"
                                      >
                                        {item.memberName}
                                      </button>
                                    ) : (
                                      item.memberName
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                      {runResult.errors && runResult.errors.length > 0 && (
                        <div className="mt-2 space-y-2">
                          <p className="text-sm font-medium text-red-800">{runResult.errors.length} error(s)</p>
                          <ul className="space-y-1.5">
                            {runResult.errors.map((e: any, idx: number) => {
                              const status = e.responseStatus ?? '';
                              const label = `${e.memberName || 'Unknown'}: Error ${status}`.trim();
                              return (
                                <li key={idx} className="flex items-center justify-between gap-2 text-sm">
                                  <span className="text-red-700 truncate">{label}</span>
                                  <button
                                    type="button"
                                    onClick={() => setViewingError({
                                      memberName: e.memberName || 'Unknown',
                                      type: e.type || 'error',
                                      message: e.message,
                                      responseBody: e.responseBody,
                                      responseStatus: e.responseStatus
                                    })}
                                    className="flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 text-gray-700"
                                  >
                                    <Eye className="h-3 w-3" /> View
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {showTestRunModal && (
          <ProductAPITestRunModal
            productId={productId}
            isOpen={showTestRunModal}
            onClose={() => setShowTestRunModal(false)}
            initialConfig={
              testRunConfigType === 'enrollment'
                ? { endpoint: enrollment.endpoint, method: enrollment.method, contentType: enrollment.contentType, headers: enrollment.headers || [], body: enrollment.body || [], authStep: config?.authStep, responseMapping: enrollment.responseMapping }
                : testRunConfigType === 'update'
                ? { endpoint: updateConfig.endpoint, method: updateConfig.method, contentType: updateConfig.contentType, headers: updateConfig.headers || [], body: updateConfig.body || [], authStep: config?.authStep }
                : { endpoint: deactivation.endpoint, method: deactivation.method, contentType: deactivation.contentType, headers: deactivation.headers || [], body: deactivation.body || [], authStep: config?.authStep }
            }
          />
        )}

        {showAuthStepModal && (
          <AuthStepConfigModal
            isOpen={showAuthStepModal}
            onClose={() => setShowAuthStepModal(false)}
            config={authStep}
            onSave={(cfg) => { updateAuthStep(cfg); setShowAuthStepModal(false); }}
          />
        )}

        {showCopyModal && (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50"
            onClick={() => !copyLoading && setShowCopyModal(false)}
          >
            <div
              className="bg-white rounded-lg shadow-xl max-w-md w-full p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h4 className="text-lg font-semibold text-gray-900 mb-2">Copy API config from another product</h4>
              <p className="text-sm text-gray-600 mb-4">
                Select a product (bundles excluded). Its API configuration will be pasted here. Save when ready.
              </p>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Product</label>
                <SearchableDropdown
                  options={productOptions}
                  value={selectedProductId}
                  onChange={(value) => setSelectedProductId(value)}
                  placeholder={productsLoading ? 'Loading products...' : 'Select a product'}
                  loading={productsLoading}
                />
              </div>
              {copyError && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">
                  {copyError}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCopyModal(false)}
                  disabled={copyLoading}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCopyFromProductConfirm}
                  disabled={!selectedProductId || copyLoading}
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {copyLoading ? 'Copying...' : 'Copy configuration'}
                </button>
              </div>
            </div>
          </div>
        )}

        {showPendingDeactivationsModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[80vh] flex flex-col">
              <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                <h3 className="text-lg font-medium text-gray-900">Pending deactivations</h3>
                <button
                  type="button"
                  onClick={() => setShowPendingDeactivationsModal(false)}
                  className="p-1 rounded hover:bg-gray-100"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="p-4 overflow-auto flex-1">
                {loadingPendingDeactivations ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                  </div>
                ) : (
                  <ul className="text-sm text-gray-700 space-y-1.5">
                    {pendingDeactivationList.map((m) => (
                      <li key={m.enrollmentId} className="flex justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setShowPendingDeactivationsModal(false);
                            handleOpenMember(m.memberId);
                          }}
                          className="text-blue-600 hover:underline text-left"
                        >
                          {m.memberName}
                        </button>
                        {m.terminationDate && (
                          <span className="text-gray-400 text-xs shrink-0">
                            term {new Date(m.terminationDate).toLocaleDateString()}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {!loadingPendingDeactivations && pendingDeactivationList.length >= 100 && (
                  <p className="text-xs text-gray-500 mt-2">Showing first 100 of {pendingDeactivations}</p>
                )}
              </div>
              <div className="p-4 border-t border-gray-200">
                <button
                  type="button"
                  onClick={() => setShowPendingDeactivationsModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {selectedMemberForView && (
          <MemberManagementModal
            member={selectedMemberForView}
            householdMembers={householdMembersForView}
            memberEnrollments={memberEnrollmentsForView}
            enrollmentsLoading={enrollmentsLoadingForView}
            onClose={() => setSelectedMemberForView(null)}
            onEdit={() => setSelectedMemberForView(null)}
            formatCurrency={formatCurrency}
            getStatusColor={getStatusColor}
            getRelationshipIcon={getRelationshipIcon}
            getRelationshipColor={getRelationshipColor}
            canEdit={false}
            canDelete={false}
            onRefresh={async () => {
              if (selectedMemberForView?.MemberId) {
                await handleOpenMember(selectedMemberForView.MemberId);
              }
            }}
          />
        )}

        {viewingError && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] flex flex-col">
              <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                <h3 className="text-lg font-medium text-gray-900">
                  {viewingError.memberName} – {viewingError.type}
                </h3>
                <button
                  type="button"
                  onClick={() => setViewingError(null)}
                  className="p-1 rounded hover:bg-gray-100"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="p-4 overflow-auto flex-1 space-y-3">
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Message</p>
                  <p className="text-sm text-red-700">{viewingError.message}</p>
                </div>
                {viewingError.responseStatus != null && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Status</p>
                    <p className="text-sm text-gray-900">{viewingError.responseStatus}</p>
                  </div>
                )}
                {viewingError.responseBody != null && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Response</p>
                    <pre className="text-xs bg-gray-50 p-3 rounded border border-gray-200 overflow-auto max-h-64">
                      {typeof viewingError.responseBody === 'string'
                        ? viewingError.responseBody
                        : JSON.stringify(viewingError.responseBody, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
              <div className="p-4 border-t border-gray-200">
                <button
                  type="button"
                  onClick={() => setViewingError(null)}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-gray-200 p-4 flex justify-end gap-2 flex-shrink-0">
          <button
            onClick={saveConfig}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </button>
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
