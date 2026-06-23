import { 
  Download,
  Edit, 
  Eye, 
  FileText, 
  Layers, 
  Package, 
  Plus, 
  Search, 
  Sparkles, 
  Trash2, 
  Webhook,
  XCircle,
  DollarSign,
  Settings
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import AIProductCreator from '../../components/ai/AIProductCreator';
import AddProductWizard from '../../components/forms/AddProductWizard';
import ProductAPIConfigModal from '../../components/products/ProductAPIConfigModal';
import ProductSubscribersPanel from '../../components/products/ProductSubscribersPanel';
import { useAuth } from '../../hooks/useAuth';
import { apiService } from '../../services/api.service';
import { downloadPricingExport } from '../../services/tenant-admin/pricing-export.service';
import { ApiResponse } from '../../types/index';

interface MyProduct {
  ProductId: string;
  Name: string;
  Description: string;
  ProductType: string;
  Status: string;
  IsBundle: boolean;
  ProductImageUrl?: string;
  ProductLogoUrl?: string;
  ProductDocumentUrl?: string;
  CreatedDate: string;
  ModifiedDate: string;
  SubscriptionCount: number;
}

const TenantMyProducts: React.FC = () => {
  const { user } = useAuth();
  const [products, setProducts] = useState<MyProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [showAICreator, setShowAICreator] = useState(false);
  const [editingProduct, setEditingProduct] = useState<MyProduct | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [productToDelete, setProductToDelete] = useState<MyProduct | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [detailsInitialTab, setDetailsInitialTab] = useState<'overview' | 'pricing' | 'documents' | 'subscribers'>('overview');
  const [selectedProductDetails, setSelectedProductDetails] = useState<any>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [showAPIConfigModal, setShowAPIConfigModal] = useState(false);
  const [apiConfigProduct, setApiConfigProduct] = useState<MyProduct | null>(null);

  // Load products on component mount
  useEffect(() => {
    loadProducts();
  }, []);

  const loadProducts = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await apiService.get('/api/me/tenant-admin/my-products') as ApiResponse<MyProduct[]>;
      
      if (response.success) {
        setProducts(response.data || []);
      } else {
        setError(response.message || 'Failed to load products');
      }
    } catch (err: any) {
      console.error('Error loading products:', err);
      setError(err.message || 'Failed to load products');
    } finally {
      setLoading(false);
    }
  };

  const handleAddProduct = () => {
    setEditingProduct(null);
    setShowAddProduct(true);
  };

  const handleEditProduct = (product: MyProduct) => {
    setEditingProduct(product);
    setShowAddProduct(true);
  };

  const handleViewDetails = async (
    product: MyProduct,
    initialTab: 'overview' | 'pricing' | 'documents' | 'subscribers' = 'overview'
  ) => {
    try {
      setLoadingDetails(true);
      setDetailsInitialTab(initialTab);
      setShowDetailsModal(true);
      
      // Fetch full product details
      const response = await apiService.get(`/api/me/tenant-admin/my-products/${product.ProductId}`) as ApiResponse<any>;
      
      if (response.success && response.data) {
        // Fetch pricing tiers if not included
        let productData = response.data;
        
        // If pricing tiers not included, fetch them
        if (!productData.pricingTiers && !productData.PricingTiers) {
          try {
            const pricingResponse = await apiService.get(`/api/products/${product.ProductId}`) as ApiResponse<any>;
            if (pricingResponse.success && pricingResponse.data) {
              productData = {
                ...productData,
                pricingTiers: pricingResponse.data.pricingTiers || pricingResponse.data.PricingTiers || []
              };
            }
          } catch (pricingError) {
            console.warn('Could not fetch pricing tiers:', pricingError);
          }
        }
        
        setSelectedProductDetails(productData);
      } else {
        setError('Failed to load product details');
        setShowDetailsModal(false);
      }
    } catch (err: any) {
      console.error('Error loading product details:', err);
      setError(err.message || 'Failed to load product details');
      setShowDetailsModal(false);
    } finally {
      setLoadingDetails(false);
    }
  };

  // Handle AI Product Creator success
  const handleAISuccess = (productData: any) => {
    console.log('🤖 AI Generated Product Data:', productData);
    setShowAICreator(false);
    // Set AI data as editingProduct so wizard receives it
    setEditingProduct(productData);
    setShowAddProduct(true);
  };

  const handleDeleteProduct = (product: MyProduct) => {
    setProductToDelete(product);
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    if (!productToDelete) return;

    try {
      const response = await apiService.delete(`/api/me/tenant-admin/my-products/${productToDelete.ProductId}`) as ApiResponse<any>;
      
      if (response.success) {
        await loadProducts(); // Refresh the list
        setShowDeleteConfirm(false);
        setProductToDelete(null);
      } else {
        setError(response.message || 'Failed to delete product');
      }
    } catch (err: any) {
      console.error('Error deleting product:', err);
      setError(err.message || 'Failed to delete product');
    }
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

      // Single product image is used for both ProductImageUrl and ProductLogoUrl
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
        }) as ApiResponse<{ url?: string; data?: { url?: string }[] | { url?: string } }>;
        const body = uploadResponse && typeof uploadResponse === 'object' ? uploadResponse : {};
        const success = (body as any).success === true;
        const url = (body as any).url ?? (Array.isArray((body as any).data) ? (body as any).data[0]?.url : (body as any).data?.url);
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
        }) as ApiResponse<{url: string}>;
        
        if (uploadResponse.success) {
          productDocumentUrl = (uploadResponse as any).url ?? uploadResponse.data?.url;
        }
      }

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
            const url = (uploadResponse as any).url ?? (Array.isArray(uploadResponse.data) ? uploadResponse.data[0]?.url : uploadResponse.data?.url);
            if (url) uploadedNewDocuments.push({ documentUrl: url, displayName: item.displayName?.trim() || item.file.name || 'Document', sortOrder: i });
          }
        } catch (err) {
          console.error('Error uploading product document:', err);
        }
      }
      const existingDocs = (productData.productDocuments || []).filter((d: any) => d?.documentUrl);
      const withLegacy = productDocumentUrl ? [...existingDocs, { documentUrl: productDocumentUrl, displayName: productData.productDocumentName || 'Document', sortOrder: existingDocs.length }] : existingDocs;
      const productDocuments = withLegacy.length > 0 || uploadedNewDocuments.length > 0 ? [...withLegacy, ...uploadedNewDocuments].map((d: any, i: number) => ({ ...d, sortOrder: i })) : undefined;

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

      // ---- Upload per-network ID card variation files (logos and back images) ----
      const networkLogoFiles = (productData as any).idCardLogoFileByNetwork as Record<string, File | null> | undefined;
      const networkBackFiles = (productData as any).idCardBackImageFilesByNetwork as Record<string, Record<string, File | null>> | undefined;
      const allVariationKeys = new Set<string>([
        ...Object.keys(networkLogoFiles || {}),
        ...Object.keys(networkBackFiles || {}),
        ...Object.keys((productData.idCardData?.NetworkVariations as Record<string, unknown>) || {})
      ]);
      if (allVariationKeys.size > 0) {
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
        const idCardDataAny = productData.idCardData as any;
        if (!idCardDataAny.NetworkVariations) idCardDataAny.NetworkVariations = {};

        for (const networkId of allVariationKeys) {
          if (!idCardDataAny.NetworkVariations[networkId]) {
            // Defensive: if there's no variation entry but there are pending files, seed one from default
            idCardDataAny.NetworkVariations[networkId] = JSON.parse(JSON.stringify({
              DisableIDCard: idCardDataAny.DisableIDCard === true,
              Card_Front: idCardDataAny.Card_Front,
              Card_Back: idCardDataAny.Card_Back
            }));
          }
          const variation = idCardDataAny.NetworkVariations[networkId];

          // Logo upload for variation
          const logoFile = networkLogoFiles?.[networkId];
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
              console.error(`Error uploading variation logo for network ${networkId}:`, err);
            }
          }

          // Back-image uploads for variation
          const backFiles = networkBackFiles?.[networkId];
          if (backFiles) {
            for (const section of backImageSections) {
              const file = backFiles[section];
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
                  console.error(`Error uploading variation back image (${section}) for network ${networkId}:`, err);
                }
              }
            }
          }
        }
      }

      // Prepare API data
      const apiProductData = {
        name: productData.name,
        description: productData.description,
        productType: productData.productType,
        salesType: productData.salesType,
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
        // Update existing product
        response = await apiService.put(`/api/me/tenant-admin/my-products/${editingProduct.ProductId}`, apiProductData) as ApiResponse<any>;
      } else {
        // Create new product
        response = await apiService.post('/api/me/tenant-admin/my-products', apiProductData) as ApiResponse<any>;
      }
      
      if (response.success) {
        setShowAddProduct(false);
        setEditingProduct(null);
        await loadProducts(); // Refresh the list
      } else {
        throw new Error(response.message || 'Failed to save product');
      }
    } catch (err: any) {
      console.error('Error saving product:', err);
      setError(err.message || 'Failed to save product');
      throw err; // Re-throw to let the wizard handle it
    }
  };

  const handleCloseWizard = () => {
    setShowAddProduct(false);
    setEditingProduct(null);
  };

  // Filter products based on search term and type
  const filteredProducts = products.filter(product => {
    const matchesSearch = product.Name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         product.Description.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         product.ProductType.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesType = filterType === 'all' || product.ProductType === filterType;
    
    return matchesSearch && matchesType;
  });

  // Get unique product types for filter
  const productTypes = Array.from(new Set(products.map(p => p.ProductType)));

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end items-center space-x-3">
        <button
          onClick={() => setShowAICreator(true)}
          className="bg-gradient-to-r from-purple-600 to-blue-600 text-white px-4 py-2 rounded-lg hover:from-purple-700 hover:to-blue-700 transition-colors flex items-center"
        >
          <Sparkles className="h-4 w-4 mr-2" />
          Create with AI
        </button>
        <button
          onClick={handleAddProduct}
          className="bg-oe-primary text-white px-4 py-2 rounded-lg hover:bg-oe-primary-dark transition-colors flex items-center"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Product
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-6 rounded-lg border border-gray-200">
          <div className="flex items-center">
            <Package className="h-8 w-8 text-oe-primary" />
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">Total Products</p>
              <p className="text-2xl font-semibold text-gray-900">{products.length}</p>
            </div>
          </div>
        </div>
        <div className="bg-white p-6 rounded-lg border border-gray-200">
          <div className="flex items-center">
            <Package className="h-8 w-8 text-green-600" />
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">Active Products</p>
              <p className="text-2xl font-semibold text-gray-900">
                {products.filter(p => p.Status === 'Active').length}
              </p>
            </div>
          </div>
        </div>
        <div className="bg-white p-6 rounded-lg border border-gray-200">
          <div className="flex items-center">
            <Package className="h-8 w-8 text-yellow-600" />
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">Pending Review</p>
              <p className="text-2xl font-semibold text-gray-900">
                {products.filter(p => p.Status === 'Pending').length}
              </p>
            </div>
          </div>
        </div>
        <div className="bg-white p-6 rounded-lg border border-gray-200">
          <div className="flex items-center">
            <Package className="h-8 w-8 text-purple-600" />
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">Bundles</p>
              <p className="text-2xl font-semibold text-gray-900">
                {products.filter(p => p.IsBundle).length}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="bg-white p-6 rounded-lg border border-gray-200">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
              <input
                type="text"
                placeholder="Search products by name, description, or type..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
            </div>
          </div>
          <div className="sm:w-48">
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="all">All Types</option>
              {productTypes.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Products List */}
      <div className="bg-white rounded-lg border border-gray-200">
        {filteredProducts.length === 0 ? (
          <div className="text-center py-12">
            <Package className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">No products found</h3>
            <p className="mt-1 text-sm text-gray-500">
              {searchTerm || filterType !== 'all' 
                ? 'Try adjusting your search terms or filters.'
                : 'Get started by creating your first product.'
              }
            </p>
            {!searchTerm && filterType === 'all' && (
              <div className="mt-6">
                <button
                  onClick={handleAddProduct}
                  className="bg-oe-primary text-white px-4 py-2 rounded-lg hover:bg-oe-primary-dark transition-colors"
                >
                  <Plus className="h-4 w-4 mr-2 inline" />
                  Add Product
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Product
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Subscriptions
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredProducts.map((product) => (
                  <tr key={product.ProductId} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="flex-shrink-0 h-10 w-10">
                          {product.ProductLogoUrl ? (
                            <img
                              className="h-10 w-10 rounded-lg object-cover"
                              src={product.ProductLogoUrl}
                              alt={product.Name}
                            />
                          ) : (
                            <div className="h-10 w-10 rounded-lg bg-gray-200 flex items-center justify-center">
                              <Package className="h-5 w-5 text-gray-400" />
                            </div>
                          )}
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900">
                            {product.Name}
                            {product.IsBundle && (
                              <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                                Bundle
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-gray-500 truncate max-w-xs">
                            {product.Description}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {product.ProductType}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        product.Status === 'Active' 
                          ? 'bg-green-100 text-green-800'
                          : product.Status === 'Pending'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}>
                        {product.Status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {product.SubscriptionCount > 0 ? (
                        <button
                          type="button"
                          onClick={() => void handleViewDetails(product, 'subscribers')}
                          className="text-oe-primary hover:text-oe-dark font-medium underline-offset-2 hover:underline"
                          title="View tenant subscribers"
                        >
                          {product.SubscriptionCount}
                        </button>
                      ) : (
                        product.SubscriptionCount
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(product.CreatedDate).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center justify-end space-x-2">
                        <button
                          onClick={() => handleViewDetails(product)}
                          className="text-gray-600 hover:text-gray-900 p-1"
                          title="View details"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        {!product.IsBundle && (
                          <button
                            onClick={() => { setApiConfigProduct(product); setShowAPIConfigModal(true); }}
                            className="text-purple-600 hover:text-purple-900 p-1"
                            title="API configuration"
                          >
                            <Webhook className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          onClick={() => handleEditProduct(product)}
                          className="text-oe-primary hover:text-blue-900 p-1"
                          title="Edit product"
                        >
                          <Edit className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteProduct(product)}
                          className="text-red-600 hover:text-red-900 p-1"
                          title="Delete product"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* AI Product Creator Modal */}
      <AIProductCreator
        isOpen={showAICreator}
        onClose={() => {
          setShowAICreator(false);
        }}
        onSuccess={handleAISuccess}
        productOwnerId={user?.currentTenantId || user?.tenantId || ""}
      />

      {/* Add/Edit Product Wizard */}
      <AddProductWizard
        isOpen={showAddProduct}
        onClose={handleCloseWizard}
        onSave={handleSaveProduct}
        editingProduct={editingProduct}
        isTenantAdmin={true}
      />

      {/* Product Details Modal */}
      {showDetailsModal && (
        <ProductDetailsModal
          product={selectedProductDetails}
          loading={loadingDetails}
          initialTab={detailsInitialTab}
          onSubscribersChanged={loadProducts}
          onClose={() => {
            setShowDetailsModal(false);
            setSelectedProductDetails(null);
            setDetailsInitialTab('overview');
          }}
        />
      )}

      {/* Product API Config Modal */}
      {apiConfigProduct && (
        <ProductAPIConfigModal
          productId={apiConfigProduct.ProductId}
          productName={apiConfigProduct.Name}
          isOpen={showAPIConfigModal}
          onClose={() => { setShowAPIConfigModal(false); setApiConfigProduct(null); }}
          onSaved={() => {}}
        />
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && productToDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Delete Product</h3>
            <p className="text-sm text-gray-600 mb-6">
              Are you sure you want to delete "{productToDelete.Name}"? This action cannot be undone.
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Product Details Modal Component
interface ProductDetailsModalProps {
  product: any;
  loading: boolean;
  onClose: () => void;
  initialTab?: 'overview' | 'pricing' | 'documents' | 'subscribers';
  onSubscribersChanged?: () => void;
}

const ProductDetailsModal: React.FC<ProductDetailsModalProps> = ({
  product,
  loading,
  onClose,
  initialTab = 'overview',
  onSubscribersChanged
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'pricing' | 'documents' | 'subscribers'>(initialTab);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, product?.ProductId]);

  const handleExportPricing = async () => {
    if (!product) return;
    setIsExporting(true);
    setExportError(null);
    try {
      await downloadPricingExport(
        product.ProductId,
        product.Name || product.ProductName || 'product'
      );
    } catch (err: any) {
      setExportError(err?.message || 'Failed to export pricing');
    } finally {
      setIsExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
            <span className="ml-3 text-gray-600">Loading product details...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!product) {
    return null;
  }

  // Handle both flat and nested pricing structures
  let pricingTiers: any[] = [];
  if (product?.pricingTiers || product?.PricingTiers) {
    const rawTiers = product.pricingTiers || product.PricingTiers || [];
    // Check if it's nested structure (with ageBands)
    if (rawTiers.length > 0 && rawTiers[0]?.ageBands) {
      // Flatten nested structure
      rawTiers.forEach((tier: any) => {
        tier.ageBands?.forEach((band: any) => {
          pricingTiers.push({
            id: band.id,
            minAge: band.minAge,
            maxAge: band.maxAge,
            tierType: tier.tierType,
            tobaccoStatus: band.tobaccoStatus,
            msrpRate: band.msrpRate || band.MSRPRate || 0,
            rate: band.msrpRate || band.MSRPRate || band.affiliateRate || (band.netRate + band.overrideRate) || 0
          });
        });
      });
    } else {
      // Flat structure - use as is but calculate MSRPRate
      pricingTiers = rawTiers.map((tier: any) => ({
        id: tier.id,
        minAge: tier.minAge || tier.MinAge,
        maxAge: tier.maxAge || tier.MaxAge,
        tierType: tier.tierType || tier.TierType,
        tobaccoStatus: tier.tobaccoStatus || tier.TobaccoStatus,
        msrpRate: tier.msrpRate || tier.MSRPRate || 0,
        rate: tier.msrpRate || tier.MSRPRate || tier.rate || (tier.netRate || tier.NetRate || 0) + (tier.overrideRate || tier.OverrideRate || 0)
      }));
    }
  }
  
  const bundleProducts = product.bundleProducts || [];
  const allowedStates = product.AllowedStates ? (typeof product.AllowedStates === 'string' ? JSON.parse(product.AllowedStates) : product.AllowedStates) : [];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              {product.ProductLogoUrl && (
                <img
                  src={product.ProductLogoUrl}
                  alt={product.Name || product.ProductName}
                  className="h-16 w-32 object-contain bg-white rounded-lg border border-gray-200 p-2"
                />
              )}
              <div>
                <h2 className="text-2xl font-bold text-gray-900">
                  {product.Name || product.ProductName}
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  {product.ProductType} {product.IsBundle && '• Bundle'}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-500 p-2"
            >
              <XCircle className="h-6 w-6" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 flex-shrink-0">
          <nav className="flex space-x-8 px-6" aria-label="Tabs">
            <button
              type="button"
              onClick={() => setActiveTab('overview')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'overview'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Overview
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('pricing')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'pricing'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Pricing ({pricingTiers.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('documents')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'documents'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Documents
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('subscribers')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'subscribers'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Subscribers ({product.SubscriptionCount ?? 0})
            </button>
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Basic Information */}
              <div className="bg-gray-50 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Basic Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-500">Product Name</p>
                    <p className="text-sm text-gray-900 mt-1">{product.Name || product.ProductName}</p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-500">Product Type</p>
                    <p className="text-sm text-gray-900 mt-1">{product.ProductType}</p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-500">Status</p>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium mt-1 ${
                      product.Status === 'Active' 
                        ? 'bg-green-100 text-green-800'
                        : product.Status === 'Pending'
                        ? 'bg-yellow-100 text-yellow-800'
                        : 'bg-gray-100 text-gray-800'
                    }`}>
                      {product.Status}
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-500">Sales Type</p>
                    <p className="text-sm text-gray-900 mt-1">{product.SalesType || 'N/A'}</p>
                  </div>
                  {(product.MinAge || product.MaxAge) && (
                    <div>
                      <p className="text-sm font-medium text-gray-500">Age Range</p>
                      <p className="text-sm text-gray-900 mt-1">
                        {product.MinAge || 0} - {product.MaxAge || 99} years
                      </p>
                    </div>
                  )}
                  {allowedStates.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-gray-500">Available States</p>
                      <p className="text-sm text-gray-900 mt-1">{allowedStates.join(', ')}</p>
                    </div>
                  )}
                </div>
                {product.Description && (
                  <div className="mt-4">
                    <p className="text-sm font-medium text-gray-500">Description</p>
                    <p className="text-sm text-gray-900 mt-1">{product.Description}</p>
                  </div>
                )}
              </div>

              {/* Bundle Products */}
              {product.IsBundle && bundleProducts.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                    <Layers className="h-5 w-5 mr-2" />
                    Included Products ({bundleProducts.length})
                  </h3>
                  <div className="space-y-3">
                    {bundleProducts.map((bp: any, index: number) => (
                      <div key={bp.productId || index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div className="flex items-center space-x-3">
                          <div className="h-2 w-2 bg-oe-primary rounded-full"></div>
                          <div>
                            <p className="text-sm font-medium text-gray-900">{bp.name || bp.ProductName}</p>
                            <p className="text-xs text-gray-500">{bp.productType || bp.ProductType}</p>
                          </div>
                        </div>
                        {bp.isRequired && (
                          <span className="text-xs text-gray-500">Required</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Configuration Fields */}
              {product.ConfigurationFields && (
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                    <Settings className="h-5 w-5 mr-2" />
                    Configuration Fields
                  </h3>
                  <div className="text-sm text-gray-600">
                    {typeof product.ConfigurationFields === 'string' 
                      ? product.ConfigurationFields 
                      : JSON.stringify(product.ConfigurationFields, null, 2)}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'pricing' && (
            <div className="space-y-6">
              {pricingTiers.length > 0 ? (
                <>
                  <div className="bg-gray-50 rounded-lg p-4 flex items-center justify-between">
                    <p className="text-sm text-gray-600">
                      {pricingTiers.length} pricing tier{pricingTiers.length !== 1 ? 's' : ''} configured
                    </p>
                    <div className="flex flex-col items-end gap-1">
                      <button
                        onClick={handleExportPricing}
                        disabled={isExporting}
                        className="bg-oe-primary hover:bg-oe-dark text-white px-3 py-1.5 rounded-lg text-sm font-medium flex items-center disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                      >
                        <Download className="h-4 w-4 mr-1.5" />
                        {isExporting ? 'Exporting…' : 'Export Pricing'}
                      </button>
                      {exportError && (
                        <p className="text-xs text-red-600">{exportError}</p>
                      )}
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Age Band
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Tier Type
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Tobacco Status
                          </th>
                          <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Monthly Rate
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {pricingTiers.map((tier: any, index: number) => {
                          // Use MSRPRate if available, otherwise use calculated rate
                          const monthlyRate = tier.msrpRate || tier.rate || 0;
                          
                          return (
                            <tr key={tier.id || index} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                              <td className="px-4 py-3 text-sm text-gray-900">
                                {tier.minAge !== undefined && tier.maxAge !== undefined 
                                  ? `${tier.minAge || 0}-${tier.maxAge || 99}`
                                  : 'All Ages'}
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-900">
                                {tier.tierType || 'Standard'}
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-900">
                                {tier.tobaccoStatus || 'N/A'}
                              </td>
                              <td className="px-4 py-3 text-sm font-semibold text-gray-900 text-right">
                                ${monthlyRate.toFixed(2)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="text-center py-12 bg-gray-50 rounded-lg">
                  <DollarSign className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-gray-600">No pricing tiers configured</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'documents' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {product.ProductImageUrl && (
                  <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                    <h4 className="text-sm font-medium text-gray-900 mb-2">Product Image</h4>
                    <img
                      src={product.ProductImageUrl}
                      alt="Product"
                      className="w-full h-32 object-cover rounded-lg mb-2"
                    />
                    <a
                      href={product.ProductImageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-oe-primary hover:text-blue-800"
                    >
                      View Full Size
                    </a>
                  </div>
                )}
                {product.ProductLogoUrl && (
                  <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                    <h4 className="text-sm font-medium text-gray-900 mb-2">Product Logo</h4>
                    <img
                      src={product.ProductLogoUrl}
                      alt="Logo"
                      className="w-full h-32 object-contain bg-white rounded-lg mb-2 p-2"
                    />
                    <a
                      href={product.ProductLogoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-oe-primary hover:text-blue-800"
                    >
                      View Full Size
                    </a>
                  </div>
                )}
                {product.ProductDocumentUrl && (
                  <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                    <h4 className="text-sm font-medium text-gray-900 mb-2">Product Document</h4>
                    <div className="flex items-center justify-center h-32 bg-white rounded-lg mb-2">
                      <FileText className="h-12 w-12 text-gray-400" />
                    </div>
                    <a
                      href={product.ProductDocumentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-oe-primary hover:text-blue-800 inline-flex items-center"
                    >
                      <FileText className="h-4 w-4 mr-1" />
                      View Document
                    </a>
                  </div>
                )}
              </div>
              {!product.ProductImageUrl && !product.ProductLogoUrl && !product.ProductDocumentUrl && (
                <div className="text-center py-12 bg-gray-50 rounded-lg">
                  <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-gray-600">No documents or images available</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'subscribers' && product.ProductId && (
            <ProductSubscribersPanel
              productId={product.ProductId}
              productName={product.Name || product.ProductName}
              ownerView
              onChanged={onSubscribersChanged}
            />
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 px-6 py-4 bg-gray-50 flex-shrink-0">
          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TenantMyProducts;
