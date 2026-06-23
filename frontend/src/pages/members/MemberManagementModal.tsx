// File: frontend/src/pages/members/MemberManagementModal.tsx
import { AlertCircle, AtSign, Building2, CreditCard, DollarSign, Download, ExternalLink, History, KeyRound, LogOut, Mail, MessageCircle, MessageSquare, Pencil, Users, Wallet, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import ChangeEmailModal from '../../components/shared/ChangeEmailModal';
import SetTemporaryPasswordModal from '../../components/shared/SetTemporaryPasswordModal';
import { useAuth } from '../../contexts/AuthContext';
import { useHouseholdCredits } from '../../hooks/useHouseholdCredits';
import { useInvoices } from '../../hooks/useInvoices';
import { authService } from '../../services/auth.service';
import { apiService } from '../../services/api.service';
import { MemberEnrollment, mapEnrollmentProductDocuments } from '../../services/member/member-enrollments.service';
import { Member, resolveHouseholdMemberId } from '../../types/member.types';
import { generateMemberDetailsExport } from '../../utils/excelGenerator';
import { invoiceShowsPastDueCollectionBanner } from '../../utils/helpers';
import { MemberEnrollmentLifecycleBadges } from '../../components/members/MemberEnrollmentLifecycleBadges';
import MemberCommunicationsTab from './tabs/MemberCommunicationsTab';
import MemberDependentsTab from './tabs/MemberDependentsTab';
import MemberHistoryTab from './tabs/MemberHistoryTab';
import MemberIDCardsTab from './tabs/MemberIDCardsTab';
import MemberOverviewTab from './tabs/MemberOverviewTab';
import MemberPaymentsTab from './tabs/MemberPaymentsTab';
import MemberPlansTab from './tabs/MemberPlansTab';
import EncountersList from '../../components/vendor/encounters/EncountersList';

interface UserSessionRow {
  sessionId: string;
  userId: string;
  createdAt: string;
  lastActivityAt: string;
  userAgent: string | null;
}

interface Enrollment {
  EnrollmentId: string;
  ProductName: string;
  ProductType: string;
  Status: string;
  EffectiveDate: string;
  TerminationDate?: string;
  Premium: number;
  PaymentFrequency: string;
}

interface Props {
  member: Member;
  householdMembers: Member[];
  memberEnrollments: Enrollment[];
  enrollmentsLoading: boolean;
  onClose: () => void;
  onEdit: (member: Member) => void;
  onSendEnrollmentLink?: (member: Member) => void;
  formatCurrency: (amount: number) => string;
  getStatusColor: (status: string) => string;
  getRelationshipIcon: (relationshipType?: string) => React.ReactNode;
  getRelationshipColor: (relationshipType?: string) => string;
  canEdit?: boolean;
  canDelete?: boolean;
  onRefresh?: () => void;
  /** After household remove succeeds (refetch + close modal). */
  onRemoveComplete?: () => void | Promise<void>;
  /** When opening the modal, select this tab first (e.g. Billing). */
  initialTab?: TabType;
  /** Root overlay z-index when stacking above another modal (e.g. z-[90]). */
  overlayZIndexClass?: string;
  /** Inner confirmation overlays (defaults above root). */
  nestedOverlayZIndexClass?: string;
}

export type MemberManagementModalTab =
  | 'overview'
  | 'plans'
  | 'id-cards'
  | 'dependents'
  | 'payments'
  | 'encounters'
  | 'authentication'
  | 'history'
  | 'communications';

type TabType = MemberManagementModalTab;

const tierDisplayName = (tier: string | undefined): string => {
  if (!tier) return '';
  const map: Record<string, string> = { EE: 'Employee Only', ES: 'Employee + Spouse', EC: 'Employee + Children', EF: 'Employee + Family' };
  return map[tier] || tier;
};

const MemberManagementModal: React.FC<Props> = ({
  member,
  householdMembers,
  memberEnrollments,
  enrollmentsLoading,
  onClose,
  onEdit,
  onSendEnrollmentLink,
  formatCurrency,
  getStatusColor,
  getRelationshipIcon,
  getRelationshipColor,
  canEdit = true,
  canDelete = true,
  onRefresh,
  onRemoveComplete,
  initialTab,
  overlayZIndexClass = 'z-50',
  nestedOverlayZIndexClass = 'z-[60]',
}) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabType>(() => initialTab ?? 'overview');
  const [isExporting, setIsExporting] = useState(false);
  const [sessions, setSessions] = useState<UserSessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [changeEmailOpen, setChangeEmailOpen] = useState(false);
  const [setTempPasswordOpen, setSetTempPasswordOpen] = useState(false);
  const [sendResetLoading, setSendResetLoading] = useState(false);
  const [showResetSentModal, setShowResetSentModal] = useState(false);
  const [showSendLinkBlockedModal, setShowSendLinkBlockedModal] = useState(false);

  const showRecurringSection = user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin';
  const canManagePaymentMethods =
    user?.currentRole === 'TenantAdmin' ||
    user?.currentRole === 'SysAdmin' ||
    user?.currentRole === 'Agent' ||
    user?.currentRole === 'AgencyOwner' ||
    user?.currentRole === 'GroupAdmin';
  const showFullAuthTab =
    (user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin') && !!member.UserId;
  const showAgentAuthTab =
    (user?.currentRole === 'Agent' || user?.currentRole === 'AgencyOwner') && !!member.Email;
  const canChangeEmail =
    !!member.UserId &&
    (user?.currentRole === 'SysAdmin' ||
      user?.currentRole === 'TenantAdmin' ||
      user?.currentRole === 'GroupAdmin' ||
      user?.currentRole === 'Agent' ||
      user?.currentRole === 'AgencyOwner');
  /** When true, show the Authentication tab (password reset; full session tools for tenant/sysadmin). */
  const showSessionsTab = showFullAuthTab || showAgentAuthTab;
  const showHistoryTab = user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin';
  const householdMemberId =
    resolveHouseholdMemberId(member);

  // Phase 1g.2: surface available account credit in the modal header
  const { data: householdCredit } = useHouseholdCredits(member.HouseholdId || null);
  const creditBalance = Number(householdCredit?.availableCredit || 0);
  // Sum the absolute value of all AppliedToInvoice ledger rows so admins can see
  // historical credit activity even after the available balance reaches $0.
  const appliedCreditTotal = useMemo(() => {
    const entries = householdCredit?.byEntry || [];
    return entries
      .filter(e => e.EntryType === 'AppliedToInvoice')
      .reduce((acc, e) => acc + Math.abs(Number(e.Amount) || 0), 0);
  }, [householdCredit?.byEntry]);

  // Phase 1h: surface underpaid / past-due invoices at the modal level so admins
  // see the manual-collect signal regardless of which tab they have open. Never
  // auto-charge — admin handles collection manually.
  const { data: invoicesData } = useInvoices(
    { householdId: member.HouseholdId || undefined, type: 'Individual' },
    !!member.HouseholdId
  );
  const underpaidInvoices = useMemo(() => {
    const list = invoicesData?.invoices || [];
    return list.filter((inv) => {
      const status = String(inv?.Status || '').toLowerCase();
      const balance = Number(inv?.BalanceDue) || 0;
      return balance > 0.005 && (status === 'partial' || status === 'overdue' || status === 'unpaid');
    });
  }, [invoicesData]);
  // Split into past-due (due calendar date before today or Status=Overdue → admin collect) vs upcoming.
  // Do not compare DueDate UTC instants — same bug as invoices table (false past-due on the due date in US TZ).
  const { pastDueInvoices, upcomingInvoices, pastDueTotal, upcomingTotal } = useMemo(() => {
    const pastDue = underpaidInvoices.filter((inv) => invoiceShowsPastDueCollectionBanner(inv));
    const upcoming = underpaidInvoices.filter((inv) => !pastDue.includes(inv));
    return {
      pastDueInvoices: pastDue,
      upcomingInvoices: upcoming,
      pastDueTotal: pastDue.reduce((acc, inv) => acc + (Number(inv?.BalanceDue) || 0), 0),
      upcomingTotal: upcoming.reduce((acc, inv) => acc + (Number(inv?.BalanceDue) || 0), 0)
    };
  }, [underpaidInvoices]);

  const fetchSessions = useCallback(async () => {
    if (!member.UserId) return;
    setSessionsLoading(true);
    try {
      const res = await apiService.get<{ success: boolean; data: UserSessionRow[] }>(`/api/me/tenant-admin/user-sessions?userId=${encodeURIComponent(member.UserId)}`);
      if (res.success && Array.isArray(res.data)) {
        setSessions(res.data);
      } else {
        setSessions([]);
      }
    } catch {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, [member.UserId]);

  const handleRevokeAllSessions = useCallback(async () => {
    if (!member.UserId) return;
    setRevoking(true);
    try {
      const res = await apiService.post<{ success: boolean; message?: string }>('/api/me/tenant-admin/user-sessions/revoke', { userId: member.UserId });
      if (res.success) {
        toast.success(res.message || 'All sessions revoked');
        await fetchSessions();
      } else {
        toast.error('Failed to revoke sessions');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to revoke sessions');
    } finally {
      setRevoking(false);
    }
  }, [member.UserId, fetchSessions]);

  const handleRevokeSession = useCallback(async (sessionId: string) => {
    if (!member.UserId) return;
    setRevoking(true);
    try {
      const res = await apiService.post<{ success: boolean; message?: string }>('/api/me/tenant-admin/user-sessions/revoke', { userId: member.UserId, sessionId });
      if (res.success) {
        toast.success(res.message || 'Session revoked');
        await fetchSessions();
      } else {
        toast.error('Failed to revoke session');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to revoke session');
    } finally {
      setRevoking(false);
    }
  }, [member.UserId, fetchSessions]);

  const handleSendPasswordReset = useCallback(async () => {
    if (!member?.Email) return;
    setSendResetLoading(true);
    try {
      await authService.requestPasswordReset(member.Email);
      setShowResetSentModal(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send password reset email');
    } finally {
      setSendResetLoading(false);
    }
  }, [member?.Email]);

  // Encounters live in the vendor portal only — the backend routes are
  // VendorAdmin/VendorAgent-gated and would 403 for tenant admins anyway.
  const showEncountersTab =
    user?.currentRole === 'VendorAdmin' || user?.currentRole === 'VendorAgent';

  const tabs = useMemo(() => {
    const base = [
      { id: 'overview' as TabType, label: 'Overview', icon: Users },
      { id: 'plans' as TabType, label: 'Plans', icon: CreditCard },
      { id: 'id-cards' as TabType, label: 'ID Cards', icon: CreditCard },
      { id: 'dependents' as TabType, label: 'Dependents', icon: Users },
      { id: 'payments' as TabType, label: 'Billing', icon: Wallet },
    ];
    if (showEncountersTab) {
      base.push({ id: 'encounters' as TabType, label: 'Encounters', icon: MessageCircle });
    }
    if (showSessionsTab) {
      base.push({ id: 'authentication' as TabType, label: 'Authentication', icon: KeyRound });
    }
    if (showHistoryTab) {
      base.push({ id: 'history' as TabType, label: 'History', icon: History });
      base.push({ id: 'communications' as TabType, label: 'Communications', icon: MessageSquare });
    }
    return base;
  }, [showSessionsTab, showHistoryTab, showEncountersTab]);

  useEffect(() => {
    if (activeTab === 'authentication' && showFullAuthTab && member.UserId) {
      fetchSessions();
    }
  }, [activeTab, member.UserId, fetchSessions, showFullAuthTab]);

  const handleExportMemberDetails = async () => {
    setIsExporting(true);
    try {
      // Debug: Log member object to see what agent info is available
      console.log('🔍 Export - Member object:', {
        MemberId: member.MemberId,
        AgentName: member.AgentName,
        AgentEmail: member.AgentEmail,
        GroupAgentName: member.GroupAgentName,
        GroupAgentEmail: member.GroupAgentEmail,
        AgentId: member.AgentId,
        fullMember: member
      });
      
      // Fetch comprehensive enrollment data (similar to MemberPlansTab)
      const response = await apiService.get<{ success: boolean; data: any[]; message?: string }>(`/api/enrollments?memberId=${member.MemberId}`);
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch enrollments');
      }

      // Transform PascalCase API response to camelCase for TypeScript interface
      const transformedEnrollments: MemberEnrollment[] = response.data
        .filter((enrollment: any) => {
          // Include Product, Contribution, PaymentProcessingFee, ProcessingFee, and SystemFee enrollments (or NULL for backward compatibility)
          const enrollmentType = enrollment.EnrollmentType;
          return !enrollmentType || enrollmentType === 'Product' || enrollmentType === 'Contribution' || enrollmentType === 'PaymentProcessingFee' || enrollmentType === 'ProcessingFee' || enrollmentType === 'SystemFee';
        })
        .map((enrollment: any) => ({
          enrollmentId: enrollment.EnrollmentId,
          memberId: enrollment.MemberId,
          productId: enrollment.ProductId,
          status: enrollment.Status,
          effectiveDate: enrollment.EffectiveDate,
          terminationDate: enrollment.TerminationDate,
          premiumAmount: enrollment.PremiumAmount || enrollment.Premium || 0,
          includedPaymentProcessingFeeAmount: enrollment.IncludedPaymentProcessingFeeAmount != null ? Number(enrollment.IncludedPaymentProcessingFeeAmount) : 0,
          includedSystemFeeAmount: enrollment.IncludedSystemFeeAmount != null ? Number(enrollment.IncludedSystemFeeAmount) : 0,
          paymentFrequency: enrollment.PaymentFrequency || 'Monthly',
          createdDate: enrollment.CreatedDate,
          modifiedDate: enrollment.ModifiedDate || enrollment.CreatedDate,
          memberName: enrollment.MemberName,
          productBundleID: enrollment.ProductBundleID,
          enrollmentDetails: enrollment.EnrollmentDetails,
          enrollmentType: enrollment.EnrollmentType,
          groupID: enrollment.GroupID,
          employerContributionAmount: enrollment.EmployerContributionAmount,
          contributionId: enrollment.ContributionId,
          product: enrollment.ProductId ? {
            productId: enrollment.ProductId,
            name: enrollment.ProductName || 'Unknown Product',
            description: enrollment.ProductDescription || '',
            productType: enrollment.ProductType || '',
            productImageUrl: enrollment.ProductImageUrl,
            productLogoUrl: enrollment.ProductLogoUrl,
            productDocumentUrl: enrollment.ProductDocumentUrl,
            productDocuments: mapEnrollmentProductDocuments(enrollment.ProductDocuments),
            idCardData: enrollment.IDCardData ? (typeof enrollment.IDCardData === 'string' ? JSON.parse(enrollment.IDCardData) : enrollment.IDCardData) : null,
            requiredDataFields: enrollment.RequiredDataFields ? (typeof enrollment.RequiredDataFields === 'string' ? JSON.parse(enrollment.RequiredDataFields) : enrollment.RequiredDataFields) : [],
            features: [],
            productOwnerName: enrollment.ProductOwnerName,
            hidePricing: enrollment.HidePricing || false,
            linkedToProductId: enrollment.LinkedToProductId || null,
            vendorName: enrollment.VendorName || ''
          } : null,
          bundleProduct: enrollment.ProductBundleID ? {
            productId: enrollment.ProductBundleID,
            name: enrollment.BundleProductName,
            description: enrollment.BundleProductDescription,
            productType: enrollment.BundleProductType,
            productImageUrl: enrollment.BundleProductImageUrl,
            productLogoUrl: enrollment.BundleProductLogoUrl,
            productDocumentUrl: enrollment.BundleProductDocumentUrl,
            productDocuments: mapEnrollmentProductDocuments(enrollment.BundleProductDocuments),
            features: [],
            idCardData: enrollment.BundleIDCardData ? (typeof enrollment.BundleIDCardData === 'string' ? JSON.parse(enrollment.BundleIDCardData) : enrollment.BundleIDCardData) : null,
            vendorName: enrollment.BundleVendorName || ''
          } : null,
          // Add ConfigValue fields for backward compatibility
          configValue1: enrollment.ConfigValue1,
          configValue2: enrollment.ConfigValue2,
          configValue3: enrollment.ConfigValue3,
          configValue4: enrollment.ConfigValue4,
          configValue5: enrollment.ConfigValue5
        }));

      // Generate export
      generateMemberDetailsExport({
        member,
        householdMembers,
        enrollments: transformedEnrollments
      });

      toast.success('Member details exported successfully');
    } catch (error) {
      console.error('Error exporting member details:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to export member details');
    } finally {
      setIsExporting(false);
    }
  };

  const loginAccountInactive = !!member.UserId && member.UserStatus != null && member.UserStatus !== 'Active';

  const handleOpenSendLinkModal = () => {
    const hasActiveEnrollments = Array.isArray(memberEnrollments) && memberEnrollments.some((enrollment) =>
      String(enrollment?.Status || '').toLowerCase() === 'active'
    );
    if (hasActiveEnrollments) {
      setShowSendLinkBlockedModal(true);
      return;
    }

    if (onSendEnrollmentLink) {
      onSendEnrollmentLink(member);
      return;
    }

    let basePath = '/tenant-admin/enrollment-links';
    if (user?.currentRole === 'Agent') {
      basePath = '/agent/enrollment-links';
    } else if (user?.currentRole === 'SysAdmin') {
      basePath = '/admin/enrollment-links';
    }

    onClose();
    navigate(basePath, {
      state: {
        sendLinkMember: {
          memberId: member.MemberId,
          firstName: member.FirstName,
          lastName: member.LastName,
          email: member.Email,
          phoneNumber: member.PhoneNumber,
          agentId: member.AgentId || member.GroupAgentId
        }
      }
    });
  };

  return (
    <div className={`fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 ${overlayZIndexClass}`}>
      <div className="bg-white rounded-lg max-w-7xl w-full max-h-[95vh] overflow-hidden flex flex-col">
        {/* Login account inactive – show very clearly at the top */}
        {loginAccountInactive && (
          <div className="bg-amber-50 border-b-2 border-amber-400 px-6 py-3 flex items-center gap-3">
            <div className="flex-shrink-0 h-8 w-8 rounded-full bg-amber-100 flex items-center justify-center">
              <LogOut className="h-4 w-4 text-amber-700" />
            </div>
            <div>
              <p className="text-sm font-semibold text-amber-900">
                Login account is not active
              </p>
              <p className="text-sm text-amber-800">
                This member has a login account but it is <strong>{member.UserStatus}</strong>. They cannot sign in until the account is active. Use &quot;Set temporary password&quot; on the Authentication tab to set a password and activate the account.
              </p>
            </div>
          </div>
        )}
        {/* Underpaid invoices: show top strip only when past-due / Overdue requires manual collection */}
        {pastDueInvoices.length > 0 && (
          <div className="bg-yellow-50 border-b border-yellow-200 px-6 py-3 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-yellow-700 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-yellow-900">
              <span className="font-semibold">${pastDueTotal.toFixed(2)} past-due</span>{' '}
              across {pastDueInvoices.length} invoice{pastDueInvoices.length === 1 ? '' : 's'} — not auto-charged, admin must collect manually from the Payments tab.
              {upcomingInvoices.length > 0 && (
                <span className="block text-xs mt-1 text-yellow-800">
                  Plus ${upcomingTotal.toFixed(2)} upcoming on {upcomingInvoices.length} invoice{upcomingInvoices.length === 1 ? '' : 's'} (will run on next recurring cycle).
                </span>
              )}
            </div>
          </div>
        )}
        {/* Tenant badge (SysAdmin only) — shown above the group badge so SysAdmin always knows which
            tenant a member belongs to, even when they're not in a group. TenantAdmins are already
            scoped to one tenant so this is noise for them. */}
        {user?.currentRole === 'SysAdmin' && (member.TenantName || member.TenantId) && (
          <div className="px-6 pt-4 pb-2 border-b border-gray-100 bg-gray-50/50">
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Building2 className="h-4 w-4 text-gray-500" />
              <span className="font-medium">{member.TenantName || member.TenantId}</span>
              <span className="text-xs text-gray-500">Tenant</span>
            </div>
          </div>
        )}
        {/* Group badge (when member is in a group) */}
        {member.GroupId && member.GroupName && (
          <div className="px-6 pt-4 pb-2 border-b border-gray-100 bg-gray-50/50">
            <div className="flex items-center gap-3">
              {member.GroupLogoUrl && (
                <img
                  src={member.GroupLogoUrl}
                  alt=""
                  className="h-8 w-auto object-contain max-w-[120px]"
                />
              )}
              <span className="text-sm font-medium text-gray-700">{member.GroupName}</span>
            </div>
          </div>
        )}
        {/* Header */}
        <div className="p-6 border-b border-gray-200">
          <div className="flex justify-between items-start">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1 flex-wrap">
                <h2 className="text-2xl font-semibold text-gray-900 flex items-center gap-3 flex-wrap min-w-0">
                  <span>
                    {member.FirstName} {member.LastName}
                  </span>
                  {householdMemberId ? (
                    <span
                      className="text-sm font-mono font-semibold text-gray-800 bg-gray-100 border border-gray-200 px-2.5 py-1 rounded-md shrink-0"
                      title="Household member ID"
                    >
                      {householdMemberId}
                    </span>
                  ) : null}
                </h2>
                <MemberEnrollmentLifecycleBadges
                  member={member}
                  getStatusColor={getStatusColor}
                  showEffectiveDateBadge={false}
                  iconSizeClass="h-3.5 w-3.5"
                />
                <div className="flex items-center">
                  {getRelationshipIcon(member.RelationshipType)}
                  <span className={`ml-1 px-2 py-1 text-xs font-medium rounded-full ${getRelationshipColor(member.RelationshipType)}`}>
                    {member.RelationshipDescription || 'Primary'}
                  </span>
                </div>
                {member.Tier && (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800" title={tierDisplayName(member.Tier)}>
                    Tier: {member.Tier}
                  </span>
                )}
                {Math.abs(creditBalance) >= 0.005 && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-green-50 text-oe-success border border-green-200"
                    title="Account credit available — auto-applied to next unpaid invoice"
                  >
                    <DollarSign className="h-3 w-3" />
                    ${creditBalance.toFixed(2)} credit
                  </span>
                )}
                {Math.abs(creditBalance) < 0.005 && appliedCreditTotal >= 0.005 && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-blue-50 text-oe-primary border border-blue-200"
                    title="Credit history — already applied to invoice(s)"
                  >
                    <DollarSign className="h-3 w-3" />
                    ${appliedCreditTotal.toFixed(2)} applied
                  </span>
                )}
              </div>
              <p className="text-gray-600 flex items-center gap-2">
                <span>{member.Email}</span>
                {canChangeEmail && (
                  <button
                    type="button"
                    onClick={() => setChangeEmailOpen(true)}
                    className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white p-1.5 text-gray-600 hover:bg-gray-50 hover:text-oe-primary hover:border-gray-400 transition-colors"
                    title="Change email"
                    aria-label="Change email"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleOpenSendLinkModal}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors"
              >
                <Mail className="h-4 w-4 mr-2" />
                Send Link
              </button>
              {canEdit && (
                <button 
                  onClick={() => onEdit(member)}
                  className="btn-primary"
                >
                  Edit Member
                </button>
              )}
              {showEncountersTab && (
                <button
                  type="button"
                  onClick={() => { onClose(); navigate(`/vendor/members/${member.MemberId}`); }}
                  className="inline-flex items-center px-4 py-2 border border-oe-primary rounded-lg text-sm font-medium text-oe-dark bg-white hover:bg-oe-light transition-colors"
                  title="Open this member on the Members page"
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Go to member profile
                </button>
              )}
              <button
                onClick={handleExportMemberDetails}
                disabled={isExporting}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="Export member details to Excel"
              >
                {isExporting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600 mr-2"></div>
                    Exporting...
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4 mr-2" />
                    Export Member Details
                  </>
                )}
              </button>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 px-6">
          <nav className="-mb-px flex space-x-8">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`
                    py-4 px-1 border-b-2 font-medium text-sm transition-colors flex items-center gap-2
                    ${activeTab === tab.id
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }
                  `}
                >
                  <Icon className="h-4 w-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'overview' && (
            <MemberOverviewTab
              member={member}
              householdMembers={householdMembers}
              memberEnrollments={memberEnrollments}
              enrollmentsLoading={enrollmentsLoading}
              onEdit={onEdit}
              onSendEnrollmentLink={onSendEnrollmentLink}
              formatCurrency={formatCurrency}
              getStatusColor={getStatusColor}
              getRelationshipIcon={getRelationshipIcon}
              getRelationshipColor={getRelationshipColor}
              canEdit={canEdit}
              canDelete={canDelete}
              canChangeEmail={canChangeEmail}
              onChangeEmail={() => setChangeEmailOpen(true)}
              onRemoveComplete={async () => {
                await onRefresh?.();
                await onRemoveComplete?.();
              }}
              agentPanelEditHint={
                (user?.currentRole === 'SysAdmin' || user?.currentRole === 'TenantAdmin') && !member.GroupId
                  ? 'change-agent'
                  : 'edit-member'
              }
            />
          )}

          {activeTab === 'plans' && (
            <div className="flex flex-col">
              <div className="px-6 py-3 border-b border-gray-200 bg-gray-50/80">
                <span className="text-sm text-gray-600">Tobacco: </span>
                <span className={member.TobaccoUse === 'Y' ? 'text-amber-600 font-medium' : 'text-gray-900'}>
                  {member.TobaccoUse === 'Y' ? 'Yes' : member.TobaccoUse === 'N' ? 'No' : 'Unknown'}
                </span>
              </div>
              <MemberPlansTab
                member={member}
                onRefresh={onRefresh}
              />
            </div>
          )}

          {activeTab === 'id-cards' && (
            <MemberIDCardsTab
              member={member}
              onRefresh={onRefresh}
            />
          )}

          {activeTab === 'dependents' && (
            <MemberDependentsTab
              member={member}
              householdMembers={householdMembers}
              getRelationshipIcon={getRelationshipIcon}
              getRelationshipColor={getRelationshipColor}
              canManage={true}
              onRefresh={onRefresh}
            />
          )}

          {activeTab === 'payments' && (
            <MemberPaymentsTab
              member={member}
              showRecurringSection={showRecurringSection}
              canManagePaymentMethods={canManagePaymentMethods}
              canManageCredits={user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin'}
              onRefresh={onRefresh}
            />
          )}

          {activeTab === 'encounters' && showEncountersTab && (
            <EncountersList scope={{ kind: 'member', memberId: member.MemberId }} />
          )}

          {activeTab === 'history' && showHistoryTab && (
            <MemberHistoryTab memberId={member.MemberId} />
          )}

          {activeTab === 'communications' && showHistoryTab && (
            <MemberCommunicationsTab member={member} />
          )}

          {activeTab === 'authentication' && showSessionsTab && (
            <div className="p-6">
              <div className="mb-6">
                <h3 className="text-sm font-medium text-gray-700 mb-2">Account actions</h3>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleSendPasswordReset}
                    disabled={sendResetLoading || !member?.Email}
                    className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {sendResetLoading ? (
                      <>
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600 inline-block mr-2" />
                        Sending...
                      </>
                    ) : (
                      <>
                        <Mail className="h-4 w-4 mr-2" />
                        Send password reset
                      </>
                    )}
                  </button>
                  {canChangeEmail && (
                    <button
                      type="button"
                      onClick={() => setChangeEmailOpen(true)}
                      className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      <AtSign className="h-4 w-4 mr-2" />
                      Change email
                    </button>
                  )}
                  {showFullAuthTab && (
                    <>
                      <button
                        type="button"
                        onClick={() => setSetTempPasswordOpen(true)}
                        className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        <KeyRound className="h-4 w-4 mr-2" />
                        Set temporary password
                      </button>
                    </>
                  )}
                </div>
              </div>
              {showFullAuthTab && (
                <>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-medium text-gray-900">Active sessions</h3>
                    <button
                      type="button"
                      onClick={handleRevokeAllSessions}
                      disabled={sessionsLoading || revoking || sessions.length === 0}
                      className="inline-flex items-center rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      Revoke all sessions
                    </button>
                  </div>
                  {sessionsLoading ? (
                    <div className="flex items-center gap-2 text-gray-500">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
                      Loading sessions...
                    </div>
                  ) : sessions.length === 0 ? (
                    <p className="text-gray-500">No active sessions, or this member has no login.</p>
                  ) : (
                    <div className="overflow-x-auto rounded-lg border border-gray-200">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                            <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Last activity</th>
                            <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Device</th>
                            <th scope="col" className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {sessions.map((s) => (
                            <tr key={s.sessionId}>
                              <td className="px-4 py-2 text-sm text-gray-900">{s.createdAt ? new Date(s.createdAt).toLocaleString() : '—'}</td>
                              <td className="px-4 py-2 text-sm text-gray-600">{s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString() : '—'}</td>
                              <td className="px-4 py-2 text-sm text-gray-600 truncate max-w-[200px]" title={s.userAgent || undefined}>{s.userAgent || '—'}</td>
                              <td className="px-4 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => handleRevokeSession(s.sessionId)}
                                  disabled={revoking}
                                  className="text-sm font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                                >
                                  Revoke
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

      </div>

      {canChangeEmail && member.UserId && (
        <ChangeEmailModal
          isOpen={changeEmailOpen}
          onClose={() => setChangeEmailOpen(false)}
          userId={member.UserId}
          currentEmail={member.Email ?? ''}
          displayName={[member.FirstName, member.LastName].filter(Boolean).join(' ')}
          currentRole={user?.currentRole}
          onSuccess={() => {
            setChangeEmailOpen(false);
            onRefresh?.();
          }}
        />
      )}

      {showFullAuthTab && member.UserId && (
        <SetTemporaryPasswordModal
          isOpen={setTempPasswordOpen}
          onClose={() => setSetTempPasswordOpen(false)}
          userId={member.UserId}
          displayName={[member.FirstName, member.LastName].filter(Boolean).join(' ')}
          currentRole={user?.currentRole}
          onSuccess={() => {
            setSetTempPasswordOpen(false);
            onRefresh?.();
          }}
        />
      )}

      {showResetSentModal && (
        <div className={`fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 ${nestedOverlayZIndexClass}`}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <div className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 mb-4">
                <Mail className="h-6 w-6 text-green-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Password reset email sent</h3>
              <p className="text-sm text-gray-600 mb-2">
                A password reset link has been sent to this member&apos;s email address.
              </p>
              <p className="text-sm text-gray-500 mb-6">
                Remind them to check their junk or spam folder if they don&apos;t see it in their inbox.
              </p>
              <button
                type="button"
                onClick={() => setShowResetSentModal(false)}
                className="w-full inline-flex justify-center rounded-lg border border-transparent bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {showSendLinkBlockedModal && (
        <div className={`fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 ${nestedOverlayZIndexClass}`}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <div className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100 mb-4">
                <AlertCircle className="h-6 w-6 text-red-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Cannot send enrollment link</h3>
              <p className="text-sm text-gray-600 mb-6">
                This member is already enrolled, plan modifications must be requested.
              </p>
              <button
                type="button"
                onClick={() => setShowSendLinkBlockedModal(false)}
                className="w-full inline-flex justify-center rounded-lg border border-transparent bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-primary-dark"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MemberManagementModal;

