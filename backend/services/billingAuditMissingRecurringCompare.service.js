'use strict';

/**
 * Compare current missing-recurring member keys to the previous persisted report snapshot.
 * @param {object|null} previousReport
 * @param {Array<{ memberId: string; memberName?: string | null }>} currentMemberKeys
 */
function computeMissingRecurringDelta(previousReport, currentMemberKeys) {
  const cur = Array.isArray(currentMemberKeys) ? currentMemberKeys : [];
  if (!previousReport) {
    return { comparable: false, reason: 'no_previous_report', currentMissingCount: cur.length };
  }

  let prevKeys = [];
  const snap = previousReport.detail?.missingRecurringSnapshot;
  if (Array.isArray(snap?.memberKeys)) {
    prevKeys = snap.memberKeys;
  } else if (Array.isArray(previousReport.summary?.missingRecurringSnapshot?.memberKeys)) {
    prevKeys = previousReport.summary.missingRecurringSnapshot.memberKeys;
  } else {
    const legacyIds = previousReport.summary?.auditRun?.results?.missing_recurring?.memberIds;
    if (Array.isArray(legacyIds)) {
      prevKeys = legacyIds.map((id) => ({ memberId: String(id), memberName: null }));
    }
  }

  if (prevKeys.length === 0) {
    return {
      comparable: false,
      reason: 'no_prior_snapshot',
      currentMissingCount: cur.length
    };
  }

  const curSet = new Set(cur.map((k) => k.memberId));
  const resolved = prevKeys.filter((k) => !curSet.has(k.memberId));
  const prevSet = new Set(prevKeys.map((k) => k.memberId));
  const newlyMissing = cur.filter((k) => !prevSet.has(k.memberId));

  return {
    comparable: true,
    previousRunAtUtc: previousReport.runAtUtc,
    previousMissingCount: prevKeys.length,
    currentMissingCount: cur.length,
    resolvedCount: resolved.length,
    resolved: resolved.slice(0, 100).map((k) => ({
      memberId: k.memberId,
      memberName: k.memberName != null && String(k.memberName).trim() ? String(k.memberName).trim() : null
    })),
    resolvedTruncated: resolved.length > 100,
    newlyMissingCount: newlyMissing.length
  };
}

module.exports = { computeMissingRecurringDelta };
