import { Group } from '../services/groups.service';

function csvEscape(cell: string | number | null | undefined): string {
  const t = String(cell ?? '');
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

/** YYYY-MM-DD from EarliestFutureEffectiveDate, else EarliestActiveEffectiveDate. */
export function formatGroupEffectiveDate(group: Group): string {
  const raw = group.EarliestFutureEffectiveDate || group.EarliestActiveEffectiveDate;
  if (!raw) return '';
  const datePart = raw.split('T')[0];
  return datePart && datePart.length >= 10 ? datePart : '';
}

export function buildGroupsExportCsv(groups: Group[]): string {
  const header = ['Group name', 'Number of households', 'State', 'Effective date'];
  const rows = groups.map((g) => [
    g.Name ?? '',
    g.ActiveEnrollments ?? 0,
    g.State ?? '',
    formatGroupEffectiveDate(g),
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

export function downloadGroupsCsv(groups: Group[], filename?: string): void {
  const csv = buildGroupsExportCsv(groups);
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const today = new Date().toISOString().split('T')[0];
  a.download = filename ?? `groups-export-${today}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
