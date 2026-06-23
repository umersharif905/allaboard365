import { Copy, Edit, Heart, Plus, RefreshCw, Settings, Trash2, User, UserCheck, Users } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { ContributionRule, useGroupContributionRules } from '../../hooks/useGroupContributionRules';
import { useGroupProducts } from '../../hooks/useGroups';
import { useGroupDetails } from '../../hooks/useGroupDetails';
import { formatContributionDisplay, type PayrollPeriod } from '../../utils/payrollPeriodConverter';
import { formatDate, formatCurrency, parseCalendarDate } from '../../utils/helpers';
import GroupAddContribution from './GroupAddContribution';
import { GroupsService, type ApplyToExistingPreviewMember } from '../../services/groups.service';
import { apiService } from '../../services/api.service';
import { Member } from '../../types/member.types';
import MemberManagementModal from '../members/MemberManagementModal';

// Types are now imported from services/groups.service.ts

interface GroupContributionsTabProps {
  groupId: string;
  groupName: string;
}

// Main Tab Component
const PAYROLL_OPTIONS: Array<{ value: PayrollPeriod; label: string }> = [
  { value: 'Monthly', label: 'Monthly' },
  { value: 'Bi-Monthly', label: 'Bi-Monthly' },
  { value: 'Bi-Weekly', label: 'Bi-Weekly' },
  { value: 'Weekly', label: 'Weekly' },
];

const GroupContributionsTab: React.FC<GroupContributionsTabProps> = ({ groupId, groupName }) => {
  const queryClient = useQueryClient();
  const [showContributionModal, setShowContributionModal] = useState<boolean>(false);
  const [editingRule, setEditingRule] = useState<ContributionRule | null>(null);
  const [duplicateFromRule, setDuplicateFromRule] = useState<ContributionRule | null>(null);
  const [deleteConfirmRule, setDeleteConfirmRule] = useState<ContributionRule | null>(null);
  const [deleteLoading, setDeleteLoading] = useState<boolean>(false);
  const [showApplyToExistingModal, setShowApplyToExistingModal] = useState<boolean>(false);
  const [applyPreviewMembers, setApplyPreviewMembers] = useState<ApplyToExistingPreviewMember[]>([]);
  const [applyPreviewLoading, setApplyPreviewLoading] = useState<boolean>(false);
  const [applySubmitting, setApplySubmitting] = useState<boolean>(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  /** Member IDs selected for Apply to Existing (all preview members selected by default when preview loads). */
  const [applySelectedMemberIds, setApplySelectedMemberIds] = useState<Set<string>>(() => new Set());
  const applySelectAllRef = useRef<HTMLInputElement>(null);
  const [payrollUpdateLoading, setPayrollUpdateLoading] = useState<boolean>(false);
  const [pricingToggleLoading, setPricingToggleLoading] = useState<boolean>(false);
  // Member modal (from Apply to Existing breakdown click)
  const [selectedMemberForModal, setSelectedMemberForModal] = useState<Member | null>(null);
  const [memberModalHousehold, setMemberModalHousehold] = useState<Member[]>([]);
  const [memberModalEnrollments, setMemberModalEnrollments] = useState<any[]>([]);
  const [memberModalEnrollmentsLoading, setMemberModalEnrollmentsLoading] = useState<boolean>(false);

  // Get group details to access PayrollPeriod setting
  const { data: groupData } = useGroupDetails(groupId);
  const payrollPeriod = (groupData as any)?.PayrollPeriod || 'Monthly';
  const [showEmployeePricingOnTiles, setShowEmployeePricingOnTiles] = useState(!!(groupData as any)?.ShowEmployeePricingOnTiles);
  const [showContributionStrategy, setShowContributionStrategy] = useState(!!(groupData as any)?.ShowContributionStrategy);
  const [strategyToggleLoading, setStrategyToggleLoading] = useState(false);
  // Track whether initial server data has been loaded into state
  const togglesInitialized = useRef(false);

  // Initialize from server data once on first load (groupData may arrive after mount)
  React.useEffect(() => {
    if (groupData && !togglesInitialized.current) {
      togglesInitialized.current = true;
      setShowEmployeePricingOnTiles(!!(groupData as any).ShowEmployeePricingOnTiles);
      setShowContributionStrategy(!!(groupData as any).ShowContributionStrategy);
    }
  }, [groupData]);

  const handlePayrollPeriodChange = async (newPeriod: PayrollPeriod) => {
    if (newPeriod === payrollPeriod) return;
    try {
      setPayrollUpdateLoading(true);
      const result = await GroupsService.updateGroup(groupId, { PayrollPeriod: newPeriod });
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ['groupDetails', groupId] });
        queryClient.invalidateQueries({ queryKey: ['groupSetupStatus', groupId] });
      }
    } finally {
      setPayrollUpdateLoading(false);
    }
  };

  const handleShowEmployeePricingChange = async (enabled: boolean) => {
    setShowEmployeePricingOnTiles(enabled); // Optimistic update
    try {
      setPricingToggleLoading(true);
      const result = await GroupsService.updateGroup(groupId, { ShowEmployeePricingOnTiles: enabled });
      if (!result.success) setShowEmployeePricingOnTiles(!enabled); // Revert on failure
      else queryClient.invalidateQueries({ queryKey: ['groupDetails', groupId] });
    } catch {
      setShowEmployeePricingOnTiles(!enabled); // Revert on error
    } finally {
      setPricingToggleLoading(false);
    }
  };

  const handleShowContributionStrategyChange = async (enabled: boolean) => {
    setShowContributionStrategy(enabled); // Optimistic update
    try {
      setStrategyToggleLoading(true);
      const result = await GroupsService.updateGroup(groupId, { ShowContributionStrategy: enabled });
      if (!result.success) setShowContributionStrategy(!enabled); // Revert on failure
      else queryClient.invalidateQueries({ queryKey: ['groupDetails', groupId] });
    } catch {
      setShowContributionStrategy(!enabled); // Revert on error
    } finally {
      setStrategyToggleLoading(false);
    }
  };
  
  // Get products for the contribution rules modal
  const { data: groupProductsData } = useGroupProducts(groupId);
  
  // Get contribution rules for display (don't default data so we can tell "not loaded yet" from "loaded empty")
  const { data: contributionRulesData, isLoading: rulesLoading, isFetching: rulesFetching, error: rulesError, refetch: refetchRules } = useGroupContributionRules(groupId);
  const contributionRules = contributionRulesData ?? [];
  const showRulesLoading = rulesLoading || (contributionRulesData === undefined && rulesFetching);
  
  // Debug logging for contribution rules
  console.log('🔍 GroupContributionsTab - groupId:', groupId);
  console.log('🔍 GroupContributionsTab - rulesLoading:', rulesLoading);
  console.log('🔍 GroupContributionsTab - rulesError:', rulesError);
  console.log('🔍 GroupContributionsTab - contributionRules:', contributionRules);
  console.log('🔍 GroupContributionsTab - contributionRules type:', typeof contributionRules);
  console.log('🔍 GroupContributionsTab - contributionRules isArray:', Array.isArray(contributionRules));

  // Force refetch on mount to ensure data is loaded
  useEffect(() => {
    if (groupId && !rulesLoading) {
      console.log('🔍 GroupContributionsTab - useEffect: Refetching rules for groupId:', groupId);
      refetchRules();
    }
  }, [groupId, refetchRules, rulesLoading]);
  
  // Extract products from the API response
  // The useGroupProducts hook returns the data with groupProducts (assigned) and availableProducts (all tenant products)
  // For contribution rules, we only want products assigned to this group
  const products = Array.isArray(groupProductsData) ? groupProductsData : ((groupProductsData as any)?.groupProducts || []);
  
  // Debug logging
  console.log('🔍 GroupContributionsTab - groupProductsData:', groupProductsData);
  console.log('🔍 GroupContributionsTab - groupProductsData type:', typeof groupProductsData);
  console.log('🔍 GroupContributionsTab - groupProductsData keys:', groupProductsData ? Object.keys(groupProductsData) : 'undefined');
  console.log('🔍 GroupContributionsTab - products (assigned to group):', products);
  console.log('🔍 GroupContributionsTab - products length:', products.length);
  console.log('🔍 GroupContributionsTab - contributionRules:', contributionRules);
  console.log('🔍 GroupContributionsTab - rulesLoading:', rulesLoading);
  console.log('🔍 GroupContributionsTab - rulesError:', rulesError);

  // Create a group object that matches what GroupsContributions expects
  const groupForModal = {
    GroupId: groupId,
    Name: groupName,
    Status: 'Active' as const, // Default status
    PrimaryContact: '',
    ContactEmail: '', // Required field
    TotalMembers: 0,
    ActiveEnrollments: 0,
    MonthlyPremium: 0,
    CreatedDate: new Date().toISOString(),
    TenantId: '', // This should be provided from props or context
  };

  // Helper: label for which products a rule applies to (All Products or product names)
  const getRuleProductsLabel = (rule: ContributionRule): string => {
    const ids = Array.isArray(rule.productIds) && rule.productIds.length > 0
      ? rule.productIds
      : rule.productId ? [rule.productId] : [];
    if (ids.length === 0) return 'All Products';
    const productList = products as Array<{ ProductId: string; Name?: string }>;
    const names = ids.map(id => productList.find(p => p.ProductId === id)?.Name).filter(Boolean);
    if (ids.length === 1) return names[0] ?? rule.productName ?? ids[0];
    if (names.length === ids.length) return names.join(', ');
    return `${ids.length} products`;
  };

  // Helper function to format contribution type text
  const formatContributionType = (contributionType: string | undefined) => {
    if (!contributionType) return 'UNKNOWN CONTRIBUTION';
    return contributionType.replace(/_/g, ' ').toUpperCase() + ' CONTRIBUTION';
  };

  // Helper function to get contribution amount display text with payroll period conversion
  const getContributionAmountText = (rule: ContributionRule) => {
    switch (rule.contributionType) {
      case 'flat_rate':
        if (rule.flatRateAmount !== undefined) {
          return `${formatContributionDisplay(rule.flatRateAmount, payrollPeriod as PayrollPeriod)} per employee`;
        }
        return 'Flat rate amount not set';
      case 'percentage':
        if (rule.equivalentTier === 'EE' || rule.equivalentTier === 'ES' || rule.equivalentTier === 'EC' || rule.equivalentTier === 'EF') {
          const tierLabel = rule.equivalentTier === 'EE' ? 'EE' : rule.equivalentTier === 'ES' ? 'ES' : rule.equivalentTier === 'EC' ? 'EC' : 'EF';
          return `${rule.percentageAmount}% of ${tierLabel} equivalent ${payrollPeriod === 'Monthly' ? 'per month' : 'per pay period'}`;
        }
        return `${rule.percentageAmount}% of premium ${payrollPeriod === 'Monthly' ? 'per month' : 'per pay period'}`;
      case 'tier_based':
        if (rule.tierContributions) {
          const tiers = [];
          if (rule.tierContributions.employee_only !== undefined) {
            tiers.push(`👤 EE: ${formatContributionDisplay(rule.tierContributions.employee_only, payrollPeriod as PayrollPeriod)}`);
          }
          if (rule.tierContributions.employee_spouse !== undefined) {
            tiers.push(`👥 ES: ${formatContributionDisplay(rule.tierContributions.employee_spouse, payrollPeriod as PayrollPeriod)}`);
          }
          if (rule.tierContributions.employee_children !== undefined) {
            tiers.push(`👨‍👩‍👧 EC: ${formatContributionDisplay(rule.tierContributions.employee_children, payrollPeriod as PayrollPeriod)}`);
          }
          if (rule.tierContributions.family !== undefined) {
            tiers.push(`👨‍👩‍👧‍👦 Family: ${formatContributionDisplay(rule.tierContributions.family, payrollPeriod as PayrollPeriod)}`);
          }
          return tiers.join(', ');
        }
        return 'Tier-based amounts';
      case 'tenure_based':
        if (rule.tenureRules && rule.tenureRules.length > 0) {
          return rule.tenureRules.map(tenure => {
            return `${tenure.minYears}+ years: ${formatContributionDisplay(tenure.contributionAmount, payrollPeriod as PayrollPeriod)}`;
          }).join(', ');
        }
        return 'Tenure-based amounts';
      case 'age_based':
        if (rule.ageRules && rule.ageRules.length > 0) {
          return rule.ageRules.map(ageRule => {
            const ageRange = ageRule.maxAge 
              ? `Ages ${ageRule.minAge}-${ageRule.maxAge}`
              : `Ages ${ageRule.minAge}+`;
            const amount = ageRule.contributionType === 'percentage'
              ? `${ageRule.contributionAmount}%`
              : formatContributionDisplay(ageRule.contributionAmount, payrollPeriod as PayrollPeriod);
            return `${ageRange}: ${amount}`;
          }).join(', ');
        }
        return 'Age-based amounts';
      case 'override':
        return 'Full Premium Coverage (overrides all other rules)';
      case 'minimum_threshold':
        if (rule.minimumAmount !== undefined) {
          return `Minimum contribution: ${formatContributionDisplay(rule.minimumAmount, payrollPeriod as PayrollPeriod)}`;
        }
        return 'Minimum threshold not set';
      default:
        return 'Custom contribution rule';
    }
  };

  const handleOpenAddModal = () => {
    setEditingRule(null);
    setShowContributionModal(true);
  };

  const handleOpenEditModal = (rule: ContributionRule) => {
    setEditingRule(rule);
    setDuplicateFromRule(null);
    setShowContributionModal(true);
  };

  const handleDuplicateRule = (rule: ContributionRule) => {
    setEditingRule(null);
    setDuplicateFromRule(rule);
    setShowContributionModal(true);
  };

  const handleModalClose = () => {
    setShowContributionModal(false);
    setEditingRule(null);
    setDuplicateFromRule(null);
    refetchRules();
  };

  const handleSaveSuccess = () => {
    refetchRules();
    setShowContributionModal(false);
    setEditingRule(null);
    setDuplicateFromRule(null);
  };

  const handleDeleteClick = (rule: ContributionRule) => {
    setDeleteConfirmRule(rule);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmRule) return;
    setDeleteLoading(true);
    try {
      const res = await GroupsService.deleteGroupContribution(groupId, deleteConfirmRule.contributionId);
      if (res.success) {
        setDeleteConfirmRule(null);
        refetchRules();
      }
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleOpenApplyToExistingModal = async () => {
    setShowApplyToExistingModal(true);
    setApplyError(null);
    setApplyPreviewLoading(true);
    setApplyPreviewMembers([]);
    setApplySelectedMemberIds(new Set());
    try {
      const res = await GroupsService.getApplyContributionsToExistingPreview(groupId);
      if (res.success && res.data?.members) {
        const members = res.data.members;
        setApplyPreviewMembers(members);
        setApplySelectedMemberIds(new Set(members.map((m) => m.memberId)));
      } else {
        setApplyError(res.message || 'Failed to load preview');
      }
    } catch (e) {
      setApplyError((e as Error)?.message || 'Failed to load preview');
    } finally {
      setApplyPreviewLoading(false);
    }
  };

  const handleCloseApplyToExistingModal = () => {
    setShowApplyToExistingModal(false);
    setApplyPreviewMembers([]);
    setApplySelectedMemberIds(new Set());
    setApplyError(null);
    refetchRules();
  };

  const applyPreviewSelectedCount = applyPreviewMembers.filter((m) =>
    applySelectedMemberIds.has(m.memberId)
  ).length;
  const applyPreviewAllSelected =
    applyPreviewMembers.length > 0 && applyPreviewSelectedCount === applyPreviewMembers.length;

  useEffect(() => {
    const el = applySelectAllRef.current;
    if (!el) return;
    el.indeterminate =
      applyPreviewSelectedCount > 0 && applyPreviewSelectedCount < applyPreviewMembers.length;
  }, [applyPreviewMembers.length, applyPreviewSelectedCount]);

  const toggleApplyMemberSelected = (memberId: string) => {
    setApplySelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  };

  const toggleApplySelectAll = () => {
    if (applyPreviewAllSelected) {
      setApplySelectedMemberIds(new Set());
    } else {
      setApplySelectedMemberIds(new Set(applyPreviewMembers.map((m) => m.memberId)));
    }
  };

  const handleApplyToExisting = async () => {
    const memberIds = applyPreviewMembers
      .filter((m) => applySelectedMemberIds.has(m.memberId))
      .map((m) => m.memberId);
    if (memberIds.length === 0) {
      setApplyError('Select at least one member to apply.');
      return;
    }
    setApplySubmitting(true);
    setApplyError(null);
    try {
      const res = await GroupsService.applyContributionsToExisting(groupId, memberIds);
      if (res.success && res.data) {
        const { created, updated, errors } = res.data;
        if (errors?.length) {
          setApplyError(errors.map((e: { message: string }) => e.message).join('; '));
        }
        if ((created > 0 || updated > 0) && !errors?.length) {
          toast.success(`Contributions updated: ${created} created, ${updated} updated.`);
          handleCloseApplyToExistingModal();
        } else if (created === 0 && updated === 0 && !errors?.length) {
          setApplyError('No contribution enrollments were created or updated. Members may already match the rules.');
        }
      } else {
        setApplyError(res.message || 'Apply failed');
      }
    } catch (e) {
      setApplyError((e as Error)?.message || 'Apply failed');
    } finally {
      setApplySubmitting(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Active': return 'bg-green-100 text-green-800';
      case 'Pending': return 'bg-yellow-100 text-yellow-800';
      case 'Terminated': return 'bg-red-100 text-red-800';
      case 'Inactive': return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };
  const getRelationshipIcon = (relationshipType?: string) => {
    switch (relationshipType) {
      case 'P': return <UserCheck className="h-4 w-4 text-blue-600" />;
      case 'S': return <Heart className="h-4 w-4 text-pink-600" />;
      case 'C': return <User className="h-4 w-4 text-gray-600" />;
      default: return <UserCheck className="h-4 w-4 text-blue-600" />;
    }
  };
  const getRelationshipColor = (relationshipType?: string) => {
    switch (relationshipType) {
      case 'P': return 'bg-blue-100 text-blue-800';
      case 'S': return 'bg-pink-100 text-pink-800';
      case 'C': return 'bg-gray-100 text-gray-800';
      default: return 'bg-blue-100 text-blue-800';
    }
  };

  const openMemberManagementModal = useCallback(async (memberId: string) => {
    if (!memberId) return;
    setMemberModalEnrollmentsLoading(true);
    setSelectedMemberForModal(null);
    setMemberModalHousehold([]);
    setMemberModalEnrollments([]);
    try {
      const householdRes = await apiService.get<{ success: boolean; data: { member: Member; householdMembers: Member[] } }>(
        `/api/members/${memberId}/with-household`
      );
      if (householdRes.success && householdRes.data) {
        setSelectedMemberForModal(householdRes.data.member);
        setMemberModalHousehold(householdRes.data.householdMembers || []);
      }
      const enrollRes = await apiService.get<{ success: boolean; data: any[] }>(`/api/enrollments?memberId=${memberId}`);
      const enrollments = enrollRes.success && Array.isArray(enrollRes.data) ? enrollRes.data : [];
      setMemberModalEnrollments(enrollments);
    } catch {
      setSelectedMemberForModal(null);
      setMemberModalHousehold([]);
      setMemberModalEnrollments([]);
    } finally {
      setMemberModalEnrollmentsLoading(false);
    }
  }, []);

  return (
    <div className="space-y-6">
      {/* Current Employer Contributions */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-lg font-semibold text-gray-900 flex items-center space-x-2">
            <Settings className="h-5 w-5 text-oe-primary" />
            <span>Current Employer Contributions</span>
          </h4>
          <div className="flex items-center gap-2">
            {Array.isArray(contributionRules) && contributionRules.length > 0 && (
              <button
                onClick={handleOpenApplyToExistingModal}
                className="px-4 py-2.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2"
              >
                <Users className="h-4 w-4" />
                Apply to Existing Members
              </button>
            )}
            <button
              onClick={handleOpenAddModal}
              className="px-4 py-2.5 text-sm rounded-lg bg-oe-primary text-white hover:bg-oe-primary-dark transition-colors flex items-center gap-2"
            >
              <Plus className="h-4 w-4" />
              Add Employer Contribution
            </button>
          </div>
        </div>
        
        {showRulesLoading ? (
          <div className="flex items-center justify-center py-16 border-2 border-dashed border-gray-200 rounded-lg bg-gray-50">
            <div className="flex flex-col items-center gap-3">
              <div className="animate-spin rounded-full h-10 w-10 border-2 border-oe-primary border-t-transparent"></div>
              <span className="text-sm font-medium text-gray-600">Loading employer contributions...</span>
            </div>
          </div>
        ) : rulesError ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-red-800">
                  Error Loading Employer Contributions
                </h3>
                <div className="mt-2 text-sm text-red-700">
                  <p>Failed to load employer contributions. Please try again or contact support if the problem persists.</p>
                </div>
              </div>
            </div>
          </div>
        ) : !Array.isArray(contributionRules) || contributionRules.length === 0 ? (
          <div className="text-center py-12 text-gray-500 border-2 border-dashed border-gray-300 rounded-lg">
            <Settings className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <p className="text-lg font-medium">No employer contributions configured</p>
            <p className="text-sm">Click "Add Employer Contribution" to add your first employer contribution</p>
          </div>
        ) : (
          <div className="space-y-4">
            {Array.isArray(contributionRules) && contributionRules
              .sort((a, b) => a.priority - b.priority)
              .map((rule) => (
                <div key={rule.contributionId} className="border border-gray-200 rounded-lg p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center flex-wrap gap-2 mb-2">
                        <h4 className="font-semibold text-gray-900">{rule.name}</h4>
                        {rule.status === 'Inactive' && (
                          <span className="px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-800">
                            Inactive
                          </span>
                        )}
                        <span className={`px-2 py-1 text-xs rounded-full ${
                          rule.contributionDirection === 'MaxEmployee'
                            ? 'bg-orange-100 text-orange-800'
                            : 'bg-green-100 text-green-800'
                        }`}>
                          {rule.contributionDirection === 'MaxEmployee' ? 'Max Employee' : 'Employer'}
                        </span>
                        <span className="px-2 py-1 text-xs bg-purple-100 text-purple-800 rounded-full" title="Applies to">
                          {getRuleProductsLabel(rule)}
                        </span>
                      </div>
                      
                      {rule.description && (
                        <p className="text-sm text-gray-600 mb-3">{rule.description}</p>
                      )}
                      
                      <div className="bg-gray-50 rounded-lg p-3 w-fit">
                        <div className="text-sm">
                          <div className="font-medium text-gray-700 mb-1">
                            {formatContributionType(rule.contributionType)}
                          </div>
                          <p className="text-gray-600">{getContributionAmountText(rule)}</p>
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-between mt-3 text-xs text-gray-500">
                        {(() => {
                          const effective = parseCalendarDate(rule.effectiveDate);
                          const today = new Date();
                          today.setHours(0, 0, 0, 0);
                          const isNotYetEffective = effective && effective.getTime() > today.getTime();
                          return isNotYetEffective ? (
                            <span className="text-amber-600 font-medium" title={`Rule becomes effective on ${formatDate(rule.effectiveDate, false)}`}>
                              Not yet effective: {formatDate(rule.effectiveDate, false)}
                            </span>
                          ) : (
                            <span>Effective: {formatDate(rule.effectiveDate, false)}</span>
                          );
                        })()}
                        {rule.endDate && <span>Ends: {formatDate(rule.endDate, false)}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => handleOpenEditModal(rule)}
                        className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 hover:text-oe-primary transition-colors flex items-center gap-1.5"
                      >
                        <Edit className="h-4 w-4" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDuplicateRule(rule)}
                        className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
                        title="Duplicate rule"
                      >
                        <Copy className="h-4 w-4" />
                        Duplicate
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteClick(rule)}
                        className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-red-600 hover:bg-red-50 transition-colors flex items-center gap-1.5"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Apply to Existing Members Modal */}
      {showApplyToExistingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => !applySubmitting && handleCloseApplyToExistingModal()}>
          <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Apply to Existing Members</h3>
              <p className="text-sm text-gray-600 mt-1">
                Members below are enrolled but missing or have incorrect contribution enrollments. Review and apply to create or update contribution records.
              </p>
            </div>
            <div className="p-6 overflow-auto flex-1">
              {applyError && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">
                  {applyError}
                </div>
              )}
              {applyPreviewLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary" />
                  <span className="ml-2 text-gray-600">Loading preview...</span>
                </div>
              ) : applyPreviewMembers.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <Users className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                  <p className="text-lg font-medium">No members need updates</p>
                  <p className="text-sm">All enrolled members already have contribution enrollments that match the current rules.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-gray-600">
                    {applyPreviewSelectedCount} of {applyPreviewMembers.length} member
                    {applyPreviewMembers.length === 1 ? '' : 's'} selected for apply.
                  </p>
                  <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className="px-3 py-2 w-12 text-center">
                          <input
                            ref={applySelectAllRef}
                            type="checkbox"
                            checked={applyPreviewAllSelected}
                            onChange={toggleApplySelectAll}
                            disabled={applySubmitting}
                            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                            aria-label="Select all members for apply"
                          />
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Member</th>
                        <th className="px-4 py-2 text-center text-xs font-medium text-gray-700 uppercase">Tobacco</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase" title="Product premium + system & processing fees">Premium (incl. fees)</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Current employer</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Current employee</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">New employer</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">New employee</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {applyPreviewMembers.map((m) => (
                        <tr key={m.memberId} className="hover:bg-gray-50">
                          <td className="px-3 py-2 text-center align-middle">
                            <input
                              type="checkbox"
                              checked={applySelectedMemberIds.has(m.memberId)}
                              onChange={() => toggleApplyMemberSelected(m.memberId)}
                              disabled={applySubmitting}
                              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                              aria-label={`Include ${m.memberName} in apply`}
                            />
                          </td>
                          <td className="px-4 py-2 text-sm">
                            <button
                              type="button"
                              onClick={() => openMemberManagementModal(m.memberId)}
                              className="text-left text-blue-600 hover:text-blue-800 hover:underline font-medium cursor-pointer"
                            >
                              {m.memberName}
                            </button>
                          </td>
                          <td className="px-4 py-2 text-sm text-center">
                            <span className={m.tobaccoUse === 'Yes' ? 'text-amber-600 font-medium' : 'text-gray-600'}>
                              {m.tobaccoUse ?? '—'}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-sm text-right text-gray-600" title="Product premium + system & processing fees">{formatCurrency(m.totalPremiumIncludingFees ?? m.totalPremium)}</td>
                          <td className="px-4 py-2 text-sm text-right text-gray-600">{formatCurrency(m.currentEmployerContribution)}</td>
                          <td className="px-4 py-2 text-sm text-right text-gray-600">{formatCurrency(m.currentEmployeeContribution)}</td>
                          <td className="px-4 py-2 text-sm text-right font-medium text-green-700">{formatCurrency(m.newEmployerContribution)}</td>
                          <td className="px-4 py-2 text-sm text-right font-medium text-green-700">{formatCurrency(m.newEmployeeContribution)}</td>
                          <td className="px-4 py-2 text-xs text-gray-500">
                            {m.ruleDoesNotApply ? (
                              <span className="text-amber-600" title="Employer contribution rule does not apply (e.g. job position or age filter). Update member data or the rule to apply.">
                                Rule does not apply
                              </span>
                            ) : m.isUpdate && m.corrections?.length ? (
                              <span title={m.corrections.map(c => `${c.ruleName}: ${formatCurrency(c.currentAmount)} → ${formatCurrency(c.newAmount)}`).join(', ')}>
                                Updating {m.corrections.length} contribution{m.corrections.length > 1 ? 's' : ''}
                              </span>
                            ) : m.isUpdate ? (
                              'Update'
                            ) : (
                              'New'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleCloseApplyToExistingModal}
                disabled={applySubmitting}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {applyPreviewMembers.length === 0 ? 'Close' : 'Cancel'}
              </button>
              {applyPreviewMembers.length > 0 && (
                <button
                  type="button"
                  onClick={handleApplyToExisting}
                  disabled={applySubmitting || applyPreviewSelectedCount === 0}
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {applySubmitting ? (
                    <>
                      <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                      Applying...
                    </>
                  ) : (
                    'Apply'
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bottom bar: Payroll period left, Refresh right */}
      <div className="flex items-center justify-between pt-4 border-t border-gray-200">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600">Payroll Period:</span>
          <select
            value={payrollPeriod}
            onChange={(e) => handlePayrollPeriodChange(e.target.value as PayrollPeriod)}
            disabled={payrollUpdateLoading}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm disabled:opacity-50"
          >
            {PAYROLL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {payrollUpdateLoading && (
            <span className="text-xs text-gray-500">Updating...</span>
          )}
          {/* Contribution display toggles - only visible when contribution rules exist */}
          {contributionRulesData && contributionRulesData.length > 0 && (
            <>
              <div className="flex items-center gap-2 ml-6 pl-6 border-l border-gray-200">
                <button
                  type="button"
                  role="switch"
                  aria-checked={showEmployeePricingOnTiles}
                  onClick={() => handleShowEmployeePricingChange(!showEmployeePricingOnTiles)}
                  disabled={pricingToggleLoading}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-1 disabled:opacity-50 ${showEmployeePricingOnTiles ? 'bg-oe-primary' : 'bg-gray-200'}`}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${showEmployeePricingOnTiles ? 'translate-x-4' : 'translate-x-0'}`} />
                </button>
                <span className="text-sm text-gray-600 select-none">Show employee pricing on tiles <span className="text-gray-400">(product-specific rules only)</span></span>
              </div>
              <div className="flex items-center gap-2 ml-4 pl-4 border-l border-gray-200">
                <button
                  type="button"
                  role="switch"
                  aria-checked={showContributionStrategy}
                  onClick={() => handleShowContributionStrategyChange(!showContributionStrategy)}
                  disabled={strategyToggleLoading}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-1 disabled:opacity-50 ${showContributionStrategy ? 'bg-oe-primary' : 'bg-gray-200'}`}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${showContributionStrategy ? 'translate-x-4' : 'translate-x-0'}`} />
                </button>
                <span className="text-sm text-gray-600 select-none">Show contribution details to employees</span>
              </div>
            </>
          )}
        </div>
        <button
          onClick={() => refetchRules()}
          disabled={showRulesLoading}
          className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${showRulesLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Delete contribution confirmation */}
      {deleteConfirmRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => !deleteLoading && setDeleteConfirmRule(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Delete contribution</h3>
            <p className="text-sm text-gray-600 mb-4">
              Are you sure you want to delete &quot;{deleteConfirmRule.name}&quot;? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmRule(null)}
                disabled={deleteLoading}
                className="px-3 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={deleteLoading}
                className="px-3 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                {deleteLoading ? (
                  <>
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit Employer Contribution Modal */}
      <GroupAddContribution
        isOpen={showContributionModal}
        onClose={handleModalClose}
        selectedGroup={groupForModal}
        editingRule={editingRule}
        duplicateFromRule={duplicateFromRule}
        onSaveSuccess={handleSaveSuccess}
      />

      {/* Member detail modal (from Apply to Existing breakdown row click) */}
      {selectedMemberForModal && (
        <MemberManagementModal
          member={selectedMemberForModal}
          householdMembers={memberModalHousehold}
          memberEnrollments={memberModalEnrollments}
          enrollmentsLoading={memberModalEnrollmentsLoading}
          onClose={() => {
            setSelectedMemberForModal(null);
            setMemberModalHousehold([]);
            setMemberModalEnrollments([]);
          }}
          onEdit={() => {}}
          formatCurrency={formatCurrency}
          getStatusColor={getStatusColor}
          getRelationshipIcon={getRelationshipIcon}
          getRelationshipColor={getRelationshipColor}
          canEdit={false}
          canDelete={false}
        />
      )}
    </div>
  );
};

export default GroupContributionsTab;