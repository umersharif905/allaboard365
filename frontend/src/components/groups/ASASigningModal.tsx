import { ArrowRight, CheckCircle, Download, FileText, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUserProfile } from '../../hooks/useUserProfile';
import { apiService } from '../../services/api.service';
import { GroupASASigningService } from '../../services/group-asa-signing.service';
import PDFSigningViewer from '../pdf-signer/PDFSigningViewer';
import SignaturePad from '../enrollment-wizard/SignaturePad';

interface ASASigningModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  groupId: string;
  productId: string;
  productName: string;
  asaAgreement: {
    documentId: string;
    documentName: string;
    documentUrl: string;
  };
  groupName?: string;
  tenantName?: string;
  agentName?: string;
  agentEmail?: string;
}

const ASASigningModal: React.FC<ASASigningModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  groupId,
  productId,
  productName,
  asaAgreement,
  groupName,
  tenantName,
  agentName,
  agentEmail
}) => {
  const queryClient = useQueryClient();
  const [digitalSignature, setDigitalSignature] = useState<string>('');
  const [hasAgreed, setHasAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [signedDocumentUrl, setSignedDocumentUrl] = useState<string | null>(null);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [showSignedDocumentModal, setShowSignedDocumentModal] = useState(false);
  const [hasTemplate, setHasTemplate] = useState(false);
  const [checkingTemplate, setCheckingTemplate] = useState(false);
  const [isDocumentSaved, setIsDocumentSaved] = useState(false);
  const [isSigningReady, setIsSigningReady] = useState(false);
  const [isApplyingSignatures, setIsApplyingSignatures] = useState(false);
  const [signingComplete, setSigningComplete] = useState(false);
  const [signatures, setSignatures] = useState<Record<string, string>>({});
  const applySignaturesRef = useRef<(() => Promise<string | null>) | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  
  const userHandler = useUserProfile();
  const user = userHandler.data;

  const optimisticallyMarkDocumentSigned = (params: {
    documentId: string;
    signatureInfo?: {
      signedAgreementId?: string;
      signedByEmail?: string;
      signedByName?: string;
      signedDate?: string;
      status?: string;
      signedDocumentUrl?: string;
    };
  }) => {
    const { documentId, signatureInfo } = params;
    if (!documentId) return;

    queryClient.setQueryData(['groupASAStatus', groupId], (oldData: any) => {
      if (!oldData || !oldData.products) return oldData;

      const patchItem = (item: any) => {
        const itemDocId = item?.asaAgreement?.documentId;
        if (itemDocId && itemDocId === documentId) {
          return {
            ...item,
            isSigned: true,
            signatureInfo: {
              ...(item.signatureInfo || {}),
              ...(signatureInfo || {}),
              status: (signatureInfo?.status || item?.signatureInfo?.status || 'Completed')
            }
          };
        }
        return item;
      };

      const patchedProducts = oldData.products.map((p: any) => {
        const patched = patchItem(p);
        if (patched?.isBundle && Array.isArray(patched.bundleProducts)) {
          return {
            ...patched,
            bundleProducts: patched.bundleProducts.map((bp: any) => patchItem(bp))
          };
        }
        return patched;
      });

      // Recompute summary using unique documentIds (matches backend behavior)
      const requiredDocIds = new Set<string>();
      const signedDocIds = new Set<string>();
      const collect = (item: any) => {
        if (!item?.requiresASA) return;
        const docId = item?.asaAgreement?.documentId;
        if (!docId) return;
        requiredDocIds.add(docId);
        if (item?.isSigned) signedDocIds.add(docId);
      };
      patchedProducts.forEach((p: any) => {
        collect(p);
        if (p?.isBundle && Array.isArray(p.bundleProducts)) {
          p.bundleProducts.forEach((bp: any) => collect(bp));
        }
      });

      const productsRequiringASA = requiredDocIds.size;
      const signedASAAgreements = signedDocIds.size;
      const pendingASAAgreements = Math.max(0, productsRequiringASA - signedASAAgreements);

      return {
        ...oldData,
        products: patchedProducts,
        summary: {
          ...(oldData.summary || {}),
          productsRequiringASA,
          signedASAAgreements,
          pendingASAAgreements,
          asaCompletionPercentage: productsRequiringASA > 0
            ? Math.round((signedASAAgreements / productsRequiringASA) * 100)
            : 100
        }
      };
    });
  };

  // Check if document has a signature template
  useEffect(() => {
    const checkTemplate = async () => {
      if (!isOpen || !asaAgreement?.documentId) {
        setCheckingTemplate(false);
        return;
      }

      try {
        setCheckingTemplate(true);
        // Use a timeout to prevent hanging
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Template check timeout')), 5000)
        );
        
        const responsePromise = apiService.get<{
          success: boolean;
          data: Array<any>;
        }>(`/api/document-signatures/templates/${asaAgreement.documentId}`);

        const response = await Promise.race([responsePromise, timeoutPromise]) as {
          success: boolean;
          data: Array<any>;
        };

        if (response.success && response.data && response.data.length > 0) {
          setHasTemplate(true);
        }
      } catch (err) {
        // Template doesn't exist, timeout, or error - use basic signing
        console.log('No signature template found or timeout, using basic signing:', err);
        setHasTemplate(false);
      } finally {
        setCheckingTemplate(false);
      }
    };

    if (isOpen) {
      checkTemplate();
    }
  }, [isOpen, asaAgreement?.documentId]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setDigitalSignature('');
      setHasAgreed(false);
      setError(null);
      setSignedDocumentUrl(null);
      setShowDownloadModal(false);
      setShowSignedDocumentModal(false);
      setIsDocumentSaved(false);
      setIsSigningReady(false);
      setIsApplyingSignatures(false);
      setSigningComplete(false);
      setSignatures({});
      applySignaturesRef.current = null;
      savePromiseRef.current = null;
    }
  }, [isOpen]);

  const handleSignatureChange = (signature: string | null) => {
    setDigitalSignature(signature || '');
    setError(null);
  };

  const handleAgreementChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setHasAgreed(e.target.checked);
    setError(null);
  };

  const handleCompleteSigning = async () => {
    if (!isSigningReady || isApplyingSignatures || signingComplete) return;
    
    setIsApplyingSignatures(true);
    setError(null);
    
    try {
      console.log('💾 ========== COMPLETE SIGNING CLICKED ==========');
      
      // Call applySignatures from PDFSigningViewer
      if (!applySignaturesRef.current) {
        throw new Error('Apply signatures function not available');
      }
      
      const signedUrl = await applySignaturesRef.current();
      
      if (signedUrl) {
        console.log('✅ Signatures applied, signed URL:', signedUrl);
        setSignedDocumentUrl(signedUrl);
        
        // Save to backend
        const saveSuccess = await handleTemplateSignComplete(signedUrl);
        if (saveSuccess) {
          setSigningComplete(true);
          setIsDocumentSaved(true);
          setShowSignedDocumentModal(true);
        } else {
          throw new Error('Failed to save document to backend');
        }
      } else {
        throw new Error('Failed to apply signatures');
      }
    } catch (err) {
      console.error('❌ Error completing signing:', err);
      setError(err instanceof Error ? err.message : 'Failed to complete signing');
    } finally {
      setIsApplyingSignatures(false);
    }
  };

  const handleTemplateSignComplete = async (signedDocumentUrl: string): Promise<boolean> => {
    // Prevent duplicate saves
    if (isDocumentSaved) {
      console.log('✅ Document already saved, skipping duplicate save');
      return true;
    }

    // If a save is already in progress, wait for it to complete
    if (savePromiseRef.current) {
      console.log('⏳ Save operation already in progress, waiting...');
      try {
        await savePromiseRef.current;
        return isDocumentSaved;
      } catch {
        return false;
      }
    }

    // Create the save promise and store it in the ref
    const savePromise = (async (): Promise<boolean> => {
      try {
        setIsSubmitting(true);
        setError(null);

        if (!user) {
          throw new Error('User information not available');
        }

        console.log('💾 ========== SAVING SIGNED ASA DOCUMENT ==========');
        console.log('💾 signedDocumentUrl:', signedDocumentUrl);

        // Submit to backend to save to SignedASAAgreements table
        const result = await apiService.post<{
          success: boolean;
          data?: {
            signedDocumentUrl: string;
            signedAgreementId?: string;
          };
          message?: string;
        }>('/api/groups/' + groupId + '/asa-sign', {
          groupId,
          productId,
          signatureData: 'template-based', // Indicate template-based signing
          signerName: `${user.FirstName} ${user.LastName}`.trim(),
          signerEmail: user.Email,
          signedDocumentUrl // Pass the signed document URL
        });

        if (result.success) {
          console.log('✅ Document saved successfully to backend');
          setSignedDocumentUrl(signedDocumentUrl);
          setIsDocumentSaved(true);
          // Optimistically mark ALL products that share this ASA document as signed (no refresh needed)
          optimisticallyMarkDocumentSigned({
            documentId: asaAgreement.documentId,
            signatureInfo: {
              signedAgreementId: result.data?.signedAgreementId,
              signedByEmail: user.Email,
              signedByName: `${user.FirstName} ${user.LastName}`.trim(),
              signedDate: new Date().toISOString(),
              status: 'Completed',
              signedDocumentUrl: result.data?.signedDocumentUrl || signedDocumentUrl
            }
          });
          // Trigger parent refresh immediately so the product list updates without a full page reload
          onSuccess();
          return true;
        } else {
          throw new Error(result.message || 'Failed to save signed agreement');
        }
      } catch (error) {
        console.error('❌ Error saving signed agreement:', error);
        setError(error instanceof Error ? error.message : 'Failed to save signed agreement');
        setIsDocumentSaved(false);
        return false;
      } finally {
        setIsSubmitting(false);
        savePromiseRef.current = null;
      }
    })();

    savePromiseRef.current = savePromise;
    return await savePromise;
  };

  const handleSubmit = async () => {
    if (!hasAgreed) {
      setError('You must agree to the terms and conditions to proceed.');
      return;
    }

    if (!digitalSignature) {
      setError('Please provide your digital signature.');
      return;
    }

    if (!user) {
      setError('User information not available. Please refresh the page and try again.');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);

      console.log('📝 Submitting ASA signature:', {
        groupId,
        productId,
        productName,
        signerName: `${user.FirstName} ${user.LastName}`.trim(),
        signerEmail: user.Email,
        hasSignature: !!digitalSignature,
        signatureLength: digitalSignature.length
      });

      const response = await GroupASASigningService.signASA({
        groupId,
        productId,
        signatureData: digitalSignature,
        signerName: `${user.FirstName} ${user.LastName}`.trim(),
        signerEmail: user.Email
      });

      if (response.success) {
        console.log('✅ ASA signature submitted successfully:', response.data);
        setSignedDocumentUrl(response.data.signedDocumentUrl);
        setShowDownloadModal(true);
        // Optimistically mark ALL products that share this ASA document as signed (no refresh needed)
        optimisticallyMarkDocumentSigned({
          documentId: asaAgreement.documentId,
          signatureInfo: {
            signedAgreementId: response.data.signedAgreementId,
            signedByEmail: user.Email,
            signedByName: `${user.FirstName} ${user.LastName}`.trim(),
            signedDate: response.data.signedDate,
            status: 'Completed',
            signedDocumentUrl: response.data.signedDocumentUrl
          }
        });
        // Trigger parent refresh immediately so the product list updates without a full page reload
        onSuccess();
      } else {
        throw new Error(response.message || 'Failed to sign ASA agreement');
      }

    } catch (error) {
      console.error('❌ Error submitting ASA signature:', error);
      setError(error instanceof Error ? error.message : 'Failed to sign ASA agreement. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (isSubmitting) return;
    
    // Reset form state
    setDigitalSignature('');
    setHasAgreed(false);
    setError(null);
    setSignedDocumentUrl(null);
    setShowDownloadModal(false);
    
    onClose();
  };

  const handleSuccess = () => {
    setShowDownloadModal(false);
    // Reset form state
    setDigitalSignature('');
    setHasAgreed(false);
    setError(null);
    setSignedDocumentUrl(null);
    // Call onSuccess first to trigger any refetch, then close
    onSuccess();
    onClose();
  };

  if (!isOpen) return null;

  if (checkingTemplate) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg p-6 max-w-md w-full">
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Main Modal */}
      {!showDownloadModal && !showSignedDocumentModal && (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <div className="flex items-center space-x-3">
              <FileText className="h-6 w-6 text-oe-primary" />
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Agent Service Agreement</h2>
                <p className="text-sm text-gray-600">{productName}</p>
              </div>
            </div>
            <button
              onClick={handleClose}
              disabled={isSubmitting || isApplyingSignatures}
              className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
            >
              <X className="h-6 w-6" />
            </button>
          </div>

          {/* Content */}
          <div className="p-6">
            {hasTemplate ? (
              <>
                {/* Use PDFSigningViewer for template-based signing */}
                <PDFSigningViewer
                  documentId={asaAgreement.documentId}
                  documentUrl={asaAgreement.documentUrl}
                  signedDocumentUrl={signedDocumentUrl || undefined}
                  initialSignatures={signatures}
                  onSignaturesChange={setSignatures}
                  autoFillData={{
                    groupName: groupName || (user ? `${user.FirstName} ${user.LastName}`.trim() : ''),
                    tenantName: tenantName || '',
                    agentName: agentName || '',
                    agentEmail: agentEmail || '',
                    currentDate: (() => {
                      const now = new Date();
                      const [y, m, d] = now.toISOString().split('T')[0].split('-');
                      const date = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
                      return date.toLocaleDateString();
                    })()
                  }}
                  onSigningStatusChange={(isReady) => {
                    setIsSigningReady(isReady);
                  }}
                  onApplySignaturesReady={(applyFn) => {
                    applySignaturesRef.current = applyFn;
                  }}
                  hasAgreed={hasAgreed}
                  onHasAgreedChange={(value) => {
                    setHasAgreed(value);
                  }}
                  onCompleteSigning={handleCompleteSigning}
                  isApplyingSignatures={isApplyingSignatures}
                  signingComplete={signingComplete || !!signedDocumentUrl}
                  signerName={user ? `${user.FirstName} ${user.LastName}`.trim() : ''}
                  signerEmail={user?.Email || ''}
                />
                
                {/* Show Continue and Download buttons if document is already signed */}
                {(signedDocumentUrl || isDocumentSaved) && (
                  <div className="mt-6 flex justify-between items-center">
                    {signedDocumentUrl && (
                      <button
                        onClick={() => {
                          window.open(signedDocumentUrl, '_blank');
                        }}
                        className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 flex items-center justify-center gap-2"
                      >
                        <Download className="h-4 w-4" />
                        Download
                      </button>
                    )}
                    <button
                      onClick={() => {
                        handleSuccess();
                      }}
                      className={`px-6 py-3 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark flex items-center justify-center gap-2 ${signedDocumentUrl ? '' : 'ml-auto'}`}
                    >
                      Continue
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Use basic signature pad for documents without templates */}
                <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Document: {asaAgreement.documentName}</h3>
                    <a
                      href={asaAgreement.documentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bg-oe-primary text-white px-4 py-2 rounded-lg hover:bg-oe-primary-dark transition-colors"
                    >
                      View Document
                    </a>
                  </div>
                  
                  {/* Agreement Checkbox - Required */}
                  <div className="mb-6 p-4 bg-blue-50 border-2 border-blue-200 rounded-lg">
                    <label className="flex items-start space-x-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={hasAgreed}
                        onChange={handleAgreementChange}
                        disabled={isSubmitting}
                        className="mt-1 h-5 w-5 text-oe-primary focus:ring-oe-primary border-gray-300 rounded disabled:opacity-50"
                        required
                      />
                      <div className="flex-1">
                        <div className="flex items-center mb-1">
                          <span className="text-base font-semibold text-gray-900">
                            I agree to the terms and conditions
                          </span>
                          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                            Required
                          </span>
                        </div>
                        <p className="text-sm text-gray-700">
                          I have read, understood, and agree to the terms and conditions outlined in the 
                          Agent Service Agreement document. I acknowledge that this agreement is legally 
                          binding and will govern the relationship between my group and the agent.
                        </p>
                      </div>
                    </label>
                  </div>

                  {/* Digital Signature Section */}
                  <div className="border-t border-gray-200 pt-6">
                    <SignaturePad
                      onSignatureChange={handleSignatureChange}
                      isRequired={true}
                      label="Your Digital Signature"
                      placeholder="Click and drag to sign, or type your name below"
                    />
                  </div>

                  {/* Error Display */}
                  {error && (
                    <div className="mt-4 bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg">
                      {error}
                    </div>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="flex justify-end space-x-3">
                  <button
                    onClick={handleClose}
                    disabled={isSubmitting}
                    className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  
                  <button
                    onClick={handleSubmit}
                    disabled={isSubmitting || !hasAgreed || !digitalSignature}
                    className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                  >
                    {isSubmitting ? 'Signing Agreement...' : 'Sign Agreement'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Signed Document Modal - After template-based signing */}
      {showSignedDocumentModal && signedDocumentUrl && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <div className="text-center">
              <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-green-100 mb-4">
                <CheckCircle className="h-6 w-6 text-green-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Signing Complete!</h3>
              <p className="text-sm text-gray-600 mb-6">
                Signed document will also be available in your group portal.
              </p>
              <div className="space-y-3">
                <button
                  onClick={() => {
                    window.open(signedDocumentUrl, '_blank');
                  }}
                  className="w-full px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark flex items-center justify-center gap-2"
                >
                  <Download className="h-4 w-4" />
                  Download Signed Agreement
                </button>
                <button
                  onClick={handleSuccess}
                  className="w-full px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Download Modal - For basic signature pad */}
      {showDownloadModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 mb-4">
                <CheckCircle className="h-6 w-6 text-green-600" />
              </div>
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                Agreement Signed Successfully!
              </h3>
              <p className="text-sm text-gray-600 mb-6">
                Your ASA agreement has been signed and saved. You can download a copy of the signed document below.
              </p>
              
              <div className="space-y-3">
                {signedDocumentUrl && (
                  <button
                    onClick={() => {
                      window.open(signedDocumentUrl, '_blank');
                    }}
                    className="w-full bg-oe-primary text-white py-2 px-4 rounded-lg hover:bg-oe-primary-dark flex items-center justify-center"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download Signed Document
                  </button>
                )}
                
                <button
                  onClick={handleSuccess}
                  className="w-full bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ASASigningModal;


