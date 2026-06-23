// File: frontend/src/pages/members/tabs/MemberPlansTab.tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    AlertCircle,
    AlertTriangle,
    Calendar,
    CheckCircle,
    ChevronDown,
    Clock,
    CreditCard,
    Loader2,
    Play,
    RefreshCw,
    Search,
    Settings,
    X,
    XCircle
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import IDCard from '../../../components/IDCard';
import AccountTerminatedScreen from '../../../components/member/AccountTerminatedScreen';
import ProductDocumentsLinks from '../../../components/shared/ProductDocumentsLinks';
import VendorNetworkSelections, { VendorNetworkSelectionMap } from '../../../components/groups/VendorNetworkSelections';
import TenantAdminPlanModificationWizardModal from '../modals/TenantAdminPlanModificationWizardModal';
import EnrollmentAuditModal from '../modals/EnrollmentAuditModal';
import { useAuth } from '../../../hooks';
import { useMemberPlanTenure } from '../../../hooks/members/useMemberPlanTenure';
import { apiService } from '../../../services/api.service';
import { ContributionCalculator } from '../../../services/ContributionCalculator';
import {
  fetchMemberEnrollmentsAllStatuses,
  groupEnrollmentsForPlanWizard,
  GroupedEnrollment,
  MemberEnrollment,
  normalizeEnrollmentStatus
} from '../../../services/member/member-enrollments.service';
import { PricingService } from '../../../services/pricing.service';
import { Member, applyProductMemberIdPrefixMask, resolveHouseholdMemberId } from '../../../types/member.types';
import { calculateBundleDisplayPrices, isProductPriceHidden } from '../../../utils/bundlePricingDisplay';
import { formatDate } from '../../../utils/helpers';
import {
  computeMemberContributionTotals,
  isEnrollmentActiveForContributions,
} from '../../../utils/memberContributionTotals';

const isIDCardDisabled = (idCardData: any): boolean => {
  return idCardData?.DisableIDCard === true;
};

interface Props {
  member: Member;
  onRefresh?: () => void;
}

/** DB may use PaymentHold; UI label is friendlier */
function formatPlanEnrollmentStatusLabel(status: string, isPendingMigration?: boolean): string {
  const s = String(status || '').toLowerCase().replace(/\s+/g, '');
  if (isPendingMigration || s === 'pendingpayment') return 'Pending migration';
  if (s === 'paymenthold') return 'Payment pending';
  return status;
}

function isPendingOrPaymentHoldStatus(status: string | undefined): boolean {
  const s = String(status || '').toLowerCase().replace(/\s+/g, '');
  return s === 'pending' || s === 'paymenthold' || s === 'pendingpayment';
}

/** Earliest oe.Enrollments.CreatedDate in the group (bundle or single). */
function getPlanGroupEnrolledDate(ge: GroupedEnrollment): string | undefined {
  const list = ge.enrollments?.length ? ge.enrollments : [];
  if (list.length === 0) return ge.primaryEnrollment?.createdDate;
  let minTs = Infinity;
  let minIso: string | undefined;
  for (const e of list) {
    if (!e.createdDate) continue;
    const t = new Date(e.createdDate).getTime();
    if (!Number.isNaN(t) && t < minTs) {
      minTs = t;
      minIso = e.createdDate;
    }
  }
  return minIso ?? ge.primaryEnrollment?.createdDate;
}

// Status badge component
const StatusBadge: React.FC<{ status: string; isPendingMigration?: boolean }> = ({ status, isPendingMigration }) => {
  const getStatusConfig = (statusRaw: string) => {
    const s = statusRaw.toLowerCase().replace(/\s+/g, '');
    switch (s) {
      case 'active':
        return { color: 'bg-green-100 text-green-800', icon: CheckCircle };
      case 'pending':
      case 'pendingpayment':
        return { color: isPendingMigration ? 'bg-violet-100 text-violet-800' : 'bg-yellow-100 text-yellow-800', icon: Clock };
      case 'paymenthold':
        return { color: 'bg-amber-100 text-amber-900', icon: AlertTriangle };
      case 'denied':
        return { color: 'bg-red-100 text-red-800', icon: XCircle };
      case 'cancelled':
        return { color: 'bg-gray-100 text-gray-800', icon: XCircle };
      default:
        return { color: 'bg-gray-100 text-gray-800', icon: AlertCircle };
    }
  };

  const config = getStatusConfig(status);
  const Icon = config.icon;
  const label = formatPlanEnrollmentStatusLabel(status, isPendingMigration);

  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${config.color}`}>
      <Icon className="h-3 w-3 mr-1" />
      {label}
    </span>
  );
};

// Payment status badge component
const PaymentStatusBadge: React.FC<{ status?: string }> = ({ status }) => {
  const getPaymentStatusConfig = (status?: string) => {
    switch (status?.toLowerCase()) {
      case 'paid':
        return { color: 'bg-green-100 text-green-800', icon: CheckCircle, text: 'Paid' };
      case 'declined':
      case 'failed':
        return { color: 'bg-red-100 text-red-800', icon: XCircle, text: 'Declined' };
      case 'processing':
        return { color: 'bg-yellow-100 text-yellow-800', icon: Clock, text: 'Processing' };
      case 'pending':
        return { color: 'bg-blue-100 text-blue-800', icon: Clock, text: 'Pending' };
      default:
        return { color: 'bg-gray-100 text-gray-800', icon: AlertCircle, text: 'No Payment' };
    }
  };

  const config = getPaymentStatusConfig(status);
  const Icon = config.icon;

  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${config.color}`}>
      <Icon className="h-3 w-3 mr-1" />
      {config.text}
    </span>
  );
};

// API sync badge
const APISyncBadge: React.FC<{ synced: boolean }> = ({ synced }) => (
  <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${synced ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
    {synced ? <CheckCircle className="h-3 w-3 mr-1" /> : <Clock className="h-3 w-3 mr-1" />}
    API {synced ? 'synced' : 'pending'}
  </span>
);

// API actions dropdown - status + Run/Update/Terminate options
const APIActionsDropdown: React.FC<{
  enrollment: MemberEnrollment;
  canRunAPI: boolean;
  onRunAPI: (enrollmentId: string) => void;
  onUpdateAPI: (enrollmentId: string) => void;
  runningEnrollmentId: string | null;
  size?: 'sm' | 'md';
}> = ({ enrollment, canRunAPI, onRunAPI, onUpdateAPI, runningEnrollmentId, size = 'sm' }) => {
  const [open, setOpen] = useState(false);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const termDate = enrollment.terminationDate ? new Date(enrollment.terminationDate) : null;
  if (termDate) termDate.setHours(0, 0, 0, 0);
  const isTerminated = termDate != null && termDate <= today;
  const needsTermination = isTerminated && !enrollment.externalAPIDeactivatedAt;
  const isSynced = !!enrollment.externalAPISyncedAt;
  const isPending = !isSynced && !needsTermination;

  const statusLabel = needsTermination ? 'Needs termination' : isTerminated ? 'Terminated' : isSynced ? 'Synced' : 'Pending';
  const statusColor = needsTermination ? 'bg-red-100 text-red-800' : isTerminated ? 'bg-gray-100 text-gray-800' : isSynced ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800';

  const running = runningEnrollmentId === enrollment.enrollmentId;
  const showRun = isPending && canRunAPI;
  const showUpdate = isSynced && canRunAPI;
  const showTerminate = needsTermination && canRunAPI;
  const hasActions = showRun || showUpdate || showTerminate;

  if (!enrollment.hasProductAPIConfig || !canRunAPI) return null;

  const btnClass = size === 'md'
    ? 'inline-flex items-center gap-2 px-3 py-2 border border-purple-300 rounded-lg text-sm font-medium text-purple-700 bg-white hover:bg-purple-50 disabled:opacity-50'
    : 'inline-flex items-center gap-1.5 px-3 py-2 border border-purple-300 rounded-lg text-xs font-medium text-purple-700 bg-white hover:bg-purple-50 disabled:opacity-50';
  const iconSize = size === 'md' ? 'h-4 w-4' : 'h-3 w-3';

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={running}
        className={btnClass}
      >
        {running ? <Loader2 className={`${iconSize} animate-spin`} /> : <Settings className={iconSize} />}
        <span className={statusColor}>API {statusLabel}</span>
        <ChevronDown className={`${iconSize} transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20">
            <div className="px-3 py-2 border-b border-gray-100">
              <p className="text-xs font-medium text-gray-500">API Status</p>
              <p className="text-sm text-gray-900">{statusLabel}</p>
            </div>
            {hasActions && (
              <div className="border-b border-gray-100">
                <p className="px-3 py-1 text-xs font-medium text-gray-500">Actions</p>
              </div>
            )}
            {showRun && (
              <button
                type="button"
                onClick={() => { onRunAPI(enrollment.enrollmentId); setOpen(false); }}
                disabled={running}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
              >
                <Play className="h-4 w-4" /> Run API
              </button>
            )}
            {showUpdate && (
              <button
                type="button"
                onClick={() => { onUpdateAPI(enrollment.enrollmentId); setOpen(false); }}
                disabled={running}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
              >
                <RefreshCw className="h-4 w-4" /> Update API
              </button>
            )}
            {showTerminate && (
              <button
                type="button"
                onClick={() => { onRunAPI(enrollment.enrollmentId); setOpen(false); }}
                disabled={running}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
              >
                <XCircle className="h-4 w-4" /> Terminate API
              </button>
            )}
            {!hasActions && (
              <p className="px-3 py-2 text-xs text-gray-500">No actions available</p>
            )}
          </div>
        </>
      )}
    </div>
  );
};

// Grouped enrollment card component
const GroupedEnrollmentCard: React.FC<{ 
  groupedEnrollment: GroupedEnrollment;
  onViewIDCard?: (enrollment: MemberEnrollment) => void;
  onRunAPI?: (enrollmentId: string, options?: { force?: boolean }) => Promise<void>;
  onUpdateAPI?: (enrollmentId: string) => Promise<void>;
  canRunAPI?: boolean;
  paymentData?: {
    lastPaymentDate?: string;
    paymentStatus?: string;
    nextBillingDate?: string;
  };
  calculatedContribution?: number;
  memberTier?: string;
  memberTobacco?: string;
}> = ({ groupedEnrollment, onViewIDCard, onRunAPI, onUpdateAPI, canRunAPI, paymentData, calculatedContribution, memberTier, memberTobacco }) => {
  const [runningEnrollmentId, setRunningEnrollmentId] = useState<string | null>(null);
  const handleRunAPI = async (enrollmentId: string, options?: { force?: boolean }) => {
    if (!onRunAPI) return;
    setRunningEnrollmentId(enrollmentId);
    try {
      await onRunAPI(enrollmentId, options);
      setRunningEnrollmentId(null);
    } catch {
      setRunningEnrollmentId(null);
    }
  };
  const handleUpdateAPI = async (enrollmentId: string) => {
    if (!onUpdateAPI) return;
    setRunningEnrollmentId(enrollmentId);
    try {
      await onUpdateAPI(enrollmentId);
      setRunningEnrollmentId(null);
    } catch {
      setRunningEnrollmentId(null);
    }
  };
  const groupedEnrollmentIsPendingMigration = groupedEnrollment.enrollments?.some(
    (e) => e.isPendingMigration
  );
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
                  : groupedEnrollment.primaryEnrollment?.product?.description || ''
                }
              </p>
              {/* Show configuration value for individual products (e.g. Essential Sharewell Unshared Amount) */}
              {groupedEnrollment.type === 'individual' && groupedEnrollment.primaryEnrollment && (() => {
                try {
                  const comp = groupedEnrollment.primaryEnrollment;
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
                  // Prefer live ProductPricing.ConfigValue1 resolved via oe.Enrollments.ProductPricingId so
                  // that an admin relabel (e.g. 3000→2500) shows up on existing enrollments. Snapshot
                  // (enrollmentDetails.configuration) is fallback only.
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
              <div className="mt-2 flex items-center flex-wrap gap-2">
                {!(groupedEnrollment.status === 'Inactive' && groupedEnrollment.terminationDate && 
                  new Date(groupedEnrollment.terminationDate) > new Date()) && (
                  <StatusBadge status={groupedEnrollment.status} isPendingMigration={groupedEnrollmentIsPendingMigration} />
                )}
                {paymentData && (
                  <PaymentStatusBadge status={paymentData.paymentStatus} />
                )}
                {groupedEnrollment.type === 'individual' && groupedEnrollment.primaryEnrollment?.hasProductAPIConfig && (
                  <APISyncBadge synced={!!groupedEnrollment.primaryEnrollment?.externalAPISyncedAt} />
                )}
                {groupedEnrollment.type === 'bundle' && (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                    Bundle
                  </span>
                )}
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
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div className="space-y-2 min-w-0">
            {groupedEnrollment.terminationDate ? (
              <div className="flex items-center text-red-600">
                <XCircle className="h-4 w-4 mr-2 flex-shrink-0" />
                Expires: {formatDate(groupedEnrollment.terminationDate)}
              </div>
            ) : (
              groupedEnrollment.effectiveDate && (
                <div className="flex items-center text-gray-600">
                  <Calendar className="h-4 w-4 mr-2 flex-shrink-0" />
                  Effective: {formatDate(groupedEnrollment.effectiveDate)}
                </div>
              )
            )}
            {groupedEnrollment.terminationDate && groupedEnrollment.effectiveDate && (
              <div className="flex items-center text-gray-600">
                <Calendar className="h-4 w-4 mr-2 flex-shrink-0" />
                Effective: {formatDate(groupedEnrollment.effectiveDate)}
              </div>
            )}
          </div>
          {paymentData?.lastPaymentDate && (
            <div className="flex items-center text-gray-600">
              <CheckCircle className="h-4 w-4 mr-2" />
              Last Payment: {formatDate(paymentData.lastPaymentDate)}
            </div>
          )}
        </div>
        {(() => {
          const enrolledAt = getPlanGroupEnrolledDate(groupedEnrollment);
          if (!enrolledAt) return null;
          return (
            <p className="mt-2 text-xs text-gray-400">Enrolled {formatDate(enrolledAt)}</p>
          );
        })()}

        {/* Bundle Products */}
        {groupedEnrollment.type === 'bundle' && groupedEnrollment.componentEnrollments && groupedEnrollment.componentEnrollments.length > 0 && (() => {
          // Prefer live ProductPricing.ConfigValue1 on the first component so bundle pricing reflects
          // current product-level relabels. Snapshot fallback is for historical rows.
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
          
          // Calculate display prices for this bundle (matches PlansAndIdCards)
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
                  
                  // Compare each component's effective/termination date against the group's
                  // dates so we can flag products that joined the bundle later (or terminate
                  // earlier). Calendar dates are stored as UTC midnight; compare on
                  // YYYY-MM-DD prefix to avoid TZ drift.
                  const groupEffYmd = (groupedEnrollment.effectiveDate || '').split('T')[0];
                  const compEffYmd = (component.effectiveDate || '').split('T')[0];
                  const componentEffectiveDiffers =
                    compEffYmd && groupEffYmd && compEffYmd !== groupEffYmd;
                  const groupTermYmd = (groupedEnrollment.terminationDate || '').split('T')[0];
                  const compTermYmd = (component.terminationDate || '').split('T')[0];
                  const componentTerminationDiffers =
                    compTermYmd && compTermYmd !== groupTermYmd;

                  return (
                    <div key={component.enrollmentId} className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <h4 className="font-medium text-gray-900">{component.product?.name || 'Unknown Product'}</h4>
                          <p className="text-sm text-gray-600 line-clamp-2 pr-4">{component.product?.description || ''}</p>
                          {(componentEffectiveDiffers || componentTerminationDiffers) && (
                            <div className="flex flex-wrap gap-2 mt-1">
                              {componentEffectiveDiffers && (
                                <span
                                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200"
                                  title="This product's effective date differs from the bundle's start date"
                                >
                                  <Calendar className="h-3 w-3 mr-1" />
                                  Effective {formatDate(component.effectiveDate)}
                                </span>
                              )}
                              {componentTerminationDiffers && (
                                <span
                                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-50 text-red-700 border border-red-200"
                                  title="This product terminates before the rest of the bundle"
                                >
                                  <XCircle className="h-3 w-3 mr-1" />
                                  Ends {formatDate(component.terminationDate)}
                                </span>
                              )}
                            </div>
                          )}
                          {/* Show configuration value (e.g. Unshared Amount) if product has RequiredDataFields */}
                          {(() => {
                            try {
                              const rawConfigFields = component.product?.requiredDataFields ||
                                                     (component.product as any)?.RequiredDataFields;
                              if (!rawConfigFields) return null;
                              let fieldName = 'Configuration';
                              let hasValidConfigFields = false;
                              try {
                                const configFields = typeof rawConfigFields === 'string'
                                  ? JSON.parse(rawConfigFields)
                                  : rawConfigFields;
                                if (Array.isArray(configFields) && configFields.length > 0) {
                                  hasValidConfigFields = true;
                                  if (configFields[0].fieldName) {
                                    fieldName = configFields[0].fieldName;
                                  }
                                }
                              } catch (e) {
                                hasValidConfigFields = false;
                              }
                              if (!hasValidConfigFields) return null;
                              // Prefer live ProductPricing.ConfigValue1 resolved via ProductPricingId.
                              // Snapshot fallback is for historical rows only.
                              let configValue: string | null = null;
                              const pricingConfigValue = (component as any).configValue1;
                              if (pricingConfigValue && pricingConfigValue !== 'Default') {
                                configValue = pricingConfigValue;
                              } else {
                                const enrollmentDetails = component.enrollmentDetails;
                                if (enrollmentDetails && enrollmentDetails !== 'Enrolled via product change' && enrollmentDetails !== 'Updated via product change') {
                                  try {
                                    const details = typeof enrollmentDetails === 'string' ? JSON.parse(enrollmentDetails) : enrollmentDetails;
                                    if (details.configuration && details.configuration !== 'Default') {
                                      configValue = details.configuration;
                                    }
                                  } catch (e) {
                                    // Not JSON, ignore
                                  }
                                }
                              }
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
                          {component.product?.idCardData && !isIDCardDisabled(component.product?.idCardData) && onViewIDCard && (
                            <button
                              data-testid={`view-id-card-button-${component.product?.productId || component.enrollmentId}`}
                              onClick={() => onViewIDCard(component)}
                              className="inline-flex items-center px-3 py-2 border border-green-300 rounded-lg text-xs font-medium text-green-700 bg-white hover:bg-green-50"
                            >
                              <CreditCard className="h-3 w-3 mr-1" />
                              ID Card
                            </button>
                          )}
                          <ProductDocumentsLinks
                            product={component.product}
                            variant="button"
                            size="sm"
                            label="Plan Document"
                            className="inline-flex"
                          />
                          {component.hasProductAPIConfig && (
                            <APIActionsDropdown
                              enrollment={component}
                              canRunAPI={!!canRunAPI}
                              onRunAPI={(id) => handleRunAPI(id)}
                              onUpdateAPI={(id) => handleUpdateAPI(id)}
                              runningEnrollmentId={runningEnrollmentId}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        <div className="mt-4 flex justify-between items-center">
          <div className="flex gap-2 flex-wrap">
            {groupedEnrollment.type === 'individual' &&
              groupedEnrollment.status === 'Active' &&
              onViewIDCard &&
              groupedEnrollment.primaryEnrollment &&
              groupedEnrollment.primaryEnrollment.product?.idCardData &&
              !isIDCardDisabled(groupedEnrollment.primaryEnrollment.product?.idCardData) && (
              <button
                data-testid="view-id-card-button"
                onClick={() => onViewIDCard(groupedEnrollment.primaryEnrollment!)}
                className="inline-flex items-center px-3 py-2 border border-green-300 rounded-lg text-sm font-medium text-green-700 bg-white hover:bg-green-50"
              >
                <CreditCard className="h-4 w-4 mr-2" />
                View ID Card
              </button>
            )}
            {groupedEnrollment.type === 'individual' && groupedEnrollment.primaryEnrollment?.hasProductAPIConfig && canRunAPI && (
              <APIActionsDropdown
                enrollment={groupedEnrollment.primaryEnrollment}
                canRunAPI
                onRunAPI={(id) => handleRunAPI(id)}
                onUpdateAPI={(id) => handleUpdateAPI(id)}
                runningEnrollmentId={runningEnrollmentId}
                size="md"
              />
            )}
          </div>

          <div className="flex gap-2">
            <ProductDocumentsLinks
              product={groupedEnrollment.bundleProduct ?? groupedEnrollment.primaryEnrollment?.product}
              variant="button"
              size="md"
              label="Plan Document"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

const MemberPlansTab: React.FC<Props> = ({ member, onRefresh }) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [showTenantAdminWizard, setShowTenantAdminWizard] = useState(false);
  const [showEnrollmentAudit, setShowEnrollmentAudit] = useState(false);
  const [selectedIDCardEnrollment, setSelectedIDCardEnrollment] = useState<MemberEnrollment | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const memberIsPendingMigration = member.IsPendingMigration === true || member.IsPendingMigration === 1;
  const [filterStatus, setFilterStatus] = useState<'active' | 'pending' | 'terminated' | 'all'>(() =>
    memberIsPendingMigration ? 'pending' : 'active'
  );
  const [showPaymentWarning, setShowPaymentWarning] = useState(false);
  const pendingPlansSectionRef = useRef<HTMLDivElement | null>(null);

  const { data: planTenure } = useMemberPlanTenure(member.MemberId, member.TenantId);

  // Fetch member enrollments
  const { data: enrollments, isLoading: isLoadingEnrollments, isError: hasEnrollmentsError, error: enrollmentsError, refetch: refetchEnrollments } = useQuery({
    queryKey: ['memberEnrollments', member.MemberId],
    queryFn: () => fetchMemberEnrollmentsAllStatuses(member.MemberId),
    staleTime: 0, // Always refetch when invalidated to show new enrollments immediately
    refetchOnMount: true, // Refetch when component mounts
  });

  // Fetch member household data
  const { data: householdData, refetch: refetchHousehold } = useQuery({
    queryKey: ['memberHousehold', member.MemberId],
    queryFn: async () => {
      const response = await apiService.get<{ success: boolean; data: { member: Member; householdMembers: Member[] }; message?: string }>(`/api/members/${member.MemberId}/with-household`);
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch household data');
      }
      return response.data;
    },
    staleTime: 0, // Always refetch when invalidated to show updated household data immediately
    refetchOnMount: true, // Refetch when component mounts
  });

  // Get group contribution rules if member is part of a group
  const { data: groupContributionRules } = useQuery({
    queryKey: ['groupContributionRules', member.GroupId],
    queryFn: async () => {
      if (!member.GroupId) return null;
      const response = await apiService.get<{ success: boolean; data: any[] }>(`/api/groups/${member.GroupId}/contributions`);
      return response.success ? response.data : [];
    },
    enabled: !!member.GroupId,
    staleTime: 5 * 60 * 1000,
  });

  // Get member payment methods to determine if fees apply
  // Note: Same query key as MemberPaymentsTab which returns { list, hasExistingDimeCustomerId }; ensure we always get an array
  const { data: paymentMethodsData } = useQuery({
    queryKey: ['memberPaymentMethods', member.MemberId],
    queryFn: async () => {
      const response = await apiService.get<{ success: boolean; data: any[] }>(`/api/members/${member.MemberId}/payment-methods`);
      return response.success ? response.data : [];
    },
    staleTime: 5 * 60 * 1000,
  });
  const paymentMethods = (Array.isArray(paymentMethodsData) ? paymentMethodsData : (paymentMethodsData as { list?: any[] })?.list) ?? [];

  // ----- Household vendor network selection (individuals only) -----
  // Only show for non-group members and admin-capable roles. Household-scoped
  // selection drives ID card variation when the member has no GroupId.
  const canManageHouseholdNetworks = !!user?.currentRole && [
    'SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner'
  ].includes(user.currentRole);
  const showHouseholdNetworkPicker = canManageHouseholdNetworks && !member.GroupId && !!member.HouseholdId;

  const [householdVendorSelections, setHouseholdVendorSelections] = useState<VendorNetworkSelectionMap>({});
  useQuery({
    queryKey: ['householdVendorNetworks', member.HouseholdId],
    queryFn: async () => {
      if (!member.HouseholdId) return null;
      const resp = await apiService.get<{ success: boolean; data?: Array<{ vendorId: string; vendorNetworkId: string }> }>(`/api/households/${member.HouseholdId}/vendor-networks`);
      const map: VendorNetworkSelectionMap = {};
      if (resp?.success && Array.isArray(resp.data)) {
        for (const r of resp.data) {
          if (r?.vendorId) map[r.vendorId] = r.vendorNetworkId || null;
        }
      }
      setHouseholdVendorSelections(map);
      return map;
    },
    enabled: showHouseholdNetworkPicker,
    staleTime: 60 * 1000,
  });

  const householdVendorProducts = useMemo(() => {
    if (!showHouseholdNetworkPicker || !enrollments) return [];
    const seen = new Set<string>();
    const list: { VendorId: string; VendorName: string }[] = [];
    for (const e of enrollments as any[]) {
      const status = normalizeEnrollmentStatus(e.status);
      if (status !== 'Active' && status !== 'Pending') continue;
      const candidates = [e.product, e.bundleProduct].filter(Boolean);
      for (const p of candidates) {
        const vid = p?.vendorId || p?.VendorId;
        if (!vid || seen.has(vid)) continue;
        seen.add(vid);
        list.push({ VendorId: vid, VendorName: p?.vendorName || p?.VendorName || 'Vendor' });
      }
    }
    return list;
  }, [enrollments, showHouseholdNetworkPicker]);

  const queryClient = useQueryClient();

  // When onRefresh is called from parent, refetch enrollments and household
  // The parent's onRefresh will invalidate queries, which will trigger automatic refetch
  // due to staleTime: 0 and refetchOnMount: true
  useEffect(() => {
    if (onRefresh) {
      // Create a wrapper that refetches our data when onRefresh is called
      // Since onRefresh is a function prop, we can't modify it directly
      // Instead, we'll rely on query invalidation from the parent
      // The queries will automatically refetch due to staleTime: 0
    }
  }, [onRefresh, queryClient, member.MemberId]);

  // Monthly contribution — sum PremiumAmount on product + fee rows (matches billing / DIME)
  const contributionTotals = useMemo(
    () => computeMemberContributionTotals(enrollments || [], isEnrollmentActiveForContributions),
    [enrollments]
  );

  const totalMonthlyContribution = contributionTotals.totalMonthlyContribution;
  const totalPremium = contributionTotals.totalProductPremium;
  const totalEmployerContribution = contributionTotals.totalEmployerContribution;
  const processingFee = contributionTotals.processingFee;
  const yourContribution = contributionTotals.yourContribution;

  // Check if member is a group member
  const isGroupMember = member.GroupId || member.BillType === 'LB';

  const groupedEnrollments = useMemo(
    () => groupEnrollmentsForPlanWizard(enrollments || []),
    [enrollments]
  );

  // Calculate individual product contributions (matches PlansAndIdCards logic)
  const calculateProductContribution = (enrollment: GroupedEnrollment) => {
    // Ensure groupContributionRules is an array
    const rules = Array.isArray(groupContributionRules) ? groupContributionRules : [];
    
    if (!member || !rules.length) {
      return enrollment.totalPremium || 0;
    }

    try {
      const productId = enrollment.bundleId || enrollment.primaryEnrollment?.productId;
      
      // Get ONLY product-specific contribution rules (rules that apply to this specific product)
      const productRules = rules.filter((rule: any) => 
        rule.ProductId === productId && rule.Status === 'Active'
      );

      // If no product-specific rules, return full premium
      if (productRules.length === 0) {
        return enrollment.totalPremium || 0;
      }

      // Transform rules to ContributionCalculator format (matches PlansAndIdCards)
      const transformedProductRules = productRules.map((rule: any) => ({
        type: rule.ContributionType === 'flat_rate' ? 'flat_rate' : 
              rule.ContributionType === 'percentage' ? 'percentage' :
              rule.ContributionType === 'tier_based' ? 'tier_based' : 'flat_rate',
        amount: rule.ContributionType === 'flat_rate' ? rule.FlatRateAmount : 
                rule.ContributionType === 'percentage' ? rule.PercentageAmount : 0,
        description: rule.Name || '',
        appliesTo: 'product',
        contributionDirection: rule.ContributionDirection || 'Employer',
        tierContributions: rule.ContributionType === 'tier_based' ? {
          employee_only: rule.TierContributions?.EE || rule.TierContributions?.employee_only,
          employee_spouse: rule.TierContributions?.ES || rule.TierContributions?.employee_spouse,
          employee_children: rule.TierContributions?.EC || rule.TierContributions?.employee_children,
          family: rule.TierContributions?.EF || rule.TierContributions?.family || rule.TierContributions?.employee_family
        } : undefined
      }));

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
        [], // No all-products rules for individual product display
        member.Tier // Include tier support
      );

      return contributionResult.totals.totalEmployeeContribution;
    } catch (error) {
      console.warn('Failed to calculate product contribution, using fallback:', error);
      return enrollment.totalPremium || 0;
    }
  };

  // Filter enrollments
  const filterEnrollments = (enrollments: GroupedEnrollment[]) => {
    if (!enrollments) return [];
    
    return enrollments.filter((enrollment) => {
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const productName = (enrollment.bundleName || enrollment.primaryEnrollment?.product?.name || '').toLowerCase();
        const productDescription = enrollment.type === 'bundle' 
          ? `bundle with ${enrollment.componentEnrollments?.length || 0} products`
          : (enrollment.primaryEnrollment?.product?.description || '').toLowerCase();
        
        if (!productName.includes(query) && !productDescription.includes(query)) {
          return false;
        }
      }
      
      return true;
    });
  };

  const activeGroupedEnrollments = filterEnrollments(
    groupedEnrollments?.filter((e) => normalizeEnrollmentStatus(e.status) === 'Active') || []
  );

  // Tier mismatch: primary member's Tier does not match the pricing tier of one or more active product enrollments
  const tierMismatchWarning = useMemo(() => {
    if (member.RelationshipType !== 'P' || !member.Tier) return null;
    const memberTierNorm = String(member.Tier).trim().toUpperCase();
    const enrollmentsToCheck = activeGroupedEnrollments.flatMap((ge) => ge.enrollments || []);
    for (const enr of enrollmentsToCheck) {
      if (enr.enrollmentType && enr.enrollmentType !== 'Product') continue;
      if (enr.productId === '00000000-0000-0000-0000-000000000000') continue;
      const pricingTier = (enr as MemberEnrollment).pricingTier;
      if (!pricingTier) continue;
      const planTierNorm = String(pricingTier).trim().toUpperCase();
      if (memberTierNorm !== planTierNorm) {
        return { memberTier: member.Tier, planTier: pricingTier };
      }
    }
    return null;
  }, [member.RelationshipType, member.Tier, activeGroupedEnrollments]);

  const pendingTerminationEnrollments = filterEnrollments(
    groupedEnrollments?.filter((e) => {
      if (normalizeEnrollmentStatus(e.status) === 'Inactive' && e.terminationDate) {
        const terminationDate = new Date(e.terminationDate);
        const today = new Date();
        return terminationDate > today;
      }
      return false;
    }) || []
  );

  const pendingGroupedEnrollments = filterEnrollments(
    groupedEnrollments?.filter((e) => isPendingOrPaymentHoldStatus(normalizeEnrollmentStatus(e.status))) || []
  );

  const paymentHoldGroupedCount = useMemo(
    () =>
      (groupedEnrollments || []).filter((e) => normalizeEnrollmentStatus(e.status) === 'PaymentHold').length,
    [groupedEnrollments]
  );

  const scrollToPendingPlansSection = () => {
    setFilterStatus('pending');
    window.setTimeout(() => {
      pendingPlansSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  };

  // Ended plans: show Inactive (backend sets this when terminating) and Terminated (legacy enrollment status, if any)
  const inactiveGroupedEnrollments = filterEnrollments(
    groupedEnrollments?.filter((e) => {
      if (normalizeEnrollmentStatus(e.status) === 'Terminated') return true;
      if (normalizeEnrollmentStatus(e.status) === 'Inactive') {
        if (!e.terminationDate) return true;
        const terminationDate = new Date(e.terminationDate);
        const today = new Date();
        return terminationDate <= today;
      }
      return false;
    }) || []
  );

  const canRunAPI = user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin';

  const [runAPIResult, setRunAPIResult] = useState<{
    type: 'success' | 'error';
    message: string;
    data?: { activated?: number; deactivated?: number; updated?: number; errors?: { message?: string; responseBody?: unknown; responseStatus?: number }[] };
  } | null>(null);

  const handleRunAPI = async (enrollmentId: string, options?: { force?: boolean }) => {
    setRunAPIResult(null);
    try {
      const r = await apiService.post('/api/me/tenant-admin/product-api/run-api-for-enrollment', { enrollmentId, force: options?.force }) as {
        success: boolean;
        data?: { activated?: number; deactivated?: number; updated?: number; errors?: { message?: string; responseBody?: unknown; responseStatus?: number }[] };
        message?: string;
      };
      if (!r.success) {
        setRunAPIResult({
          type: 'error',
          message: r.message || 'Run failed',
          data: r as any
        });
        return;
      }
      const data = r.data || {};
      if (data.errors && data.errors.length > 0) {
        setRunAPIResult({
          type: 'error',
          message: data.errors.map((e: any) => e.message || 'Unknown error').join('; '),
          data
        });
      } else if ((data.activated ?? 0) > 0) {
        setRunAPIResult({ type: 'success', message: 'API synced successfully.', data });
      } else if ((data.deactivated ?? 0) > 0) {
        setRunAPIResult({ type: 'success', message: 'Deactivation API complete.', data });
      } else if ((data.updated ?? 0) > 0) {
        setRunAPIResult({ type: 'success', message: 'Update API complete.', data });
      } else {
        setRunAPIResult({ type: 'success', message: 'Done.', data });
      }
    } catch (e: any) {
      const msg = e.response?.data?.message || e.message || 'Run failed';
      setRunAPIResult({
        type: 'error',
        message: msg,
        data: e.response?.data
      });
    } finally {
      await refetchEnrollments();
      if (onRefresh) onRefresh();
    }
  };

  const handleUpdateAPI = async (enrollmentId: string) => {
    setRunAPIResult(null);
    try {
      const r = await apiService.post('/api/me/tenant-admin/product-api/run-update-for-enrollment', { enrollmentId }) as {
        success: boolean;
        data?: { updated?: number };
        message?: string;
      };
      if (!r.success) {
        setRunAPIResult({
          type: 'error',
          message: r.message || 'Update failed',
          data: r as any
        });
        return;
      }
      setRunAPIResult({ type: 'success', message: 'Update API complete.', data: r.data });
    } catch (e: any) {
      const msg = e.response?.data?.message || e.message || 'Update failed';
      setRunAPIResult({
        type: 'error',
        message: msg,
        data: e.response?.data
      });
    } finally {
      await refetchEnrollments();
      if (onRefresh) onRefresh();
    }
  };

  const handleViewIDCard = (enrollment: MemberEnrollment) => {
    if (isIDCardDisabled(enrollment.product?.idCardData)) return;
    setSelectedIDCardEnrollment(enrollment);
  };

  const isLoading = isLoadingEnrollments;
  const hasError = hasEnrollmentsError;

  const checkForTerminatedAccount = () => {
    if (enrollmentsError?.message?.includes('terminated')) {
      return true;
    }
    const enrollmentsErrorAny = enrollmentsError as any;
    if (enrollmentsErrorAny?.code === 'MEMBER_TERMINATED') {
      return true;
    }
    return false;
  };

  const checkForInactiveAccount = () => {
    if (enrollmentsError?.message?.includes('inactive')) {
      return true;
    }
    const enrollmentsErrorAny = enrollmentsError as any;
    if (enrollmentsErrorAny?.code === 'MEMBER_INACTIVE') {
      return true;
    }
    return false;
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto"></div>
          <p className="mt-2 text-gray-600">Loading plans...</p>
        </div>
      </div>
    );
  }

  if (checkForTerminatedAccount()) {
    const error = enrollmentsError as any;
    const memberId = error?.memberId;
    const terminatedDate = error?.terminatedDate;
    
    return <AccountTerminatedScreen memberId={memberId} terminatedDate={terminatedDate} />;
  }

  if (checkForInactiveAccount()) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <AlertCircle className="h-8 w-8 text-yellow-500 mx-auto mb-2" />
          <p className="text-yellow-600">Account Inactive</p>
          <p className="text-sm text-gray-500 mt-1">{enrollmentsError?.message || 'This account is currently inactive.'}</p>
        </div>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <AlertCircle className="h-8 w-8 text-red-500 mx-auto mb-2" />
          <p className="text-red-600">Failed to load plans</p>
          {enrollmentsError && <p className="text-sm text-gray-500 mt-1">{enrollmentsError.message}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {showHouseholdNetworkPicker && householdVendorProducts.length > 0 && (
        <VendorNetworkSelections
          selectedProducts={householdVendorProducts}
          value={householdVendorSelections}
          onChange={(next) => {
            setHouseholdVendorSelections(next);
            queryClient.invalidateQueries({ queryKey: ['memberEnrollments', member.MemberId] });
          }}
          householdId={member.HouseholdId || undefined}
          autoSave
        />
      )}
      {showTenantAdminWizard && (
        <TenantAdminPlanModificationWizardModal
          member={member}
          enrollments={enrollments || []}
          groupedEnrollments={groupedEnrollments || []}
          onClose={() => setShowTenantAdminWizard(false)}
          onApplied={async () => {
            await refetchEnrollments();
            if (onRefresh) onRefresh();
          }}
        />
      )}
      {showEnrollmentAudit && (
        <EnrollmentAuditModal
          member={member}
          onClose={() => setShowEnrollmentAudit(false)}
          onApplied={async () => {
            await refetchEnrollments();
            if (onRefresh) onRefresh();
          }}
        />
      )}
      {runAPIResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col">
            <div className={`flex items-center justify-between p-4 rounded-t-lg ${
              runAPIResult.type === 'success' ? 'bg-green-50 border-b border-green-200' : 'bg-red-50 border-b border-red-200'
            }`}>
              <h3 className={`text-lg font-semibold ${runAPIResult.type === 'success' ? 'text-green-800' : 'text-red-800'}`}>
                Run API Result
              </h3>
              <button
                type="button"
                onClick={() => setRunAPIResult(null)}
                className="p-1 rounded hover:bg-black/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 overflow-auto flex-1">
              <p className={`text-sm font-medium mb-3 ${runAPIResult.type === 'success' ? 'text-green-700' : 'text-red-700'}`}>
                {runAPIResult.message}
              </p>
              {runAPIResult.data != null && (
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Full response</p>
                  <pre className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-4 overflow-auto max-h-64 font-mono text-gray-800">
                    {JSON.stringify(runAPIResult.data, null, 2)}
                  </pre>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-gray-200">
              <button
                type="button"
                onClick={() => setRunAPIResult(null)}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 text-sm font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="border-b border-gray-200 pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 flex-wrap">
            <h3 className="text-lg font-semibold text-gray-900">Plans</h3>
            {paymentHoldGroupedCount > 0 && (
              <button
                type="button"
                onClick={scrollToPendingPlansSection}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-200 hover:bg-amber-200 transition-colors"
                title="Show enrollments waiting on payment"
              >
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                {paymentHoldGroupedCount} payment pending
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {(user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin') && (
              <button
                onClick={() => setShowEnrollmentAudit(true)}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                <Search className="h-4 w-4 mr-2" />
                Audit Data
              </button>
            )}
            {user?.currentRole === 'TenantAdmin' && (
              <button
                onClick={() => setShowTenantAdminWizard(true)}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                <Settings className="h-4 w-4 mr-2" />
                Modify Plans
              </button>
            )}
          </div>
        </div>
        {planTenure?.hasCoverage && planTenure.tenureStartDate && (
          <div className="mt-3">
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-oe-light text-oe-dark border border-oe-primary/20"
              title={planTenure.chain
                .map(c => `${c.productName || 'Plan'}: ${c.effectiveDate}${c.terminationDate ? ` → ${c.terminationDate}` : ' → present'}`)
                .join('\n')}
            >
              <Calendar className="h-3.5 w-3.5 flex-shrink-0" />
              On plan for {planTenure.daysOnPlan} {planTenure.daysOnPlan === 1 ? 'day' : 'days'} · Since {formatDate(planTenure.tenureStartDate)}
            </span>
          </div>
        )}
      </div>

      {/* Monthly Contribution Card - Full Width (matches PlansAndIdCards) */}
      {activeGroupedEnrollments.length > 0 && filterStatus === 'active' && (
        <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Monthly Contribution</h3>
          {(() => {
            console.log('🔍 DEBUG: Rendering contribution card:', {
              totalEmployerContribution,
              totalMonthlyContribution,
              totalPremium,
              hasActiveEnrollments: activeGroupedEnrollments.length > 0,
              filterStatus
            });
            return null;
          })()}
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
                  {/* Employer Contribution */}
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
                  {/* Employee Contribution */}
                  <div className="flex items-center justify-between py-2">
                    <div className="text-sm font-medium text-gray-700">{isGroupMember ? 'Employee Contribution' : 'Your Contribution'}</div>
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
                  {/* Employee Contribution */}
                  <div className="flex items-center justify-between py-2">
                    <div className="text-sm font-medium text-gray-700">{isGroupMember ? 'Employee Contribution' : 'Your Contribution'}</div>
                    <div className="text-2xl font-bold text-gray-900">
                      {PricingService.formatCurrency(yourContribution)}/mo
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tier mismatch warning */}
      {tierMismatchWarning && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-800">
              Member tier ({tierMismatchWarning.memberTier}) does not match the tier one or more plans were priced with ({tierMismatchWarning.planTier}).
            </p>
            <p className="text-sm text-amber-700 mt-1">
              Update dependents (add/remove) to sync the primary member&apos;s tier, or run a plan modification to recalculate pricing.
            </p>
          </div>
        </div>
      )}

      {/* Pending migration / payment — hidden when Active filter selected */}
      {filterStatus === 'active' && pendingGroupedEnrollments.length > 0 && (
        <div className="rounded-lg border border-violet-200 bg-violet-50 p-4 flex items-start gap-3">
          <Clock className="h-5 w-5 text-violet-700 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-violet-900">
            <p className="font-medium">
              {pendingGroupedEnrollments.length} plan(s) not shown — status is pending migration or awaiting payment.
            </p>
            <button
              type="button"
              onClick={scrollToPendingPlansSection}
              className="mt-1 text-violet-800 underline hover:text-violet-950"
            >
              Show pending plans
            </button>
          </div>
        </div>
      )}

      {/* Search and Filter Bar */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1">
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

          <div className="md:w-64">
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as 'active' | 'pending' | 'terminated' | 'all')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="active">Active Plans</option>
              <option value="pending">
                Pending, payment hold & migration
                {pendingGroupedEnrollments.length > 0 ? ` (${pendingGroupedEnrollments.length})` : ''}
              </option>
              <option value="terminated">Terminated Plans</option>
              <option value="all">All Plans</option>
            </select>
          </div>
        </div>
      </div>

      {/* Active Plans */}
      {(filterStatus === 'active' || filterStatus === 'all') && (activeGroupedEnrollments.length > 0 || pendingTerminationEnrollments.length > 0) && (
        <div data-testid="active-plans">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-gray-900">
              Active Plans
              {pendingTerminationEnrollments.length > 0 && filterStatus === 'all' && (
                <span className="text-sm font-normal text-gray-500 ml-2">
                  (including pending terminations)
                </span>
              )}
            </h2>
          </div>
          <div className="grid gap-4">
            {activeGroupedEnrollments.map((groupedEnrollment: GroupedEnrollment) => {
              const calculatedContribution = calculateProductContribution(groupedEnrollment);
              
              return (
                <GroupedEnrollmentCard
                  key={groupedEnrollment.bundleId || groupedEnrollment.primaryEnrollment?.enrollmentId}
                  groupedEnrollment={groupedEnrollment}
                  onViewIDCard={handleViewIDCard}
                  onRunAPI={handleRunAPI}
                  onUpdateAPI={handleUpdateAPI}
                  canRunAPI={canRunAPI}
                  calculatedContribution={calculatedContribution}
                  memberTier={member.Tier}
                  memberTobacco={member.TobaccoUse}
                />
              );
            })}
            
            {filterStatus === 'all' && pendingTerminationEnrollments.map((groupedEnrollment: GroupedEnrollment) => (
              <GroupedEnrollmentCard
                key={groupedEnrollment.bundleId || groupedEnrollment.primaryEnrollment?.enrollmentId}
                groupedEnrollment={groupedEnrollment}
                onViewIDCard={handleViewIDCard}
                onRunAPI={handleRunAPI}
                onUpdateAPI={handleUpdateAPI}
                canRunAPI={canRunAPI}
                memberTier={member.Tier}
                memberTobacco={member.TobaccoUse}
              />
            ))}
          </div>
        </div>
      )}

      {/* Pending Enrollments (includes PaymentHold — awaiting payment after enrollment wizard) */}
      {(filterStatus === 'pending' || filterStatus === 'all') && pendingGroupedEnrollments.length > 0 && (
        <div ref={pendingPlansSectionRef} id="member-plans-pending-section">
          <h2 className="text-lg font-medium text-gray-900 mb-4">
            Pending, payment hold & migration
          </h2>
          <div className="grid gap-4">
            {pendingGroupedEnrollments.map((groupedEnrollment: GroupedEnrollment) => (
              <GroupedEnrollmentCard
                key={groupedEnrollment.bundleId || groupedEnrollment.primaryEnrollment?.enrollmentId}
                groupedEnrollment={groupedEnrollment}
                onRunAPI={handleRunAPI}
                onUpdateAPI={handleUpdateAPI}
                canRunAPI={canRunAPI}
                memberTier={member.Tier}
                memberTobacco={member.TobaccoUse}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty State — nothing in any status bucket */}
      {activeGroupedEnrollments.length === 0 &&
        pendingTerminationEnrollments.length === 0 &&
        pendingGroupedEnrollments.length === 0 &&
        inactiveGroupedEnrollments.length === 0 && (
        <div className="text-center py-12">
          {searchQuery ? (
            <>
              <Search size={64} className="mx-auto mb-6 text-gray-400" />
              <h2 className="text-xl font-medium text-gray-900 mb-2">No Plans Found</h2>
              <p className="text-gray-600 max-w-md mx-auto mb-6">
                No plans match your search "{searchQuery}".
              </p>
              <button
                onClick={() => setSearchQuery('')}
                className="inline-flex items-center px-6 py-3 border border-gray-300 rounded-lg text-base font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                <X className="h-5 w-5 mr-2" />
                Clear Search
              </button>
            </>
          ) : (
            <>
              <CreditCard size={64} className="mx-auto mb-6 text-gray-400" />
              <h2 className="text-xl font-medium text-gray-900 mb-2">No Plans</h2>
              <p className="text-gray-600 max-w-md mx-auto mb-6">
                This member does not have any enrollments in the system yet.
              </p>
            </>
          )}
        </div>
      )}

      {/* Terminated Plans */}
      {(filterStatus === 'terminated' || filterStatus === 'all') && inactiveGroupedEnrollments.length > 0 && (
        <div>
          <h2 className="text-lg font-medium text-gray-900 mb-4">Terminated Plans</h2>
          <div className="grid gap-4">
            {inactiveGroupedEnrollments.map((groupedEnrollment: GroupedEnrollment) => (
              <GroupedEnrollmentCard
                key={groupedEnrollment.bundleId || groupedEnrollment.primaryEnrollment?.enrollmentId}
                groupedEnrollment={groupedEnrollment}
                onRunAPI={handleRunAPI}
                onUpdateAPI={handleUpdateAPI}
                canRunAPI={canRunAPI}
                memberTier={member.Tier}
                memberTobacco={member.TobaccoUse}
              />
            ))}
          </div>
        </div>
      )}

      {/* ID Card Display Modal */}
      {selectedIDCardEnrollment && householdData && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-gray-900">Digital ID Card - {selectedIDCardEnrollment.product?.name || 'Unknown Product'}</h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => refetchHousehold()}
                    className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                    title="Refresh household data"
                  >
                    <Clock className="h-4 w-4 mr-1" />
                    Refresh
                  </button>
                  <button
                    onClick={() => setSelectedIDCardEnrollment(null)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-6 w-6" />
                  </button>
                </div>
              </div>
            </div>

            <div className="p-6">
              <IDCard
                idCardData={selectedIDCardEnrollment.product?.idCardData || {
                  Card_Front: {
                    Header: { Image: '' },
                    Footer: { Header: 'Contact Information', Text1: 'For Eligibility, Benefits & Customer Service', Text2: '(904) 373-6872' }
                  },
                  Card_Back: {
                    Top_Left: { Image: '', Header: 'ER Visits', Text1: 'Request an Itemized Bill\n(Submit Sharing Request)', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
                    Top_Right: { Image: '', Header: 'Planned Healthcare', Text1: 'Contact Member Success\nfor Payment Services', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
                    Middle: { Image: '', Header: 'Contact ShareWELL Partners', Text1: 'Member Success Phone (904) 373-6872\nHow to Submit a Share Request', Link_Name1: 'How to Submit a Share Request', URL1: 'https://sharewellpartners.com/sharingrequest/', Link_Name2: '', URL2: '' },
                    Bottom_Left: { Image: '', Header: 'Member Success Email', Text1: '', Link_Name1: 'membersuccess@sharewellpartners.com', URL1: 'mailto:membersuccess@sharewellpartners.com', Link_Name2: '', URL2: '' },
                    Bottom_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' }
                  }
                }}
                memberInfo={{
                  firstName: householdData.member.FirstName || '',
                  lastName: householdData.member.LastName || '',
                  memberId: (() => {
                    const raw = resolveHouseholdMemberId(householdData.member);
                    const tenantPrefix =
                      householdData.member.TenantMemberIDPrefix ??
                      (selectedIDCardEnrollment as { memberTenantMemberIdPrefix?: string })
                        .memberTenantMemberIdPrefix;
                    const masked =
                      raw != null
                        ? applyProductMemberIdPrefixMask(
                            raw,
                            tenantPrefix,
                            selectedIDCardEnrollment.product?.idCardMemberIdPrefixMask,
                            householdData.member.TenantIndividualMemberIDPrefix
                          )
                        : undefined;
                    return masked ?? raw ?? 'Not Assigned';
                  })(),
                  dateOfBirth: householdData.member.DateOfBirth || '1990-01-01',
                  planName: selectedIDCardEnrollment.product?.name || 'Unknown Product',
                  effectiveDate: selectedIDCardEnrollment.effectiveDate,
                  spouse: (() => {
                    // Get spouse from household data (matches IDCards.tsx)
                    if (!householdData?.householdMembers) return undefined;
                    const spouse = householdData.householdMembers.find(member => 
                      member.MemberId !== householdData.member.MemberId && 
                      member.RelationshipType === 'S' &&
                      member.Status !== 'Terminated'
                    );
                    if (!spouse) return undefined;
                    const genderValue = (spouse.Gender || '').toString();
                    return {
                      name: `${spouse.FirstName} ${spouse.LastName}`,
                      dob: spouse.DateOfBirth || '',
                      gender: genderValue
                    };
                  })(),
                  dependents: (() => {
                    // Get children (dependents) from household data (matches IDCards.tsx)
                    if (!householdData?.householdMembers) return undefined;
                    const dependents = householdData.householdMembers
                      .filter(member => 
                        member.MemberId !== householdData.member.MemberId && 
                        member.RelationshipType === 'C' &&
                        member.Status !== 'Terminated'
                      )
                      .map(member => {
                        const genderValue = (member.Gender || '').toString();
                        return {
                          name: `${member.FirstName} ${member.LastName}`,
                          dob: member.DateOfBirth || '',
                          gender: genderValue
                        };
                      });
                    return dependents.length > 0 ? dependents : undefined;
                  })()
                }}
                productName={selectedIDCardEnrollment.product?.name || 'Unknown Product'}
                groupId={(selectedIDCardEnrollment.product as any)?.groupId || null}
                showGroupId={(selectedIDCardEnrollment.product as any)?.showGroupIdOnIDCard || false}
                fallbackLogoUrl={selectedIDCardEnrollment.product?.productLogoUrl || selectedIDCardEnrollment.product?.productImageUrl || ''}
                idCardConfigurationDisplay={selectedIDCardEnrollment.idCardConfigurationDisplay ?? null}
              />
            </div>
          </div>
        </div>
      )}

      {/* Payment Method Warning Modal */}
      {showPaymentWarning && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-lg p-6 max-w-md mx-4 shadow-xl">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <AlertCircle className="h-6 w-6 text-red-600" />
              </div>
              <div className="ml-3 flex-1">
                <h3 className="text-lg font-medium text-gray-900">
                  No Payment Method on File
                </h3>
                <div className="mt-2 text-sm text-gray-600">
                  <p>
                    {member.FirstName} {member.LastName} does not have an active payment method on file. 
                    {isGroupMember 
                      ? ' However, since this is a group member, payment is handled at the group level and this check is bypassed.'
                      : ' A payment method is required to modify their plan.'}
                  </p>
                  {!isGroupMember && (
                    <p className="mt-2">
                      Please have the member add a payment method before proceeding with plan modifications.
                    </p>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-5 sm:mt-6">
              <button
                onClick={() => setShowPaymentWarning(false)}
                className="w-full inline-flex justify-center px-4 py-2 bg-oe-primary text-white text-sm font-medium rounded-lg hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MemberPlansTab;
