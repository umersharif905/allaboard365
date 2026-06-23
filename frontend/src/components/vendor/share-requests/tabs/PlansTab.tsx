import { useEffect, useState } from 'react';
import { Package } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import CombinedPlansTab from '../../shared/CombinedPlansTab';
import Skeleton from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';

interface PlansTabProps {
  shareRequestId: string;
}

// Share-request Plans tab is a thin wrapper that resolves the share request's
// primary member, then defers to CombinedPlansTab (same component used in the
// vendor member workspace) so plans and ID cards render identically in both
// contexts.
const PlansTab = ({ shareRequestId }: PlansTabProps) => {
  const [memberId, setMemberId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await apiService.get<{ success: boolean; data: { MemberId?: string } }>(
          `/api/me/vendor/share-requests/${shareRequestId}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const id = resp?.data?.MemberId;
        if (!id) {
          setError('Share request has no associated member.');
          return;
        }
        setMemberId(id);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('Error loading share request for plans:', err);
        setError('Unable to load share request');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [shareRequestId]);

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-6 w-40" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-40 w-full" rounded="lg" />
          <Skeleton className="h-40 w-full" rounded="lg" />
        </div>
      </div>
    );
  }

  if (error || !memberId) {
    return <EmptyState icon={Package} title={error ?? 'No member found'} tone="error" />;
  }

  return <CombinedPlansTab memberId={memberId} />;
};

export default PlansTab;
