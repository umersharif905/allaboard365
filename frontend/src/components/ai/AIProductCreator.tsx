import { AlertCircle, CheckCircle, FileText, Loader2, Sparkles, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useTenantsForDropdown } from '../../hooks/useEnrollmentLinkTemplates';
import { MAX_DOCUMENT_UPLOAD_MB } from '../../constants/uploads';
import { apiService } from '../../services/api.service';
import type {
  AIGenerationProgress,
  AIGenerationResponse,
  AIProductCreatorProps,
  FileWithPreview
} from '../../types/ai/aiProductCreator.types';
import type { ProductFormData } from '../../types/sysadmin/addproductswizard.types';
import SearchableDropdown from '../common/SearchableDropdown';
import AIProductReview from './AIProductReview';

export default function AIProductCreator({
  isOpen,
  onClose,
  onSuccess,
  vendorId: prefilledVendorId,
  productOwnerId
}: AIProductCreatorProps) {
  const { user } = useAuth();
  const isSysAdmin = user?.currentRole === 'SysAdmin';
  const { data: tenants, isLoading: loadingTenants } = useTenantsForDropdown();
  
  const [textInput, setTextInput] = useState('');
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  const [progress, setProgress] = useState<AIGenerationProgress>({
    stage: 'idle',
    message: ''
  });
  const [dragActive, setDragActive] = useState(false);
  const [vendors, setVendors] = useState<any[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState(prefilledVendorId || '');
  const [loadingVendors, setLoadingVendors] = useState(false);
  const [generatedProductData, setGeneratedProductData] = useState<ProductFormData | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [isEditingMode, setIsEditingMode] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState('');

  // Fetch vendors when modal opens
  useEffect(() => {
    if (isOpen && !prefilledVendorId) {
      fetchVendors();
    } else if (prefilledVendorId) {
      setSelectedVendorId(prefilledVendorId);
    }
  }, [isOpen, prefilledVendorId]);

  const fetchVendors = async () => {
    setLoadingVendors(true);
    try {
      const response = await apiService.get<{ vendors?: any[]; data?: any[] }>('/api/vendors');
      setVendors(response.vendors || response.data || []);
    } catch (error) {
      console.error('Failed to fetch vendors:', error);
    } finally {
      setLoadingVendors(false);
    }
  };

  // Handle file selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files).map(file => ({
        file,
        preview: URL.createObjectURL(file),
        name: file.name,
        size: file.size,
        type: file.type
      }));
      
      // Check file limit
      const totalFiles = files.length + newFiles.length;
      if (totalFiles > 20) {
        alert(`Maximum 20 files allowed. You currently have ${files.length} file(s) and tried to add ${newFiles.length} more.`);
        return;
      }
      
      setFiles(prev => [...prev, ...newFiles]);
    }
  };

  // Handle drag and drop
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const newFiles = Array.from(e.dataTransfer.files).map(file => ({
        file,
        preview: URL.createObjectURL(file),
        name: file.name,
        size: file.size,
        type: file.type
      }));
      setFiles(prev => [...prev, ...newFiles]);
    }
  }, []);

  // Remove file
  const removeFile = (index: number) => {
    setFiles(prev => {
      const newFiles = [...prev];
      URL.revokeObjectURL(newFiles[index].preview);
      newFiles.splice(index, 1);
      return newFiles;
    });
  };

  // Format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  // Handle form submission
  const handleGenerate = async () => {
    if (!textInput.trim() && files.length === 0) {
      alert('Please provide either text input or upload files');
      return;
    }

    if (!selectedVendorId) {
      alert('Please select a vendor');
      return;
    }

    // Determine productOwnerId: use selected tenant for SysAdmin, otherwise use prop
    const effectiveProductOwnerId = isSysAdmin ? selectedTenantId : productOwnerId;
    
    if (!effectiveProductOwnerId) {
      alert(isSysAdmin ? 'Please select a tenant' : 'Product Owner ID is required');
      return;
    }

    setProgress({
      stage: 'uploading',
      message: 'Preparing files...'
    });

    try {
      // Create FormData
      const formData = new FormData();
      
      // If editing, include the existing product data in the text
      let promptText = textInput;
      if (isEditingMode && generatedProductData) {
        promptText = `EXISTING PRODUCT DATA (modify based on the request below):\n${JSON.stringify(generatedProductData, null, 2)}\n\nUSER REQUEST:\n${textInput}`;
      }
      
      formData.append('textInput', promptText);
      formData.append('vendorId', selectedVendorId);
      formData.append('productOwnerId', effectiveProductOwnerId);

      // Add files
      files.forEach(fileItem => {
        formData.append('files', fileItem.file);
      });

      setProgress({
        stage: 'processing',
        message: 'Processing documents...'
      });

      // Call API with extended timeout for AI generation (10 minutes)
      const result = await apiService.post<AIGenerationResponse>('/api/ai/generate-product', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        },
        timeout: 600000 // 10 minutes (600,000ms) - AI generation can take time with multiple files and retries
      });

      if (!result.success || !result.data) {
        const error = new Error(result.message || 'Failed to generate product') as Error & {
          validationErrors?: string[];
          attempts?: number;
        };
        error.validationErrors = result.validationErrors;
        error.attempts = result.attempts;
        throw error;
      }

      setProgress({
        stage: 'success',
        message: `Product generated successfully in ${result.attempts || 1} attempt(s)!`,
        attempt: result.attempts,
        maxAttempts: 3
      });

      // Store generated data and show review screen
      setGeneratedProductData(result.data);
      setTimeout(() => {
        setShowReview(true);
      }, 1000);

    } catch (error: unknown) {
      console.error('AI generation error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to generate product. Please try again.';
      const errorWithExtras = error as Error & {
        validationErrors?: string[];
        attempts?: number;
      };
      
      const progressUpdate: AIGenerationProgress = {
        stage: 'error',
        message: errorMessage,
        ...(errorWithExtras.validationErrors && { validationErrors: errorWithExtras.validationErrors }),
        ...(errorWithExtras.attempts !== undefined && { attempt: errorWithExtras.attempts })
      };
      
      setProgress(progressUpdate);
    }
  };

  // Reset form
  const handleReset = () => {
    setTextInput('');
    files.forEach(f => URL.revokeObjectURL(f.preview));
    setFiles([]);
    setProgress({ stage: 'idle', message: '' });
    setShowReview(false);
    setGeneratedProductData(null);
    setIsEditingMode(false);
    if (!prefilledVendorId) {
      setSelectedVendorId('');
    }
    if (isSysAdmin) {
      setSelectedTenantId('');
    }
  };

  // Handle Edit with AI
  const handleEditWithAI = () => {
    setShowReview(false);
    setIsEditingMode(true);
    setTextInput('');
    setProgress({ stage: 'idle', message: '' });
  };

  // Handle Finish in Wizard
  const handleFinishInWizard = () => {
    if (generatedProductData) {
      onSuccess(generatedProductData);
      handleClose();
    }
  };

  // Close handler
  const handleClose = () => {
    handleReset();
    onClose();
  };

  if (!isOpen) return null;

  const isGenerating = ['uploading', 'processing', 'generating', 'validating'].includes(progress.stage);
  const isSuccess = progress.stage === 'success';
  const isError = progress.stage === 'error';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg w-full max-w-4xl max-h-[90vh] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gradient-to-r from-blue-600 to-blue-700">
          <div className="flex items-center space-x-3">
            <Sparkles className="w-6 h-6 text-white" />
            <h2 className="text-xl font-bold text-white">
              {showReview ? 'Review Generated Product' : isEditingMode ? 'Edit Product with AI' : 'Create Product with AI'}
            </h2>
          </div>
          <button
            onClick={handleClose}
            disabled={isGenerating}
            className="text-white hover:bg-white hover:bg-opacity-20 p-2 rounded-lg transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)]">
          {/* Show Review Screen if product is generated */}
          {showReview && generatedProductData ? (
            <AIProductReview
              productData={generatedProductData}
              onEditWithAI={handleEditWithAI}
              onFinishInWizard={handleFinishInWizard}
            />
          ) : (
            <>
          {/* Current Product Info (shown when editing) */}
          {isEditingMode && generatedProductData && (
            <div className="bg-white border-2 border-purple-200 rounded-lg p-4 mb-6">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">
                    {generatedProductData.name || 'Untitled Product'}
                  </h3>
                  <p className="text-sm text-gray-600 line-clamp-2">
                    {generatedProductData.description || 'No description provided'}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setShowReview(true);
                    setIsEditingMode(false);
                    setTextInput('');
                    setProgress({ stage: 'idle', message: '' });
                  }}
                  className="ml-4 px-3 py-1.5 text-sm font-medium text-purple-700 bg-purple-100 hover:bg-purple-200 rounded-lg transition-colors flex-shrink-0"
                >
                  View All Details
                </button>
              </div>
            </div>
          )}

          {/* Instructions */}
          {isEditingMode ? (
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-6">
              <h3 className="text-lg font-medium text-purple-900 mb-2">Edit Product with AI</h3>
              <p className="text-purple-700 text-sm mb-2">
                Describe the changes you'd like to make to the product. The AI will modify the existing product data based on your request.
              </p>
              <p className="text-purple-600 text-xs">
                Example: "Change the monthly premium to $450" or "Add dental coverage to the description"
              </p>
            </div>
          ) : (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
              <h3 className="text-lg font-medium text-blue-900 mb-2">How it works</h3>
              <p className="text-oe-primary-dark text-sm mb-2">
                Provide product information through text description and/or upload documents (PDFs, spreadsheets, images, etc.). 
                Our AI will analyze the content and generate a complete product configuration for you to review.
              </p>
              <p className="text-oe-primary text-xs">
                Tip: Include pricing information, coverage details, age ranges, and any special requirements.
              </p>
            </div>
          )}

          {/* Tenant Selection (SysAdmin only) */}
          {isSysAdmin && (
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select Tenant <span className="text-red-500">*</span>
              </label>
              {loadingTenants ? (
                <div className="flex items-center space-x-2 text-gray-500">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Loading tenants...</span>
                </div>
              ) : (
                <SearchableDropdown
                  options={(tenants || []).map((tenant) => ({
                    id: tenant.TenantId,
                    label: tenant.TenantName,
                    value: tenant.TenantId
                  }))}
                  value={selectedTenantId}
                  onChange={(value) => setSelectedTenantId(value)}
                  placeholder="Select a tenant"
                  searchPlaceholder="Search tenants..."
                  disabled={isGenerating}
                />
              )}
            </div>
          )}

          {/* Vendor Selection */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Vendor <span className="text-red-500">*</span>
            </label>
            {loadingVendors ? (
              <div className="flex items-center space-x-2 text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading vendors...</span>
              </div>
            ) : (
              <select
                value={selectedVendorId}
                onChange={(e) => setSelectedVendorId(e.target.value)}
                disabled={isGenerating || !!prefilledVendorId}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-100 disabled:cursor-not-allowed"
              >
                <option value="">-- Select a Vendor --</option>
                {vendors.map((vendor) => (
                  <option key={vendor.VendorId || vendor.Id} value={vendor.VendorId || vendor.Id}>
                    {vendor.VendorName || vendor.Name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Text Input */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {isEditingMode ? 'Enter Info to Edit Product' : 'Enter Product Info to Create Product'}
            </label>
            <textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              disabled={isGenerating}
              autoFocus
              placeholder={
                isEditingMode 
                  ? "Describe the changes you'd like to make... (e.g., 'Change the monthly premium to $450')"
                  : "Enter product details here... (e.g., 'Healthcare plan for employees, monthly premium $350, ages 18-65, covers medical, dental, and vision')"
              }
              className="w-full h-32 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
          </div>

          {/* File Upload Area */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Upload Documents (optional)
            </label>
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                dragActive
                  ? 'border-oe-primary bg-blue-50'
                  : 'border-gray-300 hover:border-gray-400'
              } ${isGenerating ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <input
                type="file"
                id="file-upload"
                multiple
                onChange={handleFileChange}
                disabled={isGenerating}
                className="hidden"
                accept=".pdf,.xlsx,.xls,.csv,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp,.txt"
              />
              <label
                htmlFor="file-upload"
                className={`flex flex-col items-center ${isGenerating ? 'cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <Upload className="w-12 h-12 text-gray-400 mb-3" />
                <p className="text-gray-600 font-medium mb-1">
                  Click to upload or drag and drop
                </p>
                <p className="text-gray-500 text-sm">
                  PDF, Excel, Word, Images, or Text files (Max 20 files, {MAX_DOCUMENT_UPLOAD_MB}MB each)
                </p>
              </label>
            </div>
          </div>

          {/* Uploaded Files List */}
          {files.length > 0 && (
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Uploaded Files ({files.length})
              </label>
              <div className="space-y-2">
                {files.map((fileItem, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200"
                  >
                    <div className="flex items-center space-x-3 flex-1 min-w-0">
                      <FileText className="w-5 h-5 text-gray-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {fileItem.name}
                        </p>
                        <p className="text-xs text-gray-500">
                          {formatFileSize(fileItem.size)}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => removeFile(index)}
                      disabled={isGenerating}
                      className="ml-2 text-red-600 hover:text-red-800 disabled:opacity-50"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Progress/Status */}
          {progress.stage !== 'idle' && (
            <div className="mb-6">
              {isGenerating && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <div className="flex items-center space-x-3">
                    <Loader2 className="w-5 h-5 text-oe-primary animate-spin" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-blue-900">{progress.message}</p>
                      {progress.attempt && (
                        <p className="text-xs text-oe-primary mt-1">
                          Attempt {progress.attempt} of {progress.maxAttempts || 3}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {isSuccess && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="flex items-center space-x-3">
                    <CheckCircle className="w-5 h-5 text-green-600" />
                    <p className="text-sm font-medium text-green-900">{progress.message}</p>
                  </div>
                </div>
              )}

              {isError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="flex items-start space-x-3">
                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-red-900 mb-2">{progress.message}</p>
                      
                      {progress.validationErrors && progress.validationErrors.length > 0 && (
                        <div className="mt-3 mb-3">
                          <p className="text-xs font-semibold text-red-800 mb-2">
                            Validation Errors ({progress.validationErrors.length}):
                          </p>
                          <ul className="list-disc list-inside space-y-1 max-h-40 overflow-y-auto">
                            {progress.validationErrors.map((error, index) => (
                              <li key={index} className="text-xs text-red-700">
                                {error}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      
                      <div className="mt-3">
                        <p className="text-xs text-red-600 mb-2">
                          <strong>Tip:</strong> Try providing more detailed information about the product, including:
                        </p>
                        <ul className="text-xs text-red-600 list-disc list-inside space-y-1">
                          <li>Product name and type</li>
                          <li>Pricing information (if available)</li>
                          <li>Age ranges and coverage details</li>
                          <li>Required licenses</li>
                        </ul>
                      </div>
                      
                      <button
                        onClick={handleReset}
                        className="text-xs text-red-600 hover:text-red-800 underline mt-2"
                      >
                        Try again
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          </>
          )}
        </div>

        {/* Footer - Only show when not in review mode */}
        {!showReview && (
        <div className="flex justify-between items-center p-6 border-t border-gray-200 bg-gray-50">
          <button
            onClick={handleClose}
            disabled={isGenerating}
            className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>

          <button
            onClick={handleGenerate}
            disabled={
              isGenerating || 
              isSuccess || 
              (!textInput.trim() && files.length === 0) || 
              !selectedVendorId ||
              (isSysAdmin && !selectedTenantId)
            }
            className="px-6 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{isEditingMode ? 'Updating...' : 'Generating...'}</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>{isEditingMode ? 'Update Product' : 'Generate Product'}</span>
              </>
            )}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}

