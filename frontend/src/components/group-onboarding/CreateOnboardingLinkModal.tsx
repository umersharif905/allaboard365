import { CheckCircle, Send, X } from 'lucide-react';
import React, { useState } from 'react';
import { GroupOnboardingService } from '../../services/group-onboarding.service';

interface CreateOnboardingLinkModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string;
  groupName: string;
  onLinkCreated?: (linkData: any) => void;
}

const CreateOnboardingLinkModal: React.FC<CreateOnboardingLinkModalProps> = ({
  isOpen,
  onClose,
  groupId,
  groupName,
  onLinkCreated
}) => {
  const [sendEmail, setSendEmail] = useState(false);
  const [groupAdminEmail, setGroupAdminEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [linkData, setLinkData] = useState<any>(null);

  const handleSubmit = async () => {
    if (sendEmail && !groupAdminEmail) {
      setError('Please enter the group admin email address');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const response = await GroupOnboardingService.createOnboardingLink(
        groupId,
        sendEmail,
        sendEmail ? groupAdminEmail : undefined
      );

      if (response.success) {
        setLinkData(response.data);
        setSuccess(true);
        
        // Console log the link for testing
        console.log('🔗 Group Onboarding Link Created:', response.data.onboardingUrl);
        
        if (onLinkCreated) {
          onLinkCreated(response.data);
        }
      } else {
        setError(response.message || 'Failed to create onboarding link');
      }
    } catch (err) {
      setError('Failed to create onboarding link');
      console.error('Error creating onboarding link:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setSendEmail(false);
    setGroupAdminEmail('');
    setError(null);
    setSuccess(false);
    setLinkData(null);
    onClose();
  };

  const copyLinkToClipboard = () => {
    if (linkData?.onboardingUrl) {
      navigator.clipboard.writeText(linkData.onboardingUrl);
      // You could add a toast notification here
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900">Send Group Onboarding Link</h3>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-500"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!success ? (
          <>
            <div className="mb-4">
              <p className="text-sm text-gray-600 mb-4">
                Create an onboarding link for <strong>{groupName}</strong> to allow the group administrator to complete the setup process.
              </p>
            </div>

            <div className="space-y-4">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="sendEmail"
                  checked={sendEmail}
                  onChange={(e) => setSendEmail(e.target.checked)}
                  className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                />
                <label htmlFor="sendEmail" className="ml-2 text-sm text-gray-700">
                  Send onboarding link via email
                </label>
              </div>

              {sendEmail && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Group Admin Email Address <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    value={groupAdminEmail}
                    onChange={(e) => setGroupAdminEmail(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="Enter group admin email address"
                    required
                  />
                </div>
              )}

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg">
                  {error}
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button
                onClick={handleClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-lg hover:bg-oe-primary-dark disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center"
              >
                {loading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                    Creating...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    Create Link
                  </>
                )}
              </button>
            </div>
          </>
        ) : (
          <div className="text-center">
            <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 mb-4">
              <CheckCircle className="h-6 w-6 text-green-600" />
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              Onboarding Link Created!
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              {sendEmail ? 'The onboarding link has been sent to the group admin.' : 'Share this link with the group admin to complete the onboarding process.'}
            </p>
            
            {linkData && (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
                <p className="text-xs text-gray-500 mb-2">Onboarding Link:</p>
                <div className="flex items-center space-x-2">
                  <input
                    type="text"
                    value={linkData.onboardingUrl}
                    readOnly
                    className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded bg-white"
                  />
                  <button
                    onClick={copyLinkToClipboard}
                    className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Expires: {new Date(linkData.expiresAt).toLocaleString()}
                </p>
              </div>
            )}

            <div className="flex justify-center space-x-3">
              <button
                onClick={handleClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CreateOnboardingLinkModal;
