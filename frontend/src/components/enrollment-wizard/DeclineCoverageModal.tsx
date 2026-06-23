import { XCircle } from 'lucide-react';
import React, { useState } from 'react';
import SignaturePad from './SignaturePad';

interface DeclineCoverageModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: DeclineCoverageData) => void;
  memberInfo: {
    firstName: string;
    lastName: string;
    email: string;
  };
}

interface DeclineCoverageData {
  declineReasons: string[];
  digitalSignature: string;
  memberInfo: {
    firstName: string;
    lastName: string;
    email: string;
  };
}

const DECLINE_REASONS = [
  { id: 'coverage-through-spouse', label: 'Coverage through spouse/partner' },
  { id: 'coverage-through-parents', label: 'Coverage through parents' },
  { id: 'coverage-through-other', label: 'Coverage through other plan' },
  { id: 'cost-of-plan', label: 'Cost of plan' },
  { id: 'other', label: 'Other' }
];

const DeclineCoverageModal: React.FC<DeclineCoverageModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  memberInfo
}) => {
  const [declineReasons, setDeclineReasons] = useState<string[]>([]);
  const [digitalSignature, setDigitalSignature] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ [key: string]: string }>({});

  const handleReasonChange = (reasonId: string, checked: boolean) => {
    if (checked) {
      setDeclineReasons(prev => [...prev, reasonId]);
    } else {
      setDeclineReasons(prev => prev.filter(id => id !== reasonId));
    }
    // Clear error when user makes a selection
    if (errors.declineReasons) {
      setErrors(prev => ({ ...prev, declineReasons: '' }));
    }
  };

  const handleSignatureChange = (signature: string) => {
    setDigitalSignature(signature);
    // Clear error when user provides signature
    if (errors.digitalSignature) {
      setErrors(prev => ({ ...prev, digitalSignature: '' }));
    }
  };

  const validateForm = () => {
    const newErrors: { [key: string]: string } = {};

    if (declineReasons.length === 0) {
      newErrors.declineReasons = 'Please select at least one reason for declining coverage';
    }

    if (!digitalSignature || digitalSignature.trim() === '') {
      newErrors.digitalSignature = 'Digital signature is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        declineReasons,
        digitalSignature,
        memberInfo
      });
      // Reset form on successful submission
      setDeclineReasons([]);
      setDigitalSignature('');
      setErrors({});
    } catch (error) {
      console.error('Error submitting decline coverage:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      setDeclineReasons([]);
      setDigitalSignature('');
      setErrors({});
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Acknowledgements</h2>
          <div className="h-px bg-gray-200"></div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Decline Company Offered Benefits - Acknowledgment Section */}
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Decline Company Offered Benefits - Acknowledgment
            </h3>
            <p className="text-gray-600">
              I, the undersigned, have been offered participation in the company-sponsored healthcare benefits plan. 
              After reviewing the plan details and understanding my eligibility, I have decided to decline participation 
              in the healthcare benefits plan.
            </p>
          </div>

          {/* Reason for Declining Section */}
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Reason for Declining <span className="text-red-500">*</span>
            </h3>
            <div className="space-y-3">
              {DECLINE_REASONS.map((reason) => (
                <label key={reason.id} className="flex items-center space-x-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={declineReasons.includes(reason.id)}
                    onChange={(e) => handleReasonChange(reason.id, e.target.checked)}
                    className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                  />
                  <span className="text-gray-700">{reason.label}</span>
                </label>
              ))}
            </div>
            {errors.declineReasons && (
              <p className="mt-2 text-sm text-red-600 flex items-center">
                <XCircle className="h-4 w-4 mr-1" />
                {errors.declineReasons}
              </p>
            )}
          </div>

          {/* Decline Signature Section */}
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Decline Signature <span className="text-red-500">*</span>
            </h3>
            <SignaturePad
              onSignatureChange={handleSignatureChange}
              isRequired={true}
              label="Your Digital Signature"
              placeholder="Click and drag to sign, or type your name below"
            />
            {errors.digitalSignature && (
              <p className="mt-2 text-sm text-red-600 flex items-center">
                <XCircle className="h-4 w-4 mr-1" />
                {errors.digitalSignature}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-200 flex justify-center space-x-4">
          <button
            onClick={handleClose}
            disabled={isSubmitting}
            className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Back
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || declineReasons.length === 0 || !digitalSignature}
            className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
          >
            {isSubmitting ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                Processing...
              </>
            ) : (
              'Decline Coverage'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeclineCoverageModal;
