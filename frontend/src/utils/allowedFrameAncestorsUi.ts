/**
 * AllowedFrameAncestors: '*' or comma-separated origins (e.g. https://example.com).
 */

export type EmbedMode = 'any' | 'restrict';

export function embedModeFromStored(stored: string | null | undefined): { mode: EmbedMode; linesText: string } {
  const t = (stored ?? '*').trim();
  if (t === '' || t === '*') return { mode: 'any', linesText: '' };
  return { mode: 'restrict', linesText: splitToLines(t) };
}

function splitToStoredParts(s: string): string[] {
  return s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function splitToLines(stored: string): string {
  return splitToStoredParts(stored).join('\n');
}

/** Comma-separated list for API (no extra spaces). */
export function serializeEmbedSites(lines: string): string {
  return splitToStoredParts(lines).join(',');
}
