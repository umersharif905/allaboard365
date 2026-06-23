import { BookOpen, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import TrainingPlayer2Panel from '../../components/tenant-admin/training/player/TrainingPlayer2/TrainingPlayer2Panel';
import type {
  AgentLibraryProgress,
  TrainingModule,
  TrainingPackage
} from '../../components/tenant-admin/training/trainingTypes';
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

const EMPTY_PROGRESS: AgentLibraryProgress = { quizCompletions: [], moduleCompletions: [] };

/**
 * Back-office Training tab. VendorAgents/VendorAdmins get read-only access to
 * the same org-wide training agents use, so they share product knowledge.
 *
 * This is a resource, not a required course: no completion handlers are wired,
 * so nothing is recorded, no certificates are earned, and there is no due date.
 */
export default function VendorTraining() {
  const [packages, setPackages] = useState<TrainingPackage[]>([]);
  const [moduleLibrary, setModuleLibrary] = useState<TrainingModule[]>([]);
  const [certificateGallery, setCertificateGallery] = useState<CertificateGalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadLibraryContent = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await apiService.get('/api/me/vendor/training/library-content')) as {
        success?: boolean;
        data?: {
          packages?: TrainingPackage[];
          moduleLibrary?: TrainingModule[];
          certificates?: CertificateGalleryItem[];
        };
        message?: string;
      };
      if (!res?.success) {
        setPackages([]);
        setModuleLibrary([]);
        setCertificateGallery([]);
        setError(res?.message || 'Failed to load training');
        return;
      }
      setPackages(Array.isArray(res.data?.packages) ? res.data.packages : []);
      setModuleLibrary(Array.isArray(res.data?.moduleLibrary) ? res.data.moduleLibrary : []);
      setCertificateGallery(Array.isArray(res.data?.certificates) ? res.data.certificates : []);
    } catch (e) {
      setPackages([]);
      setModuleLibrary([]);
      setCertificateGallery([]);
      setError(e instanceof Error ? e.message : 'Failed to load training');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLibraryContent();
  }, [loadLibraryContent]);

  // Client-side only: keeps the player in sync as the user navigates modules.
  // Nothing is persisted — this surface is a read-only resource.
  const onUpdateModule = useCallback(
    (moduleId: string, updater: (module: TrainingModule) => TrainingModule) => {
      setModuleLibrary(prev => prev.map(m => (m.id === moduleId ? updater(m) : m)));
    },
    []
  );

  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center min-h-[320px] px-4 sm:px-6 lg:px-8 py-8">
        <Loader2 className="h-10 w-10 animate-spin text-oe-primary" aria-hidden />
        <p className="mt-3 text-sm text-gray-600">Loading training…</p>
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
            Training on the plans, available as a reference resource.
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-600 text-sm">
          No training is available yet.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="bg-white px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
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
            Work through the plan training at your own pace. This is a reference resource — there is
            no due date and nothing is required.
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 min-w-0 w-full">
        <TrainingPlayer2Panel
          key={packages.map(p => p.id).join('|')}
          packages={packages}
          moduleLibrary={moduleLibrary}
          initialPackageId=""
          initialTabId="curriculum"
          onUpdateModule={onUpdateModule}
          certificateGallery={certificateGallery}
          agentProgress={EMPTY_PROGRESS}
        />
      </div>
    </div>
  );
}
