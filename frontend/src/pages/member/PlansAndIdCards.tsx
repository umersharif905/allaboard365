import { useQuery } from '@tanstack/react-query';
import {
    AlertCircle,
    Calendar,
    CheckCircle,
    Clock,
    CreditCard,
    ExternalLink,
    Info,
    Search,
    X,
    XCircle
} from 'lucide-react';
import React, { useState } from 'react';
import AccountTerminatedScreen from '../../components/member/AccountTerminatedScreen';
import PlanChangesModal from '../../components/member/PlanChangesModal';
import ProductDocumentsLinks from '../../components/shared/ProductDocumentsLinks';
import { useMemberContributions } from '../../hooks/member/useMemberContributions';
import { useGroupedMemberEnrollments, useMemberEnrollmentManager } from '../../hooks/member/useMemberEnrollments';
import { useMemberProfile } from '../../hooks/member/useMemberProfile';
import { ContributionCalculator } from '../../services/ContributionCalculator';
import { apiService } from '../../services/api.service';
import { GroupedEnrollment, MemberEnrollment } from '../../services/member/member-enrollments.service';
import { PricingService } from '../../services/pricing.service';
import { calculateBundleDisplayPrices, isProductPriceHidden } from '../../utils/bundlePricingDisplay';
import { hasProductDocuments } from '../../utils/productDocuments';

// Helper function to format ISO date strings without timezone conversion
const formatDate = (isoDateString: string): string => {
  if (!isoDateString) return '';
  const [datePart] = isoDateString.split('T');
  const [year, month, day] = datePart.split('-');
  const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// Status badge component
const StatusBadge: React.FC<{ status: string; effectiveDate?: string }> = ({ status, effectiveDate }) => {
  const getStatusConfig = (status: string, effectiveDate?: string) => {
    // Check if plan has future effective date
    if (effectiveDate) {
      const effectiveDateObj = new Date(effectiveDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Reset time to start of day for accurate comparison
      effectiveDateObj.setHours(0, 0, 0, 0);
      
      if (effectiveDateObj > today) {
        return { color: 'bg-blue-100 text-blue-800', icon: Clock, text: 'Not Yet Effective' };
      }
    }
    
    switch (status.toLowerCase()) {
      case 'active':
        return { color: 'bg-green-100 text-green-800', icon: CheckCircle, text: 'Active' };
      case 'pending':
        return { color: 'bg-yellow-100 text-yellow-800', icon: Clock, text: 'Pending' };
      case 'denied':
        return { color: 'bg-red-100 text-red-800', icon: XCircle, text: 'Denied' };
      case 'cancelled':
        return { color: 'bg-gray-100 text-gray-800', icon: XCircle, text: 'Cancelled' };
      case 'terminated':
        return { color: 'bg-gray-100 text-gray-800', icon: XCircle, text: 'Terminated' };
      case 'inactive':
        return { color: 'bg-gray-100 text-gray-800', icon: XCircle, text: 'Terminated' };
      default:
        return { color: 'bg-gray-100 text-gray-800', icon: AlertCircle, text: status };
    }
  };

  const config = getStatusConfig(status, effectiveDate);
  const Icon = config.icon;

  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${config.color}`}>
      <Icon className="h-3 w-3 mr-1" />
      {config.text}
    </span>
  );
};

// Plan Document Modal Component
interface PlanDocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
  documentUrl: string;
  productName?: string;
}

const PlanDocumentModal: React.FC<PlanDocumentModalProps> = ({ isOpen, onClose, documentUrl, productName }) => {
  if (!isOpen || !documentUrl) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg w-full max-w-4xl h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">
            {productName ? `${productName} - Plan Document` : 'Plan Document'}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* PDF Viewer */}
        <div className="flex-1 p-4 overflow-hidden">
          <iframe
            src={documentUrl}
            title="Plan Document"
            className="w-full h-full border-0"
          />
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-gray-200 flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 transition-colors"
          >
            Close
          </button>
          <a
            href={documentUrl}
            target="_blank"
            rel="noopener noreferrer"
            download
            className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors"
          >
            Download PDF
          </a>
        </div>
      </div>
    </div>
  );
};

// Plan Details Modal Component
interface PlanDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  planDetailsData: any;
  productLogoUrl?: string;
}

const PlanDetailsModal: React.FC<PlanDetailsModalProps> = ({ isOpen, onClose, planDetailsData, productLogoUrl }) => {
  if (!isOpen || !planDetailsData) return null;

  const getBodySections = () => {
    if (!planDetailsData?.Plan_Body) return [];
    
    const bodyCount = parseInt(planDetailsData.Plan_Body.Body_Count || "0", 10);
    const sections: any[] = [];
    
    for (let i = 1; i <= bodyCount; i++) {
      const section = planDetailsData.Plan_Body[`Body${i}`];
      if (section && typeof section === 'object' && section.Header) {
        sections.push(section);
      }
    }
    
    return sections;
  };

  const headerLogoUrl = planDetailsData?.Plan_Data?.Header?.Image || productLogoUrl;
  const bodySections = getBodySections();

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Plan Details</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Plan Header */}
          {planDetailsData?.Plan_Data?.Header && (
            <div 
              className="p-6 text-center"
              style={{ 
                backgroundColor: planDetailsData.Plan_Data.Header.Background_color || '#1f8dbf',
                color: planDetailsData.Plan_Data.Header.Text_color || '#FFFFFF'
              }}
            >
              {headerLogoUrl && (
                <div className="mb-3">
                  <img
                    src={headerLogoUrl}
                    alt="Header logo"
                    className="mx-auto object-contain"
                    style={{ width: 'calc(50% - 15px)', height: 'auto', maxHeight: '60px' }}
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                </div>
              )}
              <h2 className="text-xl font-bold">{planDetailsData.Plan_Data.Header.Text1}</h2>
              {planDetailsData.Plan_Data.Header.Text2 && (
                <p className="text-sm mt-2 opacity-90">{planDetailsData.Plan_Data.Header.Text2}</p>
              )}
            </div>
          )}
          
          {/* Body Sections */}
          {bodySections.length > 0 && (
            <div className="p-4 space-y-4">
              {bodySections.map((section, index) => (
                <div key={index} className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
                  <h3 className="font-bold text-gray-900 mb-3 text-lg">{section.Header}</h3>
                  {section.Text1 && (
                    <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                      {section.Text1}
                    </div>
                  )}
                  
                  {/* Links */}
                  {(section.Link_Name1 && section.URL1) || (section.Link_Name2 && section.URL2) ? (
                    <div className="mt-4 space-y-2">
                      {section.Link_Name1 && section.URL1 && (
                        <a 
                          href={section.URL1} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-oe-primary hover:text-blue-800 text-sm font-medium"
                        >
                          <ExternalLink className="w-4 h-4" />
                          {section.Link_Name1}
                        </a>
                      )}
                      
                      {section.Link_Name2 && section.URL2 && (
                        <a 
                          href={section.URL2} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-oe-primary hover:text-blue-800 text-sm font-medium"
                        >
                          <ExternalLink className="w-4 h-4" />
                          {section.Link_Name2}
                        </a>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          
          {/* Footer */}
          {planDetailsData?.Plan_Data?.Footer && (
            <div 
              className="p-4 text-center border-t mt-4"
              style={{ 
                backgroundColor: planDetailsData.Plan_Data.Footer.Background_color || '#FFFFFF',
                color: planDetailsData.Plan_Data.Footer.Text_color || '#000000'
              }}
            >
              <h3 className="font-bold text-sm mb-2">{planDetailsData.Plan_Data.Footer.Header}</h3>
              <p className="text-xs opacity-75">{planDetailsData.Plan_Data.Footer.Text1}</p>
              {planDetailsData.Plan_Data.Footer.Text2 && (
                <p className="text-lg font-bold mt-2">{planDetailsData.Plan_Data.Footer.Text2}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Grouped enrollment card component for bundles
const GroupedEnrollmentCard: React.FC<{ 
  groupedEnrollment: GroupedEnrollment;
  onCancel?: (enrollmentId: string) => void;
  calculatedContribution?: number;
  memberTier?: string;
  memberTobacco?: string;
}> = ({ groupedEnrollment, onCancel, calculatedContribution, memberTier, memberTobacco }) => {
  const [showPlanDetails, setShowPlanDetails] = useState(false);
  const [showComponentPlanDetails, setShowComponentPlanDetails] = useState<string | null>(null);
  
  // Get plan details from bundle product (for bundles) or primary enrollment product (for individual)
  const planDetailsData = groupedEnrollment.bundleProduct?.planDetailsData || 
                          groupedEnrollment.primaryEnrollment?.product?.planDetailsData;
  
  const productLogoUrl = groupedEnrollment.bundleProduct?.productLogoUrl || 
                         groupedEnrollment.primaryEnrollment?.product?.productLogoUrl;
  return (
    <div data-testid="grouped-enrollment-card" className="bg-white rounded-lg border border-gray-200 hover:border-gray-300 transition-colors">
      <div className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start space-x-4">
            {(groupedEnrollment.bundleProduct?.productLogoUrl || groupedEnrollment.primaryEnrollment?.product?.productLogoUrl) && (
              <img
                src={groupedEnrollment.bundleProduct?.productLogoUrl || groupedEnrollment.primaryEnrollment?.product?.productLogoUrl}
                alt={`${groupedEnrollment.bundleName} logo`}
                className="h-12 w-12 object-contain rounded-lg border border-gray-200"
              />
            )}
            <div className="flex-1">
              <h3 className="text-lg font-medium text-gray-900">
                {groupedEnrollment.type === 'bundle' ? groupedEnrollment.bundleName : groupedEnrollment.primaryEnrollment?.product?.name || 'Unknown Product'}
              </h3>
              <p className="text-gray-600 text-sm mt-1 line-clamp-2 pr-4">
                {groupedEnrollment.type === 'bundle'
                  ? `Bundle with ${groupedEnrollment.componentEnrollments?.length || 0} product${(groupedEnrollment.componentEnrollments?.length || 0) !== 1 ? 's' : ''}`
                  : groupedEnrollment.primaryEnrollment?.product.description
                }
              </p>
              {/* Show configuration value for individual products (e.g. Essential Sharewell Unshared Amount) */}
              {groupedEnrollment.type === 'individual' && groupedEnrollment.primaryEnrollment && (() => {
                try {
                  const comp = groupedEnrollment.primaryEnrollment;
                  if ((comp as any).configurationShownInIdCardData === true) return null;
                  const rawConfigFields = comp.product?.requiredDataFields || (comp.product as any)?.RequiredDataFields;
                  if (!rawConfigFields) return null;
                  let fieldName = 'Configuration';
                  let hasValidConfigFields = false;
                  try {
                    const configFields = typeof rawConfigFields === 'string' ? JSON.parse(rawConfigFields) : rawConfigFields;
                    if (Array.isArray(configFields) && configFields.length > 0) {
                      hasValidConfigFields = true;
                      if (configFields[0].fieldName) fieldName = configFields[0].fieldName;
                    }
                  } catch (e) {
                    hasValidConfigFields = false;
                  }
                  if (!hasValidConfigFields) return null;
                  // Prefer live ProductPricing.ConfigValue1 (resolved via oe.Enrollments.ProductPricingId).
                  // This lets admins relabel an option (e.g. 3000→2500) and have every existing enrollment
                  // reflect it automatically. Snapshot (enrollmentDetails.configuration) is fallback only
                  // for historical rows that predate the pricing-keyed config.
                  let configValue: string | null = null;
                  const pricingConfigValue = (comp as any).configValue1;
                  if (pricingConfigValue && pricingConfigValue !== 'Default') {
                    configValue = pricingConfigValue;
                  } else {
                    const enrollmentDetails = comp.enrollmentDetails;
                    if (enrollmentDetails && enrollmentDetails !== 'Enrolled via product change' && enrollmentDetails !== 'Updated via product change') {
                      try {
                        const details = typeof enrollmentDetails === 'string' ? JSON.parse(enrollmentDetails) : enrollmentDetails;
                        if (details.configuration && details.configuration !== 'Default') configValue = details.configuration;
                      } catch (e) { /* ignore */ }
                    }
                  }
                  if (configValue) {
                    return (
                      <p className="text-oe-primary text-xs mt-1">
                        {fieldName}: ${configValue}
                      </p>
                    );
                  }
                } catch (e) { /* ignore */ }
                return null;
              })()}
              {/* Configuration also shown at component level for bundles below */}
              <div className="mt-2 flex items-center space-x-2">
                {/* Only show status badge if it's not an inactive plan with pending termination */}
                {!(groupedEnrollment.status === 'Inactive' && groupedEnrollment.terminationDate && 
                  new Date(groupedEnrollment.terminationDate) > new Date()) && (
                  <StatusBadge status={groupedEnrollment.status} effectiveDate={groupedEnrollment.effectiveDate} />
                )}
                {groupedEnrollment.type === 'bundle' && (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                    Bundle
                  </span>
                )}
                {/* Show "Pending Termination" badge for inactive plans with future termination date */}
                {groupedEnrollment.status === 'Inactive' && groupedEnrollment.terminationDate && 
                 new Date(groupedEnrollment.terminationDate) > new Date() && (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                    <Clock className="h-3 w-3 mr-1" />
                    Pending Termination
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="text-right">
            {calculatedContribution !== undefined ? (
              <div>
                <div className="text-xs text-gray-900 font-medium mb-1">Monthly Premium:</div>
                <div className="text-lg font-semibold text-gray-900">
                  {PricingService.formatCurrency(groupedEnrollment.totalPremium)}
                </div>
                {(() => {
                  const employerContribution = groupedEnrollment.totalPremium - calculatedContribution;
                  // Only show "Your Contribution" if there's an employer contribution
                  if (employerContribution > 0) {
                    return (
                      <>
                        <div className="text-xs text-gray-500 mt-1">
                          Your Contribution: {PricingService.formatCurrency(calculatedContribution)}
                        </div>
                      <div className="text-xs text-gray-500 mt-1">
                        Employer Contribution: {PricingService.formatCurrency(employerContribution)}
                      </div>
                      </>
                    );
                  }
                  return null;
                })()}
              </div>
            ) : (
              <div>
                <div className="text-xs text-gray-900 font-medium mb-1">Monthly Premium:</div>
                <div className="text-lg font-semibold text-gray-900">
                  {PricingService.formatCurrency(groupedEnrollment.totalPremium)}
                </div>
              </div>
            )}
            {groupedEnrollment.totalPremium === 0 && (
              <div className="text-xs text-gray-400">
                Premium not set
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 text-sm">
          {groupedEnrollment.terminationDate ? (
            <div className="flex items-center text-red-600">
              <XCircle className="h-4 w-4 mr-2" />
              Expires: {formatDate(groupedEnrollment.terminationDate)}
            </div>
          ) : (
            <div className="flex items-center text-gray-600">
              <Calendar className="h-4 w-4 mr-2" />
              Effective: {formatDate(groupedEnrollment.effectiveDate)}
            </div>
          )}
        </div>


        {/* Bundle Products */}
        {groupedEnrollment.type === 'bundle' && groupedEnrollment.componentEnrollments && groupedEnrollment.componentEnrollments.length > 0 && (() => {
          // Get bundle configuration. Prefer the live ProductPricing.ConfigValue1 on the first component
          // so product-level relabels flow through to bundle display/pricing automatically. Fall back to
          // the enrollmentDetails snapshot for historical rows without a pricing-keyed config.
          let bundleSelectedConfig: string | undefined;
          const firstComponent = groupedEnrollment.componentEnrollments[0];
          const firstPricingConfig = (firstComponent as any)?.configValue1;
          if (firstPricingConfig && firstPricingConfig !== 'Default') {
            bundleSelectedConfig = firstPricingConfig;
          } else {
            try {
              if (firstComponent?.enrollmentDetails) {
                const details = JSON.parse(firstComponent.enrollmentDetails);
                if (details.configuration && details.configuration !== 'Default') {
                  bundleSelectedConfig = details.configuration;
                }
              }
            } catch (e) {
              // Not JSON, ignore
            }
          }
          
          // Calculate display prices for this bundle
          const bundleProducts = groupedEnrollment.componentEnrollments.map((comp: any) => ({
            productId: comp.product?.productId || comp.productId,
            productName: comp.product?.name || 'Unknown Product',
            monthlyPremium: (comp.premiumAmount || 0) + (comp.includedPaymentProcessingFeeAmount || 0) + (comp.includedSystemFeeAmount || 0),
            hidePricing: (comp.product as any)?.hidePricing || false,
            linkedToProductId: (comp.product as any)?.linkedToProductId || null,
            pricingVariations: []
          }));
          
          // Map bundle's config to all its included products for price calculation
          const includedProductConfigs: Record<string, string> = {};
          if (bundleSelectedConfig) {
            bundleProducts.forEach((bp: any) => {
              includedProductConfigs[bp.productId] = bundleSelectedConfig;
            });
          }
          
          const displayPrices = calculateBundleDisplayPrices(bundleProducts, includedProductConfigs);
          
          return (
            <div className="mt-4">
              <h4 className="text-sm font-medium text-gray-900 mb-2">
                Products ({groupedEnrollment.componentEnrollments.length})
              </h4>
              <div className="space-y-2">
                {groupedEnrollment.componentEnrollments.map((component) => {
                  const isPriceHidden = isProductPriceHidden(component.product?.productId || component.productId, displayPrices.hiddenProductIds);
                  const displayPriceResult = displayPrices.displayPrices.get(component.product?.productId || component.productId);
                  const displayPrice = displayPriceResult?.displayPrice;
                  const actualPrice = (component.premiumAmount || 0) + (component.includedPaymentProcessingFeeAmount || 0) + (component.includedSystemFeeAmount || 0);
                  
                  return (
                    <div key={component.enrollmentId} className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <h4 className="font-medium text-gray-900">{component.product?.name || 'Unknown Product'}</h4>
                          <p className="text-sm text-gray-600 line-clamp-2 pr-4">{component.product?.description || ''}</p>
                          {/* Show configuration if available AND product has RequiredDataFields */}
                          {(() => {
                            try {
                              if ((component as any).configurationShownInIdCardData === true) return null;
                              // First check if this product actually has configuration fields
                              const rawConfigFields = component.product.requiredDataFields || 
                                                     (component.product as any).RequiredDataFields;
                              
                              // Only proceed if product has config fields
                              if (!rawConfigFields) {
                                return null;
                              }
                              
                              // Parse RequiredDataFields to get field name
                              let fieldName = 'Configuration';
                              let hasValidConfigFields = false;
                              
                              try {
                                const configFields = typeof rawConfigFields === 'string' 
                                  ? JSON.parse(rawConfigFields) 
                                  : rawConfigFields;
                                
                                // Check if configFields is a non-empty array with valid field definitions
                                if (Array.isArray(configFields) && configFields.length > 0) {
                                  hasValidConfigFields = true;
                                  if (configFields[0].fieldName) {
                                    fieldName = configFields[0].fieldName;
                                  }
                                }
                              } catch (e) {
                                // If parsing fails, no valid config fields
                                hasValidConfigFields = false;
                              }
                              
                              // If no valid config fields, don't show configuration
                              if (!hasValidConfigFields) {
                                return null;
                              }
                              
                              // Prefer live ProductPricing.ConfigValue1 resolved via ProductPricingId so
                              // option relabels flow to existing enrollments. Snapshot is fallback only.
                              let configValue: string | null = null;
                              const pricingConfigValue = (component as any).configValue1;
                              if (pricingConfigValue && pricingConfigValue !== 'Default') {
                                configValue = pricingConfigValue;
                              } else {
                                const enrollmentDetails = component.enrollmentDetails;
                                if (enrollmentDetails && enrollmentDetails !== 'Enrolled via product change' && enrollmentDetails !== 'Updated via product change') {
                                  try {
                                    const details = JSON.parse(enrollmentDetails);
                                    if (details.configuration && details.configuration !== 'Default') {
                                      configValue = details.configuration;
                                    }
                                  } catch (e) {
                                    // Not JSON, ignore
                                  }
                                }
                              }
                              
                              // Only show configuration if it exists (not "Default")
                              if (configValue) {
                                return (
                                  <p className="text-oe-primary text-xs mt-1">
                                    {fieldName}: ${configValue}
                                  </p>
                                );
                              }
                            } catch (e) {
                              // Ignore errors
                            }
                            return null;
                          })()}
                        </div>
                        <div className="flex items-center space-x-3">
                          <div className="text-right">
                            <div className="text-sm font-medium text-gray-900">
                              {isPriceHidden ? (
                                <span className="text-gray-500 text-xs">Included</span>
                              ) : displayPrice !== null && displayPrice !== undefined && displayPrice !== actualPrice ? (
                                PricingService.formatCurrency(displayPrice)
                              ) : (
                                PricingService.formatCurrency(actualPrice)
                              )}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            {/* Show Plan Details button for individual products within bundles that have plan details */}
                            {component.product?.planDetailsData && (
                              <button
                                onClick={() => setShowComponentPlanDetails(component.enrollmentId)}
                                className="inline-flex items-center px-2 py-1 border border-oe-primary rounded text-xs font-medium text-oe-primary bg-white hover:bg-oe-light"
                              >
                                <Info className="h-3 w-3 mr-1" />
                                Plan Details
                              </button>
                            )}
                            {hasProductDocuments(component.product) && (
                              <ProductDocumentsLinks
                                product={component.product}
                                variant="button"
                                size="sm"
                                label="Plan Document"
                                className="inline-flex"
                              />
                            )}
                          </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          );
        })()}

        {/* Action buttons - only for individual products (not bundles) */}
        {groupedEnrollment.type !== 'bundle' && (
          <div className="mt-4 flex justify-between items-center">
            <div className="flex gap-2">
            </div>

            <div className="flex gap-2">
              {groupedEnrollment.status === 'Pending' && onCancel && groupedEnrollment.primaryEnrollment && (
                <button
                  onClick={() => onCancel(groupedEnrollment.primaryEnrollment!.enrollmentId)}
                  className="inline-flex items-center px-3 py-2 border border-red-300 rounded-lg text-sm font-medium text-red-700 bg-white hover:bg-red-50"
                >
                  <X className="h-4 w-4 mr-2" />
                  Cancel Request
                </button>
              )}

              {planDetailsData && (
                <button
                  onClick={() => setShowPlanDetails(true)}
                  className="inline-flex items-center px-3 py-2 border border-oe-primary rounded-lg text-sm font-medium text-oe-primary bg-white hover:bg-oe-light"
                >
                  <Info className="h-4 w-4 mr-2" />
                  Plan Details
                </button>
              )}

              <ProductDocumentsLinks
                product={groupedEnrollment.primaryEnrollment?.product ?? groupedEnrollment.bundleProduct}
                variant="button"
                size="md"
                label="Plan Document"
              />
            </div>
          </div>
        )}

        {/* Only show Cancel Request button for pending bundle enrollments */}
        {groupedEnrollment.type === 'bundle' && groupedEnrollment.status === 'Pending' && onCancel && groupedEnrollment.primaryEnrollment && (
          <div className="mt-4 flex justify-end">
            <button
              onClick={() => onCancel(groupedEnrollment.primaryEnrollment!.enrollmentId)}
              className="inline-flex items-center px-3 py-2 border border-red-300 rounded-lg text-sm font-medium text-red-700 bg-white hover:bg-red-50"
            >
              <X className="h-4 w-4 mr-2" />
              Cancel Request
            </button>
          </div>
        )}

        {/* Plan Details Modal for Bundle/Individual Product */}
        <PlanDetailsModal
          isOpen={showPlanDetails}
          onClose={() => setShowPlanDetails(false)}
          planDetailsData={planDetailsData}
          productLogoUrl={productLogoUrl}
        />

        {/* Plan Details Modals for Component Products */}
        {groupedEnrollment.type === 'bundle' && groupedEnrollment.componentEnrollments?.map((component) => {
          const componentPlanDetails = component.product?.planDetailsData;
          const componentLogoUrl = component.product?.productLogoUrl;
          const isDetailsOpen = showComponentPlanDetails === component.enrollmentId;
          
          return (
            <React.Fragment key={component.enrollmentId}>
              {componentPlanDetails && (
                <PlanDetailsModal
                  isOpen={isDetailsOpen}
                  onClose={() => setShowComponentPlanDetails(null)}
                  planDetailsData={componentPlanDetails}
                  productLogoUrl={componentLogoUrl}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};


export default function PlansAndIdCards() {
  const [selectedPlanChangesEnrollment, setSelectedPlanChangesEnrollment] = useState<MemberEnrollment | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'active' | 'terminated'>('active');
  
  const {
    isLoading: isLoadingProducts,
    hasError: hasProductsError,
    productsError,
    cancelEnrollmentRequest
  } = useMemberEnrollmentManager();

  // Get grouped enrollments - pass filterStatus to backend to get only the requested enrollments
  const {
    data: groupedEnrollmentsRaw,
    isLoading: isLoadingEnrollments,
    isError: hasEnrollmentsError,
    error: enrollmentsError
  } = useGroupedMemberEnrollments(filterStatus);
  
  // Filter out all-products contribution enrollments (ProductId = special GUID) from main display
  const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';
  const groupedEnrollments = groupedEnrollmentsRaw?.filter((e: GroupedEnrollment) => 
    e.primaryEnrollment?.productId !== ALL_PRODUCTS_GUID
  ) || [];

  const { profile: memberProfile } = useMemberProfile();

  // Get group contribution rules if member is part of a group
  const { data: groupContributionRules } = useQuery({
    queryKey: ['groupContributionRules', memberProfile?.groupId],
    queryFn: async () => {
      if (!memberProfile?.groupId) return null;
      const response = await apiService.get<{ success: boolean; data: any[] }>(`/api/groups/${memberProfile.groupId}/contributions`);
      return response.success ? response.data : [];
    },
    enabled: !!memberProfile?.groupId,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // Combined loading and error states
  const isLoading = isLoadingEnrollments || isLoadingProducts;
  const hasError = hasEnrollmentsError || hasProductsError;




  const handleSavePlanChanges = async (changes: any) => {
    // TODO: Implement plan changes API call
    console.log('Saving plan changes:', changes);
    // This would call a new API endpoint to save the changes
  };


  const handleCancel = (enrollmentId: string) => {
    if (confirm('Are you sure you want to cancel this enrollment request?')) {
      cancelEnrollmentRequest(enrollmentId);
    }
  };




  // Filter and search helper function
  const filterEnrollments = (enrollments: GroupedEnrollment[]) => {
    if (!enrollments) return [];
    
    return enrollments.filter((enrollment) => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const productName = (enrollment.bundleName || enrollment.primaryEnrollment?.product?.name || '').toLowerCase();
        const productDescription = enrollment.type === 'bundle' 
          ? `bundle with ${enrollment.componentEnrollments?.length || 0} products`
          : (enrollment.primaryEnrollment?.product.description || '').toLowerCase();
        
        if (!productName.includes(query) && !productDescription.includes(query)) {
          return false;
        }
      }
      
      return true;
    });
  };

  // Active plans: only truly active plans (status === 'Active')
  // Note: groupedEnrollments is already filtered to exclude all-products contributions
  const activeGroupedEnrollments = filterEnrollments(
    groupedEnrollments?.filter((e: GroupedEnrollment) => {
      return e.status === 'Active';
    }) || []
  );

  // Plans that are inactive but not yet terminated (for display purposes only)
  const pendingTerminationEnrollments = filterEnrollments(
    groupedEnrollments?.filter((e: GroupedEnrollment) => {
      if (e.status === 'Inactive' && e.terminationDate) {
        const terminationDate = new Date(e.terminationDate);
        const today = new Date();
        return terminationDate > today; // Still active until termination date
      }
      return false;
    }) || []
  );

  const pendingGroupedEnrollments = filterEnrollments(
    groupedEnrollments?.filter((e: GroupedEnrollment) => e.status === 'Pending') || []
  );
  
  // Terminated plans: Show all enrollments when filterStatus is 'terminated'
  // The backend already filters by status, so we just need to filter out the all-products contribution
  const inactiveGroupedEnrollments = filterStatus === 'terminated' 
    ? filterEnrollments(groupedEnrollments || [])
    : filterEnrollments(
        groupedEnrollments?.filter((e: GroupedEnrollment) => {
          // Check if the grouped enrollment itself is Inactive or Terminated
          if (e.status === 'Inactive' || e.status === 'Terminated') {
            if (!e.terminationDate) return true; // No termination date = truly inactive/terminated
            const terminationDate = new Date(e.terminationDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0); // Reset time to start of day for accurate comparison
            terminationDate.setHours(0, 0, 0, 0);
            const isTerminated = terminationDate <= today; // Already terminated
            return isTerminated;
          }
          
          // Also check if any enrollment in the group is Inactive/Terminated with past termination date
          const hasTerminatedEnrollment = e.enrollments?.some((enrollment: MemberEnrollment) => {
            if ((enrollment.status === 'Inactive' || enrollment.status === 'Terminated') && enrollment.terminationDate) {
              const termDate = new Date(enrollment.terminationDate);
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              termDate.setHours(0, 0, 0, 0);
              return termDate <= today;
            }
            return false;
          });
          
          return hasTerminatedEnrollment;
        }) || []
      );

  // Debug logging for terminated enrollments (after inactiveGroupedEnrollments is declared)
  console.log('🔍 PlansAndIdCards - Debug enrollments:', {
    filterStatus,
    groupedEnrollmentsRawCount: groupedEnrollmentsRaw?.length || 0,
    groupedEnrollmentsCount: groupedEnrollments.length,
    inactiveGroupedEnrollmentsCount: inactiveGroupedEnrollments.length,
    allEnrollmentStatuses: groupedEnrollments.map(e => ({
      enrollmentId: e.primaryEnrollment?.enrollmentId,
      status: e.status,
      terminationDate: e.terminationDate,
      productName: e.primaryEnrollment?.product?.name || e.bundleName,
      enrollmentCount: e.enrollments?.length || 0,
      enrollmentStatuses: e.enrollments?.map((en: MemberEnrollment) => ({
        id: en.enrollmentId,
        status: en.status,
        terminationDate: en.terminationDate
      })) || []
    })),
    inactiveEnrollments: groupedEnrollments.filter(e => e.status === 'Inactive' || e.status === 'Terminated').map(e => ({
      enrollmentId: e.primaryEnrollment?.enrollmentId,
      status: e.status,
      terminationDate: e.terminationDate,
      productName: e.primaryEnrollment?.product?.name || e.bundleName
    }))
  });

  // Calculate individual product contributions (product-specific rules ONLY, not all-products)
  const calculateProductContribution = (enrollment: GroupedEnrollment) => {
    if (!memberProfile || !groupContributionRules) {
      return enrollment.totalPremium || 0;
    }

    try {
      const productId = enrollment.bundleId || enrollment.primaryEnrollment?.productId;
      
      // Get ONLY product-specific contribution rules (rules that apply to this specific product)
      const productRules = groupContributionRules.filter((rule: any) => 
        rule.ProductId === productId && rule.Status === 'Active'
      );

      console.log('🔍 DEBUG: calculateProductContribution for', {
        productId,
        productName: enrollment.bundleName || enrollment.primaryEnrollment?.product?.name || 'Unknown Product',
        totalPremium: enrollment.totalPremium,
        productRules: productRules.length
      });

      // If no product-specific rules, return full premium
      if (productRules.length === 0) {
        return enrollment.totalPremium || 0;
      }

      // Transform rules to ContributionCalculator format
      const transformedProductRules = productRules.map((rule: any) => ({
        type: rule.ContributionType === 'flat_rate' ? 'flat_rate' : 'percentage',
        amount: rule.ContributionType === 'flat_rate' ? rule.FlatRateAmount : rule.PercentageAmount,
        description: rule.Name || '',
        appliesTo: 'product'
      }));

      // Transform single enrollment to ContributionCalculator format
      const productData = {
        productId: productId || '',
        productName: enrollment.bundleName || enrollment.primaryEnrollment?.product?.name || 'Unknown Product',
        description: '',
        productType: '',
        isBundle: enrollment.type === 'bundle',
        contributionRules: transformedProductRules,
        pricingVariations: [{
          configValue: 'Default',
          monthlyPremium: enrollment.totalPremium || 0,
          employerContribution: 0,
          employeeContribution: enrollment.totalPremium || 0
        }]
      };

      const selectedConfigs = { [productId || '']: 'Default' };

      // Use ContributionCalculator with EMPTY all-products rules (applied separately to total)
      const contributionResult = ContributionCalculator.calculateTotalContributions(
        [productData],
        selectedConfigs,
        [] // No all-products rules for individual product display
      );

      console.log('🔍 DEBUG: ContributionCalculator result for', {
        productName: enrollment.bundleName || enrollment.primaryEnrollment?.product?.name || 'Unknown Product',
        totalPremium: enrollment.totalPremium,
        employeeContribution: contributionResult.totals.totalEmployeeContribution,
        employerContribution: contributionResult.totals.totalEmployerContribution
      });

      return contributionResult.totals.totalEmployeeContribution;
    } catch (error) {
      console.warn('Failed to calculate product contribution, using fallback:', error);
      return enrollment.totalPremium || 0;
    }
  };

  // Use the unified contributions hook for all calculations
  const contributions = useMemberContributions();
  
  // Destructure for easier access
  const {
    totalProductPremium: totalPremium,
    totalEmployerContribution,
    processingFee,
    totalMonthlyContribution,
    yourContribution,
  } = contributions;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto"></div>
          <p className="mt-2 text-gray-600">Loading your plans...</p>
        </div>
      </div>
    );
  }

  // Check for specific error types
  const checkForTerminatedAccount = () => {
    if (enrollmentsError?.message?.includes('terminated') || productsError?.message?.includes('terminated')) {
      return true;
    }
    
    // Check for API error codes - cast to any to access custom properties
    const enrollmentsErrorAny = enrollmentsError as any;
    const productsErrorAny = productsError as any;
    
    if (enrollmentsErrorAny?.code === 'MEMBER_TERMINATED' || productsErrorAny?.code === 'MEMBER_TERMINATED') {
      return true;
    }
    
    return false;
  };

  const checkForInactiveAccount = () => {
    if (enrollmentsError?.message?.includes('inactive') || productsError?.message?.includes('inactive')) {
      return true;
    }
    
    const enrollmentsErrorAny = enrollmentsError as any;
    const productsErrorAny = productsError as any;
    
    if (enrollmentsErrorAny?.code === 'MEMBER_INACTIVE' || productsErrorAny?.code === 'MEMBER_INACTIVE') {
      return true;
    }
    
    return false;
  };

  // Show terminated account screen
  if (checkForTerminatedAccount()) {
    const error = (enrollmentsError || productsError) as any;
    const memberId = error?.memberId;
    const terminatedDate = error?.terminatedDate;
    
    return <AccountTerminatedScreen memberId={memberId} terminatedDate={terminatedDate} />;
  }

  // Show inactive account message
  if (checkForInactiveAccount()) {
    const error = enrollmentsError || productsError;
    return (
      <div className="space-y-6">
        <div className="text-center py-12">
          <AlertCircle className="h-8 w-8 text-yellow-500 mx-auto mb-2" />
          <p className="text-yellow-600">Account Inactive</p>
          <p className="text-sm text-gray-500 mt-1">{error?.message || 'Your account is currently inactive.'}</p>
          <div className="mt-4">
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center px-4 py-2 border border-transparent rounded-lg text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="space-y-6">
        <div className="text-center py-12">
          <AlertCircle className="h-8 w-8 text-red-500 mx-auto mb-2" />
          <p className="text-red-600">Failed to load your plans</p>
          {enrollmentsError && <p className="text-sm text-gray-500 mt-1">{enrollmentsError.message}</p>}
          {productsError && <p className="text-sm text-gray-500 mt-1">{productsError.message}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="border-b border-gray-200">
          <nav className="flex space-x-0" aria-label="Tabs">
            <button
              onClick={() => setFilterStatus('active')}
              className={`flex-1 group relative px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                filterStatus === 'active'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Active Plans
              {activeGroupedEnrollments.length > 0 && (
                <span className={`ml-2 py-0.5 px-2 rounded-full text-xs ${
                  filterStatus === 'active'
                    ? 'bg-blue-100 text-blue-800'
                    : 'bg-gray-100 text-gray-600'
                }`}>
                  {activeGroupedEnrollments.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setFilterStatus('terminated')}
              className={`flex-1 group relative px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                filterStatus === 'terminated'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              History
              {inactiveGroupedEnrollments.length > 0 && (
                <span className={`ml-2 py-0.5 px-2 rounded-full text-xs ${
                  filterStatus === 'terminated'
                    ? 'bg-blue-100 text-blue-800'
                    : 'bg-gray-100 text-gray-600'
                }`}>
                  {inactiveGroupedEnrollments.length}
                </span>
              )}
            </button>
          </nav>
        </div>
        
        {/* Search Bar - Only show on Active tab */}
        {filterStatus === 'active' && (
          <div className="p-4 border-b border-gray-200">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search plans by name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>


      {/* Active Plans */}
      {filterStatus === 'active' && (activeGroupedEnrollments.length > 0 || pendingTerminationEnrollments.length > 0) && (
        <div data-testid="active-plans">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-gray-900">
              Active Plans
            </h2>
          </div>
          <div className="grid gap-4">
            {/* Show truly active plans */}
            {activeGroupedEnrollments.map((groupedEnrollment: GroupedEnrollment) => {
              // Calculate contribution for this specific enrollment
              const calculatedContribution = calculateProductContribution(groupedEnrollment);
              
              return (
                <GroupedEnrollmentCard
                  key={groupedEnrollment.bundleId || groupedEnrollment.primaryEnrollment?.enrollmentId}
                  groupedEnrollment={groupedEnrollment}
                  calculatedContribution={calculatedContribution}
                  memberTier={memberProfile?.tier}
                  memberTobacco={memberProfile?.tobaccoUse}
              />
              );
            })}
            
            {/* Show pending termination plans */}
            {pendingTerminationEnrollments.map((groupedEnrollment: GroupedEnrollment) => {
              return (
                <GroupedEnrollmentCard
                  key={groupedEnrollment.bundleId || groupedEnrollment.primaryEnrollment?.enrollmentId}
                  groupedEnrollment={groupedEnrollment}
                  // No calculatedContribution for pending termination plans
                  memberTier={memberProfile?.tier}
                  memberTobacco={memberProfile?.tobaccoUse}
              />
              );
            })}
          </div>
        </div>
      )}





        
      {/* Empty State / No Results */}
      {((filterStatus === 'active' && activeGroupedEnrollments.length === 0 && pendingTerminationEnrollments.length === 0) ||
        (filterStatus === 'terminated' && inactiveGroupedEnrollments.length === 0)) && (
        <div className="text-center py-12">
          {searchQuery ? (
            <>
              <Search size={64} className="mx-auto mb-6 text-gray-400" />
              <h2 className="text-xl font-medium text-gray-900 mb-2">No Plans Found</h2>
              <p className="text-gray-600 max-w-md mx-auto mb-6">
                No plans match your search "{searchQuery}". Try a different search term or clear the search.
              </p>
              <button
                onClick={() => setSearchQuery('')}
                className="inline-flex items-center px-6 py-3 border border-gray-300 rounded-lg text-base font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                <X className="h-5 w-5 mr-2" />
                Clear Search
              </button>
            </>
          ) : filterStatus === 'active' ? (
            <>
              <CreditCard size={64} className="mx-auto mb-6 text-gray-400" />
              <h2 className="text-xl font-medium text-gray-900 mb-2">No Active Plans</h2>
              <p className="text-gray-600 max-w-md mx-auto mb-6">
                You don&apos;t have any active benefit plans yet. Contact your group administrator about available options.
              </p>
            </>
          ) : filterStatus === 'terminated' ? (
            <>
              <AlertCircle size={64} className="mx-auto mb-6 text-gray-400" />
              <h2 className="text-xl font-medium text-gray-900 mb-2">No Terminated Plans</h2>
              <p className="text-gray-600 max-w-md mx-auto mb-6">
                You don't have any terminated plans in your history.
              </p>
            </>
          ) : null}
        </div>
      )}

      {/* History Tab - Terminated Plans */}
      {filterStatus === 'terminated' && inactiveGroupedEnrollments.length > 0 && (
        <div>
          <h2 className="text-lg font-medium text-gray-900 mb-4">Terminated Plans</h2>
          <div className="grid gap-4">
            {inactiveGroupedEnrollments.map((groupedEnrollment: GroupedEnrollment) => (
              <GroupedEnrollmentCard
                key={groupedEnrollment.bundleId || groupedEnrollment.primaryEnrollment?.enrollmentId}
                groupedEnrollment={groupedEnrollment}
                memberTier={memberProfile?.tier}
                memberTobacco={memberProfile?.tobaccoUse}
              />
            ))}
          </div>
        </div>
      )}

      {/* Monthly Contribution Card - Moved to bottom after all plans */}
      {activeGroupedEnrollments.length > 0 && filterStatus === 'active' && (
        <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm mt-6">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Monthly Contribution</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left Column - Math Formula Breakdown */}
            <div className="space-y-2">
              {totalEmployerContribution > 0 ? (
                <>
                  {/* Total Premium - products only (no processing fees) */}
                  <div className="flex items-center justify-between py-2">
                    <div className="text-sm font-medium text-gray-700">Total Premium</div>
                    <div className="text-lg font-semibold text-gray-900">
                      {PricingService.formatCurrency(totalPremium)}
                    </div>
                  </div>
                  {/* Fees (processing + system fees enrollments) */}
                  {processingFee > 0 && (
                    <div className="flex items-center justify-between py-2">
                      <div className="text-sm font-medium text-gray-700">Fees</div>
                      <div className="text-lg font-semibold text-gray-900">
                        {PricingService.formatCurrency(processingFee)}
                      </div>
                    </div>
                  )}
                  {/* Employer Contribution - from Contribution enrollments only */}
                  <div className="flex items-center justify-between py-2">
                    <div className="text-sm font-medium text-gray-700">
                      Employer Contribution
                    </div>
                    <div className="text-lg font-semibold text-green-600">
                      -{PricingService.formatCurrency(totalEmployerContribution)}
                    </div>
                  </div>
                  {/* Divider */}
                  <div className="border-t border-gray-200 my-2"></div>
                  {/* Your Contribution */}
                  <div className="flex items-center justify-between py-2">
                    <div className="text-sm font-medium text-gray-700">Your Contribution</div>
                    <div className="text-2xl font-bold text-gray-900">
                      {PricingService.formatCurrency(yourContribution)}/mo
                    </div>
                  </div>
                </>
              ) : (
                /* No employer contribution - show with processing fees */
                <>
                  {/* Total Premium - products only (no processing fees) */}
                  <div className="flex items-center justify-between py-2">
                    <div className="text-sm font-medium text-gray-700">Total Premium</div>
                    <div className="text-lg font-semibold text-gray-900">
                      {PricingService.formatCurrency(totalPremium)}
                    </div>
                  </div>
                  {/* Fees (processing + system fees enrollments) */}
                  {processingFee > 0 && (
                    <div className="flex items-center justify-between py-2">
                      <div className="text-sm font-medium text-gray-700">Fees</div>
                      <div className="text-lg font-semibold text-gray-900">
                        {PricingService.formatCurrency(processingFee)}
                      </div>
                    </div>
                  )}
                  {/* Divider */}
                  {processingFee > 0 && <div className="border-t border-gray-200 my-2"></div>}
                  {/* Your Contribution */}
                  <div className="flex items-center justify-between py-2">
                    <div className="text-sm font-medium text-gray-700">Your Contribution</div>
                    <div className="text-2xl font-bold text-gray-900">
                      {PricingService.formatCurrency(totalMonthlyContribution + processingFee)}/mo
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}


      {/* Plan Changes Modal */}
      {selectedPlanChangesEnrollment && (
        <PlanChangesModal
          enrollment={selectedPlanChangesEnrollment}
          isOpen={!!selectedPlanChangesEnrollment}
          onClose={() => setSelectedPlanChangesEnrollment(null)}
          onSaveChanges={handleSavePlanChanges}
        />
      )}


    </div>
  );
}
