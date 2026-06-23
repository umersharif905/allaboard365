import { FileText } from 'lucide-react';
import { getProductDocumentItems, type ProductDocumentItem } from '../../utils/productDocuments';

export interface ProductDocumentsLinksProps {
  product: {
    productDocuments?: ProductDocumentItem[];
    productDocumentUrl?: string | null;
    ProductDocumentUrl?: string | null;
  } | null | undefined;
  /** 'button' for button style, 'link' for anchor style */
  variant?: 'button' | 'link';
  /** Size class: 'sm' (text-xs) or 'md' (text-sm) */
  size?: 'sm' | 'md';
  /** Fallback label when a document has no displayName (e.g. single doc or first doc) */
  label?: string;
  className?: string;
  /** When true, use displayName only (no fallback to "Document N") so UI can present custom labels */
  useLabelsOnly?: boolean;
}

export default function ProductDocumentsLinks({
  product,
  variant = 'button',
  size = 'md',
  label = 'Plan Document',
  className = '',
  useLabelsOnly = false
}: ProductDocumentsLinksProps) {
  const items = getProductDocumentItems(product ?? {});
  if (items.length === 0) return null;

  const sizeClass = size === 'sm' ? 'text-xs' : 'text-sm';
  const baseClass = variant === 'link'
    ? `inline-flex items-center font-medium text-oe-primary-dark hover:text-oe-primary underline ${sizeClass}`
    : `inline-flex items-center px-3 py-2 border border-blue-300 rounded-lg font-medium text-oe-primary-dark bg-white hover:bg-blue-50 ${sizeClass}`;
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  const gapClass = size === 'sm' ? 'mr-1' : 'mr-2';

  const getDisplayText = (doc: ProductDocumentItem, index: number) => {
    if (doc.displayName && doc.displayName.trim()) return doc.displayName.trim();
    if (useLabelsOnly) return `Document ${index + 1}`;
    return index === 0 ? label : `Document ${index + 1}`;
  };

  if (items.length === 1) {
    return (
      <a
        href={items[0].documentUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={`${baseClass} ${className}`}
      >
        <FileText className={`${iconSize} ${gapClass}`} />
        {getDisplayText(items[0], 0)}
      </a>
    );
  }

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {items.map((doc, index) => (
        <a
          key={doc.productDocumentId ?? doc.documentUrl ?? index}
          href={doc.documentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={baseClass}
        >
          <FileText className={`${iconSize} ${gapClass}`} />
          {getDisplayText(doc, index)}
        </a>
      ))}
    </div>
  );
}
