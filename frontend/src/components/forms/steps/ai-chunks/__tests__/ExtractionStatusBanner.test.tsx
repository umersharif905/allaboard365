import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ExtractionStatusBanner from '../ExtractionStatusBanner';

describe('ExtractionStatusBanner', () => {
  it('shows empty state when no documents', () => {
    render(<ExtractionStatusBanner documents={[]} onRegenerate={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText(/Upload a product document/)).toBeInTheDocument();
  });
  it('renders completed status with chunk count', () => {
    render(<ExtractionStatusBanner documents={[{
      ProductDocumentId: 'd1', DocumentUrl: 'x', DisplayName: 'plan.pdf', SortOrder: 0,
      ExtractionStatus: 'completed', ExtractionStartedAt: null, ExtractionCompletedAt: null,
      ExtractionError: null, ExtractionChunkCount: 12,
    }]} onRegenerate={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText(/12 chunks extracted/)).toBeInTheDocument();
  });
  it('shows Retry button for failed docs', () => {
    render(<ExtractionStatusBanner documents={[{
      ProductDocumentId: 'd1', DocumentUrl: 'x', DisplayName: 'bad.pdf', SortOrder: 0,
      ExtractionStatus: 'failed', ExtractionStartedAt: null, ExtractionCompletedAt: null,
      ExtractionError: 'parse error', ExtractionChunkCount: null,
    }]} onRegenerate={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText(/Retry/)).toBeInTheDocument();
  });
});
