// frontend/src/hooks/useGroupSetupStatus.ts
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { GroupsService } from '../services/groups.service';
import { useGroupASAStatus } from './useGroupASAStatus';

export interface SetupStep {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  tabIndex: number;
  icon: string;
  required: boolean;
}

export interface GroupSetupStatus {
  isSetupComplete: boolean;
  steps: SetupStep[];
  completionPercentage: number;
  nextStep?: SetupStep;
}

/**
 * Hook to check if a group's setup is complete
 * @param groupId The ID of the group to check
 * @param groupData Optional group data that includes SetupStatus field
 * @param hasOnboardingAccess Whether user can access the onboarding tab (affects tab indices)
 */
export const useGroupSetupStatus = (groupId: string | undefined, groupData?: any, hasOnboardingAccess: boolean = true) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  
  // oe.Groups.SetupStatus is legacy (payment/members/links/hire period only) — never skip ASA or
  // certification checks when it is "Complete". Agent group detail also omits SetupStatus; always
  // use /setup-steps + /asa-status so Agent and TenantAdmin see the same signature state.
  const canUseSetupStatus = groupData?.SetupStatus && !isAuthLoading;

  const setupStepsQuery = useQuery({
    queryKey: ['groupSetupSteps', groupId],
    queryFn: async () => {
      if (!groupId) return null;
      const res = await GroupsService.getSetupSteps(groupId);
      if (!res.success) {
        throw new Error(res.message || 'Could not load group setup steps from the server.');
      }
      return res.data;
    },
    enabled: !isAuthLoading && !!user && !!groupId,
    staleTime: 30_000,
  });
  const { data: setupStepsData, isLoading: setupStepsLoading } = setupStepsQuery;

  // Get ASA status for the group - ALWAYS fetch this, even if SetupStatus is Complete,
  // because ASA requirements might have been added after setup was marked complete
  const asaQuery = useGroupASAStatus(groupId);
  const {
    data: asaStatusData,
    isLoading: asaStatusLoading,
    isError: asaStatusError,
  } = asaQuery;

  const setupStatusQuery = useQuery({
    queryKey: [
      'groupSetupStatus',
      groupId,
      hasOnboardingAccess,
      setupStepsData,
      setupStepsQuery.isError,
      setupStepsQuery.status,
      asaQuery.isError,
      asaQuery.status,
      asaStatusData?.summary?.productsRequiringASA,
      asaStatusData?.summary?.signedASAAgreements,
    ],
    queryFn: async (): Promise<GroupSetupStatus> => {
      if (!groupId) {
        return {
          isSetupComplete: false,
          steps: [],
          completionPercentage: 0
        };
      }

      if (setupStepsQuery.isError) {
        const err = setupStepsQuery.error;
        throw err instanceof Error ? err : new Error(String(err ?? 'Setup steps request failed'));
      }
      if (asaQuery.isError) {
        const err = asaQuery.error;
        throw err instanceof Error ? err : new Error(String(err ?? 'ASA status request failed'));
      }

      const isLoading = setupStepsLoading || (asaStatusLoading && !asaStatusError);

      if (isLoading) {
        return {
          isSetupComplete: false,
          steps: [],
          completionPercentage: 0
        };
      }

      const productsRequiringASA = asaStatusData?.summary?.productsRequiringASA ?? 0;
      const signedASAAgreements = asaStatusData?.summary?.signedASAAgreements ?? 0;
      const asaSigningRequired = productsRequiringASA > 0;
      const asaSigningCompleted = asaSigningRequired && signedASAAgreements >= productsRequiringASA;

      const stepsData = setupStepsData;
      let hasRequiredGroupInfo: boolean;
      if (canUseSetupStatus && groupData) {
        const g = groupData as Record<string, unknown>;
        const val = (k: string) => g?.[k] ?? g?.[k.charAt(0).toLowerCase() + k.slice(1)];
        const has = (v: unknown) => v != null && String(v).trim() !== '';
        hasRequiredGroupInfo = has(val('TaxIdNumber')) && has(val('PrimaryContact')) && has(val('ContactEmail')) && has(val('ContactPhone')) && has(val('Address'));
      } else {
        hasRequiredGroupInfo = stepsData?.hasBusinessInfo ?? false;
      }
      const certificationComplete =
        stepsData?.signaturesRequired === false
          ? true
          : !!(stepsData?.agentHasSignature && stepsData?.groupAdminHasSignature);

      const businessInfoAndCertifyComplete = hasRequiredGroupInfo && certificationComplete;

      const hasPaymentMethod = stepsData?.hasPaymentMethod ?? false;
      const hasMembers = stepsData?.hasMembers ?? false;
      const hasEnrollmentLinks = stepsData?.hasEnrollmentLinks ?? false;
      const hasContributionRules = (stepsData?.contributionRulesCount ?? 0) > 0;

      const tempSteps = [
        { id: 'asaSigning', completed: asaSigningCompleted, required: asaSigningRequired },
        { id: 'businessInfo', completed: businessInfoAndCertifyComplete, required: true },
        { id: 'banking', completed: hasPaymentMethod, required: true },
        { id: 'members', completed: hasMembers, required: true },
        { id: 'enrollments', completed: hasEnrollmentLinks, required: true },
        { id: 'contributionRules', completed: hasContributionRules, required: false }
      ];
      
      const requiredSteps = tempSteps.filter(step => step.required);
      const completedRequiredSteps = requiredSteps.filter(step => step.completed);
      const isSetupComplete = completedRequiredSteps.length === requiredSteps.length;
      
      // Define setup steps (tab indices are now calculated by parent component via getTabIndexForStep)
      const steps: SetupStep[] = [];
      
      // Add ASA signing step if required (as step 1)
      if (asaSigningRequired) {
        steps.push({
          id: 'asaSigning',
          title: 'Step 1: Sign ASA Agreements',
          description: `Sign required Agent Service Agreements for ${productsRequiringASA} product${productsRequiringASA > 1 ? 's' : ''}`,
          completed: asaSigningCompleted,
          tabIndex: 0, // Placeholder - actual index calculated by parent
          icon: 'FileSignature',
          required: true
        });
      }

      // Add remaining steps with adjusted step numbers
      const stepNumberOffset = asaSigningRequired ? 1 : 0;
      steps.push(
        {
          id: 'businessInfo',
          title: `Step ${1 + stepNumberOffset}: Complete Business Info & Sign`,
          description: 'Add EIN (Tax ID), required business information, and sign to certify group info is accurate',
          completed: businessInfoAndCertifyComplete,
          tabIndex: 0, // Placeholder - opens combined modal
          icon: 'Assignment',
          required: true
        },
        {
          id: 'banking',
          title: `Step ${2 + stepNumberOffset}: Add Payment Method`,
          description: 'Add a valid payment method for billing',
          completed: hasPaymentMethod,
          tabIndex: 0, // Placeholder - actual index calculated by parent
          icon: 'CreditCard',
          required: true
        },
        {
          id: 'members',
          title: `Step ${3 + stepNumberOffset}: Add Members`,
          description: 'Add your employees to your group',
          completed: hasMembers,
          tabIndex: 0, // Placeholder - actual index calculated by parent
          icon: 'People',
          required: true
        },
        {
          id: 'enrollments',
          title: `Step ${4 + stepNumberOffset}: Send Enrollment Links`,
          description: 'Send enrollment links to employees',
          completed: hasEnrollmentLinks,
          tabIndex: 0, // Placeholder - actual index calculated by parent
          icon: 'Link',
          required: true
        },
        {
          id: 'contributionRules',
          title: 'Contribution Rules',
          description: 'Set up contribution rules for products (Recommended)',
          completed: hasContributionRules,
          tabIndex: 0, // Placeholder - actual index calculated by parent
          icon: 'AccountBalance',
          required: false
        }
      );

      // Use the already calculated completion status
      
      const completionPercentage = Math.round((completedRequiredSteps.length / requiredSteps.length) * 100);
      
      // Find next incomplete step
      const nextStep = steps.find(step => !step.completed);

      return {
        isSetupComplete,
        steps,
        completionPercentage,
        nextStep
      };
    },
    enabled: !isAuthLoading && !!user && !!groupId,
    staleTime: 30_000, // 30s - avoid refetch on every tab switch
    refetchOnWindowFocus: false,
    refetchOnMount: false, // Use cache when not stale
  });

  const refetchAll = async () => {
    await Promise.all([
      setupStepsQuery.refetch(),
      asaQuery.refetch(),
      setupStatusQuery.refetch(),
    ]);
  };

  const setupStepsFetchError = setupStepsQuery.isError
    ? setupStepsQuery.error instanceof Error
      ? setupStepsQuery.error.message
      : String(setupStepsQuery.error ?? 'Setup steps failed')
    : null;
  const asaFetchError = asaQuery.isError
    ? asaQuery.error instanceof Error
      ? asaQuery.error.message
      : String(asaQuery.error ?? 'ASA status failed')
    : null;

  // Return the setup status with loading state
  return {
    ...setupStatusQuery,
    refetch: refetchAll,
    data: setupStatusQuery.data || {
      isSetupComplete: false,
      steps: [],
      completionPercentage: 0,
      nextStep: null
    },
    /** True when /setup-steps failed */
    isSetupStepsError: setupStepsQuery.isError,
    /** True when /asa-status failed */
    isAsaError: asaQuery.isError,
    setupStepsFetchError,
    asaFetchError,
  };
};
