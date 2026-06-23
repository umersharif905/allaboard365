// frontend/src/hooks/useAvailableProductTypes.ts
import { useQuery } from '@tanstack/react-query';
import { AvailableProductType } from '../components/enrollment-wizard/types/wizard.types';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';
import { sortProductTypes } from '../utils/productTypeOrdering';

/**
 * Hook to fetch available product types based on user role
 * This follows the same pattern as the product pages
 * @param tenantId - Optional tenant ID for SysAdmin role
 * @param templateType - Optional template type ('Individual' | 'Group') to filter by SalesType
 */
/** Normalize template type so API/list can return 'Group' or 'group' etc. */
function normalizeTemplateType(
  templateType?: string | null
): 'Individual' | 'Group' | undefined {
  if (!templateType) return undefined;
  const t = String(templateType).trim();
  if (t.toLowerCase() === 'group') return 'Group';
  if (t.toLowerCase() === 'individual') return 'Individual';
  return undefined;
}

export const useAvailableProductTypes = (tenantId?: string, templateType?: 'Individual' | 'Group' | string | null) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  const normalizedType = normalizeTemplateType(templateType);

  return useQuery({
    queryKey: ['available-product-types', user?.currentRole, tenantId, normalizedType],
    queryFn: async (): Promise<AvailableProductType[]> => {
      if (!user?.currentRole) {
        throw new Error('User role not available');
      }

      // Use the main products endpoint directly since /types endpoints don't exist
      // Always use the endpoint that matches currentRole so auth/tenant context is correct (avoids 500 from agent endpoint when TenantAdmin calls it).
      let endpoint: string;
      switch (user.currentRole) {
        case 'SysAdmin':
          // For SysAdmin, we need a tenant to get tenant-specific products
          if (!tenantId) {
            return []; // Return empty array if no tenant selected
          }
          endpoint = `/api/tenants/${tenantId}/products`;
          break;
        case 'TenantAdmin':
          // Always use tenant-admin products when in TenantAdmin context (agent endpoint can 500 when called as TenantAdmin).
          endpoint = '/api/me/tenant-admin/products';
          break;
        case 'Agent':
          endpoint = '/api/me/agent/products';
          break;
        default:
          throw new Error(`Unsupported role: ${user.currentRole}`);
      }

      try {
        console.log(`🔍 useAvailableProductTypes - Making API call:`, {
          endpoint,
          tenantId,
          userRole: user.currentRole
        });
        
        // For enrollment wizard we exclude hidden products (includeHidden=false on agent endpoint)
        const isAgentEndpoint = endpoint.includes('/api/me/agent/products');
        const url = isAgentEndpoint ? `${endpoint}?includeHidden=false` : endpoint;
        const response = await apiService.get<{ success: boolean; data: any[] }>(url);
        
        console.log(`🔍 useAvailableProductTypes - API response:`, {
          endpoint,
          success: response.success,
          dataLength: response.data?.length || 0
        });
        
        if (response.success && response.data) {
          console.log('🔍 useAvailableProductTypes - Raw API data sample:', response.data[0]);
          console.log('🔍 useAvailableProductTypes - All products before processing:', response.data.map(p => ({ 
            id: p.ProductId || p.productId, 
            name: p.Name || p.name, 
            type: p.ProductType || p.productType, 
            status: p.Status || p.status,
            isBundle: p.IsBundle || p.isBundle,
            isHidden: p.IsHidden || p.isHidden
          })));
          
          // Transform the response to extract product types and count them
          // Exclude hidden products (and bundle-only: not sold as standalone) so counts match what users can select
          const productTypeCounts = response.data.reduce((acc: Record<string, number>, product: any) => {
            const type = product.productType || product.ProductType;
            const isBundle = product.IsBundle === 1 || product.IsBundle === true || product.isBundle === 1 || product.isBundle === true;
            const isHidden = product.IsHidden === 1 || product.IsHidden === true || product.isHidden === 1 || product.isHidden === true;
            const salesType = (product.SalesType || product.salesType || '').toString().trim();
            
            // Don't count hidden or bundle-only (hidden from individual selection)
            if (isHidden) return acc;
            
            // Filter by SalesType if templateType is provided (use normalized value)
            // SalesType can be 'Individual', 'Group', or 'Both'. Empty/null = include for both.
            // For Group links: include Group, Both, and also Individual/empty so group-specific
            // enrollment links can still show product sections (tenant may only have Individual set).
            let salesTypeMatch = true;
            if (normalizedType && salesType) {
              salesTypeMatch =
                salesType === 'Both' ||
                salesType === normalizedType ||
                (normalizedType === 'Group' && (salesType === 'Individual' || salesType === ''));
            }
            
            console.log('🔍 useAvailableProductTypes - Processing product:', { type, isBundle, isHidden, salesType, normalizedType, salesTypeMatch, product });
            
            // Only count non-bundle products that match SalesType (bundles have their own section/count)
            if (type && !isBundle && salesTypeMatch) {
              acc[type] = (acc[type] || 0) + 1;
            }
            return acc;
          }, {});

          console.log('🔍 useAvailableProductTypes - Product type counts:', productTypeCounts);

          const productTypes: AvailableProductType[] = Object.entries(productTypeCounts).map(([productType, count]) => ({
            productType,
            count: count as number
          }));

          console.log('🔍 useAvailableProductTypes - Final product types:', productTypes);

          // Sort according to custom ordering
          return sortProductTypes(productTypes);
        }
        
        return [];
      } catch (error) {
        console.warn(`Error fetching products from ${endpoint}:`, error);
        return [];
      }
    },
    enabled: !isAuthLoading && !!user?.currentRole && (user.currentRole !== 'SysAdmin' || !!tenantId),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};