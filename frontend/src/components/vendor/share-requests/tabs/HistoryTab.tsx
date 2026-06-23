// frontend/src/components/vendor/share-requests/tabs/HistoryTab.tsx
// Backs the Share Request History tab. Thin wrapper around the shared
// HistoryTimeline component (components/vendor/shared/HistoryTimeline.tsx),
// which renders the unified, read-only timeline used by both Cases and Share
// Requests. The previous status-only implementation was replaced by the
// shared aggregator-backed timeline.

import HistoryTimeline from '../../shared/HistoryTimeline';

interface HistoryTabProps {
  shareRequestId: string;
  /** Bumps on any claim/status mutation to trigger a refetch. */
  claimVersion?: number;
}

const HistoryTab = ({ shareRequestId, claimVersion = 0 }: HistoryTabProps) => (
  <HistoryTimeline
    entityType="share-request"
    entityId={shareRequestId}
    refreshKey={claimVersion}
  />
);

export default HistoryTab;
