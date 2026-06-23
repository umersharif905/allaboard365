// Small reusable indicator for an encounter's follow-up state.
// - overdue: red
// - due soon (<= 24h): amber
// - open (later): blue
// - completed: grey check
// - none: nothing rendered

import { Bell, BellOff, Check } from 'lucide-react';
import { isFollowUpOpen, isFollowUpOverdue, type EncounterRow } from '../../../types/encounter.types';

interface Props {
  encounter: EncounterRow;
  size?: 'xs' | 'sm';
}

const fmt = (v: string) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  // e.g. "May 16, 3:45 PM" — short enough for the pill but keeps the time
  // since the user picks a datetime, not just a date.
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const EncounterFollowUpBadge = ({ encounter, size = 'xs' }: Props) => {
  if (!encounter.FollowUpDueDate && !encounter.FollowUpCompletedAt) return null;

  const sizeClasses = size === 'xs' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';
  const iconSize = size === 'xs' ? 'h-2.5 w-2.5' : 'h-3 w-3';

  if (encounter.FollowUpCompletedAt) {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full font-medium bg-gray-100 text-gray-600 ${sizeClasses}`}>
        <Check className={iconSize} />
        Done
      </span>
    );
  }

  if (!isFollowUpOpen(encounter)) return null;

  const overdue = isFollowUpOverdue(encounter);
  const due = encounter.FollowUpDueDate as string;
  const dueDate = new Date(due);
  const soon =
    !overdue &&
    !Number.isNaN(dueDate.getTime()) &&
    dueDate.getTime() - Date.now() <= 24 * 60 * 60 * 1000;

  const tone = overdue
    ? 'bg-red-100 text-red-800'
    : soon
      ? 'bg-amber-100 text-amber-800'
      : 'bg-sky-100 text-sky-800';

  const Icon = overdue ? Bell : soon ? Bell : BellOff;
  const label = overdue ? `Overdue · ${fmt(due)}` : `Due ${fmt(due)}`;

  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium ${tone} ${sizeClasses}`}>
      <Icon className={iconSize} />
      {label}
    </span>
  );
};

export default EncounterFollowUpBadge;
