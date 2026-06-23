// frontend/src/components/pdf-signer/PDFSigningViewer.tsx
// Component for signing PDFs with signature templates

import { AlertCircle, ArrowRight, CheckCircle, Download, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';
import { apiService } from '../../services/api.service';
import SignaturePad from '../enrollment-wizard/SignaturePad';

// Set up PDF.js worker - use local worker file from public directory
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

interface SignatureField {
  TemplateId: string;
  FieldType: string;
  FieldName: string | null;
  XPosition: number;
  YPosition: number;
  Width: number;
  Height: number;
  PageNumber: number;
  IsRequired: boolean;
  AutoFillType: string | null;
  // Formatting options
  FontSize?: number;
  IsBold?: boolean;
  TextColor?: string;
  BackgroundColor?: string;
  FillBackground?: boolean;
  TextAlign?: 'left' | 'center' | 'right';
  DateFormat?: 'short' | 'medium' | 'long';
}

interface PDFSigningViewerProps {
  documentId: string;
  documentUrl: string;
  signedDocumentUrl?: string; // Pre-signed document URL to display
  autoFillData?: {
    tenantName?: string;
    agentName?: string;
    agentEmail?: string;
    memberName?: string;
    groupName?: string;
    currentDate?: string;
  };
  onSignComplete?: (signedDocumentUrl: string) => void;
  onContinue?: () => void;
  onCancel?: () => void;
  signerName?: string;
  signerEmail?: string;
  onSigningStatusChange?: (isReady: boolean) => void; // Callback when signing is ready to complete
  onApplySignaturesReady?: (applyFn: () => Promise<string | null>) => void; // Callback to expose applySignatures function
  // Controlled mode props for consent and complete signing
  hasAgreed?: boolean;
  onHasAgreedChange?: (value: boolean) => void;
  onCompleteSigning?: () => Promise<void>;
  isApplyingSignatures?: boolean;
  signingComplete?: boolean;
  // Signature state persistence
  initialSignatures?: Record<string, string>;
  onSignaturesChange?: (signatures: Record<string, string>) => void;
}

const PDFSigningViewer: React.FC<PDFSigningViewerProps> = ({
  documentId,
  documentUrl,
  signedDocumentUrl: propSignedDocumentUrl,
  autoFillData = {},
  onSignComplete,
  onContinue,
  onCancel,
  signerName = '',
  signerEmail = '',
  onSigningStatusChange,
  onApplySignaturesReady,
  hasAgreed: propHasAgreed,
  onHasAgreedChange,
  onCompleteSigning,
  isApplyingSignatures: propIsApplyingSignatures,
  signingComplete: propSigningComplete,
  initialSignatures = {},
  onSignaturesChange
}) => {
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageWidth, setPageWidth] = useState<number>(800);
  const [template, setTemplate] = useState<SignatureField[]>([]);
  const [signatures, setSignatures] = useState<Record<string, string>>(initialSignatures);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consentToElectronicSignature, setConsentToElectronicSignature] = useState(false);
  const [signedDocumentUrl, setSignedDocumentUrl] = useState<string | null>(null);
  const [activeField, setActiveField] = useState<SignatureField | null>(null);
  const [activeSignature, setActiveSignature] = useState<string>('');
  const [masterSignature, setMasterSignature] = useState<string>(''); // Store master signature for reuse
  const [highlightedField, setHighlightedField] = useState<string | null>(null); // For "Next Field" highlighting
  const [authenticatedDocumentUrl, setAuthenticatedDocumentUrl] = useState<string>(documentUrl);
  const [showSignatureModal, setShowSignatureModal] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [isPreparingDownload, setIsPreparingDownload] = useState(false);
  const [customTextValues, setCustomTextValues] = useState<Record<string, string>>({});
  const blobUrlRef = useRef<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // Helper function to load signed PDF
  const loadSignedPDF = async (signedUrl: string) => {
    if (!signedUrl) return;
    try {
      console.log('📥 Loading signed PDF from:', signedUrl);
      // Use axios params to ensure proper encoding
      const proxyUrl = `/api/document-signatures/documents/${documentId}/proxy`;
      const blob = await apiService.get<Blob>(
        proxyUrl,
        { 
          responseType: 'blob',
          params: {
            signedUrl: signedUrl
          }
        }
      );
      const blobUrl = URL.createObjectURL(blob);
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
      blobUrlRef.current = blobUrl;
      setAuthenticatedDocumentUrl(blobUrl);
      console.log('✅ Loaded signed PDF via proxy');
    } catch (proxyErr) {
      console.warn('⚠️ Proxy failed, trying direct fetch:', proxyErr);
      try {
        // Try direct fetch
        const response = await fetch(signedUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
        }
        blobUrlRef.current = blobUrl;
        setAuthenticatedDocumentUrl(blobUrl);
        console.log('✅ Loaded signed PDF directly');
      } catch (directErr) {
        console.error('❌ Failed to load signed PDF:', directErr);
        // Fallback to original
        loadAuthenticatedUrl();
      }
    }
  };

  const loadAuthenticatedUrl = async () => {
    try {
      // Always fetch PDF as blob through authenticated API to avoid CORS/auth issues
      const blob = await apiService.get<Blob>(
        `/api/document-signatures/documents/${documentId}/proxy`,
        { responseType: 'blob' }
      );
      
      // Create object URL from blob
      const blobUrl = URL.createObjectURL(blob);
      
      // Cleanup previous blob URL if exists
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
      
      blobUrlRef.current = blobUrl;
      setAuthenticatedDocumentUrl(blobUrl);
    } catch (err: any) {
      console.error('Could not load PDF:', err);
      setError(err.message || 'Failed to load PDF document');
      // Fallback to original URL if available
      if (documentUrl) {
        setAuthenticatedDocumentUrl(documentUrl);
      }
    }
  };

  const loadTemplate = async () => {
    try {
      setLoading(true);
      const response = await apiService.get<{
        success: boolean;
        data: SignatureField[];
      }>(`/api/document-signatures/templates/${documentId}`);

      if (response.success && response.data) {
        console.log('📋 Template loaded:', response.data.length, 'fields');
        // Log formatting fields for debugging
        response.data.forEach((field: any, index: number) => {
          if (field.FieldType === 'text' || field.FieldType === 'date') {
            console.log(`  Field ${index + 1} (${field.FieldType}):`, {
              FontSize: field.FontSize,
              IsBold: field.IsBold,
              TextColor: field.TextColor,
              BackgroundColor: field.BackgroundColor,
              FillBackground: field.FillBackground,
              TextAlign: field.TextAlign,
              DateFormat: field.DateFormat
            });
          }
        });
        setTemplate(response.data);
      }
    } catch (err: any) {
      console.error('Error loading template:', err);
      setError(err.message || 'Failed to load signature template');
    } finally {
      setLoading(false);
    }
  };

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  // Load template and get authenticated document URL
  useEffect(() => {
    loadTemplate();
    
    // If a signed document URL is provided, load that instead of the original
    if (propSignedDocumentUrl) {
      console.log('📥 Loading pre-signed document:', propSignedDocumentUrl);
      loadSignedPDF(propSignedDocumentUrl);
      setSignedDocumentUrl(propSignedDocumentUrl);
    } else {
      // Load original document
      loadAuthenticatedUrl();
    }
    
    // Cleanup blob URL on unmount
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, [documentId, propSignedDocumentUrl]);

  // Update page width on resize
  useEffect(() => {
    const updatePageWidth = () => {
      if (pageRef.current) {
        const containerWidth = pageRef.current.clientWidth;
        setPageWidth(Math.min(containerWidth - 32, 800)); // Account for padding
      }
    };

    updatePageWidth();
    window.addEventListener('resize', updatePageWidth);
    return () => window.removeEventListener('resize', updatePageWidth);
  }, []);

  const getNextIncompleteField = (): SignatureField | null => {
    // Get all required signature/initial fields that need user input
    const incompleteFields = template.filter(f => {
      return (f.FieldType === 'signature' || f.FieldType === 'initial') && f.IsRequired && !signatures[f.TemplateId];
    });

    if (incompleteFields.length === 0) return null;

    // Sort by page number, then by position (top to bottom, left to right)
    incompleteFields.sort((a, b) => {
      if (a.PageNumber !== b.PageNumber) {
        return a.PageNumber - b.PageNumber;
      }
      // Sort by Y position (bottom to top), then X position (left to right)
      if (Math.abs(a.YPosition - b.YPosition) > 0.01) {
        return b.YPosition - a.YPosition; // Higher Y = lower on page
      }
      return a.XPosition - b.XPosition;
    });

    return incompleteFields[0] || null;
  };

  const handleNextField = () => {
    const nextField = getNextIncompleteField();
    if (nextField) {
      setCurrentPage(nextField.PageNumber);
      setHighlightedField(nextField.TemplateId);
      // Instantly scroll to field
      setTimeout(() => {
        const fieldElement = document.querySelector(`[data-field-id="${nextField.TemplateId}"]`);
        if (fieldElement) {
          fieldElement.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
        // Remove highlight after 3 seconds
        setTimeout(() => setHighlightedField(null), 3000);
      }, 50);
    }
  };


  const handleSignatureChange = (signature: string | null) => {
    if (activeField) {
      const signatureValue = signature || '';
      setActiveSignature(signatureValue);
      // Store as master signature if this is the first signature
      if (!masterSignature && signatureValue) {
        setMasterSignature(signatureValue);
      }
    }
  };

  const handleSignatureComplete = () => {
    if (activeField && activeSignature) {
      // Save signature to the active field
      const updatedSignatures = {
        ...signatures,
        [activeField.TemplateId]: activeSignature
      };
      setSignatures(updatedSignatures);
      
      // Store as master signature for reuse
      if (!masterSignature) {
        setMasterSignature(activeSignature);
      }
    }
    setShowSignatureModal(false);
    setActiveField(null);
    setActiveSignature('');
    setHighlightedField(null);

    // Automatically jump to next field if there is one
    setTimeout(() => {
      const nextField = getNextIncompleteField();
      if (nextField) {
        handleNextField();
      }
    }, 100);
  };

  const handlePasteSignature = (field: SignatureField) => {
    if (masterSignature) {
      const updatedSignatures = {
        ...signatures,
        [field.TemplateId]: masterSignature
      };
      setSignatures(updatedSignatures);
      onSignaturesChange?.(updatedSignatures);
      setHighlightedField(null);
      
      // Automatically jump to next field if there is one
      setTimeout(() => {
        const nextField = getNextIncompleteField();
        if (nextField) {
          handleNextField();
        }
      }, 100);
    }
  };

  const handleNewSignature = (field: SignatureField) => {
    setActiveField(field);
    setActiveSignature(signatures[field.TemplateId] || '');
    setShowSignatureModal(true);
    if (field.PageNumber !== currentPage) {
      setCurrentPage(field.PageNumber);
    }
  };

  // Sync signatures with initialSignatures prop when component mounts or prop changes
  // Only restore after template is loaded so we can properly validate
  useEffect(() => {
    // Only restore if we have initialSignatures and template is loaded
    if (Object.keys(initialSignatures).length > 0 && template.length > 0) {
      const currentKeys = Object.keys(signatures).sort().join(',');
      const initialKeys = Object.keys(initialSignatures).sort().join(',');
      const hasChanges = currentKeys !== initialKeys || 
        Object.keys(initialSignatures).some(key => signatures[key] !== initialSignatures[key]);
      
      if (hasChanges) {
        console.log('📥 Restoring signatures from parent:', Object.keys(initialSignatures).length, 'signatures', 'Template fields:', template.length);
        // Replace signatures with initialSignatures (parent is source of truth)
        setSignatures(initialSignatures);
      }
    } else if (Object.keys(initialSignatures).length > 0 && template.length === 0) {
      // Template not loaded yet, but we have signatures to restore - will restore once template loads
      console.log('📥 Waiting for template to load before restoring signatures');
    }
  }, [initialSignatures, template]);

  // Track signing ready state for controlled mode
  const [isSigningReadyInternal, setIsSigningReadyInternal] = useState(false);
  
  // Notify parent when signing is ready (all fields complete)
  // Note: In controlled mode (onApplySignaturesReady provided), consent is managed by parent
  useEffect(() => {
    if (!onSigningStatusChange) return;
    
    const requiredFields = template.filter(f => f.IsRequired);
    const allComplete = requiredFields.every(f => {
      if (f.FieldType === 'signature' || f.FieldType === 'initial') {
        return !!signatures[f.TemplateId];
      }
      return true; // Auto-filled fields are always complete
    });
    
    // In controlled mode, only check if all fields are complete (parent handles consent and signedDocumentUrl)
    // In non-controlled mode, check allComplete, consent, and ensure document hasn't been signed yet
    let isReady = false;
    if (onApplySignaturesReady) {
      // Controlled mode: only check if all fields are complete
      isReady = allComplete && template.length > 0;
    } else {
      // Non-controlled mode: check allComplete, consent, and no signed document yet
      isReady = allComplete && consentToElectronicSignature && !signedDocumentUrl && template.length > 0;
    }
    
    setIsSigningReadyInternal(isReady);
    
    console.log('🔍 Signing ready check:', {
      allComplete,
      hasOnApplySignaturesReady: !!onApplySignaturesReady,
      consentToElectronicSignature,
      hasSignedDocumentUrl: !!signedDocumentUrl,
      templateLength: template.length,
      isReady,
      signatureCount: Object.keys(signatures).length,
      requiredFieldsCount: template.filter(f => f.IsRequired && (f.FieldType === 'signature' || f.FieldType === 'initial')).length
    });
    
    onSigningStatusChange(isReady);
  }, [signatures, consentToElectronicSignature, template.length, signedDocumentUrl, onSigningStatusChange, onApplySignaturesReady]);

  // Expose applySignatures function to parent
  const applySignaturesInternal = async (): Promise<string | null> => {
    if (signedDocumentUrl) {
      console.log('✅ Document already signed, returning existing URL');
      return signedDocumentUrl;
    }

    try {
      setSigning(true);
      setError(null);

      // Prepare signature data
      const signatureData: Record<string, string> = {};
      template.forEach(field => {
        if (field.FieldType === 'signature' || field.FieldType === 'initial') {
          const sig = signatures[field.TemplateId];
          if (sig) {
            signatureData[field.FieldName || field.TemplateId] = sig;
            signatureData[field.TemplateId] = sig; // Also key by template ID
          }
        }
      });

      // Prepare auto-fill data
      const now = new Date();
      const fillData: Record<string, string> = {
        tenantName: autoFillData.tenantName || '',
        agentName: autoFillData.agentName || '',
        agentEmail: autoFillData.agentEmail || '',
        memberName: autoFillData.memberName || '',
        groupName: autoFillData.groupName || '',
        currentDate: autoFillData.currentDate || `${now.getUTCMonth() + 1}/${now.getUTCDate()}/${now.getUTCFullYear()}`
      };
      
      // Add custom text values
      Object.keys(customTextValues).forEach(fieldId => {
        if (customTextValues[fieldId]) {
          fillData[fieldId] = customTextValues[fieldId];
        }
      });
      
      console.log('🚀 ========== APPLYING SIGNATURES ==========');
      console.log('📝 Document ID:', documentId);
      console.log('📝 Signature count:', Object.keys(signatureData).length);

      const response = await apiService.post<{
        success: boolean;
        data: {
          signedDocumentUrl: string;
          documentId: string;
        };
      }>('/api/document-signatures/apply', {
        documentId,
        signatureData,
        autoFillData: fillData,
        consentToElectronicSignature: true,
        ipAddress: '',
        userAgent: navigator.userAgent,
        signedDate: new Date().toISOString()
      });

      if (response.success && response.data) {
        console.log('✅ Signatures applied successfully');
        setSignedDocumentUrl(response.data.signedDocumentUrl);
        
        // Reload the PDF to show signed version
        try {
          const proxyUrl = `/api/document-signatures/documents/${documentId}/proxy`;
          const blob = await apiService.get<Blob>(
            proxyUrl,
            { 
              responseType: 'blob',
              params: {
                signedUrl: response.data.signedDocumentUrl
              }
            }
          );
          const blobUrl = URL.createObjectURL(blob);
          if (blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current);
          }
          blobUrlRef.current = blobUrl;
          setAuthenticatedDocumentUrl(blobUrl);
        } catch (blobErr) {
          console.error('❌ Error reloading signed PDF:', blobErr);
          setAuthenticatedDocumentUrl(response.data.signedDocumentUrl);
        }
        
        return response.data.signedDocumentUrl;
      } else {
        throw new Error('Failed to sign document');
      }
    } catch (err: any) {
      console.error('❌ Error applying signatures:', err);
      setError(err.message || 'Failed to sign document');
      return null;
    } finally {
      setSigning(false);
    }
  };

  // Expose applySignatures function to parent
  useEffect(() => {
    if (onApplySignaturesReady) {
      onApplySignaturesReady(applySignaturesInternal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onApplySignaturesReady, template, signatures, customTextValues, documentId, autoFillData]);

  const [hoveredField, setHoveredField] = useState<string | null>(null);

  // Shared function to download/open signed PDF
  const handleDownloadSignedPDF = async () => {
    try {
      console.log('📥 ========== DOWNLOAD BUTTON CLICKED ==========');
      console.log('📥 signedDocumentUrl exists:', !!signedDocumentUrl);
      if (!signedDocumentUrl) {
        console.error('❌ No signed document URL available!');
        setError('Signed document URL is missing. Please wait for the document to be processed.');
        return;
      }
      console.log('📥 Full signedDocumentUrl:', signedDocumentUrl);
      console.log('📥 signedDocumentUrl length:', signedDocumentUrl.length);
      console.log('📥 Opening signed document URL directly in new tab...');
      
      // Open the signed document URL directly instead of using proxy
      // This avoids query parameter parsing issues and ensures we get the correct signed document
      window.open(signedDocumentUrl, '_blank');
      console.log('✅ Opened signed document URL in new tab');
    } catch (err) {
      console.error('❌ Error opening document:', err);
      setError('Failed to open document. Please try again.');
    }
  };

  const renderField = (field: SignatureField) => {
    const left = field.XPosition * 100;
    const bottom = field.YPosition * 100;
    const width = field.Width * 100;
    const height = field.Height * 100;

    const isSigned = field.FieldType === 'signature' || field.FieldType === 'initial'
      ? !!signatures[field.TemplateId]
      : true; // Auto-filled fields are always "signed"

    const isActive = activeField?.TemplateId === field.TemplateId;
    const isHighlighted = highlightedField === field.TemplateId;
    const isHovered = hoveredField === field.TemplateId;
    const isSignatureField = field.FieldType === 'signature' || field.FieldType === 'initial';

    return (
      <div
        key={field.TemplateId}
        data-field-id={field.TemplateId}
        className={`absolute border-2 ${
          isSigned
            ? 'border-oe-success bg-green-50 bg-opacity-30'
            : isHighlighted
            ? 'border-oe-primary bg-oe-primary-light bg-opacity-70 ring-4 ring-oe-primary ring-opacity-50'
            : isActive
            ? 'border-oe-primary bg-oe-primary-light bg-opacity-50'
            : 'border-oe-warning bg-yellow-50 bg-opacity-30'
        } ${isSignatureField ? 'cursor-pointer hover:border-oe-primary' : ''}`}
        style={{
          left: `${left}%`,
          bottom: `${bottom}%`,
          width: `${width}%`,
          height: `${height}%`,
          transition: isHighlighted ? 'all 0.3s ease' : 'none'
        }}
        onMouseEnter={() => isSignatureField && setHoveredField(field.TemplateId)}
        onMouseLeave={() => setHoveredField(null)}
        onClick={() => {
          if (isSignatureField) {
            handleNewSignature(field);
          }
        }}
      >
        {isHovered && isSignatureField && (
          <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-95 z-10 border-2 border-oe-primary rounded">
            <div className="flex gap-2">
              {!isSigned && masterSignature && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePasteSignature(field);
                  }}
                  className="px-3 py-1.5 bg-oe-primary text-white text-xs font-medium rounded hover:bg-oe-primary-dark"
                >
                  Paste Signature
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleNewSignature(field);
                }}
                className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-xs font-medium rounded hover:bg-gray-50"
              >
                {isSigned ? 'Edit Signature' : 'New Signature'}
              </button>
            </div>
          </div>
        )}
        {isSigned && isSignatureField && signatures[field.TemplateId] && (
          <div className="absolute inset-0 flex items-center justify-center p-1">
            {signatures[field.TemplateId].startsWith('data:image') ? (
              <img
                src={signatures[field.TemplateId]}
                alt="Signature"
                className="max-w-full max-h-full object-contain"
                style={{ imageRendering: 'auto' }}
              />
            ) : (
              <span className="text-xs font-medium text-gray-700">{signatures[field.TemplateId]}</span>
            )}
          </div>
        )}
        {/* Background fill for text/date fields */}
        {(field.FieldType === 'text' || field.FieldType === 'date') && field.FillBackground && (
          <div 
            className="absolute inset-0"
            style={{
              backgroundColor: field.BackgroundColor || '#FFFFFF',
              opacity: 1
            }}
          />
        )}
        
        {field.FieldType === 'text' && field.AutoFillType && field.AutoFillType !== 'CustomText' && (
          <div 
            className="absolute inset-0 flex px-1"
            style={{
              fontSize: field.FontSize ? `${field.FontSize}pt` : '12pt',
              fontWeight: field.IsBold ? 'bold' : 'normal',
              color: field.TextColor || '#000000',
              alignItems: 'start',
              justifyContent: field.TextAlign === 'center' ? 'center' : field.TextAlign === 'right' ? 'flex-end' : 'flex-start',
              textAlign: field.TextAlign || 'left'
            }}
          >
            {field.AutoFillType === 'TenantName' && (autoFillData.tenantName || '')}
            {field.AutoFillType === 'AgentName' && (autoFillData.agentName || '')}
            {field.AutoFillType === 'AgentEmail' && (autoFillData.agentEmail || '')}
            {field.AutoFillType === 'MemberName' && (autoFillData.memberName || '')}
            {field.AutoFillType === 'GroupName' && (autoFillData.groupName || '')}
          </div>
        )}
        {field.FieldType === 'text' && field.AutoFillType === 'CustomText' && (
          <input
            type="text"
            value={customTextValues[field.TemplateId] || ''}
            onChange={(e) => {
              setCustomTextValues(prev => ({
                ...prev,
                [field.TemplateId]: e.target.value
              }));
            }}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.stopPropagation()}
            className="absolute inset-0 w-full h-full px-1 border-0 focus:outline-none focus:ring-2 focus:ring-oe-primary"
            style={{
              fontSize: field.FontSize ? `${field.FontSize}pt` : '12pt',
              fontWeight: field.IsBold ? 'bold' : 'normal',
              color: field.TextColor || '#000000',
              backgroundColor: field.FillBackground ? (field.BackgroundColor || '#FFFFFF') : 'transparent',
              textAlign: field.TextAlign || 'left'
            }}
            placeholder="Enter text..."
          />
        )}
        {field.FieldType === 'date' && (
          <div 
            className="absolute inset-0 flex px-1"
            style={{
              fontSize: field.FontSize ? `${field.FontSize}pt` : '12pt',
              fontWeight: field.IsBold ? 'bold' : 'normal',
              color: field.TextColor || '#000000',
              alignItems: 'start',
              justifyContent: field.TextAlign === 'center' ? 'center' : field.TextAlign === 'right' ? 'flex-end' : 'flex-start',
              textAlign: field.TextAlign || 'left'
            }}
          >
            {field.AutoFillType === 'CurrentDate' && (() => {
              // Format date based on DateFormat setting
              let dateObj: Date;
              if (autoFillData.currentDate) {
                const dateStr = autoFillData.currentDate;
                if (dateStr.includes('T')) {
                  const [y, m, d] = dateStr.split('T')[0].split('-');
                  dateObj = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
                } else {
                  dateObj = new Date(dateStr);
                }
              } else {
                dateObj = new Date();
              }
              
              const dateFormat = field.DateFormat || 'medium';
              const month = dateObj.getMonth() + 1;
              const day = dateObj.getDate();
              const year = dateObj.getFullYear();
              const shortYear = year.toString().slice(-2);
              
              const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                                 'July', 'August', 'September', 'October', 'November', 'December'];
              const monthAbbrev = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
              
              switch (dateFormat.toLowerCase()) {
                case 'short':
                  return `${month}/${day}/${shortYear}`;
                case 'medium':
                  return `${monthAbbrev[month - 1]} ${day}, ${year}`;
                case 'long':
                  return `${monthNames[month - 1]} ${day}, ${year}`;
                default:
                  return `${monthAbbrev[month - 1]} ${day}, ${year}`;
              }
            })()}
            {field.AutoFillType === 'FirstOfMonth' && (() => {
              // Calculate next 1st of month
              const now = new Date();
              const nextFirst = new Date(now.getFullYear(), now.getMonth() + 1, 1);
              const dateFormat = field.DateFormat || 'medium';
              const month = nextFirst.getMonth() + 1;
              const day = nextFirst.getDate();
              const year = nextFirst.getFullYear();
              const shortYear = year.toString().slice(-2);
              
              const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                                 'July', 'August', 'September', 'October', 'November', 'December'];
              const monthAbbrev = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
              
              switch (dateFormat.toLowerCase()) {
                case 'short':
                  return `${month}/${day}/${shortYear}`;
                case 'medium':
                  return `${monthAbbrev[month - 1]} ${day}, ${year}`;
                case 'long':
                  return `${monthNames[month - 1]} ${day}, ${year}`;
                default:
                  return `${monthAbbrev[month - 1]} ${day}, ${year}`;
              }
            })()}
            {field.AutoFillType === 'UserEnteredDate' && ''}
            {!field.AutoFillType && ''}
          </div>
        )}
        {!field.AutoFillType && field.FieldType === 'text' && (
          <div 
            className="absolute inset-0 flex px-1"
            style={{
              fontSize: field.FontSize ? `${field.FontSize}pt` : '12pt',
              fontWeight: field.IsBold ? 'bold' : 'normal',
              color: field.TextColor || '#9CA3AF',
              alignItems: 'start',
              justifyContent: field.TextAlign === 'center' ? 'center' : field.TextAlign === 'right' ? 'flex-end' : 'flex-start',
              textAlign: field.TextAlign || 'left'
            }}
          >
            {field.FieldName || ''}
          </div>
        )}
      </div>
    );
  };

  // Only count signature/initial fields that require user input
  const userInputFields = template.filter(f => 
    (f.FieldType === 'signature' || f.FieldType === 'initial') && f.IsRequired
  );
  const completedUserFields = userInputFields.filter(f => !!signatures[f.TemplateId]);

  const nextField = getNextIncompleteField();

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-6">
      <div className="mb-4 md:mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className={`text-sm font-medium px-3 py-1 rounded-full ${
              completedUserFields.length === userInputFields.length
                ? 'bg-oe-success text-white'
                : 'bg-oe-warning text-yellow-900'
            }`}>
              {completedUserFields.length}/{userInputFields.length} complete
            </span>
            {numPages > 1 && (
              <select
                value={currentPage}
                onChange={(e) => {
                  const pageNum = parseInt(e.target.value);
                  setCurrentPage(pageNum);
                  // Instantly scroll to the selected page
                  const pageElement = pageRefs.current[pageNum];
                  if (pageElement && containerRef.current) {
                    pageElement.scrollIntoView({ behavior: 'auto', block: 'start' });
                  }
                }}
                className="px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
              >
                {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                  <option key={pageNum} value={pageNum}>
                    Page {pageNum} of {numPages}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Show Next Field button when document is not signed yet */}
            {!signedDocumentUrl && !propSignedDocumentUrl && getNextIncompleteField() && (
              <button
                onClick={handleNextField}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark flex items-center justify-center gap-2 whitespace-nowrap"
              >
                Next Field
                <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-4 alert alert-error flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-oe-error" />
          <span className="text-oe-error">{error}</span>
        </div>
      )}

      {/* PDF Viewer - Full Width */}
      <div className="bg-gray-100 rounded-lg p-2 md:p-4 overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center h-96">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
          </div>
        ) : (
          <div className="flex flex-col items-center">
            {/* PDF Document - Scrollable Container with All Pages */}
            <div 
              ref={containerRef}
              className="w-full overflow-auto max-h-[70vh]"
              style={{ scrollBehavior: 'auto' }}
            >
                  <Document
                    key={authenticatedDocumentUrl} // Force re-render when URL changes
                    file={authenticatedDocumentUrl}
                onLoadSuccess={onDocumentLoadSuccess}
                loading={
                  <div className="flex items-center justify-center h-96">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
                  </div>
                }
                error={
                  <div className="flex flex-col items-center justify-center h-96 p-4">
                    <AlertCircle className="h-12 w-12 text-oe-error mb-4" />
                    <p className="text-oe-error mb-2 font-medium">Failed to load PDF</p>
                    <p className="text-sm text-gray-600 text-center">
                      {error || 'Please check that the document URL is valid and accessible.'}
                    </p>
                  </div>
                }
              >
                {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                  <div
                    key={pageNum}
                    ref={(el) => {
                      if (pageNum === 1) pageRef.current = el;
                      pageRefs.current[pageNum] = el;
                    }}
                    data-page-number={pageNum}
                    className="relative bg-white shadow-lg mx-auto mb-4"
                    style={{ 
                      minWidth: '100%',
                      maxWidth: '100%',
                      width: '100%'
                    }}
                  >
                    <Page
                      pageNumber={pageNum}
                      width={Math.min(pageWidth, containerRef.current?.clientWidth || 800)}
                      renderTextLayer={false}
                      renderAnnotationLayer={false}
                    />
                    {/* Render Fields for this page */}
                    {template.filter(f => f.PageNumber === pageNum).map(field => renderField(field))}
                  </div>
                ))}
              </Document>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Action Bar - Controlled mode (consent and complete button inside container) */}
      {onApplySignaturesReady && (
        <div className="mt-4 md:mt-6 space-y-4 border-t border-gray-200 pt-4">
          {/* Consent Checkbox */}
          <div>
            <label className="flex items-start cursor-pointer">
              <input
                type="checkbox"
                checked={propHasAgreed || false}
                onChange={(e) => onHasAgreedChange?.(e.target.checked)}
                disabled={propIsApplyingSignatures || propSigningComplete}
                className="mt-1 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
              />
              <span className="ml-3 text-sm text-gray-700">
                I consent to use electronic signatures and understand that my electronic signature
                has the same legal effect as a handwritten signature.
              </span>
            </label>
          </div>
          
          {/* Complete Signing Button */}
          <div className="flex justify-center">
            <button
              onClick={onCompleteSigning}
              disabled={!isSigningReadyInternal || !propHasAgreed || propIsApplyingSignatures || propSigningComplete}
              className={`px-8 py-3 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-medium ${
                propSigningComplete
                  ? 'bg-green-600 text-white hover:bg-green-700'
                  : 'bg-yellow-500 text-white hover:bg-yellow-600'
              }`}
            >
              {propIsApplyingSignatures ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  Saving signed document...
                </>
              ) : propSigningComplete ? (
                <>
                  <CheckCircle className="h-4 w-4" />
                  Signing Complete!
                </>
              ) : (
                'Complete Signing'
              )}
            </button>
          </div>
        </div>
      )}
      
      {/* Bottom Action Bar - Non-controlled mode */}
      {!onApplySignaturesReady && (
        <div className="mt-4 md:mt-6 space-y-4">
          {/* ESIGN Consent */}
          <div className="bg-oe-primary-light border border-oe-primary rounded-lg p-4">
            <label className="flex items-start cursor-pointer">
              <input
                type="checkbox"
                checked={consentToElectronicSignature}
                onChange={(e) => setConsentToElectronicSignature(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
              />
              <span className="ml-3 text-sm text-gray-700">
                I consent to use electronic signatures and understand that my electronic signature
                has the same legal effect as a handwritten signature.
              </span>
            </label>
          </div>

          {/* Continue Button - Only show when document is signed (for non-controlled mode) */}
          {completedUserFields.length === userInputFields.length && signedDocumentUrl && onContinue && (
            <div className="flex justify-end">
              <button
                onClick={() => {
                  if (onContinue) {
                    onContinue();
                  }
                }}
                className="px-6 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark flex items-center justify-center gap-2"
              >
                Continue
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Download Modal */}
      {showDownloadModal && signedDocumentUrl && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[10050] p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full">
            <div className="text-center">
              {isPreparingDownload ? (
                <>
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">Signing Complete</h3>
                  <p className="text-sm text-gray-600">Preparing your signed document...</p>
                </>
              ) : (
                <>
                  <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-oe-success/10 mb-4">
                    <CheckCircle className="h-6 w-6 text-oe-success" />
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">Download Signed Agreement</h3>
                  <p className="text-sm text-gray-600 mb-6">This document will also be available in your portal.</p>
                  <div className="space-y-3">
                    <button
                      onClick={handleDownloadSignedPDF}
                      className="w-full px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark flex items-center justify-center gap-2"
                    >
                      <Download className="h-4 w-4" />
                      Download Signed Agreement
                    </button>
                    {onContinue && (
                      <button
                        onClick={() => {
                          setShowDownloadModal(false);
                          onContinue();
                        }}
                        className="w-full px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                      >
                        Continue
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Signature Modal */}
      {showSignatureModal && activeField && (activeField.FieldType === 'signature' || activeField.FieldType === 'initial') && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[10050] p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">
                {activeField.FieldName || `${activeField.FieldType.charAt(0).toUpperCase() + activeField.FieldType.slice(1)}`}
              </h3>
              <button
                onClick={handleSignatureComplete}
                className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <SignaturePad
              onSignatureChange={handleSignatureChange}
              isRequired={activeField.IsRequired}
              label={activeField.FieldName || `${activeField.FieldType.charAt(0).toUpperCase() + activeField.FieldType.slice(1)}`}
            />
            <div className="mt-4 flex gap-2">
              <button
                onClick={handleSignatureComplete}
                disabled={!activeSignature}
                className="flex-1 px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {activeSignature ? 'Add Signature' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PDFSigningViewer;

