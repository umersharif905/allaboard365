// PlanMembersCard — lists everyone on the same plan/household as the share
// request's member, so the care team can see the whole family at a glance
// (a request is sometimes filed for one person but about another). Clicking a
// member opens a modal with the contact/demographic detail we hold.
//
// Renders as one more card in the RequestDetailsTab system-data grid, matching
// the local <Card> look. Reuses the existing vendor household endpoint — every
// field shown comes back in that single call, so the modal needs no extra fetch:
//   GET /api/me/vendor/members/:memberId/household
import { useEffect, useMemo, useState } from 'react';
import { Users, X } from 'lucide-react';
import { apiService } from '../../../../services/api.service';

interface PlanMember {
  MemberId: string;
  HouseholdMemberID?: string;
  FirstName: string;
  LastName: string;
  Phone?: string;
  Gender?: string;
  /** 'yyyy-MM-dd' from the API */
  DateOfBirth?: string;
  RelationshipType?: 'P' | 'S' | 'C' | string;
  Relationship?: string;
}

interface PlanMembersCardProps {
  /** The member the share request is filed under — used to load the household. */
  memberId: string;
  /** Patient name captured on the request (RequestName: "First Last"). Used to
   *  pinpoint which household member the request is actually for — for anonymous
   *  submissions the filed-under member is the primary, not the patient. */
  patientName?: string | null;
  /** Patient's relation to the primary member (self/spouse/child), when captured. */
  patientRelation?: string | null;
}

const norm = (s?: string | null) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const RELATIONSHIP_BADGE: Record<string, string> = {
  P: 'bg-blue-100 text-blue-800',
  S: 'bg-purple-100 text-purple-800',
  C: 'bg-gray-100 text-gray-700',
};

const fmtDob = (raw?: string) => {
  if (!raw) return '—';
  const [datePart] = raw.split('T');
  const [y, m, d] = (datePart ?? '').split('-');
  if (!y || !m || !d) return raw;
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
};

const fullName = (m: PlanMember) => `${m.FirstName ?? ''} ${m.LastName ?? ''}`.trim() || '—';

const PlanMembersCard = ({ memberId, patientName, patientRelation }: PlanMembersCardProps) => {
  const [members, setMembers] = useState<PlanMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PlanMember | null>(null);

  // Only treat the request as "for" a specific person when the captured patient
  // name actually matches a household member. RequestName is a free-text title on
  // many legacy/manual requests (e.g. "ER Visit"), so unmatched names show nothing
  // — this also stays compatible with the future where RequestName is the patient.
  const matchedPatient = useMemo(() => {
    const target = norm(patientName);
    if (!target) return null;
    return members.find((m) => norm(fullName(m)) === target) ?? null;
  }, [members, patientName]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiService.get<{ success: boolean; data: PlanMember[] }>(
          `/api/me/vendor/members/${memberId}/household`,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        if (res.success) {
          setMembers(res.data ?? []);
        } else {
          setError('Unable to load plan members');
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Unable to load plan members');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [memberId]);

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <header className="bg-gray-50 px-3 py-2 border-b border-gray-200 flex items-center gap-1.5">
        <Users className="h-3.5 w-3.5 text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-900">Plan members</h3>
      </header>
      <div className="p-3 space-y-1.5">
        {matchedPatient ? (
          <div className="mb-1 rounded-md bg-oe-light/40 px-2 py-1.5 text-xs text-gray-600">
            This request is for{' '}
            <span className="font-medium text-gray-900">{fullName(matchedPatient)}</span>
            {patientRelation ? <span className="text-gray-500"> · {patientRelation}</span> : null}
          </div>
        ) : null}
        {loading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-gray-400">No plan members found.</p>
        ) : (
          members.map((m) => {
            const isPatient = !!matchedPatient && m.MemberId === matchedPatient.MemberId;
            // No confident patient match → subtly mark the member the request is
            // filed under, for orientation, without claiming it's the patient.
            const isFiledUnder = !matchedPatient && m.MemberId === memberId;
            const badge = RELATIONSHIP_BADGE[m.RelationshipType ?? ''] ?? 'bg-gray-100 text-gray-700';
            return (
              <button
                key={m.MemberId}
                type="button"
                onClick={() => setSelected(m)}
                className={`w-full text-left flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-gray-50 transition-colors ${
                  isPatient
                    ? 'ring-1 ring-oe-primary bg-oe-light/50'
                    : isFiledUnder
                      ? 'ring-1 ring-oe-primary/30 bg-oe-light/30'
                      : ''
                }`}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm text-gray-900 truncate">{fullName(m)}</span>
                    {isPatient ? (
                      <span className="shrink-0 inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-oe-primary text-white">
                        This request
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-xs text-gray-500">DOB {fmtDob(m.DateOfBirth)}</span>
                </span>
                <span
                  className={`shrink-0 inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${badge}`}
                >
                  {m.Relationship ?? '—'}
                </span>
              </button>
            );
          })
        )}
      </div>

      {selected && <PlanMemberModal member={selected} onClose={() => setSelected(null)} />}
    </div>
  );
};

const PlanMemberModal = ({ member, onClose }: { member: PlanMember; onClose: () => void }) => {
  const badge = RELATIONSHIP_BADGE[member.RelationshipType ?? ''] ?? 'bg-gray-100 text-gray-700';
  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-start justify-between gap-2 px-5 py-4 border-b border-gray-200">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900 truncate">{fullName(member)}</h3>
            <span className={`mt-1 inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${badge}`}>
              {member.Relationship ?? '—'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md p-1"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="px-5 py-4 space-y-2.5">
          <DetailRow label="Date of birth" value={fmtDob(member.DateOfBirth)} />
          <DetailRow label="Gender" value={member.Gender} />
          <DetailRow label="Phone" value={member.Phone} />
          <DetailRow label="Member #" value={member.HouseholdMemberID} />
        </div>
      </div>
    </div>
  );
};

const DetailRow = ({ label, value }: { label: string; value?: string | null }) => (
  <div className="text-sm flex items-start gap-2">
    <span className="text-gray-500 w-28 shrink-0">{label}</span>
    <span className="text-gray-900 break-words">{value && value.toString().trim() ? value : '—'}</span>
  </div>
);

export default PlanMembersCard;
