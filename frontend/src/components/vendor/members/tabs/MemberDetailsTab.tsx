import { useEffect, useState } from 'react';
import { User, UserRound } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import Skeleton from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';
import VendorMemberDirectDepositSection from '../../VendorMemberDirectDepositSection';

interface MemberDetail {
  MemberId: string;
  HouseholdId: string;
  HouseholdMemberID: string;
  RelationshipType: string;
  FirstName: string;
  LastName: string;
  Email: string;
  Phone?: string;
  Address?: string;
  Address2?: string;
  City?: string;
  State?: string;
  ZipCode?: string;
  DateOfBirth?: string;
  Gender?: string;
  MemberStatus?: 'Active' | 'Terminated' | 'PendingMigration' | 'Inactive';
  MemberRawStatus?: string | null;
  IsPendingMigration?: boolean;
  MigrationSourceSystem?: string | null;
  AgentFirstName?: string | null;
  AgentLastName?: string | null;
  AgentEmail?: string | null;
  AgentPhone?: string | null;
  AgentFromHouseholdPrimary?: boolean | number;
}

interface MemberDetailsTabProps {
  memberId: string;
}

const RELATIONSHIP_LABEL: Record<string, string> = {
  P: 'Primary',
  S: 'Spouse',
  C: 'Dependent',
};

const formatDob = (raw?: string) => {
  if (!raw) return '';
  const [datePart] = raw.split('T');
  if (!datePart) return raw;
  const [y, m, d] = datePart.split('-');
  if (!y || !m || !d) return raw;
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
};

const Field = ({
  label,
  value,
  labelWidth = 'w-28',
}: {
  label: string;
  value: string;
  labelWidth?: string;
}) => (
  <div className="flex items-center gap-3 min-w-0">
    <label className={`${labelWidth} text-sm text-gray-600 text-right shrink-0`}>{label}:</label>
    <input
      type="text"
      value={value || ''}
      readOnly
      className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-200 rounded-md bg-gray-50 text-gray-900 focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary cursor-default transition-shadow"
    />
  </div>
);

const MemberDetailsTab = ({ memberId }: MemberDetailsTabProps) => {
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await apiService.get<{
          success: boolean;
          data: MemberDetail;
        }>(`/api/me/vendor/members/${memberId}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.success) {
          setMember(response.data);
        } else {
          setError('Member not found');
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('Error loading member:', err);
        setError('Unable to load member details');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [memberId]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <Skeleton className="h-6 w-40" />
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <Skeleton className="h-9 w-full" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !member) {
    return <EmptyState icon={User} title={error ?? 'Member not found'} tone="error" />;
  }

  const relationshipLabel =
    RELATIONSHIP_LABEL[member.RelationshipType] ?? member.RelationshipType ?? '';

  const agentName = [member.AgentFirstName, member.AgentLastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  const hasAgent = !!(agentName || member.AgentEmail || member.AgentPhone);

  return (
    <div className="max-w-4xl mx-auto p-6 animate-fade-up">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Member Details</h2>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-soft">
        <div className="mb-5">
          <Field label="Member ID" value={member.HouseholdMemberID || ''} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <Field label="First Name" value={member.FirstName} />
          <Field label="Last Name" value={member.LastName} />
          <Field label="Email" value={member.Email} />
          <Field label="Phone" value={member.Phone ?? ''} />
          <Field label="DoB" value={formatDob(member.DateOfBirth)} />
          <Field label="Gender" value={member.Gender ?? ''} />
          <Field label="Relationship" value={relationshipLabel} />
        </div>

        <div className="mt-6 pt-6 border-t border-gray-100 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <Field label="Address" value={member.Address ?? ''} />
          <Field label="Address 2" value={member.Address2 ?? ''} />
          <Field label="City" value={member.City ?? ''} />
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex-1 min-w-0">
              <Field label="State" value={member.State ?? ''} labelWidth="w-12" />
            </div>
            <div className="flex-1 min-w-0">
              <Field label="Zip" value={member.ZipCode ?? ''} labelWidth="w-10" />
            </div>
          </div>
        </div>
      </div>

      {/* Member's assigned agent (read-only). Pulled from the member's
          AgentId → Agents → Users so the vendor can see who to contact. */}
      <div className="mt-6">
        <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-soft">
          <div className="flex items-center gap-2 mb-5">
            <UserRound className="h-4 w-4 text-oe-primary" />
            <h3 className="text-base font-semibold text-gray-900">Member's Agent</h3>
            {hasAgent && !!member.AgentFromHouseholdPrimary && (
              <span className="text-xs text-gray-500 font-normal">
                (from household primary)
              </span>
            )}
          </div>
          {hasAgent ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
              <Field label="Name" value={agentName} />
              <Field label="Email" value={member.AgentEmail ?? ''} />
              <Field label="Phone" value={member.AgentPhone ?? ''} />
            </div>
          ) : (
            <p className="text-sm text-gray-500">No agent assigned to this member.</p>
          )}
        </div>
      </div>

      {/* Member direct deposit (read-only). Shows how reimbursements for
          this member's household will be paid out. */}
      <div className="mt-6">
        <VendorMemberDirectDepositSection memberId={member.MemberId} />
      </div>
    </div>
  );
};

export default MemberDetailsTab;
