import { describe, expect, it } from 'vitest';
import { normalizeProductDocument } from '../useProductDocuments';

describe('normalizeProductDocument', () => {
  it('maps camelCase API fields to wizard extraction shape', () => {
    const doc = normalizeProductDocument({
      productDocumentId: 'abc-123',
      documentUrl: 'https://example.com/plan.pdf',
      displayName: 'Plan.pdf',
      sortOrder: 1,
      extractionStatus: 'completed',
      extractionChunkCount: 8,
    });

    expect(doc.ProductDocumentId).toBe('abc-123');
    expect(doc.DocumentUrl).toBe('https://example.com/plan.pdf');
    expect(doc.DisplayName).toBe('Plan.pdf');
    expect(doc.ExtractionStatus).toBe('completed');
    expect(doc.ExtractionChunkCount).toBe(8);
  });
});
