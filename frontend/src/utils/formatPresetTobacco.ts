import { parseEligibilityTemplateColumns } from './eligibilityRowTemplate';

/** CSV header labels from a format row template (for tobacco column picker). */
export function csvHeadersFromTemplate(template: string): string[] {
  const cols = parseEligibilityTemplateColumns(template.trim());
  const labels = cols.map((c) => c.headerLabel.trim()).filter(Boolean);
  return [...new Set(labels)];
}

export function defaultTobaccoColumnFromTemplate(template: string): string {
  const headers = csvHeadersFromTemplate(template);
  const hit = headers.find((h) => /tobacco|nicotine|surcharge/i.test(h));
  return hit || headers[headers.length - 2] || 'Tobacco Surcharge';
}

export function formatTobaccoYesValuesForInput(values: string[] | undefined): string {
  return (values || []).join(', ');
}

export function parseTobaccoYesValuesInput(raw: string): string[] {
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
}
