// frontend/src/components/groups/ASARequiredBanner.tsx
import React from 'react';
import { AlertCircle, Info } from 'lucide-react';

export interface ASAStatusItem {
  productId: string;
  productName: string;
  documentId: string;
  documentName: string;
  documentUrl?: string;
  signed: boolean;
}

interface ASARequiredBannerProps {
  asaStatus: ASAStatusItem[];
  /** True for Group Admin (can sign); false for Agent / Tenant (read-only). */
  canSign: boolean;
  onSign: (documentId: string) => void;
}

/**
 * Groups the ASA status array by documentId and returns one row per unique
 * unsigned document. Many products often share one ASA; we surface the document
 * once with a single Sign action.
 */
function uniqueUnsignedDocuments(asaStatus: ASAStatusItem[]): ASAStatusItem[] {
  const byDoc = new Map<string, ASAStatusItem>();
  for (const item of asaStatus) {
    if (item.signed) continue;
    if (!byDoc.has(item.documentId)) {
      byDoc.set(item.documentId, item);
    }
  }
  return Array.from(byDoc.values());
}

const ASARequiredBanner: React.FC<ASARequiredBannerProps> = ({
  asaStatus,
  canSign,
  onSign,
}) => {
  const unsigned = uniqueUnsignedDocuments(asaStatus);
  if (unsigned.length === 0) return null;

  if (!canSign) {
    return (
      <div className="bg-oe-light border border-oe-primary/30 rounded-lg p-4 mb-4">
        <div className="flex items-start gap-3">
          <Info className="h-5 w-5 text-oe-primary mt-0.5" aria-hidden />
          <div>
            <p className="font-semibold text-gray-900">Awaiting group admin signature on:</p>
            <ul className="mt-2 list-disc list-inside text-sm text-gray-700">
              {unsigned.map((doc) => (
                <li key={doc.documentId}>{doc.documentName}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-oe-light border border-oe-primary/30 rounded-lg p-4 mb-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-oe-primary mt-0.5" aria-hidden />
        <div className="flex-1">
          <p className="font-semibold text-gray-900">ASA signature required</p>
          <p className="text-sm text-gray-600 mt-1">
            Sign these documents to enable enrollment for the affected products.
          </p>

          <ul className="mt-3 space-y-2">
            {unsigned.map((doc) => (
              <li key={doc.documentId} className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-900">{doc.documentName}</span>
                <button
                  type="button"
                  onClick={() => onSign(doc.documentId)}
                  className="bg-oe-primary hover:bg-oe-dark text-white rounded-md px-3 py-1.5 text-sm font-medium"
                >
                  Sign
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default ASARequiredBanner;
