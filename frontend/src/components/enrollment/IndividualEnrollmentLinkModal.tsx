import { AlertCircle, Mail, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';
import { Member } from '../../types/member.types';

interface IndividualEnrollmentLinkModalProps {
  show: boolean;
  member: Member;
  onClose: () => void;
  onSuccess: () => void;
  setSuccessMessage: (message: string) => void;
}

interface EnrollmentLinkTemplate {
  templateId: string;
  templateName: string;
  templateType: string;
  linkMetaData: any;
}

const IndividualEnrollmentLinkModal: React.FC<IndividualEnrollmentLinkModalProps> = ({
  show,
  member,
  onClose,
  onSuccess,
  setSuccessMessage
}) => {
  const [templates, setTemplates] = useState<EnrollmentLinkTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch available enrollment link templates
  useEffect(() => {
    if (show) {
      fetchTemplates();
    }
  }, [show]);

  const fetchTemplates = async () => {
    try {
      setTemplatesLoading(true);
      // Get templates of type 'Individual' for individual member enrollment
      const response = await apiService.get<{success: boolean, data: EnrollmentLinkTemplate[]}>('/api/enrollment-link-templates?templateType=Individual');
      
      if (response.success) {
        setTemplates(response.data || []);
        if (response.data && response.data.length > 0) {
          setSelectedTemplate(response.data[0].templateId);
        }
      } else {
        setError('Failed to load enrollment templates');
      }
    } catch (error) {
      console.error('Error fetching templates:', error);
      setError('Failed to load enrollment templates');
    } finally {
      setTemplatesLoading(false);
    }
  };

  const handleSendLink = async () => {
    if (!selectedTemplate) {
      setError('Please select an enrollment template');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Create individual enrollment link
      const response = await apiService.post<{success: boolean, message?: string}>('/api/enrollment-links/send-individual', {
        memberId: member.MemberId,
        templateId: selectedTemplate,
        memberEmail: member.Email,
        memberName: `${member.FirstName} ${member.LastName}`
      });

      if (response.success) {
        setSuccessMessage(`Enrollment link sent to ${member.Email}`);
        onSuccess();
      } else {
        setError(response.message || 'Failed to send enrollment link');
      }
    } catch (error) {
      console.error('Error sending enrollment link:', error);
      setError('Failed to send enrollment link');
    } finally {
      setLoading(false);
    }
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center">
            <Mail className="h-6 w-6 text-oe-primary mr-3" />
            <h2 className="text-xl font-semibold text-gray-900">Send Enrollment Link</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Member Info */}
          <div className="mb-6 p-4 bg-gray-50 rounded-lg">
            <h3 className="font-medium text-gray-900 mb-2">Member Details</h3>
            <div className="space-y-1 text-sm text-gray-600">
              <p><strong>Name:</strong> {member.FirstName} {member.LastName}</p>
              <p><strong>Email:</strong> {member.Email}</p>
              <p><strong>Status:</strong> {member.Status}</p>
              {member.GroupName && (
                <p><strong>Group:</strong> {member.GroupName}</p>
              )}
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-start">
                <AlertCircle className="h-5 w-5 text-red-600 mr-2 mt-0.5 flex-shrink-0" />
                <div className="text-sm text-red-800">
                  <p className="font-medium mb-1">Cannot Send Enrollment Link</p>
                  <p>{error}</p>
                </div>
              </div>
            </div>
          )}

          {/* Template Selection */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Enrollment Template
            </label>
            {templatesLoading ? (
              <div className="flex items-center justify-center py-4">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary"></div>
                <span className="ml-2 text-sm text-gray-500">Loading templates...</span>
              </div>
            ) : templates.length === 0 ? (
              <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                <div className="flex items-center">
                  <AlertCircle className="h-5 w-5 text-yellow-600 mr-2" />
                  <span className="text-sm text-yellow-800">
                    No individual enrollment templates found. Please create one first.
                  </span>
                </div>
              </div>
            ) : (
              <select
                value={selectedTemplate}
                onChange={(e) => setSelectedTemplate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              >
                {templates.map((template) => (
                  <option key={template.templateId} value={template.templateId}>
                    {template.templateName}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Warning */}
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-start">
              <AlertCircle className="h-5 w-5 text-oe-primary mr-2 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-blue-800">
                <p className="font-medium mb-1">What happens next?</p>
                <ul className="space-y-1">
                  <li>• An enrollment link will be sent to {member.Email}</li>
                  <li>• The member can click the link to complete their enrollment</li>
                  <li>• They'll set up their password and select products</li>
                  <li>• Coverage will begin on the 1st of the following month</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSendLink}
            disabled={loading || templatesLoading || templates.length === 0 || !selectedTemplate}
            className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center"
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                Sending...
              </>
            ) : (
              <>
                <Mail className="h-4 w-4 mr-2" />
                Send Enrollment Link
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default IndividualEnrollmentLinkModal;
