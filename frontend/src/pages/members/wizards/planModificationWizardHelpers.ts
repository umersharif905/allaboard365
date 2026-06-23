/** Group / list-bill members: employer or group billing — no individual DIME recurring in this wizard. */
export function shouldSkipDimeRecurringForMember(
  member: { GroupId?: string | null; BillType?: string | null },
  dryRunIsGroupBilled?: boolean
): boolean {
  if (typeof dryRunIsGroupBilled === 'boolean') return dryRunIsGroupBilled;
  const bt = String(member.BillType ?? '').toUpperCase();
  return !!member.GroupId || bt === 'LB';
}

export function isPrimaryEnrollmentPreviewRow(row: {
  isDependentRow?: boolean;
  rel?: string;
  enrollmentType?: string;
}): boolean {
  const t = row.enrollmentType || '';
  if (t === 'PaymentProcessingFee' || t === 'SystemFee' || t === 'Contribution') return true;
  if (row.isDependentRow) return false;
  if (row.rel === 'S' || row.rel === 'C') return false;
  return true;
}

export function hasDimeApplyWarning(
  applyResult: { dimeUpdate?: { success?: boolean; details?: { cancelFailures?: unknown[] } } } | null,
  skipDime: boolean
): boolean {
  if (skipDime || !applyResult) return false;
  const du = applyResult.dimeUpdate;
  return (
    du?.success === false || ((du?.details?.cancelFailures?.length ?? 0) > 0)
  );
}
