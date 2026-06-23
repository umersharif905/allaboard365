import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AIKnowledgeSection from '../AIKnowledgeSection';

vi.mock('../../../services/aiTenantKnowledge.service', () => ({
  aiTenantKnowledgeService: {
    listChunks: vi.fn().mockResolvedValue({
      success: true,
      chunks: [
        {
          AIChunkId: 'c1', ProductId: 'p1', ProductName: 'Lyric Direct Primary Care', ProductIsBundle: false,
          ChunkType: 'faq', Source: 'ai',
          Question: 'Does Lyric cover specialists?', Title: null,
          ChunkText: 'Lyric covers primary care only.',
          SourceDocumentId: 'd1',
          CreatedDate: '2026-04-12', ModifiedDate: '2026-04-12',
          AvgRating: 4.5, RatingCount: 8,
        },
      ],
      page: 1, pageSize: 50, totalCount: 1,
    }),
    getStats: vi.fn().mockResolvedValue({
      success: true,
      stats: {
        totalChunks: 1, byType: { prose: 0, faq: 1 }, bySource: { ai: 1, manual: 0 },
        productsWithChunks: 1, ratedChunks: 1, overallAvgRating: 4.5,
      },
    }),
    listProducts: vi.fn().mockResolvedValue({
      success: true,
      products: [{ productId: 'p1', name: 'Lyric Direct Primary Care', isBundle: false, chunkCount: 1, avgRating: 4.5 }],
    }),
  },
}));

vi.mock('../../../services/productChunks.service', () => ({
  updateProductChunk: vi.fn().mockResolvedValue({ success: true }),
  deleteProductChunk: vi.fn().mockResolvedValue({ success: true }),
}));

const renderSection = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AIKnowledgeSection />
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

describe('AIKnowledgeSection', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders stats header and chunk row', async () => {
    renderSection();
    expect(await screen.findByText(/Does Lyric cover specialists\?/i)).toBeInTheDocument();
    expect(screen.getAllByText(/4\.50/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Total chunks/i)).toBeInTheDocument();
  });

  it('debounces search input and refetches with the search param', async () => {
    const { aiTenantKnowledgeService } = await import('../../../services/aiTenantKnowledge.service');
    renderSection();
    await screen.findByText(/Does Lyric cover specialists\?/i);
    const searchBox = screen.getByPlaceholderText(/Search chunks/i);
    fireEvent.change(searchBox, { target: { value: 'lyric' } });
    await waitFor(() => {
      const listChunks = aiTenantKnowledgeService.listChunks as unknown as ReturnType<typeof vi.fn>;
      const calls = listChunks.mock.calls;
      expect(calls.some(([args]) => args.search === 'lyric')).toBe(true);
    }, { timeout: 1000 });
  });
});
