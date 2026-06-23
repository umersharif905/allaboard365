// frontend/src/components/modals/EditSetupFeeModal.tsx
import { AlertCircle, DollarSign, Loader2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';
import type { ApiResponse } from '../../types/index';

interface EditSetupFeeModalProps {
  isOpen: boolean;
  onClose: () => void;
  product: {
    subscriptionId: string;
    Name: string;
    SetupFee?: number | null;
  };
  onSuccess: () => void;
  tenantMinimumSetupFee?: number | null;
}

const EditSetupFeeModal: React.FC<EditSetupFeeModalProps> = ({
  isOpen,
  onClose,
  product,
  onSuccess,
  tenantMinimumSetupFee
}) => {
  const [setupFee, setSetupFee] = useState<string>(product.SetupFee?.toString() || '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSetupFee(product.SetupFee?.toString() || '');
      setError(null);
    }
  }, [isOpen, product.SetupFee]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const feeValue = setupFee.trim() === '' ? null : parseFloat(setupFee);
    
    // Validation
    if (feeValue !== null) {
      if (isNaN(feeValue) || feeValue < 0) {
        setError('Setup fee must be a non-negative number');
        return;
      }
      
      if (tenantMinimumSetupFee !== null && tenantMinimumSetupFee !== undefined && feeValue < tenantMinimumSetupFee) {
        setError(`Setup fee must be at least $${tenantMinimumSetupFee.toFixed(2)} (tenant minimum)`);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const response = await apiService.put<ApiResponse<{ message?: string }>>(`/api/tenant/products/${product.subscriptionId}/setup-fee`, {
        setupFee: feeValue
      });

      if (response.success) {
        onSuccess();
        onClose();
      } else {
        setError(response.message || 'Failed to update setup fee');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to update setup fee');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Background overlay */}
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={onClose}
        />

        {/* Modal panel */}
        <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
          {/* Header */}
          <div className="bg-white px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <DollarSign className="h-6 w-6 text-oe-primary mr-3" />
                <h3 className="text-lg font-medium text-gray-900">
                  Edit Setup Fee
                </h3>
              </div>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-500 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Content */}
          <form onSubmit={handleSubmit}>
            <div className="bg-white px-6 py-4">
              <div className="mb-4">
                <p className="text-sm text-gray-600 mb-4">
                  Set the setup fee for <span className="font-medium text-gray-900">{product.Name}</span>
                </p>

                {tenantMinimumSetupFee !== null && tenantMinimumSetupFee !== undefined && (
                  <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-sm text-blue-800">
                      <strong>Minimum Setup Fee:</strong> ${tenantMinimumSetupFee.toFixed(2)}
                    </p>
                  </div>
                )}

                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Setup Fee
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                  <input
                    type="number"
                    value={setupFee}
                    onChange={(e) => setSetupFee(e.target.value)}
                    className={`w-full px-3 py-2 pl-8 border rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                      error ? 'border-red-300' : 'border-gray-300'
                    }`}
                    placeholder="0.00"
                    step="0.01"
                    min="0"
                    disabled={isSubmitting}
                  />
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Leave empty to remove the setup fee
                </p>

                {error && (
                  <div className="mt-3 flex items-start space-x-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                    <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-red-800">{error}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="bg-gray-50 px-6 py-4 border-t border-gray-200 flex justify-end space-x-3">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg text-sm font-medium hover:bg-oe-primary-dark transition-colors disabled:opacity-50 flex items-center"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save Setup Fee'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default EditSetupFeeModal;

