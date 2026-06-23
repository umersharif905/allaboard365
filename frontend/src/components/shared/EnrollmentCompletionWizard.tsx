// frontend/src/components/shared/EnrollmentCompletionWizard.tsx
import { Check, CreditCard, FileText, Info, Loader2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import SignaturePad from '../enrollment-wizard/SignaturePad';

interface AcknowledgementQuestion {
  id: string;
  question: string;
  fieldType: string;
  required: boolean;
  options?: string[];
  customAction?: string;
}

interface ProductAcknowledgement {
  productId: string;
  productName: string;
  productType: string;
  selectionType: string;
  acknowledgements: AcknowledgementQuestion[];
}

interface EnrollmentCompletionWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (data: {
    acknowledgements: any[];
    digitalSignature: string;
  }) => void;
  productAcknowledgements: ProductAcknowledgement[];
  memberInfo: any;
  selectedProducts: any[];
  loading?: boolean;
  pdfUrl?: string | null;
  // Contribution-related props
  products?: any[];
  selectedConfigs?: Record<string, string>;
  allProductsRules?: any[];
  calculatedTotal?: number;
  // Payment-related props
  isGroupMember?: boolean;
  // Effective date for billing calculation
  effectiveDate?: string;
  // Payment method selection props (for non-group members)
  availablePaymentMethods?: Array<{
    id: string;
    type: string;
    last4: string;
    cardBrand?: string;
    isDefault: boolean;
  }>;
  selectedPaymentMethodId?: string;
  onPaymentMethodSelect?: (paymentMethodId: string) => void;
  onAddPaymentMethod?: () => void;
  onPaymentMethodAdded?: () => void;
  paymentMethodLoading?: boolean;
  shouldAutoAdvance?: boolean;
  onAutoAdvanceComplete?: () => void;
}

const EnrollmentCompletionWizard: React.FC<EnrollmentCompletionWizardProps> = ({
  isOpen,
  onClose,
  onComplete,
  productAcknowledgements,
  memberInfo,
  selectedProducts,
  loading = false,
  pdfUrl: propPdfUrl = null,
  calculatedTotal,
  isGroupMember = false,
  effectiveDate,
  // Payment method selection props
  availablePaymentMethods = [],
  selectedPaymentMethodId = '',
  onPaymentMethodSelect,
  onAddPaymentMethod,
  paymentMethodLoading = false,
  shouldAutoAdvance = false,
  onAutoAdvanceComplete
}) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [acknowledgementResponses, setAcknowledgementResponses] = useState<Record<string, any>>({});
  const [digitalSignature, setDigitalSignature] = useState('');
  const [isSignatureValid, setIsSignatureValid] = useState(false);
  const [signatureAgreement, setSignatureAgreement] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showPdfModal, setShowPdfModal] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  // Generate steps based on whether acknowledgements are required and if recurring payment setup is needed
  const hasAcknowledgements = productAcknowledgements && productAcknowledgements.length > 0;
  const needsRecurringPayment = !isGroupMember && calculatedTotal && calculatedTotal > 0;
  const needsPaymentMethodSelection = needsRecurringPayment && (!selectedPaymentMethodId || selectedPaymentMethodId === '');
  
  const steps = [
    ...(hasAcknowledgements ? [
      { id: 'acknowledgements', title: 'Product Acknowledgements', description: 'Review and acknowledge product terms' },
      { id: 'signature', title: 'Digital Signature', description: 'Sign to complete your enrollment' }
    ] : []),
    ...(needsPaymentMethodSelection ? [
      { id: 'payment', title: 'Payment Method', description: 'Set up recurring payment method' }
    ] : []),
    { id: 'confirmation', title: 'Confirmation', description: 'Review your selections' }
  ];

  useEffect(() => {
    if (isOpen) {
      setCurrentStep(0);
      setAcknowledgementResponses({});
      setDigitalSignature('');
      setIsSignatureValid(false);
      setSignatureAgreement(false);
      setErrors({});
      setPdfUrl(propPdfUrl);
    }
  }, [isOpen, propPdfUrl]);

  // Ensure currentStep is always within bounds
  useEffect(() => {
    if (currentStep >= steps.length) {
      setCurrentStep(Math.max(0, steps.length - 1));
    }
  }, [currentStep, steps.length]);

  // Auto-advance when triggered by parent
  useEffect(() => {
    if (shouldAutoAdvance && currentStep < steps.length - 1) {
      setTimeout(() => {
        setCurrentStep(prev => prev + 1);
        onAutoAdvanceComplete?.();
      }, 500);
    }
  }, [shouldAutoAdvance, currentStep, steps.length, onAutoAdvanceComplete]);

  const handleAcknowledgementResponse = (questionId: string, productId: string, response: string | boolean) => {
    const key = `${productId}-${questionId}`;
    setAcknowledgementResponses(prev => ({
      ...prev,
      [key]: { questionId, productId, response, fieldType: 'acknowledgement' }
    }));

    // Clear error for this question
    if (errors[key]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[key];
        return newErrors;
      });
    }
  };

  const checkAcknowledgementsValid = () => {
    const newErrors: Record<string, string> = {};

    productAcknowledgements.forEach(product => {
      product.acknowledgements.forEach(question => {
        if (question.required) {
          const key = `${product.productId}-${question.id}`;
          const response = acknowledgementResponses[key];
          
          if (!response || (typeof response.response === 'string' && response.response.trim() === '')) {
            newErrors[key] = 'This acknowledgement is required';
          }
        }
      });
    });

    return Object.keys(newErrors).length === 0;
  };

  const validateAcknowledgements = () => {
    const newErrors: Record<string, string> = {};

    productAcknowledgements.forEach(product => {
      product.acknowledgements.forEach(question => {
        if (question.required) {
          const key = `${product.productId}-${question.id}`;
          const response = acknowledgementResponses[key];
          
          if (!response || (typeof response.response === 'string' && response.response.trim() === '')) {
            newErrors[key] = 'This acknowledgement is required';
          }
        }
      });
    });

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const isNextDisabled = () => {
    if (loading) return true;
    
    const currentStepData = steps[currentStep];
    
    if (currentStepData?.id === 'acknowledgements') {
      // Check if all required acknowledgements are completed
      return !checkAcknowledgementsValid();
    } else if (currentStepData?.id === 'signature') {
      // Check if signature is valid and agreement is checked
      return !isSignatureValid || !signatureAgreement;
    } else if (currentStepData?.id === 'payment') {
      // Check if payment method is selected
      return !selectedPaymentMethodId || paymentMethodLoading;
    }
    
    return false;
  };

  const handleNext = () => {
    const currentStepData = steps[currentStep];
    
    if (currentStepData?.id === 'acknowledgements') {
      // Validate acknowledgements
      if (!validateAcknowledgements()) {
        return;
      }
    } else if (currentStepData?.id === 'signature') {
      // Validate signature
      if (!isSignatureValid) {
        setErrors(prev => ({ ...prev, signature: 'Digital signature is required' }));
        return;
      }
      if (!signatureAgreement) {
        setErrors(prev => ({ ...prev, signatureAgreement: 'You must agree to use your digital signature' }));
        return;
      }
    } else if (currentStepData?.id === 'payment') {
      // Validate payment method selection
      if (!selectedPaymentMethodId) {
        setErrors(prev => ({ ...prev, paymentMethod: 'Please select a payment method' }));
        return;
      }
      if (selectedPaymentMethodId === 'new') {
        // Trigger add payment method modal
        onAddPaymentMethod?.();
        return;
      }
    }

    if (currentStep < steps.length - 1) {
      setCurrentStep(prev => prev + 1);
    } else {
      // Complete the process - build full acknowledgement objects with question text
      const acknowledgements: any[] = [];
      
      productAcknowledgements.forEach(product => {
        product.acknowledgements.forEach(question => {
          const key = `${product.productId}-${question.id}`;
          const response = acknowledgementResponses[key];
          
          if (response) {
            acknowledgements.push({
              questionId: question.id, // Required by backend validation
              question: question.question, // Include the actual question text
              questionText: question.question, // Also include as questionText for compatibility
              response: response.response,
              fieldType: question.fieldType,
              required: question.required,
              productId: product.productId,
              productName: product.productName
            });
          }
        });
      });
      
      onComplete({ acknowledgements, digitalSignature });
    }
  };

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(prev => prev - 1);
    }
  };

  const renderAcknowledgements = () => {
    if (productAcknowledgements.length === 0) {
      return (
        <div className="text-center py-8">
          <Check className="h-12 w-12 text-green-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Acknowledgements Required</h3>
          <p className="text-gray-600">The selected products do not require any acknowledgements.</p>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        {productAcknowledgements.map((product) => (
          <div key={product.productId} className="bg-gray-50 rounded-lg p-4">
            <h4 className="text-lg font-medium text-gray-900 mb-2">{product.productName}</h4>
            <p className="text-sm text-gray-600 mb-4">{product.productType}</p>
            
            <div className="space-y-4">
              {product.acknowledgements.map((question) => {
                const key = `${product.productId}-${question.id}`;
                const response = acknowledgementResponses[key];
                const hasError = !!errors[key];

                return (
                  <div key={question.id} className="border border-gray-200 rounded-lg p-4">
                    <div className="mb-3">
                      <div className="max-h-64 overflow-y-auto border border-gray-100 rounded-md p-3 bg-gray-50">
                        <label className="text-sm font-medium text-gray-900 whitespace-pre-wrap">
                          {question.question}
                          {question.required && <span className="text-red-500 ml-1">*</span>}
                        </label>
                      </div>
                      {question.fieldType === 'checkbox' && (
                        <p className="text-sm text-gray-600 mt-2">
                          Please check the box below to acknowledge this statement
                        </p>
                      )}
                    </div>
                    
                    {/* Checkbox Field Type */}
                    {question.fieldType === 'checkbox' && (
                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          checked={!!response?.response}
                          onChange={(e) => handleAcknowledgementResponse(question.id, product.productId, e.target.checked)}
                          className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                        />
                        <span className="ml-2 text-sm text-gray-700">
                          I acknowledge and agree to the above statement
                        </span>
                      </div>
                    )}
                    
                    {/* Dropdown Field Type */}
                    {question.fieldType === 'dropdown' && question.options && (
                      <div>
                        <select
                          value={response?.response as string || ''}
                          onChange={(e) => handleAcknowledgementResponse(question.id, product.productId, e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        >
                          <option value="">Select an option</option>
                          {question.options.map((option, index) => (
                            <option key={index} value={option}>{option}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    
                    {/* Text Field Type */}
                    {question.fieldType === 'text' && (
                      <div>
                        <input
                          type="text"
                          value={response?.response as string || ''}
                          onChange={(e) => handleAcknowledgementResponse(question.id, product.productId, e.target.value)}
                          placeholder="Enter your response"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        />
                      </div>
                    )}
                    
                    {/* Textarea Field Type */}
                    {question.fieldType === 'textarea' && (
                      <div>
                        <textarea
                          value={response?.response as string || ''}
                          onChange={(e) => handleAcknowledgementResponse(question.id, product.productId, e.target.value)}
                          placeholder="Enter your response"
                          rows={4}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        />
                      </div>
                    )}
                    
                    {/* Number Field Type */}
                    {question.fieldType === 'number' && (
                      <div>
                        <input
                          type="number"
                          value={response?.response as string || ''}
                          onChange={(e) => handleAcknowledgementResponse(question.id, product.productId, e.target.value)}
                          placeholder="Enter a number"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        />
                      </div>
                    )}
                    
                    {/* Radio Field Type */}
                    {question.fieldType === 'radio' && question.options && (
                      <div className="space-y-2">
                        {question.options.map((option, index) => (
                          <div key={index} className="flex items-center">
                            <input
                              type="radio"
                              name={`${key}-option`}
                              value={option}
                              checked={response?.response === option}
                              onChange={(e) => handleAcknowledgementResponse(question.id, product.productId, e.target.value)}
                              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                            />
                            <span className="ml-2 text-sm text-gray-700">{option}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    
                    {/* Yes/No Field Type */}
                    {question.fieldType === 'yesno' && (
                      <div className="space-y-3">
                        <div className="flex items-center space-x-6">
                          <div className="flex items-center">
                            <input
                              type="radio"
                              name={`${key}-yesno`}
                              value="Yes"
                              checked={response?.response === 'Yes'}
                              onChange={(e) => handleAcknowledgementResponse(question.id, product.productId, e.target.value)}
                              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                            />
                            <span className="ml-2 text-sm text-gray-700">Yes</span>
                          </div>
                          <div className="flex items-center">
                            <input
                              type="radio"
                              name={`${key}-yesno`}
                              value="No"
                              checked={response?.response === 'No'}
                              onChange={(e) => handleAcknowledgementResponse(question.id, product.productId, e.target.value)}
                              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                            />
                            <span className="ml-2 text-sm text-gray-700">No</span>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    {hasError && (
                      <p className="mt-2 text-sm text-red-600">{errors[key]}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderSignature = () => (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-lg font-medium text-gray-900 mb-2">Digital Signature Required</h3>
        <p className="text-gray-600">
          Please provide your digital signature to complete the enrollment process.
        </p>
      </div>

      <div className="bg-gray-50 rounded-lg p-6">
        <SignaturePad
          onSignatureChange={(signature) => {
            setDigitalSignature(signature || '');
            setIsSignatureValid((signature || '').length > 0);
            if (errors.signature) {
              setErrors(prev => {
                const newErrors = { ...prev };
                delete newErrors.signature;
                return newErrors;
              });
            }
          }}
        />
        
        {errors.signature && (
          <p className="mt-2 text-sm text-red-600">{errors.signature}</p>
        )}
      </div>

      {/* Digital Signature Agreement */}
      <div className="bg-blue-50 rounded-lg p-4">
        <div className="flex items-start">
          <input
            type="checkbox"
            id="signature-agreement"
            checked={signatureAgreement}
            onChange={(e) => {
              setSignatureAgreement(e.target.checked);
              if (errors.signatureAgreement) {
                setErrors(prev => {
                  const newErrors = { ...prev };
                  delete newErrors.signatureAgreement;
                  return newErrors;
                });
              }
            }}
            className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded mt-1"
          />
          <label htmlFor="signature-agreement" className="ml-3 text-sm text-blue-900">
            <strong>Digital Signature Agreement:</strong> I understand that by providing my digital signature above, 
            I am electronically signing this document and that this electronic signature has the same legal effect 
            as a handwritten signature. I agree to be bound by the terms and conditions of the selected products.
          </label>
        </div>
        {errors.signatureAgreement && (
          <p className="mt-2 text-sm text-red-600">{errors.signatureAgreement}</p>
        )}
      </div>
    </div>
  );

  const renderPaymentMethod = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-4">Set Up Recurring Payment</h3>
        <p className="text-sm text-gray-600 mb-6">
          Choose a payment method for your recurring monthly payments of ${calculatedTotal?.toFixed(2)}. 
          This payment method will be used for all future billing cycles.
        </p>
        
        {paymentMethodLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-oe-primary" />
            <span className="ml-2 text-gray-600">Loading payment methods...</span>
          </div>
        ) : availablePaymentMethods.length > 0 ? (
          <div className="space-y-3">
            {availablePaymentMethods.map((pm) => (
              <label 
                key={pm.id} 
                className="flex items-center p-3 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50"
              >
                <input
                  type="radio"
                  name="paymentMethod"
                  value={pm.id}
                  checked={selectedPaymentMethodId === pm.id}
                  onChange={(e) => onPaymentMethodSelect?.(e.target.value)}
                  className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                />
                <div className="ml-3 flex-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900">
                      {pm.type === 'ACH' ? 'Bank Account' : pm.cardBrand} ending in {pm.last4}
                    </span>
                    <div className="flex items-center space-x-2">
                      {pm.isDefault && (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          Default
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </label>
            ))}
            
            {/* Add New Payment Method Option */}
            <label className="flex items-center p-3 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 hover:border-blue-400">
              <input
                type="radio"
                name="paymentMethod"
                value="new"
                checked={selectedPaymentMethodId === 'new'}
                onChange={(e) => onPaymentMethodSelect?.(e.target.value)}
                className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
              />
              <div className="ml-3 flex-1">
                <span className="text-sm font-medium text-gray-900">Add New Payment Method</span>
                <p className="text-xs text-gray-500">Add a new payment method for recurring billing</p>
              </div>
            </label>
          </div>
        ) : (
          <div className="text-center py-6">
            <div className="text-gray-500 mb-4">
              <CreditCard className="h-12 w-12 mx-auto mb-2" />
              <p className="text-sm">No credit cards on file</p>
            </div>
            <label className="flex items-center justify-center p-3 border-2 border-dashed border-blue-300 rounded-lg cursor-pointer hover:bg-blue-50">
              <input
                type="radio"
                name="paymentMethod"
                value="new"
                checked={selectedPaymentMethodId === 'new'}
                onChange={(e) => onPaymentMethodSelect?.(e.target.value)}
                className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
              />
              <div className="ml-3">
                <span className="text-sm font-medium text-blue-900">Add New Payment Method</span>
                <p className="text-xs text-oe-primary">Add a payment method for recurring billing</p>
              </div>
            </label>
          </div>
        )}
      </div>
    </div>
  );

  const renderConfirmation = () => {
    // Use the calculated total from ProductChangePage if provided (for group enrollments)
    // Otherwise fall back to simple sum (for individual enrollments)
    let totalCost = selectedProducts.reduce((sum, product) => sum + (product.monthlyPremium || 0), 0);
    let showContributionBreakdown = false;
    
    if (calculatedTotal !== undefined && memberInfo?.groupId) {
      // Use the exact same calculation as the Plan Summary in ProductChangePage
      // Only show contribution breakdown for group members
      totalCost = calculatedTotal;
      showContributionBreakdown = true;
      console.log('🔍 DEBUG: Using calculatedTotal from ProductChangePage for group member:', calculatedTotal);
    } else {
      console.log('🔍 DEBUG: Using fallback calculation for individual enrollment:', totalCost);
    }
    
    return (
      <div className="space-y-6">
        <div className="text-center">
          <Check className="h-12 w-12 text-green-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">Ready to Complete</h3>
          <p className="text-gray-600">
            Review your selections and complete the enrollment process.
          </p>
        </div>

        <div className="bg-gray-50 rounded-lg p-6">
          <h4 className="text-md font-medium text-gray-900 mb-4">Selected Products</h4>
          <div className="space-y-2">
            {selectedProducts.map((product) => (
              <div key={product.productId} className="flex justify-between items-center">
                <span className="text-sm text-gray-700">{product.productName}</span>
                <span className="text-sm font-medium text-gray-900">${product.monthlyPremium?.toFixed(2) || '0.00'}/mo</span>
              </div>
            ))}
          </div>
          
          {/* Total Cost */}
          <div className="mt-4 pt-4 border-t border-gray-200">
            {showContributionBreakdown && (() => {
              const totalPremium = selectedProducts.reduce((sum, product) => sum + (product.monthlyPremium || 0), 0);
              const employerContribution = totalPremium - totalCost;
              
              return (
                <>
                  {/* Total Premium */}
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-gray-700">Total Premium:</span>
                    <span className="text-sm text-gray-900">${totalPremium.toFixed(2)}/mo</span>
                  </div>
                  
                  {/* Employer Contribution - only show if > $0 */}
                  {employerContribution > 0 && (
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-sm font-medium text-green-700">Employer Contribution:</span>
                      <span className="text-sm text-green-600">-${employerContribution.toFixed(2)}/mo</span>
                    </div>
                  )}
                  
                  {/* Employee Contribution */}
                  <div className="flex justify-between items-center pt-2 border-t border-gray-200">
                    <span className="text-lg font-semibold text-gray-900">Your Monthly Contribution:</span>
                    <span className="text-lg font-bold text-oe-primary">${totalCost.toFixed(2)}/mo</span>
                  </div>
                </>
              );
            })()}
            
            {!showContributionBreakdown && (
              <div className="flex justify-between items-center">
                <span className="text-lg font-semibold text-gray-900">New Premium:</span>
                <span className="text-lg font-bold text-oe-primary">${totalCost.toFixed(2)}/mo</span>
              </div>
            )}
          </div>
          
        </div>

        {/* Payment Information */}
        {!isGroupMember && (
          <div className="bg-green-50 rounded-lg p-4">
            <div className="flex items-start">
              <Check className="h-5 w-5 text-green-400 mt-0.5 mr-3" />
              <div>
                <p className="text-sm text-green-700 mt-1">
                  Recurring payment will be set up for your monthly billing. 
                  Your payment method will be charged automatically each month starting from the effective date.
                </p>
                {(() => {
                  // Get the selected payment method from available payment methods
                  const selectedPaymentMethod = availablePaymentMethods?.find(pm => pm.id === selectedPaymentMethodId);
                  if (selectedPaymentMethod) {
                    // Calculate first billing date (effective date)
                    let firstBillingDate;
                    if (effectiveDate) {
                      // Use effective date as first billing date - parse as local date to avoid timezone issues
                      firstBillingDate = new Date(effectiveDate + 'T00:00:00');
                    } else {
                      // Fallback to today if no effective date
                      firstBillingDate = new Date();
                    }
                    
                    const formattedBillingDate = firstBillingDate.toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric'
                    });
                    
                    return (
                      <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded-md">
                        <p className="text-xs text-green-800 font-medium">
                          Payment Method: {selectedPaymentMethod.type === 'ACH' ? 'Bank Account' : 'Credit Card'} 
                          {selectedPaymentMethod.cardBrand && ` (${selectedPaymentMethod.cardBrand})`} 
                          ending in {selectedPaymentMethod.last4}
                        </p>
                        <p className="text-xs text-green-700 mt-1">
                          Monthly Premium: ${calculatedTotal?.toFixed(2) || '0.00'}
                        </p>
                        <p className="text-xs text-green-700 mt-1">
                          First billing date: {formattedBillingDate}
                        </p>
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>
            </div>
          </div>
        )}

        {isGroupMember && (
          <div className="bg-blue-50 rounded-lg p-4">
            <div className="flex items-start">
              <Info className="h-5 w-5 text-blue-400 mt-0.5 mr-3" />
              <div>
                <h4 className="text-sm font-medium text-blue-900">Group Payment</h4>
                <p className="text-sm text-oe-primary-dark mt-1">
                  Payment for your plan changes will be handled at the group level. No individual payment method is required.
                </p>
              </div>
            </div>
          </div>
        )}

        {hasAcknowledgements && (
          <div className="bg-blue-50 rounded-lg p-4">
            <div className="flex items-start">
              <FileText className="h-5 w-5 text-blue-400 mt-0.5 mr-3" />
              <div>
                <h4 className="text-sm font-medium text-blue-900">Document Generation</h4>
                <p className="text-sm text-oe-primary-dark mt-1">
                  A PDF document will be generated with your acknowledgements and signature for your records.
                </p>
                {pdfUrl && (
                  <button
                    onClick={() => setShowPdfModal(true)}
                    className="mt-2 inline-flex items-center px-3 py-1 rounded text-xs font-medium text-oe-primary hover:text-blue-800 hover:bg-blue-100"
                  >
                    <FileText className="h-3 w-3 mr-1" />
                    Download Document
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-gray-200">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Complete Enrollment</h2>
            <p className="text-sm text-gray-600 mt-1">
              Step {currentStep + 1} of {steps.length}: {steps[currentStep]?.title || 'Unknown Step'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            disabled={loading}
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Progress Bar */}
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center space-x-4">
            {steps.map((step, index) => (
              <div key={step.id} className="flex items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                    index <= currentStep
                      ? 'bg-oe-primary text-white'
                      : 'bg-gray-200 text-gray-600'
                  }`}
                >
                  {index + 1}
                </div>
                <div className="ml-2">
                  <p className={`text-sm font-medium ${
                    index <= currentStep ? 'text-oe-primary' : 'text-gray-500'
                  }`}>
                    {step.title}
                  </p>
                </div>
                {index < steps.length - 1 && (
                  <div className={`w-8 h-0.5 ml-4 ${
                    index < currentStep ? 'bg-oe-primary' : 'bg-gray-200'
                  }`} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 p-6 overflow-y-auto">
          {currentStep < steps.length && (
            <>
              {steps[currentStep]?.id === 'acknowledgements' && renderAcknowledgements()}
              {steps[currentStep]?.id === 'signature' && renderSignature()}
              {steps[currentStep]?.id === 'payment' && renderPaymentMethod()}
              {steps[currentStep]?.id === 'confirmation' && renderConfirmation()}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center p-6 border-t border-gray-200">
          <button
            onClick={handlePrevious}
            disabled={currentStep === 0 || loading}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          
          <div className="flex space-x-3">
            <button
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              onClick={handleNext}
              disabled={isNextDisabled()}
              className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-md hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Processing...
                </>
              ) : currentStep === steps.length - 1 ? (
                'Confirm Enrollment Changes'
              ) : steps[currentStep]?.id === 'payment' && selectedPaymentMethodId === 'new' ? (
                'Add Payment Method'
              ) : (
                'Next'
              )}
            </button>
          </div>
        </div>
      </div>

      {/* PDF Download Modal */}
      {showPdfModal && pdfUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-[90vh] flex flex-col">
            <div className="flex justify-between items-center p-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-800">Enrollment Document</h2>
              <button 
                onClick={() => setShowPdfModal(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="flex-1 p-4">
              <iframe
                src={pdfUrl}
                title="Enrollment Document"
                className="w-full h-full border-0"
              />
            </div>
            <div className="p-4 border-t border-gray-200 flex justify-end space-x-3">
              <button
                onClick={() => setShowPdfModal(false)}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300"
              >
                Close
              </button>
              <a
                href={pdfUrl}
                download="enrollment-document.pdf"
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark"
              >
                Download PDF
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EnrollmentCompletionWizard;
