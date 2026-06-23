import { FileText, Loader2, Check, AlertCircle, RefreshCw } from 'lucide-react';
import type { ProductDocumentWithExtraction } from '../../../../types/aiChunks';

interface Props {
  documents: ProductDocumentWithExtraction[];
  onRegenerate: (documentId: string) => void;
  onRetry: (documentId: string) => void;
  isRegenerating?: boolean;
  regeneratingDocumentId?: string;
}

export default function ExtractionStatusBanner({
  documents,
  onRegenerate,
  onRetry,
  isRegenerating,
  regeneratingDocumentId,
}: Props) {
  if (!documents.length) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm text-gray-600">
        Upload a product document on the Documents step to auto-generate AI knowledge.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {documents.map((d, index) => {
        const docId = d.ProductDocumentId;
        const hasDocId = Boolean(docId);
        const docBusy =
          regeneratingDocumentId === docId ||
          d.ExtractionStatus === 'running' ||
          d.ExtractionStatus === 'queued';
        const regenDisabled = isRegenerating || docBusy || !hasDocId;

        return (
        <div key={docId || `doc-${index}`}
             className="flex items-center justify-between bg-white border border-gray-200 rounded-lg p-3">
          <div className="flex items-center min-w-0 flex-1">
            <FileText className="w-5 h-5 text-gray-400 flex-shrink-0 mr-3" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-800 truncate">{d.DisplayName}</p>
              <StatusLine doc={d} />
              {!hasDocId && (
                <p className="text-xs text-amber-700 mt-1">
                  Legacy document — re-upload on the Media step to enable regeneration.
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 ml-3 flex-shrink-0">
            {d.ExtractionStatus === 'failed' && hasDocId && (
              <button onClick={() => onRetry(docId)}
                      disabled={regenDisabled}
                      className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md disabled:opacity-50 flex items-center gap-1">
                <RefreshCw className={`w-3.5 h-3.5 ${regeneratingDocumentId === docId ? 'animate-spin' : ''}`} /> Retry
              </button>
            )}
            <button onClick={() => onRegenerate(docId)}
                    disabled={regenDisabled}
                    className="px-3 py-1.5 text-sm bg-oe-primary hover:bg-oe-dark text-white rounded-md disabled:opacity-50 flex items-center gap-1">
              <RefreshCw className={`w-3.5 h-3.5 ${regeneratingDocumentId === docId ? 'animate-spin' : ''}`} />
              {regeneratingDocumentId === docId ? 'Queuing…' : 'Regenerate'}
            </button>
          </div>
        </div>
        );
      })}
    </div>
  );
}

function StatusLine({ doc }: { doc: ProductDocumentWithExtraction }) {
  const cls = 'text-xs flex items-center gap-1 mt-0.5';
  switch (doc.ExtractionStatus) {
    case 'queued':
      return <p className={`${cls} text-gray-500`}><Loader2 className="w-3 h-3 animate-spin" /> Waiting to extract…</p>;
    case 'running':
      return <p className={`${cls} text-oe-primary`}><Loader2 className="w-3 h-3 animate-spin" /> Extracting…</p>;
    case 'completed':
      return <p className={`${cls} text-oe-success`}><Check className="w-3 h-3" /> {doc.ExtractionChunkCount ?? 0} chunks extracted</p>;
    case 'failed':
      return <p className={`${cls} text-red-600`}><AlertCircle className="w-3 h-3" /> Failed: {doc.ExtractionError?.slice(0, 80) || 'Unknown error'}</p>;
    default:
      return <p className={`${cls} text-gray-400`}>Not extracted yet</p>;
  }
}
