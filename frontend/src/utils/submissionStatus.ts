/**
 * Shared resolution-status logic for public-form submissions — used by both
 * the submissions list and the submission detail page so the same row reads
 * the same way wherever it appears.
 */

export type ResolutionTone = 'green' | 'amber' | 'gray';

export type ResolutionStatus = {
  /** Full label, e.g. "Resolved · linked", "Resolved · not linked", "Unresolved". */
  label: string;
  /** One-word label for compact placements (header pills, etc.). */
  shortLabel: 'Resolved' | 'Needs attention';
  /** Color tone for chips / accents. */
  tone: ResolutionTone;
  /** True when the submission is matched to a member (any flavour). */
  isResolved: boolean;
  /**
   * True when the submission warrants triage — typically a member ID that
   * didn't match a customer in the DB. Drives the "surface it" rule on both
   * the list (row accent) and the detail (Needs-attention block).
   */
  needsAttention: boolean;
};

type StatusInput = {
  MemberId?: string | null;
  ShareRequestId?: string | null;
  CaseId?: string | null;
};

export function resolutionStatus(s: StatusInput): ResolutionStatus {
  if (!s.MemberId) {
    return {
      label: 'Unresolved',
      shortLabel: 'Needs attention',
      tone: 'amber',
      isResolved: false,
      needsAttention: true
    };
  }
  if (s.ShareRequestId || s.CaseId) {
    return {
      label: 'Resolved · linked',
      shortLabel: 'Resolved',
      tone: 'green',
      isResolved: true,
      needsAttention: false
    };
  }
  return {
    label: 'Resolved · not linked',
    shortLabel: 'Resolved',
    tone: 'gray',
    isResolved: true,
    needsAttention: false
  };
}

/** True when the recipient typed a member ID on the form. */
export function hasSubmittedMemberId(s: { SubmittedMemberIdText?: string | null }): boolean {
  return !!s.SubmittedMemberIdText && s.SubmittedMemberIdText.trim() !== '';
}
