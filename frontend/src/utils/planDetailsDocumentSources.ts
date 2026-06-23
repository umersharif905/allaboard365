import type { ProductFormData } from '../types/sysadmin/addproductswizard.types';
import { getProductDocumentItems } from './productDocuments';

export type PlanDetailsDocSourceKind = 'existing' | 'pending' | 'generate-only';

export interface PlanDetailsDocSource {
  id: string;
  kind: PlanDetailsDocSourceKind;
  label: string;
  documentUrl?: string;
  file?: File;
}

export function buildPlanDetailsDocumentSources(
  formData: ProductFormData,
  existingProductDocumentUrl?: string
): PlanDetailsDocSource[] {
  const sources: PlanDetailsDocSource[] = [];

  const existingDocs =
    formData.productDocuments && formData.productDocuments.length > 0
      ? formData.productDocuments
      : existingProductDocumentUrl && !formData.deleteProductDocument
        ? [{ documentUrl: existingProductDocumentUrl, displayName: 'Document', sortOrder: 0 }]
        : getProductDocumentItems({
            productDocuments: formData.productDocuments,
            productDocumentUrl: existingProductDocumentUrl,
          });

  existingDocs.forEach((doc, index) => {
    if (!doc.documentUrl?.trim()) return;
    sources.push({
      id: `existing-${doc.productDocumentId || index}-${doc.documentUrl}`,
      kind: 'existing',
      label: doc.displayName?.trim() || `Saved document ${index + 1}`,
      documentUrl: doc.documentUrl.trim(),
    });
  });

  (formData.productDocumentFiles || []).forEach((item, index) => {
    if (!item?.file) return;
    sources.push({
      id: `pending-${index}-${item.file.name}-${item.file.size}`,
      kind: 'pending',
      label: item.displayName?.trim() || item.file.name || `Pending upload ${index + 1}`,
      file: item.file,
    });
  });

  return sources;
}

export async function fetchDocumentUrlAsFile(url: string, filename: string): Promise<File> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Failed to fetch document (${response.status})`);
  }
  const blob = await response.blob();
  const ext =
    filename.includes('.') ? filename.split('.').pop() : blob.type.includes('pdf') ? 'pdf' : 'bin';
  const safeName = filename.replace(/\s+/g, '-').replace(/[^\w.-]/g, '') || `document.${ext}`;
  return new File([blob], safeName, { type: blob.type || 'application/octet-stream' });
}

export async function collectFilesForPlanDetailsGeneration(
  sources: PlanDetailsDocSource[],
  selectedIds: Set<string>,
  generateOnlyFiles: File[]
): Promise<File[]> {
  const files: File[] = [];

  for (const source of sources) {
    if (!selectedIds.has(source.id)) continue;
    if (source.kind === 'existing' && source.documentUrl) {
      const file = await fetchDocumentUrlAsFile(
        source.documentUrl,
        `${source.label.replace(/\s+/g, '-')}.pdf`
      );
      files.push(file);
    } else if ((source.kind === 'pending' || source.kind === 'generate-only') && source.file) {
      files.push(source.file);
    }
  }

  for (const file of generateOnlyFiles) {
    files.push(file);
  }

  return files;
}
