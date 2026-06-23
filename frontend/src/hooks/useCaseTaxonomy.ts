// useCaseTaxonomy — vendor-scoped Case taxonomy hook.
// Replaces the old hardcoded TICKET_TYPE_SUBCATEGORIES constant. The taxonomy
// is editable per vendor by VendorAdmin (see CaseSettings).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService } from '../services/api.service';
import {
  FALLBACK_TYPE_LABELS,
  FALLBACK_SUBCATEGORY_LABELS,
} from '../constants/caseTaxonomy';

export interface TaxonomySubcategory {
  subcategoryId: string;
  code: string;
  label: string;
  sortOrder: number;
  isActive?: boolean;
}

export interface TaxonomyType {
  typeId: string;
  code: string;
  label: string;
  sortOrder: number;
  isActive?: boolean;
  subcategories: TaxonomySubcategory[];
}

interface TaxonomyResp { success: boolean; data: { types: TaxonomyType[] } }

const ACTIVE_KEY = ['caseTaxonomy', 'active'] as const;
const FULL_KEY   = ['caseTaxonomy', 'full']   as const;

/**
 * Active taxonomy for the current vendor (inactive items hidden).
 * Use for: New Case modal, Details tab dropdown, Encounter convert dialog,
 * header chip label rendering.
 */
export function useCaseTaxonomy() {
  const query = useQuery({
    queryKey: ACTIVE_KEY,
    queryFn: async () => {
      const resp = await apiService.get<TaxonomyResp>('/api/me/vendor/cases/taxonomy');
      return resp.success ? resp.data.types : [];
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const types = query.data ?? [];

  // Build label maps. Fallback to hardcoded labels for legacy codes whose
  // rows are inactive or absent (so old tickets still render a readable type).
  const typeLabel = (code: string | null | undefined): string => {
    if (!code) return '';
    const t = types.find((x) => x.code === code);
    return t?.label || FALLBACK_TYPE_LABELS[code] || code;
  };

  const subcategoryLabel = (code: string | null | undefined): string => {
    if (!code) return '';
    for (const t of types) {
      const s = t.subcategories.find((x) => x.code === code);
      if (s) return s.label;
    }
    return FALLBACK_SUBCATEGORY_LABELS[code] || code;
  };

  const subcategoriesForType = (typeCode: string): TaxonomySubcategory[] => {
    const t = types.find((x) => x.code === typeCode);
    return t?.subcategories ?? [];
  };

  return {
    types,
    isLoading: query.isLoading,
    isError: query.isError,
    typeLabel,
    subcategoryLabel,
    subcategoriesForType,
  };
}

// --------------------------------------------------------------------------
// Admin hooks (VendorAdmin only — only mounted from the Settings tab)
// --------------------------------------------------------------------------

interface AdminTaxonomyResp { success: boolean; data: { types: TaxonomyType[] } }

export function useFullCaseTaxonomy() {
  return useQuery({
    queryKey: FULL_KEY,
    queryFn: async () => {
      const resp = await apiService.get<AdminTaxonomyResp>('/api/me/vendor/cases/admin/taxonomy');
      return resp.success ? resp.data.types : [];
    },
    staleTime: 30 * 1000,
    retry: false,
  });
}

function useInvalidateTaxonomy() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ACTIVE_KEY });
    qc.invalidateQueries({ queryKey: FULL_KEY });
  };
}

export function useCreateType() {
  const invalidate = useInvalidateTaxonomy();
  return useMutation({
    mutationFn: (body: { label: string; sortOrder?: number }) =>
      apiService.post<{ success: boolean }>('/api/me/vendor/cases/admin/types', body),
    onSuccess: invalidate,
  });
}

export function useUpdateType() {
  const invalidate = useInvalidateTaxonomy();
  return useMutation({
    mutationFn: ({ typeId, body }: { typeId: string; body: { label?: string; isActive?: boolean; sortOrder?: number } }) =>
      apiService.put<{ success: boolean }>(`/api/me/vendor/cases/admin/types/${typeId}`, body),
    onSuccess: invalidate,
  });
}

export function useReorderTypes() {
  const invalidate = useInvalidateTaxonomy();
  return useMutation({
    mutationFn: (orderedTypeIds: string[]) =>
      apiService.put<{ success: boolean }>('/api/me/vendor/cases/admin/types/reorder', { orderedTypeIds }),
    onSuccess: invalidate,
  });
}

export function useCreateSubcategory() {
  const invalidate = useInvalidateTaxonomy();
  return useMutation({
    mutationFn: ({ typeId, body }: { typeId: string; body: { label: string; sortOrder?: number } }) =>
      apiService.post<{ success: boolean }>(`/api/me/vendor/cases/admin/types/${typeId}/subcategories`, body),
    onSuccess: invalidate,
  });
}

export function useUpdateSubcategory() {
  const invalidate = useInvalidateTaxonomy();
  return useMutation({
    mutationFn: ({ subcategoryId, body }: { subcategoryId: string; body: { label?: string; isActive?: boolean; sortOrder?: number } }) =>
      apiService.put<{ success: boolean }>(`/api/me/vendor/cases/admin/subcategories/${subcategoryId}`, body),
    onSuccess: invalidate,
  });
}

export function useReorderSubcategories() {
  const invalidate = useInvalidateTaxonomy();
  return useMutation({
    mutationFn: ({ typeId, orderedSubcategoryIds }: { typeId: string; orderedSubcategoryIds: string[] }) =>
      apiService.put<{ success: boolean }>('/api/me/vendor/cases/admin/subcategories/reorder', { typeId, orderedSubcategoryIds }),
    onSuccess: invalidate,
  });
}
