// frontend/src/hooks/useProductsByType.ts
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiService, withExplicitTenantScope } from '../services/api.service';

export interface Product {
  ProductId: string;
  Name: string;
  ProductType: string;
  Carrier?: string;
  Description?: string;
  Status: string; // Use Status instead of IsActive
}

/**
 * Hook to fetch specific products by product type for the wizard
 * @param productType - The product type to filter by (e.g., 'Healthcare', 'Dental')
 * @param tenantId - Optional tenant ID for SysAdmin role
 * @param templateType - Optional template type ('Individual' | 'Group') to filter by SalesType
 * @param groupId - Optional group ID for Group templates - when provided, only returns products assigned to that group
 */
export const useProductsByType = (productType: string, tenantId?: string, templateType?: 'Individual' | 'Group', groupId?: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();

  console.log('🔍 useProductsByType - Hook called:', {
    productType,
    tenantId,
    userRole: user?.currentRole,
    hasUser: !!user,
    isAuthLoading
  });

  const queryKey = ['products-by-type', user?.currentRole, productType, tenantId, templateType, groupId];
  
  console.log('🔍 useProductsByType - Query key:', queryKey);
  
  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<Product[]> => {
      const timestamp = new Date().toISOString();
      console.log(`🔍 useProductsByType - Query function EXECUTING at ${timestamp}:`, {
        userRole: user?.currentRole,
        productType,
        tenantId,
        groupId,
        templateType,
        hasUser: !!user
      });
      
      if (!user?.currentRole || !productType) {
        console.log('🔍 useProductsByType - Missing required data:', { userRole: user?.currentRole, productType });
        return [];
      }

      // For Group templates with groupId, fetch products assigned to that group
      if (templateType === 'Group' && groupId) {
        console.log('🔍 useProductsByType - Fetching group products for groupId:', groupId);
        try {
          const response = await apiService.get<{ success: boolean; data: { groupProducts: any[]; availableProducts: any[] } }>(
            `/api/groups/${groupId}/products`
          );
          
          if (response.success && response.data) {
            // Only return products that are assigned to the group (from groupProducts array)
            const groupProducts = response.data.groupProducts || [];
            console.log('🔍 useProductsByType - Group products count:', groupProducts.length);
            
            // First, identify bundles and fetch their included products
            const bundles = groupProducts.filter((p: any) => {
              const isBundle = p.IsBundle === 1 || p.IsBundle === true;
              return isBundle;
            });
            
            // Fetch included products for all bundles
            const bundleProductTypes: Record<string, string[]> = {};
            await Promise.all(bundles.map(async (bundle: any) => {
              try {
                const bundleResponse = await apiService.get<{ success: boolean; data: any[] }>(`/api/products/${bundle.ProductId}/bundle-products`);
                if (bundleResponse.success && bundleResponse.data) {
                  // Get unique ProductTypes from included products
                  const includedProductTypes = [...new Set(bundleResponse.data.map((ip: any) => ip.ProductType).filter(Boolean))];
                  bundleProductTypes[bundle.ProductId] = includedProductTypes;
                  console.log(`🔍 useProductsByType - Group bundle ${bundle.Name} includes product types:`, includedProductTypes);
                }
              } catch (error) {
                console.warn(`Error fetching bundle products for ${bundle.ProductId}:`, error);
                // If we can't fetch bundle products, exclude the bundle to be safe
                bundleProductTypes[bundle.ProductId] = [];
              }
            }));
            
            // Filter by product type, IsHidden, and SalesType
            const filteredProducts = groupProducts.filter((product: any) => {
              const productTypeMatch = product.ProductType === productType;
              const isActive = product.ProductStatus === 'Active' || product.IsActive === true;
              const isHidden = product.IsHidden === 1 || product.IsHidden === true;
              const isBundle = product.IsBundle === 1 || product.IsBundle === true;
              
              // Exclude hidden products
              if (isHidden) {
                return false;
              }
              
              // For bundles: Only include if they contain products of the requested productType
              // For regular products: Must match the productType exactly
              let includeBundle = false;
              if (isBundle) {
                const includedTypes = bundleProductTypes[product.ProductId] || [];
                includeBundle = includedTypes.includes(productType);
                console.log(`🔍 useProductsByType - Group bundle ${product.Name} includes types:`, includedTypes, `matches ${productType}:`, includeBundle);
              }
              
              // Filter by SalesType for both bundles and regular products
              let salesTypeMatch = true;
              if (templateType) {
                const salesType = (product.SalesType || '').toString().trim();
                const normalizedTemplateType = templateType.toString().trim();
                // SalesType can be 'Individual', 'Group', or 'Both'
                // If templateType is 'Individual', show products with SalesType 'Individual' or 'Both'
                // If templateType is 'Group', show products with SalesType 'Group' or 'Both'
                // If SalesType is null/empty, include it (assume it's valid for the template type)
                // Normalize comparison by trimming and ensuring exact match
                salesTypeMatch = !salesType || salesType === 'Both' || salesType === normalizedTemplateType;
                
                if (!salesTypeMatch) {
                  console.log(`🚫 useProductsByType - Filtered out product (Group): ${product.Name}, SalesType: "${salesType}", TemplateType: "${normalizedTemplateType}"`);
                }
              }
              
              return (productTypeMatch || includeBundle) && isActive && salesTypeMatch;
            });
            
            console.log('🔍 useProductsByType - Filtered group products count:', filteredProducts.length);
            return filteredProducts.map((p: any) => ({
              ProductId: p.ProductId,
              Name: p.Name,
              ProductType: p.ProductType,
              Carrier: p.Carrier,
              Description: p.Description,
              Status: p.ProductStatus || 'Active',
              IsBundle: p.IsBundle,
              SalesType: p.SalesType,
              IsHidden: p.IsHidden || 0
            }));
          }
          
          return [];
        } catch (error) {
          console.warn(`Error fetching group products for type ${productType}:`, error);
          return [];
        }
      }

      let endpoint: string;
      
      switch (user.currentRole) {
        case 'SysAdmin':
          // For SysAdmin, we need a tenant to get tenant-specific products
          if (!tenantId) {
            console.log('🔍 useProductsByType - SysAdmin missing tenantId');
            return [];
          }
          endpoint = `/api/tenants/${tenantId}/products`;
          break;
        case 'TenantAdmin':
          // Use role-specific endpoint for TenantAdmin (follows @backend-system.md)
          endpoint = '/api/me/tenant-admin/products';
          break;
        case 'Agent':
          // Use role-specific endpoint for Agent (follows @backend-system.md)
          endpoint = '/api/me/agent/products';
          break;
        default:
          throw new Error(`Unsupported role: ${user.currentRole}`);
      }

      try {
        console.log(`🔍 useProductsByType - Making API call:`, {
          endpoint,
          productType,
          tenantId,
          userRole: user.currentRole
        });
        
        // For enrollment link wizard, exclude hidden products (agent endpoint returns them by default)
        const url = endpoint.includes('/api/me/agent/products') ? `${endpoint}?includeHidden=false` : endpoint;
        console.log(`🔍 useProductsByType - About to fetch from: ${url}`);
        // TenantAdmin/Agent: /api/me/* uses x-current-tenant-id; pass wizard tenant so it cannot drift from localStorage.
        const scopeConfig =
          tenantId && (user.currentRole === 'TenantAdmin' || user.currentRole === 'Agent')
            ? withExplicitTenantScope(tenantId)
            : undefined;
        const response = await apiService.get<{ success: boolean; data: Product[] }>(
          url,
          scopeConfig && Object.keys(scopeConfig.headers || {}).length ? scopeConfig : undefined
        );
        
        console.log(`🔍 useProductsByType - API response:`, {
          endpoint,
          productType,
          success: response.success,
          dataLength: response.data?.length || 0
        });
        
        if (response.success && response.data) {
          console.log('🔍 useProductsByType - Raw API data sample:', response.data[0]);
          console.log('🔍 useProductsByType - All products before filtering:', response.data.map(p => ({ id: p.ProductId, name: p.Name, type: p.ProductType, status: p.Status })));
          
          // First, identify bundles and fetch their included products
          const bundles = response.data.filter(p => {
            const isBundle = (p as any).IsBundle === 1 || (p as any).IsBundle === true || (p as any).isBundle === 1 || (p as any).isBundle === true;
            return isBundle;
          });
          
          // Fetch included products for all bundles
          const bundleProductTypes: Record<string, string[]> = {};
          await Promise.all(bundles.map(async (bundle) => {
            try {
              const bundleResponse = await apiService.get<{ success: boolean; data: any[] }>(`/api/products/${bundle.ProductId}/bundle-products`);
              if (bundleResponse.success && bundleResponse.data) {
                // Get unique ProductTypes from included products
                const includedProductTypes = [...new Set(bundleResponse.data.map((ip: any) => ip.ProductType).filter(Boolean))];
                bundleProductTypes[bundle.ProductId] = includedProductTypes;
                console.log(`🔍 useProductsByType - Bundle ${bundle.Name} includes product types:`, includedProductTypes);
              }
            } catch (error) {
              console.warn(`Error fetching bundle products for ${bundle.ProductId}:`, error);
              // If we can't fetch bundle products, exclude the bundle to be safe
              bundleProductTypes[bundle.ProductId] = [];
            }
          }));
          
          // Filter by product type, SalesType, IsHidden, and return active products
          const filteredProducts = response.data.filter(product => {
            const productTypeMatch = product.ProductType === productType;
            const isActive = product.Status === 'Active';
            const isBundle = (product as any).IsBundle === 1 || (product as any).IsBundle === true || (product as any).isBundle === 1 || (product as any).isBundle === true;
            
            // Filter out hidden products (IsHidden = 1 or true)
            const isHidden = (product as any).IsHidden === 1 || (product as any).IsHidden === true || (product as any).isHidden === 1 || (product as any).isHidden === true;
            if (isHidden) {
              console.log('🔍 useProductsByType - Filtering out hidden product:', product.Name);
              return false;
            }
            
            // For bundles: Only include if they contain products of the requested productType
            // For regular products: Must match the productType exactly
            let includeBundle = false;
            if (isBundle) {
              const includedTypes = bundleProductTypes[product.ProductId] || [];
              includeBundle = includedTypes.includes(productType);
              console.log(`🔍 useProductsByType - Bundle ${product.Name} includes types:`, includedTypes, `matches ${productType}:`, includeBundle);
            }
            
            // Filter by SalesType if templateType is provided
            // For both bundles and regular products: Filter by SalesType
            let salesTypeMatch = true; // Default to true if no templateType filter
            if (templateType) {
              const salesType = ((product as any).SalesType || (product as any).salesType || '').toString().trim();
              const normalizedTemplateType = templateType.toString().trim();
              // SalesType can be 'Individual', 'Group', or 'Both'
              // If templateType is 'Individual', show products with SalesType 'Individual' or 'Both'
              // If templateType is 'Group', show products with SalesType 'Group' or 'Both'
              // If SalesType is null/empty, include it (assume it's valid for the template type)
              // This applies to both bundles and regular products
              // Normalize comparison by trimming and ensuring exact match
              salesTypeMatch = !salesType || salesType === 'Both' || salesType === normalizedTemplateType;
              
              if (!salesTypeMatch) {
                console.log(`🚫 useProductsByType - Filtered out product: ${product.Name}, SalesType: "${salesType}", TemplateType: "${normalizedTemplateType}"`);
              }
            }
            
            console.log('🔍 useProductsByType - Filtering product:', { 
              productId: product.ProductId, 
              productName: product.Name,
              productType: product.ProductType, 
              targetType: productType, 
              typeMatch: productTypeMatch,
              status: product.Status,
              isActive,
              isBundle,
              isHidden,
              includeBundle,
              templateType,
              salesType: (product as any).SalesType || (product as any).salesType,
              salesTypeMatch,
              passesFilter: (productTypeMatch || includeBundle) && isActive && salesTypeMatch
            });
            
            return (productTypeMatch || includeBundle) && isActive && salesTypeMatch;
          });
          
          console.log('🔍 useProductsByType - Filtered products sample:', filteredProducts[0]);
          console.log('🔍 useProductsByType - Filtered products count:', filteredProducts.length);
          
          console.log('🔍 useProductsByType - Returning products:', filteredProducts.map(p => ({ id: p.ProductId, name: p.Name, type: p.ProductType })));
          
          return filteredProducts;
        }
        
        return [];
      } catch (error) {
        console.warn(`Error fetching products for type ${productType}:`, error);
        return [];
      }
    },
    enabled: (() => {
      const enabled = !isAuthLoading && !!user?.currentRole && !!productType && (user.currentRole !== 'SysAdmin' || !!tenantId);
      console.log('🔍 useProductsByType - Query enabled:', {
        enabled,
        isAuthLoading,
        hasUserRole: !!user?.currentRole,
        hasProductType: !!productType,
        isSysAdmin: user?.currentRole === 'SysAdmin',
        hasTenantId: !!tenantId
      });
      return enabled;
    })(),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });

  // Debug: Log query state changes
  console.log('🔍 useProductsByType - Query state:', {
    productType,
    tenantId,
    isFetching: query.isFetching,
    isLoading: query.isLoading,
    isError: query.isError,
    dataLength: query.data?.length || 0,
    error: query.error,
    isStale: query.isStale,
    isSuccess: query.isSuccess,
    status: query.status
  });

  // Debug: Check if query should be executing
  React.useEffect(() => {
    console.log('🔍 useProductsByType - useEffect triggered for:', {
      productType,
      tenantId,
      queryStatus: query.status,
      hasData: !!query.data,
      dataLength: query.data?.length || 0
    });
  }, [productType, tenantId, query.status, query.data]);

  return query;
};