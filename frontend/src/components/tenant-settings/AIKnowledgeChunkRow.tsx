import { Star, Pencil, Trash2, ExternalLink, Bot, User, MessageSquareText, FileText, Package } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { TenantKnowledgeChunk } from '../../services/aiTenantKnowledge.service';

interface Props {
  chunk: TenantKnowledgeChunk;
  onEdit: (chunk: TenantKnowledgeChunk) => void;
  onDelete: (chunk: TenantKnowledgeChunk) => void;
}

const previewText = (text: string, max = 240) =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;

const RatingPill = ({ avg, count }: { avg: number | null; count: number }) => {
  if (count === 0 || avg == null) {
    return <span className="text-xs text-gray-400 italic">No ratings</span>;
  }
  const color =
    avg >= 4 ? 'text-oe-success' :
    avg >= 3 ? 'text-yellow-600' :
    'text-red-600';
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-medium ${color}`}>
      <Star className="w-4 h-4 fill-current" />
      {avg.toFixed(2)}
      <span className="text-gray-500 font-normal">({count})</span>
    </span>
  );
};

export default function AIKnowledgeChunkRow({ chunk, onEdit, onDelete }: Props) {
  const SourceIcon = chunk.Source === 'ai' ? Bot : User;
  const TypeIcon = chunk.ChunkType === 'faq' ? MessageSquareText : FileText;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 hover:border-oe-primary transition-colors">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs mb-1">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-oe-light text-oe-dark">
              <TypeIcon className="w-3 h-3" />
              {chunk.ChunkType.toUpperCase()}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
              <SourceIcon className="w-3 h-3" />
              {chunk.Source === 'ai' ? 'AI generated' : 'Manual'}
            </span>
            {chunk.ProductName && (
              <Link
                to={`/products/${chunk.ProductId}`}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200"
                title="Open product editor"
              >
                {chunk.ProductIsBundle ? <Package className="w-3 h-3" /> : null}
                {chunk.ProductName}
                <ExternalLink className="w-3 h-3" />
              </Link>
            )}
          </div>
          {chunk.ChunkType === 'faq' && chunk.Question && (
            <p className="text-sm font-semibold text-gray-900 mb-1">Q: {chunk.Question}</p>
          )}
          {chunk.Title && chunk.ChunkType !== 'faq' && (
            <p className="text-sm font-semibold text-gray-900 mb-1">{chunk.Title}</p>
          )}
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{previewText(chunk.ChunkText)}</p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <RatingPill avg={chunk.AvgRating} count={chunk.RatingCount} />
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="p-1.5 rounded text-gray-500 hover:text-oe-primary hover:bg-oe-light"
              title="Edit chunk"
              onClick={() => onEdit(chunk)}
            >
              <Pencil className="w-4 h-4" />
            </button>
            <button
              type="button"
              className="p-1.5 rounded text-gray-500 hover:text-red-600 hover:bg-red-50"
              title="Delete chunk"
              onClick={() => onDelete(chunk)}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
