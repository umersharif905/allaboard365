import { BookOpen, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import TrainingPlayer2Panel from '../../components/tenant-admin/training/player/TrainingPlayer2/TrainingPlayer2Panel';
import {
  diagnoseH2AgentLibraryVsAdminSave,
  isTrainingDiagnosticsConsoleEnabled,
  logH2ToConsole
} from '../../components/tenant-admin/training/trainingPlayerDiagnostics';
import type {
  AgentLibraryProgress,
  TrainingModule,
  TrainingPackage
} from '../../components/tenant-admin/training/trainingTypes';
import { useAgentTrainingIncomplete } from '../../contexts/AgentTrainingIncompleteContext';
import { useAuth } from '../../hooks/useAuth';
import { useShowCalloutControls } from '../../hooks/useShowCalloutControls';
import { apiService } from '../../services/api.service';

type CertificateGalleryItem = {
  packageId: string;
  packageTitle: string;
  certificate: {
    packageName: string;
    certificateName: string;
    certificateDetails: string;
    certificateImageUrl: string;
  };
  earned: boolean;
  awardedAt?: string | null;
};

const TRAINING_HEADER_LOGO_URL =
  'https://res.cloudinary.com/doi8qjcv6/image/upload/v1775067407/customers/mightywell/Favicon-01_ds7yuo.png';

export default function AgentTraining() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const showCalloutControls = useShowCalloutControls();
  const { refresh: refreshTrainingIncomplete, agentPortalTrainingEnabled } = useAgentTrainingIncomplete();

  useEffect(() => {
    if (!agentPortalTrainingEnabled) {
      navigate('/agent/dashboard', { replace: true });
    }
  }, [agentPortalTrainingEnabled, navigate]);
  const [packages, setPackages] = useState<TrainingPackage[]>([]);
  const [moduleLibrary, setModuleLibrary] = useState<TrainingModule[]>([]);
  const [certificateGallery, setCertificateGallery] = useState<CertificateGalleryItem[]>([]);
  const [agentProgress, setAgentProgress] = useState<AgentLibraryProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resettingProfile, setResettingProfile] = useState(false);
  const isLocalHost =
    typeof window !== 'undefined' &&
    ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

  const loadLibraryContent = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    if (!agentPortalTrainingEnabled) {
      if (!silent) {
        setLoading(false);
      }
      return;
    }
    if (!silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const res = (await apiService.get('/api/me/agent/training/library-content')) as {
        success?: boolean;
        data?: {
          packages?: TrainingPackage[];
          moduleLibrary?: TrainingModule[];
          certificates?: CertificateGalleryItem[];
          agentProgress?: AgentLibraryProgress;
        };
        message?: string;
      };
      if (!res?.success) {
        setPackages([]);
        setModuleLibrary([]);
        setCertificateGallery([]);
        setAgentProgress(null);
        setError(res?.message || 'Failed to load training library');
        return;
      }
      const pkgs = Array.isArray(res.data?.packages) ? res.data.packages : [];
      const mods = Array.isArray(res.data?.moduleLibrary) ? res.data.moduleLibrary : [];
      const certs = Array.isArray(res.data?.certificates) ? res.data.certificates : [];
      setPackages(pkgs);
      setModuleLibrary(mods);
      if (!silent && isTrainingDiagnosticsConsoleEnabled()) {
        const loadedAtIso = new Date().toISOString();
        const h2 = diagnoseH2AgentLibraryVsAdminSave(mods, loadedAtIso);
        logH2ToConsole(h2);
      }
      setCertificateGallery(certs);
      const progress = res.data?.agentProgress;
      setAgentProgress(
        progress && Array.isArray(progress.quizCompletions) && Array.isArray(progress.moduleCompletions)
          ? progress
          : { quizCompletions: [], moduleCompletions: [] }
      );

      if (pkgs.length === 0) {
        try {
          const diagRes = (await apiService.get(
            '/api/me/agent/training/library-content?diagnose=1'
          )) as { success?: boolean; data?: { diagnostics?: unknown } };
          const diag = diagRes?.data?.diagnostics ?? diagRes;
           
          console.warn('[AgentTraining] library-content empty — diagnostics (5 hypotheses)\n', JSON.stringify(diag, null, 2));
        } catch (diagErr) {
           
          console.warn('[AgentTraining] diagnose fetch failed', diagErr);
        }
      }
    } catch (e) {
      setPackages([]);
      setModuleLibrary([]);
      setCertificateGallery([]);
      setAgentProgress(null);
      setError(e instanceof Error ? e.message : 'Failed to load training library');
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [agentPortalTrainingEnabled, activeTenantId]);

  useEffect(() => {
    void loadLibraryContent();
  }, [loadLibraryContent]);

  const onUpdateModule = useCallback((moduleId: string, updater: (module: TrainingModule) => TrainingModule) => {
    setModuleLibrary(prev => prev.map(m => (m.id === moduleId ? updater(m) : m)));
  }, []);

  const onModuleCompleted = useCallback(
    async (packageId: string, moduleId: string) => {
      try {
        await apiService.post('/api/me/agent/training/library-modules/complete', { packageId, moduleId });
        await refreshTrainingIncomplete();
      } catch (err) {
        console.warn('[AgentTraining] library module completion failed', err);
      }
    },
    [refreshTrainingIncomplete]
  );

  const onCompleteLibraryQuiz = useCallback(
    async ({
      packageId,
      moduleId,
      stepId,
      quizId,
      score,
      totalQuestions
    }: {
      packageId: string;
      moduleId: string;
      stepId: string;
      quizId: string;
      score: number;
      totalQuestions: number;
    }) => {
      const res = (await apiService.post('/api/me/agent/training/library-quizzes/complete', {
        packageId,
        moduleId,
        stepId,
        quizId,
        score,
        totalQuestions
      })) as {
        success?: boolean;
        data?: { packageCertification?: { passed?: boolean } };
      };
      await loadLibraryContent({ silent: true });
      await refreshTrainingIncomplete();
      return {
        packageCertificationPassed: Boolean(res?.data?.packageCertification?.passed)
      };
    },
    [loadLibraryContent, refreshTrainingIncomplete]
  );

  const onResetTrainingProfile = useCallback(async () => {
    const confirmed = window.confirm(
      'Reset your training profile? This clears your training completion history so you can restart from a fresh state.'
    );
    if (!confirmed) {
      return;
    }
    setResettingProfile(true);
    try {
      await apiService.post('/api/me/agent/training/profile/reset');
      await loadLibraryContent();
      await refreshTrainingIncomplete();
    } catch (resetError) {
      console.warn('[AgentTraining] training profile reset failed', resetError);
      setError(resetError instanceof Error ? resetError.message : 'Failed to reset training profile');
    } finally {
      setResettingProfile(false);
    }
  }, [loadLibraryContent, refreshTrainingIncomplete]);

  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center min-h-[320px] px-4 sm:px-6 lg:px-8 py-8">
        <Loader2 className="h-10 w-10 animate-spin text-oe-primary" aria-hidden />
        <p className="mt-3 text-sm text-gray-600">Loading your training…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <img
              src={TRAINING_HEADER_LOGO_URL}
              alt=""
              width={32}
              height={32}
              className="h-8 w-8 shrink-0 object-contain"
            />
            <BookOpen className="h-7 w-7 text-oe-primary" aria-hidden />
            Training
          </h1>
        </div>
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
          <button
            type="button"
            onClick={() => void loadLibraryContent()}
            className="ml-2 font-medium text-oe-primary underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (packages.length === 0) {
    return (
      <div className="px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <img
              src={TRAINING_HEADER_LOGO_URL}
              alt=""
              width={32}
              height={32}
              className="h-8 w-8 shrink-0 object-contain"
            />
            <BookOpen className="h-7 w-7 text-oe-primary" aria-hidden />
            Training
          </h1>
          <p className="text-gray-600 mt-1 text-sm">
            When your organization assigns active training packages to your agency, they will appear here.
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-600 text-sm">
          No library training is assigned to your tenant yet.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="bg-white px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
              <img
                src={TRAINING_HEADER_LOGO_URL}
                alt=""
                width={32}
                height={32}
                className="h-8 w-8 shrink-0 object-contain"
              />              
              Training
            </h1>
            <p className="text-gray-600 mt-1 text-sm">
              Work through assigned packages, steps, and section quizzes. Progress is saved when you finish each module.
            </p>
          </div>
          {isLocalHost ? (
            <button
              type="button"
              onClick={() => void onResetTrainingProfile()}
              disabled={resettingProfile}
              className="inline-flex shrink-0 items-center rounded-md border border-rose-300 bg-rose-100 px-3 py-2 text-xs font-semibold text-rose-900 hover:bg-rose-200 disabled:cursor-not-allowed disabled:opacity-60"
              title="Localhost-only: clears this user's training profile so testing can restart from a fresh state."
            >
              {resettingProfile ? 'Resetting...' : 'Reset Training Profile'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 min-h-0 min-w-0 w-full">
        <TrainingPlayer2Panel
          key={packages.map(p => p.id).join('|')}
          packages={packages}
          moduleLibrary={moduleLibrary}
          initialPackageId=""
          initialTabId={location.pathname.endsWith('/certificates') ? 'certificates' : 'curriculum'}
          onUpdateModule={onUpdateModule}
          onModuleCompleted={onModuleCompleted}
          onCompleteLibraryQuiz={onCompleteLibraryQuiz}
          onNavigateToCertificates={() => navigate('/agent/training/certificates')}
          certificateGallery={certificateGallery}
          agentProgress={agentProgress}
          showColumbusCallout
          columbusShowDevControls={showCalloutControls}
        />
      </div>
    </div>
  );
}
