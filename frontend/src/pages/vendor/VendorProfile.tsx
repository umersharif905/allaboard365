// frontend/src/pages/vendor/VendorProfile.tsx
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';
import { Building2, Save } from 'lucide-react';

interface VendorProfileData {
  Id: string;
  VendorName: string;
  AddressLine1?: string;
  AddressLine2?: string;
  City?: string;
  State?: string;
  Zip?: string;
  ContactName?: string;
  Phone?: string;
  Email?: string;
}

const VendorProfile: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<VendorProfileData>({
    Id: '',
    VendorName: '',
    AddressLine1: '',
    AddressLine2: '',
    City: '',
    State: '',
    Zip: '',
    ContactName: '',
    Phone: '',
    Email: ''
  });
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const loadProfile = async () => {
      try {
        setLoading(true);
        const response = await apiService.get<{ success: boolean; data?: any }>('/api/me/vendor/profile');
        if (response?.success && response.data) {
          setFormData(response.data);
        }
      } catch (error) {
        console.error('Error loading vendor profile:', error);
        setMessage({ type: 'error', text: 'Failed to load vendor profile' });
      } finally {
        setLoading(false);
      }
    };

    loadProfile();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      setMessage(null);
      const response = await apiService.put<{ success: boolean; message?: string }>('/api/me/vendor/profile', formData);
      if (response?.success) {
        setMessage({ type: 'success', text: 'Vendor profile updated successfully' });
      } else {
        setMessage({ type: 'error', text: response?.message || 'Failed to update profile' });
      }
    } catch (error: any) {
      console.error('Error updating vendor profile:', error);
      setMessage({ type: 'error', text: error?.response?.data?.message || 'Failed to update profile' });
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (field: keyof VendorProfileData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };


  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <Building2 className="h-6 w-6 text-oe-primary" />
        <h1 className="text-2xl font-semibold text-gray-900">Vendor Details</h1>
      </div>

      {message && (
        <div className={`mb-4 p-4 rounded-lg ${
          message.type === 'success' 
            ? 'bg-green-50 border border-green-200 text-green-800' 
            : 'bg-red-50 border border-red-200 text-red-800'
        }`}>
          {message.text}
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Vendor Name *
            </label>
            <input
              type="text"
              required
              value={formData.VendorName}
              onChange={(e) => handleChange('VendorName', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Address Line 1
            </label>
            <input
              type="text"
              value={formData.AddressLine1 || ''}
              onChange={(e) => handleChange('AddressLine1', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Address Line 2
            </label>
            <input
              type="text"
              value={formData.AddressLine2 || ''}
              onChange={(e) => handleChange('AddressLine2', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              City
            </label>
            <input
              type="text"
              value={formData.City || ''}
              onChange={(e) => handleChange('City', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              State
            </label>
            <input
              type="text"
              value={formData.State || ''}
              onChange={(e) => handleChange('State', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              ZIP Code
            </label>
            <input
              type="text"
              value={formData.Zip || ''}
              onChange={(e) => handleChange('Zip', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Contact Name
            </label>
            <input
              type="text"
              value={formData.ContactName || ''}
              onChange={(e) => handleChange('ContactName', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Phone
            </label>
            <input
              type="tel"
              value={formData.Phone || ''}
              onChange={(e) => handleChange('Phone', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              type="email"
              value={formData.Email || ''}
              onChange={(e) => handleChange('Email', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark focus:ring-2 focus:ring-oe-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default VendorProfile;

