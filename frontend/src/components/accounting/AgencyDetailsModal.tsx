// frontend/src/components/accounting/AgencyDetailsModal.tsx
import { Building2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { TenantAdminAgentsService } from '../../services/tenant-admin/agents.service';

interface AgencyDetailsModalProps {
  agencyId: string;
  agencyName?: string;
  isOpen: boolean;
  onClose: () => void;
}

const AgencyDetailsModal: React.FC<AgencyDetailsModalProps> = ({
  agencyId,
  agencyName: initialAgencyName,
  isOpen,
  onClose
}) => {
  const [agency, setAgency] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && agencyId) {
      fetchAgencyData();
    }
  }, [isOpen, agencyId]);

  const fetchAgencyData = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await TenantAdminAgentsService.getAgencyDetails(agencyId);
      
      if (response.success && response.data) {
        setAgency(response.data);
      } else {
        throw new Error(response.message || 'Failed to load agency details');
      }
    } catch (err: any) {
      console.error('Error fetching agency data:', err);
      setError(err.message || 'Failed to load agency information');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const displayName = agency?.AgencyName || initialAgencyName || 'Unknown Agency';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <Building2 className="w-6 h-6 text-oe-primary" />
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">Agency Details</h2>
              <p className="text-sm text-gray-600 mt-1">{displayName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
              <span className="ml-3 text-gray-600">Loading agency details...</span>
            </div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center gap-2">
                <X className="w-5 h-5 text-red-500" />
                <span className="text-red-700">{error}</span>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Agency Information */}
              <div className="bg-gray-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Contact Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {agency?.ContactName && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-700">Contact Name:</span>
                      <span className="text-gray-700">{agency.ContactName}</span>
                    </div>
                  )}
                  {agency?.AgencyName && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-700">Agency Name:</span>
                      <span className="text-gray-700">{agency.AgencyName}</span>
                    </div>
                  )}
                  {agency?.AgencyCode && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-700">Agency Code:</span>
                      <span className="text-gray-700">{agency.AgencyCode}</span>
                    </div>
                  )}
                  {agency?.AgencyType && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-700">Agency Type:</span>
                      <span className="text-gray-700">{agency.AgencyType}</span>
                    </div>
                  )}
                  {agency?.EIN && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-700">EIN:</span>
                      <span className="text-gray-700">{agency.EIN}</span>
                    </div>
                  )}
                  {agency?.CommissionRole && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-700">Commission Role:</span>
                      <span className="text-gray-700">{agency.CommissionRole}</span>
                    </div>
                  )}
                  {agency?.DistributionChannel && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-700">Distribution Channel:</span>
                      <span className="text-gray-700">{agency.DistributionChannel}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Address Information */}
              {(agency?.Address || agency?.City || agency?.State || agency?.ZipCode) && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Address</h3>
                  <div className="text-sm text-gray-700">
                    {agency.Address && <div>{agency.Address}</div>}
                    {(agency.City || agency.State || agency.ZipCode) && (
                      <div>
                        {agency.City && agency.City}
                        {agency.City && agency.State && ', '}
                        {agency.State && agency.State}
                        {agency.ZipCode && ` ${agency.ZipCode}`}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Banking Information */}
              {(agency?.BankName || agency?.AccountHolderName || agency?.AccountNumberLast4) && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Banking Information</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {agency?.BankName && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-gray-700">Bank Name:</span>
                        <span className="text-gray-700">{agency.BankName}</span>
                      </div>
                    )}
                    {agency?.AccountHolderName && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-gray-700">Account Holder:</span>
                        <span className="text-gray-700">{agency.AccountHolderName}</span>
                      </div>
                    )}
                    {agency?.AccountType && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-gray-700">Account Type:</span>
                        <span className="text-gray-700">{agency.AccountType}</span>
                      </div>
                    )}
                    {agency?.AccountNumberLast4 && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-gray-700">Account Number:</span>
                        <span className="text-gray-700">****{agency.AccountNumberLast4}</span>
                      </div>
                    )}
                    {agency?.AchRoutingNumber && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-gray-700">Routing Number:</span>
                        <span className="text-gray-700">{agency.AchRoutingNumber}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 p-4 bg-gray-50">
          <div className="flex items-center justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgencyDetailsModal;

