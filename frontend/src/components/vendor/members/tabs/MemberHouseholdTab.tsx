import { useEffect, useState } from 'react';
import { Home } from 'lucide-react';
import { apiService } from '../../../../services/api.service';
import { SkeletonRows } from '../../ui/Skeleton';
import EmptyState from '../../ui/EmptyState';

interface HouseholdMember {
  MemberId: string;
  HouseholdMemberID?: string;
  FirstName: string;
  LastName: string;
  Email?: string;
  Phone?: string;
  DateOfBirth?: string;
  RelationshipType?: string;
  Relationship?: string;
}

interface MemberHouseholdTabProps {
  memberId: string;
}

const formatDob = (raw?: string) => {
  if (!raw) return '';
  const [datePart] = raw.split('T');
  if (!datePart) return raw;
  const [y, m, d] = datePart.split('-');
  if (!y || !m || !d) return raw;
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
};

const RELATIONSHIP_BADGE: Record<string, string> = {
  P: 'bg-blue-100 text-blue-800',
  S: 'bg-purple-100 text-purple-800',
  C: 'bg-gray-100 text-gray-700',
};

const MemberHouseholdTab = ({ memberId }: MemberHouseholdTabProps) => {
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await apiService.get<{ success: boolean; data: HouseholdMember[] }>(
          `/api/me/vendor/members/${memberId}/household`,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        if (response.success) {
          setMembers(response.data ?? []);
        } else {
          setError('Unable to load household');
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('Error loading household:', err);
        setError('Unable to load household');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [memberId]);

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonRows count={5} rowClassName="h-12" />
      </div>
    );
  }

  if (error) {
    return <EmptyState icon={Home} title={error} tone="error" />;
  }

  if (members.length === 0) {
    return (
      <EmptyState
        icon={Home}
        title="No household members"
        description="There are no other members linked to this household."
      />
    );
  }

  return (
    <div className="p-6 animate-fade-up">
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-soft">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                First Name
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                Last Name
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                Relationship
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                DoB
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {members.map((m) => {
              const isCurrent = m.MemberId === memberId;
              return (
                <tr
                  key={m.MemberId}
                  className={`text-sm transition-colors ${
                    isCurrent ? 'bg-oe-light/40' : 'hover:bg-gray-50'
                  }`}
                >
                  <td className="px-4 py-2.5 text-gray-900 font-medium">
                    {m.FirstName}
                    {isCurrent && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide font-semibold text-oe-primary">
                        current
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-gray-900">{m.LastName}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${
                        RELATIONSHIP_BADGE[m.RelationshipType ?? ''] ?? 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {m.Relationship || m.RelationshipType || 'Member'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-700">{formatDob(m.DateOfBirth)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400 mt-3">Rows: {members.length}</p>
    </div>
  );
};

export default MemberHouseholdTab;
