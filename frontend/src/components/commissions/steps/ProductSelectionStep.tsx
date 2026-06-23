// src/components/commissions/steps/ProductSelectionStep.tsx
import {
    Search as SearchIcon,
    ViewList as ViewListIcon,
    ViewModule as ViewModuleIcon,
} from '@mui/icons-material';
import {
    Alert,
    Box,
    Card,
    CardContent,
    Checkbox,
    Chip,
    CircularProgress,
    FormControlLabel,
    Grid,
    InputAdornment,
    Radio,
    RadioGroup,
    TextField,
    ToggleButton,
    ToggleButtonGroup,
    Typography,
} from '@mui/material';
import React, { useEffect, useRef, useState } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { apiService } from '../../../services/api.service';
import { commissionRuleService } from '../../../services/commissionRules.service';
import { RuleCreationFormData } from '../RuleCreationWizard';

// Flexible interface to handle different API response formats
interface Product {
  // Lowercase properties (frontend convention)
  productId?: string;
  productName?: string;
  productType?: string;
  description?: string;
  status?: string;
  category?: string;
  isHidden?: boolean;
  isBundle?: boolean;
  salesType?: string;
  
  // Uppercase properties (backend convention)
  ProductId?: string;
  Name?: string;
  ProductType?: string;
  Description?: string;
  Status?: string;
  OwnerName?: string;
  ProductOwnerName?: string;
  VendorName?: string;
  vendorName?: string;
  productOwnerName?: string;
  ownerName?: string;
  productOwner?: {
    tenantName?: string;
    name?: string;
  };
  IsMarketplaceProduct?: boolean;
  IsHidden?: boolean;
  IsBundle?: boolean;
  SubscriptionCount?: number;
  SalesType?: string;
}

interface ProductSelectionStepProps {
  includeHidden?: boolean;
  compact?: boolean;
}

export const ProductSelectionStep: React.FC<ProductSelectionStepProps> = ({ includeHidden = true, compact = false }) => {
  const { control, setValue, watch } = useFormContext<RuleCreationFormData>();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [productRuleCounts, setProductRuleCounts] = useState<Record<string, number>>({});
  const [onlyShowWithoutRules, setOnlyShowWithoutRules] = useState(false);
  
  const selectedProductId = watch('productId');
  const currentRuleName = watch('ruleName');
  const lastAutoRuleNameRef = useRef<string | null>(null);
  const isLocked = false;

  // Fetch products
  useEffect(() => {
    const fetchProducts = async () => {
      try {
        setLoading(true);
        setError(null);
        
        // Determine which endpoint to use based on user role
        // Commission rules should only show products the tenant has subscribed to
        const storedRoles = localStorage.getItem('roles');
        const roles = storedRoles ? JSON.parse(storedRoles) : [];
        const currentRole = localStorage.getItem('currentRole') || roles[0] || null;
        const tenantId = localStorage.getItem('currentTenantId') || localStorage.getItem('tenantId');
        const isSysAdmin = roles.includes('SysAdmin');
        
        let endpoint = '';
        if (roles.includes('SysAdmin') && tenantId) {
          // SysAdmin - get subscribed products for the tenant
          endpoint = `/api/tenants/${tenantId}/products${includeHidden ? '?includeHidden=true' : ''}`;
          console.log('Fetching products for SysAdmin from:', endpoint);
        } else if (roles.includes('TenantAdmin')) {
          // TenantAdmin - get their subscribed products
          endpoint = `/api/tenant/products${includeHidden ? '?includeHidden=true' : ''}`;
          console.log('Fetching products for TenantAdmin from:', endpoint);
        } else if (roles.includes('Agent')) {
          // Agent - get products available to them
          endpoint = `/api/me/agent/products${includeHidden ? '?includeHidden=true' : ''}`;
          console.log('Fetching products for Agent from:', endpoint);
        } else {
          throw new Error('No valid role for fetching products');
        }
        
        const [rawResponse, rules] = await Promise.all([
          apiService.get(endpoint),
          commissionRuleService.getRules({}, currentRole || undefined)
        ]);
        const response = rawResponse as
          | { success?: boolean; data?: Product[] }
          | Product[];
        console.log('Products API response:', response);
        
        // Handle different response structures
        let productData: Product[] = [];
        if (typeof response === 'object' && !Array.isArray(response) && response.success && response.data) {
          productData = response.data;
        } else if (Array.isArray(response)) {
          productData = response;
        } else if (typeof response === 'object' && !Array.isArray(response) && response.data) {
          productData = Array.isArray(response.data) ? response.data : [];
        }
        
        console.log(`Found ${productData.length} subscribed products for tenant`);

        const nextRuleCounts: Record<string, number> = {};
        (rules || []).forEach((r) => {
          if (isSysAdmin && tenantId && r?.TenantId && r.TenantId !== tenantId) return;
          const productId = r?.ProductId;
          if (!productId || productId === '00000000-0000-0000-0000-000000000000') return;
          nextRuleCounts[productId] = (nextRuleCounts[productId] || 0) + 1;
        });
        setProductRuleCounts(nextRuleCounts);
        
        if (productData.length === 0) {
          console.warn('No products returned from API');
          setError('No products found. Your tenant must subscribe to products before creating commission rules.');
        }
        
        // Filter active products only - include hidden products for commission rules
        // Exclude bundles - only show individual products (bundles don't need commission rules, their components do)
        const activeProducts = productData.filter((p: Product) => {
          const isActive = (p.status === 'Active' || p.Status === 'Active');
          const isBundle = !!p.IsBundle || !!p.isBundle || (p.IsBundle as any) === 1 || (p.isBundle as any) === 1;
          return isActive && !isBundle;
        });
        
        // Add "ALL PRODUCTS" option at the beginning
        const allProductsOption: Product = {
          ProductId: '00000000-0000-0000-0000-000000000000',
          Name: 'All Products',
          ProductType: 'Universal',
          Description: 'Commission rule applies to all products in calculating total contribution',
          Status: 'Active',
        };
        
        setProducts([allProductsOption, ...activeProducts]);
      } catch (err: any) {
        console.error('Error fetching products:', err);
        setError(err.message || 'Failed to load products. Please try again.');
        setProducts([]);
        setProductRuleCounts({});
      } finally {
        setLoading(false);
      }
    };

    fetchProducts();
  }, [includeHidden]);

  // Format SalesType for display
  const formatSalesType = (salesType?: string): string => {
    if (!salesType) return '';
    if (salesType === 'Both') return 'Group and Individual';
    if (salesType === 'Group') return 'Group';
    if (salesType === 'Individual') return 'Individual';
    return salesType;
  };

  // Filter products based on search
  const filteredProducts = products.filter(product => {
    const name = product.productName || product.Name || '';
    const type = product.productType || product.ProductType || '';
    const salesType = product.salesType || product.SalesType || '';
    const id = product.productId || product.ProductId || '';
    const searchLower = searchTerm.toLowerCase();

    const matchesSearch = name.toLowerCase().includes(searchLower) ||
           type.toLowerCase().includes(searchLower) ||
           formatSalesType(salesType).toLowerCase().includes(searchLower);
    if (!matchesSearch) return false;

    if (!onlyShowWithoutRules) return true;
    if (id === selectedProductId) return true; // Keep current selection visible.
    if (id === '00000000-0000-0000-0000-000000000000') return false; // Exclude "All Products" for this filter.

    return (productRuleCounts[id] || 0) === 0;
  });
  function getVendorName(product: Product): string {
    return (
      product.VendorName ||
      product.vendorName ||
      product.ProductOwnerName ||
      product.productOwnerName ||
      product.OwnerName ||
      product.ownerName ||
      product.productOwner?.tenantName ||
      product.productOwner?.name ||
      ''
    );
  }

  const sortedProducts = [...filteredProducts].sort((a, b) => {
    const aId = a.productId || a.ProductId || '';
    const bId = b.productId || b.ProductId || '';
    const aIsAll = aId === '00000000-0000-0000-0000-000000000000';
    const bIsAll = bId === '00000000-0000-0000-0000-000000000000';
    if (aIsAll && !bIsAll) return -1;
    if (!aIsAll && bIsAll) return 1;

    const aVendor = getVendorName(a).toLowerCase();
    const bVendor = getVendorName(b).toLowerCase();
    const vendorCompare = aVendor.localeCompare(bVendor);
    if (vendorCompare !== 0) return vendorCompare;

    const aName = (a.productName || a.Name || '').toLowerCase();
    const bName = (b.productName || b.Name || '').toLowerCase();
    return aName.localeCompare(bName);
  });

  const getHasCommissionAllocated = (product: Product): boolean => {
    const id = product.productId || product.ProductId || '';
    if (id === '00000000-0000-0000-0000-000000000000') return true;

    const hasPricingField = Object.prototype.hasOwnProperty.call(product, 'PricingTiers')
      || Object.prototype.hasOwnProperty.call(product, 'pricingTiers');
    const pricingTiers = (product as any).PricingTiers ?? (product as any).pricingTiers;

    // If pricing tiers are not included in this API payload, don't block selection.
    if (!hasPricingField) return true;
    if (!Array.isArray(pricingTiers) || pricingTiers.length === 0) return false;

    return pricingTiers.some((tier: any) => {
      const directCommission = Number(
        tier?.commission
        ?? tier?.Commission
        ?? tier?.VendorCommission
        ?? tier?.vendorCommission
      );
      if (Number.isFinite(directCommission) && directCommission > 0) return true;

      const msrp = Number(tier?.msrpRate ?? tier?.MSRPRate);
      const net = Number(tier?.netRate ?? tier?.NetRate);
      const override = Number(tier?.overrideRate ?? tier?.OverrideRate);
      if (Number.isFinite(msrp) && Number.isFinite(net) && Number.isFinite(override)) {
        return (msrp - net - override) > 0;
      }
      return false;
    });
  };

  // Handle product selection
  const handleProductSelect = (product: Product) => {
    const id = product.productId || product.ProductId || '';
    const name = product.productName || product.Name || '';
    const type = product.productType || product.ProductType || '';
    const defaultRuleName = (name || '').trim() || 'All Products';
    
    setValue('productId', id, { shouldValidate: true });
    setValue('productName', name, { shouldValidate: true });
    setValue('productType', type, { shouldValidate: true });

    // Auto-default rule name from selected product, but do not overwrite user-customized names.
    const normalizedCurrentName = (currentRuleName || '').trim();
    if (!normalizedCurrentName || normalizedCurrentName === lastAutoRuleNameRef.current) {
      setValue('ruleName', defaultRuleName, { shouldValidate: true, shouldDirty: true });
      lastAutoRuleNameRef.current = defaultRuleName;
    }
  };

  // Get chip color based on product type
  const getTypeColor = (type: string) => {
    switch (type.toLowerCase()) {
      case 'universal':
        return 'primary';
      case 'healthcare':
        return 'primary';
      case 'dental':
        return 'info';
      case 'vision':
        return 'secondary';
      case 'life':
        return 'success';
      case 'ancillary':
        return 'warning';
      default:
        return 'default';
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={300}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {!compact && (
        <Typography variant="subtitle2" fontWeight={600} gutterBottom>
          Product
        </Typography>
      )}

      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Search field with view toggle */}
      <Box sx={{ mb: 3, display: 'flex', gap: 2, alignItems: 'center' }}>
        <TextField
          fullWidth
          placeholder="Search products..."
          value={searchTerm}
          onChange={(e) => {
            if (!isLocked) setSearchTerm(e.target.value);
          }}
          disabled={isLocked}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
        />
        <ToggleButtonGroup
          value={viewMode}
          exclusive
          onChange={(_, newMode) => {
            if (!isLocked && newMode) setViewMode(newMode);
          }}
          disabled={isLocked}
          size="small"
        >
          <ToggleButton value="grid" aria-label="grid view">
            <ViewModuleIcon />
          </ToggleButton>
          <ToggleButton value="list" aria-label="list view">
            <ViewListIcon />
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Box sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={onlyShowWithoutRules}
              onChange={(e) => {
                if (!isLocked) setOnlyShowWithoutRules(e.target.checked);
              }}
              disabled={isLocked}
              size="small"
            />
          }
          label="Products without rules only"
        />
      </Box>

      {/* Product selection */}
      <Controller
        name="productId"
        control={control}
        render={({ field, fieldState }) => (
          <>
            <RadioGroup 
              value={field.value} 
              onChange={(e) => {
                if (isLocked) return;
                const product = products.find(p => 
                  (p.productId || p.ProductId) === e.target.value
                );
                if (product) handleProductSelect(product);
              }}
            >
              {viewMode === 'grid' ? (
                <Grid container spacing={2}>
                  {sortedProducts.map((product) => {
                    const id = product.productId || product.ProductId || '';
                    const name = product.productName || product.Name || '';
                    const vendorName = getVendorName(product);
                    const salesType = product.salesType || product.SalesType || '';
                    const isAllProducts = id === '00000000-0000-0000-0000-000000000000';
                    const hasCommissionAllocated = getHasCommissionAllocated(product);
                    const isProductDisabled = isLocked || !hasCommissionAllocated;
                    const existingRuleCount = productRuleCounts[id] || 0;
                    
                    return (
                      <Grid size={{ xs: 12, md: compact ? 12 : isAllProducts ? 12 : 6 }} key={id}>
                        <Card
                          sx={{
                            cursor: isProductDisabled ? 'not-allowed' : 'pointer',
                            minHeight: compact ? 56 : 160,
                            height: '100%',
                            display: 'flex',
                            flexDirection: 'column',
                            border: selectedProductId === id ? 2 : 1,
                            borderColor: selectedProductId === id 
                              ? 'primary.main' 
                              : 'divider',
                            transition: 'all 0.2s',
                            backgroundColor: isAllProducts ? 'primary.50' : 'background.paper',
                            opacity: isProductDisabled ? 0.6 : 1,
                            pointerEvents: isProductDisabled ? 'none' : 'auto',
                            '&:hover': {
                              borderColor: 'primary.main',
                              boxShadow: 2,
                            },
                          }}
                          onClick={() => {
                            if (!isProductDisabled) handleProductSelect(product);
                          }}
                        >
                          <CardContent sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
                            <Box display="flex" alignItems="flex-start" gap={2}>
                              <FormControlLabel
                                value={id}
                                control={<Radio size="small" disabled={isProductDisabled} />}
                                label=""
                                sx={{ m: 0 }}
                              />
                              <Box flex={1}>
                                <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
                                  {name}
                                </Typography>
                                {!isAllProducts && vendorName && (
                                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                                    {vendorName}
                                  </Typography>
                                )}
                                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                                  {!isAllProducts && salesType && (
                                    <Chip 
                                      label={formatSalesType(salesType)} 
                                      size="small" 
                                      color="default"
                                      variant="outlined"
                                    />
                                  )}
                                </Box>
                                {!isAllProducts && (
                                  <Typography
                                    variant="caption"
                                    sx={{
                                      color: !hasCommissionAllocated || existingRuleCount === 0 ? 'error.main' : 'text.secondary',
                                      fontWeight: !hasCommissionAllocated || existingRuleCount === 0 ? 600 : 400,
                                      display: 'block'
                                    }}
                                  >
                                    {!hasCommissionAllocated
                                      ? 'Product does not have commission allocated'
                                      : existingRuleCount === 0
                                      ? 'Has no commission rules'
                                      : `Has ${existingRuleCount} existing commission rule${existingRuleCount === 1 ? '' : 's'}`}
                                  </Typography>
                                )}
                              </Box>
                            </Box>
                          </CardContent>
                        </Card>
                      </Grid>
                    );
                  })}
                </Grid>
              ) : (
                <Box>
                  {sortedProducts.map((product) => {
                    const id = product.productId || product.ProductId || '';
                    const name = product.productName || product.Name || '';
                    const vendorName = getVendorName(product);
                    const salesType = product.salesType || product.SalesType || '';
                    const isAllProducts = id === '00000000-0000-0000-0000-000000000000';
                    const hasCommissionAllocated = getHasCommissionAllocated(product);
                    const isProductDisabled = isLocked || !hasCommissionAllocated;
                    const existingRuleCount = productRuleCounts[id] || 0;
                    
                    return (
                      <Card
                        key={id}
                        sx={{
                          cursor: isProductDisabled ? 'not-allowed' : 'pointer',
                          mb: 1,
                          border: selectedProductId === id ? 2 : 1,
                          borderColor: selectedProductId === id 
                            ? 'primary.main' 
                            : 'divider',
                          transition: 'all 0.2s',
                          backgroundColor: isAllProducts ? 'primary.50' : 'background.paper',
                          opacity: isProductDisabled ? 0.6 : 1,
                          pointerEvents: isProductDisabled ? 'none' : 'auto',
                          '&:hover': {
                            borderColor: 'primary.main',
                            boxShadow: 1,
                          },
                        }}
                        onClick={() => {
                          if (!isProductDisabled) handleProductSelect(product);
                        }}
                      >
                        <CardContent sx={{ py: 2 }}>
                          <FormControlLabel
                            value={id}
                            control={<Radio size="small" disabled={isProductDisabled} />}
                            label={
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%' }}>
                                <Box sx={{ flexGrow: 1 }}>
                                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                                    <Typography variant="subtitle2" fontWeight="bold">
                                      {name}
                                    </Typography>
                                    {!isAllProducts && vendorName && (
                                      <Typography variant="caption" color="text.secondary">
                                        {vendorName}
                                      </Typography>
                                    )}
                                    {!isAllProducts && salesType && (
                                      <Chip 
                                        label={formatSalesType(salesType)} 
                                        size="small" 
                                        color="default"
                                        variant="outlined"
                                      />
                                    )}
                                  </Box>
                                  {!isAllProducts && (
                                    <Typography
                                      variant="caption"
                                      sx={{
                                        color: !hasCommissionAllocated || existingRuleCount === 0 ? 'error.main' : 'text.secondary',
                                        fontWeight: !hasCommissionAllocated || existingRuleCount === 0 ? 600 : 400,
                                        display: 'block',
                                        mt: 0.5
                                      }}
                                    >
                                      {!hasCommissionAllocated
                                        ? 'Product does not have commission allocated'
                                        : existingRuleCount === 0
                                        ? 'Has no commission rules'
                                        : `Has ${existingRuleCount} existing commission rule${existingRuleCount === 1 ? '' : 's'}`}
                                    </Typography>
                                  )}
                                </Box>
                              </Box>
                            }
                            sx={{ m: 0, width: '100%' }}
                          />
                        </CardContent>
                      </Card>
                    );
                  })}
                </Box>
              )}
            </RadioGroup>
            
            {fieldState.error && (
              <Typography color="error" variant="caption" sx={{ mt: 1, display: 'block' }}>
                {fieldState.error.message}
              </Typography>
            )}
          </>
        )}
      />

      {filteredProducts.length === 0 && (
        <Box textAlign="center" py={4}>
          <Typography color="textSecondary">
            No products found matching your search
          </Typography>
        </Box>
      )}
    </Box>
  );
};