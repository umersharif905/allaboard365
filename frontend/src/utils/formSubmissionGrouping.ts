/**
 * Submission grouping + date+time formatting for the forms-redesign
 * followup Slice A.2.
 *
 * Same-invitation submissions are visually stacked so the care team can
 * tell at a glance which one is newest. Grouping is UI-only; the data
 * model is unchanged.
 */

export type SubmissionLike = {
  SubmissionId: string;
  InvitationId: string | null;
  CreatedDate: string | null;
};

export type SubmissionGroup<T extends SubmissionLike> = {
  /** Stable React key. `i:<invitationId>` for stacks, `s:<submissionId>` for singletons. */
  key: string;
  invitationId: string | null;
  /** Sorted newest-first. Index 0 is the "Latest". */
  submissions: T[];
};

const dateMs = (s: string | null | undefined): number => {
  if (!s) return 0;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
};

const byDateDesc = <T extends SubmissionLike>(a: T, b: T): number =>
  dateMs(b.CreatedDate) - dateMs(a.CreatedDate);

/**
 * Groups submissions by InvitationId. Submissions without an
 * InvitationId become singleton groups. Output is sorted newest-first
 * by each group's latest submission.
 */
export function groupSubmissionsByInvitation<T extends SubmissionLike>(
  submissions: T[]
): SubmissionGroup<T>[] {
  const groupsByInv = new Map<string, T[]>();
  const standalones: T[] = [];
  for (const s of submissions) {
    if (s.InvitationId) {
      const arr = groupsByInv.get(s.InvitationId);
      if (arr) arr.push(s);
      else groupsByInv.set(s.InvitationId, [s]);
    } else {
      standalones.push(s);
    }
  }

  const out: SubmissionGroup<T>[] = [];
  for (const [invitationId, subs] of groupsByInv) {
    out.push({
      key: `i:${invitationId}`,
      invitationId,
      submissions: [...subs].sort(byDateDesc),
    });
  }
  for (const s of standalones) {
    out.push({
      key: `s:${s.SubmissionId}`,
      invitationId: null,
      submissions: [s],
    });
  }
  out.sort(
    (a, b) => dateMs(b.submissions[0].CreatedDate) - dateMs(a.submissions[0].CreatedDate)
  );
  return out;
}

/**
 * "Mar 15, 2026, 2:14 PM" — date + time in the viewer's local zone.
 */
export const formatSubmissionDateTime = (raw: string | null | undefined): string => {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};
