// Fixed Marketplace.tsx - Complete code with MUI Snackbar implementation
import React, { useEffect, useState } from 'react';
import AIProductCreator from '../../components/ai/AIProductCreator';
import AddBundleWizard from '../../components/forms/AddBundleWizard';
import AddProductWizard, { ProductFormData } from '../../components/forms/AddProductWizard';
import ProductAPIConfigModal from '../../components/products/ProductAPIConfigModal';
import SubscribedProductDetailsModal, {
  normalizeMarketplaceProductForDetailsModal,
  type BundleProduct,
} from '../../components/products/SubscribedProductDetailsModal';
import SharedHeader from '../../components/layout/SharedHeader';
import { API_CONFIG } from '../../config/api';
import { apiService } from '../../services/api.service';
import { FilterState, Product } from '../../types/marketplace';
import { BundleFormData } from '../../types/sysadmin/addproductswizard.types';

// MUI Snackbar imports
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Slide, { SlideProps } from '@mui/material/Slide';
import Snackbar from '@mui/material/Snackbar';

// Icons
import {
    Building,
    Copy,
    Edit,
    Eye,
    EyeOff, Grid, List,
    Package,
    Plus,
    Shield,
    ShoppingCart,
    Sparkles,
    User,
    Users,
    Webhook,
    X
} from 'lucide-react';

// FIXED: Use inline SVG data URLs instead of external service
// const PLACEHOLDER_IMAGE = `data:image/svg+xml;charset=UTF-8,%3Csvg width='400' height='300' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='400' height='300' fill='%23e5e7eb'/%3E%3Ctext x='200' y='150' text-anchor='middle' dy='0.35em' font-family='Arial, sans-serif' font-size='16' fill='%239ca3af'%3ENo Image%3C/text%3E%3C/svg%3E`;

// const PLACEHOLDER_IMAGE_SMALL = `data:image/svg+xml;charset=UTF-8,%3Csvg width='64' height='64' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='64' height='64' fill='%23e5e7eb'/%3E%3Ctext x='32' y='32' text-anchor='middle' dy='0.35em' font-family='Arial, sans-serif' font-size='10' fill='%239ca3af'%3ENo Image%3C/text%3E%3C/svg%3E`;

// const PLACEHOLDER_IMAGE_LARGE = `data:image/svg+xml;charset=UTF-8,%3Csvg width='600' height='400' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='600' height='400' fill='%23e5e7eb'/%3E%3Ctext x='300' y='200' text-anchor='middle' dy='0.35em' font-family='Arial, sans-serif' font-size='20' fill='%239ca3af'%3ENo Image%3C/text%3E%3C/svg%3E`;

// Utility function to extract error messages
const getErrorMessage = (error: any): string => {
  if (error?.message) return error.message;
  if (typeof error === 'string') return error;
  return 'An unexpected error occurred';
};

// Types

// Type for API payload without file objects
interface ApiProductData extends Omit<ProductFormData, 'productImageFile' | 'productLogoFile' | 'productDocumentFile' | 'productDocumentFiles' | 'idCardLogoFile' | 'idCardBackImageFiles' | 'planDetailsHeaderLogoFile' | 'isBundle' | 'bundleProducts'> {
  productImageUrl?: string;
  productLogoUrl?: string;
  productDocumentUrl?: string;
  productId?: string;
  // Note: isBundle and bundleProducts are not part of the current ProductFormData type
  // They should be removed from the apiProductData object creation
}

// Snackbar notification type
type NotificationSeverity = 'success' | 'error' | 'warning' | 'info';

interface NotificationState {
  open: boolean;
  message: string;
  severity: NotificationSeverity;
  title?: string;
}

// Slide transition for Snackbar
function SlideTransition(props: SlideProps) {
  return <Slide {...props} direction="down" />;
}

const ProductMarketplace: React.FC = () => {
  // Safe helper function for joining arrays
  const safeJoinArray = (arr: any, separator: string = ', '): string => {
    if (!arr) return '';
    if (Array.isArray(arr)) return arr.join(separator);
    if (typeof arr === 'string') return arr;
    return '';
  };

  // Safe helper function for slicing and joining arrays (for modal)
  const safeSliceJoinArray = (arr: any, start: number = 0, end?: number, separator: string = ', '): string => {
    if (!arr) return '';
    if (!Array.isArray(arr)) return typeof arr === 'string' ? arr : '';
    const sliced = end ? arr.slice(start, end) : arr.slice(start);
    return sliced.join(separator);
  };

  // const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [showDetailsModal, setShowDetailsModal] = useState<boolean>(false);
  const [detailsModalProduct, setDetailsModalProduct] = useState<Record<string, unknown> | null>(null);
  
  // Add Product Wizard State
  const [showAddProduct, setShowAddProduct] = useState<boolean>(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  
  // AI Product Creator State
  const [showAICreator, setShowAICreator] = useState<boolean>(false);
  
  // Add Bundle Wizard State
  const [showAddBundle, setShowAddBundle] = useState<boolean>(false);
  const [editingBundle, setEditingBundle] = useState<Product | null>(null);
  
  // Delete confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false);
  const [productToDelete, setProductToDelete] = useState<Product | null>(null);
  
  // API config modal state
  const [showAPIConfigModal, setShowAPIConfigModal] = useState<boolean>(false);
  const [apiConfigProduct, setApiConfigProduct] = useState<Product | null>(null);
  
  // Snackbar notification state
  const [notification, setNotification] = useState<NotificationState>({
    open: false,
    message: '',
    severity: 'info'
  });
  
  const [filters, setFilters] = useState<FilterState>({
    search: '',
    productType: '',
    salesType: '',
    minPrice: '',
    maxPrice: '',
    requiredLicenses: [],
    productOwner: ''
  });

  const [selectedVendor, setSelectedVendor] = useState<string>('');

  const [productOwners, setProductOwners] = useState<Array<{
    ProductOwnerId: string;
    Name: string;
    LogoUrl?: string | null;
    ProductCount?: number;
  }>>([]);

  const [vendors, setVendors] = useState<Array<{
    Id: string;
    VendorName: string;
  }>>([]);

  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [duplicateModalProduct, setDuplicateModalProduct] = useState<Product | null>(null);
  const [duplicateTargetTenantId, setDuplicateTargetTenantId] = useState('');
  const [duplicateProductName, setDuplicateProductName] = useState('');
  const [tenantsForDuplicate, setTenantsForDuplicate] = useState<Array<{ TenantId: string; Name: string }>>([]);
  const [duplicateSubmitting, setDuplicateSubmitting] = useState(false);

  // This is a system admin-only page, so no role checking needed
  const canEditProducts = true;

  // Show notification helper
  const showNotification = (message: string, severity: NotificationSeverity = 'info', title?: string) => {
    setNotification({
      open: true,
      message,
      severity,
      title
    });
  };

  // Fix the handleCloseNotification function to use underscore for unused parameter
  const handleCloseNotification = (_event?: React.SyntheticEvent | Event, reason?: string) => {
    if (reason === 'clickaway') {
      return;
    }
    setNotification(prev => ({ ...prev, open: false }));
  };

  // API Service functions - using apiService
  const apiCall = async (endpoint: string, options: RequestInit = {}): Promise<any> => {
    try {
      if (options.method === 'POST') {
        const body = options.body ? JSON.parse(options.body as string) : undefined;
        return await apiService.post(endpoint, body);
      } else if (options.method === 'PUT') {
        const body = options.body ? JSON.parse(options.body as string) : undefined;
        return await apiService.put(endpoint, body);
      } else if (options.method === 'DELETE') {
        return await apiService.delete(endpoint);
      } else {
        return await apiService.get(endpoint);
      }
    } catch (error: any) {
      console.error('API call failed:', error);
      throw new Error(error.message || 'Request failed');
    }
  };

  const fetchProductOwners = async (): Promise<void> => {
    try {
      const response = await apiCall('/api/marketplace/product-owners');
      setProductOwners(response.productOwners || []);
    } catch (error) {
      console.error('Error fetching product owners:', getErrorMessage(error));
    }
  };

  const fetchVendors = async (): Promise<void> => {
    try {
      const response = await apiCall('/api/vendors');
      setVendors(response.data || []);
    } catch (error) {
      console.error('Error fetching vendors:', getErrorMessage(error));
    }
  };

  const fetchTenantsForDuplicate = async (): Promise<void> => {
    try {
      const response = await apiService.get<{
        success?: boolean;
        tenants?: Array<{ TenantId: string; Name: string }>;
      }>('/api/marketplace/tenants');
      const list = response.tenants || [];
      list.sort((a, b) => (a.Name || '').localeCompare(b.Name || ''));
      setTenantsForDuplicate(list);
    } catch (error) {
      console.error('Error fetching tenants:', error);
      showNotification('Failed to load tenants', 'error', 'Error');
    }
  };

  const openDuplicateModal = (product: Product) => {
    setDuplicateModalProduct(product);
    setDuplicateTargetTenantId('');
    setDuplicateProductName(`${product.Name} (Copy)`);
    setShowDuplicateModal(true);
    void fetchTenantsForDuplicate();
  };

  const handleViewDetails = async (product: Product) => {
    let bundleProducts: BundleProduct[] = [];
    if (product.IsBundle) {
      try {
        const res = await apiService.get<{
          success: boolean;
          data?: Array<Record<string, unknown>>;
        }>(`/api/products/${product.ProductId}/bundle-products`);
        if (res.success && Array.isArray(res.data)) {
          bundleProducts = res.data.map((row) => ({
            productId: String(row.IncludedProductId ?? ''),
            name: String(row.ProductName ?? ''),
            description: row.Description as string | undefined,
            productType: String(row.ProductType ?? ''),
            sortOrder: Number(row.SortOrder ?? 0),
            isRequired: Boolean(row.IsRequired),
            hidePricing: Boolean(row.HidePricing),
            linkedToProductId: row.LinkedToProductId as string | undefined,
          }));
        }
      } catch (error) {
        console.error('Error loading bundle products for details modal:', error);
      }
    }
    setDetailsModalProduct(
      normalizeMarketplaceProductForDetailsModal(product as unknown as Record<string, unknown>, bundleProducts) as Record<string, unknown>
    );
    setShowDetailsModal(true);
  };

  const handleDuplicateProduct = async () => {
    const trimmedName = duplicateProductName.trim();
    if (!duplicateModalProduct || !duplicateTargetTenantId || !trimmedName) return;
    try {
      setDuplicateSubmitting(true);
      const res = await apiService.post<{
        success: boolean;
        productId?: string;
        message?: string;
      }>(`/api/products/${duplicateModalProduct.ProductId}/duplicate`, {
        targetTenantId: duplicateTargetTenantId,
        name: trimmedName
      });
      if (res.success) {
        showNotification(
          res.message || 'Product duplicated successfully',
          'success',
          'Success'
        );
        setShowDuplicateModal(false);
        setDuplicateModalProduct(null);
        setDuplicateTargetTenantId('');
        setDuplicateProductName('');
        await fetchMarketplaceProducts();
      } else {
        showNotification(res.message || 'Duplicate failed', 'error', 'Error');
      }
    } catch (error: any) {
      const msg =
        error?.response?.data?.message ||
        error?.message ||
        'Failed to duplicate product';
      showNotification(msg, 'error', 'Error');
    } finally {
      setDuplicateSubmitting(false);
    }
  };

  const fetchMarketplaceProducts = async (): Promise<void> => {
    try {
      setLoading(true);
      
      // Build query parameters
      const queryParams = new URLSearchParams();
      if (filters.search) queryParams.append('search', filters.search);
      if (filters.productType) queryParams.append('productType', filters.productType);
      if (filters.salesType) queryParams.append('salesType', filters.salesType);
      if (filters.minPrice) queryParams.append('minPrice', filters.minPrice);
      if (filters.maxPrice) queryParams.append('maxPrice', filters.maxPrice);
      if (filters.productOwner) queryParams.append('productOwner', filters.productOwner);
      
      // FIXED: Try multiple endpoints for marketplace products
      let endpoint = `/api/marketplace/products${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
      let response;
      
      try {
        response = await apiCall(endpoint);
      } catch (error) {
        console.log('❌ Marketplace endpoint failed, trying products endpoint');
        // Fallback to products endpoint
        endpoint = `/api/products${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
        response = await apiCall(endpoint);
      }
      
      setProducts(response.products || response.data || []);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('Error fetching products:', errorMessage);
      
      // Handle token expiration
      if (errorMessage.includes('token') || errorMessage.includes('401')) {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        window.location.href = '/login';
      } else {
        showNotification(`Failed to load products: ${errorMessage}`, 'error', 'Error');
      }
      setProducts([]);
    } finally {
      setLoading(false);
    }
  };

  const subscribeToProduct = async (productId: string, notes?: string): Promise<void> => {
    try {
      await apiCall('/api/marketplace/subscribe', {
        method: 'POST',
        body: JSON.stringify({ productId, notes }),
      });
      
      // Refresh products to update subscription status
      await fetchMarketplaceProducts();
      
      // Show success notification
      showNotification('Subscription request submitted successfully!', 'success', 'Success');
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('Error subscribing to product:', errorMessage);
      showNotification(`Failed to subscribe: ${errorMessage}`, 'error', 'Error');
    }
  };

  // Handle file upload functionality - FIXED VERSION
  const handleFileUpload = async (file: File, type: string): Promise<string | undefined> => {
    try {
      console.log('📁 Uploading file:', file.name, 'Type:', type);
      
      const formData = new FormData();
      formData.append('files', file); // Changed to match backend expectation
      formData.append('uploadType', type);
      formData.append('entityId', 'marketplace');
      formData.append('fileType', type); // Backward compatibility for older backend handlers

      const result = await apiService.post<{
        success: boolean;
        url?: string;
        data?: Array<{ url: string; filename: string }>;
        filename?: string;
        message?: string;
      }>('/api/uploads', formData);

      if (result.success) {
        // The backend now returns the URL directly for single file uploads
        const uploadedUrl = result.url || (result.data && result.data.length > 0 ? result.data[0].url : undefined);
        console.log('✅ File uploaded successfully:', uploadedUrl);
        return uploadedUrl;
      } else {
        throw new Error(result.message || 'Upload failed');
      }

    } catch (error) {
      console.error('❌ File upload error:', error);
      throw error;
    }
  };

  // Handle Add/Edit Product functionality - FIXED WITH ID CARD LOGO UPLOAD AND PLAN DETAILS LOGO
  const handleSaveProduct = async (productData: ProductFormData) => {
    // Track upload failures to show user
    const uploadFailures: string[] = [];
    
    try {
      console.log('RAW productData received:', productData);
      console.log('VendorCommission value:', productData.vendorCommission);
      console.log('📦 Frontend processing product data:', {
        name: productData.name,
        pricingTiersCount: productData.pricingTiers.length,
        configFieldsCount: productData.configurationFields.length,
        editMode: !!editingProduct,
        vendorId: productData.vendorId,
        isVendorPricing: productData.isVendorPricing,
        vendorCommission: Number(productData.vendorCommission) || 0,
        hasIdCardLogoFile: !!productData.idCardLogoFile,
        hasPlanDetailsHeaderLogoFile: !!productData.planDetailsHeaderLogoFile
      });
      
      // Initialize URLs as undefined - only set them if new files are uploaded
      let productImageUrl = undefined;
      let productLogoUrl = undefined;
      let productDocumentUrl = undefined;

      // Upload files with error handling - don't stop on failure
      if (productData.productImageFile) {
        try {
          console.log('📁 Uploading file:', productData.productImageFile.name, 'Type: images, Size:', productData.productImageFile.size);
          productImageUrl = await handleFileUpload(productData.productImageFile, 'logos');
          productLogoUrl = productImageUrl || undefined;
        } catch (error) {
          console.error('❌ Product image upload failed:', error);
          uploadFailures.push(`Product Image (${productData.productImageFile.name})`);
        }
      }
      
      if (productData.productLogoFile) {
        try {
          console.log('📁 Uploading file:', productData.productLogoFile.name, 'Type: logos, Size:', productData.productLogoFile.size);
          productLogoUrl = await handleFileUpload(productData.productLogoFile, 'logos');
        } catch (error) {
          console.error('❌ Product logo upload failed:', error);
          uploadFailures.push(`Product Logo (${productData.productLogoFile.name})`);
        }
      }
      
      if (productData.productDocumentFile) {
        try {
          console.log('📁 Uploading file:', productData.productDocumentFile.name, 'Type: documents, Size:', productData.productDocumentFile.size);
          productDocumentUrl = await handleFileUpload(productData.productDocumentFile, 'documents');
        } catch (error) {
          console.error('❌ Product document upload failed:', error);
          uploadFailures.push(`Product Document (${productData.productDocumentFile.name})`);
        }
      }

      // Upload multiple new document files (unlimited)
      const uploadedNewDocuments: { documentUrl: string; displayName: string; sortOrder: number }[] = [];
      const pendingFiles = productData.productDocumentFiles || [];
      for (let i = 0; i < pendingFiles.length; i++) {
        const item = pendingFiles[i];
        if (!item?.file || !(item.file instanceof File)) continue;
        try {
          console.log('📁 Uploading document:', item.file.name, 'Type: documents');
          const url = await handleFileUpload(item.file, 'documents');
          if (url) {
            uploadedNewDocuments.push({
              documentUrl: url,
              displayName: item.displayName?.trim() || item.file.name || 'Document',
              sortOrder: i
            });
          }
        } catch (error) {
          console.error('❌ Product document upload failed:', error);
          uploadFailures.push(`Product Document (${item.file.name})`);
        }
      }

      // Build full productDocuments for API
      const existingDocs = (productData.productDocuments || []).filter((d: any) => d?.documentUrl);
      const withLegacy = productDocumentUrl
        ? [...existingDocs, { documentUrl: productDocumentUrl, displayName: productData.productDocumentName || 'Document', sortOrder: existingDocs.length }]
        : existingDocs;
      const productDocuments = [...withLegacy, ...uploadedNewDocuments].map((d: any, i: number) => ({ ...d, sortOrder: i }));

      // Handle ID Card logo upload
      let updatedIdCardData = productData.idCardData;
      if (productData.idCardLogoFile) {
        try {
          console.log('📸 Uploading ID Card logo:', productData.idCardLogoFile.name, 'Size:', productData.idCardLogoFile.size);
          const idCardLogoUrl = await handleFileUpload(productData.idCardLogoFile, 'logos');
          
          // Update the ID card data with the uploaded logo URL
          updatedIdCardData = {
            ...productData.idCardData,
            Card_Front: {
              ...productData.idCardData.Card_Front,
              Header: {
                ...productData.idCardData.Card_Front.Header,
                Image: idCardLogoUrl || ''  // Ensure it's never null
              }
            }
          };
          console.log('✅ ID Card logo uploaded:', idCardLogoUrl);
        } catch (error) {
          console.error('❌ ID Card logo upload failed:', error);
          uploadFailures.push(`ID Card Logo (${productData.idCardLogoFile.name})`);
          // Continue without the logo - product will still be saved
        }
      }

      // Handle Card Back Image uploads - EXACTLY LIKE CARD FRONT
      if (productData.idCardBackImageFiles) {
        console.log('🎴 Processing Card Back images...');
        
        for (const [section, file] of Object.entries(productData.idCardBackImageFiles)) {
          if (file) {
            console.log(`📸 Uploading ${section} image:`, file.name, 'Size:', file.size);
            try {
              const imageUrl = await handleFileUpload(file, 'logos');
              
              const sectionKey = section as keyof ProductFormData['idCardData']['Card_Back'];
              const back = {
                ...productData.idCardData?.Card_Back,
                ...updatedIdCardData?.Card_Back,
              } as ProductFormData['idCardData']['Card_Back'];
              const existing =
                back[sectionKey] && typeof back[sectionKey] === 'object' ? { ...back[sectionKey] } : ({} as Record<string, string>);
              back[sectionKey] = { ...existing, Image: imageUrl || '' } as (typeof back)[typeof sectionKey];
              updatedIdCardData = { ...updatedIdCardData, Card_Back: back };
              console.log(`✅ ${section} image uploaded:`, imageUrl);
            } catch (error) {
              console.error(`❌ Failed to upload ${section} image:`, error);
              uploadFailures.push(`Card Back ${section} (${file.name})`);
              // Continue with other uploads even if one fails
            }
          }
        }
      }

      // Handle Plan Details header logo upload
      let updatedPlanDetailsData = productData.planDetailsData;
      if (productData.planDetailsHeaderLogoFile) {
        try {
          console.log('📸 Uploading Plan Details header logo:', productData.planDetailsHeaderLogoFile.name, 'Size:', productData.planDetailsHeaderLogoFile.size);
          const planHeaderLogoUrl = await handleFileUpload(productData.planDetailsHeaderLogoFile, 'logos');
          
          // Update the plan details data with the uploaded logo URL
          if (updatedPlanDetailsData?.Plan_Data?.Header) {
            updatedPlanDetailsData = {
              ...productData.planDetailsData,
              Plan_Data: {
                ...productData.planDetailsData.Plan_Data,
                Header: {
                  ...productData.planDetailsData.Plan_Data.Header,
                  Image: planHeaderLogoUrl || ''
                }
              }
            };
          }
          console.log('✅ Plan Details header logo uploaded:', planHeaderLogoUrl);
        } catch (error) {
          console.error('❌ Plan Details header logo upload failed:', error);
          uploadFailures.push(`Plan Details Logo (${productData.planDetailsHeaderLogoFile.name})`);
          // Continue without the logo - product will still be saved
        }
      }

      // Validate ProductId is a valid GUID before using it
      const isValidGuid = (id: string | undefined): boolean => {
        if (!id) return false;
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return guidRegex.test(id);
      };
      
      // CRITICAL: AI-generated products should NEVER have a valid ProductId - if editingProduct has lowercase properties (name, vendorId),
      // it's AI-generated and should be treated as a NEW product, even if it has an invalid ProductId field
      const isAIGenerated = editingProduct && ((editingProduct as any).name || (editingProduct as any).vendorId) && !editingProduct.Name;
      
      // Only treat as existing product if it's NOT AI-generated AND has a valid ProductId GUID
      const isExistingProduct = !isAIGenerated && editingProduct && editingProduct.ProductId && isValidGuid(editingProduct.ProductId);

      const apiProductData: ApiProductData = {
        // Copy all properties except file objects
        vendorId: productData.vendorId,
        isVendorPricing: productData.isVendorPricing,
        vendorCommission: productData.vendorCommission,
        vendorGroupIdProductType: productData.vendorGroupIdProductType,
        eligibilityIndividualVendorGroupId: productData.eligibilityIndividualVendorGroupId ?? '',
        eligibilityVendorGroupFallbackProductId: productData.eligibilityVendorGroupFallbackProductId ?? '',
        planId: productData.planId ?? '',
        name: productData.name,
        description: productData.description,
        productType: productData.productType,
        productOwnerId: productData.productOwnerId,
        salesType: productData.salesType,
        minAge: productData.minAge,
        maxAge: productData.maxAge,
        allowedStates: productData.allowedStates,
        requiresTobaccoInfo: productData.requiresTobaccoInfo,
        effectiveDateLogic: productData.effectiveDateLogic,
        maxEffectiveDateDays: productData.maxEffectiveDateDays,
        terminationLogic: productData.terminationLogic,
        requiredLicenses: productData.requiredLicenses,
        isPublic: productData.isPublic,  // Include isPublic field
        isHidden: productData.isHidden || false,  // Include isHidden field
        configurationFields: productData.configurationFields,
        pricingTiers: productData.pricingTiers,
        acknowledgementQuestions: productData.acknowledgementQuestions,
        productQuestionnaires: productData.productQuestionnaires || undefined,
        idCardData: updatedIdCardData,  // Use the updated ID card data with logo URL
        idCardMemberIdPrefixMask: productData.idCardMemberIdPrefixMask ?? '',
        showGroupIdOnIDCard: productData.showGroupIdOnIDCard === true,
        planDetailsData: updatedPlanDetailsData,  // Use the updated plan details data with logo URL
        aiChunks: productData.aiChunks,
        requiredASA: productData.requiredASA,  // Include RequiredASA data
        trainingConfig: productData.trainingConfig,  // Training (agent/member) config
        medicalNeedsLinksConfig: productData.medicalNeedsLinksConfig,
        isSSNRequired: productData.isSSNRequired || false,  // Include isSSNRequired field
        premiumReportingCategory:
          productData.premiumReportingCategory === 'NonProfit' ? 'NonProfit' : 'ForProfit',
        includeProcessingFee: productData.includeProcessingFee === true,
        roundUpProcessingFee: productData.roundUpProcessingFee !== false,
        processingFeePercentage: productData.processingFeePercentage ?? null,
        // Include deletion flags
        deleteProductImage: productData.deleteProductImage,
        deleteProductLogo: productData.deleteProductLogo,
        deleteProductDocument: productData.deleteProductDocument,
        ...(productImageUrl !== undefined && { productImageUrl }),
        ...(productLogoUrl !== undefined && { productLogoUrl }),
        ...(productDocumentUrl !== undefined && { productDocumentUrl }),
        ...(productDocuments.length > 0 && { productDocuments }),
      };

      const token = localStorage.getItem('accessToken');
      const baseUrl = process.env.NODE_ENV === 'development' 
        ? API_CONFIG.BASE_URL 
        : API_CONFIG.BASE_URL;
      
      console.log('📮 Making API call to:', isExistingProduct ? 'UPDATE' : 'CREATE');

      const endpoint = isExistingProduct 
        ? `/api/products/${editingProduct.ProductId}`
        : '/api/products';
      
      const method = isExistingProduct ? 'PUT' : 'POST';

      const response = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(apiProductData)
      });

      console.log('📬 Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Response error:', errorText);
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      console.log('✅ Response result:', result);

      if (result.success) {
        console.log('🎉 Product saved successfully:', result.productId || result.product?.ProductId);
        
        // Close the wizard
        setShowAddProduct(false);
        setEditingProduct(null);
        
        // Refresh the product list
        await fetchMarketplaceProducts();
        
        // Show success notification - with warning if any uploads failed
        if (uploadFailures.length > 0) {
          const failedFiles = uploadFailures.join(', ');
          showNotification(
            isExistingProduct 
              ? `Product updated successfully, but ${uploadFailures.length} file(s) failed to upload: ${failedFiles}. You can edit the product to retry uploading these files.`
              : `Product created successfully, but ${uploadFailures.length} file(s) failed to upload: ${failedFiles}. You can edit the product to retry uploading these files.`,
            'warning',
            isExistingProduct ? 'Product Updated (with warnings)' : 'Product Created (with warnings)'
          );
        } else {
          showNotification(
            isExistingProduct ? 'Product updated successfully!' : 'Product created successfully!',
            'success',
            isExistingProduct ? 'Product Updated' : 'Product Created'
          );
        }
        
      } else {
        throw new Error(result.message || 'Failed to save product');
      }

    } catch (error) {
      console.error('❌ Error saving product:', error);
      showNotification(`Error saving product: ${getErrorMessage(error)}`, 'error', 'Error');
    }
  };

  // FIXED: Handle Edit Product with debugging
  const handleEditProduct = (product: Product) => {
    console.log('🔧 Edit Product clicked:', {
      productId: product.ProductId,
      productName: product.Name,
      productType: product.ProductType,
      hasImageUrl: !!product.ProductImageUrl,
      hasLogoUrl: !!product.ProductLogoUrl,
      hasDocumentUrl: !!product.ProductDocumentUrl,
      isBundle: product.IsBundle,
      productOwner: product.ProductOwnerName
    });
    
    // Check if this is a bundle and open appropriate wizard
    if (product.IsBundle) {
      setEditingBundle(product);
      setShowAddBundle(true);
    } else {
      setEditingProduct(product);
      setShowAddProduct(true);
    }
  };

  // Handle Close Wizard
  const handleCloseWizard = () => {
    setShowAddProduct(false);
    setEditingProduct(null);
  };

  // Handle Save Bundle
  const handleSaveBundle = async (bundleData: BundleFormData) => {
    try {
      console.log('📦 Frontend processing bundle data:', {
        name: bundleData.name,
        bundleProductsCount: bundleData.bundleProducts.length,
        editMode: !!editingBundle
      });
      
      // Handle logo URL - accept pre-uploaded URLs or upload new files if provided
      let productLogoUrl: string | undefined = bundleData.productLogoUrl ?? undefined;

      if (!productLogoUrl && bundleData.productLogoFile) {
        productLogoUrl = await handleFileUpload(bundleData.productLogoFile, 'logos');
      }

      // Upload pending bundle-level documents and merge with existing ones.
      // Backend (products.js) writes rows into oe.ProductDocuments and queues
      // AI extraction regardless of whether the ProductId belongs to a bundle.
      const uploadedNewDocuments: { documentUrl: string; displayName: string; sortOrder: number }[] = [];
      const pendingBundleDocs = bundleData.productDocumentFiles || [];
      for (let i = 0; i < pendingBundleDocs.length; i++) {
        const item = pendingBundleDocs[i];
        if (!item?.file || !(item.file instanceof File)) continue;
        try {
          const fd = new FormData();
          fd.append('file', item.file);
          fd.append('type', 'documents');
          fd.append('entityId', editingBundle?.ProductId || 'new');
          fd.append('category', 'product');
          const uploadResponse = await apiCall('/api/uploads', {
            method: 'POST',
            body: fd,
          });
          if (uploadResponse?.success) {
            const url = (uploadResponse as any).url
              || (Array.isArray(uploadResponse.data) ? uploadResponse.data[0]?.url : uploadResponse.data?.url);
            if (url) {
              uploadedNewDocuments.push({
                documentUrl: url,
                displayName: item.displayName?.trim() || item.file.name || 'Document',
                sortOrder: (bundleData.productDocuments?.length ?? 0) + i,
              });
            }
          }
        } catch (err) {
          console.error('Error uploading bundle document:', err);
        }
      }
      const existingBundleDocs = (bundleData.productDocuments || []).filter((d: any) => d?.documentUrl);
      const mergedBundleDocuments = (existingBundleDocs.length > 0 || uploadedNewDocuments.length > 0)
        ? [...existingBundleDocs, ...uploadedNewDocuments].map((d: any, i: number) => ({
            ...(d.productDocumentId ? { productDocumentId: d.productDocumentId } : {}),
            documentUrl: d.documentUrl,
            displayName: d.displayName || 'Document',
            sortOrder: i,
          }))
        : undefined;

      // Prepare the simplified bundle data for API
      const bundlePayload = {
        name: bundleData.name,
        description: bundleData.description,
        productType: 'Bundle',
        isBundle: true,
        isPublic: bundleData.isPublic,  // Include isPublic field for global marketplace
        isHidden: bundleData.isHidden || false,  // Hide from agents, enrollment links, and groups
        // Preserve existing fields when editing, use defaults for new bundles
        productOwnerId: bundleData.productOwnerId || editingBundle?.ProductOwnerId || '1CD92AF7-B6F2-4E48-A8F3-EC6316158826',
        isVendorPricing: editingBundle?.IsVendorPrice || false,
        vendorCommission: editingBundle?.VendorCommission || 0,
        salesType: bundleData.salesType || editingBundle?.SalesType || 'Both',
        minAge: editingBundle?.MinAge || 18,
        maxAge: editingBundle?.MaxAge || 65,
        allowedStates: editingBundle?.AllowedStates || [],
        requiresTobaccoInfo: editingBundle?.RequiresTobaccoInfo || false,
        effectiveDateLogic: (editingBundle?.EffectiveDateLogic === 'SelectedDay' ? 'SameDay' : editingBundle?.EffectiveDateLogic) || 'FirstOfMonth',
        maxEffectiveDateDays: editingBundle?.MaxEffectiveDateDays || 60,
        terminationLogic: editingBundle?.TerminationLogic || '',
        requiredLicenses: editingBundle?.RequiredLicenses || [],
        bundleProducts: bundleData.bundleProducts.map((bp: any) => ({
          productId: bp.productId,
          isRequired: bp.isRequired || true,
          sortOrder: bp.sortOrder || 1,
          hidePricing: !!bp.hidePricing,
          linkedToProductId: bp.hidePricing ? bp.linkedToProductId || null : null,
          allowedConfigOptions: bp.allowedConfigOptions && Object.keys(bp.allowedConfigOptions).length > 0 ? bp.allowedConfigOptions : undefined
        })),
        ...(productLogoUrl && { productLogoUrl }),
        ...(mergedBundleDocuments !== undefined && { productDocuments: mergedBundleDocuments }),
      };

      console.log('📤 Sending bundle data to API:', bundlePayload);

      // Call the API using the authenticated apiCall helper
      const endpoint = editingBundle ? `/api/products/${editingBundle.ProductId}` : '/api/products';
      const response = await apiCall(endpoint, {
        method: editingBundle ? 'PUT' : 'POST',
        body: JSON.stringify(bundlePayload),
      });

      if (response.success) {
        console.log('🎉 Bundle saved successfully:', response.productId || response.product?.ProductId);
        
        // Close the wizard
        setShowAddBundle(false);
        setEditingBundle(null);
        
        // Refresh the product list
        await fetchMarketplaceProducts();
        
        // Show success notification
        showNotification(
          editingBundle ? 'Bundle updated successfully!' : 'Bundle created successfully!',
          'success',
          editingBundle ? 'Bundle Updated' : 'Bundle Created'
        );
        
      } else {
        throw new Error(response.message || 'Failed to save bundle');
      }

    } catch (error) {
      console.error('❌ Error saving bundle:', error);
      showNotification(`Error saving bundle: ${getErrorMessage(error)}`, 'error', 'Error');
    }
  };

  // Handle product/bundle delete
  const handleDeleteProduct = async (product: Product) => {
    try {
      console.log('🗑️ Deleting product:', product.Name);
      
      const response = await apiCall(`/api/products/${product.ProductId}`, {
        method: 'DELETE'
      });
      
      if (response.success) {
        console.log('✅ Product deleted successfully');
        
        // Show success notification
        showNotification(
          `${product.Name} has been deleted successfully.`,
          'success',
          'Product Deleted'
        );
        
        // Close modal and refresh data
        setShowDeleteConfirm(false);
        setProductToDelete(null);
        setShowDetailsModal(false);
        setDetailsModalProduct(null);
        await fetchMarketplaceProducts();
      } else {
        throw new Error(response.message || 'Failed to delete product');
      }
      
    } catch (error) {
      console.error('❌ Error deleting product:', error);
      showNotification(
        `Failed to delete product: ${getErrorMessage(error)}`,
        'error',
        'Delete Failed'
      );
    }
  };

  // Handle AI Product Creator success
  const handleAISuccess = (productData: ProductFormData) => {
    console.log('🤖 AI Generated Product Data:', productData);
    setShowAICreator(false);
    // Set AI data as editingProduct so wizard receives it
    setEditingProduct(productData as any);
    setShowAddProduct(true);
  };

  useEffect(() => {
    fetchMarketplaceProducts();
  }, [filters]); // Re-fetch when filters change

  useEffect(() => {
    fetchProductOwners();
    fetchVendors();
  }, []);

  const handleFilterChange = (key: keyof FilterState, value: string | string[]): void => {
    setFilters(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const handleLogout = () => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    window.location.href = '/login';
  };

  const handleSearch = (query: string) => {
    handleFilterChange('search', query);
  };

  const filteredProducts = products.filter(product => {
    if (filters.search && !product.Name.toLowerCase().includes(filters.search.toLowerCase()) &&
        !product.Description.toLowerCase().includes(filters.search.toLowerCase())) {
      return false;
    }
    if (filters.productType && filters.productType === 'Bundles') {
      // Special handling for bundles filter
      if (!product.IsBundle) {
        return false;
      }
    } else if (filters.productType && product.ProductType !== filters.productType) {
      return false;
    }
    if (filters.salesType && product.SalesType !== filters.salesType && product.SalesType !== 'Both') {
      return false;
    }
    if (
      filters.productOwner &&
      product.ProductOwnerId !== filters.productOwner &&
      product.ProductOwnerName !== filters.productOwner
    ) {
      return false;
    }
    if (selectedVendor && product.VendorId !== selectedVendor) {
      return false;
    }
    return true;
  });

  const [productsPerPage, setProductsPerPage] = useState<number>(10);
  const [currentPage, setCurrentPage] = useState<number>(1);

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / productsPerPage));

  useEffect(() => {
    setCurrentPage(1);
  }, [filters, productsPerPage]);

  const paginatedProducts = filteredProducts.slice(
    (currentPage - 1) * productsPerPage,
    currentPage * productsPerPage
  );

  const handleProductsPerPageChange = (value: string) => {
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      setProductsPerPage(parsed);
    }
  };

  const handlePageChange = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  // FIXED: Product Card Component with proper image error handling
  const ProductCard: React.FC<{ product: Product }> = ({ product }) => {
    const [imageError, setImageError] = useState(false);

    return (
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-all duration-300 hover:shadow-xl hover:-translate-y-1 flex flex-col h-full">
        <div className="relative w-full h-48 bg-gray-50 flex items-center justify-center overflow-hidden rounded-t-lg p-4">
          {/* FIXED: Better image handling with logo fallback */}
          {product.ProductImageUrl && !imageError ? (
            <img 
              src={product.ProductImageUrl} 
              alt={product.Name}
              className="max-w-full max-h-full object-contain transition-transform duration-300 group-hover:scale-105"
              onError={() => {
                console.log('❌ Product image failed to load:', product.ProductImageUrl);
                setImageError(true);
              }}
              onLoad={() => {
                console.log('✅ Product image loaded successfully:', product.ProductImageUrl);
              }}
            />
          ) : product.ProductLogoUrl ? (
            // Show product logo as main image if no product image
            <div className="w-full h-full flex items-center justify-center bg-white rounded p-4">
              <img 
                src={product.ProductLogoUrl} 
                alt={`${product.Name} logo`}
                className="max-w-full max-h-full object-contain"
                onError={() => {
                  console.log('❌ Product logo failed to load:', product.ProductLogoUrl);
                  setImageError(true);
                }}
                onLoad={() => {
                  console.log('✅ Product logo loaded successfully:', product.ProductLogoUrl);
                }}
              />
            </div>
          ) : (
            // FIXED: Use inline SVG instead of external URL
            <div className="w-full h-full flex items-center justify-center bg-gray-100 rounded">
              <div className="text-center">
                <svg width="64" height="64" viewBox="0 0 64 64" className="mx-auto mb-2 text-gray-400">
                  <rect width="64" height="64" fill="#e5e7eb"/>
                  <rect x="12" y="12" width="40" height="40" fill="none" stroke="#9ca3af" strokeWidth="2" rx="4"/>
                  <circle cx="22" cy="22" r="3" fill="#9ca3af"/>
                  <path d="M52 44l-12-12-8 8-8-8-12 12v4a4 4 0 004 4h32a4 4 0 004-4v-4z" fill="#9ca3af"/>
                </svg>
                <p className="text-sm text-gray-500">No Image</p>
              </div>
            </div>
          )}
          
        </div>
        
        <div className="flex flex-col flex-1 p-4">
          <h3 className="text-lg font-bold text-gray-900 line-clamp-2 mb-1 group-hover:text-oe-primary transition-colors">
            {product.Name}
          </h3>

          {product.ProductOwnerName && (
            <div className="flex items-center gap-1.5 mb-3 text-sm text-gray-600">
              <Building size={14} className="text-oe-primary flex-shrink-0" />
              <span className="truncate">{product.ProductOwnerName}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 mb-3">
            {!!product.IsBundle && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                Bundle
              </span>
            )}

            {(product.IsHidden === true || product.IsHidden === 1) && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                <EyeOff size={12} className="mr-1" />
                Hidden
              </span>
            )}

            {product.IsSubscribed === true && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                Subscribed
              </span>
            )}

            {product.SubscriptionStatus === 'Pending' && product.IsSubscribed !== true && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                Pending
              </span>
            )}

            {product.ProductType && product.ProductType !== 'Bundle' && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                {product.ProductType}
              </span>
            )}

            {product.SalesType && (
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                product.SalesType === 'Individual' 
                  ? 'bg-indigo-100 text-indigo-800' 
                  : product.SalesType === 'Group'
                  ? 'bg-orange-100 text-orange-800'
                  : 'bg-teal-100 text-teal-800'
              }`}>
                {product.SalesType === 'Individual' ? (
                  <>
                    <User size={12} className="mr-1" />
                    Individual
                  </>
                ) : product.SalesType === 'Group' ? (
                  <>
                    <Users size={12} className="mr-1" />
                    Group
                  </>
                ) : (
                  <>
                    <Users size={12} className="mr-1" />
                    Both
                  </>
                )}
              </span>
            )}
          </div>

          {/* Logo removed */}

          <p className="text-gray-600 text-sm mb-4 line-clamp-2">{product.Description}</p>
          
          {/* Bundle Products Display - List line by line */}
          {product.IsBundle && (
            <div className="mb-4">
              <div className="text-xs font-medium text-gray-700 mb-2 flex items-center">
                <Package size={12} className="mr-2 flex-shrink-0 text-oe-primary" />
                Included Products:
              </div>
              {product.BundleProducts && product.BundleProducts.trim() ? (
                <div className="space-y-1 pl-4">
                  {product.BundleProducts.split(',').map((productName, index) => (
                    <div key={index} className="text-xs text-gray-600 flex items-center">
                      <div className="h-1.5 w-1.5 bg-gray-400 rounded-full mr-2"></div>
                      <span>{productName.trim()}</span>
                      {product.VendorName && (
                        <span className="text-gray-500 ml-2">({product.VendorName})</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-gray-500 pl-4">No products configured</div>
              )}
            </div>
          )}
          
          <div className="space-y-2 mb-4 flex-1">
            {product.VendorName && (
              <div className="flex items-center text-xs text-gray-500">
                <Package size={12} className="mr-2 flex-shrink-0 text-oe-primary" />
                <span className="truncate">Vendor: <span className="font-medium">{product.VendorName}</span></span>
              </div>
            )}
            
            <div className="flex items-center text-xs text-gray-500">
              <Users size={12} className="mr-2 flex-shrink-0 text-oe-primary" />
              <span><span className="font-semibold text-oe-primary">{product.ActiveSubscribers}</span> Active Subscribers</span>
            </div>
            
            {product.RequiredLicenses && Array.isArray(product.RequiredLicenses) && product.RequiredLicenses.length > 0 && (
              <div className="flex items-center text-xs text-gray-500">
                <Shield size={12} className="mr-2 flex-shrink-0 text-oe-primary" />
                <span className="truncate">Requires: <span className="font-medium">{safeJoinArray(product.RequiredLicenses)}</span> License</span>
              </div>
            )}
          </div>
          
          {/* Button container */}
          <div className="flex gap-2 mt-auto">
            <button 
              onClick={() => void handleViewDetails(product)}
              className="flex-1 px-3 py-2 bg-oe-primary text-white rounded-lg font-medium hover:bg-oe-primary-dark transition-colors shadow-sm flex items-center justify-center text-sm"
            >
              <Eye size={14} className="mr-1.5 flex-shrink-0" />
              <span className="truncate">View Details</span>
            </button>
            
            {canEditProducts && (
              <>
                {!product.IsBundle && (
                  <button
                    onClick={() => { setApiConfigProduct(product); setShowAPIConfigModal(true); }}
                    className="p-2 text-purple-600 rounded-lg font-medium hover:bg-purple-50 transition-colors border border-purple-300"
                    title="API configuration"
                  >
                    <Webhook size={14} />
                  </button>
                )}
                <button 
                  onClick={() => handleEditProduct(product)}
                  className="p-2 bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 transition-colors border border-gray-300"
                  title="Edit Product"
                >
                  <Edit size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => openDuplicateModal(product)}
                  className="p-2 bg-white text-oe-primary rounded-lg font-medium hover:bg-oe-light transition-colors border border-oe-primary"
                  title="Duplicate into another tenant"
                >
                  <Copy size={14} />
                </button>
              </>
            )}
            
            {product.SubscriptionStatus === 'Pending' && (
              <button 
                disabled
                className="px-3 py-2 bg-yellow-500 text-white rounded-lg font-medium hover:bg-yellow-600 transition-colors shadow-sm text-sm opacity-75 cursor-not-allowed"
              >
                Pending
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // FIXED: Product List Item Component with proper image error handling
  const ProductListItem: React.FC<{ product: Product }> = ({ product }) => {
    const [imageError, setImageError] = useState(false);
    
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm hover:shadow-md transition-shadow hover:shadow-lg transition-all duration-200">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4 flex-1 min-w-0">
            <div className="w-16 h-16 flex-shrink-0 rounded-lg overflow-hidden bg-gray-50 flex items-center justify-center p-2">
              {/* FIXED: Proper image error handling with logo fallback */}
              {product.ProductImageUrl && !imageError ? (
                <img 
                  src={product.ProductImageUrl} 
                  alt={product.Name}
                  className="max-w-full max-h-full object-contain"
                  onError={() => {
                    console.log('❌ Product image failed to load:', product.ProductImageUrl);
                    setImageError(true);
                  }}
                />
              ) : product.ProductLogoUrl ? (
                // Show product logo as main image if no product image
                <img 
                  src={product.ProductLogoUrl} 
                  alt={`${product.Name} logo`}
                  className="max-w-full max-h-full object-contain bg-white rounded p-1"
                  onError={() => {
                    console.log('❌ Product logo failed to load:', product.ProductLogoUrl);
                    setImageError(true);
                  }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-gray-100 rounded">
                  <svg width="32" height="32" viewBox="0 0 32 32" className="text-gray-400">
                    <rect width="32" height="32" fill="#e5e7eb"/>
                    <rect x="6" y="6" width="20" height="20" fill="none" stroke="#9ca3af" strokeWidth="1" rx="2"/>
                    <circle cx="11" cy="11" r="1.5" fill="#9ca3af"/>
                    <path d="M26 22l-6-6-4 4-4-4-6 6v2a2 2 0 002 2h16a2 2 0 002-2v-2z" fill="#9ca3af"/>
                  </svg>
                </div>
              )}
            </div>
            
            <div className="flex-1 min-w-0">
              <div className="flex items-start gap-3 mb-2">
                {/* Product Logo */}
                {product.ProductLogoUrl && (
                  <div className="w-6 h-6 flex-shrink-0">
                    <img 
                      src={product.ProductLogoUrl} 
                      alt={`${product.Name} logo`}
                      className="w-full h-full rounded object-contain bg-white p-0.5 border border-gray-200"
                      onError={(e) => {
                        console.log('❌ Product logo failed to load:', product.ProductLogoUrl);
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-bold text-gray-900 truncate hover:text-oe-primary transition-colors">
                    {product.Name}
                  </h3>
                  {product.ProductOwnerName && (
                    <p className="text-sm text-gray-500 truncate flex items-center gap-1.5 mt-0.5">
                      <Building size={14} className="text-oe-primary flex-shrink-0" />
                      <span className="truncate">{product.ProductOwnerName}</span>
                    </p>
                  )}
                </div>
                
                <div className="flex gap-2 flex-shrink-0">
                  {product.IsBundle && (
                    <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-gray-100 text-gray-800">
                      Bundle
                    </span>
                  )}
                  {product.IsSubscribed && (
                    <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-green-100 text-green-800">
                      Subscribed
                    </span>
                  )}
                  {product.SalesType && (
                    <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium ${
                      product.SalesType === 'Individual' 
                        ? 'bg-indigo-100 text-indigo-800' 
                        : product.SalesType === 'Group'
                        ? 'bg-orange-100 text-orange-800'
                        : 'bg-teal-100 text-teal-800'
                    }`}>
                      {product.SalesType === 'Individual' ? (
                        <>
                          <User size={12} className="mr-1" />
                          Individual
                        </>
                      ) : product.SalesType === 'Group' ? (
                        <>
                          <Users size={12} className="mr-1" />
                          Group
                        </>
                      ) : (
                        <>
                          <Users size={12} className="mr-1" />
                          Both
                        </>
                      )}
                    </span>
                  )}
                </div>
              </div>
              
              <p className="text-gray-600 text-sm mb-3 line-clamp-2">{product.Description}</p>
              
              {/* Bundle Products Display - List line by line */}
              {product.IsBundle && product.BundleProducts && product.BundleProducts.trim() && (
                <div className="mb-3">
                  <div className="text-xs font-medium text-gray-700 mb-1 flex items-center">
                    <Package size={12} className="mr-1.5 text-oe-primary" />
                    Included Products:
                  </div>
                  <div className="space-y-0.5 pl-4">
                    {product.BundleProducts.split(',').map((productName, index) => (
                      <div key={index} className="text-xs text-gray-600 flex items-center">
                        <div className="h-1 w-1 bg-gray-400 rounded-full mr-1.5"></div>
                        <span>{productName.trim()}</span>
                        {product.VendorName && (
                          <span className="text-gray-500 ml-1.5">({product.VendorName})</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              <div className="flex items-center gap-6 text-xs text-gray-500 flex-wrap">
                {product.VendorName && (
                  <div className="flex items-center">
                    <Package size={12} className="mr-1 text-oe-primary" />
                    <span>Vendor: <span className="font-medium">{product.VendorName}</span></span>
                  </div>
                )}
                <div className="flex items-center">
                  <Users size={12} className="mr-1 text-oe-primary" />
                  <span><span className="font-semibold text-oe-primary">{product.ActiveSubscribers}</span> Subscribers</span>
                </div>
                {product.RequiredLicenses && Array.isArray(product.RequiredLicenses) && product.RequiredLicenses.length > 0 && (
                  <div className="flex items-center">
                    <Shield size={12} className="mr-1 text-oe-primary" />
                    <span className="truncate font-medium">{safeJoinArray(product.RequiredLicenses)}</span>
                  </div>
                )}
                {product.ProductType && product.ProductType !== 'Bundle' && (
                  <div className="flex items-center">
                    <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-oe-primary text-white text-xs">{product.ProductType}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
          
          <div className="flex gap-2 flex-shrink-0">
            <button 
              onClick={() => void handleViewDetails(product)}
              className="px-4 py-2 bg-oe-primary text-white rounded-lg font-medium hover:bg-oe-primary-dark transition-colors shadow-sm flex items-center text-sm"
            >
              <Eye size={14} className="mr-1" />
              <span className="hidden sm:inline">Details</span>
            </button>
            
            {canEditProducts && (
              <>
                {!product.IsBundle && (
                  <button
                    onClick={() => { setApiConfigProduct(product); setShowAPIConfigModal(true); }}
                    className="px-4 py-2 text-purple-600 rounded-lg font-medium hover:bg-purple-50 transition-colors border border-purple-300 flex items-center"
                    title="API configuration"
                  >
                    <Webhook size={14} className="mr-1" />
                    API
                  </button>
                )}
                <button 
                  onClick={() => handleEditProduct(product)}
                  className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 transition-colors border border-gray-300 p-2"
                  title="Edit Product"
                >
                  <Edit size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => openDuplicateModal(product)}
                  className="px-4 py-2 bg-white text-oe-primary rounded-lg font-medium hover:bg-oe-light transition-colors border border-oe-primary flex items-center"
                  title="Duplicate into another tenant"
                >
                  <Copy size={14} className="mr-1" />
                  <span className="hidden sm:inline">Duplicate</span>
                </button>
              </>
            )}
            
            {product.SubscriptionStatus === 'Pending' && (
              <button 
                disabled
                className="px-4 py-2 bg-yellow-500 text-white rounded-lg font-medium hover:bg-yellow-600 transition-colors shadow-sm text-sm opacity-75 cursor-not-allowed"
              >
                Pending
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Admin Navigation Sidebar */}
      {/* <AdminNavigation 
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        onLogout={handleLogout}
      /> */}

      {/* Main Content with Header */}
      <div className="flex-1 flex flex-col">
        {/* Shared Header */}
        <SharedHeader 
          title="Product Marketplace"
          onSearch={handleSearch}
          searchValue={filters.search}
          showSearch={true}
          showNotifications={true}
        />
        
        {/* Marketplace Content */}
        <div className="flex-1 overflow-auto p-6">
          {/* Toolbar */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-2 transition-colors ${
                    viewMode === 'grid' 
                      ? 'bg-oe-primary text-white' 
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <Grid size={16} />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`p-2 transition-colors ${
                    viewMode === 'list' 
                      ? 'bg-oe-primary text-white' 
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <List size={16} />
                </button>
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              <button 
                  onClick={() => setShowAICreator(true)}
                className="px-4 py-2 bg-gradient-to-r from-oe-primary to-oe-primary-dark text-white rounded-lg font-medium hover:from-oe-primary-dark hover:to-oe-primary transition-colors shadow-sm flex items-center"
              >
                <Sparkles size={16} className="mr-2" />
                Create with AI
              </button>
              <button 
                onClick={() => setShowAddProduct(true)}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg font-medium hover:bg-oe-primary-dark transition-colors shadow-sm flex items-center"
              >
                <Plus size={16} className="mr-2" />
                Add Product
              </button>
              <button 
                onClick={() => setShowAddBundle(true)}
                className="px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors shadow-sm flex items-center"
              >
                <Package size={16} className="mr-2" />
                New Product Bundle
              </button>
            </div>
          </div>

          {/* Filters Panel - Always Visible */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm hover:shadow-md transition-shadow mb-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Product Type</label>
                <select
                  value={filters.productType}
                  onChange={(e) => handleFilterChange('productType', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="">All Types</option>
                  <option value="Healthcare">Healthcare</option>
                  <option value="Dental">Dental</option>
                  <option value="Vision">Vision</option>
                  <option value="Life Insurance">Life Insurance</option>
                  <option value="Disability">Disability</option>
                  <option value="Accident">Accident</option>
                  <option value="Critical Illness">Critical Illness</option>
                  <option value="Hospital Indemnity">Hospital Indemnity</option>
                  <option value="Bundles">Bundles</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Sales Type</label>
                <select
                  value={filters.salesType}
                  onChange={(e) => handleFilterChange('salesType', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="">Group & Individual</option>
                  <option value="Individual">Individual Only</option>
                  <option value="Group">Group Only</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vendor</label>
                <select
                  value={selectedVendor}
                  onChange={(e) => setSelectedVendor(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="">All Vendors</option>
                  {vendors.map((vendor) => (
                    <option key={vendor.Id} value={vendor.Id}>
                      {vendor.VendorName}
                    </option>
                  ))}
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Product Owner</label>
                <select
                  value={filters.productOwner}
                  onChange={(e) => handleFilterChange('productOwner', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="">All Owners</option>
                  {productOwners.map((owner) => (
                    <option key={owner.ProductOwnerId} value={owner.ProductOwnerId}>
                      {owner.Name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
            <div className="text-sm text-gray-600">
              Showing {filteredProducts.length === 0 ? 0 : (currentPage - 1) * productsPerPage + 1}-
              {Math.min(currentPage * productsPerPage, filteredProducts.length)} of {filteredProducts.length} products
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">Show</span>
              <select
                value={productsPerPage}
                onChange={(e) => handleProductsPerPageChange(e.target.value)}
                className="border border-gray-300 rounded-md text-sm px-2 py-1 focus:outline-none focus:ring-2 focus:ring-oe-primary"
              >
                {[10, 25, 50].map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <span className="text-sm text-gray-600">per page</span>
            </div>
          </div>

          {/* Products Display */}
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mb-4"></div>
                <div className="text-lg text-gray-600 font-medium">Loading products...</div>
              </div>
            </div>
          ) : (
            <div className={
              viewMode === 'grid' 
                ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6"
                : "space-y-4"
            }>
              {paginatedProducts.map((product) => (
                viewMode === 'grid' 
                  ? <ProductCard key={product.ProductId} product={product} />
                  : <ProductListItem key={product.ProductId} product={product} />
              ))}
            </div>
          )}

          {filteredProducts.length === 0 && !loading && (
            <div className="text-center py-8 bg-gray-50 rounded-lg">
              <ShoppingCart size={48} className="mx-auto text-gray-400 mb-4" />
              <h3 className="text-lg font-semibold text-gray-900 mb-2">No products found</h3>
              <p className="text-gray-600">Try adjusting your filters or search terms.</p>
              <button 
                onClick={() => setShowAddProduct(true)}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg font-medium hover:bg-oe-primary-dark transition-colors shadow-sm mt-4"
              >
                Add Your First Product
              </button>
            </div>
          )}

          {filteredProducts.length > 0 && (
            <div className="mt-6 flex flex-col items-center gap-3">
              <div className="text-sm text-gray-600">
                Page {currentPage} of {totalPages}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage === 1}
                  className={`px-3 py-1.5 rounded-md text-sm border border-gray-300 ${
                    currentPage === 1
                      ? 'text-gray-400 bg-gray-100 cursor-not-allowed'
                      : 'text-gray-700 bg-white hover:bg-gray-50'
                  }`}
                >
                  Previous
                </button>

                <div className="flex items-center gap-1 text-sm text-gray-600">
                    {Array.from({ length: totalPages }).map((_, index) => {
                    const pageNumber = index + 1;
                    const isActive = pageNumber === currentPage;
                    const showPage =
                      pageNumber === 1 ||
                      pageNumber === totalPages ||
                      Math.abs(pageNumber - currentPage) <= 1;

                    if (!showPage) {
                      if (
                        (pageNumber === currentPage - 2 && currentPage > 3) ||
                        (pageNumber === currentPage + 2 && currentPage < totalPages - 2)
                      ) {
                        return <span key={pageNumber}>...</span>;
                      }
                      return null;
                    }

                    return (
                      <button
                        key={pageNumber}
                        onClick={() => handlePageChange(pageNumber)}
                        className={`px-3 py-1.5 rounded-md border ${
                          isActive
                            ? 'border-blue-200 bg-blue-50 text-oe-primary-dark'
                            : 'border-gray-200 bg-white hover:bg-gray-50'
                        }`}
                      >
                        {pageNumber}
                      </button>
                    );
                  })}
                </div>

                <button
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  className={`px-3 py-1.5 rounded-md text-sm border border-gray-300 ${
                    currentPage === totalPages
                      ? 'text-gray-400 bg-gray-100 cursor-not-allowed'
                      : 'text-gray-700 bg-white hover:bg-gray-50'
                  }`}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showDetailsModal && detailsModalProduct && (
        <SubscribedProductDetailsModal
          key={(detailsModalProduct as { productId?: string }).productId}
          product={detailsModalProduct}
          onClose={() => {
            setShowDetailsModal(false);
            setDetailsModalProduct(null);
          }}
        />
      )}

      {/* AI Product Creator Modal */}
      <AIProductCreator
        isOpen={showAICreator}
        onClose={() => {
          setShowAICreator(false);
        }}
        onSuccess={handleAISuccess}
      />

      {/* Add/Edit Product Wizard */}
      <AddProductWizard
        isOpen={showAddProduct}
        onClose={handleCloseWizard}
        onSave={handleSaveProduct}
        editingProduct={editingProduct}
      />

      {/* Add/Edit Bundle Wizard */}
      <AddBundleWizard
        isOpen={showAddBundle}
        onClose={() => {
          setShowAddBundle(false);
          setEditingBundle(null);
        }}
        onSave={handleSaveBundle}
        editingBundle={editingBundle}
      />

      {/* Product API Config Modal */}
      {showAPIConfigModal && apiConfigProduct && (
        <ProductAPIConfigModal
          productId={apiConfigProduct.ProductId}
          productName={apiConfigProduct.Name}
          isOpen={showAPIConfigModal}
          onClose={() => { setShowAPIConfigModal(false); setApiConfigProduct(null); }}
          onSaved={() => fetchMarketplaceProducts()}
        />
      )}

      {/* Duplicate product into tenant (SysAdmin) */}
      {showDuplicateModal && duplicateModalProduct && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-md w-full shadow-2xl border border-gray-200">
            <div className="p-6 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Duplicate product</h3>
              <p className="text-sm text-gray-600 mt-1">
                Create a new product for the selected tenant with the same pricing, settings, and media URLs as{' '}
                <span className="font-medium text-gray-900">{duplicateModalProduct.Name}</span>.
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label htmlFor="duplicate-name" className="block text-sm font-medium text-gray-700 mb-1">
                  Product name
                </label>
                <input
                  id="duplicate-name"
                  type="text"
                  value={duplicateProductName}
                  onChange={(e) => setDuplicateProductName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary bg-white text-gray-900"
                  placeholder="Enter name for the duplicated product"
                />
              </div>
              <div>
                <label htmlFor="duplicate-tenant" className="block text-sm font-medium text-gray-700 mb-1">
                  Target tenant
                </label>
                <select
                  id="duplicate-tenant"
                  value={duplicateTargetTenantId}
                  onChange={(e) => setDuplicateTargetTenantId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary bg-white text-gray-900"
                >
                  <option value="">Select tenant…</option>
                  {tenantsForDuplicate.map((t) => (
                    <option key={t.TenantId} value={t.TenantId}>
                      {t.Name}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-xs text-gray-500">
                Images and documents keep the same blob URLs. Product overrides are not copied.
              </p>
            </div>
            <div className="p-6 border-t border-gray-200 flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => {
                  setShowDuplicateModal(false);
                  setDuplicateModalProduct(null);
                  setDuplicateTargetTenantId('');
                  setDuplicateProductName('');
                }}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50"
                disabled={duplicateSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDuplicateProduct()}
                disabled={!duplicateTargetTenantId || !duplicateProductName.trim() || duplicateSubmitting}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg font-medium hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {duplicateSubmitting ? 'Duplicating…' : 'Duplicate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && productToDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-md w-full shadow-2xl">
            <div className="p-6">
              <div className="flex items-center mb-4">
                <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center mr-4">
                  <X className="w-6 h-6 text-red-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Delete Product</h3>
                  <p className="text-sm text-gray-500">This action cannot be undone.</p>
                </div>
              </div>
              
              <div className="mb-6">
                <p className="text-gray-700">
                  Are you sure you want to delete <span className="font-semibold">"{productToDelete.Name}"</span>?
                </p>
                {productToDelete.IsBundle && (
                  <p className="text-sm text-amber-600 mt-2">
                    ⚠️ This is a bundle product. Deleting it will also remove all bundle configurations.
                  </p>
                )}
              </div>
              
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setProductToDelete(null);
                  }}
                  className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDeleteProduct(productToDelete)}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors"
                >
                  Delete Product
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MUI Snackbar for notifications */}
      <Snackbar
        open={notification.open}
        autoHideDuration={6000}
        onClose={handleCloseNotification}
        TransitionComponent={SlideTransition}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert 
          onClose={handleCloseNotification} 
          severity={notification.severity} 
          sx={{ 
            width: '100%',
            boxShadow: 3,
            '& .MuiAlert-icon': {
              fontSize: '1.5rem'
            }
          }}
          variant="filled"
          elevation={6}
        >
          {notification.title && <AlertTitle>{notification.title}</AlertTitle>}
          {notification.message}
        </Alert>
      </Snackbar>
    </div>
  );
};

export default ProductMarketplace;