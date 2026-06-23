import { useEffect, useState } from 'react';
import { apiService } from '../../../services/apiServices';
import { ReviewStepProps, Tenant, Vendor } from '../../../types/sysadmin/addproductswizard.types';
import { memberRetailFromMsrpRate } from '../../../utils/wizardPricingMsrp';
import { MAX_CONFIGURATION_FIELDS } from '../AddProductWizard';

type Step10ReviewProps = ReviewStepProps & {
  submitBlockers?: string[];
};
export default function Step10Review({
  formData,
  editingProduct,
  isTenantAdmin = false,
  submitBlockers = [],
}: Step10ReviewProps) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);

  const includeProcessingFee = formData.includeProcessingFee === true;
  const roundUpProcessingFee = formData.roundUpProcessingFee !== false;
  const feePct = formData.processingFeePercentage;

  const round2 = (n: number) => Math.round(Number(n || 0) * 100) / 100;

  const memberTotalForBand = (msrpRate: number) => memberRetailFromMsrpRate(msrpRate);

  const processingFeeForBand = (includedProcessingFee?: number) => {
    if (!includeProcessingFee) return 0;
    return round2(Number(includedProcessingFee || 0));
  };

  useEffect(() => {
    // Fetch vendors and tenants for display names
    const fetchData = async () => {
      try {
        // Fetch vendors
        const vendorData = await apiService.get<{ success: boolean; data?: Vendor[] }>('/api/vendors');
        if (vendorData.success) setVendors(vendorData.data || []);

        // Fetch tenants (only for SysAdmin, not TenantAdmin)
        if (!isTenantAdmin) {
          const tenantData = await apiService.get<{ success: boolean; data?: Tenant[] }>('/api/tenants');
          if (tenantData.success) setTenants(tenantData.data || []);
        } else {
          // For TenantAdmin, fetch their own tenant info
          const tenantData = await apiService.get<{ success: boolean; data?: Tenant }>('/api/me/tenant-admin/tenant');
          if (tenantData.success && tenantData.data) setTenants([tenantData.data]);
        }
      } catch (error) {
        console.error('Error fetching data:', error);
      }
    };

    fetchData();
  }, [isTenantAdmin]);

  const vendorName = vendors.find(v => v.Id === formData.vendorId)?.VendorName || 'Not specified';
  const tenantName = tenants.find(t => t.TenantId === formData.productOwnerId)?.Name || 'Not specified';

  return (
    <div className="space-y-6">
      <h3 className="text-xl font-bold text-oe-text">Review & {editingProduct ? 'Update' : 'Create'} Product</h3>
      
      <div className="card hover-lift space-y-6">
        {/* Vendor Information */}
        <div>
          <h4 className="font-semibold text-oe-text mb-3">Vendor Information</h4>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-600">Vendor:</span> 
              <span className="ml-2 font-medium">{vendorName}</span>
            </div>
            <div>
              <span className="text-gray-600">Vendor Pricing:</span> 
              <span className="ml-2 font-medium">
                {formData.isVendorPricing ? `Yes (Commission: $${formData.vendorCommission || 0})` : 'No'}
              </span>
            </div>
          </div>
        </div>

        {/* Product Information */}
        <div>
          <h4 className="font-semibold text-oe-text mb-3">Product Information</h4>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-600">Name:</span> 
              <span className="ml-2 font-medium">{formData.name || 'Not specified'}</span>
            </div>
            <div>
              <span className="text-gray-600">Product Type:</span> 
              <span className="ml-2 font-medium">{formData.productType || 'Not specified'}</span>
            </div>
            <div>
              <span className="text-gray-600">Product Owner:</span> 
              <span className="ml-2 font-medium">{tenantName}</span>
            </div>
            <div>
              <span className="text-gray-600">Sales Type:</span> 
              <span className="ml-2 font-medium">{formData.salesType}</span>
            </div>
            <div>
              <span className="text-gray-600">Age Range:</span> 
              <span className="ml-2 font-medium">{formData.minAge} - {formData.maxAge}</span>
            </div>
            <div>
              <span className="text-gray-600">Available States:</span> 
              <span className="ml-2 font-medium">{formData.allowedStates.length} states</span>
            </div>
            {/* Tobacco Info section hidden for now */}
            {false && (
              <div>
                <span className="text-gray-600">Tobacco Info Required:</span> 
                <span className="ml-2 font-medium">{formData.requiresTobaccoInfo ? 'Yes' : 'No'}</span>
              </div>
            )}
            <div>
              <span className="text-gray-600">Required Licenses:</span> 
              <span className="ml-2 font-medium">
                {formData.requiredLicenses.length > 0 ? formData.requiredLicenses.join(', ') : 'None specified'}
              </span>
            </div>
            <div>
              <span className="text-gray-600">SSN Required:</span> 
              <span className="ml-2 font-medium">{formData.isSSNRequired ? 'Yes' : 'No'}</span>
            </div>
          </div>
        </div>

        {/* Configuration Fields */}
        <div>
          <h4 className="font-semibold text-oe-text mb-2">Configuration Fields</h4>
          <p className="text-sm text-gray-600">
            {formData.configurationFields.length} of {MAX_CONFIGURATION_FIELDS} configuration field(s) defined
          </p>
          {formData.configurationFields.length > 0 && (
            <div className="text-xs text-gray-500 mt-1">
              {formData.configurationFields.map(field => field.fieldName).filter(name => name).join(', ')}
            </div>
          )}
        </div>

        {/* Pricing Tiers */}
        <div>
          <h4 className="font-semibold text-oe-text mb-2">Pricing Tiers</h4>
          <p className="text-sm text-gray-600 mb-3">
            {formData.pricingTiers.length} pricing tier(s) configured
            {includeProcessingFee && (
              <>
                {' '}
                · Processing fee included
                {feePct != null ? ` (${feePct}%)` : ''}
                {roundUpProcessingFee ? ', rounded up' : ''}
              </>
            )}
          </p>
          {formData.pricingTiers.length > 0 && (
            <div className="space-y-4">
              {formData.pricingTiers.map((tier, tierIndex) => (
                <div key={tier.id || tierIndex} className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                  <div className="font-medium text-sm text-gray-900 mb-2">
                    {tier.label || `Tier ${tierIndex + 1}`} ({tier.tierType})
                  </div>
                  <div className="space-y-2">
                    {tier.ageBands.map((band, bandIndex) => {
                      const msrp = band.msrpRate || 0;
                      const procFee = processingFeeForBand(band.includedProcessingFee);
                      const memberTotal = memberTotalForBand(msrp);
                      return (
                      <div key={band.id || bandIndex} className="bg-white rounded p-2 border border-gray-100">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-gray-900">
                            Ages {band.minAge}-{band.maxAge} ({band.tobaccoStatus || 'N/A'})
                          </span>
                          <span className="text-sm font-semibold text-gray-900">
                            ${memberTotal.toFixed(2)}/mo
                            {includeProcessingFee && procFee > 0 && (
                              <span className="text-xs font-normal text-gray-500 ml-1">incl. fee</span>
                            )}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 space-y-0.5">
                          <div className="flex justify-between">
                            <span>Vendor:</span>
                            <span>${(band.netRate || 0).toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Override:</span>
                            <span>${(band.overrideRate || 0).toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Commission:</span>
                            <span>${(band.commission || 0).toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between border-t border-gray-100 pt-0.5 mt-0.5">
                            <span>MSRP:</span>
                            <span>${msrp.toFixed(2)}</span>
                          </div>
                          {includeProcessingFee && procFee > 0 && (
                            <div className="flex justify-between">
                              <span>Processing fee:</span>
                              <span>${procFee.toFixed(2)}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Acknowledgement Questions */}
        <div>
          <h4 className="font-semibold text-oe-text mb-2">Acknowledgement Questions</h4>
          <p className="text-sm text-gray-600">
            {formData.acknowledgementQuestions.length} question(s) configured
          </p>
        </div>

        {/* Media Files */}
        <div>
          <h4 className="font-semibold text-oe-text mb-2">Media Files</h4>
          <div className="space-y-3">
            {/* Product Image */}
            <div>
              <div className="text-sm font-medium text-gray-700 mb-1">Product Image</div>
              {formData.productImageFile ? (
                <div className="text-sm text-green-600">✓ New file selected</div>
              ) : (formData as any).productImageUrl ? (
                <div className="flex items-center gap-2">
                  <img src={(formData as any).productImageUrl} alt="Product" className="w-16 h-16 object-contain border border-gray-200 rounded" />
                  <span className="text-sm text-gray-600">Existing image</span>
                </div>
              ) : (
                <div className="text-sm text-gray-500">None</div>
              )}
            </div>
            
            {/* Product Logo */}
            <div>
              <div className="text-sm font-medium text-gray-700 mb-1">Product Logo</div>
              {formData.productLogoFile ? (
                <div className="text-sm text-green-600">✓ New file selected</div>
              ) : (formData as any).productLogoUrl ? (
                <div className="flex items-center gap-2">
                  <img src={(formData as any).productLogoUrl} alt="Logo" className="w-16 h-16 object-contain border border-gray-200 rounded" />
                  <span className="text-sm text-gray-600">Existing logo</span>
                </div>
              ) : (
                <div className="text-sm text-gray-500">None</div>
              )}
            </div>
            
            {/* Product Documents */}
            <div>
              <div className="text-sm font-medium text-gray-700 mb-1">Product Documents</div>
              <div className="text-sm text-gray-600">
                {(formData.productDocuments && formData.productDocuments.length > 0) || (formData.productDocumentFiles && formData.productDocumentFiles.length > 0) ? (
                  <ul className="list-disc list-inside space-y-0.5">
                    {(formData.productDocuments || []).map((d, i) => (
                      <li key={d.productDocumentId ?? d.documentUrl ?? i}>
                        {d.displayName?.trim() || `Document ${i + 1}`}
                      </li>
                    ))}
                    {(formData.productDocumentFiles || []).map((item, i) => (
                      <li key={`new-${i}`}>
                        <span className="text-green-600">New:</span> {item.displayName?.trim() || item.file.name || 'Document'}
                      </li>
                    ))}
                  </ul>
                ) : formData.productDocumentFile ? (
                  <>✓ New file: {(formData as any).productDocumentName || formData.productDocumentFile.name || 'Document'}</>
                ) : (formData as any).productDocumentUrl ? (
                  <>Existing: {(formData as any).productDocumentName || 'Document'}</>
                ) : (
                  'None'
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ID Card Configuration */}
        <div>
          <h4 className="font-semibold text-oe-text mb-2">ID Card Configuration</h4>
          <p className="text-sm text-gray-600">
            {formData.idCardData.Card_Front.Header.Image || formData.idCardData.Card_Front.Footer.Header 
              ? '✓ Configured' 
              : 'Not configured'}
          </p>
        </div>

        {/* Plan Details */}
        <div>
          <h4 className="font-semibold text-oe-text mb-2">Plan Details</h4>
          <p className="text-sm text-gray-600">
            {formData.planDetailsData?.sections?.length > 0 
              ? `${formData.planDetailsData.sections.length} section(s) configured`
              : 'Not configured'}
          </p>
        </div>

        {/* Medical needs request links (member portal) */}
        <div>
          <h4 className="font-semibold text-oe-text mb-2">Medical Needs Request Links</h4>
          <p className="text-sm text-gray-600">
            {formData.medicalNeedsLinksConfig?.links?.length ? (
              <>
                Category: <span className="font-medium">{formData.medicalNeedsLinksConfig.categoryTitle?.trim() || '(untitled)'}</span>
                {' — '}
                {formData.medicalNeedsLinksConfig.links.length} link(s)
                {' — '}
                Priority:{' '}
                <span className="font-medium">
                  {formData.medicalNeedsLinksConfig.displayPriority ?? 1}
                </span>{' '}
                (lower = higher on member portal)
              </>
            ) : (
              'Not configured'
            )}
          </p>
        </div>

        {/* AI Chunks */}
        <div>
          <h4 className="font-semibold text-oe-text mb-2">AI Knowledge Chunks</h4>
          <p className="text-sm text-gray-600">
            {formData.aiChunks.length} chunk(s) configured
            {formData.aiChunks.length > 0 && 
              ` (${formData.aiChunks.reduce((acc, chunk) => acc + chunk.chunk_text.split(' ').length, 0)} words total)`
            }
          </p>
        </div>
      </div>

      {submitBlockers.length > 0 && (
        <div className="card bg-red-50 border border-red-200">
          <h4 className="font-semibold text-red-800 mb-2">
            Complete the following before {editingProduct ? 'updating' : 'creating'} this product
          </h4>
          <ul className="text-sm text-red-700 space-y-1 list-disc list-inside">
            {submitBlockers.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}