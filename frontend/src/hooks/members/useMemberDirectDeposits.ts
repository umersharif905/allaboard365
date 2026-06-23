import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MemberDirectDepositService,
  type CreateDirectDepositInput
} from '../../services/memberDirectDeposit.service';

const queryKey = (memberId: string) => ['member-direct-deposits', memberId] as const;

export function useMemberDirectDeposits(
  memberId: string | undefined,
  tenantId?: string | null,
  options?: { enabled?: boolean }
) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: queryKey(memberId || ''),
    queryFn: () => MemberDirectDepositService.list(memberId as string, tenantId),
    select: (resp) => resp.data || [],
    enabled: !!memberId && enabled
  });
}

export function useAddMemberDirectDeposit(memberId: string, tenantId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDirectDepositInput) =>
      MemberDirectDepositService.create(memberId, input, tenantId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(memberId) });
    }
  });
}

export function useActivateMemberDirectDeposit(memberId: string, tenantId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (directDepositId: string) =>
      MemberDirectDepositService.activate(memberId, directDepositId, tenantId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(memberId) });
    }
  });
}

export function useDeactivateMemberDirectDeposit(memberId: string, tenantId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (directDepositId: string) =>
      MemberDirectDepositService.deactivate(memberId, directDepositId, tenantId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(memberId) });
    }
  });
}

export function useRevealMemberDirectDeposit(memberId: string, tenantId?: string | null) {
  // Reveal returns sensitive data — never cache. Use a manual mutation so the
  // call only fires when the user explicitly clicks "Reveal".
  return useMutation({
    mutationFn: (directDepositId: string) =>
      MemberDirectDepositService.reveal(memberId, directDepositId, tenantId)
  });
}
