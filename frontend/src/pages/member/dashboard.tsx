import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle,
  ChevronRight,
  CreditCard,
  Home,
  Mail,
  Phone,
  RefreshCcw,
  Shield,
  Stethoscope,
  User,
  UserPlus,
  AlertTriangle
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MobileAppDownload from '../../components/member/MobileAppDownload';
import { useMemberContributions } from '../../hooks/member/useMemberContributions';
import { useMemberHousehold } from '../../hooks/member/useMemberHousehold';
import { useMemberPaymentMethods } from '../../hooks/member/useMemberPaymentMethods';
import useMemberProfile, { MemberProfile } from '../../hooks/member/useMemberProfile';
import { apiService } from '../../services/api.service';
import { MemberEnrollment } from '../../services/member/member-enrollments.service';
import { PricingService } from '../../services/pricing.service';
import { maskSSN, maskSSNLast4 } from '../../utils/helpers';
import { PaymentProcessorSettings, SystemFeesSettings } from '../../types/paymentProcessorSettings';
import { Member, resolveHouseholdMemberId } from '../../types/member.types';

// Mock profile data for development/fallback
const MOCK_PROFILE: MemberProfile = {
  id: 'mock-id-123',
  firstName: 'John',
  lastName: 'Doe',
  email: 'john.doe@example.com',
  phone: '(555) 123-4567',
  address: '123 Main Street',
  city: 'Anytown',
  state: 'CA',
  zipCode: '12345',
  memberStatus: 'Active',
  dateOfBirth: new Date('1980-01-01'),
  enrollmentDate: new Date('2023-01-01'),
  groupId: 'group-123',
  groupName: 'Sample Group'
};

export default function MemberDashboard() {
  const navigate = useNavigate();
  const [useMockData, setUseMockData] = useState(false);
  
  // Fetch member profile and enrollment data
  const { profile: apiProfile, isLoading, isError, error, refetch } = useMemberProfile();
  const { data: householdData } = useMemberHousehold();
  
  // Use the unified contributions hook for all calculations
  const contributions = useMemberContributions();
  const cardItems = useMemo(() => {
    const items: {
      title: string;
      description: string;
      icon: typeof CreditCard | typeof Stethoscope;
      path: string;
      color: 'blue' | 'green' | 'purple' | 'orange';
    }[] = [
      {
        title: "Plans",
        description: "View your plan details",
        icon: CreditCard,
        path: "/member/plans",
        color: "blue"
      },
      {
        title: "ID Cards",
        description: "View your ID cards",
        icon: CreditCard,
        path: "/member/id-cards",
        color: "blue"
      },
      {
        title: "Medical Needs",
        description: "Access forms and links for your plans",
        icon: Stethoscope,
        path: "/member/sharing-requests",
        color: "green"
      },
      {
        title: "Dependents",
        description: "View dependents on your account",
        icon: UserPlus,
        path: "/member/dependents",
        color: "purple"
      }
    ];

    return items;
  }, []);
  
  // Destructure for easier access
  const {
    enrollments,
    activeGroupedEnrollments,
    totalProductPremium: totalPremium,
    totalEmployerContribution,
    processingFee,
    yourContribution,
    hasEmployerContribution,
    isLoading: enrollmentsLoading,
    isError: enrollmentsError
  } = contributions;
  
  // Get member invoices

  // Get payment methods and settings
  const { data: paymentMethods = [] } = useMemberPaymentMethods();
  const defaultPaymentMethod = paymentMethods.find(pm => pm.isDefault);
  
  // Get tenant payment processor settings and system fees
  const { data: tenantPaymentSettings } = useQuery({
    queryKey: ['tenantPaymentSettings', apiProfile?.tenantId],
    queryFn: async () => {
      if (!apiProfile?.tenantId) return null;
      const response = await apiService.get<{ success: boolean; data: { paymentProcessorSettings: PaymentProcessorSettings | null; systemFeesSettings: SystemFeesSettings | null } }>(
        `/api/tenants/${apiProfile.tenantId}/payment-settings`
      );
      return response.success ? response.data : null;
    },
    enabled: !!apiProfile?.tenantId,
    staleTime: 10 * 60 * 1000,
  });
  
  // Get group payment method for group members
  const { data: groupPaymentMethod } = useQuery({
    queryKey: ['groupPaymentMethod', apiProfile?.groupId],
    queryFn: async () => {
      if (!apiProfile?.groupId) return null;
      const response = await apiService.get<{ success: boolean; data: { paymentMethods: any[] } }>(
        `/api/groups/${apiProfile.groupId}/billing`
      );
      if (response.success && response.data.paymentMethods && response.data.paymentMethods.length > 0) {
        const defaultPM = response.data.paymentMethods.find((pm: any) => pm.IsDefault) 
          || response.data.paymentMethods[0];
        return defaultPM?.Type === 'ACH' ? 'ACH' : 'Card';
      }
      return 'Card';
    },
    enabled: !!apiProfile?.groupId && apiProfile?.billType === 'LB',
    staleTime: 10 * 60 * 1000,
  });
  
  
  // Use API data if available, otherwise use mock data if fallback enabled
  const profile = !useMockData ? apiProfile : MOCK_PROFILE;

  // Check if SSN is required but missing
  const hasSSNRequiredEnrollments = enrollments && Array.isArray(enrollments) && enrollments.some((enrollment: MemberEnrollment) => {
    // Check if enrollment is active and product requires SSN
    return enrollment.status === 'Active' && 
           enrollment.product?.isSSNRequired === true;
  });

  const hasSsnOnFile =
    (profile?.ssn != null && String(profile.ssn).replace(/\D/g, '').length === 9) ||
    (profile?.ssnLast4 != null && profile.ssnLast4 !== '');
  const isSSNMissing = hasSSNRequiredEnrollments && !hasSsnOnFile;

  // If there's an error and we're not already using mock data, show the error UI
  if (isError && !useMockData) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 flex items-start">
        <AlertCircle size={24} className="text-red-500 mr-3 mt-0.5 flex-shrink-0" />
        <div>
          <h3 className="font-medium">Failed to load member data</h3>
          <p>{error?.message || 'An unknown error occurred. Please try again later.'}</p>
          <div className="mt-4 flex space-x-4">
            <button 
              onClick={() => refetch()}
              className="text-sm bg-red-100 px-3 py-1 rounded-md hover:bg-red-200 text-red-800 transition-colors flex items-center"
            >
              <RefreshCcw size={14} className="mr-1" />
              Retry
            </button>
            <button 
              onClick={() => setUseMockData(true)}
              className="text-sm bg-oe-primary px-3 py-1 rounded-md hover:bg-oe-dark text-white transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2"
            >
              Use Sample Data
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading && !useMockData) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  const formatPhoneNumberDisplay = (value?: string | null): string => {
    if (!value) return 'N/A';
    const digits = value.replace(/\D/g, '');
    if (digits.length === 10) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    if (digits.length === 11 && digits.startsWith('1')) {
      return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return value;
  };

  return (
    <div className="space-y-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Welcome, {profile?.firstName || 'Member'}!</h1>
      </div>

      {/* Incomplete Account Setup Notice */}
      {isSSNMissing && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex items-start">
          <div className="bg-yellow-100 rounded-full p-1 mr-3 flex-shrink-0">
            <AlertTriangle size={20} className="text-yellow-600" />
          </div>
          <div className="flex-1">
            <div className="flex items-center mb-2">
              <h3 className="font-semibold text-yellow-900 mr-2">Incomplete Account Setup (!)</h3>
            </div>
            <p className="text-yellow-800 text-sm mb-3">
              One or more of your active benefits requires your Social Security Number (SSN), but it's not currently on file. 
              Please update your profile to complete your account setup.
            </p>
            <button
              onClick={() => navigate('/member/settings')}
              className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors text-sm font-medium"
            >
              Update SSN Now
            </button>
          </div>
        </div>
      )}

      {/* Information Cards - Side by side when enough room */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Member Information Card */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-white flex justify-between items-center">
            <div className="flex items-center">
              <div className="bg-blue-100 rounded-full p-2 mr-3">
                <User size={20} className="text-oe-primary" />
              </div>
              <h2 className="text-lg font-medium text-gray-900">Your Information</h2>
            </div>
            <button 
              className="text-oe-primary hover:text-oe-dark flex items-center text-sm font-medium"
              onClick={() => navigate('/member/settings')}
            >
              <span>Edit</span>
              <ChevronRight size={16} className="ml-1" />
            </button>
          </div>
          <div className="p-6">
            <div className="space-y-4">
              <div className="flex items-start">
                <div className="bg-gray-100 rounded-full p-2 mr-3 flex-shrink-0">
                  <User size={18} className="text-gray-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-500">Member ID</p>
                  <p className="text-gray-900 font-medium">
                    {(() => {
                      const hm = householdData?.householdMembers?.find((m) => m.IsCurrentUser);
                      if (!hm) return 'Not Assigned';
                      const merged = {
                        ...hm,
                        GroupId: hm.GroupId ?? undefined,
                        TenantMemberIDPrefix: hm.TenantMemberIDPrefix ?? apiProfile?.tenantMemberIDPrefix,
                        TenantIndividualMemberIDPrefix:
                          hm.TenantIndividualMemberIDPrefix ?? apiProfile?.tenantIndividualMemberIDPrefix
                      } as Partial<Member>;
                      return (
                        resolveHouseholdMemberId(merged) ?? 'Not Assigned'
                      );
                    })()}
                  </p>
                </div>
              </div>

              {((profile?.ssnLast4 != null && profile.ssnLast4 !== '') || (profile?.ssn && profile.ssn.length === 9)) && (
                <div className="flex items-start">
                  <div className="bg-gray-100 rounded-full p-2 mr-3 flex-shrink-0">
                    <Shield size={18} className="text-gray-600" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-500">Social Security Number</p>
                    <p className="text-gray-900">
                      {profile.ssn && profile.ssn.length === 9
                        ? maskSSN(profile.ssn)
                        : maskSSNLast4(profile.ssnLast4)}
                    </p>
                  </div>
                </div>
              )}
              
              {profile?.memberStatus && (
                <div className="flex items-start">
                  <div className="bg-gray-100 rounded-full p-2 mr-3 flex-shrink-0">
                    <CheckCircle size={18} className="text-gray-600" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-500">Membership Status</p>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium mt-1 ${
                      profile.memberStatus.toLowerCase() === 'active' 
                        ? 'bg-green-100 text-green-800' 
                        : 'bg-gray-100 text-gray-800'
                    }`}>
                      {profile.memberStatus}
                    </span>
                  </div>
                </div>
              )}
              
              {profile?.groupId && profile?.groupName && (
                <div className="flex items-start">
                  <div className="bg-gray-100 rounded-full p-2 mr-3 flex-shrink-0">
                    <Home size={18} className="text-gray-600" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-500">Group</p>
                    <p className="text-gray-900">{profile.groupName}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Agent Information Card */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-white">
            <div className="flex items-center">
              <div className="bg-blue-100 rounded-full p-2 mr-3">
                <Phone size={20} className="text-oe-primary" />
              </div>
              <h2 className="text-lg font-medium text-gray-900">Your Agent</h2>
            </div>
          </div>
          <div className="p-6">
            {profile?.agent ? (
              <div className="space-y-4">
                <div className="flex items-center">
                  <div className="bg-blue-50 rounded-full h-12 w-12 flex items-center justify-center text-oe-primary-dark font-semibold text-lg flex-shrink-0">
                    {profile.agent.firstName?.[0] || '?'}{profile.agent.lastName?.[0] || '?'}
                  </div>
                  <div className="ml-4">
                    <p className="text-base font-semibold text-gray-900">
                      {profile.agent.firstName || 'N/A'} {profile.agent.lastName || ''}
                    </p>
                  </div>
                </div>
                <div className="space-y-3 pt-2">
                  {profile.agent.email && (
                    <div className="flex items-center">
                      <Mail size={16} className="mr-2 text-oe-primary flex-shrink-0" />
                      <a 
                        href={`mailto:${profile.agent.email}`}
                        className="text-oe-primary hover:text-oe-dark hover:underline"
                      >
                        {profile.agent.email}
                      </a>
                    </div>
                  )}
                  {profile.agent.phone && (
                    <div className="flex items-center">
                      <Phone size={16} className="mr-2 text-oe-primary flex-shrink-0" />
                      <a
                        href={`tel:${profile.agent.phone.replace(/\D/g, '')}`}
                        className="text-oe-primary hover:text-oe-dark hover:underline"
                      >
                        {formatPhoneNumberDisplay(profile.agent.phone)}
                      </a>
                    </div>
                  )}
                </div>
                {profile.agent.agentCode && (
                  <div className="mt-2 text-xs text-gray-500">
                    Agent ID:{' '}
                    <span className="font-mono text-gray-700">{profile.agent.agentCode}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-4">
                <p className="text-sm text-gray-500">
                  No agent assigned. An agent will appear here once your tenant assigns one to your account.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {cardItems.map((item, index) => {
          const Icon = item.icon;
          const colors = {
            blue: "bg-blue-50 text-oe-primary border-blue-200 hover:bg-blue-100",
            green: "bg-green-50 text-green-600 border-green-200 hover:bg-green-100",
            purple: "bg-purple-50 text-purple-600 border-purple-200 hover:bg-purple-100",
            orange: "bg-orange-50 text-orange-600 border-orange-200 hover:bg-orange-100"
          };

          return (
            <div 
              key={index}
              onClick={() => navigate(item.path)} 
              className={`border rounded-lg ${colors[item.color as keyof typeof colors]} p-6 cursor-pointer transition-all duration-200`}
            >
              <div className="flex items-center mb-4">
                <div className={`p-2 rounded-full ${item.color === 'blue' ? 'bg-blue-100' : item.color === 'green' ? 'bg-green-100' : item.color === 'purple' ? 'bg-purple-100' : 'bg-orange-100'}`}>
                  <Icon size={20} className={item.color === 'blue' ? 'text-oe-primary-dark' : item.color === 'green' ? 'text-green-700' : item.color === 'purple' ? 'text-purple-700' : 'text-orange-700'} />
                </div>
                <h3 className="ml-3 font-medium text-gray-900">{item.title}</h3>
              </div>
              <p className="text-sm text-gray-600">{item.description}</p>
              <div className="mt-4 flex justify-end">
                <ChevronRight size={16} className="text-gray-400" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Monthly Contribution Card - Only show for group members or if there are active enrollments */}
      {(apiProfile?.billType === 'LB' || (activeGroupedEnrollments.length > 0 && yourContribution > 0)) && (
        <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Monthly Contribution</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left Column - Math Formula Breakdown */}
            <div className="space-y-2">
              {hasEmployerContribution ? (
                <>
                  {/* Total Premium - products only (no processing fees) */}
                  <div className="flex items-center justify-between py-2">
                    <div className="text-sm font-medium text-gray-700">Total Premium</div>
                    <div className="text-lg font-semibold text-gray-900">
                      {PricingService.formatCurrency(totalPremium)}
                    </div>
                  </div>
                  {/* Processing Fees */}
                  {processingFee > 0 && (
                    <div className="flex items-center justify-between py-2">
                      <div className="text-sm font-medium text-gray-700">Processing Fees</div>
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
                  {/* Total Premium */}
                  <div className="flex items-center justify-between py-2">
                    <div className="text-sm font-medium text-gray-700">Total Premium</div>
                    <div className="text-lg font-semibold text-gray-900">
                      {PricingService.formatCurrency(totalPremium)}
                    </div>
                  </div>
                  {/* Processing Fees */}
                  {processingFee > 0 && (
                    <div className="flex items-center justify-between py-2">
                      <div className="text-sm font-medium text-gray-700">Processing Fees</div>
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
                      {PricingService.formatCurrency(yourContribution)}/mo
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Mobile App Download Section (desktop only — hidden on mobile) */}
      <MobileAppDownload />

      {/* Active Benefits/Enrollments - Commented out for now */}
      {/* <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-white">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <div className="bg-blue-100 rounded-full p-2 mr-3">
                <Package size={20} className="text-oe-primary" />
              </div>
              <h2 className="text-lg font-medium text-gray-900">Your Active Benefits</h2>
            </div>
            <button 
              onClick={() => navigate('/member/plans')}
              className="text-oe-primary hover:text-blue-800 flex items-center text-sm font-medium"
            >
              <span>View All</span>
              <ChevronRight size={16} className="ml-1" />
            </button>
          </div>
        </div>
        <div className="p-6">
          {enrollmentsLoading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
            </div>
          ) : enrollmentsError ? (
            <div className="flex items-center space-x-3 p-4 bg-red-50 text-red-700 border border-red-100 rounded-lg">
              <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
              <p>Failed to load your benefits. Please try again later.</p>
            </div>
          ) : !enrollments || (Array.isArray(enrollments) && enrollments.length === 0) ? (
            <div className="flex items-center space-x-3 p-4 bg-blue-50 text-oe-primary-dark border border-blue-100 rounded-lg">
              <Info size={20} className="text-blue-500 flex-shrink-0" />
              <div>
                <p className="font-medium">No active benefits found</p>
                <p className="text-sm text-oe-primary mt-1">
                  Visit our Plans & ID Cards section to explore available products and enroll.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {Array.isArray(enrollments) && enrollments.slice(0, 3).map((enrollment: MemberEnrollment) => {
                const getStatusIcon = (status: string) => {
                  switch (status?.toLowerCase()) {
                    case 'active':
                      return <CheckCircle size={16} className="text-green-500" />;
                    case 'pending':
                      return <Clock size={16} className="text-yellow-500" />;
                    case 'denied':
                    case 'cancelled':
                      return <XCircle size={16} className="text-red-500" />;
                    default:
                      return <Info size={16} className="text-gray-500" />;
                  }
                };

                const getStatusColor = (status: string) => {
                  switch (status?.toLowerCase()) {
                    case 'active':
                      return 'bg-green-100 text-green-800';
                    case 'pending':
                      return 'bg-yellow-100 text-yellow-800';
                    case 'denied':
                    case 'cancelled':
                      return 'bg-red-100 text-red-800';
                    default:
                      return 'bg-gray-100 text-gray-800';
                  }
                };

                return (
                  <div key={enrollment.enrollmentId} className="border border-gray-200 rounded-lg p-4 hover:border-blue-300 transition-colors duration-200">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center mb-2">
                          <h3 className="font-medium text-gray-900 mr-3">{enrollment.product?.name || 'Product Name'}</h3>
                          <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(enrollment.status)}`}>
                            {getStatusIcon(enrollment.status)}
                            <span className="ml-1">{enrollment.status}</span>
                          </span>
                        </div>
                        <p className="text-sm text-gray-600 mb-2">{enrollment.product?.description}</p>
                        <div className="flex items-center text-sm text-gray-500 space-x-4">
                          {enrollment.effectiveDate && (
                            <span>
                              Effective: {(() => {
                                const [y, m, d] = enrollment.effectiveDate.split('T')[0].split('-');
                                return new Date(parseInt(y), parseInt(m) - 1, parseInt(d)).toLocaleDateString();
                              })()}
                            </span>
                          )}
                          {enrollment.premiumAmount != null && (
                            <span>
                              Premium: ${(
                                (enrollment.premiumAmount || 0) +
                                (enrollment.includedPaymentProcessingFeeAmount || 0) +
                                (enrollment.includedSystemFeeAmount || 0)
                              ).toFixed(2)}
                              {enrollment.paymentFrequency && ` / ${enrollment.paymentFrequency.toLowerCase()}`}
                            </span>
                          )}
                        </div>
                      </div>
                      <ChevronRight size={16} className="text-gray-400 ml-4 flex-shrink-0" />
                    </div>
                  </div>
                );
              })}
              
              {Array.isArray(enrollments) && enrollments.length > 3 && (
                <div className="text-center pt-4">
                  <button
                    onClick={() => navigate('/member/plans')}
                    className="text-oe-primary hover:text-blue-800 text-sm font-medium"
                  >
                    View {enrollments.length - 3} more benefit{enrollments.length - 3 !== 1 ? 's' : ''}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div> */}

      {/* Member Support Section - Commented out (fake info) */}
      {/* <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-white">
          <div className="flex items-center">
            <div className="bg-blue-100 rounded-full p-2 mr-3">
              <Shield size={20} className="text-oe-primary" />
            </div>
            <h2 className="text-lg font-medium text-gray-900">Member Support</h2>
          </div>
        </div>
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="border border-gray-200 rounded-lg p-4 hover:border-blue-300 transition-colors duration-200">
            <h3 className="font-medium text-gray-900 mb-2">Contact Support</h3>
            <p className="text-gray-600 text-sm mb-3">
              Need help? Our support team is available Monday-Friday, 9am-5pm.
            </p>
            <div className="flex items-center text-oe-primary">
              <Phone size={16} className="mr-2" />
              <span>1-800-555-1234</span>
            </div>
          </div>
          
          <div className="border border-gray-200 rounded-lg p-4 hover:border-blue-300 transition-colors duration-200">
            <h3 className="font-medium text-gray-900 mb-2">Helpful Resources</h3>
            <p className="text-gray-600 text-sm mb-3">
              Access guides and FAQs to learn more about your membership benefits.
            </p>
            <a href="#" className="text-oe-primary flex items-center">
              <Info size={16} className="mr-2" />
              <span>View Resources</span>
            </a>
          </div>
        </div>
      </div> */}
    </div>
  );
}
