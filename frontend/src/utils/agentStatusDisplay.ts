/** Human-readable labels for agent/agency lifecycle status in admin UI. */
export function formatAgentLifecycleStatusLabel(status: string | undefined | null): string {
  if (status == null || status === '') return '';
  if (status === 'Pending') return 'Pending password setup';
  return status;
}
