import { useQuery } from '@tanstack/react-query';
import { groupCreditsService, householdCreditsService, type CreditBalance, type CreditBalanceListRow } from '../services/householdCredits.service';

export function useMemberSelfCredits(enabled = true) {
  return useQuery<CreditBalance>({
    queryKey: ['member-self-credits'],
    queryFn: () => householdCreditsService.getMemberSelf(),
    enabled,
    staleTime: 60_000
  });
}

export function useHouseholdCredits(householdId?: string | null) {
  return useQuery<CreditBalance>({
    queryKey: ['household-credits', householdId],
    queryFn: () => householdCreditsService.getForHousehold(householdId as string),
    enabled: !!householdId,
    staleTime: 60_000
  });
}

export function useHouseholdCreditBalances(params: { search?: string; householdType?: 'Individual' | 'Group' | ''; groupId?: string; includeApplied?: boolean } = {}) {
  return useQuery<CreditBalanceListRow[]>({
    queryKey: ['household-credits-balances', params],
    queryFn: () => householdCreditsService.listBalances(params),
    staleTime: 60_000
  });
}

export function useGroupCreditBalances(groupId?: string | null) {
  return useQuery<CreditBalanceListRow[]>({
    queryKey: ['group-credit-balances', groupId],
    queryFn: () => householdCreditsService.listBalances({ groupId: groupId as string }),
    enabled: !!groupId,
    staleTime: 60_000
  });
}

/**
 * Group-scoped credit ledger for a single GroupId. Returns the same
 * CreditBalance shape as `useHouseholdCredits` so the same panel UI can
 * render for either scope.
 */
export function useGroupCredits(groupId?: string | null) {
  return useQuery<CreditBalance>({
    queryKey: ['group-credits', groupId],
    queryFn: () => groupCreditsService.getForGroup(groupId as string),
    enabled: !!groupId,
    staleTime: 60_000
  });
}
