// frontend/src/pages/public/SignAcknowledgementsPage.tsx
import { AlertCircle, CheckCircle, Download, FileText } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import SignaturePad from '../../components/enrollment-wizard/SignaturePad';
import { apiService } from '../../services/api.service';

interface AcknowledgementQuestion {
  id: string;
  question: string;
  fieldType: string;
  required: boolean;
  options?: string[];
}

interface ProductAcknowledgement {
  productId: string;
  productName: string;
  productType: string;
  acknowledgements: AcknowledgementQuestion[];
}

interface AcknowledgementResponse {
  questionId: string;
  productId: string;
  response: string | boolean;
  fieldType: string;
}

interface TokenData {
  email?: string;
  signedAt?: string;
  pdfUrl?: string;
  productAcknowledgements?: ProductAcknowledgement[];
}

interface TokenResponse {
  success: boolean;
  message?: string;
  alreadySigned?: boolean;
  data: TokenData;
}

interface SubmitResponse {
  success: boolean;
  message?: string;
  data?: {
    pdfUrl?: string;
  };
}

const SignAcknowledgementsPage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tokenData, setTokenData] = useState<any>(null);
  const [alreadySigned, setAlreadySigned] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [productAcknowledgements, setProductAcknowledgements] = useState<ProductAcknowledgement[]>([]);
  const [acknowledgementResponses, setAcknowledgementResponses] = useState<AcknowledgementResponse[]>([]);
  const [digitalSignature, setDigitalSignature] = useState<string | null>(null);
  const [electronicSignatureConsent, setElectronicSignatureConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (token) {
      fetchAcknowledgementData();
    }
  }, [token]);

  const fetchAcknowledgementData = async () => {
    try {
      setLoading(true);
      
      // Get token data with acknowledgements included
      const tokenResponse = await apiService.get<TokenResponse>(`/api/public/sign-acknowledgements/${token}`);
      
      if (!tokenResponse.success) {
        setError(tokenResponse.message || 'Invalid or expired link');
        setLoading(false);
        return;
      }
      
      // Check if already signed
      if (tokenResponse.alreadySigned) {
        setAlreadySigned(true);
        setTokenData(tokenResponse.data);
        setPdfUrl(tokenResponse.data.pdfUrl || null);
        setLoading(false);
        return;
      }
      
      setTokenData(tokenResponse.data);
      
      // Product acknowledgements are now included in the token response!
      const productAcks = tokenResponse.data.productAcknowledgements || [];
      console.log('📋 Acknowledgements received:', {
        total: productAcks.length,
        products: productAcks.map((p: ProductAcknowledgement) => ({
          name: p.productName,
          ackCount: p.acknowledgements.length
        })),
        fullData: productAcks
      });
      setProductAcknowledgements(productAcks);
      
      // Initialize responses
      const responses: AcknowledgementResponse[] = [];
      productAcks.forEach((product: ProductAcknowledgement) => {
        product.acknowledgements.forEach((ack: AcknowledgementQuestion) => {
          if (ack.required) {
            responses.push({
              questionId: ack.id,
              productId: product.productId,
              response: ack.fieldType === 'checkbox' ? false : '',
              fieldType: ack.fieldType
            });
          }
        });
      });
      setAcknowledgementResponses(responses);
      
      setLoading(false);
    } catch (err: any) {
      console.error('Error fetching acknowledgement data:', err);
      setError(err.message || 'Failed to load acknowledgement data');
      setLoading(false);
    }
  };

  const handleAcknowledgementResponse = (questionId: string, productId: string, response: string | boolean) => {
    setAcknowledgementResponses(prev => {
      const existingIndex = prev.findIndex(r => r.questionId === questionId && r.productId === productId);
      
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = { ...updated[existingIndex], response };
        return updated;
      } else {
        return [...prev, { questionId, productId, response, fieldType: 'checkbox' }];
      }
    });
  };

  const validateAcknowledgements = () => {
    if (productAcknowledgements.length === 0) return true;
    
    const requiredAcknowledgements = productAcknowledgements.flatMap(product => 
      product.acknowledgements.filter(ack => ack.required).map(ack => ({ ...ack, productId: product.productId }))
    );
    
    const hasAllResponses = requiredAcknowledgements.every(ack => {
      const response = acknowledgementResponses.find(r => 
        r.questionId === ack.id && r.productId === ack.productId
      );
      
      if (!response) return false;
      
      if (ack.fieldType === 'checkbox') {
        return response.response === true;
      } else {
        return typeof response.response === 'string' && response.response.trim().length > 0;
      }
    });
    
    return hasAllResponses && digitalSignature && electronicSignatureConsent;
  };

  const handleSubmit = async () => {
    if (!validateAcknowledgements()) {
      alert('Please complete all required acknowledgements and provide your digital signature.');
      return;
    }
    
    setSubmitting(true);
    
    try {
      // Backend will fetch all acknowledgement details from database using the token
      const response = await apiService.post<SubmitResponse>(`/api/public/sign-acknowledgements/${token}`, {
        acknowledgementResponses,
        digitalSignature
      });
      
      if (response.success) {
        setSubmitted(true);
        setPdfUrl(response.data?.pdfUrl || null);
      } else {
        alert(`Failed to submit: ${response.message}`);
      }
    } catch (err: any) {
      console.error('Error submitting acknowledgements:', err);
      alert(`Error: ${err.message || 'Failed to submit acknowledgements'}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
          <p className="text-gray-600">Loading acknowledgements...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg border border-red-200 p-6 text-center">
          <AlertCircle className="h-16 w-16 text-red-600 mx-auto mb-4" />
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Link Error</h2>
          <p className="text-gray-600 mb-6">{error}</p>
        </div>
      </div>
    );
  }

  // Already signed state (when user clicks link again)
  if (alreadySigned) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg border border-blue-200 p-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-100 rounded-full mb-4">
            <CheckCircle className="h-8 w-8 text-oe-primary" />
          </div>
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">
            Already Signed
          </h2>
          <p className="text-gray-600 mb-6">
            These acknowledgements were signed{tokenData?.signedAt ? ` on ${new Date(tokenData.signedAt).toLocaleDateString()}` : ''}.
          </p>
          {pdfUrl && (
            <div className="space-y-4">
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center px-6 py-3 bg-oe-primary text-white rounded-lg font-semibold hover:bg-oe-primary-dark transition-colors"
              >
                <Download className="h-4 w-4 mr-2" />
                Download Signed PDF
              </a>
            </div>
          )}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-6">
            <p className="text-sm text-blue-800">
              ✅ Signature recorded
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Success state after signing
  if (submitted) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg border border-green-200 p-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 rounded-full mb-4">
            <CheckCircle className="h-8 w-8 text-green-600" />
          </div>
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">
            Acknowledgements Signed!
          </h2>
          <p className="text-gray-600 mb-6">
            Your acknowledgements have been signed successfully. You can now close this window and return to your enrollment.
          </p>
          {pdfUrl && (
            <div className="mb-6">
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center px-6 py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 transition-colors"
              >
                <Download className="h-4 w-4 mr-2" />
                Download Your Signed PDF
              </a>
            </div>
          )}
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <p className="text-sm text-green-800">
              ✅ Signature recorded
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <FileText className="h-16 w-16 text-oe-primary mx-auto mb-4" />
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Sign Your Enrollment Acknowledgements
          </h1>
          <p className="text-gray-600">
            Please review and acknowledge the terms for your selected benefits
          </p>
          {tokenData?.email && (
            <p className="text-sm text-gray-500 mt-2">
              Sent to: {tokenData.email}
            </p>
          )}
        </div>

        {/* Product Acknowledgements */}
        <div className="space-y-6">
          {productAcknowledgements.map((product) => (
            <div key={product.productId} className="bg-white rounded-lg border border-gray-200 p-6">
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-gray-900">{product.productName}</h3>
                <p className="text-sm text-gray-600">{product.productType}</p>
              </div>
              
              <div className="space-y-4">
                {product.acknowledgements.map((acknowledgement) => (
                  <div key={acknowledgement.id} className="border border-gray-200 rounded-lg p-4">
                    <div className="mb-3">
                      <div className="max-h-64 overflow-y-auto border border-gray-100 rounded-md p-3 bg-gray-50">
                        <h4 className="font-medium text-gray-900 whitespace-pre-wrap">
                          {acknowledgement.question}
                          {acknowledgement.required && <span className="text-red-500 ml-1">*</span>}
                        </h4>
                      </div>
                    </div>
                    
                    {acknowledgement.fieldType === 'checkbox' && (
                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          id={`ack-${acknowledgement.id}`}
                          checked={acknowledgementResponses.find(r => 
                            r.questionId === acknowledgement.id && r.productId === product.productId
                          )?.response === true || false}
                          onChange={(e) => handleAcknowledgementResponse(
                            acknowledgement.id,
                            product.productId,
                            e.target.checked
                          )}
                          className="h-5 w-5 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                        />
                        <label htmlFor={`ack-${acknowledgement.id}`} className="ml-2 text-sm text-gray-700">
                          I acknowledge and agree to the above statement
                        </label>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          
          {/* Digital Signature */}
          {productAcknowledgements.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Digital Signature <span className="text-red-500">*</span>
              </h3>
              <p className="text-gray-600 mb-4">
                Please provide your digital signature to confirm that you have read, understood, 
                and agree to all the terms and conditions presented above.
              </p>
              
              <SignaturePad
                onSignatureChange={(signature) => setDigitalSignature(signature)}
                isRequired={true}
                label="Your Digital Signature"
                placeholder="Click and drag to sign, or type your name below"
              />
            </div>
          )}

          {/* E-Signature Consent */}
          {productAcknowledgements.length > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
              <div className="flex items-start space-x-3">
                <input
                  type="checkbox"
                  id="esignature-consent-public"
                  className="mt-1 h-5 w-5 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                  checked={electronicSignatureConsent}
                  onChange={(e) => setElectronicSignatureConsent(e.target.checked)}
                  required
                />
                <label htmlFor="esignature-consent-public" className="text-sm text-gray-700">
                  <span className="font-medium">I consent to use electronic signatures and understand this is a legally binding agreement <span className="text-red-500">*</span></span>
                  <br />
                  <span className="text-gray-600 mt-1 block">
                    By checking this box, I agree that my electronic signature has the same legal effect as a handwritten signature. 
                    I understand that I can request a paper copy of this agreement at any time.
                  </span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Submit Button */}
        <div className="mt-8 flex justify-center">
          <button
            onClick={handleSubmit}
            disabled={submitting || !validateAcknowledgements()}
            className="px-8 py-3 bg-oe-primary text-white rounded-lg font-semibold hover:bg-oe-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <div className="flex items-center">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                Submitting...
              </div>
            ) : (
              'Sign & Submit Acknowledgements'
            )}
          </button>
        </div>

        {/* Footer */}
        <div className="mt-8 text-center text-sm text-gray-500">
          <p>This link expires in 24 hours from when it was sent.</p>
          <p className="mt-2">If you have questions, please contact your enrollment administrator.</p>
        </div>
      </div>
    </div>
  );
};

export default SignAcknowledgementsPage;

