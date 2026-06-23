import { BookOpen, Edit, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiService } from '../../services/api.service';
import AgentTrainingStatusPanel, { type TrainingStatusPayload } from './AgentTrainingStatusPanel';

const AgentTrainingSettingsWidget: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<TrainingStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await apiService.get('/api/me/agent/training/library-status')) as {
        success?: boolean;
        data?: TrainingStatusPayload;
        message?: string;
      };
      if (!res?.success || !res.data) {
        setData(null);
        if (res && res.success === false && res.message) {
          setError(res.message);
        }
        return;
      }
      setData(res.data);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : 'Failed to load training status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const hasContent =
    data &&
    ((data.libraryPackages && data.libraryPackages.length > 0) ||
      (data.productTraining && data.productTraining.length > 0));

  if (!loading && data?.agentPortalTrainingEnabled === false) {
    return null;
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center min-w-0">
          <BookOpen className="h-5 w-5 text-oe-primary mr-2 shrink-0" />
          <h3 className="text-lg font-medium text-oe-neutral-dark truncate">Training status</h3>
        </div>
        <Link
          to="/agent/training"
          className="inline-flex items-center px-3 py-1 rounded-md text-sm font-medium bg-oe-primary text-white hover:bg-oe-dark transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2 shrink-0 ml-3"
        >
          <Edit className="h-4 w-4 mr-1" aria-hidden />
          Launch training
        </Link>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-8 justify-center text-gray-600">
          <Loader2 className="h-6 w-6 animate-spin text-oe-primary" aria-hidden />
          <span className="text-sm">Loading training information…</span>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-md bg-red-50 border border-red-100 px-3 py-2 text-sm text-red-800">
          {error}
          <button
            type="button"
            onClick={() => void loadStatus()}
            className="ml-2 text-oe-primary underline font-medium"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && !hasContent && (
        <p className="text-sm text-gray-600 py-2">
          No assigned training packages or product certifications are available for your account yet. When your
          organization assigns training, it will appear here.
        </p>
      )}

      {!loading && !error && hasContent && data && (
        <AgentTrainingStatusPanel data={data} showProductTrainingLinkLine={false} />
      )}
    </div>
  );
};

export default AgentTrainingSettingsWidget;
