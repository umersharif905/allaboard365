import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Package, Plus, Search, Settings2, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { API_CONFIG } from '../../config/api';
import { useAuth } from '../../hooks/useAuth';
import { useBundleCreation } from '../../hooks/useBundleCreation';
import { useProducts } from '../../hooks/useProducts';
import { apiService } from '../../services/api.service';
import { AddBundleWizardProps, BundleFormData, BundleProduct, AllowedConfigOptions, ProductFormData, Tenant } from '../../types/sysadmin/addproductswizard.types';
import Step3BundleDocuments from './steps/Step3BundleDocuments';
import Step9AIChunks from './steps/Step9AIChunks';

const STEPS = [
  { id: 1, title: 'Basic Details', description: 'Bundle name, description, and logo' },
  { id: 2, title: 'Bundle Products', description: 'Select products to include' },
  { id: 3, title: 'Documents', description: 'Upload bundle guide (optional)' },
  { id: 4, title: 'AI Knowledge', description: 'Review chunks, FAQs, manual notes' },
  { id: 5, title: 'Review', description: 'Review and create bundle' }
];

function catalogProductImageUrl(product: Record<string, unknown>): string | undefined {
  return (
    (product.ProductImageUrl as string | undefined)
    || (product.productImageUrl as string | undefined)
    || (product.ProductLogoUrl as string | undefined)
    || (product.productLogoUrl as string | undefined)
    || undefined
  );
}

function catalogE123ProductId(product: Record<string, unknown>): string | undefined {
  const id = product.E123ProductId ?? product.e123ProductId;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

const AddBundleWizard: React.FC<AddBundleWizardProps> = ({
  isOpen = false,
  onClose,
  onComplete,
  onCancel,
  onSave,
  editingBundle,
  bundleProductCatalog,
  bundleProductCatalogLoading = false
}) => {
  const { user } = useAuth();
  const isTenantAdmin = bundleProductCatalog !== undefined;
  const isSysAdmin = user?.roles?.includes('SysAdmin') || user?.currentRole === 'SysAdmin';
  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState<BundleFormData>({
    name: '',
    description: '',
    productOwnerId: '',
    salesType: 'Both',
    isPublic: false,
    isHidden: false,
    bundleProducts: [],
    productLogoFile: null
  });

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProducts, setSelectedProducts] = useState<BundleProduct[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const useMarketplaceCatalog = bundleProductCatalog === undefined;
  // Fetch marketplace products only when tenant is not supplying a scoped catalog
  const { data: marketplaceProducts, isLoading: marketplaceProductsLoading } = useProducts(undefined, {
    enabled: useMarketplaceCatalog
  });
  const products = useMarketplaceCatalog ? marketplaceProducts ?? [] : bundleProductCatalog;
  const productsLoading = useMarketplaceCatalog ? marketplaceProductsLoading : bundleProductCatalogLoading;

  // Bundle creation hook
  const bundleCreationMutation = useBundleCreation();

  // Reset form when modal opens/closes
useEffect(() => {
    const initializeForm = async () => {
      if (!isOpen) return;

      setCurrentStep(1);
      setSearchTerm('');
      setShowAddModal(false);
      setIsSubmitting(false);

      if (editingBundle) {
        // Fetch full bundle details to ensure we have all fields including SalesType
        let fullBundleData = editingBundle;
        if (editingBundle.ProductId) {
          try {
            const productResponse = await apiService.get<{
              success: boolean;
              product?: any;
              data?: any;
            }>(`/api/products/${editingBundle.ProductId}`);
            
            if (productResponse.success) {
              // Use the product from the response (handle different response structures)
              fullBundleData = productResponse.product || productResponse.data || editingBundle;
              console.log('✅ Fetched full bundle details:', {
                productId: editingBundle.ProductId,
                salesType: fullBundleData.SalesType || fullBundleData.salesType,
                hasSalesType: !!(fullBundleData.SalesType || fullBundleData.salesType)
              });
            }
          } catch (error) {
            console.warn('⚠️ Could not fetch full bundle details, using provided data:', error);
          }
        }
        
        // Get SalesType from fullBundleData (handle both PascalCase and camelCase)
        const salesType = (fullBundleData as any).SalesType || (fullBundleData as any).salesType || 'Both';
        console.log('🔍 Initializing bundle form with SalesType:', {
          SalesType: (fullBundleData as any).SalesType,
          salesType: (fullBundleData as any).salesType,
          finalSalesType: salesType,
          editingBundleKeys: Object.keys(fullBundleData)
        });
        
        // Hydrate any existing bundle-level documents so the user can manage them in the
        // Documents step. The product detail response already includes productDocuments[]
        // with display name + URL + extraction status.
        const rawDocs = (fullBundleData as any).productDocuments
          || (fullBundleData as any).ProductDocuments
          || [];
        const existingDocs = Array.isArray(rawDocs)
          ? rawDocs
              .filter((d: any) => d && (d.documentUrl || d.DocumentUrl))
              .map((d: any, i: number) => ({
                productDocumentId: d.productDocumentId || d.ProductDocumentId,
                documentUrl: d.documentUrl || d.DocumentUrl,
                displayName: d.displayName || d.DisplayName || 'Document',
                sortOrder: d.sortOrder ?? d.SortOrder ?? i,
                extractionStatus: d.extractionStatus || d.ExtractionStatus || null,
              }))
          : [];

        // Default bundle form data
        const bundleFormData: BundleFormData = {
          name: fullBundleData.Name || editingBundle.Name || '',
          description: fullBundleData.Description || editingBundle.Description || '',
          productOwnerId: fullBundleData.ProductOwnerId || editingBundle.ProductOwnerId || user?.currentTenantId || user?.tenantId || '',
          salesType: salesType,
          isPublic: Boolean(fullBundleData.IsPublic !== undefined ? fullBundleData.IsPublic : editingBundle.IsPublic),
          isHidden: Boolean(fullBundleData.IsHidden === true || fullBundleData.IsHidden === 1 || editingBundle.IsHidden === true || editingBundle.IsHidden === 1),
          bundleProducts: [],
          productLogoFile: null,
          productDocuments: existingDocs.length ? existingDocs : undefined,
          productDocumentFiles: undefined,
        };

        // Attempt to fetch full bundle product details
        if (editingBundle.ProductId) {
          try {
            const response = await apiService.get<{
              success: boolean;
              data: Array<{
                IncludedProductId: string;
                ProductName: string;
                Description?: string;
                ProductType?: string;
                SortOrder?: number;
                IsRequired?: boolean;
                HidePricing?: boolean;
                LinkedToProductId?: string | null;
                AllowedConfigOptions?: AllowedConfigOptions | null;
                RequiredDataFields?: Array<{ fieldName: string; fieldOptions: string[] }> | null;
              }>;
            }>(`/api/products/${editingBundle.ProductId}/bundle-products`);

            if (response.success && Array.isArray(response.data)) {
              bundleFormData.bundleProducts = response.data.map((item, index) => ({
                id: item.IncludedProductId || `existing-${index}`,
                productId: item.IncludedProductId,
                productName: item.ProductName,
                isRequired: item.IsRequired ?? true,
                sortOrder: item.SortOrder ?? index + 1,
                productType: item.ProductType || 'Unknown',
                description: item.Description || '',
                hidePricing: item.HidePricing ?? false,
                linkedToProductId: item.HidePricing ? item.LinkedToProductId || null : null,
                allowedConfigOptions: item.AllowedConfigOptions ?? undefined,
                requiredDataFields: item.RequiredDataFields ?? undefined
              }));
            }
          } catch (error) {
            console.error('❌ Failed to fetch bundle product details:', error);
          }
        }

        // Fallback to parsing comma-separated names if detailed data not available
        if (
          bundleFormData.bundleProducts.length === 0 &&
          editingBundle.BundleProducts &&
          editingBundle.BundleProducts.trim()
        ) {
          const productNames = editingBundle.BundleProducts.split(',').map((name: string) => name.trim());
          bundleFormData.bundleProducts = productNames.map((productName: string, index: number) => ({
            id: `existing-${index}`,
            productId: '',
            productName,
            isRequired: true,
            sortOrder: index + 1,
            productType: 'Unknown',
            description: 'Loading...',
            hidePricing: false,
            linkedToProductId: null
          }));
        }

        setFormData(bundleFormData);
        setSelectedProducts(bundleFormData.bundleProducts);
      } else {
        setFormData({
          name: '',
          description: '',
          productOwnerId: isTenantAdmin ? (user?.currentTenantId || user?.tenantId || '') : '',
          salesType: 'Both',
          isPublic: false,
          isHidden: false,
          bundleProducts: [],
          productLogoFile: null
        });
        setSelectedProducts([]);
      }
    };

    initializeForm();
  }, [isOpen, editingBundle]);

  const updateFormData = (updates: Partial<BundleFormData>) => {
    setFormData(prev => ({ ...prev, ...updates }));
  };

  // Resolve product data for editing bundles
  useEffect(() => {
    if (editingBundle && products && products.length > 0) {
      const updatedBundleProducts = formData.bundleProducts.map(bundleProduct => {
        // Prefer match by productId so we don't overwrite with wrong product when names collide (e.g. "MightyWELL CoPay Gold" bundle vs healthcare product)
        let matchingProduct: any = null;
        if (bundleProduct.productId) {
          matchingProduct = products.find((p: any) => p.ProductId === bundleProduct.productId);
        }
        if (!matchingProduct) {
          // Fallback: match by name, but prefer non-bundle (same name can be bundle + healthcare product)
          const isBundle = (p: any) => p.IsBundle === true || p.IsBundle === 1 || (p.ProductType || p.productType) === 'Bundle';
          matchingProduct = products.find((p: any) => p.Name === bundleProduct.productName && !isBundle(p))
            ?? products.find((p: any) => p.Name === bundleProduct.productName);
        }
        if (matchingProduct) {
          return {
            ...bundleProduct,
            productId: matchingProduct.ProductId,
            productType: matchingProduct.ProductType,
            description: matchingProduct.Description,
            productImageUrl: matchingProduct.ProductImageUrl,
            productLogoUrl: matchingProduct.ProductLogoUrl
          };
        }
        return bundleProduct;
      });
      
      // Only update if there are changes
      const hasChanges = updatedBundleProducts.some((updated: any, index: number) => {
        const original = formData.bundleProducts[index];
        return updated.productId !== original.productId || 
               updated.productType !== original.productType ||
               updated.description !== original.description;
      });
      
      if (hasChanges) {
        setFormData(prev => ({
          ...prev,
          bundleProducts: updatedBundleProducts
        }));
        setSelectedProducts(updatedBundleProducts);
      }
    }
  }, [products, editingBundle, formData.bundleProducts]);

  const canProceedToNextStep = (): boolean => {
    switch (currentStep) {
      case 1: // Basic Details
        return !!(
          formData.name
          && formData.description
          && (isTenantAdmin || !isSysAdmin || formData.productOwnerId)
        );
      case 2: // Bundle Products
        return formData.bundleProducts.length > 0;
      case 3: // Documents (optional)
        return true;
      case 4: // AI Knowledge (view/manage only — always allow proceed)
        return true;
      case 5: // Review
        return true;
      default:
        return false;
    }
  };

  const handleAddProduct = async (product: any) => {
    // Check if product is already selected
    const isAlreadySelected = formData.bundleProducts.some(p => p.productId === product.ProductId);
    
    if (isAlreadySelected) {
      console.log('⚠️ Product already selected:', product.Name);
      return;
    }
    
    console.log('➕ Adding product to bundle:', product.Name);
    
    let requiredDataFields: BundleProduct['requiredDataFields'] = undefined;
    let allowedConfigOptions: AllowedConfigOptions | undefined = undefined;
    try {
      const detailRes = await apiService.get<{ product?: any; success?: boolean }>(`/api/products/${product.ProductId}/details`);
      const prod = (detailRes as any).product ?? detailRes;
      let raw = prod?.ConfigurationFields ?? prod?.RequiredDataFields ?? prod?.requiredDataFields;
      if (raw && !Array.isArray(raw)) {
        try {
          raw = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch { raw = null; }
      }
      if (raw && Array.isArray(raw)) {
        requiredDataFields = raw.map((f: any) => ({
          fieldName: f.fieldName || f.field_name || '',
          fieldOptions: Array.isArray(f.fieldOptions) ? f.fieldOptions : (f.options || [])
        })).filter((f: { fieldName: string }) => f.fieldName);
      }
      if ((!requiredDataFields || requiredDataFields.length === 0) && prod?.PricingTiers?.length > 0) {
        const configValuesMap = new Map<string, Set<string>>();
        const configFieldNames = new Map<string, string>();
        prod.PricingTiers.forEach((tier: any) => {
          (tier.ageBands || []).forEach((band: any) => {
            for (let i = 1; i <= 5; i++) {
              const configValue = band[`ConfigValue${i}`] ?? band[`configValue${i}`];
              const configField = band[`ConfigField${i}`] ?? band[`configField${i}`];
              if (configValue && String(configValue).trim()) {
                const key = `field${i}`;
                if (!configValuesMap.has(key)) configValuesMap.set(key, new Set());
                configValuesMap.get(key)!.add(String(configValue).trim());
                if (configField && String(configField).trim() && !configFieldNames.has(key)) {
                  configFieldNames.set(key, String(configField).trim());
                }
              }
            }
          });
        });
        if (configValuesMap.size > 0) {
          const firstKey = Array.from(configValuesMap.keys())[0];
          const values = Array.from(configValuesMap.get(firstKey)!).sort();
          const fieldName = configFieldNames.get(firstKey) || 'Unshared amount';
          requiredDataFields = [{ fieldName, fieldOptions: values }];
        }
      }
      if (requiredDataFields && requiredDataFields.length > 0) {
        const deductibles = requiredDataFields.filter((f: { fieldName: string }) =>
          /deductible|unshared amount|configuration/i.test(f.fieldName)
        );
        const toUse = deductibles.length > 0 ? deductibles : requiredDataFields;
        allowedConfigOptions = {};
        toUse.forEach((f: { fieldName: string; fieldOptions: string[] }) => {
          allowedConfigOptions![f.fieldName] = [...(f.fieldOptions || [])];
        });
      }
    } catch (_) {
      // optional: product may not have config fields
    }
    
    const bundleProduct: BundleProduct = {
      id: Math.random().toString(36).substr(2, 9),
      productId: product.ProductId || product.Id,
      productName: product.Name,
      isRequired: true,
      sortOrder: formData.bundleProducts.length + 1,
      productType: product.ProductType,
      description: product.Description,
      productImageUrl: product.ProductImageUrl || product.productImageUrl,
      productLogoUrl: product.ProductLogoUrl || product.productLogoUrl,
      hidePricing: false,
      linkedToProductId: null,
      allowedConfigOptions: allowedConfigOptions ?? undefined,
      requiredDataFields: requiredDataFields ?? undefined
    };

    const updatedProducts = [...formData.bundleProducts, bundleProduct];
    updateFormData({ bundleProducts: updatedProducts });
    setSelectedProducts(updatedProducts);
    setShowAddModal(false);
    setSearchTerm('');
  };

  const handleRemoveProduct = (productId: string) => {
    const updatedProducts = formData.bundleProducts.filter(p => p.id !== productId);
    updateFormData({ bundleProducts: updatedProducts });
    setSelectedProducts(updatedProducts);
  };


  const handleSubmit = async () => {
    // Prevent double submission
    if (isSubmitting) {
      console.log('⚠️ Submission already in progress, ignoring duplicate click');
      return;
    }

    try {
      setIsSubmitting(true);
      console.log('🚀 Starting bundle creation/update process...');
      console.log('📦 Editing bundle:', editingBundle);
      console.log('📋 Form data:', formData);
      
      // Upload logo if provided, otherwise preserve existing logo
      let logoUrl = '';
      let hasNewLogo = false;
      
      if (formData.productLogoFile) {
        try {
          console.log('📤 Uploading bundle logo...', {
            fileName: formData.productLogoFile.name,
            fileSize: formData.productLogoFile.size,
            fileType: formData.productLogoFile.type
          });
          const formDataUpload = new FormData();
          formDataUpload.append('file', formData.productLogoFile);
          formDataUpload.append('type', 'logos');
          formDataUpload.append('entityId', editingBundle?.ProductId || 'new');
          formDataUpload.append('category', 'product');
          const uploadResponse = await apiService.post('/api/uploads', formDataUpload, {
            headers: { 'Content-Type': 'multipart/form-data' }
          }) as { success?: boolean; url?: string; data?: { url?: string }[] | { url?: string } };
          const success = uploadResponse?.success === true;
          const url = uploadResponse?.url ?? (Array.isArray(uploadResponse?.data) ? uploadResponse?.data[0]?.url : (uploadResponse?.data as { url?: string })?.url);
          if (success && url) {
            logoUrl = url;
            hasNewLogo = true;
            console.log('✅ Logo uploaded successfully:', { url: logoUrl });
          } else {
            throw new Error('Upload did not return a URL');
          }
        } catch (uploadError) {
          console.error('❌ Logo upload failed:', uploadError);
          throw new Error(`Logo upload failed: ${uploadError instanceof Error ? uploadError.message : 'Unknown error'}`);
        }
      } else {
        console.log('ℹ️ No new logo file provided, preserving existing logo');
      }
      
      // Prepare bundle data
      const bundleData = {
        name: formData.name,
        description: formData.description,
        isPublic: formData.isPublic,
        isHidden: formData.isHidden,
        productType: 'Bundle',
        productOwnerId: formData.productOwnerId || editingBundle?.ProductOwnerId || user?.currentTenantId || user?.tenantId || '',
        salesType: formData.salesType,
        minAge: editingBundle?.MinAge || 18,
        maxAge: editingBundle?.MaxAge || 65,
        allowedStates: editingBundle?.AllowedStates || [],
        requiresTobaccoInfo: editingBundle?.RequiresTobaccoInfo || false,
        effectiveDateLogic: (editingBundle?.EffectiveDateLogic === 'SelectedDay' ? 'SameDay' : editingBundle?.EffectiveDateLogic) || 'FirstOfMonth',
        maxEffectiveDateDays: editingBundle?.MaxEffectiveDateDays || 60,
        terminationLogic: editingBundle?.TerminationLogic || '',
        requiredLicenses: editingBundle?.RequiredLicenses || [],
        partNumber: editingBundle?.PartNumber || '',
        isBundle: true,
        isVendorPricing: editingBundle?.IsVendorPrice || false,
        vendorCommission: editingBundle?.VendorCommission || 0,
        bundleProducts: formData.bundleProducts.map(p => ({ 
          productId: p.productId,
          isRequired: p.isRequired,
          sortOrder: p.sortOrder,
          hidePricing: p.hidePricing || false,
          linkedToProductId: p.linkedToProductId || null,
          allowedConfigOptions: p.allowedConfigOptions && Object.keys(p.allowedConfigOptions).length > 0 ? p.allowedConfigOptions : undefined
        })),
        pricingTiers: [],
        acknowledgementQuestions: [],
        productImageFile: null,
        productLogoFile: hasNewLogo ? null : formData.productLogoFile,
        productDocumentFile: null,
        // Forward bundle-level documents (existing + pending uploads) so the host's
        // onSave handler can upload pendingFiles to /api/uploads and merge before POST.
        productDocuments: formData.productDocuments,
        productDocumentFiles: formData.productDocumentFiles,
        planDetailsHeaderLogoFile: null,
        idCardLogoFile: null,
        idCardBackImageFiles: null,
        idCardData: {},
        planDetailsData: {},
        aiChunks: [],
        requiredASA: undefined,
        ...(hasNewLogo && { productLogoUrl: logoUrl }),
        isUpdate: !!editingBundle,
        productId: editingBundle?.ProductId
      };
      
      console.log('📦 Bundle data prepared:', {
        ...bundleData,
        hasNewLogo: hasNewLogo,
        productLogoUrl: hasNewLogo ? logoUrl : 'not included (preserving existing)',
        isUpdate: !!editingBundle,
        productId: editingBundle?.ProductId
      });
      
      // Use the onSave function if provided (for marketplace page integration)
      if (onSave) {
        console.log('💾 Calling onSave function with bundle data');
        await onSave(bundleData);
      } else {
        // Fallback to direct API call if no onSave function provided
        const result = await bundleCreationMutation.mutateAsync(bundleData);
        console.log('✅ Bundle operation completed:', result);
      }
      
      if (onComplete) {
        onComplete();
      } else if (onClose) {
        onClose();
      }
    } catch (error) {
      console.error('❌ Error creating/updating bundle:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const nextStep = () => {
    if (currentStep < STEPS.length && canProceedToNextStep()) {
      setCurrentStep(currentStep + 1);
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const renderStepIndicator = () => {
    return (
      <div className="flex items-center justify-center mb-8">
        {STEPS.map((step, index) => (
          <div key={step.id} className="flex items-center">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-200 ${
              step.id === currentStep 
                ? 'bg-oe-primary text-white shadow-lg transform scale-105' 
                : currentStep > step.id
                  ? 'bg-oe-success text-white' 
                  : 'bg-gray-200 text-gray-600'
            }`}>
              {currentStep > step.id ? <Check className="w-5 h-5" /> : step.id}
            </div>
            {index < STEPS.length - 1 && (
              <div className={`w-12 h-1 mx-2 transition-all duration-200 ${
                currentStep > step.id ? 'bg-oe-success' : 'bg-gray-200'
              }`} />
            )}
          </div>
        ))}
      </div>
    );
  };

  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <BasicDetailsStep
            formData={formData}
            updateFormData={updateFormData}
            editingBundle={editingBundle}
            isTenantAdmin={isTenantAdmin}
            isSysAdmin={isSysAdmin}
          />
        );
      case 2:
        return (
          <BundleProductsStep
            formData={formData}
            updateFormData={updateFormData}
            products={products || []}
            searchTerm={searchTerm}
            setSearchTerm={setSearchTerm}
            onAddProduct={handleAddProduct}
            onRemoveProduct={handleRemoveProduct}
            showAddModal={showAddModal}
            setShowAddModal={setShowAddModal}
            isLoading={productsLoading}
          />
        );
      case 3:
        return <Step3BundleDocuments formData={formData} updateFormData={updateFormData} />;
      case 4:
        // Bundles ARE rows in oe.Products, so the existing product-level
        // chunks UI works against the bundle's ProductId with no changes.
        // When creating a new bundle, editingBundle is undefined, so
        // Step9AIChunks renders its built-in "Save the product first" empty state.
        return (
          <div className="space-y-4">
            <div className="bg-oe-light bg-opacity-40 border border-oe-primary border-opacity-30 rounded-lg p-4">
              <p className="text-sm text-gray-800 font-medium mb-1">AI parsing runs automatically in the background</p>
              <p className="text-xs text-gray-700">
                When you upload a bundle document, Columbus auto-generates chunks and FAQs from it — usually within 1-3 minutes.
                You don't have to wait here. <strong>This step is optional</strong>: save the bundle whenever you're ready, then come
                back here later to review or edit the chunks. You can also add manual notes and FAQs at any time.
              </p>
            </div>
            <Step9AIChunks
              editingProductId={editingBundle?.ProductId}
              formData={{
                name: formData.name,
                aiChunks: [],
                productDocuments: formData.productDocuments,
                productDocumentFiles: formData.productDocumentFiles,
              } as ProductFormData}
              updateFormData={() => undefined}
            />
          </div>
        );
      case 5:
        return <ReviewStep formData={formData} editingBundle={editingBundle} />;
      default:
        return null;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-12">
      <div className="bg-white rounded-lg w-full max-w-7xl max-h-[90vh] overflow-hidden shadow-2xl">
        <div className="flex justify-between items-center p-3 border-b border-gray-200 bg-gradient-to-r from-oe-primary to-oe-dark">
          <h2 className="text-xl font-bold text-white flex items-center">
            <Package className="w-5 h-5 mr-2" />
            {editingBundle ? 'Edit Product Bundle' : 'Create Product Bundle'}
          </h2>
          <button
            onClick={onClose}
            className="text-white hover:bg-white hover:bg-opacity-20 p-2 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4">
          {renderStepIndicator()}
          
          <div className="overflow-y-auto max-h-[60vh]">
            {renderStep()}
          </div>
        </div>

        <div className="flex justify-between items-center p-6 border-t border-gray-200 bg-oe-light bg-opacity-30">
          <button
            onClick={prevStep}
            disabled={currentStep === 1}
            className={`btn-secondary flex items-center ${
              currentStep === 1 ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Previous
          </button>

          <div className="text-sm text-gray-600 font-medium">
            Step {currentStep} of {STEPS.length}
          </div>

          {currentStep === STEPS.length ? (
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || bundleCreationMutation.isPending}
              className="btn-success flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting || bundleCreationMutation.isPending ? (
                <div className="flex items-center">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  {editingBundle ? 'Updating...' : 'Creating...'}
                </div>
              ) : (
                editingBundle ? 'Update Bundle' : 'Create Bundle'
              )}
            </button>
          ) : (
            <button
              onClick={nextStep}
              disabled={!canProceedToNextStep()}
              className={`btn-primary flex items-center ${
                !canProceedToNextStep() ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              Next
              <ChevronRight className="w-4 h-4 ml-1" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// Step Components
const BasicDetailsStep: React.FC<{
  formData: BundleFormData;
  updateFormData: (updates: Partial<BundleFormData>) => void;
  editingBundle?: any;
  isTenantAdmin?: boolean;
  isSysAdmin?: boolean;
}> = ({ formData, updateFormData, editingBundle, isTenantAdmin = false, isSysAdmin = false }) => {
  const [availableTenants, setAvailableTenants] = useState<Tenant[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);

  useEffect(() => {
    if (isTenantAdmin) {
      const fetchCurrentTenant = async () => {
        try {
          setTenantsLoading(true);
          const data = await apiService.get<{ success: boolean; data?: Tenant }>('/api/me/tenant-admin/tenant');
          if (data.success && data.data) {
            setAvailableTenants([data.data]);
            updateFormData({ productOwnerId: data.data.TenantId });
          }
        } catch (error) {
          console.error('Error fetching tenant for bundle wizard:', error);
        } finally {
          setTenantsLoading(false);
        }
      };
      fetchCurrentTenant();
      return;
    }

    if (!isSysAdmin) {
      return;
    }

    const fetchTenants = async () => {
      try {
        setTenantsLoading(true);
        const token = localStorage.getItem('accessToken');
        if (!token) {
          return;
        }
        const response = await fetch(`${API_CONFIG.BASE_URL}/api/tenants`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json();
        if (data.success && Array.isArray(data.data)) {
          setAvailableTenants(data.data);
        } else {
          setAvailableTenants([]);
        }
      } catch (error) {
        console.error('Error fetching tenants for bundle wizard:', error);
        setAvailableTenants([]);
      } finally {
        setTenantsLoading(false);
      }
    };

    fetchTenants();
  }, [isSysAdmin, isTenantAdmin]);
  const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      updateFormData({ productLogoFile: file });
    }
  };

  // Determine which logo to show: new file upload takes priority, then existing bundle logo, then placeholder
  const getLogoDisplay = () => {
    if (formData.productLogoFile) {
      // New file uploaded - show preview
      return (
        <img
          src={URL.createObjectURL(formData.productLogoFile)}
          alt="New logo preview"
          className="w-16 h-16 rounded-lg object-contain border border-gray-200 bg-white"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
            e.currentTarget.nextElementSibling?.classList.remove('hidden');
          }}
        />
      );
    } else if (editingBundle?.ProductLogoUrl) {
      // Existing bundle logo - only show if no new file selected
      return (
        <img
          src={editingBundle.ProductLogoUrl}
          alt="Current bundle logo"
          className="w-16 h-16 rounded-lg object-contain border border-gray-200 bg-white"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
            e.currentTarget.nextElementSibling?.classList.remove('hidden');
          }}
        />
      );
    } else {
      // Placeholder
      return (
        <div className="w-16 h-16 rounded-lg bg-gray-100 flex items-center justify-center border border-gray-200">
          <Package className="w-8 h-8 text-gray-400" />
        </div>
      );
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-4">Basic Bundle Information</h3>
        <div className="space-y-4">
          <div>
            <label className="form-label">Bundle Name *</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => updateFormData({ name: e.target.value })}
              className="form-input"
              placeholder="Enter bundle name"
            />
          </div>
          <div>
            <label className="form-label">Description *</label>
            <textarea
              value={formData.description}
              onChange={(e) => updateFormData({ description: e.target.value })}
              rows={3}
              className="form-input"
              placeholder="Enter bundle description"
            />
          </div>
          <div>
            <label className="form-label">Sales Type *</label>
            <select
              value={formData.salesType}
              onChange={(e) => updateFormData({ salesType: e.target.value })}
              className="form-input"
            >
              <option value="Individual">Individual Only</option>
              <option value="Group">Group Only</option>
              <option value="Both">Both Individual & Group</option>
            </select>
          </div>
          <div>
            <label className="form-label">Product Owner (Tenant) *</label>
            {isTenantAdmin ? (
              <div>
                <input
                  type="text"
                  value={availableTenants[0]?.Name || 'Your tenant'}
                  readOnly
                  className="form-input bg-gray-50 text-gray-700 cursor-not-allowed"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Your tenant is automatically selected as the bundle owner
                </p>
              </div>
            ) : isSysAdmin ? (
              <>
                {tenantsLoading ? (
                  <div className="flex items-center py-2 text-sm text-gray-600">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-oe-primary mr-2" />
                    Loading tenants...
                  </div>
                ) : (
                  <select
                    value={formData.productOwnerId}
                    onChange={(e) => updateFormData({ productOwnerId: e.target.value })}
                    className="form-input"
                    required
                  >
                    <option value="">Select tenant owner</option>
                    {availableTenants.map((tenant) => (
                      <option key={tenant.TenantId} value={tenant.TenantId}>
                        {tenant.Name}
                      </option>
                    ))}
                  </select>
                )}
                {editingBundle?.ProductId && (
                  <p className="text-xs text-gray-400 mt-1">
                    Changing owner keeps the previous owner subscribed to this bundle.
                  </p>
                )}
              </>
            ) : (
              <input
                type="text"
                value={formData.productOwnerId ? 'Selected tenant owner' : 'Tenant owner required'}
                readOnly
                className="form-input bg-gray-50 text-gray-700"
              />
            )}
          </div>
          <div>
            <label className="form-label">Bundle Logo</label>
            <div className="mt-1 flex items-center space-x-4">
              <div className="flex-shrink-0">
                {getLogoDisplay()}
                {/* Fallback placeholder for when image fails to load */}
                <div className="w-16 h-16 rounded-lg bg-gray-100 flex items-center justify-center border border-gray-200 hidden">
                  <Package className="w-8 h-8 text-gray-400" />
                </div>
              </div>
              <div className="flex-1">
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleLogoUpload}
                  className="form-input"
                />
                <p className="text-sm text-gray-500 mt-1">
                  {formData.productLogoFile 
                    ? 'New logo selected - this will replace the current logo' 
                    : editingBundle?.ProductLogoUrl 
                      ? 'Upload a new logo to replace the current one (optional)' 
                      : 'Upload a logo for this bundle (optional)'
                  }
                </p>
              </div>
            </div>
          </div>

          {/* Add Global Product Checkbox */}
          <div className="pt-4 border-t border-gray-200">
            <div className="flex items-start">
              <input
                type="checkbox"
                checked={formData.isPublic}
                onChange={(e) => updateFormData({ isPublic: e.target.checked })}
                className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded mt-0.5"
              />
              <div className="ml-3">
                <label className="text-sm font-medium text-gray-900">Add Global Product</label>
                <p className="text-xs text-gray-500 mt-1">
                  Make this product available globally to all tenants in the marketplace
                </p>
              </div>
            </div>
          </div>

          {/* Hide from Agents, Enrollment Links, and Groups Checkbox */}
          <div className="pt-2">
            <div className="flex items-start">
              <input
                type="checkbox"
                checked={formData.isHidden || false}
                onChange={(e) => updateFormData({ isHidden: e.target.checked })}
                className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded mt-0.5"
              />
              <div className="ml-3">
                <label className="text-sm font-medium text-gray-900">Hide from Agents</label>
                <p className="text-xs text-gray-500 mt-1">
                  Hide this bundle from agents, enrollment links, and group product selection
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// Collapsible section to choose which configuration values are available when this product is in the bundle
const BundleProductConfigOptions: React.FC<{
  product: BundleProduct;
  formData: BundleFormData;
  updateFormData: (updates: Partial<BundleFormData>) => void;
}> = ({ product, formData, updateFormData }) => {
  const [expanded, setExpanded] = useState(false);
  const fields = product.requiredDataFields || [];
  const deductibles = fields.filter(f => /deductible|unshared amount/i.test(f.fieldName));
  const configFields = deductibles.length > 0 ? deductibles : fields;
  if (configFields.length === 0) return null;

  const getAllowed = (fieldName: string): string[] => {
    const allowed = product.allowedConfigOptions?.[fieldName];
    const opts = configFields.find(f => f.fieldName === fieldName)?.fieldOptions || [];
    if (allowed && allowed.length > 0) return allowed;
    return opts;
  };
  const toggleOption = (fieldName: string, option: string) => {
    const current = getAllowed(fieldName);
    const next = current.includes(option) ? current.filter(o => o !== option) : [...current, option];
    const updated = { ...(product.allowedConfigOptions || {}) };
    if (next.length === 0) return;
    updated[fieldName] = next;
    const updatedProducts = formData.bundleProducts.map(p =>
      p.id === product.id ? { ...p, allowedConfigOptions: updated } : p
    );
    updateFormData({ bundleProducts: updatedProducts });
  };
  const selectAll = (fieldName: string) => {
    const opts = configFields.find(f => f.fieldName === fieldName)?.fieldOptions || [];
    const updated = { ...(product.allowedConfigOptions || {}) };
    updated[fieldName] = [...opts];
    const updatedProducts = formData.bundleProducts.map(p =>
      p.id === product.id ? { ...p, allowedConfigOptions: updated } : p
    );
    updateFormData({ bundleProducts: updatedProducts });
  };
  const deselectAll = (fieldName: string) => {
    const opts = configFields.find(f => f.fieldName === fieldName)?.fieldOptions || [];
    if (opts.length === 0) return;
    const updated = { ...(product.allowedConfigOptions || {}) };
    updated[fieldName] = [opts[0]];
    const updatedProducts = formData.bundleProducts.map(p =>
      p.id === product.id ? { ...p, allowedConfigOptions: updated } : p
    );
    updateFormData({ bundleProducts: updatedProducts });
  };

  return (
    <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 text-left text-sm font-medium text-gray-700 hover:bg-gray-100"
      >
        <span className="flex items-center">
          <Settings2 className="w-4 h-4 mr-2 text-oe-primary" />
          <span>Configuration options in bundle</span>
          <span className="ml-2 text-oe-primary font-semibold">— {product.productName}</span>
        </span>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {expanded && (
        <div className="p-3 bg-white border-t border-gray-200">
          <p className="text-xs text-gray-600 mb-3">
            Options below apply only to <strong>{product.productName}</strong> when offered in this bundle. Other products in the bundle have their own configuration. All selected by default.
          </p>
          {configFields.map((field) => {
            const options = field.fieldOptions || [];
            const selected = getAllowed(field.fieldName);
            const allSelected = selected.length === options.length;
            const noneSelected = selected.length === 0;
            return (
              <div key={field.fieldName} className="mb-3 last:mb-0">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-700">{field.fieldName}</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => selectAll(field.fieldName)}
                      disabled={allSelected}
                      className="text-xs px-2 py-1 text-oe-primary hover:bg-blue-50 rounded disabled:opacity-50"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => deselectAll(field.fieldName)}
                      disabled={noneSelected || options.length <= 1}
                      className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-100 rounded disabled:opacity-50"
                    >
                      One
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {options.map((opt) => {
                    const isSelected = selected.includes(opt);
                    return (
                      <label
                        key={opt}
                        className={`inline-flex items-center px-2 py-1.5 border rounded text-sm cursor-pointer ${
                          isSelected ? 'border-oe-primary bg-blue-50 text-blue-900' : 'border-gray-200 bg-white'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleOption(field.fieldName, opt)}
                          className="h-3.5 w-3.5 text-oe-primary border-gray-300 rounded mr-2"
                        />
                        {opt}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const BundleProductsStep: React.FC<{
  formData: BundleFormData;
  updateFormData: (updates: Partial<BundleFormData>) => void;
  products: any[];
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  onAddProduct: (product: any) => void;
  onRemoveProduct: (productId: string) => void;
  showAddModal: boolean;
  setShowAddModal: (show: boolean) => void;
  isLoading: boolean;
}> = ({ formData, updateFormData, products, searchTerm, setSearchTerm, onAddProduct, onRemoveProduct, showAddModal, setShowAddModal, isLoading }) => {
  const filteredProducts = products.filter(product => {
    // Exclude bundles — only non-bundle products can be included in a bundle
    const isBundle = product.IsBundle === true || product.IsBundle === 1 || product.isBundle === true || product.isBundle === 1;
    const productTypeIsBundle = (product.ProductType || product.productType || '') === 'Bundle';
    if (isBundle || productTypeIsBundle) return false;
    
    // Filter by search term
    const matchesSearch = product.Name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      product.ProductType.toLowerCase().includes(searchTerm.toLowerCase());
    if (!matchesSearch) return false;
    
    // Filter by bundle sales type compatibility
    const bundleSalesType = formData.salesType || 'Both';
    const productSalesType = product.SalesType || 'Both';
    
    // If bundle is "Individual", only show products that are "Individual" or "Both"
    if (bundleSalesType === 'Individual') {
      return productSalesType === 'Individual' || productSalesType === 'Both';
    }
    
    // If bundle is "Group", only show products that are "Group" or "Both"
    if (bundleSalesType === 'Group') {
      return productSalesType === 'Group' || productSalesType === 'Both';
    }
    
    // If bundle is "Both", show all compatible products
    return true;
  });

  return (
    <>
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-4">Bundle Products</h3>
          <p className="text-sm text-gray-600 mb-4">Select products to include in this bundle</p>
          
          <button
            onClick={() => setShowAddModal(true)}
            className="btn-primary flex items-center"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Product
          </button>
        </div>

        {/* Selected Products */}
        <div className="space-y-3">
          <h4 className="text-md font-medium text-gray-900">Selected Products ({formData.bundleProducts.length})</h4>
          {formData.bundleProducts.length === 0 ? (
            <p className="text-gray-500 text-sm">No products selected yet</p>
          ) : (
            <div className="space-y-4">
              {formData.bundleProducts.map((product) => {
                // Get available products for the dropdown (exclude current product)
                const availableMainProducts = formData.bundleProducts.filter(
                  p => p.id !== product.id && !p.hidePricing
                );
                
                return (
                  <div key={product.id} className="card" data-testid="bundle-product-item">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center space-x-3 mb-4">
                          {/* Product Image */}
                          <div className="flex-shrink-0">
                            {product.productImageUrl || product.productLogoUrl ? (
                              <img
                                src={product.productImageUrl || product.productLogoUrl}
                                alt={product.productName}
                                className="w-10 h-10 rounded-lg object-contain border border-gray-200 bg-white"
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none';
                                  e.currentTarget.nextElementSibling?.classList.remove('hidden');
                                }}
                              />
                            ) : null}
                            <div className={`w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center border border-gray-200 ${(product.productImageUrl || product.productLogoUrl) ? 'hidden' : ''}`}>
                              <Package className="w-5 h-5 text-gray-400" />
                            </div>
                          </div>
                          
                          <div className="flex-1">
                            <h5 className="font-medium text-gray-900">{product.productName}</h5>
                            <p className="text-sm text-gray-600">
                              {product.productType && product.productType !== 'Unknown' ? product.productType : 'Loading...'}
                            </p>
                          </div>
                        </div>
                        
                        {/* Hide Product Pricing Checkbox */}
                        <div className="mb-3">
                          <label className="flex items-center space-x-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={product.hidePricing || false}
                              onChange={(e) => {
                                const updatedProducts = formData.bundleProducts.map(p =>
                                  p.id === product.id
                                    ? { ...p, hidePricing: e.target.checked, linkedToProductId: e.target.checked ? null : undefined }
                                    : p
                                );
                                updateFormData({ bundleProducts: updatedProducts });
                              }}
                              className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                            />
                            <span className="text-sm font-medium text-gray-700">
                              Hide Product Pricing
                            </span>
                          </label>
                          <p className="text-xs text-gray-500 ml-6 mt-1">
                            Hide this product's pricing on enrollment links and invoices
                          </p>
                        </div>
                        
                        {/* Configuration options in bundle: limit which values are offered (e.g. Unshared amount 1500/3000/6000) — right under pricing options */}
                        {product.requiredDataFields && product.requiredDataFields.length > 0 && (
                          <BundleProductConfigOptions
                            product={product}
                            formData={formData}
                            updateFormData={updateFormData}
                          />
                        )}
                        
                        {/* Link to Main Product Dropdown (only show if hidePricing is checked) */}
                        {product.hidePricing && (
                          <div className="mb-3">
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Link to Main Product
                            </label>
                            <select
                              value={product.linkedToProductId || ''}
                              onChange={(e) => {
                                const updatedProducts = formData.bundleProducts.map(p =>
                                  p.id === product.id
                                    ? { ...p, linkedToProductId: e.target.value || null }
                                    : p
                                );
                                updateFormData({ bundleProducts: updatedProducts });
                              }}
                              className="form-input w-full"
                            >
                              <option value="">Select a main product...</option>
                              {availableMainProducts.map((mainProduct) => (
                                <option key={mainProduct.id} value={mainProduct.productId}>
                                  {mainProduct.productName}
                                </option>
                              ))}
                            </select>
                            <p className="text-xs text-gray-500 mt-1">
                              Select the main product to link this hidden product to
                            </p>
                          </div>
                        )}
                      </div>
                      
                      <button
                        onClick={() => onRemoveProduct(product.id)}
                        className="text-red-600 hover:text-red-800 p-1 transition-colors ml-4"
                        data-testid="remove-product-btn"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Add Product Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-full max-w-4xl max-h-[80vh] overflow-hidden shadow-2xl">
            <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gradient-to-r from-oe-primary to-oe-dark">
              <h3 className="text-lg font-medium text-white">Add Products to Bundle</h3>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-white hover:bg-white hover:bg-opacity-20 p-2 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6">
              {/* Search */}
              <div className="mb-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                  <input
                    type="text"
                    placeholder="Search products..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="form-input pl-10"
                  />
                </div>
              </div>

              {/* Products List */}
              <div className="max-h-96 overflow-y-auto">
                {isLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
                  </div>
                ) : filteredProducts.length === 0 ? (
                  <p className="text-gray-500 text-center py-8">No products found</p>
                ) : (
                  <div className="space-y-2">
                    {filteredProducts.map((product) => {
                      const isSelected = formData.bundleProducts.some(p => p.productId === product.ProductId);
                      const imageUrl = catalogProductImageUrl(product);
                      const e123ProductId = catalogE123ProductId(product);
                      return (
                        <div
                          key={product.ProductId}
                          onClick={() => onAddProduct(product)}
                          className={`p-3 border rounded-lg cursor-pointer transition-colors hover-lift ${
                            isSelected 
                              ? 'border-green-300 bg-green-50' 
                              : 'border-gray-200 hover:bg-gray-50'
                          }`}
                        >
                        <div className="flex items-start space-x-3">
                          {/* Product Image */}
                          <div className="flex-shrink-0">
                            {imageUrl ? (
                              <img
                                src={imageUrl}
                                alt={product.Name}
                                className="w-12 h-12 rounded-lg object-contain border border-gray-200 bg-white"
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none';
                                  e.currentTarget.nextElementSibling?.classList.remove('hidden');
                                }}
                              />
                            ) : null}
                            <div className={`w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center border border-gray-200 ${imageUrl ? 'hidden' : ''}`}>
                              <Package className="w-6 h-6 text-gray-400" />
                            </div>
                          </div>
                          
                          {/* Product Details */}
                          <div className="flex-1 min-w-0">
                            <h5 className="font-medium text-gray-900 truncate">{product.Name}</h5>
                            <p className="text-sm text-gray-600">{product.ProductType}</p>
                            {e123ProductId && (
                              <p className="text-xs text-gray-500 mt-0.5">E123 ID: {e123ProductId}</p>
                            )}
                            {product.Description && (
                              <p className="text-sm text-gray-500 mt-1 line-clamp-2">{product.Description}</p>
                            )}
                          </div>
                          
                          {/* Add Button or Checkmark */}
                          <div className="flex-shrink-0">
                            {isSelected ? (
                              <div className="text-green-600">
                                <Check className="w-5 h-5" />
                              </div>
                            ) : (
                              <button className="text-oe-primary hover:text-oe-dark transition-colors">
                                <Plus className="w-5 h-5" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};


const ReviewStep: React.FC<{ formData: BundleFormData; editingBundle: any }> = ({ formData, editingBundle }) => {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-4">Review Bundle</h3>
        <p className="text-sm text-gray-600 mb-6">Review all details before creating the bundle</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Basic Details */}
        <div className="card">
          <h4 className="font-medium text-gray-900 mb-3">Basic Details</h4>
          <div className="space-y-3">
            <div>
              <span className="font-medium text-gray-700">Name:</span>
              <p className="text-gray-900 mt-1">{formData.name}</p>
            </div>
            <div>
              <span className="font-medium text-gray-700">Description:</span>
              <p className="text-gray-900 mt-1">{formData.description}</p>
            </div>
            <div>
              <span className="font-medium text-gray-700">Sales Type:</span>
              <p className="text-gray-900 mt-1">{formData.salesType}</p>
            </div>
            <div>
              <span className="font-medium text-gray-700">Global Marketplace:</span>
              <p className="text-gray-900 mt-1">
                {formData.isPublic ? (
                  <span className="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                    Yes - Available globally
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">
                    No - Private
                  </span>
                )}
              </p>
            </div>
            <div>
              <span className="font-medium text-gray-700">Hide from Agents:</span>
              <p className="text-gray-900 mt-1">
                {formData.isHidden ? (
                  <span className="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800">
                    Yes - Hidden from agents, enrollment links, and groups
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">
                    No - Visible
                  </span>
                )}
              </p>
            </div>
            {(formData.productLogoFile || editingBundle?.ProductLogoUrl) && (
              <div>
                <span className="font-medium text-gray-700">Logo:</span>
                <div className="mt-2">
                  {formData.productLogoFile ? (
                    <img
                      src={URL.createObjectURL(formData.productLogoFile)}
                      alt="Bundle logo preview"
                      className="w-16 h-16 rounded-lg object-contain border border-gray-200 bg-white"
                    />
                  ) : (
                    <img
                      src={editingBundle.ProductLogoUrl}
                      alt="Current bundle logo"
                      className="w-16 h-16 rounded-lg object-contain border border-gray-200 bg-white"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                        e.currentTarget.nextElementSibling?.classList.remove('hidden');
                      }}
                    />
                  )}
                  {/* Fallback placeholder for when image fails to load */}
                  <div className="w-16 h-16 rounded-lg bg-gray-100 flex items-center justify-center border border-gray-200 hidden">
                    <Package className="w-8 h-8 text-gray-400" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Bundle Products */}
        <div className="card">
          <h4 className="font-medium text-gray-900 mb-3">Bundle Products ({formData.bundleProducts.length})</h4>
          <div className="space-y-2 text-sm">
            {formData.bundleProducts.map((product) => {
              // Check if this product has hidden pricing
              const hasHiddenPricing = product.hidePricing && product.linkedToProductId;
              const linkedProduct = hasHiddenPricing 
                ? formData.bundleProducts.find(p => p.productId === product.linkedToProductId)
                : null;
              
              return (
                <div key={product.id} className="flex items-center justify-between">
                  <div className="flex-1">
                    <span className="font-medium text-gray-700">{product.productName}</span>
                    {product.productType && product.productType !== 'Unknown' && (
                      <span className="text-gray-600 ml-2">({product.productType})</span>
                    )}
                    {hasHiddenPricing && linkedProduct && (
                      <div className="text-xs text-oe-primary mt-1">
                        💡 Price will be consolidated with {linkedProduct.productName}
                      </div>
                    )}
                    {product.allowedConfigOptions && Object.keys(product.allowedConfigOptions).length > 0 && (
                      <div className="text-xs text-gray-500 mt-1">
                        Configuration limited to selected options in bundle
                      </div>
                    )}
                  </div>
                  <div className="flex items-center space-x-2">
                    {hasHiddenPricing && (
                      <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                        Hidden Price
                      </span>
                    )}
                    <span className={`badge ${product.isRequired ? 'badge-primary' : 'badge-warning'}`}>
                      {product.isRequired ? 'Required' : 'Optional'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          
          {/* Note about hidden pricing */}
          {formData.bundleProducts.some(p => p.hidePricing && p.linkedToProductId) && (
            <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
              <strong>Note:</strong> Products marked with "Hidden Price" will have their pricing consolidated
              into their linked product when displayed to users. This creates a cleaner pricing presentation
              while all products remain properly tracked in the system.
            </div>
          )}
        </div>

        {/* Bundle Documents */}
        {((formData.productDocuments && formData.productDocuments.length > 0) || (formData.productDocumentFiles && formData.productDocumentFiles.length > 0)) && (
          <div className="card lg:col-span-2">
            <h4 className="font-medium text-gray-900 mb-3">
              Bundle Documents ({(formData.productDocuments?.length || 0) + (formData.productDocumentFiles?.length || 0)})
            </h4>
            <ul className="space-y-1 text-sm">
              {(formData.productDocuments || []).map((d, i) => (
                <li key={d.productDocumentId ?? d.documentUrl ?? i} className="flex items-center gap-2 text-gray-700">
                  <span className="font-medium">{d.displayName || 'Document'}</span>
                  <span className="text-xs text-gray-500">existing</span>
                </li>
              ))}
              {(formData.productDocumentFiles || []).map((item, i) => (
                <li key={`pending-${i}`} className="flex items-center gap-2 text-gray-700">
                  <span className="font-medium">{item.displayName || item.file.name}</span>
                  <span className="text-xs text-green-700">will upload</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-gray-500 mt-3">
              Columbus treats these as the authoritative source for members enrolled in this bundle.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default AddBundleWizard;