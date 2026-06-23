import { Users } from 'lucide-react';

export type HouseholdMemberOption = {
  MemberId: string;
  FirstName?: string | null;
  LastName?: string | null;
  RelationshipDescription?: string | null;
  IsCurrentUser?: number | boolean;
};

/**
 * "Who is this form for?" selector shown above the form when a Member is signed
 * in and their household has more than one person. Picking a person drives the
 * About-You autofill for that member (self, spouse, or a child).
 */
export function WhoIsThisForSelect({
  members,
  selectedMemberId,
  onChange
}: {
  members: HouseholdMemberOption[];
  selectedMemberId: string | null;
  onChange: (memberId: string) => void;
}) {
  if (members.length <= 1) return null;

  const labelFor = (m: HouseholdMemberOption) => {
    const name = `${m.FirstName || ''} ${m.LastName || ''}`.trim() || 'Member';
    const rel = m.RelationshipDescription ? ` (${m.RelationshipDescription})` : '';
    return `${name}${rel}`;
  };

  return (
    <div className="mb-4 rounded-lg border border-oe-light bg-oe-light/30 p-4">
      <label className="block">
        <span className="flex items-center gap-2 text-sm font-medium text-oe-dark">
          <Users className="h-4 w-4" />
          Who is this form for?
        </span>
        <select
          className="mt-2 w-full sm:w-80 border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
          value={selectedMemberId ?? ''}
          onChange={(e) => onChange(e.target.value)}
        >
          {members.map((m) => (
            <option key={m.MemberId} value={m.MemberId}>
              {labelFor(m)}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-gray-600">
          We'll fill in this person's details from their account. Switching resets the form.
        </span>
      </label>
    </div>
  );
}
