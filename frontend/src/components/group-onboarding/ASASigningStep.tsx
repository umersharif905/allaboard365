import { ArrowRight, CheckCircle, Download } from 'lucide-react';
import React, { useEffect, useState, useRef } from 'react';
import { apiService } from '../../services/api.service';
import SignaturePad from '../enrollment-wizard/SignaturePad';
import PDFSigningViewer from '../pdf-signer/PDFSigningViewer';

interface ASASigningStepProps {
  asaAgreement?: {
    documentId: string;
    documentName: string;
    documentUrl: string;
  };
  linkToken: string;
  productId: string;
  signerName: string;
  signerEmail: string;
  groupName?: string;
  tenantName?: string;
  agentName?: string;
  agentEmail?: string;
  hasAgreed?: boolean;
  signedDocumentUrl?: string | null;
  isDocumentSaved?: boolean;
  signatures?: Record<string, string>;
  onHasAgreedChange?: (value: boolean) => void;
  onSignedDocumentUrlChange?: (value: string | null) => void;
  onIsDocumentSavedChange?: (value: boolean) => void;
  onSignaturesChange?: (value: Record<string, string>) => void;
  onSignatureComplete: (signature: string) => void;
  onBack: () => void;
  loading?: boolean;
}

const ASASigningStep: React.FC<ASASigningStepProps> = ({
  asaAgreement,
  linkToken,
  productId,
  signerName,
  signerEmail,
  groupName,
  tenantName,
  agentName,
  agentEmail,
  hasAgreed: propHasAgreed = false,
  signedDocumentUrl: propSignedDocumentUrl = null,
  isDocumentSaved: propIsDocumentSaved = false,
  signatures: propSignatures = {},
  onHasAgreedChange,
  onSignedDocumentUrlChange,
  onIsDocumentSavedChange,
  onSignaturesChange,
  onSignatureComplete,
  onBack,
  loading = false
}) => {
  const [digitalSignature, setDigitalSignature] = useState<string>('');
  const [hasAgreed, setHasAgreed] = useState(propHasAgreed);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [signedDocumentUrl, setSignedDocumentUrl] = useState<string | null>(propSignedDocumentUrl);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [showSignedDocumentModal, setShowSignedDocumentModal] = useState(false);
  const [hasTemplate, setHasTemplate] = useState(false);
  const [checkingTemplate, setCheckingTemplate] = useState(true);
  const [isDocumentSaved, setIsDocumentSaved] = useState(propIsDocumentSaved);
  const [isSigningReady, setIsSigningReady] = useState(false);
  const [isApplyingSignatures, setIsApplyingSignatures] = useState(false);
  const [signingComplete, setSigningComplete] = useState(false);
  const applySignaturesRef = useRef<(() => Promise<string | null>) | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);

  // Sync with parent state when props change
  useEffect(() => {
    if (propHasAgreed !== hasAgreed) {
      console.log('📥 Restoring hasAgreed from parent:', propHasAgreed);
      setHasAgreed(propHasAgreed);
    }
  }, [propHasAgreed]);

  useEffect(() => {
    if (propSignedDocumentUrl !== signedDocumentUrl) {
      console.log('📥 Restoring signedDocumentUrl from parent:', !!propSignedDocumentUrl);
      setSignedDocumentUrl(propSignedDocumentUrl);
    }
  }, [propSignedDocumentUrl]);

  useEffect(() => {
    if (propIsDocumentSaved !== isDocumentSaved) {
      console.log('📥 Restoring isDocumentSaved from parent:', propIsDocumentSaved);
      setIsDocumentSaved(propIsDocumentSaved);
    }
  }, [propIsDocumentSaved]);

  const handleSignatureChange = (signature: string | null) => {
    setDigitalSignature(signature || '');
    setError(null);
  };

  const handleAgreementChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.checked;
    setHasAgreed(newValue);
    onHasAgreedChange?.(newValue);
    setError(null);
  };

  // Update parent state when local state changes
  useEffect(() => {
    onSignedDocumentUrlChange?.(signedDocumentUrl);
  }, [signedDocumentUrl, onSignedDocumentUrlChange]);

  useEffect(() => {
    onIsDocumentSavedChange?.(isDocumentSaved);
  }, [isDocumentSaved, onIsDocumentSavedChange]);

  // Check if document has a signature template
  useEffect(() => {
    const checkTemplate = async () => {
      if (!asaAgreement?.documentId) {
        setCheckingTemplate(false);
        return;
      }

      try {
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
      } finally {
        setCheckingTemplate(false);
      }
    };

    checkTemplate();
  }, [asaAgreement?.documentId]);

  const handleSubmit = async () => {
    if (!hasAgreed) {
      setError('You must agree to the terms and conditions to proceed.');
      return;
    }

    if (!digitalSignature) {
      setError('Please provide your digital signature.');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);

      console.log('📝 Submitting ASA signature:', {
        linkToken,
        productId,
        signerName,
        signerEmail,
        hasSignature: !!digitalSignature,
        signatureLength: digitalSignature.length
      });

      const result = await apiService.post<{
        success: boolean;
        data?: {
          signedDocumentUrl: string;
        };
        message?: string;
      }>('/api/group-onboarding/sign-asa', {
        linkToken,
        productId,
        signatureData: digitalSignature,
        signerName,
        signerEmail
      });

      if (result.success && result.data) {
        console.log('✅ ASA signature submitted successfully:', result.data);
        setSignedDocumentUrl(result.data.signedDocumentUrl);
        setShowDownloadModal(true);
        // Don't call onSignatureComplete yet - wait for user to download
      } else {
        throw new Error(result.message || 'Failed to sign ASA agreement');
      }

    } catch (error) {
      console.error('❌ Error submitting ASA signature:', error);
      setError(error instanceof Error ? error.message : 'Failed to sign ASA agreement. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!asaAgreement) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <CheckCircle className="h-16 w-16 text-green-600 mx-auto mb-4" />
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">No ASA Agreement Required</h2>
          <p className="text-gray-600">This group does not require an Agent Service Agreement.</p>
        </div>

        <div className="mt-6 flex justify-between">
          <button
            onClick={onBack}
            className="bg-gray-500 text-white py-2 px-6 rounded-lg hover:bg-gray-600"
          >
            Back
          </button>
          
          <button
            onClick={() => onSignatureComplete('')}
            className="bg-green-600 text-white py-2 px-6 rounded-lg hover:bg-green-700"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

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
        onSignedDocumentUrlChange?.(signedUrl);
        
        // Save to backend
        const saveSuccess = await handleTemplateSignComplete(signedUrl);
        if (saveSuccess) {
          setSigningComplete(true);
          setIsDocumentSaved(true);
          onIsDocumentSavedChange?.(true);
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
        return isDocumentSaved; // Return current state after waiting
      } catch {
        return false;
      }
    }

    // Create the save promise and store it in the ref
    const savePromise = (async (): Promise<boolean> => {
      try {
        setIsSubmitting(true);
        setError(null);

        console.log('💾 ========== SAVING SIGNED ASA DOCUMENT ==========');
        console.log('💾 signedDocumentUrl:', signedDocumentUrl);

        // Submit to backend to save to SignedASAAgreements table
        const result = await apiService.post<{
          success: boolean;
          data?: {
            signedDocumentUrl: string;
          };
          message?: string;
        }>('/api/group-onboarding/sign-asa', {
          linkToken,
          productId,
          signatureData: 'template-based', // Indicate template-based signing
          signerName,
          signerEmail,
          signedDocumentUrl // Pass the signed document URL
        });

        if (result.success) {
          console.log('✅ Document saved successfully to backend');
          setSignedDocumentUrl(signedDocumentUrl);
          setIsDocumentSaved(true);
          onSignedDocumentUrlChange?.(signedDocumentUrl);
          onIsDocumentSavedChange?.(true);
          return true; // Return success
        } else {
          throw new Error(result.message || 'Failed to save signed agreement');
        }
      } catch (error) {
        console.error('❌ Error saving signed agreement:', error);
        setError(error instanceof Error ? error.message : 'Failed to save signed agreement');
        setIsDocumentSaved(false); // Reset on error
        return false; // Return failure
      } finally {
        setIsSubmitting(false);
        savePromiseRef.current = null; // Clear the ref when done
      }
    })();

    savePromiseRef.current = savePromise;
    return await savePromise;
  };

  if (checkingTemplate) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Main Content - Always show, modal overlays on top */}
      <div className="max-w-4xl mx-auto">
        {hasTemplate ? (
          <>
            {/* Use PDFSigningViewer for template-based signing */}
            <PDFSigningViewer
              documentId={asaAgreement.documentId}
              documentUrl={asaAgreement.documentUrl}
              signedDocumentUrl={signedDocumentUrl || undefined}
              initialSignatures={propSignatures}
              onSignaturesChange={onSignaturesChange}
              autoFillData={{
                groupName: groupName || signerName,
                tenantName: tenantName || '',
                agentName: agentName || '',
                agentEmail: agentEmail || '',
                currentDate: (() => {
                  // Handle UTC dates properly - parse date parts separately
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
                onHasAgreedChange?.(value);
              }}
              onCompleteSigning={handleCompleteSigning}
              isApplyingSignatures={isApplyingSignatures}
              signingComplete={signingComplete || !!signedDocumentUrl}
              signerName={signerName}
              signerEmail={signerEmail}
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
                    console.log('📥 Continue button clicked - navigating to next step');
                    onSignatureComplete('template-based');
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
            // Use basic signature pad for documents without templates
            <>
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

              <div className="mt-6 flex justify-between">
                <button
                  onClick={onBack}
                  className="bg-gray-500 text-white py-2 px-6 rounded-lg hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isSubmitting}
                >
                  Back
                </button>
                
                <button
                  onClick={handleSubmit}
                  disabled={loading || isSubmitting || !hasAgreed || !digitalSignature}
                  className="bg-green-600 text-white py-2 px-6 rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? 'Signing Agreement...' : loading ? 'Processing...' : 'Sign Agreement & Continue'}
                </button>
              </div>
            </>
          )}
        </div>

      {/* Signed Document Modal - After template-based signing (overlays content) */}
      {showSignedDocumentModal && signedDocumentUrl && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[10050] p-4">
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
                  onClick={() => {
                    setShowSignedDocumentModal(false);
                    onSignatureComplete('template-based');
                  }}
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
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[10050] p-4">
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
                  onClick={() => {
                    setShowDownloadModal(false);
                    onSignatureComplete(digitalSignature);
                  }}
                  className="w-full bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700"
                >
                  Continue to Next Step
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      
    </>
  );
};

export default ASASigningStep;



