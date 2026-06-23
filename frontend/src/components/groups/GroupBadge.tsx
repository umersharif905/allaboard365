import React from 'react';

export type GroupType = 'Standard' | 'ListBill';

export function GroupBadge({
  type,
  size = 'sm'
}: {
  type: GroupType;
  /** 'sm' = inline next to name, 'md' = standalone line below the name */
  size?: 'sm' | 'md';
}) {
  if (type === 'Standard') return null;
  const sizeClasses =
    size === 'md'
      ? 'px-3 py-1 text-sm'
      : 'px-2.5 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center rounded-full bg-green-100 text-green-800 border border-green-300 font-semibold uppercase tracking-wide ${sizeClasses}`}
      title="This is a List-Bill group: members enroll in individual products on one shared bill."
    >
      List Bill
    </span>
  );
}

export function PendingMigrationBadge({
  size = 'sm',
  pendingMemberCount = 0,
  isE123Migrated = false
}: {
  size?: 'sm' | 'md';
  pendingMemberCount?: number;
  isE123Migrated?: boolean;
}) {
  const sizeClasses =
    size === 'md'
      ? 'px-3 py-1 text-sm'
      : 'px-2.5 py-0.5 text-xs';
  const detail = isE123Migrated && pendingMemberCount > 0
    ? `E123 group with ${pendingMemberCount} member${pendingMemberCount === 1 ? '' : 's'} still pending migration.`
    : isE123Migrated
      ? 'Created from E123 migration — member assignment may still be in progress.'
      : `${pendingMemberCount} member${pendingMemberCount === 1 ? '' : 's'} still pending migration.`;
  return (
    <span
      className={`inline-flex items-center rounded-full bg-amber-100 text-amber-900 border border-amber-300 font-semibold ${sizeClasses}`}
      title={detail}
    >
      Pending migration
    </span>
  );
}
