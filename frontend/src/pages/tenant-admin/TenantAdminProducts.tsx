// File: frontend/src/pages/tenant-admin/TenantAdminProducts.tsx

import {
  AlertCircle,
  ArrowRightLeft,
  Building,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  DollarSign,
  Eye,
  EyeOff,
  Filter,
  LayoutGrid,
  Layers,
  List,
  Loader2,
  Package,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
  Trash2,
  User,
  Users,
  Webhook,
  X,
  XCircle
} from 'lucide-react';
import React, { Suspense, useEffect, useState } from 'react';
import AIProductCreator from '../../components/ai/AIProductCreator';
import AddBundleWizard from '../../components/forms/AddBundleWizard';
import ProductAPIConfigModal from '../../components/products/ProductAPIConfigModal';
import SubscribedProductDetailsModal from '../../components/products/SubscribedProductDetailsModal';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import type { ApiResponse } from '../../types/index';

// MUI Snackbar imports
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Slide, { SlideProps } from '@mui/material/Slide';
import Snackbar from '@mui/material/Snackbar';

/** Lazy-load keeps this heavy module off TenantAdminProducts’ initial graph and avoids Vite 6 soft-invalidation/HMR races. */
const AddProductWizard = React.lazy(() => import('../../components/forms/AddProductWizard'));
const ProductMigrationWizard = React.lazy(() => import('./wizards/ProductMigrationWizard'));

interface ProductOwner {
  tenantName: string;
  contactEmail?: string;
  contactPhone?: string;
  contactPerson?: string;
}

interface SystemFees {
  platformFee?: { name: string; amount: number; type: string };
  transactionFee?: { name: string; amount: number; type: string };
  processingFee?: { name: string; amount: number; type: string };
}

interface PricingTier {
  id: string;
  minAge: number;
  maxAge: number;
  tierType: string;
  tobaccoStatus: string;
  netRate: number;
  overrideRate: number;
  rate: number;
}

interface BundleProduct {
  productId: string;
  name: string;
  description?: string;
  productType: string;
  sortOrder: number;
  isRequired: boolean;
  // Optional subscription/config data when this bundle is subscribed
  subscriptionId?: string | null;
  subscriptionStatus?: string | null;
  tenantRate?: number;
  profitMargin?: number;
  systemFees?: SystemFees | null;
  setupFee?: number | null;
  isConfigured?: boolean;
  staticGroupId?: string | null;
  showGroupIdOnIDCard?: boolean;
  includeProcessingFee?: boolean;
  /** Set on oe.Products when product wizard bakes per-tier fees. */
  includeProcessingFeeFromProduct?: boolean;
  roundUpProcessingFee?: boolean;
  zeroFeeForACH?: boolean;
  customSystemFeeEnabled?: boolean;
  customSystemFeeAmount?: number | null;
}

interface SubscribedProduct {
  subscriptionId: string;
  productId: string;
  Name: string; // Changed from productName to match API response
  productType: string;
  description?: string;
  IsBundle?: boolean;
  salesType?: string;
  SalesType?: string;
  productImageUrl?: string;
  productLogoUrl?: string;
  productDocumentUrl?: string;
  basicPrice: number;
  productOwnerId?: string;
  productOwner: ProductOwner;
  subscriptionStatus: string;
  requestedDiscount?: number;
  approvedDiscount?: number;
  discountType?: 'percent' | 'flatRate' | 'tierBased';
  tierDiscounts?: { [key: string]: number };
  tenantRate: number;
  profitMargin?: number;
  systemFees?: SystemFees;
  salePrice?: number;
  setupFee?: number | null;
  requestMessage?: string;
  responseMessage?: string;
  requestDate?: string;
  responseDate?: string;
  isConfigured: boolean;
  status: string;
  allowedStates?: string[];
  pricingTiers?: PricingTier[];
  bundleProducts?: BundleProduct[];
  staticGroupId?: string;
  showGroupIdOnIDCard?: boolean;
  includeProcessingFee?: boolean;
  includeProcessingFeeFromProduct?: boolean;
  roundUpProcessingFee?: boolean;
  zeroFeeForACH?: boolean;
  customSystemFeeEnabled?: boolean;
  customSystemFeeAmount?: number | null;
  mustBeSoldWithProductIds?: string[];
  mustBeSoldWithProductNames?: string[];
}

interface MarketplaceProduct {
  productId: string;
  Name: string; // Changed from productName to match API response
  productType: string;
  description?: string;
  IsBundle?: boolean;
  salesType?: string;
  SalesType?: string;
  productImageUrl?: string;
  productLogoUrl?: string;
  productDocumentUrl?: string;
  basicPrice: number;
  productOwner: ProductOwner;
  status: string;
  allowedStates?: string[];
  pricingTiers?: PricingTier[];
  minAge?: number;
  maxAge?: number;
  bundleProducts?: BundleProduct[];
}

interface MyProduct {
  ProductId: string;
  Name: string;
  Description: string;
  ProductType: string;
  Status: string;
  IsBundle: boolean;
  IsHidden?: boolean | number;
  SalesType?: string;
  salesType?: string;
  ProductImageUrl?: string;
  ProductLogoUrl?: string;
  ProductDocumentUrl?: string;
  CreatedDate: string;
  ModifiedDate: string;
  SubscriptionCount: number;
}

interface ProductRequest {
  productId: string;
  discountType: 'percent' | 'flatRate' | 'tierBased';
  requestedDiscount?: number;
  tierDiscounts?: { [key: string]: number };
  message?: string;
  discountJustification?: string;
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

const TenantAdminProducts: React.FC = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'my-products' | 'marketplace'>('my-products');
  const [loading, setLoading] = useState(true);
  const [allProducts, setAllProducts] = useState<any[]>([]);
  const [marketplaceProducts, setMarketplaceProducts] = useState<MarketplaceProduct[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProductType, setSelectedProductType] = useState<string>('');
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  const [selectedSalesType, setSelectedSalesType] = useState<string>('');
  const [selectedVendor, setSelectedVendor] = useState<string>('');
  const [selectedIsHidden, setSelectedIsHidden] = useState<'all' | 'showHidden' | 'hideHidden'>('all');
  const [ownershipFilter, setOwnershipFilter] = useState<'all' | 'owned' | 'subscribed'>('all');
  const [productCategoryTab, setProductCategoryTab] = useState<'products' | 'bundles'>('products');
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showConfigureModal, setShowConfigureModal] = useState(false);
  const [showBundleConfigureModal, setShowBundleConfigureModal] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<MarketplaceProduct | null>(null);
  const [selectedSubscription, setSelectedSubscription] = useState<SubscribedProduct | null>(null);
  const [selectedBundleSubscription, setSelectedBundleSubscription] = useState<SubscribedProduct | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [showMigrateMembers, setShowMigrateMembers] = useState(false);
  const [editingProduct, setEditingProduct] = useState<MyProduct | null>(null);
  const [showAICreator, setShowAICreator] = useState(false);
  const [showAddBundle, setShowAddBundle] = useState(false);
  const [editingBundle, setEditingBundle] = useState<MyProduct | null>(null);
  const [bundleWizardCatalog, setBundleWizardCatalog] = useState<any[]>([]);
  const [bundleWizardCatalogLoading, setBundleWizardCatalogLoading] = useState(false);
  const [tenantMinimumSetupFee, setTenantMinimumSetupFee] = useState<number | null>(null);
  const [showAPIConfigModal, setShowAPIConfigModal] = useState(false);
  const [apiConfigProduct, setApiConfigProduct] = useState<any>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [productToDelete, setProductToDelete] = useState<any>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Snackbar notification state
  const [notification, setNotification] = useState<NotificationState>({
    open: false,
    message: '',
    severity: 'info'
  });

  // Show notification helper
  const showNotification = (message: string, severity: NotificationSeverity = 'info', title?: string) => {
    setNotification({
      open: true,
      message,
      severity,
      title
    });
  };

  // Handle close notification
  const handleCloseNotification = (_event?: React.SyntheticEvent | Event, reason?: string) => {
    if (reason === 'clickaway') {
      return;
    }
    setNotification(prev => ({ ...prev, open: false }));
  };

  // Get current tenant ID from user context (respects tenant switching)
  // Also check localStorage directly as fallback (in case user context hasn't loaded yet)
  const currentTenantId = user?.currentTenantId || user?.tenantId || localStorage.getItem('currentTenantId') || null;

  useEffect(() => {
    console.log('[TenantAdminProducts] useEffect triggered:', {
      activeTab,
      ownershipFilter,
      currentTenantId,
      userCurrentTenantId: user?.currentTenantId,
      userTenantId: user?.tenantId,
      localStorageTenantId: localStorage.getItem('currentTenantId')
    });
    loadData();
    loadTenantMinimumSetupFee();
  }, [activeTab, ownershipFilter, currentTenantId]);

  const loadTenantMinimumSetupFee = async () => {
    try {
      const response = await apiService.get<ApiResponse<{ data?: { MinimumSetupFee?: number | null }; MinimumSetupFee?: number | null }>>('/api/tenant-admin/settings');
      if (response.success && response.data) {
        const settings = (response.data as any).data || response.data;
        setTenantMinimumSetupFee(settings.MinimumSetupFee ?? null);
      }
    } catch (error) {
      console.error('Failed to load tenant minimum setup fee:', error);
    }
  };

  const loadData = async (): Promise<any[] | null> => {
    try {
      setLoading(true);
      
      if (activeTab === 'my-products') {
        // Load all products (owned + subscribed) with optional filter
        const response = await apiService.get<ApiResponse<any[]>>(`/api/me/tenant-admin/my-products?filter=${ownershipFilter}`);
        if (response.success && response.data) {
          setAllProducts(response.data);
          return response.data;
        }
      } else if (activeTab === 'marketplace') {
        const response = await apiService.get<ApiResponse<MarketplaceProduct[]>>('/api/tenant/products/catalog');
        if (response.success && response.data) {
          setMarketplaceProducts(response.data);
        }
      }
    } catch (error) {
      console.error('Failed to load data:', error);
      showNotification('Failed to load products', 'error', 'Error');
    } finally {
      setLoading(false);
    }
    return null;
  };

  // My Products functions
  const handleAddProduct = () => {
    setEditingProduct(null);
    setShowAddProduct(true);
  };

  const handleEditProduct = (product: MyProduct) => {
    setEditingProduct(product);
    setShowAddProduct(true);
  };

  // Handle AI Product Creator success
  const handleAISuccess = (productData: any) => {
    console.log('🤖 AI Generated Product Data:', productData);
    setShowAICreator(false);
    // Set AI data as editingProduct so wizard receives it
    setEditingProduct(productData);
    setShowAddProduct(true);
  };


  const handleSaveProduct = async (productData: any) => {
    try {
      console.log('💾 TenantAdmin saving product:', {
        editingProduct: !!editingProduct,
        productName: productData.name,
        productType: productData.productType,
        hasImageFile: !!productData.productImageFile,
        hasDocumentFile: !!productData.productDocumentFile
      });

      // Handle file uploads first. Single product image is used for both ProductImageUrl and ProductLogoUrl.
      let productImageUrl = undefined;
      let productLogoUrl = undefined;
      let productDocumentUrl = undefined;

      if (productData.productImageFile) {
        const formData = new FormData();
        formData.append('file', productData.productImageFile);
        formData.append('type', 'logos');
        formData.append('entityId', editingProduct?.ProductId || 'new');
        formData.append('category', 'product');
        
        const uploadResponse = await apiService.post('/api/uploads', formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        }) as { success?: boolean; url?: string; data?: { url?: string }[] | { url?: string } };
        const success = uploadResponse?.success === true;
        const url = uploadResponse?.url ?? (Array.isArray(uploadResponse?.data) ? uploadResponse?.data[0]?.url : (uploadResponse?.data as { url?: string })?.url);
        if (success && url) {
          productImageUrl = url;
          productLogoUrl = url;
        }
      }

      if (productData.productDocumentFile) {
        const formData = new FormData();
        formData.append('file', productData.productDocumentFile);
        formData.append('type', 'documents');
        formData.append('entityId', editingProduct?.ProductId || 'new');
        formData.append('category', 'product');
        
        const uploadResponse = await apiService.post('/api/uploads', formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        }) as ApiResponse<any>;
        
        if (uploadResponse.success) {
          productDocumentUrl = (uploadResponse as any).url 
            || (Array.isArray(uploadResponse.data) ? uploadResponse.data[0]?.url : uploadResponse.data?.url);
        }
      }

      // Upload multiple new document files (unlimited)
      const uploadedNewDocuments: { documentUrl: string; displayName: string; sortOrder: number }[] = [];
      const pendingFiles = productData.productDocumentFiles || [];
      for (let i = 0; i < pendingFiles.length; i++) {
        const item = pendingFiles[i];
        if (!item?.file || !(item.file instanceof File)) continue;
        try {
          const fd = new FormData();
          fd.append('file', item.file);
          fd.append('type', 'documents');
          fd.append('entityId', editingProduct?.ProductId || 'new');
          fd.append('category', 'product');
          const uploadResponse = await apiService.post('/api/uploads', fd, {
            headers: { 'Content-Type': 'multipart/form-data' }
          }) as ApiResponse<any>;
          if (uploadResponse.success) {
            const url = (uploadResponse as any).url
              || (Array.isArray(uploadResponse.data) ? uploadResponse.data[0]?.url : uploadResponse.data?.url);
            if (url) {
              uploadedNewDocuments.push({
                documentUrl: url,
                displayName: item.displayName?.trim() || item.file.name || 'Document',
                sortOrder: (productData.productDocuments?.length ?? 0) + (productDocumentUrl ? 1 : 0) + i
              });
            }
          }
        } catch (err) {
          console.error('Error uploading product document:', err);
        }
      }

      // Build full productDocuments: existing (with URLs) + legacy single upload + new uploads
      const existingDocs = (productData.productDocuments || []).filter((d: any) => d?.documentUrl);
      const withLegacy = productDocumentUrl
        ? [...existingDocs, { documentUrl: productDocumentUrl, displayName: productData.productDocumentName || 'Document', sortOrder: existingDocs.length }]
        : existingDocs;
      const productDocuments = withLegacy.length > 0 || uploadedNewDocuments.length > 0
        ? [...withLegacy, ...uploadedNewDocuments].map((d: any, i: number) => ({ ...d, sortOrder: i }))
        : undefined;

      // Upload ID Card Logo file if provided
      let idCardLogoUrl = undefined;
      if (productData.idCardLogoFile) {
        const formData = new FormData();
        formData.append('file', productData.idCardLogoFile);
        formData.append('type', 'logos');
        formData.append('entityId', editingProduct?.ProductId || 'new');
        formData.append('category', 'id-card');
        
        const uploadResponse = await apiService.post('/api/uploads', formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        }) as ApiResponse<any>;
        
        if (uploadResponse.success) {
          idCardLogoUrl = (uploadResponse as any).url 
            || (Array.isArray(uploadResponse.data) ? uploadResponse.data[0]?.url : uploadResponse.data?.url);
          
          // Update idCardData with the logo URL - preserve all existing data
          if (productData.idCardData) {
            productData.idCardData = {
              ...productData.idCardData,
              Card_Front: {
                ...productData.idCardData.Card_Front,
                Header: {
                  ...(productData.idCardData.Card_Front?.Header || {}),
                  Image: idCardLogoUrl
                },
                // Explicitly preserve Footer to prevent data loss
                Footer: productData.idCardData.Card_Front?.Footer || {
                  Header: '',
                  Text1: '',
                  Text2: ''
                }
              },
              // Explicitly preserve Card_Back to prevent data loss
              Card_Back: productData.idCardData.Card_Back || {
                Top_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
                Top_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
                Middle: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
                Bottom_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
                Bottom_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' }
              }
            };
          } else {
            // If idCardData doesn't exist, create it with the logo
            productData.idCardData = {
              Card_Front: {
                Header: {
                  Image: idCardLogoUrl
                },
                Footer: {
                  Header: '',
                  Text1: '',
                  Text2: ''
                }
              },
              Card_Back: {
                Top_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
                Top_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
                Middle: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
                Bottom_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
                Bottom_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' }
              }
            };
          }
        }
      }

      const backImageSections: Array<'Top_Left' | 'Top_Right' | 'Middle' | 'Bottom_Left' | 'Bottom_Right'> =
        ['Top_Left', 'Top_Right', 'Middle', 'Bottom_Left', 'Bottom_Right'];

      // Upload ID Card Back Image files if provided
      if (productData.idCardBackImageFiles) {
        // Ensure idCardData structure exists
        if (!productData.idCardData) {
          productData.idCardData = {
            Card_Front: {
              Header: { Image: '' },
              Footer: { Header: '', Text1: '', Text2: '' }
            },
            Card_Back: {
              Top_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
              Top_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
              Middle: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
              Bottom_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
              Bottom_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' }
            }
          };
        } else if (!productData.idCardData.Card_Back) {
          productData.idCardData.Card_Back = {
            Top_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
            Top_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
            Middle: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
            Bottom_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
            Bottom_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' }
          };
        }

        // Upload each back image file
        for (const section of backImageSections) {
          const file = productData.idCardBackImageFiles[section];
          if (file && file instanceof File) {
            try {
              const formData = new FormData();
              formData.append('file', file);
              // Use 'logos' container (public) to match front-card logo and existing Card_Back images;
              // 'images' routes to the non-public 'products' container and breaks <img> loads.
              formData.append('type', 'logos');
              formData.append('entityId', editingProduct?.ProductId || 'new');
              formData.append('category', 'id-card-back');
              
              const uploadResponse = await apiService.post('/api/uploads', formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
              }) as ApiResponse<any>;
              
              if (uploadResponse.success) {
                const imageUrl = (uploadResponse as any).url 
                  || (Array.isArray(uploadResponse.data) ? uploadResponse.data[0]?.url : uploadResponse.data?.url);
                
                if (imageUrl) {
                  if (!productData.idCardData.Card_Back[section]) {
                    productData.idCardData.Card_Back[section] = {
                      Image: '',
                      Header: '',
                      Text1: '',
                      Link_Name1: '',
                      URL1: '',
                      Link_Name2: '',
                      URL2: '',
                    };
                  }
                  productData.idCardData.Card_Back[section].Image = imageUrl;
                }
              }
            } catch (error) {
              console.error(`Error uploading ID card back image for ${section}:`, error);
              // Continue with other sections even if one fails
            }
          }
        }
      }

      // ---- Per-network ID card variation uploads ----
      const _networkLogoFiles = (productData as any).idCardLogoFileByNetwork as Record<string, File | null> | undefined;
      const _networkBackFiles = (productData as any).idCardBackImageFilesByNetwork as Record<string, Record<string, File | null>> | undefined;
      const _allVariationKeys = new Set<string>([
        ...Object.keys(_networkLogoFiles || {}),
        ...Object.keys(_networkBackFiles || {}),
        ...Object.keys((productData.idCardData?.NetworkVariations as Record<string, unknown>) || {})
      ]);
      if (_allVariationKeys.size > 0) {
        if (!productData.idCardData) {
          productData.idCardData = {
            Card_Front: { Header: { Image: '' }, Footer: { Header: '', Text1: '', Text2: '' } },
            Card_Back: {
              Top_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
              Top_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
              Middle: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
              Bottom_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
              Bottom_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' }
            }
          } as any;
        }
        const _idCardDataAny = productData.idCardData as any;
        if (!_idCardDataAny.NetworkVariations) _idCardDataAny.NetworkVariations = {};

        for (const networkId of _allVariationKeys) {
          if (!_idCardDataAny.NetworkVariations[networkId]) {
            _idCardDataAny.NetworkVariations[networkId] = JSON.parse(JSON.stringify({
              DisableIDCard: _idCardDataAny.DisableIDCard === true,
              Card_Front: _idCardDataAny.Card_Front,
              Card_Back: _idCardDataAny.Card_Back
            }));
          }
          const variation = _idCardDataAny.NetworkVariations[networkId];

          const logoFile = _networkLogoFiles?.[networkId];
          if (logoFile instanceof File) {
            try {
              const fd = new FormData();
              fd.append('file', logoFile);
              fd.append('type', 'logos');
              fd.append('entityId', editingProduct?.ProductId || 'new');
              fd.append('category', 'id-card');
              const uploadResponse = await apiService.post('/api/uploads', fd, {
                headers: { 'Content-Type': 'multipart/form-data' }
              }) as ApiResponse<any>;
              if (uploadResponse.success) {
                const url = (uploadResponse as any).url
                  || (Array.isArray(uploadResponse.data) ? uploadResponse.data[0]?.url : uploadResponse.data?.url);
                if (url) {
                  variation.Card_Front = variation.Card_Front || { Header: {}, Footer: {} };
                  variation.Card_Front.Header = { ...(variation.Card_Front.Header || {}), Image: url };
                }
              }
            } catch (err) {
              console.error(`Variation logo upload failed for network ${networkId}:`, err);
            }
          }

          const bf = _networkBackFiles?.[networkId];
          if (bf) {
            for (const section of backImageSections) {
              const file = bf[section];
              if (file instanceof File) {
                try {
                  const fd = new FormData();
                  fd.append('file', file);
                  fd.append('type', 'logos');
                  fd.append('entityId', editingProduct?.ProductId || 'new');
                  fd.append('category', 'id-card-back');
                  const uploadResponse = await apiService.post('/api/uploads', fd, {
                    headers: { 'Content-Type': 'multipart/form-data' }
                  }) as ApiResponse<any>;
                  if (uploadResponse.success) {
                    const url = (uploadResponse as any).url
                      || (Array.isArray(uploadResponse.data) ? uploadResponse.data[0]?.url : uploadResponse.data?.url);
                    if (url) {
                      variation.Card_Back = variation.Card_Back || {};
                      variation.Card_Back[section] = {
                        ...(variation.Card_Back[section] || { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' }),
                        Image: url
                      };
                    }
                  }
                } catch (err) {
                  console.error(`Variation back image upload failed (${section}) for network ${networkId}:`, err);
                }
              }
            }
          }
        }
      }

      // Prepare API data
      const apiProductData = {
        // Vendor information
        vendorId: productData.vendorId,
        isVendorPricing: productData.isVendorPricing,
        vendorCommission: productData.vendorCommission,
        vendorGroupIdProductType: productData.vendorGroupIdProductType ?? '',
        eligibilityIndividualVendorGroupId: productData.eligibilityIndividualVendorGroupId ?? '',
        eligibilityVendorGroupFallbackProductId: productData.eligibilityVendorGroupFallbackProductId ?? '',
        planId: productData.planId ?? '',
        partNumber: productData.partNumber,
        // Product information
        name: productData.name,
        description: productData.description,
        productType: productData.productType,
        salesType: productData.salesType,
        productOwnerId: user?.currentTenantId || user?.tenantId, // Use active tenant ID (respects tenant switching)
        minAge: productData.minAge,
        maxAge: productData.maxAge,
        allowedStates: productData.allowedStates,
        requiresTobaccoInfo: productData.requiresTobaccoInfo,
        effectiveDateLogic: productData.effectiveDateLogic,
        maxEffectiveDateDays: productData.maxEffectiveDateDays,
        terminationLogic: productData.terminationLogic,
        requiredLicenses: productData.requiredLicenses,
        configurationFields: productData.configurationFields,
        pricingTiers: productData.pricingTiers,
        acknowledgementQuestions: productData.acknowledgementQuestions,
        productQuestionnaires: productData.productQuestionnaires || undefined,
        idCardData: productData.idCardData,
        idCardMemberIdPrefixMask: productData.idCardMemberIdPrefixMask ?? '',
        showGroupIdOnIDCard: productData.showGroupIdOnIDCard === true,
        planDetailsData: productData.planDetailsData,
        aiChunks: productData.aiChunks,
        requiredASA: productData.requiredASA,
        trainingConfig: productData.trainingConfig,
        medicalNeedsLinksConfig: productData.medicalNeedsLinksConfig,
        // Include isPublic, isHidden, and isSSNRequired fields
        isPublic: productData.isPublic,
        isHidden: productData.isHidden || false,
        isSSNRequired: productData.isSSNRequired || false,
        premiumReportingCategory:
          productData.premiumReportingCategory === 'NonProfit' ? 'NonProfit' : 'ForProfit',
        includeProcessingFee: productData.includeProcessingFee === true,
        roundUpProcessingFee: productData.roundUpProcessingFee !== false,
        processingFeePercentage: productData.processingFeePercentage ?? null,
        // Include deletion flags
        deleteProductImage: productData.deleteProductImage,
        deleteProductLogo: productData.deleteProductLogo ?? productData.deleteProductImage,
        deleteProductDocument: productData.deleteProductDocument,
        // Only include URL fields if they are defined (new files uploaded)
        ...(productImageUrl !== undefined && { productImageUrl }),
        ...(productLogoUrl !== undefined && { productLogoUrl }),
        ...(productDocumentUrl !== undefined && { productDocumentUrl }),
        ...(productDocuments !== undefined && productDocuments.length > 0 && { productDocuments })
      };

      // Validate ProductId is a valid GUID before using it
      const isValidGuid = (id: string | undefined): boolean => {
        if (!id) return false;
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return guidRegex.test(id);
      };
      
      // CRITICAL: AI-generated products should NEVER have a valid ProductId - if editingProduct has lowercase properties (name, vendorId),
      // it's AI-generated and should be treated as a NEW product, even if it has an invalid ProductId field
      const isAIGenerated = editingProduct && ((editingProduct as any).name || (editingProduct as any).vendorId) && !editingProduct.Name;
      
      let response;
      
      // Only update if it's NOT AI-generated AND ProductId exists and is a valid GUID
      if (!isAIGenerated && editingProduct && editingProduct.ProductId && isValidGuid(editingProduct.ProductId)) {
        // Update existing product using the main products endpoint
        response = await apiService.put(`/api/products/${editingProduct.ProductId}`, apiProductData) as ApiResponse<any>;
      } else {
        // Create new product using the main products endpoint
        response = await apiService.post('/api/products', apiProductData) as ApiResponse<any>;
      }
      
      if (response.success) {
        setShowAddProduct(false);
        setEditingProduct(null);
        await loadData(); // Refresh the list
        showNotification(editingProduct ? 'Product updated successfully' : 'Product created successfully', 'success');
      } else {
        throw new Error(response.message || 'Failed to save product');
      }
    } catch (err: any) {
      console.error('Error saving product:', err);
      showNotification(err.message || 'Failed to save product', 'error');
      throw err; // Re-throw to let the wizard handle it
    }
  };

  const handleCloseWizard = () => {
    setShowAddProduct(false);
    setEditingProduct(null);
  };

  const loadBundleWizardCatalog = async (): Promise<void> => {
    setBundleWizardCatalogLoading(true);
    try {
      const response = await apiService.get<ApiResponse<any[]>>('/api/me/tenant-admin/my-products?filter=all');
      if (response.success && response.data) {
        setBundleWizardCatalog(response.data);
      } else {
        setBundleWizardCatalog([]);
      }
    } catch (e) {
      console.error('Failed to load tenant products for bundle:', e);
      setBundleWizardCatalog([]);
      showNotification('Failed to load your products for the bundle builder', 'error', 'Error');
    } finally {
      setBundleWizardCatalogLoading(false);
    }
  };

  // Bundle functions — catalog is tenant-owned + subscribed only (not global marketplace)
  const handleAddBundle = async () => {
    setEditingBundle(null);
    await loadBundleWizardCatalog();
    setShowAddBundle(true);
  };

  const handleEditBundle = async (bundle: MyProduct) => {
    setEditingBundle(bundle);
    await loadBundleWizardCatalog();
    setShowAddBundle(true);
  };

  const handleSaveBundle = async (bundleData: any) => {
    try {
      console.log('📦 TenantAdmin saving bundle:', {
        editingBundle: !!editingBundle,
        bundleName: bundleData.name,
        bundleProductsCount: bundleData.bundleProducts?.length || 0
      });

      // Handle logo URL
      let productLogoUrl = bundleData.productLogoUrl ?? bundleData.ProductLogoUrl ?? undefined;

      // Upload logo if we received a new file but no pre-uploaded URL
      if (!productLogoUrl && bundleData.productLogoFile) {
        const formData = new FormData();
        formData.append('file', bundleData.productLogoFile);
        formData.append('type', 'logos');
        formData.append('entityId', editingBundle?.ProductId || 'new');
        formData.append('category', 'product');

        const uploadResponse = await apiService.post('/api/uploads', formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        }) as ApiResponse<any>;

        if (uploadResponse.success) {
          productLogoUrl = (uploadResponse as any).url
            || (Array.isArray(uploadResponse.data) ? uploadResponse.data[0]?.url : uploadResponse.data?.url);
        }
      }

      // Upload any new bundle-level document files; merge with existing docs so the
      // backend can write rows into oe.ProductDocuments and queue AI extraction.
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
          const uploadResponse = await apiService.post('/api/uploads', fd, {
            headers: { 'Content-Type': 'multipart/form-data' }
          }) as ApiResponse<any>;
          if (uploadResponse.success) {
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

      // Prepare API data
      // Note: For tenant admin page, we need to fetch full product details before editing
      // to preserve all fields. For now, using safe defaults.
      const apiBundleData = {
        name: bundleData.name,
        description: bundleData.description,
        productType: 'Bundle',
        isBundle: true,
        // Use tenant ID for bundles (both new and existing)
        productOwnerId: user?.currentTenantId || user?.tenantId || '1CD92AF7-B6F2-4E48-A8F3-EC6316158826', // Use active tenant ID (respects tenant switching)
        isVendorPricing: false,
        vendorCommission: 0,
        salesType: bundleData.salesType || editingBundle?.SalesType || 'Both',
        minAge: 18,
        maxAge: 65,
        allowedStates: [],
        requiresTobaccoInfo: false,
        effectiveDateLogic: 'FirstOfMonth',
        maxEffectiveDateDays: 60,
        terminationLogic: '',
        requiredLicenses: [],
        bundleProducts: bundleData.bundleProducts?.map((bp: any) => ({
          productId: bp.productId,
          isRequired: bp.isRequired || true,
          sortOrder: bp.sortOrder || 1,
          hidePricing: !!bp.hidePricing,
          linkedToProductId: bp.hidePricing ? bp.linkedToProductId || null : null,
          allowedConfigOptions: bp.allowedConfigOptions && Object.keys(bp.allowedConfigOptions).length > 0 ? bp.allowedConfigOptions : undefined
        })) || [],
        // Include isPublic field
        isPublic: bundleData.isPublic || false,
        // Include isHidden - hide from agents, enrollment links, and groups
        isHidden: bundleData.isHidden || false,
        // Only include URL field if we have one (either pre-existing or newly uploaded)
        ...(productLogoUrl !== undefined && {
          productLogoUrl,
          productImageUrl: productLogoUrl
        }),
        // Forward bundle-level documents to the products route, which already inserts
        // rows into oe.ProductDocuments and queues AI extraction regardless of isBundle.
        ...(mergedBundleDocuments !== undefined && { productDocuments: mergedBundleDocuments }),
      };

      let response;
      
      if (editingBundle) {
        // Update existing bundle using the main products endpoint
        response = await apiService.put(`/api/products/${editingBundle.ProductId}`, apiBundleData) as ApiResponse<any>;
      } else {
        // Create new bundle using the main products endpoint
        response = await apiService.post('/api/products', apiBundleData) as ApiResponse<any>;
      }
      
      if (response.success) {
        setShowAddBundle(false);
        setEditingBundle(null);
        await loadData(); // Refresh the list
        showNotification(editingBundle ? 'Bundle updated successfully' : 'Bundle created successfully', 'success');
      } else {
        throw new Error(response.message || 'Failed to save bundle');
      }
    } catch (err: any) {
      console.error('Error saving bundle:', err);
      showNotification(err.message || 'Failed to save bundle', 'error');
      throw err; // Re-throw to let the wizard handle it
    }
  };

  const handleCloseBundleWizard = () => {
    setShowAddBundle(false);
    setEditingBundle(null);
  };

  // Filter products based on search and filters
  const getFilteredAllProducts = (products: any[]): any[] => {
    return products.filter(product => {
      // Search filter
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const matchesName = product.Name?.toLowerCase().includes(searchLower) || false;
        const matchesDescription = (product.Description || product.description)?.toLowerCase().includes(searchLower) || false;
        const matchesType = (product.ProductType || product.productType)?.toLowerCase().includes(searchLower) || false;
        const matchesOwner = product.productOwner?.tenantName?.toLowerCase().includes(searchLower) || false;
        
        if (!matchesName && !matchesDescription && !matchesType && !matchesOwner) {
          return false;
        }
      }

      // Product type filter
      if (selectedProductType && (product.ProductType || product.productType) !== selectedProductType) {
        return false;
      }

      // Sales Type filter: "Individual Only" / "Group Only" include products with SalesType "Both" (available for both)
      if (selectedSalesType) {
        const productSalesType = product.SalesType || product.salesType;
        const matchesFilter = productSalesType === selectedSalesType || productSalesType === 'Both';
        if (!matchesFilter) {
          return false;
        }
      }

      // Vendor filter
      if (selectedVendor) {
        const isBundle = product.IsBundle === true || product.IsBundle === 1 || product.isBundle === true || product.isBundle === 1;
        if (isBundle && product.bundleProducts && product.bundleProducts.length > 0) {
          // Bundle: show if any included product has the selected vendor
          const hasMatchingVendor = product.bundleProducts.some((bp: any) => (bp.vendorName || bp.VendorName) === selectedVendor);
          if (!hasMatchingVendor) return false;
        } else {
          const productVendor = product.vendorName || product.VendorName;
          if (productVendor !== selectedVendor) return false;
        }
      }

      // Status filter
      if (selectedStatus) {
        // For subscribed products, check subscription status
        if (product.ownershipType === 'subscriber' && product.subscriptionStatus !== selectedStatus) {
          return false;
        }
        // For owned products, check product status
        if (product.ownershipType === 'owner' && product.Status !== selectedStatus) {
          return false;
        }
      }

      // IsHidden filter
      const isHidden = product.IsHidden === true || product.IsHidden === 1 || product.isHidden === true || product.isHidden === 1;
      if (selectedIsHidden === 'hideHidden' && isHidden) {
        return false; // Filter out hidden products (isHidden = 1)
      }
      if (selectedIsHidden === 'showHidden' && !isHidden) {
        return false; // Show only hidden products (isHidden = 1)
      }
      // 'all' shows everything, no filtering needed

      return true;
    });
  };

  const getFilteredProducts = <T extends SubscribedProduct | MarketplaceProduct>(products: T[]): T[] => {
    return products.filter(product => {
      // Search filter
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const matchesName = product.Name?.toLowerCase().includes(searchLower) || false;
        const matchesDescription = product.description?.toLowerCase().includes(searchLower) || false;
        const matchesType = product.productType?.toLowerCase().includes(searchLower) || false;
        const matchesOwner = product.productOwner?.tenantName?.toLowerCase().includes(searchLower) || false;
        
        if (!matchesName && !matchesDescription && !matchesType && !matchesOwner) {
          return false;
        }
      }

      // Product type filter
      if (selectedProductType && product.productType && product.productType !== selectedProductType) {
        return false;
      }

      // Sales Type filter: "Individual Only" / "Group Only" include products with SalesType "Both" (available for both)
      if (selectedSalesType) {
        const productSalesType = (product as any).SalesType || (product as any).salesType;
        const matchesFilter = productSalesType === selectedSalesType || productSalesType === 'Both';
        if (!matchesFilter) {
          return false;
        }
      }

      // Vendor filter
      if (selectedVendor) {
        const p = product as any;
        const isBundle = p.IsBundle === true || p.IsBundle === 1 || p.isBundle === true || p.isBundle === 1;
        if (isBundle && p.bundleProducts && p.bundleProducts.length > 0) {
          const hasMatchingVendor = p.bundleProducts.some((bp: any) => (bp.vendorName || bp.VendorName) === selectedVendor);
          if (!hasMatchingVendor) return false;
        } else {
          const productVendor = p.vendorName || p.VendorName;
          if (productVendor !== selectedVendor) return false;
        }
      }

      // IsHidden filter
      const isHidden = (product as any).IsHidden === true || (product as any).IsHidden === 1 || (product as any).isHidden === true || (product as any).isHidden === 1;
      if (selectedIsHidden === 'hideHidden' && isHidden) {
        return false; // Filter out hidden products (isHidden = 1)
      }
      if (selectedIsHidden === 'showHidden' && !isHidden) {
        return false; // Show only hidden products (isHidden = 1)
      }
      // 'all' shows everything, no filtering needed

      return true;
    });
  };

  // Get unique product types for filter dropdown (exclude Bundle - bundles have their own tab)
  const getProductTypes = (): string[] => {
    if (activeTab === 'my-products') {
      const types = [...new Set(allProducts.map(p => p.ProductType || p.productType))];
      return types.filter(Boolean).filter(t => t !== 'Bundle' && t !== 'bundle').sort();
    }
    const types = [...new Set(marketplaceProducts.map(p => p.productType))];
    return types.filter(t => t !== 'Bundle' && t !== 'bundle').sort();
  };

  // Get unique vendors for filter dropdown (include vendors from products inside bundles)
  const getVendors = (): string[] => {
    const collectVendors = (products: any[]): string[] => {
      const set = new Set<string>();
      products.forEach(p => {
        const vendor = p.vendorName || p.VendorName;
        if (vendor) set.add(vendor);
        // Also include vendors from products inside bundles
        if (p.bundleProducts?.length) {
          p.bundleProducts.forEach((bp: any) => {
            const bpVendor = bp.vendorName || bp.VendorName;
            if (bpVendor) set.add(bpVendor);
          });
        }
      });
      return [...set].sort();
    };
    if (activeTab === 'my-products') return collectVendors(allProducts);
    return collectVendors(marketplaceProducts);
  };

  // Get unique statuses for products filter
  const getStatuses = (): string[] => {
    if (activeTab === 'my-products') {
      const statuses = new Set<string>();
      allProducts.forEach(p => {
        if (p.ownershipType === 'subscriber' && p.subscriptionStatus) {
          statuses.add(p.subscriptionStatus);
        } else if (p.ownershipType === 'owner' && p.Status) {
          statuses.add(p.Status);
        }
      });
      return Array.from(statuses).sort();
    }
    return [];
  };

  const handleRequestProduct = async (requestData: ProductRequest) => {
    try {
      const response = await apiService.post<ApiResponse<{ requestId: string; subscriptionId: string }>>('/api/tenant/products/request', requestData);
      if (response.success) {
        setShowRequestModal(false);
        setSelectedProduct(null);
        await loadData();
        showNotification('Product registration request submitted successfully', 'success', 'Success');
      }
    } catch (error) {
      console.error('Failed to request product:', error);
      showNotification('Failed to submit registration request', 'error', 'Error');
    }
  };

  const handleConfigureProduct = async (
    subscriptionOrProductId: string,
    profitMargin: number,
    setupFee?: number | null,
    includeProcessingFee?: boolean,
    roundUpProcessingFee?: boolean,
    customSystemFeeEnabled?: boolean,
    customSystemFeeAmount?: number | null,
    mustBeSoldWithProductIds?: string[],
    zeroFeeForACH?: boolean
  ) => {
    try {
      console.log('💾 Saving configuration:', {
        subscriptionOrProductId,
        profitMargin,
        setupFee,
        includeProcessingFee,
        roundUpProcessingFee,
        zeroFeeForACH,
        customSystemFeeEnabled,
        customSystemFeeAmount,
        mustBeSoldWithProductIds
      });

      const response = await apiService.put<ApiResponse<{ message: string; data?: any }>>(`/api/tenant/products/${subscriptionOrProductId}/configure`, {
        profitMargin,
        setupFee: setupFee !== undefined ? setupFee : null,
        includeProcessingFee: includeProcessingFee === true,
        roundUpProcessingFee: roundUpProcessingFee === true,
        zeroFeeForACH: zeroFeeForACH === true,
        customSystemFeeEnabled: customSystemFeeEnabled === true,
        customSystemFeeAmount: customSystemFeeAmount != null ? customSystemFeeAmount : null,
        mustBeSoldWithProductIds: mustBeSoldWithProductIds ?? []
      });
      
      console.log('✅ Configuration response:', response);
      
      if (response.success) {
        // Reload data first to get fresh values from database
        await loadData();
        
        // Close modal after data is reloaded
        setShowConfigureModal(false);
        setSelectedSubscription(null);
        showNotification('Configuration saved successfully', 'success', 'Success');
      } else {
        showNotification(response.message || 'Failed to save configuration', 'error', 'Error');
      }
    } catch (error: any) {
      console.error('❌ Failed to configure product:', error);
      showNotification(error.message || 'Failed to save configuration', 'error', 'Error');
      throw error; // Re-throw so modal can handle it
    }
  };

  const handleRemoveSubscription = async (subscriptionId: string) => {
    if (!confirm('Remove this product from your tenant? You can subscribe again from the marketplace later.')) {
      return;
    }
    
    try {
      const response = await apiService.delete<ApiResponse<{ message: string }>>(`/api/tenant/products/${subscriptionId}`);
      if (response.success) {
        await loadData();
        showNotification('Product removed from your tenant', 'success', 'Success');
      }
    } catch (error) {
      console.error('Failed to remove subscription:', error);
      showNotification('Failed to remove subscription', 'error', 'Error');
    }
  };

  const isSysAdmin = user?.currentRole === 'SysAdmin';

  const getEnrollmentCount = (product: any) =>
    product.enrollmentCount ?? product.EnrollmentCount ?? 0;

  const canUnsubscribeProduct = (product: any) => {
    if (product.ownershipType !== 'subscriber') return false;
    return Boolean(product.subscriptionId || product.SubscriptionId);
  };

  const canDeleteProduct = (product: any) => {
    if (product.ownershipType === 'subscriber') return false;
    if (product.ownershipType === 'owner') return true;
    const ownerId = product.productOwnerId || product.ProductOwnerId;
    const isOwnedByTenant = Boolean(ownerId && currentTenantId && ownerId === currentTenantId);
    return isOwnedByTenant || isSysAdmin;
  };

  const isProductDeletable = (product: any) =>
    canDeleteProduct(product) && getEnrollmentCount(product) === 0;

  const getDeleteBlockedReason = (product: any) => {
    const enrollmentCount = getEnrollmentCount(product);
    if (enrollmentCount > 0) {
      return `This product cannot be deleted because ${enrollmentCount} enrollment${enrollmentCount === 1 ? '' : 's'} ${enrollmentCount === 1 ? 'is' : 'are'} attached to it.`;
    }
    return null;
  };

  const handleDeleteProduct = (product: any) => {
    setProductToDelete(product);
    setDeleteError(null);
    setShowDeleteConfirm(true);
  };

  const handleCloseDeleteConfirm = () => {
    setShowDeleteConfirm(false);
    setProductToDelete(null);
    setDeleteError(null);
    setIsDeleting(false);
  };

  const confirmDeleteProduct = async () => {
    if (!productToDelete) return;

    const productId = productToDelete.ProductId || productToDelete.productId;
    if (!productId) return;

    try {
      setIsDeleting(true);
      setDeleteError(null);

      const response = await apiService.delete<ApiResponse<{ message: string; enrollmentCount?: number }>>(
        `/api/me/tenant-admin/my-products/${productId}`
      );

      if (response.success) {
        await loadData();
        handleCloseDeleteConfirm();
        showNotification('Product deleted successfully', 'success', 'Success');
      } else {
        setDeleteError(response.message || 'Failed to delete product');
      }
    } catch (err: any) {
      setDeleteError(err?.message || 'Failed to delete product');
    } finally {
      setIsDeleting(false);
    }
  };

  // Apply filtering to products
  const filteredAllProducts = getFilteredAllProducts(allProducts);
  const filteredMarketplaceProducts = getFilteredProducts(marketplaceProducts);

  // Category-filtered products for My Products tab (Products vs Bundles)
  const isBundle = (p: any) => p.IsBundle === true || p.IsBundle === 1 || p.isBundle === true || p.isBundle === 1;
  const categoryFilteredProducts = productCategoryTab === 'bundles'
    ? filteredAllProducts.filter(isBundle)
    : filteredAllProducts.filter(p => !isBundle(p));
  const migrateWizardProducts = filteredAllProducts.filter((p) => !isBundle(p));

  const tabs = [
    {
      id: 'my-products',
      label: 'My Products',
      icon: Package,
      count: allProducts.length,
      description: 'Manage owned products and subscriptions'
    },
    {
      id: 'marketplace',
      label: 'Marketplace',
      icon: Plus,
      count: marketplaceProducts.length,
      description: 'Browse and subscribe to new products'
    }
  ];

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-full">
      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        {/* Summary Cards */}
        {/* <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="p-2 bg-oe-primary/10 rounded-lg">
                <Package className="h-6 w-6 text-oe-primary" />
              </div>
              <div className="ml-4">
                <p className="text-2xl font-bold text-gray-900">
                  {allProducts.filter(p => p.ownershipType === 'owner').length}
                </p>
                <p className="text-sm text-gray-600">Products Owned</p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="p-2 bg-green-100 rounded-lg">
                <CheckCircle className="h-6 w-6 text-green-600" />
              </div>
              <div className="ml-4">
                <p className="text-2xl font-bold text-gray-900">
                  {allProducts.filter(p => p.ownershipType === 'subscriber' && p.subscriptionStatus === 'Active').length}
                </p>
                <p className="text-sm text-gray-600">Active Subscriptions</p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="p-2 bg-yellow-100 rounded-lg">
                <Clock className="h-6 w-6 text-yellow-600" />
              </div>
              <div className="ml-4">
                <p className="text-2xl font-bold text-gray-900">
                  {allProducts.filter(p => p.ownershipType === 'subscriber' && p.subscriptionStatus === 'Pending').length}
                </p>
                <p className="text-sm text-gray-600">Pending Approval</p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="p-2 bg-purple-100 rounded-lg">
                <DollarSign className="h-6 w-6 text-purple-600" />
              </div>
              <div className="ml-4">
                <p className="text-2xl font-bold text-gray-900">
                  {allProducts.filter(p => p.ownershipType === 'subscriber' && p.subscriptionStatus === 'Approved' && !p.isConfigured).length}
                </p>
                <p className="text-sm text-gray-600">Ready to Configure</p>
              </div>
            </div>
          </div>
        </div> */}

        {/* Tabs */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="border-b border-gray-200">
            <nav className="flex space-x-0">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  className={`flex-1 group relative px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                    activeTab === tab.id
                      ? 'border-oe-primary text-gray-900 font-semibold'
                      : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
                  }`}
                  style={activeTab === tab.id ? { 
                    backgroundColor: 'rgba(37, 99, 235, 0.08)',
                    borderBottomColor: 'var(--oe-primary, #2563EB)',
                    borderBottomWidth: '3px'
                  } : {}}
                >
                  <div className="flex items-center justify-center space-x-2">
                    <tab.icon className={`h-5 w-5 ${activeTab === tab.id ? 'text-oe-primary' : 'text-gray-600'}`} style={activeTab === tab.id ? { color: 'var(--oe-primary, #2563EB)' } : {}} />
                    <span className="font-semibold text-gray-900">{tab.label}</span>
                    {tab.count > 0 && (
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        activeTab === tab.id 
                          ? 'bg-oe-primary text-white' 
                          : 'bg-gray-200 text-gray-700'
                      }`} style={activeTab === tab.id ? { backgroundColor: 'var(--oe-primary, #2563EB)' } : {}}>
                        {tab.count}
                      </span>
                    )}
                  </div>
                  <div className={`text-xs mt-1 ${activeTab === tab.id ? 'text-gray-600' : 'text-gray-500'}`}>
                    {tab.description}
                  </div>
                </button>
              ))}
            </nav>
          </div>

          {/* Tab Content */}
          <div className="p-6">
            {activeTab === 'my-products' && (
              <>
                {/* Products / Bundles sub-tabs */}
                <div className="flex border-b border-gray-200 mb-6 -mt-2 gap-1">
                  <button
                    onClick={() => setProductCategoryTab('products')}
                    className={`flex items-center gap-3 px-6 py-4 text-base font-semibold border-b-2 transition-colors ${
                      productCategoryTab === 'products'
                        ? 'border-oe-primary text-gray-900'
                        : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                    }`}
                    style={productCategoryTab === 'products' ? { borderBottomColor: 'var(--oe-primary, #2563EB)' } : {}}
                  >
                    <Package className={`h-6 w-6 ${productCategoryTab === 'products' ? 'text-oe-primary' : 'text-gray-500'}`} style={productCategoryTab === 'products' ? { color: 'var(--oe-primary, #2563EB)' } : {}} />
                    Products
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium ${
                      productCategoryTab === 'products' ? 'bg-oe-primary/10 text-oe-primary' : 'bg-gray-100 text-gray-600'
                    }`} style={productCategoryTab === 'products' ? { backgroundColor: 'rgba(37, 99, 235, 0.1)', color: 'var(--oe-primary, #2563EB)' } : {}}>
                      {filteredAllProducts.filter(p => !isBundle(p)).length}
                    </span>
                  </button>
                  <button
                    onClick={() => setProductCategoryTab('bundles')}
                    className={`flex items-center gap-3 px-6 py-4 text-base font-semibold border-b-2 transition-colors ${
                      productCategoryTab === 'bundles'
                        ? 'border-oe-primary text-gray-900'
                        : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                    }`}
                    style={productCategoryTab === 'bundles' ? { borderBottomColor: 'var(--oe-primary, #2563EB)' } : {}}
                  >
                    <Layers className={`h-6 w-6 ${productCategoryTab === 'bundles' ? 'text-oe-primary' : 'text-gray-500'}`} style={productCategoryTab === 'bundles' ? { color: 'var(--oe-primary, #2563EB)' } : {}} />
                    Bundles
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium ${
                      productCategoryTab === 'bundles' ? 'bg-oe-primary/10 text-oe-primary' : 'bg-gray-100 text-gray-600'
                    }`} style={productCategoryTab === 'bundles' ? { backgroundColor: 'rgba(37, 99, 235, 0.1)', color: 'var(--oe-primary, #2563EB)' } : {}}>
                      {filteredAllProducts.filter(isBundle).length}
                    </span>
                  </button>
                </div>
                <UnifiedProductsTab
                productCategoryTab={productCategoryTab}
                products={categoryFilteredProducts}
                loading={loading}
                searchTerm={searchTerm}
                selectedProductType={selectedProductType}
                selectedStatus={selectedStatus}
                selectedSalesType={selectedSalesType}
                selectedVendor={selectedVendor}
                selectedIsHidden={selectedIsHidden}
                ownershipFilter={ownershipFilter}
                productTypes={getProductTypes()}
                vendors={getVendors()}
                statuses={getStatuses()}
                onSearchChange={setSearchTerm}
                onProductTypeChange={setSelectedProductType}
                onStatusChange={setSelectedStatus}
                onSalesTypeChange={setSelectedSalesType}
                onVendorChange={setSelectedVendor}
                onIsHiddenChange={setSelectedIsHidden}
                onOwnershipFilterChange={setOwnershipFilter}
                onShowAICreator={() => setShowAICreator(true)}
                onMigrateMembers={() => setShowMigrateMembers(true)}
                onAddProduct={handleAddProduct}
                onAddBundle={handleAddBundle}
                onEditProduct={(product) => {
                  const myProduct: MyProduct = {
                    ProductId: product.ProductId,
                    Name: product.Name,
                    Description: product.Description || product.description || '',
                    ProductType: product.ProductType || product.productType,
                    Status: product.Status || product.status,
                    IsBundle: product.IsBundle || false,
                    ProductImageUrl: product.ProductImageUrl || product.productImageUrl,
                    ProductLogoUrl: product.ProductLogoUrl || product.productLogoUrl,
                    ProductDocumentUrl: product.ProductDocumentUrl || product.productDocumentUrl,
                    CreatedDate: product.CreatedDate || '',
                    ModifiedDate: product.ModifiedDate || '',
                    SubscriptionCount: product.SubscriptionCount || 0
                  };
                  
                  if (product.IsBundle) {
                    handleEditBundle(myProduct);
                  } else {
                    handleEditProduct(myProduct);
                  }
                }}
                onConfigure={async (product) => {
                  // Ensure we have the latest product data before opening modal
                  const refreshed = await loadData();
                  const source = refreshed || allProducts;

                  // Find the updated product from the refreshed list
                  const updatedProduct = source.find((p: any) => 
                    (p.subscriptionId && product.subscriptionId && p.subscriptionId === product.subscriptionId) ||
                    (p.ProductId && product.ProductId && p.ProductId === product.ProductId)
                  ) || product;

                  if (updatedProduct?.IsBundle) {
                    setSelectedBundleSubscription(updatedProduct as any);
                    setShowBundleConfigureModal(true);
                    return;
                  }

                  setSelectedSubscription(updatedProduct as any);
                  setShowConfigureModal(true);
                }}
                onViewDetails={(product) => {
                  setSelectedSubscription(product as any);
                  setShowDetailsModal(true);
                }}
                onApiConfig={(product) => {
                  setApiConfigProduct(product);
                  setShowAPIConfigModal(true);
                }}
                onDeleteProduct={handleDeleteProduct}
                canDeleteProduct={canDeleteProduct}
                canUnsubscribeProduct={canUnsubscribeProduct}
                onRemove={handleRemoveSubscription}
                currentTenantId={user?.currentTenantId || user?.tenantId}
              />
              </>
            )}

            {activeTab === 'marketplace' && (
              <MarketplaceTab
                products={filteredMarketplaceProducts}
                loading={loading}
                searchTerm={searchTerm}
                selectedProductType={selectedProductType}
                selectedSalesType={selectedSalesType}
                selectedVendor={selectedVendor}
                selectedIsHidden={selectedIsHidden}
                productTypes={getProductTypes()}
                vendors={getVendors()}
                onSearchChange={setSearchTerm}
                onProductTypeChange={setSelectedProductType}
                onSalesTypeChange={setSelectedSalesType}
                onVendorChange={setSelectedVendor}
                onIsHiddenChange={setSelectedIsHidden}
                onRequestProduct={(product) => {
                  setSelectedProduct(product);
                  setShowRequestModal(true);
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Modals */}
      {showRequestModal && selectedProduct && (
        <SubscribeProductModal
          product={selectedProduct}
          onClose={() => {
            setShowRequestModal(false);
            setSelectedProduct(null);
          }}
          onSubmit={handleRequestProduct}
        />
      )}

      {showAPIConfigModal && apiConfigProduct && (
        <ProductAPIConfigModal
          productId={apiConfigProduct.ProductId || apiConfigProduct.productId}
          productName={apiConfigProduct.Name || apiConfigProduct.name || 'Product'}
          isOpen={showAPIConfigModal}
          onClose={() => { setShowAPIConfigModal(false); setApiConfigProduct(null); }}
          onSaved={() => loadData()}
        />
      )}

      {showConfigureModal && selectedSubscription && (
        <ConfigureProductModal
          key={selectedSubscription.subscriptionId || selectedSubscription.productId} // Force re-render when subscription changes
          product={selectedSubscription}
          currentTenantId={currentTenantId || undefined}
          onClose={() => {
            setShowConfigureModal(false);
            setSelectedSubscription(null);
          }}
          onSubmit={handleConfigureProduct}
          tenantMinimumSetupFee={tenantMinimumSetupFee}
          availableProductsForMustBeSoldWith={(allProducts || [])
            .filter((p) => (p.ProductId || (p as any).productId) !== ((selectedSubscription as any).ProductId ?? selectedSubscription.productId))
            .map((p) => {
              const isBundle = p.IsBundle === true || p.IsBundle === 1 || p.isBundle === true || p.isBundle === 1;
              return {
                ProductId: (p as any).ProductId || (p as any).productId,
                Name: (p as any).Name || (p as any).productName || '',
                IsBundle: Boolean(isBundle)
              };
            })
            .filter((p) => p.ProductId && p.Name)}
        />
      )}

      {showBundleConfigureModal && selectedBundleSubscription && (
        <ConfigureBundleModal
          bundle={selectedBundleSubscription as any}
          onClose={() => {
            setShowBundleConfigureModal(false);
            setSelectedBundleSubscription(null);
          }}
          onConfigureIncluded={(included) => {
            if (!included?.subscriptionId) return;

            // Open the standard configure modal for the included product subscription
            const includedSubscription: any = {
              subscriptionId: included.subscriptionId,
              Name: included.name,
              productType: included.productType,
              description: included.description,
              tenantRate: included.tenantRate || 0,
              profitMargin: included.profitMargin || 0,
              systemFees: included.systemFees || null,
              setupFee: included.setupFee ?? null,
              isConfigured: Boolean(included.isConfigured),
              subscriptionStatus: included.subscriptionStatus || 'Active',
              staticGroupId: included.staticGroupId || null,
              showGroupIdOnIDCard: Boolean(included.showGroupIdOnIDCard),
              includeProcessingFee: included.includeProcessingFee === true,
              roundUpProcessingFee: included.roundUpProcessingFee === true,
              customSystemFeeEnabled: included.customSystemFeeEnabled === true,
              customSystemFeeAmount: included.customSystemFeeAmount != null ? included.customSystemFeeAmount : null,
              // Keep product owner context if needed elsewhere
              productOwner: (selectedBundleSubscription as any).productOwner
            };

            setShowBundleConfigureModal(false);
            setSelectedBundleSubscription(null);
            setSelectedSubscription(includedSubscription);
            setShowConfigureModal(true);
          }}
        />
      )}

      {showDetailsModal && selectedSubscription && (
        <SubscribedProductDetailsModal
          key={(selectedSubscription as any).subscriptionId || (selectedSubscription as any).productId || (selectedSubscription as any).ProductId}
          product={selectedSubscription}
          onSubscribersChanged={() => { void loadData(); }}
          onClose={() => {
            setShowDetailsModal(false);
            setSelectedSubscription(null);
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
        productOwnerId={user?.currentTenantId || user?.tenantId || ""}
      />

      {showMigrateMembers ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30">
              <Loader2 className="h-10 w-10 animate-spin text-oe-primary" aria-hidden />
            </div>
          }
        >
          <ProductMigrationWizard
            isOpen={showMigrateMembers}
            onClose={() => setShowMigrateMembers(false)}
            products={migrateWizardProducts}
          />
        </Suspense>
      ) : null}

      {/* Add/Edit Product Wizard (lazy — see AddProductWizard const above) */}
      {showAddProduct ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30">
              <Loader2 className="h-10 w-10 animate-spin text-oe-primary" aria-hidden />
            </div>
          }
        >
          <AddProductWizard
            isOpen={showAddProduct}
            onClose={handleCloseWizard}
            onSave={handleSaveProduct}
            editingProduct={editingProduct}
            isTenantAdmin={true}
          />
        </Suspense>
      ) : null}

      {/* Add/Edit Bundle Wizard */}

      <AddBundleWizard
        isOpen={showAddBundle}
        onClose={handleCloseBundleWizard}
        onComplete={() => {}} // Not used in this implementation
        onCancel={handleCloseBundleWizard}
        onSave={handleSaveBundle}
        editingBundle={editingBundle}
        bundleProductCatalog={showAddBundle ? bundleWizardCatalog : undefined}
        bundleProductCatalogLoading={showAddBundle ? bundleWizardCatalogLoading : false}
      />


      {showDeleteConfirm && productToDelete && (() => {
        const blockedReason = getDeleteBlockedReason(productToDelete);
        const deletable = isProductDeletable(productToDelete);
        return (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-lg p-6 max-w-md w-full">
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                {deletable && !deleteError ? 'Delete Product' : 'Cannot Delete Product'}
              </h3>
              <p className="text-sm text-gray-600 mb-4">
                {deletable && !deleteError ? (
                  <>
                    Are you sure you want to permanently delete &ldquo;{productToDelete.Name || productToDelete.name}&rdquo;?
                    This action cannot be undone.
                  </>
                ) : (
                  <>
                    &ldquo;{productToDelete.Name || productToDelete.name}&rdquo; cannot be deleted.
                  </>
                )}
              </p>
              {deletable && !deleteError && (
                <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                  No enrollments are attached to this product. It can be permanently deleted.
                </div>
              )}
              {(blockedReason || deleteError) && (
                <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {deleteError || blockedReason}
                </div>
              )}
              <div className="flex justify-end space-x-3">
                <button
                  onClick={handleCloseDeleteConfirm}
                  disabled={isDeleting}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                >
                  {deletable && !deleteError ? 'Cancel' : 'Close'}
                </button>
                {deletable && !deleteError && (
                  <button
                    onClick={confirmDeleteProduct}
                    disabled={isDeleting}
                    className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
                  >
                    {isDeleting ? 'Deleting...' : 'Delete'}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

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

// Product Card Component
interface ProductCardProps {
  product: SubscribedProduct | MarketplaceProduct | any;
  onAction?: (product: any) => void;
  actionLabel?: string;
  actionIcon?: React.ReactNode;
  showConfig?: boolean;
  onConfigure?: (product: any) => void;
  onViewDetails?: (product: any) => void;
  onEditProduct?: (product: any) => void;
  onApiConfig?: (product: any) => void;
  onDeleteProduct?: (product: any) => void;
  canDeleteProduct?: (product: any) => boolean;
  onRemove?: (subscriptionId: string) => void;
  canUnsubscribeProduct?: (product: any) => boolean;
  currentTenantId?: string;
  ownershipType?: 'owner' | 'subscriber';
}

const ProductCard: React.FC<ProductCardProps> = ({
  product,
  onAction,
  actionLabel,
  actionIcon,
  showConfig,
  onConfigure,
  onViewDetails,
  onEditProduct,
  onApiConfig,
  onDeleteProduct,
  canDeleteProduct,
  onRemove,
  canUnsubscribeProduct,
  currentTenantId,
  ownershipType
}) => {
  const [showBundleProducts, setShowBundleProducts] = useState(false);
  const productLogoUrl =
    product?.productLogoUrl ||
    product?.ProductLogoUrl ||
    product?.logoUrl ||
    product?.LogoUrl ||
    product?.media?.logoUrl ||
    product?.product?.productLogoUrl ||
    product?.product?.ProductLogoUrl;

  const productName = product?.Name || product?.name || 'Product';
  
  const ownerId = product.productOwnerId || product.ProductOwnerId;
  const isOwnedProduct = ownershipType === 'owner' ||
    Boolean(ownerId && currentTenantId && ownerId === currentTenantId);

  const hasPrimaryActions = Boolean(
    (showConfig && onConfigure) ||
    (onAction && actionLabel)
  );

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow overflow-hidden flex flex-col h-full">
      {/* Product Header with Logo */}
      <div className="bg-gradient-to-r from-oe-primary/10 to-oe-primary/5 p-6">
        <div className="flex items-start space-x-4">
          <div className="h-16 w-32 flex-shrink-0">
            {productLogoUrl ? (
              <img 
                src={productLogoUrl} 
                alt={productName}
                className="h-full w-full rounded-lg object-contain bg-white p-1"
              />
            ) : (
              <div className="h-full w-full bg-white rounded-lg flex items-center justify-center">
                <Package className="h-8 w-8 text-oe-primary" />
              </div>
            )}
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-1.5">
              {productName}
              {(product.IsHidden === true || product.IsHidden === 1 || product.isHidden === true || product.isHidden === 1) && (
                <EyeOff className="h-4 w-4 text-gray-500 flex-shrink-0" title="Hidden" />
              )}
            </h3>
            {!(product.IsBundle || product.isBundle) && (
              <p className="text-sm text-gray-600">{product.productType || product.Type}</p>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col flex-1 justify-between p-6">
        <div className="space-y-4">
          {(product.salesType || product.SalesType) && (
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                (product.salesType || product.SalesType) === 'Individual' 
                  ? 'bg-indigo-100 text-indigo-800' 
                  : (product.salesType || product.SalesType) === 'Group'
                  ? 'bg-orange-100 text-orange-800'
                  : 'bg-teal-100 text-teal-800'
              }`}>
                {(product.salesType || product.SalesType) === 'Individual' ? (
                  <>
                    <User className="h-3 w-3 mr-1" />
                    Individual
                  </>
                ) : (product.salesType || product.SalesType) === 'Group' ? (
                  <>
                    <Users className="h-3 w-3 mr-1" />
                    Group
                  </>
                ) : (
                  <>
                    <Users className="h-3 w-3 mr-1" />
                    Both
                  </>
                )}
              </span>
            </div>
          )}

          {product.description && (
            <p className="text-sm text-gray-700 line-clamp-2">{product.description}</p>
          )}

          {/* Bundle Products List - expandable for full list */}
          {product.IsBundle && product.bundleProducts && product.bundleProducts.length > 0 && (
            <div className="border-t border-gray-100 pt-4">
              <button
                onClick={() => setShowBundleProducts(!showBundleProducts)}
                className="flex items-center justify-between w-full text-sm font-medium text-gray-900 hover:text-oe-primary transition-colors"
              >
                <span className="flex items-center text-gray-600">
                  <Layers className="h-4 w-4 mr-2" />
                  {product.bundleProducts.slice(0, 3).map((bp: any) => bp.name || bp.Name).filter(Boolean).join(', ')}
                  {product.bundleProducts.length > 3 && ` +${product.bundleProducts.length - 3} more`}
                </span>
                {showBundleProducts ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </button>
              
              {showBundleProducts && (
                <div className="mt-3 space-y-2 pl-6">
                  {product.bundleProducts.map((bundleProduct: any) => (
                    <div key={bundleProduct.productId} className="flex items-center text-sm">
                      <div className="h-1.5 w-1.5 bg-gray-400 rounded-full mr-3"></div>
                      <div className="flex-1">
                        <span className="text-gray-900 font-medium">{bundleProduct.name}</span>
                        <span className="text-gray-500 ml-2">({bundleProduct.productType})</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Product Details */}
          <div className="space-y-3">
            {/* Age Range */}
            {'minAge' in product && product.minAge && product.maxAge && (
              <div className="flex items-start space-x-2">
                <Users className="h-4 w-4 text-gray-400 mt-0.5" />
                <div>
                  <p className="text-xs text-gray-500">Age Range:</p>
                  <p className="text-sm text-gray-700">{product.minAge} - {product.maxAge} years</p>
                </div>
              </div>
            )}

            {/* Provider - tenant name */}
            <div className="flex items-start space-x-2">
              <Building className="h-4 w-4 text-gray-400 mt-0.5" />
              <div>
                <p className="text-xs text-gray-500">Provider:</p>
                <p className="text-sm text-gray-700">{product.productOwner?.tenantName || '-'}</p>
              </div>
            </div>

            {/* Vendor - carrier (only show when present) */}
            {(product.vendorName || product.VendorName) && (
              <div className="flex items-start space-x-2">
                <Building className="h-4 w-4 text-gray-400 mt-0.5" />
                <div>
                  <p className="text-xs text-gray-500">Vendor:</p>
                  <p className="text-sm text-gray-700">{product.vendorName || product.VendorName}</p>
                </div>
              </div>
            )}

            {/* Subscription Status - only show when inactive (not Active) */}
            {'subscriptionStatus' in product && product.subscriptionStatus && product.subscriptionStatus !== 'Active' && (
              <div className="flex items-start space-x-2">
                <CheckCircle className="h-4 w-4 text-gray-400 mt-0.5" />
                <div>
                  <p className="text-xs text-gray-500">Status:</p>
                  <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                    product.subscriptionStatus === 'Pending' ? 'bg-yellow-100 text-yellow-800' :
                    'bg-gray-100 text-gray-800'
                  }`}>
                    {product.subscriptionStatus}
                  </span>
                </div>
              </div>
            )}

            {/* Setup Fee for subscribed products and owned products (owners are auto-subscribed) */}
            {(ownershipType === 'subscriber' || ownershipType === 'owner') && 'setupFee' in product && (
              <div className="flex items-start space-x-2">
                <DollarSign className="h-4 w-4 text-gray-400 mt-0.5" />
                <div>
                  <p className="text-xs text-gray-500">Setup Fee:</p>
                  <p className="text-sm text-gray-700 font-medium">
                    {product.setupFee !== null && product.setupFee !== undefined 
                      ? `$${(product.setupFee || 0).toFixed(2)}` 
                      : 'Not set'}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="pt-4 space-y-2">
          {/* Primary Actions: Request Access, etc. */}
          {onAction && actionLabel && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => onAction(product)}
                className="inline-flex items-center px-3 py-2 bg-oe-primary text-white rounded-md text-sm font-medium hover:bg-oe-primary-dark transition-colors"
              >
                {actionIcon}
                {actionLabel}
              </button>
            </div>
          )}

          {/* Secondary Actions: Edit, Configure, Details */}
          <div className="flex flex-wrap gap-2">
            {isOwnedProduct && onEditProduct && (
              <button
                onClick={() => onEditProduct(product)}
                className="btn-secondary text-sm inline-flex items-center px-3 py-2"
              >
                <Settings className="h-4 w-4 mr-2" />
                Edit
              </button>
            )}

            {isOwnedProduct && onApiConfig && !(product.IsBundle || product.isBundle) && (
              <button
                onClick={() => onApiConfig(product)}
                className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-purple-700 bg-white hover:bg-purple-50 transition-colors"
              >
                <Webhook className="h-4 w-4 mr-2" />
                API
              </button>
            )}

            {showConfig && onConfigure && (
              <button
                onClick={() => onConfigure(product)}
                className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors"
              >
                <Settings className="h-4 w-4 mr-2" />
                Configure
              </button>
            )}

            {/* Always show Details button if onViewDetails is provided */}
            {onViewDetails && (
              <button
                onClick={() => onViewDetails(product)}
                className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors"
              >
                <Eye className="h-4 w-4 mr-2" />
                Details
              </button>
            )}

            {onDeleteProduct && canDeleteProduct?.(product) && (
              <button
                onClick={() => onDeleteProduct(product)}
                className="inline-flex items-center justify-center p-2 border border-red-200 rounded-md text-red-600 bg-white hover:bg-red-50 transition-colors"
                title="Delete product"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}

            {onRemove && canUnsubscribeProduct?.(product) && (
              <button
                onClick={() => onRemove(String(product.subscriptionId || product.SubscriptionId))}
                className="inline-flex items-center justify-center p-2 border border-red-200 rounded-md text-red-600 bg-white hover:bg-red-50 transition-colors"
                title="Remove from your tenant"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}

          </div>
        </div>
      </div>
    </div>
  );
};

// Marketplace Tab Component
interface MarketplaceTabProps {
  products: MarketplaceProduct[];
  loading: boolean;
  searchTerm: string;
  selectedProductType: string;
  selectedSalesType: string;
  selectedVendor: string;
  selectedIsHidden: 'all' | 'showHidden' | 'hideHidden';
  productTypes: string[];
  vendors: string[];
  onSearchChange: (term: string) => void;
  onProductTypeChange: (type: string) => void;
  onSalesTypeChange: (type: string) => void;
  onVendorChange: (vendor: string) => void;
  onIsHiddenChange: (value: 'all' | 'showHidden' | 'hideHidden') => void;
  onRequestProduct: (product: MarketplaceProduct) => void;
}

const MarketplaceTab: React.FC<MarketplaceTabProps> = ({
  products,
  loading,
  searchTerm,
  selectedProductType,
  selectedSalesType,
  selectedVendor,
  selectedIsHidden,
  productTypes,
  vendors,
  onSearchChange,
  onProductTypeChange,
  onSalesTypeChange,
  onVendorChange,
  onIsHiddenChange,
  onRequestProduct
}) => {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Enhanced Filters */}
      <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
        <div className="space-y-4">
          {/* Search and Type Filter Row */}
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search products by name, description, type, or provider..."
                  value={searchTerm}
                  onChange={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onSearchChange(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                  }}
                  className="w-full pl-10 pr-10 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary bg-white"
                  autoComplete="off"
                />
                {searchTerm && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onSearchChange('');
                    }}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 z-10"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            
            {/* Sales Type Filter */}
            <div className="sm:w-48">
              <select
                value={selectedSalesType}
                onChange={(e) => onSalesTypeChange(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="">Group & Individual</option>
                <option value="Individual">Individual Only</option>
                <option value="Group">Group Only</option>
              </select>
            </div>

            {/* Vendor Filter */}
            {vendors.length > 0 && (
              <div className="sm:w-48">
                <select
                  value={selectedVendor}
                  onChange={(e) => onVendorChange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="">All Vendors</option>
                  {vendors.map((vendor, index) => (
                    <option key={`vendor-${vendor}-${index}`} value={vendor}>{vendor}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Advanced Filters - Shown conditionally */}
            {showAdvancedFilters && (
              <div className="sm:w-48">
                <select
                  value={selectedProductType}
                  onChange={(e) => onProductTypeChange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="">All Product Types</option>
                  {productTypes.map((type, index) => (
                    <option key={`product-type-${type}-${index}`} value={type}>{type}</option>
                  ))}
                </select>
              </div>
            )}

            {/* IsHidden Filter */}
            <div className="sm:w-48">
              <select
                value={selectedIsHidden}
                onChange={(e) => onIsHiddenChange(e.target.value as 'all' | 'showHidden' | 'hideHidden')}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="all">Show All</option>
                <option value="hideHidden">Hide Hidden</option>
                <option value="showHidden">Show Hidden</option>
              </select>
            </div>

            {/* Advanced Filters Toggle Button */}
            <button
              onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
              className="inline-flex items-center px-3 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              {showAdvancedFilters ? (
                <>
                  <X className="h-4 w-4 mr-1" />
                  Hide Advanced
                </>
              ) : (
                <>
                  <Filter className="h-4 w-4 mr-1" />
                  Advanced Filters
                </>
              )}
            </button>

            {/* View mode toggle */}
            <div className="flex border border-gray-300 rounded-lg overflow-hidden">
              <button
                onClick={() => setViewMode('grid')}
                className={`p-2 ${viewMode === 'grid' ? 'bg-oe-primary text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                title="Grid view"
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-2 ${viewMode === 'list' ? 'bg-oe-primary text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                title="List view"
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Clear Filters */}
          {(searchTerm || selectedProductType || selectedSalesType || selectedVendor || selectedIsHidden !== 'all') && (
            <div className="flex items-center">
              <button
                onClick={() => {
                  onSearchChange('');
                  onProductTypeChange('');
                  onSalesTypeChange('');
                  onVendorChange('');
                  onIsHiddenChange('all');
                }}
                className="inline-flex items-center px-3 py-1 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50"
              >
                <X className="h-3 w-3 mr-1" />
                Clear Filters
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Products Grid or List */}
      {products.length === 0 ? (
        <div className="text-center py-12">
          <Package className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No products found</h3>
          <p className="text-gray-600">
            Try adjusting your search terms or filters
          </p>
        </div>
      ) : viewMode === 'list' ? (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Vendor</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Provider</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Availability</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {products.map((product) => {
                const productName = product?.Name || 'Product';
                const productLogoUrl = product?.productLogoUrl;
                const isHidden = (product as any).IsHidden === true || (product as any).IsHidden === 1 || (product as any).isHidden === true || (product as any).isHidden === 1;
                return (
                  <tr key={product.productId} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-16 flex-shrink-0">
                          {productLogoUrl ? (
                            <img src={productLogoUrl} alt={productName} className="h-full w-full rounded object-contain bg-gray-50 p-1" />
                          ) : (
                            <div className="h-full w-full bg-gray-100 rounded flex items-center justify-center">
                              <Package className="h-5 w-5 text-gray-400" />
                            </div>
                          )}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900 flex items-center gap-1.5">
                            {productName}
                            {isHidden && <EyeOff className="h-4 w-4 text-gray-500 flex-shrink-0" title="Hidden" />}
                          </p>
                          {!(product.IsBundle || (product as any).isBundle) && (
                            <p className="text-xs text-gray-500">{product.productType || '-'}</p>
                          )}
                          {product.IsBundle && product.bundleProducts && product.bundleProducts.length > 0 && (
                            <p className="text-xs text-gray-500 mt-0.5">
                              Includes: {product.bundleProducts.slice(0, 3).map((bp: any) => bp.name || bp.Name).filter(Boolean).join(', ')}
                              {product.bundleProducts.length > 3 && ` +${product.bundleProducts.length - 3} more`}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">{(product as any).vendorName || (product as any).VendorName || '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{product.productOwner?.tenantName || '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{product.SalesType || product.salesType || '-'}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => onRequestProduct(product)}
                        className="inline-flex items-center px-3 py-1.5 bg-oe-primary text-white rounded text-sm font-medium hover:bg-oe-primary-dark"
                      >
                        <Send className="h-3 w-3 mr-1" />
                        Request Access
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {products.map((product) => (
            <ProductCard
              key={product.productId}
              product={product}
              onAction={onRequestProduct}
              actionLabel="Request Access"
              actionIcon={<Send className="h-4 w-4 mr-2" />}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// Subscribe Product Modal Component - WITHOUT DISCOUNT OPTIONS
interface SubscribeProductModalProps {
  product: MarketplaceProduct;
  onClose: () => void;
  onSubmit: (request: ProductRequest) => void;
}

const SubscribeProductModal: React.FC<SubscribeProductModalProps> = ({ product, onClose, onSubmit }) => {
  const [formData, setFormData] = useState({
    message: ''
  });

  // Use actual pricing tiers from product
  const pricingTiers = product.pricingTiers || [];
  const hasPricingData = pricingTiers.length > 0;

  const handleSubmit = () => {
    const request: ProductRequest = {
      productId: product.productId,
      discountType: 'percent', // Default value, not used but may be required by API
      requestedDiscount: 0, // No discount requested
      message: formData.message,
      discountJustification: formData.message
    };

    onSubmit(request);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-900">Subscribe to Product</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
              <XCircle className="h-6 w-6" />
            </button>
          </div>

          {/* Product Summary */}
          <div className="bg-gradient-to-r from-oe-primary/10 to-oe-primary/5 p-4 rounded-lg mb-6">
            <div className="flex items-center space-x-4">
              <div className="h-16 w-32 flex-shrink-0">
                {product.productLogoUrl ? (
                  <img 
                    src={product.productLogoUrl} 
                    alt={product.Name}
                    className="h-full w-full rounded-lg object-contain bg-white p-1"
                  />
                ) : (
                  <div className="h-full w-full bg-white rounded-lg flex items-center justify-center">
                    <Package className="h-8 w-8 text-oe-primary" />
                  </div>
                )}
              </div>
              <div>
                <h3 className="text-lg font-medium text-gray-900">{product.Name}</h3>
                <p className="text-sm text-gray-600">{product.productType} • {product.productOwner.tenantName}</p>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            {/* Pricing Information */}
            {hasPricingData ? (
              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-3">Pricing Information</h4>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Age Band</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tier Type</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tobacco Status</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Monthly Rate</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {pricingTiers.map((tier, index) => (
                        <tr key={index} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                          <td className="px-4 py-3 text-sm text-gray-900">{tier.minAge}-{tier.maxAge}</td>
                          <td className="px-4 py-3 text-sm text-gray-900">{tier.tierType}</td>
                          <td className="px-4 py-3 text-sm text-gray-900">{tier.tobaccoStatus}</td>
                          <td className="px-4 py-3 text-sm text-gray-900 text-right font-medium">
                            ${(tier.rate || 0).toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="bg-gray-50 rounded-lg p-6 text-center">
                <p className="text-sm text-gray-600">Detailed pricing information not available</p>
                <p className="text-xs text-gray-500 mt-1">Starting at ${(product.basicPrice || 0).toFixed(2)}/month</p>
              </div>
            )}

            {/* Message */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Message to Product Owner (Optional)
              </label>
              <textarea
                rows={4}
                value={formData.message}
                onChange={(e) => setFormData(prev => ({ ...prev, message: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                placeholder="Additional information about your subscription request..."
              />
            </div>

            {/* Submit Section */}
            <div className="flex justify-end space-x-3 pt-6 border-t">
              <button
                type="button"
                onClick={onClose}
                className="btn-secondary text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                className="btn-primary text-sm inline-flex items-center"
              >
                <Send className="h-4 w-4 mr-2" />
                Submit Registration Request
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// Note: SubscribedProductsTab has been consolidated into UnifiedProductsTab

// Configure Product Modal Component
interface ConfigureProductModalProps {
  product: SubscribedProduct;
  currentTenantId?: string;
  onClose: () => void;
  onSubmit: (
    subscriptionOrProductId: string,
    profitMargin: number,
    setupFee?: number | null,
    includeProcessingFee?: boolean,
    roundUpProcessingFee?: boolean,
    customSystemFeeEnabled?: boolean,
    customSystemFeeAmount?: number | null,
    mustBeSoldWithProductIds?: string[],
    zeroFeeForACH?: boolean
  ) => void;
  tenantMinimumSetupFee?: number | null;
  /** Other products/bundles that can be selected as "must be sold with" (excludes current product) */
  availableProductsForMustBeSoldWith?: Array<{ ProductId: string; Name: string; IsBundle?: boolean }>;
}

const ConfigureProductModal: React.FC<ConfigureProductModalProps> = ({ product, onClose, onSubmit, tenantMinimumSetupFee, availableProductsForMustBeSoldWith = [] }) => {
  const [profitMargin, setProfitMargin] = useState(product.profitMargin?.toString() || '');
  const [staticGroupId, setStaticGroupId] = useState(product.staticGroupId || '');
  const [mustBeSoldWithEnabled, setMustBeSoldWithEnabled] = useState<boolean>(Boolean((product as any).mustBeSoldWithProductIds?.length));
  const [mustBeSoldWithProductIds, setMustBeSoldWithProductIds] = useState<string[]>((product as any).mustBeSoldWithProductIds ?? []);
  const [addProductDropdownValue, setAddProductDropdownValue] = useState('');
  const [showGroupIdOnIDCard, setShowGroupIdOnIDCard] = useState(() => {
    // Handle boolean conversion for ShowGroupIdOnIDCard (can be boolean, 1/0, or undefined)
    const value = product.showGroupIdOnIDCard;
    if (value === true) return true;
    if (typeof value === 'number' && value === 1) return true;
    if (typeof value === 'string' && (value === 'true' || value === '1')) return true;
    return false;
  });
  const [setupFee, setSetupFee] = useState(product.setupFee?.toString() || '');
  const [setupFeeError, setSetupFeeError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [zeroFeeForACH, setZeroFeeForACH] = useState<boolean>((product as any).zeroFeeForACH === true);
  const [customSystemFeeEnabled, setCustomSystemFeeEnabled] = useState<boolean>(product.customSystemFeeEnabled === true);
  const [customSystemFeeAmount, setCustomSystemFeeAmount] = useState<string>(
    product.customSystemFeeAmount != null ? String(product.customSystemFeeAmount) : ''
  );
  
  // Update state when product prop changes (e.g., when reopening modal with updated data)
  useEffect(() => {
    console.log('🔄 ConfigureProductModal: Product prop changed', {
      subscriptionId: product.subscriptionId,
      showGroupIdOnIDCard: product.showGroupIdOnIDCard,
      type: typeof product.showGroupIdOnIDCard
    });
    
    setProfitMargin(product.profitMargin?.toString() || '');
    setStaticGroupId(product.staticGroupId || '');
    
    // Handle boolean conversion for ShowGroupIdOnIDCard (can be boolean, 1/0, or undefined)
    const value = product.showGroupIdOnIDCard;
    let showGroupId = false;
    if (value === true) showGroupId = true;
    else if (typeof value === 'number' && value === 1) showGroupId = true;
    else if (typeof value === 'string' && (value === 'true' || value === '1')) showGroupId = true;
    console.log('🔄 Setting showGroupIdOnIDCard:', { value, converted: showGroupId });
    setShowGroupIdOnIDCard(showGroupId);
    
    setSetupFee(product.setupFee?.toString() || '');
    setSetupFeeError(null);
    setIsSubmitting(false);
    setZeroFeeForACH((product as any).zeroFeeForACH === true);
    setCustomSystemFeeEnabled(product.customSystemFeeEnabled === true);
    setCustomSystemFeeAmount(product.customSystemFeeAmount != null ? String(product.customSystemFeeAmount) : '');
    setMustBeSoldWithEnabled(Boolean((product as any).mustBeSoldWithProductIds?.length));
    setMustBeSoldWithProductIds((product as any).mustBeSoldWithProductIds ?? []);
  }, [product.subscriptionId, product.showGroupIdOnIDCard, product.staticGroupId, product.setupFee, product.profitMargin, product.customSystemFeeEnabled, product.customSystemFeeAmount, (product as any).zeroFeeForACH, (product as any).mustBeSoldWithProductIds]);

  const handleSubmit = async () => {
    // Validate setup fee
    const feeValue = setupFee.trim() === '' ? null : parseFloat(setupFee);
    
    if (feeValue !== null) {
      if (isNaN(feeValue) || feeValue < 0) {
        setSetupFeeError('Setup fee must be a non-negative number');
        return;
      }
      
      if (tenantMinimumSetupFee !== null && tenantMinimumSetupFee !== undefined && feeValue < tenantMinimumSetupFee) {
        setSetupFeeError(`Setup fee must be at least $${tenantMinimumSetupFee.toFixed(2)} (tenant minimum)`);
        return;
      }
    }
    
    setSetupFeeError(null);
    setIsSubmitting(true);
    try {
      const effectiveCustomSystemFeeAmount = customSystemFeeEnabled && customSystemFeeAmount.trim() !== ''
        ? Math.max(0, parseFloat(customSystemFeeAmount) || 0)
        : null;
      const routeId =
        product.subscriptionId ||
        product.productId ||
        (product as { ProductId?: string }).ProductId;
      if (!routeId) {
        setSetupFeeError('Missing product id — cannot save configuration');
        return;
      }
      await onSubmit(
        routeId,
        parseFloat(profitMargin) || 0,
        feeValue,
        false,
        false,
        customSystemFeeEnabled,
        effectiveCustomSystemFeeAmount,
        mustBeSoldWithEnabled ? mustBeSoldWithProductIds : [],
        zeroFeeForACH === true
      );
    } catch (_error) {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-900">Product Configuration</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
              <XCircle className="h-6 w-6" />
            </button>
          </div>

          <div className="bg-gray-50 p-4 rounded-lg mb-6">
            <h3 className="text-lg font-medium text-gray-900 mb-2">{product.Name}</h3>
            <p className="text-sm text-gray-600">{product.productType}</p>
          </div>

          <div className="space-y-6">
            <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
              <h4 className="font-medium text-gray-900">Profit Margin</h4>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Your Profit Margin ($) *
                </label>
                <input
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  value={profitMargin}
                  onChange={(e) => setProfitMargin(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="Enter your profit margin amount"
                />
              </div>
            </div>

            {/* Setup Fee Configuration */}
            <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
              <h4 className="font-medium text-gray-900">Setup Fee</h4>
              
              <div>
                {tenantMinimumSetupFee !== null && tenantMinimumSetupFee !== undefined && (
                  <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-sm text-blue-800">
                      <strong>Minimum Setup Fee:</strong> ${tenantMinimumSetupFee.toFixed(2)}
                    </p>
                  </div>
                )}

                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Amount
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                  <input
                    type="number"
                    value={setupFee}
                    onChange={(e) => {
                      setSetupFee(e.target.value);
                      setSetupFeeError(null);
                    }}
                    className={`w-full px-3 py-2 pl-8 border rounded-md focus:ring-oe-primary focus:border-oe-primary ${
                      setupFeeError ? 'border-red-300' : 'border-gray-300'
                    }`}
                    placeholder="0.00"
                    step="0.01"
                    min="0"
                  />
                </div>

                {setupFeeError && (
                  <div className="mt-2 flex items-start space-x-2 p-2 bg-red-50 border border-red-200 rounded">
                    <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-red-800">{setupFeeError}</p>
                  </div>
                )}
              </div>
            </div>

            {/* ACH processing fee override */}
            <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
              <h4 className="font-medium text-gray-900">Payment Processing</h4>
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={zeroFeeForACH}
                  onChange={(e) => setZeroFeeForACH(e.target.checked)}
                  className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                />
                <span className="text-sm font-medium text-gray-700">
                  Zero processing fee for ACH payments
                </span>
              </label>
              <p className="text-xs text-gray-600 pl-6">
                When enabled, this product&apos;s processing fee is $0 when paid by ACH. Credit card payments still incur the tenant&apos;s configured CC fee.
              </p>
            </div>

            {/* Custom System Fee */}
            <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
              <h4 className="font-medium text-gray-900">Custom System Fee</h4>
              <p className="text-sm text-gray-600">
                When enabled, this product uses a flat system fee amount instead of the tenant-level member-charged system fee. If multiple selected products have a custom system fee, the highest amount is used.
              </p>
              <div className="space-y-3">
                <label className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={customSystemFeeEnabled}
                    onChange={(e) => setCustomSystemFeeEnabled(e.target.checked)}
                    className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    Use custom system fee for this product
                  </span>
                </label>
                {customSystemFeeEnabled && (
                  <div className="pl-6">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Custom system fee amount ($)
                    </label>
                    <div className="relative max-w-xs">
                      <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={customSystemFeeAmount}
                        onChange={(e) => setCustomSystemFeeAmount(e.target.value)}
                        className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ID Card Group ID Settings — configure on product wizard Step 7 (product-level). Subscription DB columns kept for possible future use. */}
            {false && (
            <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
              <h4 className="font-medium text-gray-900">ID Card Group ID Settings</h4>
              <div className="space-y-4">
                <div>
                  <label className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={showGroupIdOnIDCard}
                      onChange={(e) => setShowGroupIdOnIDCard(e.target.checked)}
                      className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                    />
                    <span className="text-sm font-medium text-gray-700">Show Group ID on ID Cards</span>
                  </label>
                </div>
                <div>
                  <input
                    type="text"
                    value={staticGroupId}
                    onChange={(e) => setStaticGroupId(e.target.value)}
                  />
                </div>
              </div>
            </div>
            )}

            {/* Must be sold with (at least one of) */}
            <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
              <h4 className="font-medium text-gray-900">Must be sold with (at least one of)</h4>
              <p className="text-sm text-gray-600">
                When enabled, this product cannot be purchased alone; at least one of the selected products must also be in the cart.
              </p>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={mustBeSoldWithEnabled}
                  onChange={(e) => setMustBeSoldWithEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                />
                <span className="text-sm font-medium text-gray-700">Must be sold with at least one of the following (cannot be purchased alone)</span>
              </label>
              {mustBeSoldWithEnabled && (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-gray-500">Select one or more products; this product can only be purchased when at least one of them is also in the cart.</p>
                  {availableProductsForMustBeSoldWith.length > 0 ? (
                    <>
                      <div className="flex flex-wrap gap-2">
                        {mustBeSoldWithProductIds.map((id) => {
                          const option = availableProductsForMustBeSoldWith.find((p) => (p.ProductId || (p as any).productId) === id);
                          const name = option?.Name ?? (product as any).mustBeSoldWithProductNames?.[mustBeSoldWithProductIds.indexOf(id)] ?? id;
                          const label = option?.IsBundle ? `📦 ${name}` : name;
                          return (
                            <span
                              key={id}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-blue-50 text-blue-800 text-sm"
                            >
                              {label}
                              <button
                                type="button"
                                onClick={() => setMustBeSoldWithProductIds((prev) => prev.filter((x) => x !== id))}
                                className="text-blue-600 hover:text-blue-800"
                                aria-label="Remove"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                      <div className="flex gap-2 items-center">
                        <div className="flex-1 min-w-0">
                          <SearchableDropdown
                            options={availableProductsForMustBeSoldWith
                              .filter((p) => !mustBeSoldWithProductIds.includes(p.ProductId))
                              .map((p) => ({ id: p.ProductId, label: p.IsBundle ? `📦 ${p.Name}` : p.Name, value: p.ProductId }))}
                            value={addProductDropdownValue}
                            onChange={(value) => {
                              if (value && !mustBeSoldWithProductIds.includes(value)) {
                                setMustBeSoldWithProductIds((prev) => [...prev, value]);
                                setAddProductDropdownValue('');
                              }
                            }}
                            placeholder="Add product or bundle..."
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-gray-500">No other products available to select.</p>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end space-x-3 pt-6 border-t">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="btn-secondary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="btn-primary text-sm inline-flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                    Saving...
                  </>
                ) : (
                  <>
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Save Changes
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

interface ConfigureBundleModalProps {
  bundle: SubscribedProduct;
  onClose: () => void;
  onConfigureIncluded: (included: BundleProduct) => void;
}

const ConfigureBundleModal: React.FC<ConfigureBundleModalProps> = ({ bundle, onClose, onConfigureIncluded }) => {
  const includedProducts = bundle.bundleProducts || [];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Configure Bundle</h2>
              <p className="text-sm text-gray-600 mt-1">
                Bundles don&apos;t have ID cards. Configure the included products below.
              </p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
              <XCircle className="h-6 w-6" />
            </button>
          </div>

          <div className="bg-gray-50 p-4 rounded-lg mb-6">
            <h3 className="text-lg font-medium text-gray-900 mb-1">{bundle.Name}</h3>
            <p className="text-sm text-gray-600">{bundle.productType}</p>
          </div>

          {includedProducts.length === 0 ? (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
              No included products found for this bundle.
            </div>
          ) : (
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Subscription</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {includedProducts
                    .slice()
                    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
                    .map((p) => {
                      const canConfigure = Boolean(p.subscriptionId);
                      return (
                        <tr key={p.productId}>
                          <td className="px-4 py-3">
                            <div className="text-sm font-medium text-gray-900">{p.name}</div>
                            {p.description && <div className="text-xs text-gray-500 mt-1">{p.description}</div>}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700">{p.productType}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">
                            {p.subscriptionStatus || (canConfigure ? 'Active' : 'Not Subscribed')}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => onConfigureIncluded(p)}
                              disabled={!canConfigure}
                              className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Settings className="h-4 w-4 mr-2" />
                              Configure
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-end pt-6 border-t mt-6">
            <button onClick={onClose} className="btn-secondary text-sm">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Unified Products Tab Component (Owned + Subscribed)
interface UnifiedProductsTabProps {
  productCategoryTab: 'products' | 'bundles';
  products: any[];
  loading: boolean;
  searchTerm: string;
  selectedProductType: string;
  selectedStatus: string;
  selectedSalesType: string;
  selectedVendor: string;
  selectedIsHidden: 'all' | 'showHidden' | 'hideHidden';
  ownershipFilter: 'all' | 'owned' | 'subscribed';
  productTypes: string[];
  vendors: string[];
  statuses: string[];
  onSearchChange: (value: string) => void;
  onProductTypeChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onSalesTypeChange: (value: string) => void;
  onVendorChange: (value: string) => void;
  onIsHiddenChange: (value: 'all' | 'showHidden' | 'hideHidden') => void;
  onOwnershipFilterChange: (value: 'all' | 'owned' | 'subscribed') => void;
  onShowAICreator: () => void;
  onMigrateMembers?: () => void;
  onAddProduct: () => void;
  onAddBundle: () => void;
  onEditProduct: (product: any) => void;
  onApiConfig?: (product: any) => void;
  onDeleteProduct?: (product: any) => void;
  canDeleteProduct?: (product: any) => boolean;
  canUnsubscribeProduct?: (product: any) => boolean;
  onConfigure: (product: any) => void;
  onViewDetails: (product: any) => void;
  onRemove: (subscriptionId: string) => void;
  currentTenantId?: string;
}

const UnifiedProductsTab: React.FC<UnifiedProductsTabProps> = ({
  productCategoryTab,
  products,
  loading,
  searchTerm,
  selectedProductType,
  selectedStatus,
  selectedSalesType,
  selectedVendor,
  selectedIsHidden,
  ownershipFilter,
  productTypes,
  vendors,
  statuses,
  onSearchChange,
  onProductTypeChange,
  onStatusChange,
  onSalesTypeChange,
  onVendorChange,
  onIsHiddenChange,
  onOwnershipFilterChange,
  onShowAICreator,
  onMigrateMembers,
  onAddProduct,
  onAddBundle,
  onEditProduct,
  onApiConfig,
  onDeleteProduct,
  canDeleteProduct,
  canUnsubscribeProduct,
  onConfigure,
  onViewDetails,
  onRemove,
  currentTenantId
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(15);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // Calculate pagination
  const totalItems = products.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const currentProducts = products.slice(startIndex, endIndex);

  // Reset to first page when items per page changes
  const handleItemsPerPageChange = (newItemsPerPage: number) => {
    setItemsPerPage(newItemsPerPage);
    setCurrentPage(1);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
        <span className="ml-2 text-gray-600">Loading your products...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Search and Buttons Row */}
      <div className="flex items-center justify-between mb-4">
        {/* Search Input */}
        <div className="relative flex-1 max-w-md">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="h-4 w-4 text-gray-400" />
          </div>
          <input
            type="text"
            placeholder={productCategoryTab === 'bundles' ? 'Search bundles...' : 'Search products...'}
            value={searchTerm}
            onChange={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSearchChange(e.target.value);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
            }}
            className="w-full pl-10 pr-10 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary bg-white"
            autoComplete="off"
          />
          {searchTerm && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSearchChange('');
              }}
              className="absolute inset-y-0 right-0 pr-3 flex items-center z-10"
            >
              <X className="h-4 w-4 text-gray-400 hover:text-gray-600" />
            </button>
          )}
        </div>

        {/* Add Product Buttons */}
        <div className="flex items-center space-x-3">
          {productCategoryTab === 'products' && (
            <>
              <button
                onClick={onShowAICreator}
                className="inline-flex items-center px-4 py-2 bg-gradient-to-r from-purple-600 to-blue-600 text-white text-sm font-medium rounded-md hover:from-purple-700 hover:to-blue-700 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 transition-all duration-200"
              >
                <Sparkles className="h-4 w-4 mr-2" />
                Create with AI
              </button>
              {onMigrateMembers ? (
                <button
                  onClick={onMigrateMembers}
                  className="btn-secondary inline-flex items-center text-sm"
                  type="button"
                >
                  <ArrowRightLeft className="h-4 w-4 mr-2" />
                  Migrate Members
                </button>
              ) : null}
              <button
                onClick={onAddProduct}
                className="btn-primary inline-flex items-center text-sm"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add New Product
              </button>
            </>
          )}
          {productCategoryTab === 'bundles' && (
            <button
              onClick={onAddBundle}
              className="inline-flex items-center px-4 py-2 bg-oe-primary-dark text-white text-sm font-medium rounded-md hover:bg-oe-primary focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Package className="h-4 w-4 mr-2" />
              New Product Bundle
            </button>
          )}
        </div>
      </div>

      {/* Filters Row */}
      <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <div className="flex flex-col sm:flex-row gap-4 flex-1">
              {/* Sales Type Filter */}
              <div className="sm:w-48">
                <select
                  value={selectedSalesType}
                  onChange={(e) => onSalesTypeChange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="">Group & Individual</option>
                  <option value="Individual">Individual Only</option>
                  <option value="Group">Group Only</option>
                </select>
              </div>

              {/* Vendor Filter */}
              {vendors.length > 0 && (
                <div className="sm:w-48">
                  <select
                    value={selectedVendor}
                    onChange={(e) => onVendorChange(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="">All Vendors</option>
                    {vendors.map((vendor, index) => (
                      <option key={`vendor-${vendor}-${index}`} value={vendor}>{vendor}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Advanced Filters - Shown conditionally */}
              {showAdvancedFilters && (
                <>
                  {/* Product Type Filter - only on Products tab */}
                  {productCategoryTab === 'products' && (
                    <div className="sm:w-48">
                      <select
                        value={selectedProductType}
                        onChange={(e) => onProductTypeChange(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                      >
                        <option value="">All Product Types</option>
                        {productTypes.map((type, index) => (
                          <option key={`product-type-${type}-${index}`} value={type}>{type}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {/* Ownership Filter */}
                  <div className="sm:w-48">
                    <select
                      value={ownershipFilter}
                      onChange={(e) => onOwnershipFilterChange(e.target.value as 'all' | 'owned' | 'subscribed')}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                    >
                      <option value="all">All Products</option>
                      <option value="owned">Products I Own</option>
                      <option value="subscribed">Subscriptions</option>
                    </select>
                  </div>

                  {/* IsHidden Filter */}
                  <div className="sm:w-48">
                    <select
                      value={selectedIsHidden}
                      onChange={(e) => onIsHiddenChange(e.target.value as 'all' | 'showHidden' | 'hideHidden')}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                    >
                      <option value="all">Show All</option>
                      <option value="hideHidden">Hide Hidden</option>
                      <option value="showHidden">Show Hidden</option>
                    </select>
                  </div>
                </>
              )}
            </div>

            {/* Advanced Filters Toggle Button */}
            <button
              onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
              className="inline-flex items-center px-3 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              {showAdvancedFilters ? (
                <>
                  <X className="h-4 w-4 mr-1" />
                  Hide Advanced
                </>
              ) : (
                <>
                  <Filter className="h-4 w-4 mr-1" />
                  Advanced Filters
                </>
              )}
            </button>

            {/* View mode toggle */}
            <div className="flex border border-gray-300 rounded-lg overflow-hidden">
              <button
                onClick={() => setViewMode('grid')}
                className={`p-2 ${viewMode === 'grid' ? 'bg-oe-primary text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                title="Grid view"
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-2 ${viewMode === 'list' ? 'bg-oe-primary text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                title="List view"
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Clear Filters */}
          {(searchTerm || selectedProductType || selectedSalesType || selectedVendor || selectedIsHidden !== 'all' || ownershipFilter !== 'all') && (
            <div className="flex items-center">
              <button
                onClick={() => {
                  onSearchChange('');
                  onProductTypeChange('');
                  onSalesTypeChange('');
                  onVendorChange('');
                  onIsHiddenChange('all');
                  onOwnershipFilterChange('all');
                }}
                className="inline-flex items-center px-3 py-1 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md hover:bg-gray-50"
              >
                <X className="h-3 w-3 mr-1" />
                Clear Filters
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Products Grid */}
      {products.length === 0 ? (
        <div className="text-center py-12">
          <Package className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No {productCategoryTab === 'bundles' ? 'bundles' : 'products'} found</h3>
          <p className="text-gray-600">
            Try adjusting your search terms or filters
          </p>
        </div>
      ) : viewMode === 'list' ? (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Vendor</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Provider</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Availability</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {currentProducts.map((product) => {
                const productName = product?.Name || product?.name || 'Product';
                const productLogoUrl = product?.productLogoUrl || product?.ProductLogoUrl || product?.product?.productLogoUrl || product?.product?.ProductLogoUrl;
                const ownerId = product.productOwnerId || product.ProductOwnerId;
                const isOwnedProduct = product.ownershipType === 'owner' || Boolean(ownerId && currentTenantId && ownerId === currentTenantId);
                const isHidden = product.IsHidden === true || product.IsHidden === 1 || product.isHidden === true || product.isHidden === 1;
                return (
                  <tr key={product.subscriptionId || product.ProductId} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-16 flex-shrink-0">
                          {productLogoUrl ? (
                            <img src={productLogoUrl} alt={productName} className="h-full w-full rounded object-contain bg-gray-50 p-1" />
                          ) : (
                            <div className="h-full w-full bg-gray-100 rounded flex items-center justify-center">
                              <Package className="h-5 w-5 text-gray-400" />
                            </div>
                          )}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900 flex items-center gap-1.5">
                            {productName}
                            {isHidden && <EyeOff className="h-4 w-4 text-gray-500 flex-shrink-0" title="Hidden" />}
                          </p>
                          {!(product.IsBundle || product.isBundle) && (
                            <p className="text-xs text-gray-500">{product.ProductType || product.productType || '-'}</p>
                          )}
                          {product.IsBundle && product.bundleProducts && product.bundleProducts.length > 0 && (
                            <p className="text-xs text-gray-500 mt-0.5">
                              Includes: {product.bundleProducts.slice(0, 3).map((bp: any) => bp.name || bp.Name).filter(Boolean).join(', ')}
                              {product.bundleProducts.length > 3 && ` +${product.bundleProducts.length - 3} more`}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">{product.vendorName || product.VendorName || '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{product.productOwner?.tenantName || '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{product.SalesType || product.salesType || '-'}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-wrap gap-1 justify-end">
                        {isOwnedProduct && onEditProduct && (
                          <button onClick={() => onEditProduct(product)} className="inline-flex items-center px-2 py-1 border border-gray-300 rounded text-xs font-medium text-gray-700 hover:bg-gray-50">
                            <Settings className="h-3 w-3 mr-1" /> Edit
                          </button>
                        )}
                        {isOwnedProduct && onApiConfig && !(product.IsBundle || product.isBundle) && (
                          <button onClick={() => onApiConfig?.(product)} className="inline-flex items-center px-2 py-1 border border-purple-300 rounded text-xs font-medium text-purple-700 hover:bg-purple-50">
                            <Webhook className="h-3 w-3 mr-1" /> API
                          </button>
                        )}
                        {(product.ownershipType === 'subscriber' || product.ownershipType === 'owner') && (product.subscriptionStatus === 'Approved' || product.subscriptionStatus === 'Active') && onConfigure && (
                          <button onClick={() => onConfigure(product)} className="inline-flex items-center px-2 py-1 border border-gray-300 rounded text-xs font-medium text-gray-700 hover:bg-gray-50">
                            <Settings className="h-3 w-3 mr-1" /> Configure
                          </button>
                        )}
                        {onViewDetails && (
                          <button onClick={() => onViewDetails(product)} className="inline-flex items-center px-2 py-1 border border-gray-300 rounded text-xs font-medium text-gray-700 hover:bg-gray-50">
                            <Eye className="h-3 w-3 mr-1" /> Details
                          </button>
                        )}
                        {onDeleteProduct && canDeleteProduct?.(product) && (
                          <button
                            onClick={() => onDeleteProduct(product)}
                            className="inline-flex items-center px-2 py-1 border border-red-200 rounded text-xs font-medium text-red-700 hover:bg-red-50"
                            title="Delete product"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                        {onRemove && canUnsubscribeProduct?.(product) && (
                          <button
                            onClick={() => onRemove(String(product.subscriptionId || product.SubscriptionId))}
                            className="inline-flex items-center px-2 py-1 border border-red-200 rounded text-xs font-medium text-red-700 hover:bg-red-50"
                            title="Remove from your tenant"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {currentProducts.map((product) => (
            <ProductCard
              key={product.subscriptionId || product.ProductId}
              product={product}
              showConfig={(product.ownershipType === 'subscriber' || product.ownershipType === 'owner') && (product.subscriptionStatus === 'Approved' || product.subscriptionStatus === 'Active')}
              onConfigure={onConfigure}
              onViewDetails={onViewDetails}
              onEditProduct={product.ownershipType === 'owner' ? onEditProduct : undefined}
              onApiConfig={product.ownershipType === 'owner' && !(product.IsBundle || product.isBundle) && onApiConfig ? onApiConfig : undefined}
              onDeleteProduct={onDeleteProduct}
              canDeleteProduct={canDeleteProduct}
              onRemove={onRemove}
              canUnsubscribeProduct={canUnsubscribeProduct}
              currentTenantId={currentTenantId}
              ownershipType={product.ownershipType}
            />
          ))}
        </div>
      )}

      {/* Pagination Controls - Bottom */}
      {products.length > 0 && (
        <div className="flex items-center justify-between mt-6">
          <div className="flex items-center space-x-4">
            <span className="text-sm text-gray-700">
              {startIndex === 0 && totalItems <= itemsPerPage
                ? `Showing all ${totalItems} ${productCategoryTab === 'bundles' ? 'bundles' : 'products'}`
                : `Showing ${startIndex + 1}–${Math.min(endIndex, totalItems)} of ${totalItems} ${productCategoryTab === 'bundles' ? 'bundles' : 'products'}`}
            </span>
            <div className="flex items-center space-x-2">
              <span className="text-sm text-gray-700">Show:</span>
              <select
                value={itemsPerPage}
                onChange={(e) => handleItemsPerPageChange(Number(e.target.value))}
                className="px-2 py-1 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value={15}>15</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
            </div>
          </div>
          
          {totalPages > 1 && (
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-gray-700">
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage === totalPages}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
            </button>
          </div>
          )}
        </div>
      )}
    </div>
  );
};

// Note: MyProductsTab has been consolidated into UnifiedProductsTab

export default TenantAdminProducts;
