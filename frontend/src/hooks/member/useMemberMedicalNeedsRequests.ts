import { useQuery } from '@tanstack/react-query';
import { apiService } from '../../services/api.service';

export interface MedicalNeedsRequestLinkRow {
  label: string;
  href: string;
  buttonColor: string;
}

export interface MedicalNeedsRequestSection {
  productId: string;
  productName: string;
  categoryTitle: string;
  links: MedicalNeedsRequestLinkRow[];
}

const queryKey = ['member', 'medical-needs-requests'] as const;

async function fetchSections(): Promise<MedicalNeedsRequestSection[]> {
  const res = await apiService.get<{
    success: boolean;
    data?: { sections: MedicalNeedsRequestSection[] };
    message?: string;
  }>('/api/me/member/medical-needs-requests');
  if (!res.success) {
    throw new Error(res.message || 'Failed to load medical needs requests');
  }
  return res.data?.sections ?? [];
}

export function useMemberMedicalNeedsRequests() {
  return useQuery({
    queryKey,
    queryFn: fetchSections,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000
  });
}

export const memberMedicalNeedsRequestsQueryKey = queryKey;
