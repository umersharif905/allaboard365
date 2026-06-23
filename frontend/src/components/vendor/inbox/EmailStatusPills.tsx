// Derived status pills for an email thread (Needs reply / Awaiting customer /
// Linked / Unread). All computed from the thread row — no manual state.
import { Link2, AlertTriangle } from 'lucide-react';
import { deriveThreadPills, type EmailThread } from '../../../types/email.types';

const STYLES: Record<string, string> = {
  'needs-reply': 'bg-amber-100 text-amber-800',
  'awaiting-customer': 'bg-gray-100 text-gray-600',
  linked: 'bg-oe-light text-oe-dark',
  unread: 'bg-oe-primary/10 text-oe-primary',
  bounced: 'bg-red-100 text-red-700',
};

interface Props {
  thread: Pick<EmailThread,
    'NeedsReply' | 'LastDirection' | 'UnreadCount' | 'CaseId' | 'ShareRequestId' | 'LinkedShareRequestNumber' | 'LinkedCaseNumber'
    | 'Subject' | 'CounterpartyName' | 'CounterpartyAddress'>;
  size?: 'sm' | 'md';
}

const EmailStatusPills = ({ thread, size = 'sm' }: Props) => {
  const pills = deriveThreadPills(thread);
  if (!pills.length) return null;
  const pad = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-1';
  return (
    <div className="flex flex-wrap gap-1.5">
      {pills.map((p) => (
        <span
          key={p.kind}
          className={`inline-flex items-center gap-1 rounded-full font-medium ${pad} ${STYLES[p.kind]}`}
        >
          {p.kind === 'linked' && <Link2 className="h-3 w-3" />}
          {p.kind === 'bounced' && <AlertTriangle className="h-3 w-3" />}
          {p.label}
        </span>
      ))}
    </div>
  );
};

export default EmailStatusPills;
