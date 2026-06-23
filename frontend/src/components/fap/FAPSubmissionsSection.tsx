// components/fap/FAPSubmissionsSection.tsx
// FAP Forms & Submission Instructions Component

import { useEffect, useState } from 'react';
import {
  ExternalLink,
  FileText,
  Link as LinkIcon,
  Edit2,
  Save,
  X,
  Info,
  BookOpen,
  Phone,
  Mail,
  Clock
} from 'lucide-react';
import { apiService } from '../../services/api.service';
import { ProviderFAPSettings } from '../../types/fap.types';

interface FAPSubmissionsSectionProps {
  providerId: string;
  onUpdate: () => void;
}

const FAPSubmissionsSection: React.FC<FAPSubmissionsSectionProps> = ({
  providerId,
  onUpdate
}) => {
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<ProviderFAPSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<Partial<ProviderFAPSettings>>({});

  useEffect(() => {
    if (!providerId) {
      return;
    }
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const response = await apiService.get<{
        success: boolean;
        data: ProviderFAPSettings;
      }>(`/api/me/vendor/providers/${providerId}/fap/settings`);

      if (response.success && response.data) {
        setSettings(response.data);
        setFormData(response.data);
      } else {
        // Initialize empty settings if none exist
        setSettings(null);
        setFormData({
          providerId,
          fapWebsiteUrl: '',
          fapFormUrl: '',
          fapInstructionsUrl: '',
          providerSpecificRules: '',
          requiredDocumentation: ''
        });
      }
    } catch (err: any) {
      console.error('Error loading FAP settings:', err);
      // Initialize empty settings on error
      setSettings(null);
      setFormData({
        providerId,
        fapWebsiteUrl: '',
        fapFormUrl: '',
        fapInstructionsUrl: '',
        providerSpecificRules: '',
        requiredDocumentation: ''
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const response = await apiService.put<{
        success: boolean;
        data: ProviderFAPSettings;
      }>(`/api/me/vendor/providers/${providerId}/fap/settings`, formData);

      if (response.success) {
        setSettings(response.data);
        setEditing(false);
        onUpdate();
      }
    } catch (err: any) {
      console.error('Error saving FAP settings:', err);
      alert('Failed to save FAP settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setFormData(settings || {
      providerId,
      fapWebsiteUrl: '',
      fapFormUrl: '',
      fapInstructionsUrl: '',
      providerSpecificRules: '',
      requiredDocumentation: ''
    });
    setEditing(false);
  };

  const parseRequiredDocs = (docs?: string): string[] => {
    if (!docs) return [];
    try {
      const parsed = JSON.parse(docs);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // If not JSON, treat as comma-separated list
      return docs.split(',').map(d => d.trim()).filter(d => d.length > 0);
    }
  };

  const requiredDocs = parseRequiredDocs(formData.requiredDocumentation);

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin h-6 w-6 border-2 border-oe-primary border-t-transparent rounded-full mx-auto"></div>
        <p className="text-sm text-gray-500 mt-2">Loading FAP forms and instructions...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with Edit Button */}
      <div className="flex justify-between items-center">
        <div>
          <h4 className="text-sm font-semibold text-gray-900">FAP Forms & Submission Instructions</h4>
          <p className="text-xs text-gray-500 mt-1">
            Links to provider forms and notes on how to submit FAP applications
          </p>
        </div>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-oe-primary hover:text-oe-dark hover:bg-oe-light rounded-lg transition-colors"
          >
            <Edit2 className="h-4 w-4" />
            Edit
          </button>
        )}
      </div>

      {editing ? (
        /* Edit Mode */
        <div className="space-y-4 bg-gray-50 p-4 rounded-lg border border-gray-200">
          {/* FAP Website URL */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              FAP Website URL
            </label>
            <input
              type="url"
              value={formData.fapWebsiteUrl || ''}
              onChange={(e) => setFormData({ ...formData, fapWebsiteUrl: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="https://provider.com/financial-aid"
            />
            <p className="text-xs text-gray-500 mt-1">Link to the provider's main FAP information page</p>
          </div>

          {/* FAP Form URL */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              FAP Application Form URL
            </label>
            <input
              type="url"
              value={formData.fapFormUrl || ''}
              onChange={(e) => setFormData({ ...formData, fapFormUrl: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="https://provider.com/fap-application-form.pdf"
            />
            <p className="text-xs text-gray-500 mt-1">Direct link to download or access the FAP application form</p>
          </div>

          {/* FAP Instructions URL */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              FAP Instructions/Guide URL
            </label>
            <input
              type="url"
              value={formData.fapInstructionsUrl || ''}
              onChange={(e) => setFormData({ ...formData, fapInstructionsUrl: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="https://provider.com/fap-instructions"
            />
            <p className="text-xs text-gray-500 mt-1">Link to instructions or guide on how to complete the FAP application</p>
          </div>

          {/* Required Documentation */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Required Documentation
            </label>
            <textarea
              value={formData.requiredDocumentation || ''}
              onChange={(e) => setFormData({ ...formData, requiredDocumentation: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              rows={4}
              placeholder="Enter required documents, one per line or as a comma-separated list"
            />
            <p className="text-xs text-gray-500 mt-1">
              List of required documents (e.g., Income verification, Tax returns, Medical bills)
            </p>
          </div>

          {/* Provider-Specific Rules/Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Submission Notes & Instructions
            </label>
            <textarea
              value={formData.providerSpecificRules || ''}
              onChange={(e) => setFormData({ ...formData, providerSpecificRules: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              rows={6}
              placeholder="Enter notes about how to submit forms, special requirements, provider quirks, processing times, etc."
            />
            <p className="text-xs text-gray-500 mt-1">
              Important notes about submitting FAP applications to this provider
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <X className="h-4 w-4 inline mr-1" />
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              <Save className="h-4 w-4" />
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      ) : (
        /* View Mode */
        <div className="space-y-4">
          {/* Links Section */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h5 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <LinkIcon className="h-4 w-4 text-oe-primary" />
              FAP Forms & Links
            </h5>
            <div className="space-y-3">
              {/* FAP Website */}
              {formData.fapWebsiteUrl ? (
                <a
                  href={formData.fapWebsiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between p-3 bg-oe-light hover:bg-oe-primary-light rounded-lg border border-oe-primary-light transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-oe-primary-light rounded-lg">
                      <BookOpen className="h-4 w-4 text-oe-primary" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">FAP Information Website</div>
                      <div className="text-xs text-gray-500 truncate max-w-md">{formData.fapWebsiteUrl}</div>
                    </div>
                  </div>
                  <ExternalLink className="h-4 w-4 text-oe-primary group-hover:text-oe-dark" />
                </a>
              ) : (
                <div className="p-3 bg-gray-50 rounded-lg border border-gray-200 text-sm text-gray-500 text-center">
                  No FAP website URL configured
                </div>
              )}

              {/* FAP Form */}
              {formData.fapFormUrl ? (
                <a
                  href={formData.fapFormUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between p-3 bg-oe-light hover:bg-oe-primary-light rounded-lg border border-oe-primary-light transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-oe-primary-light rounded-lg">
                      <FileText className="h-4 w-4 text-oe-primary" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">FAP Application Form</div>
                      <div className="text-xs text-gray-500 truncate max-w-md">{formData.fapFormUrl}</div>
                    </div>
                  </div>
                  <ExternalLink className="h-4 w-4 text-oe-primary group-hover:text-oe-dark" />
                </a>
              ) : (
                <div className="p-3 bg-gray-50 rounded-lg border border-gray-200 text-sm text-gray-500 text-center">
                  No FAP form URL configured
                </div>
              )}

              {/* FAP Instructions */}
              {formData.fapInstructionsUrl ? (
                <a
                  href={formData.fapInstructionsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between p-3 bg-oe-light hover:bg-oe-primary-light rounded-lg border border-oe-primary-light transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-purple-100 rounded-lg">
                      <Info className="h-4 w-4 text-purple-600" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">FAP Instructions & Guide</div>
                      <div className="text-xs text-gray-500 truncate max-w-md">{formData.fapInstructionsUrl}</div>
                    </div>
                  </div>
                  <ExternalLink className="h-4 w-4 text-oe-primary group-hover:text-oe-dark" />
                </a>
              ) : (
                <div className="p-3 bg-gray-50 rounded-lg border border-gray-200 text-sm text-gray-500 text-center">
                  No FAP instructions URL configured
                </div>
              )}
            </div>
          </div>

          {/* Required Documentation */}
          {requiredDocs.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h5 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <FileText className="h-4 w-4 text-orange-600" />
                Required Documentation
              </h5>
              <ul className="space-y-2">
                {requiredDocs.map((doc, index) => (
                  <li key={index} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="text-orange-600 mt-0.5">•</span>
                    <span>{doc}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Submission Notes */}
          {formData.providerSpecificRules && (
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h5 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <Info className="h-4 w-4 text-oe-primary" />
                Submission Notes & Instructions
              </h5>
              <div className="prose prose-sm max-w-none">
                <div className="text-sm text-gray-700 whitespace-pre-wrap">
                  {formData.providerSpecificRules}
                </div>
              </div>
            </div>
          )}

          {/* Contact Information (if available) */}
          {(formData.primaryContactName || formData.primaryContactPhone || formData.primaryContactEmail) && (
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h5 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <Phone className="h-4 w-4 text-gray-600" />
                FAP Contact Information
              </h5>
              <div className="space-y-2 text-sm">
                {formData.primaryContactName && (
                  <div className="text-gray-700">
                    <span className="font-medium">Contact:</span> {formData.primaryContactName}
                  </div>
                )}
                {formData.primaryContactPhone && (
                  <div className="text-gray-700 flex items-center gap-2">
                    <Phone className="h-3 w-3 text-gray-400" />
                    {formData.primaryContactPhone}
                  </div>
                )}
                {formData.primaryContactEmail && (
                  <div className="text-gray-700 flex items-center gap-2">
                    <Mail className="h-3 w-3 text-gray-400" />
                    <a href={`mailto:${formData.primaryContactEmail}`} className="text-oe-primary hover:text-oe-primary-dark">
                      {formData.primaryContactEmail}
                    </a>
                  </div>
                )}
                {formData.expectedProcessingTimeDays && (
                  <div className="text-gray-700 flex items-center gap-2 mt-2 pt-2 border-t border-gray-200">
                    <Clock className="h-3 w-3 text-gray-400" />
                    <span>Expected processing time: <strong>{formData.expectedProcessingTimeDays} days</strong></span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Empty State */}
          {!formData.fapWebsiteUrl && !formData.fapFormUrl && !formData.fapInstructionsUrl && 
           !formData.providerSpecificRules && requiredDocs.length === 0 && (
            <div className="text-center py-8 bg-gray-50 rounded-lg border border-gray-200">
              <FileText className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">No FAP forms or instructions configured</p>
              <p className="text-xs text-gray-400 mt-1">Click "Edit" to add links and submission notes</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default FAPSubmissionsSection;
