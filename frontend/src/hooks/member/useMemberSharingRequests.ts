import { useQuery } from '@tanstack/react-query';
import { apiService } from '../../services/api.service';

/**
 * Member-facing view of a sharing request, returned by
 * GET /api/me/member/sharing-requests. Gated per-vendor by
 * ShowShareRequestStatusToMembers.
 */
export interface MemberShareRequest {
  ShareRequestId: string;
  RequestNumber: string;
  RequestTypeName?: string | null;
  SubType?: string | null;
  Status: string;
  Determination?: string | null;
  SubmittedDate: string;
  IntakeDate?: string | null;
  ReviewStartDate?: string | null;
  CompletedDate?: string | null;
  VendorId: string;
  VendorName?: string | null;
  ShowShareRequestStatusToMembers: boolean | number;
  MemberFirstName?: string | null;
  MemberLastName?: string | null;
  TotalBilledAmount?: number | null;
  TotalUAAmount?: number | null;
  MemberStatedUA?: string | null;
  IncidentUAAmount?: number | null;
  /** Live sum of the request's active bills (server-computed). Use this, not TotalBilledAmount. */
  ComputedTotalBilled?: number | null;
  /** The member's plan "Unshared Amount" (UA) — same value the care team sees. */
  PlanUAValue?: string | number | null;
  NextSteps?: string | null;
  GeneralNotes?: string | null;
  /** Member-facing closing explanation written by the care team at terminal status. */
  MemberOutcomeNote?: string | null;
}

const queryKey = ['member', 'sharing-requests'] as const;

async function fetchSharingRequests(): Promise<MemberShareRequest[]> {
  const res = await apiService.get<{
    success: boolean;
    data?: MemberShareRequest[];
    message?: string;
  }>('/api/me/member/sharing-requests');
  if (!res.success) {
    throw new Error(res.message || 'Failed to load sharing requests');
  }
  return res.data ?? [];
}

export function useMemberSharingRequests() {
  return useQuery({
    queryKey,
    queryFn: fetchSharingRequests,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000
  });
}

export const memberSharingRequestsQueryKey = queryKey;
