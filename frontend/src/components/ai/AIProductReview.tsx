import { Building2, CheckCircle, Edit, FileAudio, FileImage, FileSpreadsheet, FileText, FileType, FileVideo, File as GenericFileIcon, Image as ImageIcon, Sparkles } from 'lucide-react';
import type { ProductFormData } from '../../types/sysadmin/addproductswizard.types';

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
  // Check if it's a local file path (starts with / or contains uploads/ai-temp)
  return url.startsWith('/') || url.includes('uploads/ai-temp') || url.includes('localhost');
};

// Helper function to convert local file path to viewable URL
const getViewableUrl = (url: string): string => {
  if (!url) return '';
  
  if (isLocalFile(url)) {
    // Extract filename from local path
    const filename = url.split('/').pop();
    if (filename) {
      return `/api/ai/temp-file/${filename}`;
    }
  }
  
  return url;
};

// Helper function to get the appropriate icon based on file type
const getFileIconFromUrl = (url: string) => {
  const fileName = extractFileNameFromUrl(url);
  const extension = fileName.split('.').pop()?.toLowerCase();
  
  switch (extension) {
    case 'pdf':
      return <FileText className="w-6 h-6" />;
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'bmp':
    case 'webp':
    case 'svg':
      return <FileImage className="w-6 h-6" />;
    case 'xls':
    case 'xlsx':
    case 'csv':
      return <FileSpreadsheet className="w-6 h-6" />;
    case 'mp4':
    case 'avi':
    case 'mov':
    case 'wmv':
      return <FileVideo className="w-6 h-6" />;
    case 'mp3':
    case 'wav':
    case 'flac':
      return <FileAudio className="w-6 h-6" />;
    case 'txt':
    case 'doc':
    case 'docx':
    case 'rtf':
      return <FileType className="w-6 h-6" />;
    default:
      return <GenericFileIcon className="w-6 h-6" />;
  }
};

interface AIProductReviewProps {
  productData: ProductFormData;
  onEditWithAI: () => void;
  onFinishInWizard: () => void;
}

export default function AIProductReview({
  productData,
  onEditWithAI,
  onFinishInWizard
}: AIProductReviewProps) {
  return (
    <div className="bg-white rounded-lg p-6">
      {/* Header */}
      <div className="flex items-center space-x-3 mb-6 pb-4 border-b border-gray-200">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-green-100">
          <CheckCircle className="w-6 h-6 text-green-600" />
        </div>
        <div>
          <h3 className="text-xl font-semibold text-gray-900">AI Generated Product</h3>
          <p className="text-sm text-gray-600">Review the details below and choose how to proceed</p>
        </div>
      </div>

      {/* Product Details */}
      <div className="space-y-6">
        {/* Basic Info */}
        <div>
          <h4 className="text-lg font-medium text-gray-900 mb-3">Basic Information</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-gray-600">Product Name</label>
              <p className="text-gray-900">{productData.name || '(Not provided)'}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-600">Product Type</label>
              <p className="text-gray-900">{productData.productType || '(Not provided)'}</p>
            </div>
            <div className="md:col-span-2">
              <label className="text-sm font-medium text-gray-600">Description</label>
              <p className="text-gray-900">{productData.description || '(Not provided)'}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-600">Sales Type</label>
              <p className="text-gray-900">{productData.salesType || '(Not provided)'}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-600">Age Range</label>
              <p className="text-gray-900">
                {productData.minAge || productData.maxAge 
                  ? `${productData.minAge || 0} - ${productData.maxAge || 65}` 
                  : '(Not provided)'}
              </p>
            </div>
          </div>
        </div>

        {/* Required Licenses */}
        {productData.requiredLicenses && productData.requiredLicenses.length > 0 && (
          <div>
            <h4 className="text-lg font-medium text-gray-900 mb-3">Required Licenses</h4>
            <div className="flex flex-wrap gap-2">
              {productData.requiredLicenses.map((license, index) => (
                <span
                  key={index}
                  className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800"
                >
                  {license}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Allowed States */}
        {productData.allowedStates && productData.allowedStates.length > 0 && (
          <div>
            <h4 className="text-lg font-medium text-gray-900 mb-3">Allowed States</h4>
            <div className="flex flex-wrap gap-2">
              {productData.allowedStates.map((state, index) => (
                <span
                  key={index}
                  className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-800"
                >
                  {state}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Configuration Fields */}
        {productData.configurationFields && productData.configurationFields.length > 0 && (
          <div>
            <h4 className="text-lg font-medium text-gray-900 mb-3">Configuration Fields</h4>
            <div className="space-y-2">
              {productData.configurationFields.map((field, index) => (
                <div key={index} className="bg-gray-50 p-3 rounded-lg">
                  <p className="font-medium text-gray-900">{field.fieldName}</p>
                  <p className="text-sm text-gray-600">
                    Options: {field.fieldOptions.join(', ') || 'None'}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pricing Tiers */}
        {productData.pricingTiers && productData.pricingTiers.length > 0 && (
          <div>
            <h4 className="text-lg font-medium text-gray-900 mb-3">Pricing Tiers</h4>
            <div className="space-y-3">
              {productData.pricingTiers.map((tier, index) => (
                <div key={index} className="bg-gray-50 p-4 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <h5 className="font-medium text-gray-900">
                      {tier.label || tier.tierType}
                    </h5>
                    <span className="text-sm text-gray-600">
                      {tier.ageBands.length} age band{tier.ageBands.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                    {tier.ageBands.map((band, bandIndex) => (
                      <div key={bandIndex} className="bg-white p-2 rounded border border-gray-200">
                        <p className="text-xs text-gray-600">
                          Ages {band.minAge}-{band.maxAge}
                        </p>
                        <p className="font-medium text-gray-900">
                          ${band.msrpRate || band.netRate || 0}/mo
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Acknowledgement Questions */}
        {productData.acknowledgementQuestions && productData.acknowledgementQuestions.length > 0 && (
          <div>
            <h4 className="text-lg font-medium text-gray-900 mb-3">Acknowledgement Questions</h4>
            <div className="space-y-2">
              {productData.acknowledgementQuestions.map((question, index) => (
                <div key={index} className="bg-gray-50 p-3 rounded-lg">
                  <p className="text-gray-900">{question.question}</p>
                  <p className="text-xs text-gray-600 mt-1">
                    Type: {question.fieldType} {question.required && '(Required)'}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* File Attachments */}
        {(productData.productImageUrl || productData.productLogoUrl || productData.productDocumentUrl) && (
          <div>
            <h4 className="text-lg font-medium text-gray-900 mb-3">File Attachments</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {productData.productImageUrl && (
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                  <div className="flex items-center space-x-3 mb-3">
                    <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                      <ImageIcon className="w-5 h-5 text-oe-primary" />
                    </div>
                    <div>
                      <span className="text-sm font-medium text-gray-900">Product Image</span>
                      <p className="text-xs text-gray-500">Main product photo</p>
                    </div>
                  </div>
                  
                  {/* Image Preview */}
                  <div className="w-full h-24 bg-white rounded-lg border border-gray-200 mb-3 overflow-hidden flex items-center justify-center">
                    {isLocalFile(productData.productImageUrl) ? (
                      <div className="text-center">
                        <div className="w-8 h-8 mx-auto mb-2 text-gray-400">
                          <FileImage className="w-6 h-6" />
                        </div>
                        <span className="text-xs text-gray-500">Local file - preview in wizard</span>
                      </div>
                    ) : (
                      <>
                        <img 
                          src={productData.productImageUrl} 
                          alt="Product image preview"
                          className="max-w-full max-h-full object-contain bg-white"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                            e.currentTarget.nextElementSibling?.classList.remove('hidden');
                          }}
                        />
                        <div className="hidden w-full h-full flex items-center justify-center text-gray-400">
                          <span className="text-xs">Preview not available</span>
                        </div>
                      </>
                    )}
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-600 truncate flex-1">
                      {(productData as any).productImageName || extractFileNameFromUrl(productData.productImageUrl)}
                    </p>
                    <button
                      onClick={() => window.open(getViewableUrl(productData.productImageUrl), '_blank')}
                      className="text-xs text-oe-primary hover:text-blue-800 underline ml-2"
                    >
                      View
                    </button>
                  </div>
                </div>
              )}
              
              {productData.productLogoUrl && (
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                  <div className="flex items-center space-x-3 mb-3">
                    <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                      <Building2 className="w-5 h-5 text-green-600" />
                    </div>
                    <div>
                      <span className="text-sm font-medium text-gray-900">Company Logo</span>
                      <p className="text-xs text-gray-500">Vendor/company logo</p>
                    </div>
                  </div>
                  
                  {/* Logo Preview */}
                  <div className="w-full h-24 bg-white rounded-lg border border-gray-200 mb-3 overflow-hidden flex items-center justify-center">
                    {isLocalFile(productData.productLogoUrl) ? (
                      <div className="text-center">
                        <div className="w-8 h-8 mx-auto mb-2 text-gray-400">
                          <FileImage className="w-6 h-6" />
                        </div>
                        <span className="text-xs text-gray-500">Local file - preview in wizard</span>
                      </div>
                    ) : (
                      <>
                        <img 
                          src={productData.productLogoUrl} 
                          alt="Company logo preview"
                          className="max-w-full max-h-full object-contain"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                            e.currentTarget.nextElementSibling?.classList.remove('hidden');
                          }}
                        />
                        <div className="hidden w-full h-full flex items-center justify-center text-gray-400">
                          <span className="text-xs">Preview not available</span>
                        </div>
                      </>
                    )}
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-600 truncate flex-1">
                      {(productData as any).productLogoName || extractFileNameFromUrl(productData.productLogoUrl)}
                    </p>
                    <button
                      onClick={() => window.open(getViewableUrl(productData.productLogoUrl), '_blank')}
                      className="text-xs text-oe-primary hover:text-blue-800 underline ml-2"
                    >
                      View
                    </button>
                  </div>
                </div>
              )}
              
              {productData.productDocumentUrl && (
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                  <div className="flex items-center space-x-3 mb-3">
                    <div className="w-10 h-10 bg-purple-100 rounded-full flex items-center justify-center">
                      <FileText className="w-5 h-5 text-purple-600" />
                    </div>
                    <div>
                      <span className="text-sm font-medium text-gray-900">Product Document</span>
                      <p className="text-xs text-gray-500">Brochure, terms, or docs</p>
                    </div>
                  </div>
                  
                  {/* Document Preview */}
                  <div className="w-full h-24 bg-white rounded-lg border border-gray-200 mb-3 flex items-center justify-center">
                    <div className="text-center">
                      <div className="w-8 h-8 mx-auto mb-2 text-gray-400">
                        {getFileIconFromUrl(productData.productDocumentUrl)}
                      </div>
                      <span className="text-xs text-gray-500">Document</span>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-600 truncate flex-1">
                      {(productData as any).productDocumentName || extractFileNameFromUrl(productData.productDocumentUrl)}
                    </p>
                    <button
                      onClick={() => window.open(getViewableUrl(productData.productDocumentUrl), '_blank')}
                      className="text-xs text-oe-primary hover:text-blue-800 underline ml-2"
                    >
                      View
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* AI Chunks */}
        {productData.aiChunks && productData.aiChunks.length > 0 && (
          <div>
            <h4 className="text-lg font-medium text-gray-900 mb-3">AI Knowledge Base</h4>
            <p className="text-sm text-gray-600 mb-2">
              {productData.aiChunks.length} knowledge chunk{productData.aiChunks.length !== 1 ? 's' : ''} added
            </p>
            <div className="max-h-40 overflow-y-auto space-y-2">
              {productData.aiChunks.map((chunk, index) => (
                <div key={index} className="bg-gray-50 p-2 rounded text-sm text-gray-700">
                  {chunk.chunk_text.substring(0, 150)}
                  {chunk.chunk_text.length > 150 && '...'}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-between mt-8 pt-6 border-t border-gray-200">
        <button
          onClick={onEditWithAI}
          className="inline-flex items-center px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg hover:from-purple-700 hover:to-blue-700 transition-colors font-medium"
        >
          <Sparkles className="w-5 h-5 mr-2" />
          Edit with AI
        </button>

        <button
          onClick={onFinishInWizard}
          className="inline-flex items-center px-6 py-3 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors font-medium"
        >
          <Edit className="w-5 h-5 mr-2" />
          Finish in Wizard
        </button>
      </div>

      {/* Info Note */}
      <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
        <p className="text-sm text-oe-primary-dark">
          <strong>Edit with AI:</strong> Refine this product by chatting with AI to make changes.
          <br />
          <strong>Finish in Wizard:</strong> Review and confirm each step manually in the product wizard.
        </p>
      </div>
    </div>
  );
}



