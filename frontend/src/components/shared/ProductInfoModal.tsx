import { FileText, Package, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { API_CONFIG } from '../../config/api';
import { getProductDocumentItems, type ProductDocumentItem } from '../../utils/productDocuments';

interface ProductInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  product: any; // Can be a single product or a bundle
  isBundle: boolean;
  includedProducts?: Array<any>;
}

const ProductInfoModal: React.FC<ProductInfoModalProps> = ({
  isOpen,
  onClose,
  product,
  isBundle,
  includedProducts = []
}) => {
  if (!isOpen || !product) return null;

  const [activeTab, setActiveTab] = useState(0);
  const [activeDocIndex, setActiveDocIndex] = useState(0);
  const [authenticatedDocumentUrl, setAuthenticatedDocumentUrl] = useState<string | null>(null);
  const [documentLoadFailed, setDocumentLoadFailed] = useState(false);

  const productsToDisplay = isBundle && includedProducts.length > 0 ? includedProducts : [product];
  const currentProduct = productsToDisplay[activeTab];
  const documentItems: ProductDocumentItem[] = getProductDocumentItems(currentProduct ?? {});
  const hasMultipleDocs = documentItems.length > 1;
  const currentDoc = documentItems[activeDocIndex];
  const displayUrl = currentDoc?.documentUrl;

  // Subheading text shown under the modal title — this is the product description that used
  // to live on the tile. Shown whenever it's non-empty.
  const currentName = currentProduct?.productName || currentProduct?.name || '';
  const currentDescription = currentProduct?.description ? String(currentProduct.description).trim() : '';
  const showDescription = currentDescription.length > 0;

  // Reset document tab and load state when switching products or document
  useEffect(() => {
    setActiveDocIndex(0);
    setDocumentLoadFailed(false);
  }, [currentProduct?.productId, currentProduct?.productDocumentUrl, currentProduct?.productDocuments]);
  useEffect(() => {
    setDocumentLoadFailed(false);
  }, [activeDocIndex]);

  // Fetch authenticated document URL when single-doc API is used (legacy single document)
  useEffect(() => {
    const fetchAuthenticatedUrl = async () => {
      if (documentItems.length === 1 && currentProduct?.productId) {
        try {
          const token = localStorage.getItem('accessToken');
          const response = await fetch(`${API_CONFIG.BASE_URL}/api/products/${currentProduct.productId}/document`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          });

          if (response.ok) {
            const data = await response.json();
            if (data.success && data.data?.downloadUrl) {
              setAuthenticatedDocumentUrl(data.data.downloadUrl);
              return;
            }
          }
        } catch (error) {
          console.error('Error fetching authenticated document URL:', error);
        }
      }
      setAuthenticatedDocumentUrl(null);
    };

    fetchAuthenticatedUrl();
  }, [currentProduct?.productId, documentItems.length, currentProduct?.productDocumentUrl, currentProduct?.productDocuments]);

  const iframeUrl = documentItems.length === 1 && authenticatedDocumentUrl
    ? authenticatedDocumentUrl
    : displayUrl;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-[90vh] flex flex-col">
        {/* Modal Header */}
        <div className="p-4 border-b border-gray-200">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold text-gray-800 flex items-center">
              <FileText className="w-6 h-6 mr-2 text-oe-primary" />
              Product Information: {currentName}
            </h2>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
              <X className="w-6 h-6" />
            </button>
          </div>
          {showDescription && (
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">{currentDescription}</p>
          )}
        </div>

        {/* Tabs for Bundles */}
        {isBundle && productsToDisplay.length > 1 && (
          <div className="flex border-b border-gray-200 bg-gray-50">
            {productsToDisplay.map((p, index) => (
              <button
                key={p.productId || p.id || index}
                className={`px-4 py-2 text-sm font-medium ${
                  activeTab === index
                    ? 'border-b-2 border-oe-primary text-oe-primary'
                    : 'text-gray-600 hover:text-gray-800'
                }`}
                onClick={() => setActiveTab(index)}
              >
                {p.productName || p.name}
              </button>
            ))}
          </div>
        )}

        {/* Document selector when product has multiple documents */}
        {hasMultipleDocs && (
          <div className="flex border-b border-gray-200 bg-gray-50 px-4 py-2 gap-2 flex-wrap">
            {documentItems.map((doc, index) => (
              <button
                key={doc.productDocumentId ?? doc.documentUrl ?? index}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
                  activeDocIndex === index
                    ? 'bg-oe-primary text-white'
                    : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
                onClick={() => setActiveDocIndex(index)}
              >
                {doc.displayName?.trim() || `Document ${index + 1}`}
              </button>
            ))}
          </div>
        )}

        {/* Document Display Area */}
        <div className="flex-1 p-4 overflow-y-auto min-h-0">
          {iframeUrl ? (
            documentLoadFailed ? (
              <div className="flex flex-col items-center justify-center min-h-[400px] text-gray-500 p-6 text-center">
                <FileText className="w-12 h-12 text-gray-400 mb-3" />
                <p className="font-medium text-gray-700">This document is no longer available.</p>
                <p className="text-sm mt-1">It may have been removed. Refresh the page to see the latest document list.</p>
              </div>
            ) : (
              <>
                <iframe
                  key={activeDocIndex}
                  src={iframeUrl}
                  title={currentDoc?.displayName?.trim() || `Document ${activeDocIndex + 1}`}
                  className="w-full h-full min-h-[400px] border border-gray-200 rounded"
                  onError={() => setDocumentLoadFailed(true)}
                />
                <p className="text-xs text-gray-400 mt-2">If a document doesn&apos;t load, it may have been removed. Refresh the page for the latest list.</p>
              </>
            )
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-500 min-h-[300px]">
              <Package className="w-16 h-16 mb-4" />
              <p className="text-lg font-medium">No document available for this product.</p>
              <p className="text-sm">Please contact your agent for more information.</p>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-gray-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProductInfoModal;
