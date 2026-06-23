/** Turn raw assistant text into user-facing prose (no JSON blobs). */
export function formatAssistantMessageText(text: string): string {
  if (!text?.trim()) return '';

  let out = text.trim();

  // Entire message is JSON (model mistake)
  if (out.startsWith('{') || out.startsWith('[')) {
    try {
      const parsed = JSON.parse(out) as Record<string, unknown>;
      if (typeof parsed.text === 'string' && parsed.text.trim()) {
        return parsed.text.trim();
      }
      if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
        return parsed.summary.trim();
      }
      if (parsed.kind === 'proposal' && parsed.patch) {
        return 'I prepared a product update proposal — review the card below and click **Apply to wizard** when ready.';
      }
    } catch {
      // keep original
    }
  }

  // Strip fenced JSON/code blocks from markdown answers
  out = out.replace(/```(?:json)?\s*[\s\S]*?```/gi, '').trim();

  if (out.startsWith('PRODUCT_PROPOSAL_JSON:')) {
    try {
      const payload = JSON.parse(out.slice('PRODUCT_PROPOSAL_JSON:'.length));
      if (typeof payload.summary === 'string') return payload.summary;
    } catch {
      return 'I prepared a product update proposal — review the card below.';
    }
  }

  return out || text.trim();
}

export function formatFieldLabel(fieldPath: string): string {
  const labels: Record<string, string> = {
    pricingTiers: 'Pricing tiers',
    configurationFields: 'Configuration fields',
    acknowledgementQuestions: 'Acknowledgement questions',
    aiChunks: 'AI knowledge chunks',
    allowedStates: 'Allowed states',
    requiredLicenses: 'Required licenses',
    minAge: 'Minimum age',
    maxAge: 'Maximum age',
    productType: 'Product type',
    salesType: 'Sales type',
    description: 'Description',
    name: 'Product name',
  };
  if (labels[fieldPath]) return labels[fieldPath];
  if (fieldPath === 'includeProcessingFee') return 'Include processing fee in pricing';
  if (fieldPath === 'manualIncludedProcessingFee') return 'Manual included fee entry';
  if (fieldPath === 'roundUpProcessingFee') return 'Round up processing fee';
  if (fieldPath === 'processingFeePercentage') return 'Processing fee %';
  return fieldPath
    .replace(/([A-Z])/g, ' $1')
    .replace(/[._]/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

export function formatMoney(n: number): string {
  return `$${Number(n || 0).toFixed(2)}`;
}
