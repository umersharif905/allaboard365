import { useState, useMemo, useEffect } from 'react';
import { Search, Sparkles, MessageSquareText, Bot, Star, Brain, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  useTenantKnowledgeChunks,
  useTenantKnowledgeStats,
  useTenantKnowledgeProducts,
  useUpdateTenantChunk,
  useDeleteTenantChunk,
} from '../../hooks/useAiTenantKnowledge';
import type {
  ChunkSource, ChunkType, SortBy, SortDir, TenantKnowledgeChunk,
} from '../../services/aiTenantKnowledge.service';
import AIKnowledgeChunkRow from './AIKnowledgeChunkRow';
import AIKnowledgeEditModal from './AIKnowledgeEditModal';

const PAGE_SIZE = 25;

const useDebounced = <T,>(value: T, ms: number): T => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
};

interface StatCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
}

const StatCard = ({ icon: Icon, label, value, sub }: StatCardProps) => (
  <div className="bg-white border border-gray-200 rounded-lg p-4">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
        <p className="text-2xl font-semibold text-gray-900 mt-1">{value}</p>
        {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
      </div>
      <Icon className="w-8 h-8 text-oe-primary opacity-60" />
    </div>
  </div>
);

export default function AIKnowledgeSection() {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput, 350);
  const [productId, setProductId] = useState<string | null>(null);
  const [chunkType, setChunkType] = useState<ChunkType | null>(null);
  const [source, setSource] = useState<ChunkSource | null>(null);
  const [hasRating, setHasRating] = useState(false);
  const [minRating, setMinRating] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('modifiedDate');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<TenantKnowledgeChunk | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TenantKnowledgeChunk | null>(null);

  useEffect(() => { setPage(1); }, [search, productId, chunkType, source, hasRating, minRating, sortBy, sortDir]);

  const filters = useMemo(() => ({
    search, productId, chunkType, source, hasRating, minRating, sortBy, sortDir, page, pageSize: PAGE_SIZE,
  }), [search, productId, chunkType, source, hasRating, minRating, sortBy, sortDir, page]);

  const chunksQuery = useTenantKnowledgeChunks(filters);
  const statsQuery = useTenantKnowledgeStats();
  const productsQuery = useTenantKnowledgeProducts();
  const updateMutation = useUpdateTenantChunk();
  const deleteMutation = useDeleteTenantChunk();

  const stats = statsQuery.data?.stats;
  const products = productsQuery.data?.products ?? [];
  const chunks = chunksQuery.data?.chunks ?? [];
  const totalCount = chunksQuery.data?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const handleSave = async (payload: { chunkText: string; question?: string; title?: string }) => {
    if (!editing || !editing.ProductId) return;
    await updateMutation.mutateAsync({ productId: editing.ProductId, chunkId: editing.AIChunkId, payload });
    setEditing(null);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete || !confirmDelete.ProductId) return;
    await deleteMutation.mutateAsync({ productId: confirmDelete.ProductId, chunkId: confirmDelete.AIChunkId });
    setConfirmDelete(null);
  };

  const resetFilters = () => {
    setSearchInput(''); setProductId(null); setChunkType(null);
    setSource(null); setHasRating(false); setMinRating(null);
    setSortBy('modifiedDate'); setSortDir('desc');
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Brain className="w-5 h-5 text-oe-primary" />
          <h3 className="text-lg font-medium text-gray-900">AI Knowledge</h3>
        </div>
        <p className="text-sm text-gray-600">
          Search, review and edit every chunk Columbus uses to answer your members.
          Edits here flow back to the source product instantly — AI-generated chunks
          become manual when edited so they survive future document regenerations.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Sparkles}         label="Total chunks" value={stats?.totalChunks ?? '—'} />
        <StatCard icon={Bot}               label="AI generated" value={stats?.bySource.ai ?? '—'}
                  sub={stats ? `${stats.bySource.manual} manual` : undefined} />
        <StatCard icon={MessageSquareText} label="FAQ chunks"   value={stats?.byType.faq ?? '—'}
                  sub={stats ? `${stats.byType.prose} prose` : undefined} />
        <StatCard icon={Star}              label="Avg rating"   value={stats?.overallAvgRating?.toFixed(2) ?? '—'}
                  sub={stats ? `${stats.ratedChunks} rated chunks` : undefined} />
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search chunks, questions, or titles…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="flex-1 border-none focus:outline-none text-sm"
          />
          {searchInput && (
            <button type="button" className="text-xs text-gray-500 hover:text-gray-700" onClick={() => setSearchInput('')}>
              Clear
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            value={productId ?? ''}
            onChange={(e) => setProductId(e.target.value || null)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white"
          >
            <option value="">All products ({products.length})</option>
            {products.map((p) => (
              <option key={p.productId} value={p.productId}>
                {p.isBundle ? '📦 ' : ''}{p.name} ({p.chunkCount})
              </option>
            ))}
          </select>
          <select
            value={chunkType ?? ''}
            onChange={(e) => setChunkType((e.target.value || null) as ChunkType | null)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white"
          >
            <option value="">All types</option>
            <option value="prose">Prose</option>
            <option value="faq">FAQ</option>
          </select>
          <select
            value={source ?? ''}
            onChange={(e) => setSource((e.target.value || null) as ChunkSource | null)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white"
          >
            <option value="">AI + Manual</option>
            <option value="ai">AI generated</option>
            <option value="manual">Manual</option>
          </select>
          <select
            value={minRating ?? ''}
            onChange={(e) => setMinRating(e.target.value ? Number(e.target.value) : null)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white"
          >
            <option value="">Any rating</option>
            <option value="4">≥ 4 stars</option>
            <option value="3">≥ 3 stars</option>
            <option value="2">≥ 2 stars</option>
            <option value="1">≥ 1 star</option>
          </select>
          <label className="inline-flex items-center gap-1 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={hasRating}
              onChange={(e) => setHasRating(e.target.checked)}
              className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
            />
            Only rated
          </label>
          <span className="text-gray-400">·</span>
          <span className="text-gray-600">Sort:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white"
          >
            <option value="modifiedDate">Recently modified</option>
            <option value="avgRating">Avg rating</option>
            <option value="ratingCount">Rating count</option>
            <option value="productName">Product</option>
          </select>
          <select
            value={sortDir}
            onChange={(e) => setSortDir(e.target.value as SortDir)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white"
          >
            <option value="desc">Desc</option>
            <option value="asc">Asc</option>
          </select>
          <button
            type="button"
            onClick={resetFilters}
            className="ml-auto text-xs text-gray-500 hover:text-oe-primary"
          >
            Reset filters
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {chunksQuery.isLoading && (
          <div className="text-center text-gray-500 text-sm py-8">Loading chunks…</div>
        )}
        {!chunksQuery.isLoading && chunks.length === 0 && (
          <div className="text-center text-gray-500 text-sm py-8 bg-white border border-gray-200 rounded-lg">
            No chunks match these filters.
          </div>
        )}
        {chunks.map((c) => (
          <AIKnowledgeChunkRow
            key={c.AIChunkId}
            chunk={c}
            onEdit={setEditing}
            onDelete={setConfirmDelete}
          />
        ))}
      </div>

      {totalCount > 0 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalCount)} of {totalCount}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1 || chunksQuery.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1 px-3 py-1 border border-gray-300 rounded-md text-sm bg-white disabled:opacity-40 hover:bg-gray-50"
            >
              <ChevronLeft className="w-4 h-4" /> Prev
            </button>
            <span>Page {page} / {totalPages}</span>
            <button
              type="button"
              disabled={page >= totalPages || chunksQuery.isFetching}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="inline-flex items-center gap-1 px-3 py-1 border border-gray-300 rounded-md text-sm bg-white disabled:opacity-40 hover:bg-gray-50"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <AIKnowledgeEditModal
        chunk={editing}
        saving={updateMutation.isPending}
        onClose={() => setEditing(null)}
        onSave={handleSave}
      />

      {confirmDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[80] p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-2">Delete chunk?</h3>
            <p className="text-sm text-gray-600 mb-4">
              This chunk will be soft-deleted and Columbus will stop returning it. You can recover
              it by regenerating the source document if it was AI-generated.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="px-4 py-2 text-sm border border-gray-300 text-gray-700 bg-white rounded-md hover:bg-gray-50"
                onClick={() => setConfirmDelete(null)}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-4 py-2 text-sm text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50"
                onClick={handleConfirmDelete}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
