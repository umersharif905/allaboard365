import { AlertCircle, CheckCircle2, RefreshCw, X } from 'lucide-react';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiService } from '../services/api.service';
import type { ApiResponse } from '../types/index';
import {
  AgentLicenseValidationData,
  AgentProfileValidationData,
  AgentValidationSummary,
  buildAgentValidationSummary,
} from '../utils/agent-validation';

const DRAWER_ANIMATION_MS = 220;

type AgentProfileValidationContextValue = {
  summary: AgentValidationSummary | null;
  isLoading: boolean;
  isRefreshing: boolean;
  loadFailed: boolean;
  runValidation: (opts?: { initial?: boolean }) => Promise<void>;
  openDrawer: () => void;
  closeDrawer: () => void;
  isDrawerMounted: boolean;
  isDrawerVisible: boolean;
  statusClasses: { badge: string; action: string };
  missingPreview: string;
  goToChecklistItem: (targetId: string, guide?: string) => void;
  /** True when all validation checks pass (100% complete). */
  isProfileComplete: boolean;
};

const AgentProfileValidationContext = createContext<AgentProfileValidationContextValue | null>(null);

export const useAgentProfileValidation = (): AgentProfileValidationContextValue | null => {
  return useContext(AgentProfileValidationContext);
};

export const AgentProfileValidationProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [summary, setSummary] = useState<AgentValidationSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isDrawerMounted, setIsDrawerMounted] = useState(false);
  const [isDrawerVisible, setIsDrawerVisible] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const validationRequestIdRef = useRef(0);

  const runValidation = useCallback(async ({ initial = false }: { initial?: boolean } = {}) => {
    const requestId = ++validationRequestIdRef.current;

    if (initial) {
      setIsLoading(true);
    } else {
      setIsRefreshing(true);
    }

    try {
      const [profileResponse, licensesResponse] = await Promise.all([
        apiService.get<ApiResponse<AgentProfileValidationData>>('/api/me/agent/profile'),
        apiService.get<ApiResponse<AgentLicenseValidationData[]>>('/api/me/agent/licenses'),
      ]);

      if (requestId !== validationRequestIdRef.current) {
        return;
      }

      if (!profileResponse.success || !profileResponse.data) {
        setLoadFailed(true);
        return;
      }

      const licenses =
        licensesResponse.success && Array.isArray(licensesResponse.data)
          ? licensesResponse.data
          : [];

      setSummary(buildAgentValidationSummary(profileResponse.data, licenses));
      setLoadFailed(false);
    } catch {
      if (requestId === validationRequestIdRef.current) {
        setLoadFailed(true);
      }
    } finally {
      if (requestId === validationRequestIdRef.current) {
        if (initial) {
          setIsLoading(false);
        } else {
          setIsRefreshing(false);
        }
      }
    }
  }, []);

  useEffect(() => {
    void runValidation({ initial: true });
  }, [runValidation]);

  useEffect(() => {
    const handleValidationRevalidate = () => {
      void runValidation();
    };

    window.addEventListener('agent-validation-revalidate', handleValidationRevalidate);
    return () => {
      window.removeEventListener('agent-validation-revalidate', handleValidationRevalidate);
    };
  }, [runValidation]);

  const openDrawer = useCallback(() => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    setIsDrawerMounted(true);
    window.requestAnimationFrame(() => {
      setIsDrawerVisible(true);
    });
  }, []);

  const closeDrawer = useCallback(() => {
    setIsDrawerVisible(false);

    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
    }

    closeTimerRef.current = window.setTimeout(() => {
      setIsDrawerMounted(false);
      closeTimerRef.current = null;
    }, DRAWER_ANIMATION_MS);
  }, []);

  useEffect(() => {
    if (isDrawerMounted) {
      closeDrawer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.hash]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const statusClasses = useMemo(() => {
    if (!summary) {
      return {
        badge: 'bg-gray-100 text-gray-700',
        action: 'text-gray-700 hover:text-gray-900',
      };
    }

    if (summary.tone === 'good') {
      return {
        badge: 'bg-emerald-100 text-emerald-700',
        action: 'text-emerald-700 hover:text-emerald-800',
      };
    }

    if (summary.tone === 'critical') {
      return {
        badge: 'bg-rose-100 text-rose-700',
        action: 'text-rose-700 hover:text-rose-800',
      };
    }

    return {
      badge: 'bg-amber-100 text-amber-700',
      action: 'text-amber-700 hover:text-amber-800',
    };
  }, [summary]);

  const missingPreview = useMemo(() => {
    if (!summary || summary.missing.length === 0) {
      return 'All required profile metadata is complete';
    }

    const previewItems = summary.missing
      .slice(0, 2)
      .map((item) => item.label)
      .join(', ');
    const extra = summary.missing.length - 2;

    return extra > 0 ? `Missing: ${previewItems} +${extra} more` : `Missing: ${previewItems}`;
  }, [summary]);

  const goToChecklistItem = useCallback(
    (targetId: string, guide?: string) => {
      closeDrawer();
      const params = new URLSearchParams(location.search);
      if (guide) {
        params.set('guide', guide);
      } else {
        params.delete('guide');
      }
      const search = params.toString();
      const settingsPath = `/agent/settings${search ? `?${search}` : ''}#${targetId}`;

      if (location.pathname === '/agent/settings') {
        navigate(settingsPath, { replace: true });
        const targetElement = document.getElementById(targetId);
        if (targetElement) {
          targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }

      navigate(settingsPath);
    },
    [closeDrawer, location.pathname, location.search, navigate]
  );

  const isProfileComplete = Boolean(summary && summary.missing.length === 0);

  const value = useMemo<AgentProfileValidationContextValue>(
    () => ({
      summary,
      isLoading,
      isRefreshing,
      loadFailed,
      runValidation,
      openDrawer,
      closeDrawer,
      isDrawerMounted,
      isDrawerVisible,
      statusClasses,
      missingPreview,
      goToChecklistItem,
      isProfileComplete,
    }),
    [
      summary,
      isLoading,
      isRefreshing,
      loadFailed,
      runValidation,
      openDrawer,
      closeDrawer,
      isDrawerMounted,
      isDrawerVisible,
      statusClasses,
      missingPreview,
      goToChecklistItem,
      isProfileComplete,
    ]
  );

  return (
    <AgentProfileValidationContext.Provider value={value}>
      {children}
      {isDrawerMounted && (
        <>
          <button
            type="button"
            aria-label="Close validation checklist"
            className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-200 ease-out ${isDrawerVisible ? 'opacity-100' : 'opacity-0'}`}
            onClick={closeDrawer}
          />
          <aside
            className={`fixed right-0 top-0 z-50 h-full w-full max-w-sm bg-white shadow-xl border-l border-gray-200 flex flex-col transform transition-transform duration-200 ease-out ${isDrawerVisible ? 'translate-x-0' : 'translate-x-full'}`}
          >
            <div className="px-4 py-4 border-b border-gray-200 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-gray-900">Validation Checklist</h2>
                  <button
                    type="button"
                    className="inline-flex items-center text-gray-500 hover:text-gray-700"
                    onClick={() => void runValidation()}
                    aria-label="Revalidate checklist"
                    title="Revalidate"
                  >
                    <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <p className="text-xs text-gray-600 mt-1">
                  {summary ? `${summary.completed}/${summary.total} complete` : 'Unable to load checklist'}
                </p>
              </div>
              <button
                type="button"
                className="p-1 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                onClick={closeDrawer}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {summary?.checks.map((check) => (
                <div
                  key={check.key}
                  className={`rounded-lg border p-3 ${check.ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-200 bg-amber-50/70'}`}
                >
                  <div className="flex items-center gap-2">
                    {check.ok ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-amber-700 flex-shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">{check.label}</p>
                      <p className="text-xs text-gray-600">{check.ok ? 'Complete' : 'Missing'}</p>
                    </div>
                    {!check.ok && (
                      <div className="flex items-center gap-1 whitespace-nowrap">
                        <button
                          type="button"
                          className="text-xs font-medium text-oe-primary hover:text-oe-primary-dark"
                          onClick={() => goToChecklistItem(check.targetId, check.guide)}
                        >
                          Fix
                        </button>
                        <span className="text-gray-300 text-xs">|</span>
                        <button
                          type="button"
                          className="text-xs font-medium text-oe-primary hover:text-oe-primary-dark"
                          onClick={() => void runValidation()}
                        >
                          Revalidate
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="p-4 border-t border-gray-200">
              <button
                type="button"
                className="w-full inline-flex items-center justify-center rounded-md bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-dark transition-colors"
                onClick={() => {
                  const nextMissing = summary?.missing[0];
                  goToChecklistItem(nextMissing?.targetId || 'settings-profile', nextMissing?.guide);
                }}
              >
                Resolve Next Item
              </button>
            </div>
          </aside>
        </>
      )}
    </AgentProfileValidationContext.Provider>
  );
};

/** Sidebar block: shows profile completion only while loading (brief) or when incomplete; hidden at 100%. */
export const AgentProfileCompletionSidebar: React.FC = () => {
  const ctx = useAgentProfileValidation();
  if (!ctx) {
    return null;
  }

  const {
    summary,
    isLoading,
    loadFailed,
    openDrawer,
    statusClasses,
    missingPreview,
    isProfileComplete,
  } = ctx;

  if (isLoading) {
    return null;
  }

  if (loadFailed || !summary) {
    return (
      <div className="mt-2 flex items-center gap-1 text-[11px] leading-4 text-gray-500">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">Validation unavailable</span>
      </div>
    );
  }

  if (isProfileComplete) {
    return null;
  }

  return (
    <div className="mt-2 min-w-0">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClasses.badge}`}
        >
          {summary.tone === 'good' ? (
            <CheckCircle2 className="h-3 w-3 shrink-0" />
          ) : (
            <AlertCircle className="h-3 w-3 shrink-0" />
          )}
          {summary.completed}/{summary.total}
        </span>
        <button
          type="button"
          className={`text-[11px] font-medium whitespace-nowrap ${statusClasses.action}`}
          onClick={openDrawer}
        >
          Resolve
        </button>
      </div>
      <p className="mt-1 text-[11px] text-gray-600 leading-snug line-clamp-2">{missingPreview}</p>
    </div>
  );
};
