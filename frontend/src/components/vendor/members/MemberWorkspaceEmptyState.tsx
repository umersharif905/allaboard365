import { ArrowLeft, Users } from 'lucide-react';

const MemberWorkspaceEmptyState = () => (
  <div className="flex flex-col items-center justify-center text-center h-full py-16 px-6 animate-fade-in">
    <div className="relative mb-5">
      <div className="absolute inset-0 rounded-full bg-oe-light blur-2xl opacity-70" />
      <div className="relative h-20 w-20 rounded-full bg-gradient-to-br from-oe-light to-white border border-oe-light flex items-center justify-center shadow-soft">
        <Users className="h-9 w-9 text-oe-primary" />
      </div>
    </div>
    <h2 className="text-lg font-semibold text-gray-900 mb-1.5">Select a member</h2>
    <p className="text-sm text-gray-500 max-w-sm leading-relaxed">
      Pick a member from the list to view their details, household, plans, calls, emails, notes,
      documents, and share requests.
    </p>
    <p className="mt-6 text-xs text-gray-400 inline-flex items-center gap-1.5">
      <ArrowLeft className="h-3.5 w-3.5" />
      Use the rail on the left
    </p>
  </div>
);

export default MemberWorkspaceEmptyState;
