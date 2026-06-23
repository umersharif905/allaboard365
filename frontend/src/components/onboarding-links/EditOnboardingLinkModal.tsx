// frontend/src/components/onboarding-links/EditOnboardingLinkModal.tsx
import React, { useState, useEffect } from 'react';
import { X, AlertCircle } from 'lucide-react';
import { OnboardingLink, UpdateOnboardingLinkRequest } from '../../services/onboardingLinks.service';

interface EditOnboardingLinkModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (linkId: string, linkData: UpdateOnboardingLinkRequest) => Promise<void>;
  link: OnboardingLink;
}


const EditOnboardingLinkModal: React.FC<EditOnboardingLinkModalProps> = ({
  isOpen,
  onClose,
  onUpdate,
  link
}) => {
  const [formData, setFormData] = useState({
    linkName: link.LinkName,
    isActive: link.IsActive
  });
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setFormData({
        linkName: link.LinkName,
        isActive: link.IsActive
      });
    }
  }, [isOpen, link]);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.linkName) {
      setError('Please enter a link name');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      
      await onUpdate(link.LinkId, {
        linkName: formData.linkName,
        isActive: formData.isActive
      });
      
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update onboarding link');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setError(null);
      onClose();
    }
  };


  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">Edit Onboarding Link</h2>
          <button
            onClick={handleClose}
            disabled={loading}
            className="text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Error Message */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg flex items-center">
              <AlertCircle className="w-5 h-5 mr-2" />
              {error}
            </div>
          )}


          {/* Link Name */}
          <div>
            <label htmlFor="linkName" className="block text-sm font-medium text-gray-700 mb-1">
              Link Name *
            </label>
            <input
              type="text"
              id="linkName"
              value={formData.linkName}
              onChange={(e) => setFormData({ ...formData, linkName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
              placeholder="e.g., Q1 2024 Agent Recruitment"
              required
              disabled={loading}
            />
          </div>


          {/* Active Status */}
          <div>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={formData.isActive}
                onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                className="rounded border-gray-300 text-[#1f8dbf] focus:ring-[#1f8dbf]"
                disabled={loading}
              />
              <span className="ml-2 text-sm font-medium text-gray-700">
                Active (agents can use this link)
              </span>
            </label>
          </div>


          {/* Usage Stats (Read-only) */}
          <div className="bg-gray-50 p-4 rounded-lg">
            <h3 className="text-sm font-medium text-gray-700 mb-2">Usage Statistics</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Total Uses:</span>
                <span className="ml-2 font-medium text-gray-900">{link.CurrentUses}</span>
              </div>
              <div>
                <span className="text-gray-500">Total Sessions:</span>
                <span className="ml-2 font-medium text-gray-900">{link.TotalSessions || 0}</span>
              </div>
              <div>
                <span className="text-gray-500">Completed:</span>
                <span className="ml-2 font-medium text-gray-900">{link.CompletedSessions || 0}</span>
              </div>
              <div>
                <span className="text-gray-500">Success Rate:</span>
                <span className="ml-2 font-medium text-gray-900">
                  {link.CompletionRate ? `${(link.CompletionRate || 0).toFixed(1)}%` : '0%'}
                </span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
            <button
              type="button"
              onClick={handleClose}
              disabled={loading}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#1a7ba8] transition-colors disabled:opacity-50 text-sm font-medium"
            >
              {loading ? 'Updating...' : 'Update Link'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EditOnboardingLinkModal;
