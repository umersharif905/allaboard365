import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService } from '../services/api.service';

interface CreateBundleRequest {
  name: string;
  description: string;
  productType: string;
  productOwnerId: string;
  salesType: string;
  isHidden?: boolean;
  minAge: number;
  maxAge: number;
  allowedStates: string[];
  requiresTobaccoInfo: boolean;
  effectiveDateLogic: string;
  maxEffectiveDateDays: number;
  terminationLogic: string;
  requiredLicenses: string[];
  partNumber?: string;
  isBundle: boolean;
  vendorId?: string;
  isVendorPricing: boolean;
  vendorCommission: number;
  bundleProducts: {
    productId: string;
    isRequired: boolean;
    sortOrder: number;
    hidePricing?: boolean;
    linkedToProductId?: string | null;
  }[];
  pricingTiers: any[];
  acknowledgementQuestions: any[];
  productImageFile?: File | null;
  productLogoFile?: File | null;
  productDocumentFile?: File | null;
  planDetailsHeaderLogoFile?: File | null;
  idCardLogoFile?: File | null;
  idCardBackImageFiles?: any;
  idCardData: any;
  planDetailsData: any;
  aiChunks: any[];
  requiredASA?: any;
  logoUrl?: string;
  isUpdate?: boolean;
  productId?: string;
}

interface CreateBundleResponse {
  success: boolean;
  data: {
    Id: string;
    Name: string;
    Description: string;
    ProductType: string;
    IsBundle: boolean;
    BundleProducts: any[];
  };
  message?: string;
  error?: {
    message: string;
    code: string;
  };
  productId?: string;
}

const createBundle = async (bundleData: CreateBundleRequest): Promise<CreateBundleResponse> => {
  try {
    // Create FormData for file uploads
    const formData = new FormData();
    
    // Add basic bundle information
    formData.append('name', bundleData.name);
    formData.append('description', bundleData.description);
    formData.append('productType', bundleData.productType);
    formData.append('productOwnerId', bundleData.productOwnerId);
    formData.append('salesType', bundleData.salesType);
    formData.append('isHidden', String(bundleData.isHidden ?? false));
    formData.append('minAge', bundleData.minAge.toString());
    formData.append('maxAge', bundleData.maxAge.toString());
    formData.append('allowedStates', JSON.stringify(bundleData.allowedStates));
    formData.append('requiresTobaccoInfo', bundleData.requiresTobaccoInfo.toString());
    formData.append('effectiveDateLogic', bundleData.effectiveDateLogic);
    formData.append('maxEffectiveDateDays', bundleData.maxEffectiveDateDays.toString());
    formData.append('terminationLogic', bundleData.terminationLogic);
    formData.append('requiredLicenses', JSON.stringify(bundleData.requiredLicenses));
    formData.append('partNumber', bundleData.partNumber || '');
    formData.append('isBundle', 'true');
    
    // Bundles are tenant-owned — no vendor
    if (bundleData.vendorId) {
      formData.append('vendorId', bundleData.vendorId);
    }
    formData.append('isVendorPricing', bundleData.isVendorPricing.toString());
    formData.append('vendorCommission', bundleData.vendorCommission.toString());
    const normalizedBundleProducts = bundleData.bundleProducts.map((product) => ({
      productId: product.productId,
      isRequired: product.isRequired,
      sortOrder: product.sortOrder,
      hidePricing: !!product.hidePricing,
      linkedToProductId: product.hidePricing
        ? product.linkedToProductId || null
        : null,
    }));

    formData.append('bundleProducts', JSON.stringify(normalizedBundleProducts));
    formData.append('pricingTiers', JSON.stringify(bundleData.pricingTiers));
    formData.append('acknowledgementQuestions', JSON.stringify(bundleData.acknowledgementQuestions));
    formData.append('idCardData', JSON.stringify(bundleData.idCardData));
    formData.append('planDetailsData', JSON.stringify(bundleData.planDetailsData));
    formData.append('aiChunks', JSON.stringify(bundleData.aiChunks));
    
    if (bundleData.requiredASA) {
      formData.append('requiredASA', JSON.stringify(bundleData.requiredASA));
    }
    
    // Add update-specific fields
    if (bundleData.logoUrl) {
      formData.append('productLogoUrl', bundleData.logoUrl);
      console.log('🔗 Adding productLogoUrl to FormData:', bundleData.logoUrl);
    }
    if (bundleData.isUpdate) {
      formData.append('isUpdate', 'true');
      console.log('🔄 Adding isUpdate flag to FormData');
    }
    if (bundleData.productId) {
      formData.append('productId', bundleData.productId);
      console.log('🆔 Adding productId to FormData:', bundleData.productId);
    }

    // Add file uploads
    if (bundleData.productImageFile) {
      formData.append('productImageFile', bundleData.productImageFile);
    }
    if (bundleData.productLogoFile) {
      formData.append('productLogoFile', bundleData.productLogoFile);
    }
    if (bundleData.productDocumentFile) {
      formData.append('productDocumentFile', bundleData.productDocumentFile);
    }
    if (bundleData.planDetailsHeaderLogoFile) {
      formData.append('planDetailsHeaderLogoFile', bundleData.planDetailsHeaderLogoFile);
    }
    if (bundleData.idCardLogoFile) {
      formData.append('idCardLogoFile', bundleData.idCardLogoFile);
    }
    if (bundleData.idCardBackImageFiles) {
      Object.entries(bundleData.idCardBackImageFiles).forEach(([key, file]) => {
        if (file) {
          formData.append(`idCardBackImageFiles.${key}`, file as File);
        }
      });
    }

    // Use PUT for updates, POST for creates
    const endpoint = bundleData.isUpdate && bundleData.productId 
      ? `/api/products/${bundleData.productId}`
      : '/api/products';
    
    const method = bundleData.isUpdate && bundleData.productId ? 'put' : 'post';
    
    console.log('🌐 Making API call:', {
      method: method.toUpperCase(),
      endpoint: endpoint,
      isUpdate: bundleData.isUpdate,
      productId: bundleData.productId,
      hasLogoUrl: !!bundleData.logoUrl,
      logoUrl: bundleData.logoUrl
    });
    
    const response = await apiService[method]<CreateBundleResponse>(endpoint, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    
    console.log('📡 API response received:', {
      success: response.success,
      message: response.message,
      productId: response.productId
    });

    return response;
  } catch (error) {
    console.error('Error creating bundle:', error);
    throw new Error(error instanceof Error ? error.message : 'Failed to create bundle');
  }
};

export const useBundleCreation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createBundle,
    onSuccess: (data) => {
      // Invalidate and refetch products query
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['bundles'] });
      
      console.log('Bundle created successfully:', data);
    },
    onError: (error) => {
      console.error('Error creating bundle:', error);
    },
  });
};
