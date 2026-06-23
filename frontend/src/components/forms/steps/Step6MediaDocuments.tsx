import { FileAudio, FileImage, FileSpreadsheet, FileText, FileType, FileVideo, File as GenericFileIcon, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MediaStepProps } from '../../../types/sysadmin/addproductswizard.types';

// Helper function to extract filename from URL
const extractFileNameFromUrl = (url: string): string => {
  if (!url) return '';
  
  try {
    // Remove query parameters and get the last part of the path
    const urlWithoutQuery = url.split('?')[0];
    const pathParts = urlWithoutQuery.split('/');
    const fileName = pathParts[pathParts.length - 1];
    
    // If it's a UUID-based filename, return a generic name
    if (fileName && fileName.includes('-') && fileName.length > 20) {
      const extension = fileName.split('.').pop();
      return `Document.${extension}`;
    }
    
    return fileName || 'Document';
  } catch (error) {
    console.warn('Error extracting filename from URL:', error);
    return 'Document';
  }
};

// Helper function to check if a URL is a local file path
const isLocalFile = (url: string): boolean => {
  if (!url) return false;
  return url.startsWith('/') || url.includes('uploads/ai-temp') || url.includes('localhost');
};

// Helper function to convert local file path to viewable URL
const getViewableUrl = (url: string): string => {
  if (!url) return '';
  
  if (isLocalFile(url)) {
    const filename = url.split('/').pop();
    if (filename) {
      return `/api/ai/temp-file/${filename}`;
    }
  }
  
  return url;
};

// Helper function to get the appropriate icon based on file type
const getFileIcon = (contentType?: string, fileName?: string) => {
  // Prioritize content type for more accurate detection
  if (contentType) {
    if (contentType === 'application/pdf') {
      return FileText; // PDF icon
    }
    if (contentType.startsWith('image/')) {
      return FileImage; // Image icon
    }
    if (contentType.includes('spreadsheet') || contentType.includes('excel') || contentType.includes('csv')) {
      return FileSpreadsheet; // Spreadsheet icon
    }
    if (contentType.startsWith('video/')) {
      return FileVideo; // Video icon
    }
    if (contentType.startsWith('audio/')) {
      return FileAudio; // Audio icon
    }
    if (contentType.includes('text/') || contentType.includes('document')) {
      return FileType; // Text/document icon
    }
  }

  // Fallback to filename extension if contentType is not specific or missing
  if (fileName) {
    const extension = fileName.split('.').pop()?.toLowerCase();
    switch (extension) {
      case 'pdf':
        return FileText;
      case 'jpg':
      case 'jpeg':
      case 'png':
      case 'gif':
      case 'bmp':
      case 'webp':
      case 'svg':
        return FileImage;
      case 'xls':
      case 'xlsx':
      case 'csv':
        return FileSpreadsheet;
      case 'mp4':
      case 'avi':
      case 'mov':
      case 'wmv':
        return FileVideo;
      case 'mp3':
      case 'wav':
      case 'flac':
        return FileAudio;
      case 'txt':
      case 'doc':
      case 'docx':
      case 'rtf':
        return FileType;
      default:
        return GenericFileIcon; // Generic file icon for unknown types
    }
  }

  return GenericFileIcon; // Default generic file icon
};

export default function Step6MediaDocuments({
  formData,
  updateFormData,
  existingMediaUrls,
  documentMetadata,
  onOpenLogoGenerate,
}: MediaStepProps) {
  const [documentToRemoveIndex, setDocumentToRemoveIndex] = useState<number | null>(null);
  const [pendingImagePreviewUrl, setPendingImagePreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!formData.productImageFile) {
      setPendingImagePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(formData.productImageFile);
    setPendingImagePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [formData.productImageFile]);

  // Single product image (we kept "Product Image" in the wizard; it writes to both fields)
  const existingProductImageUrl = existingMediaUrls.productImageUrl || existingMediaUrls.productLogoUrl;

  // Handle image deletion (clears both image and logo URLs so backend/store stay in sync)
  const handleDeleteImage = () => {
    if (window.confirm('Are you sure you want to delete the current image? This action cannot be undone.')) {
      updateFormData({
        productImageFile: null,
        productLogoFile: null,
        deleteProductImage: true,
        deleteProductLogo: true
      });
    }
  };

  // Build list of documents: existing from productDocuments + legacy single URL, plus pending new files (unlimited)
  const existingDocs = (formData.productDocuments && formData.productDocuments.length > 0)
    ? formData.productDocuments
    : existingMediaUrls.productDocumentUrl && !formData.deleteProductDocument
      ? [{ documentUrl: existingMediaUrls.productDocumentUrl, displayName: (formData as any).productDocumentName || 'Document', sortOrder: 0 }]
      : [];
  const pendingFiles = formData.productDocumentFiles || [];

  const setDocumentLabel = (index: number, displayName: string) => {
    if (index < existingDocs.length) {
      if (formData.productDocuments && formData.productDocuments.length > 0) {
        const next = formData.productDocuments.map((d, i) => (i === index ? { ...d, displayName: displayName || d.displayName } : d));
        updateFormData({ productDocuments: next });
      } else if (existingMediaUrls.productDocumentUrl && index === 0) {
        updateFormData({ productDocumentName: displayName || 'Document' } as any);
      }
    } else {
      const pendingIndex = index - existingDocs.length;
      const next = [...(formData.productDocumentFiles || [])];
      if (next[pendingIndex]) next[pendingIndex] = { ...next[pendingIndex], displayName: displayName || next[pendingIndex].displayName };
      updateFormData({ productDocumentFiles: next });
    }
  };

  const removeDocument = (index: number) => {
    if (index < existingDocs.length) {
      if (formData.productDocuments && formData.productDocuments.length > 0) {
        const next = formData.productDocuments.filter((_, i) => i !== index);
        updateFormData({ productDocuments: next.length ? next : undefined });
      } else if (index === 0) {
        updateFormData({ deleteProductDocument: true });
      }
    } else {
      const pendingIndex = index - existingDocs.length;
      const next = (formData.productDocumentFiles || []).filter((_, i) => i !== pendingIndex);
      updateFormData({ productDocumentFiles: next.length ? next : undefined });
    }
    setDocumentToRemoveIndex(null);
  };

  const confirmRemoveDocument = (index: number) => setDocumentToRemoveIndex(index);

  const addPendingDocument = (file: File) => {
    const next = [...(formData.productDocumentFiles || []), { file, displayName: file.name || 'Document' }];
    updateFormData({ productDocumentFiles: next });
  };

  return (
    <div className="space-y-6">
      <h3 className="text-xl font-bold text-oe-text">Media & Documents</h3>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="form-label">Product Image</label>
          <p className="text-xs text-gray-500 mb-2">Used for cards and enrollment; one image is stored for both display and logo.</p>
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-oe-primary transition-colors min-h-[200px] flex flex-col justify-center">
            {existingProductImageUrl && !formData.productImageFile && !formData.deleteProductImage ? (
              <div className="space-y-3">
                <div className="w-full h-32 flex items-center justify-center bg-gray-50 rounded-lg overflow-hidden">
                  {isLocalFile(existingProductImageUrl) ? (
                    <div className="text-center">
                      <FileImage className="w-12 h-12 text-blue-500 mx-auto mb-2" />
                      <p className="text-xs text-gray-500">Local file - preview in new tab</p>
                    </div>
                  ) : (
                    <img
                      src={existingProductImageUrl}
                      alt="Current product image"
                      className="max-w-full max-h-full object-contain"
                    />
                  )}
                </div>
                <p className="text-sm text-gray-600">Current Image</p>
                {(formData as any).productImageName && (
                  <p className="text-xs text-gray-500 font-medium truncate px-2">
                    {(formData as any).productImageName}
                  </p>
                )}
                <button
                  onClick={() => window.open(getViewableUrl(existingProductImageUrl), '_blank')}
                  className="text-xs text-oe-primary hover:text-blue-800 underline"
                >
                  Preview Image
                </button>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) updateFormData({ productImageFile: file, deleteProductImage: false, deleteProductLogo: false });
                  }}
                  className="hidden"
                  id="product-image-update"
                />
                <div className="flex flex-wrap gap-2 justify-center">
                  <label htmlFor="product-image-update" className="btn-primary cursor-pointer text-sm inline-block px-4 py-2">
                    Replace Image
                  </label>
                  <button
                    type="button"
                    onClick={() => onOpenLogoGenerate?.()}
                    className="btn-secondary text-sm inline-flex items-center gap-1.5 px-4 py-2"
                  >
                    <Sparkles className="w-4 h-4" />
                    Generate with AI
                  </button>
                  <button
                    onClick={handleDeleteImage}
                    className="p-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
                    title="Delete Image"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
              </div>
            ) : formData.productImageFile ? (
              <div className="space-y-3">
                <div className="w-full h-32 flex items-center justify-center bg-gray-50 rounded-lg overflow-hidden">
                  {pendingImagePreviewUrl ? (
                    <img
                      src={pendingImagePreviewUrl}
                      alt="Selected product image"
                      className="max-w-full max-h-full object-contain"
                    />
                  ) : (
                    <p className="text-sm text-green-600 font-medium">✓ {formData.productImageFile.name}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 justify-center">
                  <button
                    type="button"
                    onClick={() => updateFormData({ productImageFile: null, productLogoFile: null })}
                    className="btn-danger text-sm"
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenLogoGenerate?.()}
                    className="btn-secondary text-sm inline-flex items-center gap-1.5 px-4 py-2"
                  >
                    <Sparkles className="w-4 h-4" />
                    Generate with AI
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="w-full h-32 flex items-center justify-center bg-gray-100 rounded">
                  <div className="text-center">
                    <svg width="64" height="64" viewBox="0 0 64 64" className="mx-auto mb-2 text-gray-400">
                      <rect width="64" height="64" fill="#e5e7eb"/>
                      <rect x="12" y="12" width="40" height="40" fill="none" stroke="#9ca3af" strokeWidth="2" rx="4"/>
                      <circle cx="22" cy="22" r="3" fill="#9ca3af"/>
                      <path d="M52 44l-12-12-8 8-8-8-12 12v4a4 4 0 004 4h32a4 4 0 004-4v-4z" fill="#9ca3af"/>
                    </svg>
                    <p className="text-sm text-gray-500">No Image</p>
                  </div>
                </div>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      updateFormData({
                        productImageFile: file,
                        deleteProductImage: false,
                        deleteProductLogo: false
                      });
                    }
                  }}
                  className="hidden"
                  id="product-image"
                />
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <label htmlFor="product-image" className="text-sm text-oe-primary hover:text-oe-primary-dark cursor-pointer transition-colors">
                    Upload Image
                  </label>
                  <span className="text-gray-300">|</span>
                  <button
                    type="button"
                    onClick={() => onOpenLogoGenerate?.()}
                    className="text-sm text-oe-primary hover:text-oe-primary-dark inline-flex items-center gap-1.5 transition-colors"
                  >
                    <Sparkles className="w-4 h-4" />
                    Generate with AI
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div>
          <label className="form-label">Product Documents</label>
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-oe-primary transition-colors min-h-[200px] flex flex-col justify-center">
            {(existingDocs.length > 0 || pendingFiles.length > 0) ? (
              <div className="space-y-3 w-full text-left">
                <p className="text-sm text-gray-600">Add as many documents as you need. Set labels for how they appear on the UI.</p>
                {existingDocs.map((doc, index) => (
                  <div key={doc.productDocumentId ?? doc.documentUrl ?? index} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg border border-gray-200">
                    <input
                      type="text"
                      value={doc.displayName || ''}
                      onChange={(e) => setDocumentLabel(index, e.target.value)}
                      placeholder="Label (e.g. Summary PDF)"
                      className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    />
                    <a
                      href={doc.documentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-oe-primary hover:underline shrink-0"
                    >
                      Preview
                    </a>
                    <button
                      type="button"
                      onClick={() => confirmRemoveDocument(index)}
                      className="p-1.5 text-red-500 hover:bg-red-50 rounded"
                      title="Remove document"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                {pendingFiles.map((item, i) => (
                  <div key={`pending-${i}`} className="flex items-center gap-2 p-2 bg-green-50 rounded-lg border border-green-200">
                    <input
                      type="text"
                      value={item.displayName || ''}
                      onChange={(e) => setDocumentLabel(existingDocs.length + i, e.target.value)}
                      placeholder="Label for new document"
                      className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    />
                    <span className="text-xs text-green-700 shrink-0 truncate max-w-[120px]" title={item.file.name}>{item.file.name}</span>
                    <button
                      type="button"
                      onClick={() => confirmRemoveDocument(existingDocs.length + i)}
                      className="p-1.5 text-red-500 hover:bg-red-50 rounded"
                      title="Remove document"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <input
                  type="file"
                  accept=".pdf,.doc,.docx"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      addPendingDocument(file);
                      e.target.value = '';
                    }
                  }}
                  className="hidden"
                  id="product-document-add"
                />
                <label htmlFor="product-document-add" className="inline-flex items-center gap-1.5 text-sm text-oe-primary hover:text-oe-primary-dark cursor-pointer">
                  <Plus className="h-4 w-4" />
                  Add another document
                </label>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="w-full h-32 flex items-center justify-center bg-gray-100 rounded">
                  <div className="text-center">
                    <GenericFileIcon className="w-12 h-12 text-gray-400 mx-auto mb-2" />
                    <p className="text-sm text-gray-500">No documents yet</p>
                    <p className="text-xs text-gray-400 mt-1">Add PDFs or documents; you can add as many as you need.</p>
                  </div>
                </div>
                <input
                  type="file"
                  accept=".pdf,.doc,.docx"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      addPendingDocument(file);
                      e.target.value = '';
                    }
                  }}
                  className="hidden"
                  id="product-document"
                />
                <label htmlFor="product-document" className="text-sm text-oe-primary hover:text-oe-primary-dark cursor-pointer transition-colors inline-flex items-center gap-1.5">
                  <Plus className="h-4 w-4" />
                  Add document
                </label>
              </div>
            )}
          </div>
        </div>
      </div>


      {/* Confirm remove document modal */}
      {documentToRemoveIndex !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Remove document?</h3>
            <p className="text-sm text-gray-600 mb-4">
              This document will be removed from the product. Save the product to apply changes.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDocumentToRemoveIndex(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => removeDocument(documentToRemoveIndex)}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}