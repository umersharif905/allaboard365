// Standalone "Create provider" modal — the same NPI-lookup-and-form
// experience the standalone Providers page offers, packaged as a component
// other surfaces (notably the SR Providers tab) can mount inline.
//
// On successful create the modal closes itself and calls `onCreated(provider)`
// with a Provider-shaped object built from the submitted form + the new
// ProviderId. Caller decides what to do next (e.g. auto-select + link).

import { useEffect, useState } from 'react';
import { Save, Search, X } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import type { Provider } from '../../../types/shareRequest.types';

interface CreateProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the newly-created provider's record (best-effort shape:
   *  the fields the form collected plus the returned ProviderId). */
  onCreated: (provider: Provider) => void;
  /** Pre-fill the Provider Name field — typically the search term that
   *  came up empty in the caller's search box. */
  initialName?: string;
}

const PROVIDER_TYPES = [
  'Hospital',
  'Physician',
  'Clinic',
  'Lab',
  'Pharmacy',
  'Specialist',
  'Urgent Care',
  'Emergency Room',
  'Imaging Center',
  'Surgery Center',
  'Other',
];

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
  'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC',
];

type FormData = {
  providerName: string;
  providerType: string;
  npi: string;
  phone: string;
  fax: string;
  email: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zipCode: string;
  specialty: string;
  isActive: boolean;
};

const blankForm = (initialName?: string): FormData => ({
  providerName: initialName ?? '',
  providerType: '',
  npi: '',
  phone: '',
  fax: '',
  email: '',
  address1: '',
  address2: '',
  city: '',
  state: '',
  zipCode: '',
  specialty: '',
  isActive: true,
});

interface NpiResult {
  providerName?: string;
  providerType?: string;
  npi?: string;
  phone?: string;
  fax?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  specialty?: string;
}

const CreateProviderModal = ({
  isOpen,
  onClose,
  onCreated,
  initialName,
}: CreateProviderModalProps) => {
  const [formData, setFormData] = useState<FormData>(() => blankForm(initialName));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // NPI direct-lookup state.
  const [lookingUpNPI, setLookingUpNPI] = useState(false);
  const [npiLookupError, setNpiLookupError] = useState('');

  // NPI registry search state.
  const [npiSearchFields, setNpiSearchFields] = useState({
    organizationName: '',
    lastName: '',
    city: '',
    state: '',
  });
  const [npiSearchResults, setNpiSearchResults] = useState<NpiResult[]>([]);
  const [searchingNPI, setSearchingNPI] = useState(false);

  // Reset state whenever the modal opens — keeps a stale form from a
  // previous open from leaking into the next one.
  useEffect(() => {
    if (!isOpen) return;
    setFormData(blankForm(initialName));
    setSaving(false);
    setSaveError(null);
    setLookingUpNPI(false);
    setNpiLookupError('');
    setNpiSearchFields({ organizationName: '', lastName: '', city: '', state: '' });
    setNpiSearchResults([]);
    setSearchingNPI(false);
  }, [isOpen, initialName]);

  if (!isOpen) return null;

  const lookupNPI = async () => {
    if (!/^\d{10}$/.test(formData.npi)) {
      setNpiLookupError('NPI must be exactly 10 digits');
      return;
    }
    setLookingUpNPI(true);
    setNpiLookupError('');
    try {
      const response = await apiService.get<{
        success: boolean;
        data: NpiResult | null;
        message?: string;
      }>(`/api/me/vendor/npi/lookup/${formData.npi}`);
      if (response.success && response.data) {
        const d = response.data;
        setFormData({
          ...formData,
          providerName: d.providerName || formData.providerName,
          providerType: d.providerType || '',
          npi: d.npi || formData.npi,
          phone: d.phone || '',
          fax: d.fax || '',
          address1: d.address1 || '',
          address2: d.address2 || '',
          city: d.city || '',
          state: d.state || '',
          zipCode: d.zipCode || '',
          specialty: d.specialty || '',
          isActive: true,
        });
      } else {
        setNpiLookupError(response.message || 'NPI not found in registry');
      }
    } catch (err) {
      setNpiLookupError(err instanceof Error ? err.message : 'Failed to lookup NPI');
    } finally {
      setLookingUpNPI(false);
    }
  };

  const searchNPIRegistry = async () => {
    const { organizationName, lastName, city, state } = npiSearchFields;
    if (!organizationName && !lastName) {
      setNpiLookupError('Enter an Organization Name or Last Name');
      return;
    }
    setSearchingNPI(true);
    setNpiLookupError('');
    try {
      const params = new URLSearchParams();
      if (organizationName) params.append('organizationName', organizationName);
      if (lastName) params.append('lastName', lastName);
      if (city) params.append('city', city);
      if (state) params.append('state', state);
      params.append('limit', '30');
      const response = await apiService.get<{ success: boolean; data: NpiResult[] }>(
        `/api/me/vendor/npi/search?${params.toString()}`
      );
      if (response.success) {
        setNpiSearchResults(response.data || []);
        if ((response.data || []).length === 0) {
          setNpiLookupError('No providers found matching your search criteria');
        }
      }
    } catch (err) {
      setNpiLookupError(err instanceof Error ? err.message : 'Failed to search NPI Registry');
      setNpiSearchResults([]);
    } finally {
      setSearchingNPI(false);
    }
  };

  const selectNPIResult = (result: NpiResult) => {
    setFormData({
      ...formData,
      providerName: result.providerName || '',
      providerType: result.providerType || '',
      npi: result.npi || '',
      phone: result.phone || '',
      fax: result.fax || '',
      address1: result.address1 || '',
      address2: result.address2 || '',
      city: result.city || '',
      state: result.state || '',
      zipCode: result.zipCode || '',
      specialty: result.specialty || '',
      isActive: true,
    });
    setNpiSearchResults([]);
    setNpiSearchFields({ organizationName: '', lastName: '', city: '', state: '' });
  };

  const handleSubmit = async () => {
    setSaveError(null);
    if (!formData.providerName.trim()) {
      setSaveError('Provider name is required');
      return;
    }
    setSaving(true);
    try {
      const response = await apiService.post<{
        success: boolean;
        data?: { providerId: string };
        message?: string;
      }>('/api/me/vendor/providers', formData);
      if (!response.success || !response.data?.providerId) {
        throw new Error(response.message || 'Failed to create provider');
      }
      // Build a Provider-shaped object the caller can use to render the
      // newly-created row without a separate refetch.
      const created: Provider = {
        ProviderId: response.data.providerId,
        VendorId: '',
        ProviderName: formData.providerName.trim(),
        ProviderType: formData.providerType || undefined,
        NPI: formData.npi || undefined,
        Phone: formData.phone || undefined,
        Fax: formData.fax || undefined,
        Email: formData.email || undefined,
        Address1: formData.address1 || undefined,
        Address2: formData.address2 || undefined,
        City: formData.city || undefined,
        State: formData.state || undefined,
        ZipCode: formData.zipCode || undefined,
        IsActive: formData.isActive,
        CreatedDate: new Date().toISOString(),
      };
      onCreated(created);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create provider';
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-provider-title"
      // Sits above the SR "Add provider" modal (z-30) so nested rendering works.
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 id="create-provider-title" className="text-lg font-semibold text-gray-900">
            Create new provider
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-4 min-h-0">
          {/* NPI Lookup */}
          <div className="bg-oe-light border border-oe-primary/30 rounded-lg p-4">
            <label className="block text-sm font-medium text-oe-primary mb-2">
              Lookup from NPI Registry
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={formData.npi}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    npi: e.target.value.replace(/\D/g, '').slice(0, 10),
                  })
                }
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                placeholder="Enter 10-digit NPI number"
                maxLength={10}
              />
              <button
                type="button"
                onClick={lookupNPI}
                disabled={lookingUpNPI || formData.npi.length !== 10}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 whitespace-nowrap"
              >
                {lookingUpNPI ? 'Looking up…' : 'Lookup NPI'}
              </button>
            </div>
            {npiLookupError && <p className="text-sm text-red-600 mt-2">{npiLookupError}</p>}

            {/* NPI Search */}
            <div className="mt-3 pt-3 border-t border-oe-primary/30">
              <label className="block text-sm font-medium text-oe-primary mb-2">
                Or search NPI Registry:
              </label>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Organization Name</label>
                  <input
                    type="text"
                    value={npiSearchFields.organizationName}
                    onChange={(e) =>
                      setNpiSearchFields({
                        ...npiSearchFields,
                        organizationName: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="e.g., Baptist Hospital"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Last Name</label>
                  <input
                    type="text"
                    value={npiSearchFields.lastName}
                    onChange={(e) =>
                      setNpiSearchFields({ ...npiSearchFields, lastName: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="e.g., Smith"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">City</label>
                  <input
                    type="text"
                    value={npiSearchFields.city}
                    onChange={(e) =>
                      setNpiSearchFields({ ...npiSearchFields, city: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="e.g., Dallas"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">State</label>
                  <select
                    value={npiSearchFields.state}
                    onChange={(e) =>
                      setNpiSearchFields({ ...npiSearchFields, state: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="">All States</option>
                    {US_STATES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <button
                type="button"
                onClick={searchNPIRegistry}
                disabled={
                  searchingNPI ||
                  (!npiSearchFields.organizationName && !npiSearchFields.lastName)
                }
                className="w-full px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {searchingNPI ? (
                  <>
                    <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                    Searching…
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4" />
                    Search NPI Registry
                  </>
                )}
              </button>
              {npiSearchResults.length > 0 && (
                <div className="mt-3 border border-oe-primary/30 rounded-lg max-h-64 overflow-y-auto bg-white">
                  <div className="sticky top-0 bg-oe-light px-3 py-1.5 text-xs text-oe-primary font-medium border-b border-oe-primary/30">
                    {npiSearchResults.length} result
                    {npiSearchResults.length !== 1 ? 's' : ''} found — click to select
                  </div>
                  {npiSearchResults.map((result, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => selectNPIResult(result)}
                      className="w-full px-3 py-2.5 text-left hover:bg-oe-light border-b border-gray-100 last:border-0"
                    >
                      <div className="flex justify-between items-start">
                        <div className="font-medium text-gray-900">{result.providerName}</div>
                        {result.npi && (
                          <span className="font-mono text-xs text-oe-primary bg-oe-light px-2 py-0.5 rounded">
                            {result.npi}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-gray-500 mt-0.5">
                        {result.providerType && (
                          <span className="inline-block bg-gray-100 text-gray-700 text-xs px-1.5 py-0.5 rounded mr-2">
                            {result.providerType}
                          </span>
                        )}
                        {result.specialty && <span>{result.specialty}</span>}
                      </div>
                      {(result.city || result.state || result.address1) && (
                        <div className="text-xs text-gray-400 mt-1">
                          {result.address1 && <span>{result.address1}, </span>}
                          {result.city && <span>{result.city}, </span>}
                          {result.state} {result.zipCode}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Manual form fields */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Provider Name *
            </label>
            <input
              type="text"
              value={formData.providerName}
              onChange={(e) => setFormData({ ...formData, providerName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="Hospital or practice name"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
              <select
                value={formData.providerType}
                onChange={(e) => setFormData({ ...formData, providerType: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="">Select type</option>
                {PROVIDER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Specialty</label>
              <input
                type="text"
                value={formData.specialty}
                onChange={(e) => setFormData({ ...formData, specialty: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                placeholder="e.g., Internal Medicine"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input
                type="tel"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                placeholder="(555) 123-4567"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Fax</label>
              <input
                type="tel"
                value={formData.fax}
                onChange={(e) => setFormData({ ...formData, fax: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                placeholder="(555) 123-4568"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="billing@provider.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
            <input
              type="text"
              value={formData.address1}
              onChange={(e) => setFormData({ ...formData, address1: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-2 focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="Street address"
            />
            <input
              type="text"
              value={formData.address2}
              onChange={(e) => setFormData({ ...formData, address2: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="Suite, unit, etc. (optional)"
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
              <input
                type="text"
                value={formData.city}
                onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
              <input
                type="text"
                value={formData.state}
                onChange={(e) =>
                  setFormData({ ...formData, state: e.target.value.toUpperCase() })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                placeholder="TX"
                maxLength={2}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ZIP Code</label>
              <input
                type="text"
                value={formData.zipCode}
                onChange={(e) => setFormData({ ...formData, zipCode: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                placeholder="12345"
                maxLength={10}
              />
            </div>
          </div>
          <div className="flex items-center pt-2">
            <input
              type="checkbox"
              id="create-provider-active"
              checked={formData.isActive}
              onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
              className="h-4 w-4 text-oe-primary rounded border-gray-300 focus:ring-oe-primary"
            />
            <label htmlFor="create-provider-active" className="ml-2 text-sm text-gray-700">
              Active provider
            </label>
          </div>

          {saveError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              {saveError}
            </div>
          )}
        </div>

        <div className="p-6 border-t border-gray-200 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || !formData.providerName.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-oe-primary hover:bg-oe-dark text-white rounded-lg disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving…' : 'Create provider'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreateProviderModal;
